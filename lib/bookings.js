// R7.8–R7.10 — bookings.
//
// The requirement states the rule in six words: A LINK CLICK IS NOT A BOOKING.
//
// It is worth being blunt about why. Click-based "bookings" are the easiest
// metric in the world to produce and the most dishonest: the owner sees a
// number, plans around it, and discovers later that nobody was ever in the
// diary. Everything here therefore has exactly one source of truth — a
// signature-verified webhook from the scheduler, or a record the owner entered
// themselves. A click is stored as what it is: evidence of interest, and
// explicitly NOT a booking.
//
// Attribution (R7.10) is captured at booking time, not reconstructed later,
// because by the time a call is attended the campaign may have changed.

import crypto from 'node:crypto';
import { store } from './store.js';

const BOOKING = (id) => `booking:${id}`;
const INDEX = 'bookings:all';
const SEEN_EVENT = (id) => `booking:event:${id}`;
const CLICKS = (contactId) => `booking:clicks:${contactId}`;

export const BOOKING_STATUS = Object.freeze({
  SCHEDULED: 'scheduled',
  CANCELLED: 'cancelled',
  RESCHEDULED: 'rescheduled',
  ATTENDED: 'attended',
  NO_SHOW: 'no-show',
});

export const SOURCE = Object.freeze({
  WEBHOOK: 'verified-webhook',
  OWNER: 'owner-recorded',
});

/**
 * A click on a booking link. Recorded, and deliberately NOT a booking.
 * Returns an object that says so, so a caller cannot mistake it for one.
 */
export async function recordBookingLinkClick(contactId, { campaignId = null, at = Date.now(), userAgent = '', deliveredAt = null, linksInMessage = 1, clickedLinks = 1 } = {}) {
  const clicks = await store.smembers(CLICKS(contactId)).catch(() => []);
  await store.sadd(CLICKS(contactId), `${at}:${campaignId || ''}`);

  // R9.3 — a scanner opening every link in a message is not a person. It is
  // classified here, where the click arrives, and counted in its own column so
  // that the most aggressively filtered recipients do not look like the most
  // interested ones.
  const { classifyClick, recordSecondaryEverywhere } = await import('./secondary.js');
  const verdict = classifyClick({ at, deliveredAt, userAgent, linksInMessage, clickedLinks });
  try {
    await recordSecondaryEverywhere({ contactId, kind: verdict.kind, at, evidence: { campaignId, reasons: verdict.reasons } });
  } catch { /* a click must never fail because of an experiment */ }

  return {
    recorded: true,
    isBooking: false,
    machine: verdict.machine,
    classification: verdict,
    note: 'A click on the booking link is interest, not an appointment. Only a verified webhook or an owner-entered record creates a booking.',
    clicksSoFar: clicks.length + 1,
  };
}

export async function clickCount(contactId) {
  return (await store.smembers(CLICKS(contactId)).catch(() => [])).length;
}

/**
 * Verify a Calendly webhook signature.
 *
 * Calendly signs with `Calendly-Webhook-Signature: t=<ts>,v1=<hmac>` over
 * `<ts>.<rawBody>` using the signing key from the subscription. Unsigned or
 * mis-signed payloads are rejected outright — an unverified webhook is just an
 * HTTP request from a stranger, and this one creates records the owner plans
 * their week around.
 */
export function verifyCalendlySignature({ header, rawBody, signingKey, now = Date.now(), toleranceSec = 300 }) {
  if (!signingKey) return { ok: false, reason: 'no webhook signing key configured, so no webhook can be trusted' };
  if (!header) return { ok: false, reason: 'request carried no signature header' };

  const parts = Object.fromEntries(
    String(header)
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((kv) => kv.length === 2)
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return { ok: false, reason: 'signature header is malformed' };

  const ageSec = Math.abs(now / 1000 - Number(t));
  if (!Number.isFinite(ageSec) || ageSec > toleranceSec) {
    return { ok: false, reason: `signature timestamp is ${Math.round(ageSec)}s away from now (tolerance ${toleranceSec}s) — replay protection`, replay: true };
  }

  const expected = crypto.createHmac('sha256', signingKey).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(v1), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature does not match' };
  }
  return { ok: true };
}

/**
 * Handle a verified scheduler webhook.
 *
 * Idempotent by event id (R11.2) and order-independent (R11.5): a cancellation
 * that arrives before the creation it refers to must not resurrect the booking.
 */
export async function handleBookingWebhook({ event, verified = false, now = Date.now() }) {
  if (!verified) {
    return { ok: false, reason: 'refusing to act on an unverified webhook', ignored: true };
  }
  const eventId = event?.id || event?.payload?.uri;
  if (!eventId) return { ok: false, reason: 'webhook carried no event id, so it cannot be de-duplicated' };

  if (await store.get(SEEN_EVENT(eventId))) {
    return { ok: true, duplicate: true, note: 'this webhook was already processed' };
  }
  await store.set(SEEN_EVENT(eventId), String(now), { ex: 60 * 60 * 24 * 90 });

  const kind = event.event || event.type;
  const p = event.payload || {};
  const bookingId = p.bookingId || p.uri || eventId;
  const existing = await getBooking(bookingId);

  // Out-of-order protection: ignore anything older than what we already have.
  const stamp = Number(p.updatedAt || p.created_at || now);
  if (existing && Number(existing.updatedAt || 0) > stamp) {
    return { ok: true, outOfOrder: true, note: 'a newer update for this booking is already recorded' };
  }

  if (kind === 'invitee.created') {
    const booking = {
      id: bookingId,
      status: BOOKING_STATUS.SCHEDULED,
      source: SOURCE.WEBHOOK,
      verified: true,
      startAt: p.startAt || p.start_time || null,
      inviteeEmail: (p.email || '').toLowerCase() || null,
      // R7.10 — attribution captured NOW, not reconstructed later
      attribution: {
        contactId: p.contactId || existing?.attribution?.contactId || null,
        campaignId: p.campaignId || existing?.attribution?.campaignId || null,
        messageVariant: p.variant || existing?.attribution?.messageVariant || null,
        source: p.source || 'scheduler',
        capturedAt: now,
      },
      history: [...(existing?.history || []), { at: now, kind, status: BOOKING_STATUS.SCHEDULED }],
      updatedAt: stamp,
    };
    await putBooking(booking);
    // R9.1 — a confirmed booking is the outcome that actually matters, so it
    // is recorded against the arm at the moment it is verified.
    try {
      const { listExperiments, recordOutcome: recordExperimentOutcome } = await import('./experiments.js');
      for (const exp of await listExperiments()) {
        if (exp.state !== 'running') continue;
        await recordExperimentOutcome({
          experimentId: exp.id,
          contactId: booking.attribution?.contactId || null,
          kind: 'booking:scheduled',
          evidence: { bookingId: booking.id },
        });
        // R9.2 rung 2 — a booking confirmed by a signature-verified webhook.
        // A link click never reaches here.
        const { recordPrimaryOutcome, PRIMARY } = await import('./outcomes.js');
        await recordPrimaryOutcome({
          experimentId: exp.id,
          contactId: booking.attribution?.contactId || null,
          outcome: PRIMARY.QUALIFIED_BOOKING,
          source: 'verified-webhook',
          evidence: { bookingId: booking.id },
        });
      }
    } catch { /* an experiment must never break a booking */ }
    return { ok: true, booking, created: true };
  }

  if (kind === 'invitee.canceled' || kind === 'invitee.cancelled') {
    // A cancellation for a booking we never saw still has to be recorded, or an
    // out-of-order creation would later resurrect it as scheduled.
    const booking = {
      ...(existing || { id: bookingId, source: SOURCE.WEBHOOK, verified: true, attribution: { capturedAt: now } }),
      status: BOOKING_STATUS.CANCELLED,
      cancelledAt: now,
      // R7.9 — attribution survives a cancellation
      attribution: existing?.attribution || { contactId: p.contactId || null, campaignId: p.campaignId || null, capturedAt: now },
      history: [...(existing?.history || []), { at: now, kind, status: BOOKING_STATUS.CANCELLED }],
      updatedAt: stamp,
    };
    await putBooking(booking);
    try {
      const { record: funnel, FUNNEL } = await import('./funnel.js');
      await funnel(FUNNEL.CANCELLED, { contactId: booking.attribution?.contactId || null, at: now, bookingId: booking.id });
    } catch { /* the booking record above is the authoritative one */ }
    return { ok: true, booking, cancelled: true };
  }

  return { ok: true, ignoredKind: kind, note: 'event type not handled' };
}

/** A reschedule is a cancellation plus a creation that keeps the attribution. */
export async function rescheduleBooking(oldId, { newId, startAt, now = Date.now() }) {
  const old = await getBooking(oldId);
  if (!old) return { ok: false, reason: 'unknown booking' };
  const moved = {
    ...old,
    id: newId || old.id,
    status: BOOKING_STATUS.SCHEDULED,
    startAt: startAt || old.startAt,
    rescheduledFrom: oldId,
    attribution: old.attribution, // R7.9 — carried, never recomputed
    history: [...(old.history || []), { at: now, kind: 'rescheduled', from: oldId, status: BOOKING_STATUS.RESCHEDULED }],
    updatedAt: now,
  };
  if (newId && newId !== oldId) {
    await putBooking({ ...old, status: BOOKING_STATUS.RESCHEDULED, movedTo: newId, updatedAt: now });
  }
  await putBooking(moved);
  return { ok: true, booking: moved };
}

/** The owner saying what actually happened. Only they can mark attendance. */
export async function recordOutcome(bookingId, outcome, { by = 'owner', now = Date.now() } = {}) {
  if (![BOOKING_STATUS.ATTENDED, BOOKING_STATUS.NO_SHOW].includes(outcome)) {
    return { ok: false, reason: `"${outcome}" is not an outcome a person can record` };
  }
  const b = await getBooking(bookingId);
  if (!b) return { ok: false, reason: 'unknown booking' };
  b.status = outcome;
  b.outcomeBy = by;
  // R9.2 rung 3 — someone turning up is a different fact from someone booking,
  // and only a person can assert it. A booking in the past is not attendance.
  if (outcome === BOOKING_STATUS.ATTENDED) {
    try {
      const { listExperiments } = await import('./experiments.js');
      const { recordPrimaryOutcome, PRIMARY } = await import('./outcomes.js');
      for (const exp of await listExperiments()) {
        if (exp.state !== 'running') continue;
        await recordPrimaryOutcome({
          experimentId: exp.id,
          contactId: b.attribution?.contactId || null,
          outcome: PRIMARY.ATTENDED_CALL,
          source: 'owner',
          evidence: { bookingId: b.id, by },
        });
      }
    } catch { /* an experiment must never break recording an outcome */ }
  }
  b.history = [...(b.history || []), { at: now, kind: 'outcome', status: outcome, by }];
  b.updatedAt = now;
  await putBooking(b);

  // R19.7 — attended and no-show are the two ends of the funnel and are
  // recorded only here, by a person. `observedBy` is the evidence `funnel`
  // requires for ATTENDED, and `by` is the person asserting it.
  try {
    const { record: funnel, FUNNEL } = await import('./funnel.js');
    await funnel(outcome === BOOKING_STATUS.ATTENDED ? FUNNEL.ATTENDED : FUNNEL.NO_SHOW, {
      contactId: b.attribution?.contactId || null, at: now, observedBy: by, bookingId: b.id,
    });
  } catch { /* the booking record above is the authoritative one */ }

  return { ok: true, booking: b };
}

/** A booking the owner entered by hand — honest about where it came from. */
export async function recordManualBooking({ contactId, campaignId = null, startAt, by = 'owner', now = Date.now() }) {
  const id = `manual-${contactId}-${now}`;
  const booking = {
    id,
    status: BOOKING_STATUS.SCHEDULED,
    source: SOURCE.OWNER,
    verified: true,
    enteredBy: by,
    startAt: startAt || null,
    attribution: { contactId, campaignId, source: 'owner-recorded', capturedAt: now },
    history: [{ at: now, kind: 'manual', status: BOOKING_STATUS.SCHEDULED, by }],
    updatedAt: now,
  };
  await putBooking(booking);
  return { ok: true, booking };
}

async function putBooking(b) {
  await store.set(BOOKING(b.id), JSON.stringify(b));
  await store.sadd(INDEX, b.id);
  return b;
}

export async function getBooking(id) {
  const raw = await store.get(BOOKING(id)).catch(() => null);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

export async function listBookings({ limit = 200 } = {}) {
  const ids = await store.smembers(INDEX).catch(() => []);
  const out = [];
  for (const id of ids.slice(0, limit)) {
    const b = await getBooking(id);
    if (b) out.push(b);
  }
  return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

/**
 * The counts that may be reported (R10.1).
 * Clicks are reported SEPARATELY and never summed into bookings.
 */
export async function bookingStats() {
  const all = await listBookings({ limit: 1000 });
  const by = (s) => all.filter((b) => b.status === s).length;
  return {
    verifiedBookings: all.filter((b) => b.verified).length,
    scheduled: by(BOOKING_STATUS.SCHEDULED),
    cancelled: by(BOOKING_STATUS.CANCELLED),
    attended: by(BOOKING_STATUS.ATTENDED),
    noShow: by(BOOKING_STATUS.NO_SHOW),
    // stated explicitly so a reader cannot assume clicks are in the total
    note: 'Bookings come only from a verified webhook or an owner-entered record. Link clicks are counted separately and are not bookings.',
  };
}
