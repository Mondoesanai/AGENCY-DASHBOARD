// The real funnel: ten events that are not each other.
//
// R19.7. The question the owner needs answered is "where do people drop out",
// and a funnel answers it only if each stage counts a different thing. The way
// this goes wrong is always the same: a page view, a slot click and a form
// submission get folded into "bookings", the number looks healthy, and the week
// has no meetings in it.
//
// So the one rule this module exists to enforce: A BOOKING IS ONLY A BOOKING
// WHEN THE SCHEDULING PROVIDER CONFIRMED IT. `record` refuses a confirmed
// booking with no provider reference — not by ignoring it, by returning a
// refusal that says what was missing. Everything earlier in the funnel has its
// own event and can never increment that one.
//
// The same applies at the other end. "Attended" is something that happened, not
// something a visitor ticked on a form: the attendance checkbox is an
// acknowledgment and is recorded as RECONFIRMED, never as ATTENDED.

import { store } from './store.js';

export const FUNNEL = Object.freeze({
  INVITATION: 'invitation-sent',        // we asked somebody to look
  FORM_VISIT: 'form-visit',             // the page was opened
  SUBMITTED: 'request-submitted',       // they filled it in — NOT a booking
  BOOKED: 'booking-confirmed',          // the PROVIDER confirmed a time
  PREVIEW_BUILT: 'preview-built',       // a real URL exists and was reviewed
  PREVIEW_DELIVERED: 'preview-delivered', // they were sent the link
  RECONFIRMED: 'reconfirmed',           // they said they still plan to come
  ATTENDED: 'call-attended',            // they actually came
  CANCELLED: 'cancelled',
  NO_SHOW: 'no-show',
});

/** The order a person moves through, for drop-off between stages. */
export const FUNNEL_ORDER = Object.freeze([
  FUNNEL.INVITATION, FUNNEL.FORM_VISIT, FUNNEL.SUBMITTED, FUNNEL.BOOKED,
  FUNNEL.PREVIEW_BUILT, FUNNEL.PREVIEW_DELIVERED, FUNNEL.RECONFIRMED, FUNNEL.ATTENDED,
]);

/** The two that are not stages — they are ways out of it. */
export const FUNNEL_EXITS = Object.freeze([FUNNEL.CANCELLED, FUNNEL.NO_SHOW]);

export const FUNNEL_LABEL = Object.freeze({
  'invitation-sent': 'Invited',
  'form-visit': 'Opened the form',
  'request-submitted': 'Sent their details',
  'booking-confirmed': 'Booked a time',
  'preview-built': 'Preview built',
  'preview-delivered': 'Preview sent to them',
  reconfirmed: 'Said they still plan to come',
  'call-attended': 'Came to the call',
  cancelled: 'Cancelled',
  'no-show': 'Did not turn up',
});

/**
 * Events that cannot be recorded on somebody's say-so.
 *
 * Each names the evidence it requires. A caller that cannot supply it is
 * recording something it does not actually know.
 */
const REQUIRES_EVIDENCE = Object.freeze({
  [FUNNEL.BOOKED]: {
    field: 'providerId',
    why: 'a booking counts only when the scheduling provider confirmed it. A page view, a slot selection and a form submission are different events.',
  },
  [FUNNEL.PREVIEW_BUILT]: {
    field: 'previewUrl',
    why: 'a preview counts as built only when there is a real URL. "Being built" is not built.',
  },
  [FUNNEL.PREVIEW_DELIVERED]: {
    field: 'previewUrl',
    why: 'a preview counts as delivered only when there was a link to deliver.',
  },
  [FUNNEL.ATTENDED]: {
    field: 'observedBy',
    why: 'attendance is something that happened, observed by somebody. A ticked "I plan to attend" box is a RECONFIRMED event, never this one.',
  },
});

const key = (ev) => `funnel:${ev}`;
const LOG = 'funnel:log';

/**
 * Record one funnel event.
 *
 * Returns `{ ok: false, reason }` rather than throwing, so a caller on a
 * request path cannot fail a person's booking because a counter was unhappy —
 * and cannot quietly succeed either.
 */
export async function record(event, { contactId = null, requestId = null, at = Date.now(), ...evidence } = {}) {
  if (!Object.values(FUNNEL).includes(event)) {
    return { ok: false, reason: `"${event}" is not a funnel event` };
  }
  const needs = REQUIRES_EVIDENCE[event];
  if (needs && !evidence[needs.field]) {
    return { ok: false, reason: `${FUNNEL_LABEL[event]} needs ${needs.field}: ${needs.why}`, missing: needs.field };
  }

  // Counted per event, never shared. Two counters cannot drift into each other
  // the way one counter with a "type" field can.
  let n;
  try {
    n = await store.incr(key(event), 1);
  } catch (e) {
    return { ok: false, reason: 'the funnel counter could not be written', error: String(e?.message || e) };
  }

  // The log is best effort; the count is the number. A failed log must not
  // make a real event look like it did not happen.
  //
  // Written as a dated key with a TTL rather than a list, because the store has
  // no list type and faking one with a set would grow without bound.
  try {
    const id = `${at.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    await store.set(`${LOG}:${id}`, JSON.stringify({ event, at, contactId, requestId, ...evidence }), { ex: 60 * 60 * 24 * 90 });
    await store.sadd(LOG, id);
  } catch { /* the counter above is the record */ }

  return { ok: true, event, count: n };
}

/**
 * The funnel as numbers, with the drop-off between each stage.
 *
 * `readable: false` rather than zeros when the store cannot answer — a funnel
 * of zeros reads as "nobody came", which is a different and much worse claim
 * than "I could not count".
 */
export async function report() {
  const out = { stages: [], exits: [], readable: true };
  const counts = {};
  for (const ev of [...FUNNEL_ORDER, ...FUNNEL_EXITS]) {
    try {
      counts[ev] = Number(await store.get(key(ev))) || 0;
    } catch {
      out.readable = false;
      out.why = 'the funnel counters could not be read, so these numbers are not being shown rather than shown as zero';
      return out;
    }
  }

  let prev = null;
  for (const ev of FUNNEL_ORDER) {
    const n = counts[ev];
    out.stages.push({
      event: ev,
      label: FUNNEL_LABEL[ev],
      count: n,
      // Stated as a fraction of the PREVIOUS stage, which is the number that
      // says where people are actually lost.
      fromPrevious: prev === null ? null : (prev === 0 ? null : Math.round((n / prev) * 100)),
    });
    prev = n;
  }
  for (const ev of FUNNEL_EXITS) {
    out.exits.push({ event: ev, label: FUNNEL_LABEL[ev], count: counts[ev] });
  }

  // The two numbers most likely to be conflated, reported side by side so they
  // cannot be.
  out.submittedButNotBooked = Math.max(0, counts[FUNNEL.SUBMITTED] - counts[FUNNEL.BOOKED]);
  out.bookedButNotAttended = Math.max(0, counts[FUNNEL.BOOKED] - counts[FUNNEL.ATTENDED]);
  out.note = 'A booking is counted only when the scheduling provider confirmed it. Page views, slot selections and form submissions are counted separately and are never bookings.';
  return out;
}

/** The last events, newest first — for the owner to see what is happening now. */
export async function recent(limit = 50) {
  let ids;
  try {
    ids = await store.smembers(LOG);
  } catch {
    return { ok: false, events: [], reason: 'the funnel log could not be read' };
  }
  const rows = [];
  for (const id of (ids || [])) {
    const raw = await store.get(`${LOG}:${id}`).catch(() => null);
    // An id whose record has expired is dropped from the index rather than
    // left to accumulate, since the set has no TTL of its own.
    if (!raw) { await store.srem(LOG, id).catch(() => {}); continue; }
    try { rows.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch { /* skip */ }
  }
  rows.sort((a, b) => (b.at || 0) - (a.at || 0));
  return { ok: true, events: rows.slice(0, limit) };
}
