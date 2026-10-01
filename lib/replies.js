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
