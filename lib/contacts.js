// Contacts — the acquisition system's core record.
//
// Storage is Redis KV (no SQL in this project), so relationships are modelled
// with explicit secondary-index sets, the same pattern `registry:slugs`
// already uses:
//
//   contact:<id>                 the record (JSON)
//   contacts:all                 set of every id
//   contacts:byEmail:<norm>      set of ids (normalised email -> ids)
//   contacts:byPhone:<e164>      set of ids
//   contacts:byDomain:<domain>   set of ids (one business can have many people)
//   contacts:bySource:<source>   set of ids
//   suppress:email:<norm>        '1' if this address must never be contacted
//   suppress:phone:<e164>        '1' if this number must never be contacted
//
// Two rules drive most of the design:
//
//  1. NEVER INVENT CONTACT DETAILS. Every extracted field carries a confidence
//     and, where it came from OCR, the raw text it was read from. A field we
//     are unsure of is flagged for review, not quietly guessed.
//
//  2. CONSENT AND OPT-OUT ARE APPEND-ONLY. An import can add consent evidence
//     but can never overwrite or downgrade an existing opt-out. Suppression is
//     checked at send time against its own keys, so even a corrupted contact
//     record cannot resurrect a contact who asked to be left alone.

import { store } from './store.js';

const nowISO = () => new Date().toISOString();

// ---------------------------------------------------------------------------
// Normalisation — used for dedup. Must be stable and lossless enough that two
// spellings of the same address collide, without merging genuinely different
// people.
// ---------------------------------------------------------------------------

export function normEmail(raw) {
  const s = String(raw || '').trim().toLowerCase();
  const m = s.match(/<([^>]+)>/); // "Name <a@b.test>"
  const addr = (m ? m[1] : s).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return '';
  const [user, domain] = addr.split('@');
  // Gmail ignores dots and +tags. Only Gmail — applying this everywhere would
  // wrongly merge distinct mailboxes on providers that treat them literally.
  if (/^(gmail|googlemail)\.com$/.test(domain)) {
    return `${user.split('+')[0].replace(/\./g, '')}@gmail.com`;
  }
  return `${user.split('+')[0]}@${domain}`;
}

/** US-centric E.164. Returns '' when it is not a plausible number. */
export function normPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  if (d.length > 11 && d.length <= 15) return `+${d}`;
  return ''; // too short to be real — don't guess
}

export function normDomain(raw) {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '').trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return '';
  // free mail hosts are never a business's own domain
  if (/^(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|aol|proton|protonmail|gmx|comcast|att|verizon)\./.test(s)) return '';
  return s;
}

const slugId = () => 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------
// Consent
//
// "scope" is deliberately narrow and separate, because the permissions are not
// interchangeable and the law treats them differently:
//   none                  no messaging permission at all
//   one_time_followup     "yes, send me that thing we discussed" — a single reply, not a series
//   transactional         appointment/booking confirmations they asked for
//   promotional           ongoing marketing. Requires explicit written consent.
// ---------------------------------------------------------------------------

export const CONSENT_SCOPES = Object.freeze(['none', 'one_time_followup', 'transactional', 'promotional']);

export function makeConsentRecord({ scope, channel, source, wording, wordingVersion, at, evidence }) {
  if (!CONSENT_SCOPES.includes(scope)) throw new Error(`unknown consent scope: ${scope}`);
  return {
    scope,
    channel: channel === 'sms' ? 'sms' : 'email',
    source: String(source || 'unspecified').slice(0, 120), // "web form", "business card", "verbal at X event"
    wording: String(wording || '').slice(0, 600), // what they actually agreed to
    wordingVersion: String(wordingVersion || '').slice(0, 40),
    at: at || nowISO(),
    evidence: String(evidence || '').slice(0, 300), // where the proof lives
  };
}

/**
 * Highest consent currently held for a channel — computed from the append-only
 * log, with any withdrawal after a grant cancelling it. Never trusts a bare
 * flag on the record.
 */
export function effectiveConsent(contact, channel = 'email') {
  const log = (contact?.consentLog || []).filter((c) => c.channel === channel);
  if (!log.length) return { scope: 'none', since: null, source: null };
  const sorted = [...log].sort((a, b) => String(a.at).localeCompare(String(b.at)));
  let current = { scope: 'none', since: null, source: null };
  for (const entry of sorted) {
    if (entry.withdrawn || entry.scope === 'none') current = { scope: 'none', since: entry.at, source: entry.source };
    else current = { scope: entry.scope, since: entry.at, source: entry.source };
  }
  return current;
}

// ---------------------------------------------------------------------------
// Eligibility — the single gate every send must pass through.
// Returns { ok, reason } and is intentionally conservative: anything unclear
// is NOT eligible.
// ---------------------------------------------------------------------------

export async function canContact(contact, { channel = 'email', purpose = 'promotional' } = {}) {
  if (!contact) return { ok: false, reason: 'no contact' };
  if (contact.deletedAt) return { ok: false, reason: 'contact was deleted' };

  if (channel === 'email') {
    const email = contact.email?.value ? normEmail(contact.email.value) : '';
    if (!email) return { ok: false, reason: 'no usable email address' };
    if (await store.get(`suppress:email:${email}`)) return { ok: false, reason: 'this address opted out' };
    if (contact.optedOutAt) return { ok: false, reason: 'contact opted out' };
    if (contact.emailStatus === 'hard_bounce') return { ok: false, reason: 'address hard-bounced' };
    if (contact.emailStatus === 'complained') return { ok: false, reason: 'marked us as spam' };
    // Cold business email to a business address is permitted with identity +
    // opt-out (CAN-SPAM). It is NOT permitted to a personal address the person
    // never gave us for this purpose, so a free-mail address needs real consent.
    const isBusinessAddress = !!normDomain(email.split('@')[1]);
    if (!isBusinessAddress && effectiveConsent(contact, 'email').scope === 'none') {
      return { ok: false, reason: 'personal address with no recorded consent' };
    }
    return { ok: true };
  }

  if (channel === 'sms') {
    // R6.12 — validated properly, not merely "has ten digits". A transposed
    // digit off a business card is a real number belonging to a stranger, so
    // an implausible one is refused rather than dialled.
    const { parseNumber } = await import('./phone.js');
    const parsed = parseNumber(contact.phone?.value || contact.phone || '');
    if (!parsed.ok) return { ok: false, reason: parsed.problems[0]?.text || 'no usable mobile number' };
    // A placeholder parses but is nobody. Sending to one achieves nothing and,
    // if the digits are a typo for a real number, reaches a stranger.
    if (parsed.placeholder) {
      return { ok: false, reason: parsed.problems.find((p) => p.severity === 'suspect')?.text || 'this looks like a placeholder number' };
    }
    const phone = parsed.e164;
    if (await isPhoneSuppressed(phone)) return { ok: false, reason: 'this number opted out' };
    if (contact.phoneType && contact.phoneType !== 'mobile') {
      return { ok: false, reason: `number is ${contact.phoneType}, not mobile` };
    }
    const c = effectiveConsent(contact, 'sms');
    // Never infer consent from silence. The scope must actually cover the use.
    if (purpose === 'promotional' && c.scope !== 'promotional') {
      return { ok: false, reason: 'no written consent for promotional texts' };
    }
    if (purpose === 'one_time_followup' && !['one_time_followup', 'promotional'].includes(c.scope)) {
      return { ok: false, reason: 'no permission for a follow-up text' };
    }
    if (purpose === 'transactional' && c.scope === 'none') {
      return { ok: false, reason: 'no permission for texts' };
    }
    return { ok: true };
  }

  return { ok: false, reason: `unknown channel ${channel}` };
}

// ---------------------------------------------------------------------------
// Field shape: every contact detail keeps where it came from and how sure we
// are, so the UI can ask rather than assume, and so nothing is ever silently
// fabricated.
// ---------------------------------------------------------------------------

export function field(value, { confidence = 1, source = 'manual', raw = null, needsReview = false } = {}) {
  const v = typeof value === 'string' ? value.trim() : value;
  if (!v) return null;
  return { value: v, confidence, source, raw, needsReview: needsReview || confidence < 0.75 };
}

/**
 * Accept a bare string where a field object was meant.
 *
 * Every field on a contact is `{ value, confidence, source, needsReview }`, and
 * `indexContact`, `findDuplicates` and `optOut` all read `.value`. A contact
 * saved with `email: 'a@b.test'` was therefore stored but **never indexed** —
 * invisible to deduplication, to reply matching, and, worst of all, to
 * `optOut`, which finds the person to suppress through `contacts:byEmail`.
 *
 * Every caller in this codebase passes the right shape today. This exists so
 * that the one that does not — a future caller, or anything posting to
 * `contacts-save` — cannot create a contact that an opt-out can never find.
 */
export function asField(v, source = 'manual') {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return 'value' in v ? v : null;
  return field(v, { source });
}

export const SOURCES = Object.freeze(['business_card', 'csv_import', 'manual', 'discovery', 'referral', 'inbound']);
export const RELATIONSHIPS = Object.freeze(['met_in_person', 'same_networking_group', 'referred', 'none']);

// ---------------------------------------------------------------------------

export async function getContact(id) {
  const raw = await store.get(`contact:${id}`).catch(() => null);
  try {
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    return null;
  }
}

async function indexContact(c) {
  const jobs = [store.sadd('contacts:all', c.id)];
  const email = c.email?.value ? normEmail(c.email.value) : '';
  const phone = c.phone?.value ? normPhone(c.phone.value) : '';
  const domain = c.website?.value ? normDomain(c.website.value) : email ? normDomain(email.split('@')[1]) : '';
  if (email) jobs.push(store.sadd(`contacts:byEmail:${email}`, c.id));
  if (phone) jobs.push(store.sadd(`contacts:byPhone:${phone}`, c.id));
  if (domain) jobs.push(store.sadd(`contacts:byDomain:${domain}`, c.id));
  if (c.source) jobs.push(store.sadd(`contacts:bySource:${c.source}`, c.id));
  await Promise.all(jobs);
}

export async function saveContact(c) {
  const rec = { ...c, updatedAt: nowISO() };
  await store.set(`contact:${rec.id}`, JSON.stringify(rec));
  await indexContact(rec);
  return rec;
}

/** Existing contacts that look like the same person/business. */
/**
 * R12.4 — how many same-domain colleagues are worth reading before deciding
 * "this is the same business, probably a different person".
 *
 * Email and phone matches are capped by reality: one address and one number
 * belong to one or two records. A DOMAIN is different — every colleague at one
 * company shares it, so the set grows without limit, and reading all of it on
 * every insert makes importing a list from one business quadratic. A 2,000-row
 * same-domain import measured at ~2,000,000 reads before this cap; the same
 * import with distinct domains needs none at all.
 *
 * Reading more of them does not improve the answer. The domain match only ever
 * produces "same business, review this", and a handful of examples supports
 * that conclusion as well as two thousand do. When the cap bites, the result
 * says so rather than quietly implying the list was complete.
 */
export const DOMAIN_MATCH_LIMIT = 25;

export async function findDuplicates({ email, phone, website, personName }) {
  const ids = new Set();
  const hits = { email: [], phone: [], domain: [] };
  const e = normEmail(email);
  const p = normPhone(phone);
  const d = normDomain(website) || (e ? normDomain(e.split('@')[1]) : '');
  let domainTruncated = false;
  if (e) for (const id of await store.smembers(`contacts:byEmail:${e}`)) { ids.add(id); hits.email.push(id); }
  if (p) for (const id of await store.smembers(`contacts:byPhone:${p}`)) { ids.add(id); hits.phone.push(id); }
  if (d) {
    const all = await store.smembers(`contacts:byDomain:${d}`);
    // the exact-email and phone matches are never dropped — only the
    // same-business list is sampled, because that is the unbounded one
    const sample = all.length > DOMAIN_MATCH_LIMIT ? all.slice(0, DOMAIN_MATCH_LIMIT) : all;
    domainTruncated = sample.length < all.length;
    for (const id of sample) { ids.add(id); hits.domain.push(id); }
  }
  const matches = [];
  for (const id of ids) {
    const c = await getContact(id);
    if (!c || c.deletedAt) continue;
    // An exact email match is the same person. A domain-only match is the same
    // BUSINESS but probably a different person — that must not auto-merge.
    const certainty = hits.email.includes(id) ? 'exact' : hits.phone.includes(id) ? 'likely' : 'same_business';
    // Comparing BUSINESS names here would flag every colleague as a possible
    // duplicate of their own coworker — two people at one company share a
    // business name by definition. The only name signal worth anything is the
    // PERSON's name.
    const samePerson =
      !!personName &&
      !!c.name?.value &&
      String(c.name.value).trim().toLowerCase() === String(personName).trim().toLowerCase();
    matches.push({ contact: c, certainty, samePerson });
  }
  // the flag rides on the array rather than changing the return shape, because
  // every caller treats this as a list and a truncated list must still be one
  if (domainTruncated) {
    Object.defineProperty(matches, 'domainTruncated', { value: true, enumerable: false });
  }
  return matches;
}

/**
 * Create a contact, or merge into an existing one when it is unambiguously the
 * same person. Returns {contact, action, needsReview}.
 *
 * action: 'created' | 'merged' | 'review'
 *   'review' means we found a plausible but not certain match and refuse to
 *   guess — the owner decides. Nothing is overwritten in that case.
 */
export async function upsertContact(input, { allowMerge = true } = {}) {
  const matches = await findDuplicates({
    email: asField(input.email)?.value,
    phone: asField(input.phone)?.value,
    website: asField(input.website)?.value,
    personName: asField(input.name)?.value,
  });

  const exact = matches.find((m) => m.certainty === 'exact');
  if (exact && allowMerge) {
    const merged = mergeInto(exact.contact, input);
    return { contact: await saveContact(merged), action: 'merged', matchedId: exact.contact.id };
  }

  const likely = matches.filter((m) => m.certainty === 'likely' || (m.certainty === 'same_business' && m.samePerson));
  if (likely.length && allowMerge) {
    // Same phone, or same business AND same name — plausible, not certain.
    // Record it for human review instead of merging or creating a silent dupe.
    const c = await createContact({ ...input, needsMergeReview: likely.map((m) => m.contact.id) });
    return { contact: c, action: 'review', candidates: likely.map((m) => m.contact.id) };
  }

  return { contact: await createContact(input), action: 'created' };
}

async function createContact(input) {
  const id = input.id || slugId();
  const rec = {
    id,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    source: SOURCES.includes(input.source) ? input.source : 'manual',
    collectedAt: input.collectedAt || nowISO(),
    owner: input.owner || 'owner',

    // coerced, so a caller passing a bare string cannot produce a contact
    // that is stored but unindexed — and therefore unfindable by opt-out
    name: asField(input.name, input.source),
    businessName: asField(input.businessName, input.source),
    role: asField(input.role, input.source),
    email: asField(input.email, input.source),
    phone: asField(input.phone, input.source),
    website: asField(input.website, input.source),
    address: asField(input.address, input.source),

    // relationship context — never claim a meeting that did not happen
    relationship: RELATIONSHIPS.includes(input.relationship) ? input.relationship : 'none',
    networkingGroup: input.networkingGroup || null,
    event: input.event || null,
    meetingNotes: input.meetingNotes || null,

    // provenance
    cardImageKeys: input.cardImageKeys || [],
    evidence: input.evidence || [],
    // R19.5 — what we actually learned about their website, not just its URL.
    //
    // The record is built explicitly, so a field that is not named here is
    // dropped. `websiteCheck` was being passed by enrolment and silently
    // discarded, which left the outreach gate reading a field nothing wrote:
    // it could not tell a business's own site from a Facebook page, and the
    // premise of every cold message rested on that difference.
    websiteCheck: input.websiteCheck || null,

    // messaging state
    consentLog: Array.isArray(input.consentLog) ? input.consentLog : [],
    emailStatus: input.emailStatus || 'unknown', // unknown|valid|risky|hard_bounce|complained
    phoneType: input.phoneType || null, // mobile|landline|voip|unknown
    optedOutAt: null,
    suppressedReason: null,

    needsMergeReview: input.needsMergeReview || null,
    campaignHistory: [],
    conversationIds: [],
  };

  // R17.1 — a permission can arrive BEFORE the person is a contact: somebody
  // texts the keyword, or fills in the opt-in form, and we have no record of
  // them yet. That consent is held against the number; this is where it is
  // picked up. Dropping it would mean a person who deliberately opted in shows
  // as "permission needed" the moment we create their record, which is both
  // wrong and the kind of thing nobody notices until they complain.
  try {
    const tel = rec.phone?.value;
    if (tel) {
      const { pendingKeywordOptIn } = await import('./optin-public.js');
      const held = await pendingKeywordOptIn(normPhone(tel));
      if (held && !rec.consentLog.some((r) => r.at === held.at && r.source === held.source)) {
        rec.consentLog = [...rec.consentLog, held];
      }
    }
  } catch { /* the contact is still created; the permission stays held */ }

  return saveContact(rec);
}

/**
 * Merge new information into an existing contact.
 * Rules: never downgrade a known value with a less confident one, never drop
 * consent history, never un-suppress, never overwrite an opt-out.
 */
export function mergeInto(existing, incoming) {
  const out = { ...existing };
  for (const key of ['name', 'businessName', 'role', 'email', 'phone', 'website', 'address']) {
    const a = existing[key];
    const b = incoming[key];
    if (!b) continue;
    if (!a) { out[key] = b; continue; }
    // keep whichever we're more sure of; ties keep what we already had
    if ((b.confidence || 0) > (a.confidence || 0)) out[key] = b;
  }
  // append-only consent
  out.consentLog = [...(existing.consentLog || []), ...(incoming.consentLog || [])];
  // opt-out is sticky — an import can never clear it
  out.optedOutAt = existing.optedOutAt || incoming.optedOutAt || null;
  out.suppressedReason = existing.suppressedReason || incoming.suppressedReason || null;
  // a hard bounce / complaint outranks an optimistic "valid" from an import
  const rank = { complained: 4, hard_bounce: 3, risky: 2, valid: 1, unknown: 0 };
  if ((rank[incoming.emailStatus] || 0) > (rank[existing.emailStatus] || 0)) out.emailStatus = incoming.emailStatus;
  // relationship: a real meeting outranks "same group" outranks nothing
  const relRank = { met_in_person: 3, referred: 2, same_networking_group: 1, none: 0 };
  if ((relRank[incoming.relationship] || 0) > (relRank[existing.relationship] || 0)) out.relationship = incoming.relationship;
  out.networkingGroup = existing.networkingGroup || incoming.networkingGroup || null;
  out.event = existing.event || incoming.event || null;
  out.meetingNotes = [existing.meetingNotes, incoming.meetingNotes].filter(Boolean).join('\n—\n') || null;
  out.cardImageKeys = [...new Set([...(existing.cardImageKeys || []), ...(incoming.cardImageKeys || [])])];
  out.evidence = [...(existing.evidence || []), ...(incoming.evidence || [])];
  // R19.5 — the NEWER website check wins. A site that has since stopped
  // loading, or a link that turned out to be a profile page, must be able to
  // take a contact OUT of the outbound segment; keeping the older, more
  // flattering verification would make the premise permanent.
  const checkedAt = (v) => Number(v?.checkedAt) || 0;
  if (checkedAt(incoming.websiteCheck) >= checkedAt(existing.websiteCheck) && incoming.websiteCheck) {
    out.websiteCheck = incoming.websiteCheck;
  } else {
    out.websiteCheck = existing.websiteCheck || incoming.websiteCheck || null;
  }
  out.mergedAt = nowISO();
  return out;
}

// ---------------------------------------------------------------------------
// Opt-out / suppression. Writes to BOTH the contact and a standalone
// suppression key, so a send check can never miss it even if the contact
// record is unreadable, and so an address stays suppressed after deletion.
// ---------------------------------------------------------------------------

export async function optOut({ email, phone, contactId, reason = 'opt-out', channel = 'email' }) {
  const e = normEmail(email);
  const p = normPhone(phone);
  const jobs = [];
  if (e) jobs.push(store.set(`suppress:email:${e}`, JSON.stringify({ at: nowISO(), reason })));
  if (p) jobs.push(store.set(`suppress:phone:${p}`, JSON.stringify({ at: nowISO(), reason })));
  await Promise.all(jobs);

  const ids = new Set(contactId ? [contactId] : []);
  if (e) for (const id of await store.smembers(`contacts:byEmail:${e}`)) ids.add(id);
  if (p) for (const id of await store.smembers(`contacts:byPhone:${p}`)) ids.add(id);
  const touched = [];
  for (const id of ids) {
    const c = await getContact(id);
    if (!c) continue;
    c.optedOutAt = c.optedOutAt || nowISO();
    c.suppressedReason = reason;
    c.consentLog = [...(c.consentLog || []), { scope: 'none', channel, source: reason, at: nowISO(), withdrawn: true, wording: 'opt-out received' }];
    await saveContact(c);
    touched.push(id);
  }
  return { ok: true, suppressed: { email: e || null, phone: p || null }, contacts: touched };
}

/**
 * Every key a phone suppression might be stored under.
 *
 * R17.1 — there were two formats in use. `contacts.js`, `phone.js` and
 * `sms-inbound.js` wrote and read E.164 (`+12145550123`); `retention.js` and
 * `sms-outreach.js` used digits only (`12145550123`). So an erasure-suppression
 * written by retention was invisible to every consent check, and the prospect
 * SMS sender's own opt-out check read a key nothing writes.
 *
 * Writers now use the canonical E.164 form. READERS CHECK BOTH, deliberately
 * and probably for ever: a suppression already stored in the old format is a
 * real person who said stop, and a tidy-up that silently stopped matching it
 * would start messaging them again. The cost of carrying the second lookup is
 * one KV read; the cost of dropping it is contacting somebody who opted out.
 */
export function suppressionKeys(phone) {
  const e164 = normPhone(phone);
  const forms = new Set();
  if (e164) {
    forms.add(e164); // canonical, what every writer now uses
    forms.add(e164.replace(/^\+/, '')); // the legacy digits-only form
  }
  const bare = String(phone || '').replace(/\D/g, '');
  if (bare) forms.add(bare); // exactly as it was typed, digits only
  return [...forms].map((f) => `suppress:phone:${f}`);
}

/**
 * True if this number is suppressed under ANY key format in use.
 *
 * DELIBERATELY DOES NOT SWALLOW A READ FAILURE. An unreadable suppression list
 * must never read as "not suppressed" — that is the difference between "we
 * checked and they are fine to contact" and "we could not check", and only one
 * of those permits a send. Callers catch and fail closed; an earlier version of
 * this function caught internally and returned false, which silently removed
 * the fail-closed behaviour from every gate that depended on it.
 */
export async function isPhoneSuppressed(phone) {
  for (const k of suppressionKeys(phone)) {
    if (await store.get(k)) return true;
  }
  return false;
}

export async function isSuppressed({ email, phone }) {
  const e = normEmail(email);
  if (e && (await store.get(`suppress:email:${e}`))) return true;
  if (phone && (await isPhoneSuppressed(phone))) return true;
  return false;
}

export async function listContacts({ limit = 100, offset = 0, source = null } = {}) {
  const ids = await store.smembers(source ? `contacts:bySource:${source}` : 'contacts:all');
  const page = ids.slice(offset, offset + limit);
  const out = [];
  for (const id of page) {
    const c = await getContact(id);
    if (c && !c.deletedAt) out.push(c);
  }
  return { total: ids.length, contacts: out };
}

/** Right-to-be-forgotten. Keeps the suppression entry so they are not re-added. */
export async function deleteContact(id) {
  const c = await getContact(id);
  if (!c) return { ok: false, error: 'not found' };
  const e = c.email?.value ? normEmail(c.email.value) : '';
  const p = c.phone?.value ? normPhone(c.phone.value) : '';
  if (e) await store.srem(`contacts:byEmail:${e}`, id);
  if (p) await store.srem(`contacts:byPhone:${p}`, id);
  await store.srem('contacts:all', id);
  if (c.source) await store.srem(`contacts:bySource:${c.source}`, id);
  await store.del(`contact:${id}`);
  // suppression survives deletion on purpose
  if (e) await store.set(`suppress:email:${e}`, JSON.stringify({ at: nowISO(), reason: 'contact deleted' }));
  return { ok: true, deleted: id };
}
