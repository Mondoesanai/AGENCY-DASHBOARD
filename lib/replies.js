// R7 — inbound replies.
//
// R7.1 is the one that matters most and is easiest to get subtly wrong: an
// inbound reply must pause that contact's follow-ups IMMEDIATELY, "including
// the already-queued race".
//
// The race is this. A worker decides a follow-up is due, and between that
// decision and the actual send, the person replies. If "stop" only means
// "don't pick them next time", the message still goes — and the person who just
// answered gets an automated nudge asking why they haven't answered. That is
// the worst output this system can produce, so stopping is checked TWICE:
// once when the reply arrives, and again immediately before the send commits.
//
// `claimSend` is the mechanism. A worker must hold a claim to send, the claim
// is revoked the moment a reply lands, and the send re-checks the claim after
// doing its slow work. A revoked claim cannot be un-revoked.

import { store } from './store.js';
import { stopContact } from './campaigns.js';
import { optOut } from './contacts.js';

const CLAIM = (campaignId, contactId, step) => `send:claim:${campaignId}:${contactId}:${step}`;
const REPLY_FLAG = (contactId) => `reply:stop:${contactId}`;
const INBOX = 'replies:inbox';
const REPLY = (id) => `reply:${id}`;

export const REPLY_KINDS = Object.freeze({
  INTERESTED: 'interested',
  WANTS_DETAILS: 'wants-details',
  WANTS_PREVIEW: 'wants-preview',
  WANTS_CALL: 'wants-call',
  NOT_NOW: 'not-now',
  NOT_INTERESTED: 'not-interested',
  OPT_OUT: 'opt-out',
  AUTO_REPLY: 'auto-reply',
  BOUNCE: 'delivery-failure',
  AMBIGUOUS: 'ambiguous',
});

/** Kinds that are NOT a human choosing to talk to us. */
export const NON_HUMAN = new Set([REPLY_KINDS.AUTO_REPLY, REPLY_KINDS.BOUNCE]);

// ---------------------------------------------------------------------------
// R7.2 — classification.
//
// Rules first, deliberately. The three categories where a wrong answer does
// real damage — opt-out, bounce, auto-reply — are decided by headers and exact
// phrases, never by a model's judgement, because "probably not an opt-out" is
// not a standard anyone should be held to. A model only ever sees the genuinely
// ambiguous remainder, and its answer is clamped to the known set.
//
// When nothing matches, the answer is AMBIGUOUS. That is a real outcome that
// routes to a human, not a failure to be papered over with a guess.
// ---------------------------------------------------------------------------

const STOP_PHRASES = [
  /\bunsubscribe\b/i, /\bopt[- ]?out\b/i, /\btake me off\b/i, /\bremove me\b/i,
  /\bstop (emailing|contacting|messaging)\b/i, /^\s*stop\s*$/i,
  /\bdo not (contact|email|message) me\b/i, /\bdon'?t (contact|email) me\b/i,
  /\bno longer wish to receive\b/i,
];

const NOT_INTERESTED = [
  /\bnot interested\b/i, /\bno thank(s| you)\b/i, /\bwe'?re (all )?(good|set|sorted)\b/i,
  /\bwe already have\b/i, /\balready (have|got) (a|our) (website|guy|developer)\b/i,
  /\bpass\b/i, /\bno need\b/i,
];

const NOT_NOW = [
  /\bnot (right )?now\b/i, /\blater (in the )?year\b/i, /\bnext (quarter|year|month)\b/i,
  /\bcheck back\b/i, /\bcircle back\b/i, /\breach out in\b/i, /\bbusy season\b/i,
  /\bmaybe (in|after)\b/i,
];

const WANTS_CALL = [/\bgive me a call\b/i, /\bcall me\b/i, /\bhop on a call\b/i, /\bschedule a (call|time)\b/i, /\bphone\b.*\b(call|chat)\b/i, /\bwhen (are|r) you free\b/i];
// "mockup" and "mock-up" must match as well as "mock", so no \b after the stem
const WANTS_PREVIEW = [
  /\b(see|show me)\b.{0,12}\b(mock(\s|-)?up|mock|preview|example|draft)/i,
  /\bwhat would it look like\b/i,
  /\bsend (me )?(a |the )?(preview|mock(\s|-)?up|mock)/i,
];
const WANTS_DETAILS = [/\bhow much\b/i, /\bwhat (do|would) (you|it) charge\b/i, /\bpricing\b/i, /\bsend (me )?(more )?(info|details|information)\b/i, /\bwhat'?s involved\b/i, /\btell me more\b/i];
const INTERESTED = [/\b(yes|yeah|sure|sounds good|i'?m interested|interested)\b/i, /\blet'?s do it\b/i, /\bgo ahead\b/i];

/**
 * Classify an inbound message.
 * `headers` matter more than the body for the three dangerous categories.
 */
export function classifyReply({ text = '', subject = '', from = '', headers = {} } = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers || {})) h[String(k).toLowerCase()] = String(v);
  const body = String(text || '');
  const subj = String(subject || '');
  const hay = `${subj}\n${body}`;

  // --- delivery failure: headers are authoritative ---
  if (
    h['x-failed-recipients'] ||
    /mailer-daemon|postmaster/i.test(from) ||
    /^(undeliverable|delivery status notification|returned mail|mail delivery failed)/i.test(subj) ||
    h['content-type']?.includes('report-type=delivery-status')
  ) {
    return { kind: REPLY_KINDS.BOUNCE, confidence: 1, basis: 'delivery-failure headers or sender', byRule: true };
  }

  // --- auto-reply: RFC 3834 and the common vendor headers ---
  if (
    (h['auto-submitted'] && h['auto-submitted'] !== 'no') ||
    h['x-autoreply'] || h['x-autorespond'] || h['x-auto-response-suppress'] ||
    h['precedence'] === 'auto_reply' ||
    /^(out of (the )?office|automatic reply|auto(matic)?[- ]response|away from)/i.test(subj)
  ) {
    return { kind: REPLY_KINDS.AUTO_REPLY, confidence: 1, basis: 'auto-reply headers or subject', byRule: true };
  }

  // --- opt-out: decided by phrase, never by inference ---
  for (const re of STOP_PHRASES) {
    if (re.test(hay)) return { kind: REPLY_KINDS.OPT_OUT, confidence: 1, basis: `explicit stop phrase (${re.source})`, byRule: true };
  }

  // --- the rest: most specific intent first ---
  const check = (list, kind) => (list.some((re) => re.test(hay)) ? kind : null);
  const ordered =
    check(WANTS_CALL, REPLY_KINDS.WANTS_CALL) ||
    check(WANTS_PREVIEW, REPLY_KINDS.WANTS_PREVIEW) ||
    check(WANTS_DETAILS, REPLY_KINDS.WANTS_DETAILS) ||
    check(NOT_INTERESTED, REPLY_KINDS.NOT_INTERESTED) ||
    check(NOT_NOW, REPLY_KINDS.NOT_NOW) ||
    check(INTERESTED, REPLY_KINDS.INTERESTED);

  if (ordered) return { kind: ordered, confidence: 0.8, basis: 'phrase match', byRule: true };

  // Nothing matched. Ambiguous is a real answer that routes to a human.
  return { kind: REPLY_KINDS.AMBIGUOUS, confidence: 0, basis: 'no rule matched; a person should read this', byRule: true };
}

/** Every category the spec requires, so coverage is checkable. */
export const ALL_KINDS = Object.freeze(Object.values(REPLY_KINDS));

/**
 * Take a claim to send one specific message.
 * Returns null if this contact is already stopped — so a worker cannot even
 * begin preparing a send for someone who has replied.
 */
export async function claimSend(campaignId, contactId, step) {
  if (await store.get(REPLY_FLAG(contactId))) {
    return { ok: false, reason: 'this contact has replied; their follow-ups are stopped' };
  }
  const token = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await store.set(CLAIM(campaignId, contactId, step), token, { ex: 3600 });
  return { ok: true, token };
}

/**
 * The second check, immediately before the send commits.
 *
 * A worker calls this AFTER its slow work (composing, provider call setup) and
 * before actually sending. If a reply landed in that window, the claim is gone
 * and the send must not happen.
 */
export async function claimStillValid(campaignId, contactId, step, token) {
  if (await store.get(REPLY_FLAG(contactId))) {
    return { ok: false, reason: 'a reply arrived while this message was being prepared — not sending' };
  }
  const held = await store.get(CLAIM(campaignId, contactId, step));
  if (held !== token) {
    return { ok: false, reason: 'the send claim was revoked or taken by another worker' };
  }
  return { ok: true };
}

/**
 * Record an inbound reply and stop everything for that contact, at once.
 *
 * The stop flag is written FIRST, before the slower campaign bookkeeping, so
 * there is no window where a reply is known about but not yet enforced.
 */
export async function recordReply({ contactId, kind, text = '', campaignId = null, at = Date.now(), messageId = null }) {
  if (!contactId) return { ok: false, reason: 'no contact' };

  // 1. Stop first. Everything else can be slow; this cannot.
  const human = !NON_HUMAN.has(kind);
  if (human) await store.set(REPLY_FLAG(contactId), String(at));

  // 2. Revoke any claim a worker is currently holding for this contact.
  //    (Claims are per-step; the flag above covers steps we cannot enumerate.)
  if (campaignId) {
    for (let step = 0; step <= 5; step++) {
      await store.set(CLAIM(campaignId, contactId, step), '', { ex: 1 }).catch(() => {});
    }
  }

  // 3. Now the bookkeeping.
  let stopped = { stopped: [], totalCancelled: 0 };
  if (human) stopped = await stopContact(contactId, `replied: ${kind}`);

  const id = `${contactId}-${at}`;
  const record = {
    id,
    contactId,
    campaignId,
    kind,
    text: String(text).slice(0, 4000),
    at,
    messageId,
    handled: false,
    // an auto-reply or a bounce is not someone talking to us
    pausedFollowUps: human,
    cancelledSends: stopped.totalCancelled,
  };
  await store.set(REPLY(id), JSON.stringify(record));
  await store.sadd(INBOX, id);

  // 4. An opt-out is a standing instruction, not just a stop.
  if (kind === REPLY_KINDS.OPT_OUT) {
    await optOut({ contactId, reason: 'replied asking to stop' }).catch(() => {});
  }

  return { ok: true, reply: record, stopped };
}

export async function isStopped(contactId) {
  return !!(await store.get(REPLY_FLAG(contactId)));
}

export async function listReplies({ limit = 100, onlyUnhandled = false } = {}) {
  const ids = await store.smembers(INBOX).catch(() => []);
  const out = [];
  for (const id of ids.slice(0, limit)) {
    const raw = await store.get(REPLY(id)).catch(() => null);
    if (!raw) continue;
    try {
      const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (onlyUnhandled && r.handled) continue;
      out.push(r);
    } catch { /* skip */ }
  }
  return out.sort((a, b) => b.at - a.at);
}

export async function markHandled(replyId, by = 'owner') {
  const raw = await store.get(REPLY(replyId)).catch(() => null);
  if (!raw) return null;
  const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
  r.handled = true;
  r.handledBy = by;
  r.handledAt = Date.now();
  await store.set(REPLY(replyId), JSON.stringify(r));
  return r;
}

/**
 * INGESTION — the part that makes R7.1 automatic rather than theoretical.
 *
 * The reviewer was right to ask: `recordReply` on its own only fires if a human
 * tells the system a reply arrived, which is not a pause mechanism at all. This
 * scans the real mailbox, matches senders against people we have actually
 * written to, classifies, and records — which is what revokes send claims.
 *
 * Deliberately narrow: a message only counts as a prospect reply if its sender
 * matches a contact we have a send record for. Anything else is left alone,
 * because this mailbox also carries client mail that `lib/revisions.js` owns.
 */
export async function ingestReplies({
  listMail,
  isKnownContact,
  now = Date.now(),
  days = 7,
  max = 25,
} = {}) {
  if (typeof listMail !== 'function' || typeof isKnownContact !== 'function') {
    return { ok: false, reason: 'ingestion needs a mail source and a contact lookup', ingested: 0 };
  }
  const since = new Date(now - days * 86400000).toISOString().slice(0, 10).replace(/-/g, '/');
  let mail = [];
  try {
    mail = (await listMail(since)) || [];
  } catch (e) {
    return { ok: false, reason: `could not read the mailbox: ${e.message || e}`, transient: true, ingested: 0 };
  }

  const out = { ok: true, scanned: mail.length, ingested: 0, ignored: 0, paused: 0, results: [] };
  for (const m of mail.slice(0, max)) {
    const from = String(m.from || '');
    const addr = (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();

    const known = await isKnownContact(addr, m);
    if (!known) { out.ignored++; continue; }

    const verdict = classifyReply({
      text: m.body || m.snippet || '',
      subject: m.subject || '',
      from,
      headers: m.headers || {},
    });

    const rec = await recordReply({
      contactId: known.contactId,
      kind: verdict.kind,
      text: m.body || m.snippet || '',
      campaignId: known.campaignId || null,
      at: m.at || now,
      messageId: m.id || null,
    });
    if (!rec.ok) continue;

    out.ingested++;
    if (rec.reply.pausedFollowUps) out.paused++;
    out.results.push({
      from: addr,
      kind: verdict.kind,
      basis: verdict.basis,
      pausedFollowUps: rec.reply.pausedFollowUps,
      cancelledSends: rec.reply.cancelledSends,
    });
  }
  out.note = 'Replies are recorded and follow-ups paused. Nothing here answers anyone.';
  return out;
}

/**
 * The real lookup: is this address someone we have actually written to?
 *
 * Only a contact with a recorded SEND counts. Someone merely sitting in the
 * contact list who emails us about something else is not a campaign reply, and
 * treating them as one would stop campaigns they were never in.
 */
export async function prospectReplyLookup(address) {
  const { findDuplicates } = await import('./contacts.js');
  const matches = await findDuplicates({ email: address }).catch(() => []);
  // Only an EXACT email match identifies the person who replied. A domain match
  // means a colleague, and stopping their campaign because someone else at the
  // company wrote to us would be wrong.
  const contact = (matches || []).find((m) => m.certainty === 'exact')?.contact;
  if (!contact) return null;

  const ids = await store.smembers('campaigns:all').catch(() => []);
  for (const cid of ids) {
    const raw = await store.get(`campaign:member:${cid}:${contact.id}`).catch(() => null);
    if (!raw) continue;
    try {
      const m = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if ((m.sentSteps || []).length > 0) return { contactId: contact.id, campaignId: cid };
    } catch { /* skip */ }
  }
  return null;
}

/** The scheduled pass: real mailbox, real contacts. */
export async function runReplyIngest({ now = Date.now(), days = 7, max = 25 } = {}) {
  const { listNewMail, googleConfigured } = await import('./google.js');
  if (!googleConfigured()) return { ok: false, reason: 'Gmail is not connected, so replies cannot be detected automatically', ingested: 0 };
  return ingestReplies({
    listMail: (since) => listNewMail(since),
    isKnownContact: (addr) => prospectReplyLookup(addr),
    now,
    days,
    max,
  });
}

/**
 * The guarded send. This is the ONLY shape a worker should use: claim, do the
 * slow work, re-check, then commit. Exported so the ordering is testable rather
 * than a convention someone has to remember.
 */
export async function guardedSend({ campaignId, contactId, step, prepare, commit }) {
  const claim = await claimSend(campaignId, contactId, step);
  if (!claim.ok) return { sent: false, reason: claim.reason, stage: 'claim' };

  const prepared = await prepare();
  if (!prepared || prepared.ok === false) {
    return { sent: false, reason: prepared?.reason || 'preparation failed', stage: 'prepare' };
  }

  const still = await claimStillValid(campaignId, contactId, step, claim.token);
  if (!still.ok) return { sent: false, reason: still.reason, stage: 'recheck' };

  const result = await commit(prepared);
  return { sent: true, result, stage: 'commit' };
}
