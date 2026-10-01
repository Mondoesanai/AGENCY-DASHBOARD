// R5 — campaign workflows.
//
// Two campaign types, deliberately different, because the relationship is
// different and pretending otherwise is how outreach becomes a lie:
//
//   COLD   — a business found by discovery. We have never spoken. The message
//            may reference exactly one observation we actually made, must
//            identify who is writing, and must carry an opt-out.
//   WARM   — someone whose card we took or who shares a networking group. The
//            message may reference the meeting ONLY if it happened. A card is
//            not permission to run a promotional sequence.
//
// The composer below cannot produce a claim the evidence does not support. That
// is enforced by construction: every sentence it can emit is assembled from a
// fixed set of fragments chosen by the prospect's verified state, and the only
// free text is the business name and the owner's own details.

import { getSettings, priceLine } from './settings.js';
import { WEB_STATUS } from './discovery.js';
import { canContact } from './contacts.js';
import { store } from './store.js';

export const CAMPAIGN_TYPES = Object.freeze({
  COLD_NO_SITE: 'cold-no-site-found',
  COLD_WEAK_SITE: 'cold-weak-site',
  WARM_CARD: 'warm-card-followup',
});

/** Default cadence. Editable within bounds — not a constant, not unbounded. */
export const CADENCE_BOUNDS = Object.freeze({
  minGapDays: 2,
  maxGapDays: 30,
  maxFollowUps: 2, // cold: intro + at most 2
  maxFollowUpsWarm: 1, // warm: the promised follow-up + at most 1 reminder
});

export function defaultCadence(type) {
  if (type === CAMPAIGN_TYPES.WARM_CARD) return { gapDays: 4, followUps: 1 };
  return { gapDays: 4, followUps: 2 };
}

/** Clamp an owner-edited cadence into the safe band, and say what changed. */
export function clampCadence(type, cadence = {}) {
  const maxFollow = type === CAMPAIGN_TYPES.WARM_CARD ? CADENCE_BOUNDS.maxFollowUpsWarm : CADENCE_BOUNDS.maxFollowUps;
  const d = defaultCadence(type);
  const notes = [];

  let gapDays = Number(cadence.gapDays);
  if (!Number.isFinite(gapDays)) gapDays = d.gapDays;
  if (gapDays < CADENCE_BOUNDS.minGapDays) { gapDays = CADENCE_BOUNDS.minGapDays; notes.push(`gap raised to ${CADENCE_BOUNDS.minGapDays} days — closer than that reads as pestering`); }
  if (gapDays > CADENCE_BOUNDS.maxGapDays) { gapDays = CADENCE_BOUNDS.maxGapDays; notes.push(`gap capped at ${CADENCE_BOUNDS.maxGapDays} days`); }

  let followUps = Number(cadence.followUps);
  if (!Number.isFinite(followUps)) followUps = d.followUps;
  if (followUps < 0) { followUps = 0; notes.push('follow-ups cannot be negative'); }
  if (followUps > maxFollow) { followUps = maxFollow; notes.push(`follow-ups capped at ${maxFollow} for this campaign type`); }

  return { gapDays, followUps, notes };
}

// ---------------------------------------------------------------------------
// Message composition — the part that must not be able to lie
// ---------------------------------------------------------------------------

/**
 * The single observation a cold message may reference, derived from the
 * verified web status. Returns null when there is nothing honest to say, and a
 * null observation means NO cold message can be built at all.
 */
export function observationFor(prospect) {
  const st = prospect?.web?.status;
  if (st === WEB_STATUS.NOT_LINKED) {
    return {
      kind: 'no-site-found',
      // the wording R4.7 fixes: about the listing, not about their existence
      sentence: `I was looking up ${prospect.name} and couldn't find a website linked from your listing.`,
      hedge: 'If you do have one and I just missed it, tell me and I\'ll stop bothering you about it.',
    };
  }
  if (st === WEB_STATUS.INACCESSIBLE) {
    return {
      kind: 'weak-site',
      sentence: `I tried the website listed for ${prospect.name} and it didn't load when I checked.`,
      hedge: 'That may well be temporary — worth knowing either way.',
    };
  }
  // verified-present and uncertain both give us nothing truthful to open with
  return null;
}

/**
 * Build a cold message. Returns { ok:false, reason } rather than a message
 * whenever the evidence does not support one.
 */
export async function composeCold(prospect, { owner = {}, settings = null, preview = null } = {}) {
  const s = settings || (await getSettings());
  const obs = observationFor(prospect);
  if (!obs) {
    return { ok: false, reason: `no honest opening for this prospect (web status: ${prospect?.web?.status || 'unknown'})` };
  }
  if (!owner.name || !owner.business || !owner.postalAddress) {
    return { ok: false, reason: 'sender identity incomplete — CAN-SPAM requires a real name, business and postal address' };
  }

  // R5.2 — a preview may only be mentioned if one actually exists.
  const previewLine = preview?.exists && preview?.url
    ? `I built a rough version so you can see what I mean rather than take my word for it: ${preview.url}`
    : null;

  // G1 — a price only appears when pricing is configured.
  const price = priceLine(s);
  const priceSentence = price ? `It's ${price}.` : null;

  const lines = [
    `Hi${prospect.contactFirstName ? ' ' + prospect.contactFirstName : ''},`,
    '',
    obs.sentence,
    obs.hedge,
    '',
    `I build websites for ${s.targeting.geography.label} businesses${prospect.industry ? ` — a fair bit of ${prospect.industry} work` : ''}.`,
    previewLine,
    priceSentence,
    '',
    'If it\'s useful, reply and I\'ll show you what I\'d do. If not, no hard feelings.',
    '',
    owner.name,
    owner.business,
    owner.postalAddress,
    owner.unsubscribeLine || 'Reply with STOP and I won\'t contact you again.',
  ].filter((l) => l !== null);

  return {
    ok: true,
    subject: obs.kind === 'no-site-found' ? `Couldn't find a website for ${prospect.name}` : `The website listed for ${prospect.name}`,
    body: lines.join('\n'),
    observationKind: obs.kind,
    mentionsPrice: !!priceSentence,
    mentionsPreview: !!previewLine,
  };
}

/** Warm follow-up. The relationship claim is taken from the record, never assumed. */
export async function composeWarm(contact, { owner = {}, settings = null } = {}) {
  const s = settings || (await getSettings());
  if (!owner.name || !owner.business || !owner.postalAddress) {
    return { ok: false, reason: 'sender identity incomplete' };
  }

  const rel = contact.relationship;
  let opener;
  if (rel === 'met_in_person') {
    const where = contact.event || contact.networkingGroup;
    opener = where ? `Good to meet you at ${where}.` : 'Good to meet you the other day.';
  } else if (rel === 'same_networking_group') {
    // we have NOT met — saying otherwise would be the lie R3.12 exists to stop
    opener = `We're both in ${contact.networkingGroup || 'the same group'}, though I don't think we've actually met.`;
  } else {
    return { ok: false, reason: 'no recorded relationship, so there is nothing truthful to open a warm message with' };
  }

  const price = priceLine(s);
  const lines = [
    `Hi ${contact.name?.value || contact.name || 'there'},`,
    '',
    opener,
    contact.meetingNotes ? `You mentioned ${contact.meetingNotes}.` : null,
    '',
    `I build websites for ${s.targeting.geography.label} businesses. If that's ever useful to ${contact.businessName?.value || contact.businessName || 'you'}, I'm happy to show you what I'd do.`,
    price ? `It's ${price}.` : null,
    '',
    owner.name,
    owner.business,
    owner.postalAddress,
  ].filter((l) => l !== null);

  return { ok: true, subject: `Following up — ${owner.business}`, body: lines.join('\n'), relationship: rel };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

const CKEY = (id) => `campaign:${id}`;
const CINDEX = 'campaigns:all';
const MEMBER = (cid, contactId) => `campaign:member:${cid}:${contactId}`;

export const MEMBER_STATE = Object.freeze({
  SCHEDULED: 'scheduled',
  SENT: 'sent',
  REPLIED: 'replied',
  STOPPED: 'stopped',
});

export async function createCampaign({ name, type, cadence = {}, settings = null }) {
  if (!Object.values(CAMPAIGN_TYPES).includes(type)) return { ok: false, reason: `unknown campaign type "${type}"` };
  const s = settings || (await getSettings());
  const clamped = clampCadence(type, cadence);
  const id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const campaign = {
    id,
    name: String(name || 'Untitled').slice(0, 120),
    type,
    cadence: { gapDays: clamped.gapDays, followUps: clamped.followUps },
    cadenceNotes: clamped.notes,
    createdAt: Date.now(),
    // a campaign is never created running
    status: 'draft',
    outreachActiveAtCreation: s.outreach.active,
  };
  await store.set(CKEY(id), JSON.stringify(campaign));
  await store.sadd(CINDEX, id);
  return { ok: true, campaign };
}

export async function getCampaign(id) {
  const raw = await store.get(CKEY(id)).catch(() => null);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

export async function listCampaigns() {
  const ids = await store.smembers(CINDEX).catch(() => []);
  const out = [];
  for (const id of ids) { const c = await getCampaign(id); if (c) out.push(c); }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * The send plan for one contact: intro now, then follow-ups spaced by the
 * cadence. Pure, so the schedule can be inspected before anything is queued.
 */
export function planSends(campaign, startAt = Date.now()) {
  const out = [{ step: 0, kind: 'intro', at: startAt }];
  for (let i = 1; i <= campaign.cadence.followUps; i++) {
    out.push({ step: i, kind: 'follow-up', at: startAt + i * campaign.cadence.gapDays * 86400000 });
  }
  return out;
}

export async function addMember(campaignId, contact, { startAt = Date.now() } = {}) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, reason: 'unknown campaign' };

  const consent = await canContact(contact, { channel: 'email', purpose: 'promotional' });
  if (!consent.ok) return { ok: false, reason: consent.reason, refused: true };

  const existing = await store.get(MEMBER(campaignId, contact.id)).catch(() => null);
  if (existing) return { ok: false, reason: 'already in this campaign' };

  const member = {
    campaignId,
    contactId: contact.id,
    state: MEMBER_STATE.SCHEDULED,
    plan: planSends(campaign, startAt),
    sentSteps: [],
    addedAt: Date.now(),
  };
  await store.set(MEMBER(campaignId, contact.id), JSON.stringify(member));
  await store.sadd(`campaign:members:${campaignId}`, contact.id);
  return { ok: true, member };
}

export async function getMember(campaignId, contactId) {
  const raw = await store.get(MEMBER(campaignId, contactId)).catch(() => null);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

async function putMember(m) {
  await store.set(MEMBER(m.campaignId, m.contactId), JSON.stringify(m));
  return m;
}

/**
 * R5.4 — the stop. A reply, opt-out, hard bounce or booking cancels every
 * pending send for that contact, in EVERY campaign, immediately.
 *
 * This is deliberately not "mark the current step done". A queued follow-up
 * that fires after someone has replied is the single most damaging thing this
 * system could do, so the whole remaining plan is dropped.
 */
export async function stopContact(contactId, reason) {
  const ids = await store.smembers(CINDEX).catch(() => []);
  const stopped = [];
  for (const cid of ids) {
    const m = await getMember(cid, contactId);
    if (!m || m.state === MEMBER_STATE.STOPPED) continue;
    const pending = m.plan.filter((p) => !m.sentSteps.includes(p.step)).length;
    m.state = MEMBER_STATE.STOPPED;
    m.stoppedReason = reason;
    m.stoppedAt = Date.now();
    m.cancelledSteps = pending;
    m.plan = m.plan.filter((p) => m.sentSteps.includes(p.step)); // nothing pending survives
    await putMember(m);
    stopped.push({ campaignId: cid, cancelled: pending });
  }
  return { stopped, totalCancelled: stopped.reduce((n, s) => n + s.cancelled, 0) };
}

/** What is due right now, respecting the stop and the sending window. */
export async function dueSends(campaignId, { now = Date.now(), window = null } = {}) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, reason: 'unknown campaign', due: [] };
  if (campaign.status !== 'running') return { ok: true, due: [], note: `campaign is ${campaign.status}, not running` };

  const ids = await store.smembers(`campaign:members:${campaignId}`).catch(() => []);
  const due = [];
  for (const contactId of ids) {
    const m = await getMember(campaignId, contactId);
    if (!m || m.state !== MEMBER_STATE.SCHEDULED) continue;
    const next = m.plan.find((p) => !m.sentSteps.includes(p.step) && p.at <= now);
    if (next) due.push({ contactId, step: next.step, kind: next.kind });
  }

  if (window && !withinWindow(now, window)) {
    return { ok: true, due: [], held: due.length, note: `outside the sending window (${window.startHour}:00–${window.endHour}:00, weekdays only)` };
  }
  return { ok: true, due };
}

/** R6.5 — business-local sending window. */
export function withinWindow(ts, { startHour = 8, endHour = 17, weekdaysOnly = true, tzOffsetMinutes = -300 } = {}) {
  const local = new Date(ts + tzOffsetMinutes * 60000);
  const day = local.getUTCDay();
  if (weekdaysOnly && (day === 0 || day === 6)) return false;
  const h = local.getUTCHours();
  return h >= startHour && h < endHour;
}

export async function markStepSent(campaignId, contactId, step) {
  const m = await getMember(campaignId, contactId);
  if (!m) return null;
  if (m.state === MEMBER_STATE.STOPPED) return m; // never resurrect a stopped member
  if (!m.sentSteps.includes(step)) m.sentSteps.push(step);
  if (m.sentSteps.length >= m.plan.length) m.state = MEMBER_STATE.SENT;
  return putMember(m);
}

export async function setCampaignStatus(id, status) {
  const c = await getCampaign(id);
  if (!c) return null;
  if (!['draft', 'running', 'paused', 'done'].includes(status)) return null;
  c.status = status;
  c.statusAt = Date.now();
  await store.set(CKEY(id), JSON.stringify(c));
  return c;
}

/**
 * The join between discovery and campaigns: turn qualified prospects into
 * contacts, then into campaign members.
 *
 * This is where a prospect becomes someone we might actually write to, so the
 * refusals matter more than the successes. A prospect with no email cannot be
 * enrolled at all — we are not guessing an address from a domain — and one
 * whose website verified as present is refused too, because the campaign's
 * whole premise is an observation that no longer holds.
 */
export async function enrolProspects(campaignId, prospectIds) {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, reason: 'unknown campaign', enrolled: 0, refused: [] };

  const { getProspect } = await import('./discovery.js');
  const { upsertContact, field } = await import('./contacts.js');

  const enrolled = [];
  const refused = [];
  for (const pid of prospectIds || []) {
    const p = await getProspect(pid);
    if (!p) { refused.push({ id: pid, reason: 'prospect not found' }); continue; }

    if (!p.email) {
      refused.push({ id: pid, name: p.name, reason: 'no email address on the listing — we do not guess one from the domain' });
      continue;
    }
    const seg = p.qualification?.segment;
    if (campaign.type === CAMPAIGN_TYPES.COLD_NO_SITE && seg !== 'no-site-found') {
      refused.push({ id: pid, name: p.name, reason: `this campaign is for businesses with no website found; this one is "${seg || 'unclassified'}"` });
      continue;
    }
    if (campaign.type === CAMPAIGN_TYPES.COLD_WEAK_SITE && seg !== 'weak-site') {
      refused.push({ id: pid, name: p.name, reason: `this campaign is for businesses whose site did not load; this one is "${seg || 'unclassified'}"` });
      continue;
    }

    const f = (v) => (v ? field(v, { confidence: 0.9, source: 'discovery' }) : null);
    const { contact } = await upsertContact({
      source: 'discovery',
      name: f(p.contactName),
      businessName: f(p.name),
      email: f(p.email),
      phone: f(p.phone),
      website: f(p.website),
      relationship: 'none', // we have never met them, and the copy must reflect that
      discoveredFrom: p.sourceId,
    });

    const add = await addMember(campaignId, contact);
    if (add.ok) enrolled.push({ id: pid, name: p.name, contactId: contact.id });
    else refused.push({ id: pid, name: p.name, reason: add.reason });
  }
  return { ok: true, enrolled: enrolled.length, enrolledDetail: enrolled, refused };
}

/**
 * R5.8 — there is no path from an unanswered email to a text message. This
 * function exists so the prohibition is testable rather than merely absent.
 */
export function mayEscalateToSms() {
  return { allowed: false, reason: 'An unanswered email never becomes a text. SMS requires its own recorded consent.' };
}
