// What we may text somebody about one preview request — and who sends what.
//
// R19.2. The form promises "up to N texts for this request". That sentence is
// only honest if N is a number the code enforces, so this file is both: the
// enumerated plan the page quotes, and the gate that refuses message N+1.
//
// TWO PROBLEMS THIS SOLVES:
//
//  1. THE NUMBER ON THE PAGE. A consent line that says "up to 8" while the
//     system has no ceiling is a fabricated figure. `MAX_REQUEST_TEXTS` is
//     derived from the plan below, the page reads it from the server, and
//     `claimRequestText` will not let a ninth through.
//
//  2. DUPLICATE NOTIFICATIONS. Google Calendar already emails the invitation,
//     every change to it, and its own reminders, because we create the event
//     with `sendUpdates: 'all'`. If our app also emailed those, the prospect
//     gets each one twice. So every notification in the lifecycle is assigned
//     to exactly ONE owner: the calendar provider owns appointment EMAIL, we
//     own SMS and the preview-delivery email. Nothing is owned by both.
//
// AND THE THING IT WILL NOT DO: none of this is permission. Every entry below
// is only sendable to somebody whose promotional consent already passed
// `mayText`, which this file does not touch and cannot soften. A plan is a
// ceiling, not a licence.

import { store } from './store.js';

export const OWNER = Object.freeze({
  US: 'our-app',
  CALENDAR: 'calendar-provider',   // Google Calendar, via sendUpdates:'all'
});

/**
 * The whole lifecycle, one row per notification, with its single owner.
 *
 * `channel: 'sms'` + `owner: US` is what counts towards the quoted maximum.
 * Everything else is listed so the split is visible and reviewable rather than
 * implied.
 */
export const REQUEST_MESSAGE_PLAN = Object.freeze([
  { kind: 'booking-confirmation', channel: 'sms', owner: OWNER.US, when: 'immediately after the provider confirms' },
  { kind: 'calendar-invitation', channel: 'email', owner: OWNER.CALENDAR, when: 'with the event — Google sends it, we do not' },
  { kind: 'reminder-24h', channel: 'sms', owner: OWNER.US, when: 'about a day before' },
  { kind: 'reminder-1h', channel: 'sms', owner: OWNER.US, when: 'about an hour before' },
  { kind: 'reschedule-or-cancel', channel: 'sms', owner: OWNER.US, when: 'if the time changes' },
  { kind: 'calendar-update', channel: 'email', owner: OWNER.CALENDAR, when: 'if the time changes — Google sends it' },
  { kind: 'preview-ready', channel: 'sms', owner: OWNER.US, when: 'when a real preview URL exists and has been reviewed' },
  { kind: 'preview-delivery', channel: 'email', owner: OWNER.US, when: 'with the preview link — the calendar knows nothing about this' },
  // The owner asked for this one by name: the page must say we will text after
  // the appointment as well, so it is in the plan and inside the ceiling.
  { kind: 'post-appointment-followup', channel: 'sms', owner: OWNER.US, when: 'after the call' },
  { kind: 'no-show-followup', channel: 'sms', owner: OWNER.US, when: 'only if they did not attend' },
]);

/** The number the consent line quotes. Derived, never typed twice. */
export const MAX_REQUEST_TEXTS = REQUEST_MESSAGE_PLAN
  .filter((m) => m.channel === 'sms' && m.owner === OWNER.US).length;

/** Only these kinds may ever be sent as a text under a preview request. */
export const TEXTABLE_KINDS = Object.freeze(
  REQUEST_MESSAGE_PLAN.filter((m) => m.channel === 'sms' && m.owner === OWNER.US).map((m) => m.kind),
);

/**
 * Who sends a given notification?
 *
 * Call this before sending anything in the lifecycle. If it answers CALENDAR,
 * we must not send it — Google already did.
 */
export function notificationOwner(kind, channel) {
  const row = REQUEST_MESSAGE_PLAN.find((m) => m.kind === kind && (!channel || m.channel === channel));
  if (!row) return { known: false, owner: null, weSend: false, why: `"${kind}" is not in the plan` };
  return {
    known: true,
    owner: row.owner,
    channel: row.channel,
    weSend: row.owner === OWNER.US,
    why: row.owner === OWNER.CALENDAR
      ? 'the calendar provider already sends this — sending it too would duplicate it'
      : 'this one is ours',
  };
}

const usedKey = (requestId) => `preq:sms:used:${requestId}`;
const kindKey = (requestId, kind) => `preq:sms:${requestId}:${kind}`;

/**
 * Take one text out of this request's allowance.
 *
 * Refuses on three grounds, in this order:
 *   · the kind is not a text we ever send for a request;
 *   · we already sent that exact kind (so a retried job cannot double-text);
 *   · the allowance is spent.
 *
 * The count is an atomic INCR, so two concurrent jobs cannot both see "7 used"
 * and both send the eighth and ninth.
 *
 * FAILS CLOSED. If the counter cannot be read we do not send: an outage must
 * make texting harder, never easier. The one message type where that matters
 * most is the one most likely to be retried.
 */
/**
 * The texts that only make sense for an appointment that actually exists.
 *
 * R19.7 — "only confirmed appointments get reminders". A request where the
 * calendar was disconnected, or where booking failed, is a request for a call,
 * not an appointment: reminding somebody about a meeting that was never booked
 * is worse than saying nothing, because they may clear the time for it.
 */
export const NEEDS_CONFIRMED_BOOKING = Object.freeze([
  'booking-confirmation', 'reminder-24h', 'reminder-1h', 'reschedule-or-cancel', 'no-show-followup',
]);

export async function claimRequestText({ requestId, kind, bookingConfirmed = null, now = Date.now() } = {}) {
  if (!requestId) return { ok: false, reason: 'no request id, so the allowance cannot be counted' };
  if (NEEDS_CONFIRMED_BOOKING.includes(kind) && bookingConfirmed !== true) {
    return {
      ok: false,
      needsBooking: true,
      reason: `"${kind}" is only for a confirmed appointment, and this request ${bookingConfirmed === false ? 'has none' : 'has not shown one'}. Reminding somebody about a meeting that was never booked may make them clear the time for it.`,
    };
  }
  if (!TEXTABLE_KINDS.includes(kind)) {
    const who = notificationOwner(kind, 'sms');
    return {
      ok: false,
      reason: who.known
        ? `"${kind}" is not ours to send — ${who.why}`
        : `"${kind}" is not one of the texts this request allows`,
    };
  }

  // Per-kind: exactly one of each, however many times the job runs.
  let once;
  try {
    once = await store.claimOnce(kindKey(requestId, kind), { ttlSec: 60 * 60 * 24 * 120, now });
  } catch {
    return { ok: false, reason: 'the message ledger could not be read, so nothing was sent', retryable: true };
  }
  if (!once || once.won !== true) {
    return { ok: false, alreadySent: true, reason: `the ${kind} text has already gone out` };
  }

  // Then the ceiling the page quoted.
  let used;
  try {
    used = await store.incr(usedKey(requestId), 1);
  } catch {
    return { ok: false, reason: 'the message allowance could not be counted, so nothing was sent', retryable: true };
  }
  if (!Number.isFinite(used)) {
    return { ok: false, reason: 'the message allowance could not be counted, so nothing was sent', retryable: true };
  }
  if (used > MAX_REQUEST_TEXTS) {
    return {
      ok: false,
      overCap: true,
      used,
      max: MAX_REQUEST_TEXTS,
      reason: `this request has already used its ${MAX_REQUEST_TEXTS} texts`,
    };
  }

  return { ok: true, kind, used, max: MAX_REQUEST_TEXTS, remaining: MAX_REQUEST_TEXTS - used };
}

/** What the page should say, generated from the enforced plan. */
export function consentCopy({ business = 'Inspiring Websites' } = {}) {
  return {
    lead: `I agree to receive texts from ${business}`,
    detail: 'About my requested website preview and appointment — confirmation, reminders, '
      + 'rescheduling information, a link to my preview when it is ready, and a follow-up text '
      + 'after the appointment.',
    max: MAX_REQUEST_TEXTS,
    frequency: `Up to ${MAX_REQUEST_TEXTS} texts for this request.`,
    rates: 'Message and data rates may apply.',
    keywords: 'Reply STOP to opt out or HELP for help.',
    optional: 'Texts are optional and are not required to book.',
  };
}

/** For the owner's screen: what has been used, and what is left. */
export async function requestTextLedger(requestId) {
  const out = { requestId, max: MAX_REQUEST_TEXTS, used: 0, sent: [], readable: true };
  try {
    const raw = await store.get(usedKey(requestId));
    out.used = Number(raw) || 0;
  } catch {
    out.readable = false;
    return out;
  }
  for (const kind of TEXTABLE_KINDS) {
    const at = await store.get(kindKey(requestId, kind)).catch(() => null);
    if (at) out.sent.push({ kind, at: Number(at) || null });
  }
  out.remaining = Math.max(0, MAX_REQUEST_TEXTS - out.used);
  return out;
}
