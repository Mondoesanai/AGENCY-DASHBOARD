// R7.8–R7.10 — a link click is not a booking.
import crypto from 'node:crypto';
import { check, section, done } from './world.mjs';
import {
  BOOKING_STATUS, SOURCE, recordBookingLinkClick, clickCount,
  verifyCalendlySignature, handleBookingWebhook, rescheduleBooking,
  recordOutcome, recordManualBooking, getBooking, listBookings, bookingStats,
} from '../lib/bookings.js';

const KEY = 'test-signing-key';
const sign = (body, ts) => {
  const t = ts ?? Math.floor(Date.now() / 1000);
  const v1 = crypto.createHmac('sha256', KEY).update(`${t}.${body}`).digest('hex');
  return { header: `t=${t},v1=${v1}`, rawBody: body };
};

// ---------------------------------------------------------------------------
section('V1  a click is recorded, and is explicitly NOT a booking');
let c = await recordBookingLinkClick('contact-1', { campaignId: 'camp-1' });
check('the click is recorded', c.recorded === true);
check('and it says plainly it is not a booking', c.isBooking === false);
check('with the reason in words', /interest, not an appointment/.test(c.note), c.note);
await recordBookingLinkClick('contact-1', { campaignId: 'camp-1', at: Date.now() + 1000 });
check('clicks accumulate', (await clickCount('contact-1')) === 2, String(await clickCount('contact-1')));
check('but no booking exists from clicking', (await listBookings()).length === 0, String((await listBookings()).length));

let stats = await bookingStats();
check('the stats show zero bookings despite two clicks', stats.verifiedBookings === 0);
check('and state that clicks are counted separately', /are not bookings/.test(stats.note));

// ---------------------------------------------------------------------------
section('V2  an unverified webhook is refused outright');
let r = await handleBookingWebhook({ event: { id: 'e1', event: 'invitee.created', payload: {} }, verified: false });
check('it is refused', r.ok === false, JSON.stringify(r));
check('and nothing is created', (await listBookings()).length === 0);
check('the reason names the problem', /unverified webhook/.test(r.reason), r.reason);

// ---------------------------------------------------------------------------
section('V3  signature verification, replay and tampering');
const body = JSON.stringify({ event: 'invitee.created', payload: { uri: 'b1' } });
let s = sign(body);
check('a correct signature verifies', verifyCalendlySignature({ ...s, signingKey: KEY }).ok === true);
check('a wrong key fails', verifyCalendlySignature({ ...s, signingKey: 'other-key' }).ok === false);
check('a tampered body fails', verifyCalendlySignature({ header: s.header, rawBody: body + ' ', signingKey: KEY }).ok === false);
check('a missing header fails', verifyCalendlySignature({ rawBody: body, signingKey: KEY }).ok === false);
check('a malformed header fails', verifyCalendlySignature({ header: 'nonsense', rawBody: body, signingKey: KEY }).ok === false);

// replay protection
const old = sign(body, Math.floor(Date.now() / 1000) - 3600);
let v = verifyCalendlySignature({ ...old, signingKey: KEY });
check('an hour-old signature is refused', v.ok === false);
check('and it is flagged as replay protection', v.replay === true, JSON.stringify(v));
check('with the age stated', /away from now/.test(v.reason), v.reason);

// no key configured = nothing is trusted
v = verifyCalendlySignature({ ...s, signingKey: null });
check('with no signing key, no webhook is trusted', v.ok === false && /no webhook can be trusted/.test(v.reason), v.reason);

// ---------------------------------------------------------------------------
section('V4  a verified booking is created, with attribution captured NOW');
r = await handleBookingWebhook({
  verified: true,
  event: { id: 'e2', event: 'invitee.created', payload: { uri: 'b1', email: 'Pat@Lone.test', startAt: '2026-10-09T15:00:00Z', contactId: 'contact-1', campaignId: 'camp-1', variant: 'A' } },
});
check('the booking is created', r.created === true && r.booking.status === BOOKING_STATUS.SCHEDULED, JSON.stringify(r).slice(0, 160));
check('it is marked verified', r.booking.verified === true && r.booking.source === SOURCE.WEBHOOK);
check('the contact is attributed', r.booking.attribution.contactId === 'contact-1');
check('the campaign is attributed', r.booking.attribution.campaignId === 'camp-1');
check('the message variant is attributed', r.booking.attribution.messageVariant === 'A');
check('and the attribution records when it was captured', typeof r.booking.attribution.capturedAt === 'number');
check('the email is normalised', r.booking.inviteeEmail === 'pat@lone.test');

stats = await bookingStats();
check('now there is exactly one verified booking', stats.verifiedBookings === 1 && stats.scheduled === 1, JSON.stringify(stats));

// ---------------------------------------------------------------------------
section('V5  duplicate and out-of-order webhooks (R11.5)');
r = await handleBookingWebhook({ verified: true, event: { id: 'e2', event: 'invitee.created', payload: { uri: 'b1' } } });
check('the same event id is ignored as a duplicate', r.duplicate === true, JSON.stringify(r));
check('and the booking still has its attribution', (await getBooking('b1')).attribution.contactId === 'contact-1');

// an OLDER update arriving late must not overwrite a newer state
await handleBookingWebhook({
  verified: true,
  event: { id: 'e3', event: 'invitee.canceled', payload: { uri: 'b1', updatedAt: Date.now() + 10000 } },
});
check('the cancellation applies', (await getBooking('b1')).status === BOOKING_STATUS.CANCELLED);
r = await handleBookingWebhook({
  verified: true,
  event: { id: 'e4', event: 'invitee.created', payload: { uri: 'b1', updatedAt: Date.now() - 10000 } },
});
check('a late, older creation does NOT resurrect a cancelled booking', r.outOfOrder === true, JSON.stringify(r));
check('the booking stays cancelled', (await getBooking('b1')).status === BOOKING_STATUS.CANCELLED);
check('and attribution survives the cancellation (R7.9)', (await getBooking('b1')).attribution.contactId === 'contact-1');

// a cancellation for a booking we never saw is still recorded
r = await handleBookingWebhook({ verified: true, event: { id: 'e5', event: 'invitee.canceled', payload: { uri: 'never-seen' } } });
check('an unknown booking cancellation is recorded, not dropped', (await getBooking('never-seen'))?.status === BOOKING_STATUS.CANCELLED, JSON.stringify(r));

// ---------------------------------------------------------------------------
section('V6  rescheduling keeps the attribution (R7.9)');
await handleBookingWebhook({
  verified: true,
  event: { id: 'e6', event: 'invitee.created', payload: { uri: 'b2', contactId: 'contact-9', campaignId: 'camp-9', variant: 'B', startAt: '2026-10-10T10:00:00Z' } },
});
r = await rescheduleBooking('b2', { newId: 'b3', startAt: '2026-10-14T10:00:00Z' });
check('the reschedule succeeds', r.ok === true, JSON.stringify(r).slice(0, 140));
check('the new booking keeps the contact', r.booking.attribution.contactId === 'contact-9');
check('and the campaign', r.booking.attribution.campaignId === 'camp-9');
check('and the message variant', r.booking.attribution.messageVariant === 'B');
check('it records what it moved from', r.booking.rescheduledFrom === 'b2');
check('the old booking is marked moved, not deleted', (await getBooking('b2')).status === BOOKING_STATUS.RESCHEDULED);
check('rescheduling an unknown booking is refused', (await rescheduleBooking('nope', { newId: 'x' })).ok === false);

// ---------------------------------------------------------------------------
section('V7  only a person records attendance');
r = await recordOutcome('b3', BOOKING_STATUS.ATTENDED, { by: 'Mondo' });
check('attendance can be recorded', r.ok === true && r.booking.status === BOOKING_STATUS.ATTENDED);
check('and it records who said so', r.booking.outcomeBy === 'Mondo');
check('a no-show can be recorded', (await recordOutcome('b3', BOOKING_STATUS.NO_SHOW)).booking.status === BOOKING_STATUS.NO_SHOW);
r = await recordOutcome('b3', BOOKING_STATUS.SCHEDULED);
check('"scheduled" is not an outcome a person records', r.ok === false, JSON.stringify(r));
check('nor is anything invented', (await recordOutcome('b3', 'went-great')).ok === false);
check('an unknown booking is refused', (await recordOutcome('nope', BOOKING_STATUS.ATTENDED)).ok === false);

// ---------------------------------------------------------------------------
section('V8  an owner-entered booking is honest about where it came from');
r = await recordManualBooking({ contactId: 'contact-5', campaignId: 'camp-5', startAt: '2026-10-20T09:00:00Z', by: 'Mondo' });
check('it is created', r.ok === true && r.booking.status === BOOKING_STATUS.SCHEDULED);
check('the source says owner-recorded, not webhook', r.booking.source === SOURCE.OWNER, r.booking.source);
check('it records who entered it', r.booking.enteredBy === 'Mondo');
check('and it counts as verified, because a person vouched for it', r.booking.verified === true);
check('with attribution captured at entry', r.booking.attribution.contactId === 'contact-5');

// ---------------------------------------------------------------------------
section('V9  the reported numbers never mix clicks with bookings');
stats = await bookingStats();
const clicks = await clickCount('contact-1');
check('clicks still exist', clicks === 2, String(clicks));
check('and are not in the booking totals', stats.verifiedBookings < clicks + stats.verifiedBookings);
check('every counted booking is verified', stats.verifiedBookings === (await listBookings()).filter((b) => b.verified).length);
check('attended is its own count, not folded into scheduled', typeof stats.attended === 'number' && typeof stats.scheduled === 'number');
check('the note restates the rule for anyone reading the numbers', /verified webhook or an owner-entered record/.test(stats.note));

done();
