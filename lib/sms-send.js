// Sending a text, as a product workflow rather than a button.
//
// The gates already exist and are reused, not reimplemented: `mayText` decides
// permission (lib/phone.js), `withinQuietHours` decides timing
// (lib/sms-inbound.js), `getSmsAdapter` decides transport (lib/sms-outreach.js),
// and `conversations.js` owns the thread. This module is the part that was
// missing — composing a message, knowing what it will cost, scheduling it,
// sending it, and tracking what actually happened to it.
//
// FOUR THINGS IT REFUSES TO DO, each of which is a real pattern:
//
//   · Send without checking permission at SEND time. Consent recorded in
//     January does not survive a STOP in March, and the gate runs at the
//     moment of sending, not when the message was queued.
//   · Send outside quiet hours. A marketing text at 7am is the thing people
//     complain to carriers about, and a complaint is what takes the number
//     down for everyone.
//   · Claim a preview exists. The one message type that names a link is gated
//     on `previews.mayAnnounce`, which requires a real URL.
//   · Hide what it costs. Segments are computed from the actual encoding, so
//     a message that quietly became three segments says so before it is sent.

import { store } from './store.js';

const MSG = (id) => `sms:msg:${id}`;
const INDEX = 'sms:messages';
const BY_CONTACT = (id) => `sms:byContact:${id}`;

/** What has actually happened to a message. Not the same as "we sent it". */
export const SMS_DELIVERY = Object.freeze({
  DRAFT: 'draft',
  SCHEDULED: 'scheduled',
  SENDING: 'sending',
  ACCEPTED: 'accepted',     // the provider took it — NOT delivery
  DELIVERED: 'delivered',   // the carrier confirmed it
  FAILED: 'failed',
  UNDELIVERED: 'undelivered',
  UNKNOWN: 'unknown',       // sent, never confirmed either way
});

export const DELIVERY_LABEL = Object.freeze({
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  accepted: 'Accepted by provider',
  delivered: 'Delivered',
  failed: 'Failed',
  undelivered: 'Not delivered',
  unknown: 'Unconfirmed',
});

// GSM-7 covers most plain English; anything outside it forces UCS-2, which
// halves the characters per segment. Getting this wrong is how a message the
// owner thought cost one segment quietly costs three.
const GSM7 = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXT = '^{}\\[~]|€';

export function encodingOf(text) {
  const s = String(text || '');
  for (const ch of s) {
    if (GSM7.includes(ch)) continue;
    if (GSM7_EXT.includes(ch)) continue;
    return 'UCS2';
  }
  return 'GSM7';
}

/** Segments, counted the way the carrier counts them. */
export function segmentsFor(text) {
  const s = String(text || '');
  const enc = encodingOf(s);
  if (enc === 'GSM7') {
    // extended characters take two septets each
    let septets = 0;
    for (const ch of s) septets += GSM7_EXT.includes(ch) ? 2 : 1;
    if (septets <= 160) return { encoding: enc, units: septets, segments: septets === 0 ? 0 : 1 };
    return { encoding: enc, units: septets, segments: Math.ceil(septets / 153) };
  }
  const units = [...s].length;
  if (units <= 70) return { encoding: enc, units, segments: units === 0 ? 0 : 1 };
  return { encoding: enc, units, segments: Math.ceil(units / 67) };
}

/**
 * What this will cost, stated as an ESTIMATE because it is one.
 *
 * The per-segment price is a setting rather than a constant: it varies by
 * provider and by destination, and a hard-coded number would quietly become
 * wrong. Reconciled against real billing by `reconcileUsage` below, which is
 * the only thing allowed to report an actual cost.
 */
export const DEFAULT_SEGMENT_COST_CENTS = 0.79; // US A2P 10DLC, order of magnitude

export async function estimateCost(text, { recipients = 1 } = {}) {
  let perSegment = DEFAULT_SEGMENT_COST_CENTS;
  try {
    const raw = await store.get('sms:segmentCostCents');
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) perSegment = n;
  } catch { /* the default is an estimate either way */ }
  const seg = segmentsFor(text);
  return {
    ...seg,
    recipients,
    perSegmentCents: perSegment,
    estimatedCents: +(seg.segments * recipients * perSegment).toFixed(3),
    isEstimate: true,
    note: 'An estimate from segment count and a configured rate. Actual cost comes from the provider\'s billing, not from here.',
  };
}

const newId = () => `sm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Compose and check — everything except sending.
 *
 * Returns what the message will look like, what it will cost, whether it is
 * permitted, and whether now is a reasonable time. Used by the preview in the
 * dashboard, so what the owner approves is exactly what the gate evaluated.
 */
export async function compose({ contact, body, purpose = 'one_time_followup', at = Date.now() }) {
  // `reason` is set on EVERY refusal, not only the late ones. The early returns
  // used to carry `error` while the main path carried `reason`, and the screen
  // reads `reason` — so a refused draft rendered as "Cannot send." with nothing
  // after it, which is the least useful thing a refusal can say.
  if (!contact) return { ok: false, error: 'no contact', reason: 'no contact' };
  const text = String(body || '').trim();
  if (!text) {
    const r = 'there is nothing written yet';
    return { ok: false, error: r, reason: r, body: '' };
  }

  const { mayText } = await import('./phone.js');
  const { withinQuietHours } = await import('./sms-inbound.js');
  const permission = await mayText({ contact, purpose, now: at });
  const cost = await estimateCost(text);
  const to = contact?.phone?.value || contact?.phone || '';
  const quiet = to ? withinQuietHours(to, { at }) : { ok: false, reason: 'no number' };

  // R9.8 — the same prohibitions that apply to email copy apply here
  const { inspect } = await import('./prohibition.js');
  const prohibited = inspect(text);

  return {
    ok: permission.ok && prohibited.ok,
    body: text,
    to,
    cost,
    permission,
    quietHours: quiet,
    prohibited: prohibited.ok ? null : prohibited.findings,
    // stated separately: being permitted is not the same as it being a
    // sensible moment, and the owner should see both
    sendableNow: permission.ok && prohibited.ok && quiet.ok !== false,
    reason: !permission.ok ? permission.reason
      : !prohibited.ok ? `the wording is not allowed: ${prohibited.findings[0].why}`
        : quiet.ok === false ? `it is outside their quiet hours — ${quiet.reason}`
          : null,
  };
}

/**
 * Queue a message. Nothing is sent by this call.
 *
 * Scheduling writes a record with the time it should go; the send path checks
 * permission AGAIN at that moment, because the gap between scheduling and
 * sending is exactly where a STOP arrives.
 */
export async function schedule({
  contact, body, purpose = 'one_time_followup', sendAt = Date.now(), by = 'owner', campaignId = null,
  // R19.2 — a message belonging to a preview request carries its request and
  // which planned notification it is, so the send path can hold it to the
  // ceiling the form quoted and refuse a kind the calendar provider already
  // sends. Absent on ordinary messages, which are governed by consent alone.
  requestId = null, requestKind = null,
}) {
  const draft = await compose({ contact, body, purpose, at: sendAt });
  if (!draft.ok) return { ok: false, error: draft.reason || 'this message cannot be sent', draft };

  // Refuse at queue time too, so a message the plan does not allow never sits
  // in the queue looking as though it will go.
  if (requestId || requestKind) {
    const { notificationOwner } = await import('./request-sms.js');
    const who = notificationOwner(requestKind, 'sms');
    if (!who.weSend) {
      return { ok: false, error: `this is not a text we send for a preview request — ${who.why}` };
    }
  }

  const msg = {
    id: newId(),
    contactId: contact.id,
    to: draft.to,
    body: draft.body,
    purpose,
    campaignId,
    requestId,
    requestKind,
    state: SMS_DELIVERY.SCHEDULED,
    sendAt,
    createdAt: Date.now(),
    createdBy: by,
    segments: draft.cost.segments,
    estimatedCents: draft.cost.estimatedCents,
    providerId: null,
    history: [{ at: Date.now(), state: SMS_DELIVERY.SCHEDULED, by }],
  };
  await store.set(MSG(msg.id), JSON.stringify(msg));
  await store.sadd(INDEX, msg.id).catch(() => {});
  await store.sadd(BY_CONTACT(contact.id), msg.id).catch(() => {});
  return { ok: true, message: msg };
}

export async function getMessage(id) {
  try {
    const raw = await store.get(MSG(id));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * Actually send one scheduled message.
 *
 * Re-checks everything. The checks at schedule time were about whether to
 * queue it; these are about whether to send it, and the answer can have
 * changed — which is the entire reason they are repeated rather than trusted.
 */
export async function send(messageId, { contact, env = process.env, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const msg = await getMessage(messageId);
  if (!msg) return { ok: false, error: `no message "${messageId}"` };
  if (msg.state !== SMS_DELIVERY.SCHEDULED && msg.state !== SMS_DELIVERY.DRAFT) {
    return { ok: false, error: `this message is already ${DELIVERY_LABEL[msg.state] || msg.state}`, state: msg.state };
  }

  // the conversation may have moved on since this was queued
  const { isPaused } = await import('./conversations.js');
  const paused = await isPaused(msg.contactId);
  if (paused.paused) {
    await mark(msg, SMS_DELIVERY.DRAFT, { note: paused.reason || 'the conversation is paused' });
    return { ok: false, error: paused.reason || 'this conversation is paused', held: true };
  }

  const recheck = await compose({ contact, body: msg.body, purpose: msg.purpose, at: now });
  if (!recheck.ok) {
    await mark(msg, SMS_DELIVERY.FAILED, { note: recheck.reason || 'no longer permitted' });
    return { ok: false, error: recheck.reason || 'no longer permitted at send time', permissionChanged: true };
  }
  if (recheck.quietHours && recheck.quietHours.ok === false) {
    return { ok: false, error: `held: ${recheck.quietHours.reason}`, held: true, retryAfter: recheck.quietHours.nextOkAt || null };
  }

  const { getSmsAdapter } = await import('./sms-outreach.js');
  const adapter = getSmsAdapter({ env, fetchImpl });
  if (!adapter.configured || !adapter.configured()) {
    await mark(msg, SMS_DELIVERY.DRAFT, { note: 'no SMS provider connected' });
    return { ok: false, error: 'no SMS provider is connected, so nothing was sent', disconnected: true };
  }

  // R19.2 — the ceiling the consent line quoted, enforced at the last possible
  // moment. Claimed AFTER the provider is known to be connected (so a
  // disconnected adapter does not burn an allowance) and BEFORE the send, so
  // the claim and the send cannot be separated by a crash in a way that lets a
  // retry send twice. Each kind is claimed once; the total is an atomic INCR.
  if (msg.requestId) {
    const { claimRequestText } = await import('./request-sms.js');
    const allow = await claimRequestText({ requestId: msg.requestId, kind: msg.requestKind, now });
    if (!allow.ok) {
      await mark(msg, allow.retryable ? SMS_DELIVERY.SCHEDULED : SMS_DELIVERY.FAILED, { note: allow.reason });
      return { ok: false, error: allow.reason, overCap: !!allow.overCap, alreadySent: !!allow.alreadySent, retryable: !!allow.retryable };
    }
  }

  await mark(msg, SMS_DELIVERY.SENDING, { note: 'handed to the provider' });
  let res;
  try {
    res = await adapter.send({ to: msg.to, body: msg.body });
  } catch (e) {
    await mark(msg, SMS_DELIVERY.UNKNOWN, { note: `the request threw: ${String(e.message || e)}` });
    return { ok: false, error: String(e.message || e), unknown: true };
  }

  if (!res || res.ok !== true) {
    const transient = !!(res && res.transient);
    await mark(msg, transient ? SMS_DELIVERY.UNKNOWN : SMS_DELIVERY.FAILED, { note: (res && res.error) || 'no response' });
    return { ok: false, error: (res && res.error) || 'the provider refused it', transient };
  }

  await mark(msg, SMS_DELIVERY.ACCEPTED, { note: 'the provider accepted it', providerId: res.sid || null });

  // the thread is the record of what this person has actually received
  try {
    const { record, CHANNEL, DIRECTION } = await import('./conversations.js');
    await record({
      contactId: msg.contactId, channel: CHANNEL.SMS, direction: DIRECTION.OUT,
      body: msg.body, at: now, by: msg.createdBy, campaignId: msg.campaignId,
      messageId: msg.id, state: SMS_DELIVERY.ACCEPTED,
    });
  } catch { /* the message record above is the authoritative one */ }

  return { ok: true, accepted: true, providerId: res.sid || null, messageId: msg.id };
}

async function mark(msg, state, { note = '', providerId = null, at = Date.now() } = {}) {
  msg.state = state;
  if (providerId) msg.providerId = providerId;
  msg.history = [...(msg.history || []), { at, state, note }].slice(-20);
  await store.set(MSG(msg.id), JSON.stringify(msg));
  return msg;
}

/**
 * A delivery receipt from the provider.
 *
 * "Accepted" and "delivered" are different facts and are kept apart, because
 * reporting acceptance as delivery is how a number that is silently failing
 * looks healthy for a week.
 */
export async function applyDeliveryReceipt({ providerId, status, errorCode = null, at = Date.now() }) {
  let ids = [];
  try {
    ids = await store.smembers(INDEX);
  } catch {
    return { ok: false, error: 'the message index could not be read' };
  }
  for (const id of ids) {
    const m = await getMessage(id);
    if (!m || m.providerId !== providerId) continue;
    const map = {
      delivered: SMS_DELIVERY.DELIVERED,
      undelivered: SMS_DELIVERY.UNDELIVERED,
      failed: SMS_DELIVERY.FAILED,
      sent: SMS_DELIVERY.ACCEPTED,
    };
    const next = map[String(status).toLowerCase()] || SMS_DELIVERY.UNKNOWN;
    await mark(m, next, { note: errorCode ? `provider code ${errorCode}` : `provider says ${status}`, at });

    // a hard failure is a fact about the NUMBER, not just this message
    if (next === SMS_DELIVERY.FAILED || next === SMS_DELIVERY.UNDELIVERED) {
      try {
        const { applySendFailure, classifySendFailure } = await import('./sms-inbound.js');
        const kind = classifySendFailure({ code: errorCode, message: status });
        await applySendFailure(m.to, { code: errorCode, message: status, kind });
      } catch { /* the message state above still records it */ }
    }
    return { ok: true, messageId: m.id, state: next };
  }
  return { ok: false, error: 'no message matches that provider id', unmatched: true };
}

export async function forContact(contactId, { limit = 50 } = {}) {
  let ids = [];
  try {
    ids = await store.smembers(BY_CONTACT(contactId));
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const m = await getMessage(id);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** Counts for the report, with the distinctions that matter kept apart. */
export async function stats() {
  let ids = [];
  try {
    ids = await store.smembers(INDEX);
  } catch {
    return { ok: false, error: 'the message index could not be read' };
  }
  const by = Object.fromEntries(Object.values(SMS_DELIVERY).map((s) => [s, 0]));
  let segments = 0;
  let cents = 0;
  for (const id of ids) {
    const m = await getMessage(id);
    if (!m) continue;
    by[m.state] = (by[m.state] || 0) + 1;
    segments += Number(m.segments || 0);
    cents += Number(m.estimatedCents || 0);
  }
  const attempted = by.accepted + by.delivered + by.failed + by.undelivered + by.unknown;
  return {
    ok: true,
    attempted,
    accepted: by.accepted + by.delivered,
    delivered: by.delivered,
    failed: by.failed + by.undelivered,
    deliveryUnknown: by.unknown,
    scheduled: by.scheduled,
    byState: by,
    segments,
    estimatedCents: +cents.toFixed(2),
    // said out loud, because the number above is the one people quote
    costIsEstimate: true,
  };
}

/**
 * Reconcile against the provider's real billing.
 *
 * Until this runs, every cost figure in the dashboard is an estimate and says
 * so. This is the only function allowed to produce an actual number, and it
 * refuses to invent one when no billing data has been supplied.
 */
export async function reconcileUsage(billing = null) {
  if (!billing || typeof billing.totalCents !== 'number') {
    return {
      ok: false,
      reason: 'no provider billing data has been supplied, so there is no actual cost to report — only the estimate',
      haveActual: false,
    };
  }
  const s = await stats();
  await store.set('sms:billing:last', JSON.stringify({ at: Date.now(), ...billing })).catch(() => {});
  return {
    ok: true,
    haveActual: true,
    actualCents: billing.totalCents,
    estimatedCents: s.estimatedCents,
    differenceCents: +(billing.totalCents - s.estimatedCents).toFixed(2),
    period: billing.period || null,
  };
}
