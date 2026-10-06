// Turning a discovered business into someone we are allowed to text.
//
// THE OWNER'S IDEA, AND THE ONE THING THAT HAS TO MOVE.
//
// The owner wants to message every contact — "we built you a website, we'd
// love for you to see it; say YES if you want it, NO if you don't" — and treat
// a YES as the opt-in. That funnel is exactly right, and it is what this
// module builds. One thing about it has to change, and only one:
//
//   THE INVITATION CANNOT GO BY TEXT.
//
// Not because of caution. Because the invitation IS the marketing message. If
// we text 400 discovered numbers to ask whether they want marketing, we have
// already sent 400 unconsented marketing texts — the consent would arrive
// after the act it was meant to authorise. Under the TCPA that is $500–$1,500
// per message in statutory damages, and it is the owner who is liable. More
// immediately: carriers police A2P 10DLC traffic by complaint rate, and the
// usual outcome is not a fine but the number being blocked. The channel the
// owner most wants would be the first thing lost.
//
// Email is different, and that difference is the whole solution. CAN-SPAM
// permits a first commercial email to a business without prior consent, as
// long as it identifies the sender, gives a real postal address and an opt-out
// that works. So the invitation goes by email, carrying the owner's exact
// words — and a YES reply is a documented, provable, per-person opt-in that
// unlocks SMS for that person.
//
// Same funnel. Same message. Legal first step, and a consent record with
// evidence behind it rather than an assertion.
//
// ON THE BULK CHECKBOX. The owner also wants a single checkbox meaning "they
// all opted in". That is recorded here as an ATTESTATION — who asserted it,
// when, and on what basis — and it is deliberately not stored as consent,
// because it is not evidence about any particular person. It unlocks a single
// requested follow-up, never a recurring promotional sequence, and it shows on
// every affected contact as owner-asserted with nothing on file. If the owner
// genuinely collected permission, running the email invitation over that same
// list converts the assertion into real records within a day, and then the
// attestation is not needed at all.

import { store } from './store.js';

/** How someone came to be contactable, strongest evidence first. */
export const PERMISSION = Object.freeze({
  DOCUMENTED: 'documented',     // they said yes, and we have what they replied to
  INBOUND: 'inbound',           // they messaged us first
  ATTESTED: 'owner-asserted',   // the owner says so; no per-person evidence
  NONE: 'none',
});

/** What the owner's invitation asks for, versioned so a record can cite it. */
export const INVITE_WORDING_VERSION = 'invite-v1';

export const YES_WORDS = Object.freeze(['yes', 'y', 'yeah', 'yep', 'sure', 'ok', 'okay', 'please', 'interested', 'send it', 'send']);
export const NO_WORDS = Object.freeze(['no', 'n', 'nope', 'not interested', 'no thanks', 'stop', 'unsubscribe', 'remove']);

/**
 * The invitation itself — the owner's message, by email.
 *
 * Every claim in it has to be true at the moment it is sent, so the preview
 * must already exist. "We built you a website" when nothing has been built is
 * the one sentence in this whole funnel that would do real damage: it is the
 * opening line of the relationship and it would be a lie.
 */
export function composeInvitation({ contact, business, owner = {}, previewUrl = null }) {
  const name = contact?.name?.value || contact?.name || null;
  const biz = business || contact?.businessName?.value || contact?.businessName || 'your business';
  if (!owner.name || !owner.postalAddress) {
    return { ok: false, reason: 'CAN-SPAM requires the sender to be identified with a real postal address; set both in Settings first' };
  }
  if (!previewUrl) {
    return { ok: false, reason: 'no preview exists yet. "We built you a website" has to be true when it is sent — build the preview first' };
  }

  const greeting = name ? `Hi ${String(name).split(/\s+/)[0]},` : 'Hi,';
  const body = [
    greeting,
    '',
    `I build websites for local businesses, and I put together a preview for ${biz} — no charge, nothing owed, I just wanted to show you what it could look like.`,
    '',
    'Would you like to see it?',
    '',
    `  • Reply YES and I'll send you the link.`,
    `  • Reply NO and I won't contact you again.`,
    '',
    `If you'd rather I texted you the link, say so and I will — otherwise I'll keep it to email.`,
    '',
    `— ${owner.name}${owner.businessName ? `, ${owner.businessName}` : ''}`,
    owner.postalAddress,
  ].join('\n');

  return {
    ok: true,
    subject: `A website preview for ${biz}`,
    body,
    wordingVersion: INVITE_WORDING_VERSION,
    // what a YES is actually agreeing to, stored verbatim on the consent record
    asks: 'Reply YES to be sent a link to a free website preview. Replying also permits a text with that link if they ask for one.',
  };
}

/** Did they say yes, no, or something that needs a person? */
export function readInviteReply(text) {
  const raw = String(text || '').trim().toLowerCase();
  if (!raw) return { verdict: 'unclear', why: 'empty reply' };
  const words = raw.replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(Boolean);
  const first = words[0] || '';
  const short = words.length <= 6;
  const has = (set) => set.some((w) => (w.includes(' ') ? raw.includes(w) : words.includes(w)));

  // Matching is on WHOLE WORDS, not substrings. "n" and "y" are in these lists
  // because people really do reply with one letter — and a substring pass then
  // read "yeah send it" as a NO, because "send" contains an n, and "interested"
  // the same way. A single letter has to stand as its own word or it is noise.
  //
  // NO is still checked first. Getting a no wrong means continuing to message
  // someone who declined; getting a yes wrong only costs a delay.
  if (NO_WORDS.includes(first) || (short && has(NO_WORDS))) {
    return { verdict: 'no', why: `they said "${first}"` };
  }
  if (YES_WORDS.includes(first) || (short && has(YES_WORDS))) {
    return { verdict: 'yes', why: `they said "${first}"` };
  }
  // A long reply is a conversation, not a vote — a person reads it.
  return { verdict: 'unclear', why: short ? 'neither yes nor no' : 'they wrote a real reply rather than answering yes or no' };
}

/**
 * A YES. This is the moment a discovered contact becomes someone we may text,
 * and the record has to be good enough to show somebody later.
 */
export async function recordYes(contact, { text, at = Date.now(), invite = null }) {
  if (!contact?.id) return { ok: false, error: 'no contact' };
  const { makeConsentRecord, saveContact } = await import('./contacts.js');
  const record = makeConsentRecord({
    scope: 'one_time_followup',
    channel: 'sms',
    source: 'replied YES to the preview invitation (email)',
    wording: invite?.asks || 'Replied YES to an emailed offer of a free website preview.',
    wordingVersion: invite?.wordingVersion || INVITE_WORDING_VERSION,
    at: new Date(at).toISOString(),
    evidence: `their reply: "${String(text || '').slice(0, 160)}"`,
  });
  const next = { ...contact, consentLog: [...(contact.consentLog || []), record] };
  await saveContact(next);
  return { ok: true, permission: PERMISSION.DOCUMENTED, scope: 'one_time_followup', record };
}

/** A NO. Suppressed on both channels — they answered the question. */
export async function recordNo(contact, { text, at = Date.now() }) {
  if (!contact?.id) return { ok: false, error: 'no contact' };
  const { optOut } = await import('./contacts.js');
  await optOut({
    contactId: contact.id,
    email: contact.email?.value || contact.email || null,
    phone: contact.phone?.value || contact.phone || null,
    reason: `replied NO to the preview invitation: "${String(text || '').slice(0, 120)}"`,
    channel: 'all',
  }).catch(() => {});
  return { ok: true, suppressed: true };
}

// ---------------------------------------------------------------------------
// The owner's blanket assertion
// ---------------------------------------------------------------------------

const ATTEST = (id) => `consent:attested:${id}`;
const ATTEST_INDEX = 'consent:attested:all';

/**
 * Record that the owner says a batch of people gave permission.
 *
 * Stored as an attestation and NOT written into the consent log, because it is
 * a statement about the owner's belief rather than evidence about any one
 * person. Keeping them in different places is what lets the dashboard show
 * "owner-asserted, nothing on file" instead of a tick that looks like proof.
 *
 * It unlocks ONE requested follow-up. Not a sequence: a blanket claim cannot
 * distinguish the person who asked for a call from the person whose card was
 * in a bowl, and a recurring campaign on that basis is the thing that gets a
 * number blocked.
 */
export async function attestConsent({ contactIds = [], by = 'owner', basis = '', at = Date.now() }) {
  const ids = [...new Set((contactIds || []).filter(Boolean))];
  if (!ids.length) return { ok: false, error: 'no contacts selected' };
  if (!basis || String(basis).trim().length < 12) {
    return {
      ok: false,
      error: 'say how these people gave permission (where, when, what they were told). An unexplained assertion is not something anyone could stand behind later.',
    };
  }
  const record = {
    by: String(by).slice(0, 80),
    basis: String(basis).slice(0, 400),
    at: new Date(at).toISOString(),
    count: ids.length,
    scope: 'one_time_followup',
  };
  for (const id of ids) {
    await store.set(ATTEST(id), JSON.stringify(record));
    await store.sadd(ATTEST_INDEX, id);
  }
  await store.set('consent:attested:last', JSON.stringify(record));
  return {
    ok: true,
    attested: ids.length,
    record,
    unlocks: 'one requested follow-up per person',
    doesNotUnlock: 'recurring promotional sequences',
    note: 'Running the email invitation over this same list converts the assertion into per-person records, after which this is no longer needed.',
  };
}

export async function attestationFor(contactId) {
  try {
    const raw = await store.get(ATTEST(contactId));
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch { return null; }
}

export async function clearAttestation(contactId) {
  await store.set(ATTEST(contactId), '');
  await store.srem(ATTEST_INDEX, contactId).catch(() => {});
  return { ok: true };
}

// ---------------------------------------------------------------------------
// What the owner sees
// ---------------------------------------------------------------------------

/**
 * One contact's standing on each channel, in plain words.
 *
 * The requirement this exists for: a contact marked emailable must not look
 * SMS-eligible. So the two channels are computed separately and each carries
 * its own reason and its own next action.
 */
export async function contactStatus(contact) {
  const { canContact, effectiveConsent } = await import('./contacts.js');
  const out = { id: contact?.id || null, name: contact?.name?.value || contact?.name || '(no name)' };

  const emailGate = await canContact(contact, { channel: 'email', purpose: 'promotional' });
  out.email = {
    eligible: emailGate.ok,
    label: emailGate.ok ? 'Email OK' : 'Email blocked',
    reason: emailGate.ok ? 'a business address, first contact is permitted' : emailGate.reason,
    next: emailGate.ok ? 'Send the preview invitation' : null,
  };

  const attested = await attestationFor(contact?.id);
  const smsConsent = effectiveConsent(contact, 'sms');
  const oneTime = await canContact(contact, { channel: 'sms', purpose: 'one_time_followup' });
  const promo = await canContact(contact, { channel: 'sms', purpose: 'promotional' });

  let permission = PERMISSION.NONE;
  if (smsConsent.scope !== 'none') permission = /inbound|they messaged/i.test(smsConsent.source || '') ? PERMISSION.INBOUND : PERMISSION.DOCUMENTED;
  else if (attested) permission = PERMISSION.ATTESTED;

  const hasPhone = !!(contact?.phone?.value || contact?.phone);
  out.sms = {
    eligible: oneTime.ok || (permission === PERMISSION.ATTESTED && hasPhone),
    promotional: promo.ok,
    permission,
    label:
      !hasPhone ? 'No mobile number'
      : promo.ok ? 'Text OK — ongoing'
      : oneTime.ok ? 'Text OK — one message'
      : permission === PERMISSION.ATTESTED ? 'Text OK — one message (owner-asserted)'
      : 'Permission needed',
    reason:
      !hasPhone ? 'no mobile number on file'
      : promo.ok ? `written consent for promotional texts, from ${smsConsent.source || 'an on-file record'}`
      : oneTime.ok ? `they asked for one thing (${smsConsent.source || 'on file'}) — one message, not a series`
      : permission === PERMISSION.ATTESTED ? `the owner stated these people gave permission; nothing on file for this person specifically. Basis: ${attested.basis}`
      : (oneTime.reason || 'no permission on file'),
    next:
      !hasPhone ? 'Find a mobile number, or keep this one to email'
      : (promo.ok || oneTime.ok) ? null
      : permission === PERMISSION.ATTESTED ? 'Send the email invitation to turn this into a real record'
      : 'Send the preview invitation by email — a YES unlocks texting',
  };

  // suppression wins over everything and is said plainly
  if (contact?.optedOutAt) {
    out.suppressed = true;
    out.email = { eligible: false, label: 'Opted out', reason: 'they asked not to be contacted', next: null };
    out.sms = { ...out.sms, eligible: false, promotional: false, label: 'Opted out', reason: 'they asked not to be contacted', next: null };
  }
  return out;
}

/** The whole list, counted by standing — the table the owner asked for. */
export async function statusTable(contacts = []) {
  const rows = [];
  for (const c of contacts) rows.push(await contactStatus(c));
  const count = (f) => rows.filter(f).length;
  return {
    rows,
    total: rows.length,
    emailEligible: count((r) => r.email.eligible),
    smsEligible: count((r) => r.sms.eligible),
    smsPromotional: count((r) => r.sms.promotional),
    permissionNeeded: count((r) => !r.suppressed && !r.sms.eligible && r.sms.label === 'Permission needed'),
    ownerAsserted: count((r) => r.sms.permission === PERMISSION.ATTESTED),
    suppressed: count((r) => r.suppressed),
    unknown: count((r) => r.sms.label === 'No mobile number'),
  };
}

// ---------------------------------------------------------------------------
// Running the funnel for real
// ---------------------------------------------------------------------------

const INVITED = (id) => `optin:invited:${id}`;
const INVITED_INDEX = 'optin:invited:all';

/** When this contact was sent the invitation, or null. */
export async function invitedAt(contactId) {
  try {
    const raw = await store.get(INVITED(contactId));
    if (!raw) return null;
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return v?.at || null;
  } catch { return null; }
}

/** Record that the invitation went out, so a later reply can be read as an answer. */
export async function markInvited(contactId, { at = Date.now(), wordingVersion = INVITE_WORDING_VERSION, previewUrl = null } = {}) {
  await store.set(INVITED(contactId), JSON.stringify({ at, wordingVersion, previewUrl }));
  await store.sadd(INVITED_INDEX, contactId);
  return { ok: true };
}

/**
 * A reply from somebody we invited.
 *
 * This is what the mailbox pass calls. It is deliberately narrow: it only runs
 * for contacts that were actually invited, because "yes" from someone who was
 * never asked the question is just a word in an email — and treating it as
 * consent would be exactly the inference this module exists to prevent.
 */
export async function applyInviteReply(contactId, text, { at = Date.now() } = {}) {
  const read = readInviteReply(text);
  const { getContact } = await import('./contacts.js');
  const contact = await getContact(contactId);
  if (!contact) return { verdict: read.verdict, changed: false, why: 'no such contact' };

  if (read.verdict === 'yes') {
    const r = await recordYes(contact, { text, at });
    return { verdict: 'yes', changed: r.ok === true, why: read.why, permission: r.permission || null };
  }
  if (read.verdict === 'no') {
    const r = await recordNo(contact, { text, at });
    return { verdict: 'no', changed: r.ok === true, why: read.why, suppressed: true };
  }
  // Unclear is NOT a yes. It goes to a person, and nothing about their
  // standing changes — which is the whole point of having a third answer.
  return { verdict: 'unclear', changed: false, why: read.why, needsPerson: true };
}

/**
 * Who could be invited, and who could not.
 *
 * Read-only. The send path is separate and gated, because this is the list the
 * owner reviews before anything leaves.
 */
export async function invitationCandidates(contacts = []) {
  const { canContact } = await import('./contacts.js');
  const eligible = [];
  const skipped = [];
  for (const c of contacts) {
    if (!c) continue;
    if (await invitedAt(c.id)) { skipped.push({ id: c.id, name: c.name?.value || c.name, why: 'already invited' }); continue; }
    const gate = await canContact(c, { channel: 'email', purpose: 'promotional' });
    if (!gate.ok) { skipped.push({ id: c.id, name: c.name?.value || c.name, why: gate.reason }); continue; }
    eligible.push({ id: c.id, name: c.name?.value || c.name, email: c.email?.value || c.email });
  }
  return { eligible, skipped, total: contacts.length };
}

/**
 * Send the invitation to a reviewed list.
 *
 * `send` is injected and there is NO default. With nothing supplied this
 * reports that it is not connected rather than quietly doing nothing — the two
 * look identical from a screen and only one of them is honest. Every message
 * is composed per contact so the refusals (no preview, no sender identity)
 * apply to each one individually rather than to the batch.
 */
export async function sendInvitations(contacts, { owner = {}, previewUrlFor = null, send = null, at = Date.now(), dryRun = false } = {}) {
  const out = { ok: true, sent: 0, refused: [], prepared: [], dryRun: !!dryRun };
  if (!dryRun && typeof send !== 'function') {
    return { ok: false, error: 'no email sender is connected, so no invitation was sent', disconnected: true, sent: 0, refused: [], prepared: [] };
  }
  for (const c of contacts || []) {
    const previewUrl = typeof previewUrlFor === 'function' ? await previewUrlFor(c) : null;
    const msg = composeInvitation({ contact: c, owner, previewUrl });
    if (!msg.ok) { out.refused.push({ id: c.id, name: c.name?.value || c.name, why: msg.reason }); continue; }
    out.prepared.push({ id: c.id, to: c.email?.value || c.email, subject: msg.subject, body: msg.body });
    if (dryRun) continue;
    try {
      const r = await send({ to: c.email?.value || c.email, subject: msg.subject, body: msg.body });
      if (r && r.ok !== false) {
        await markInvited(c.id, { at, wordingVersion: msg.wordingVersion, previewUrl });
        out.sent++;
      } else {
        out.refused.push({ id: c.id, why: (r && r.error) || 'the sender refused it' });
      }
    } catch (e) {
      out.refused.push({ id: c.id, why: String(e.message || e).slice(0, 120) });
    }
  }
  return out;
}
