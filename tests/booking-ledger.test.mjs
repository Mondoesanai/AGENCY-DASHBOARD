// A confirmed booking has to become a MEETING, not just a counter.
//
// R21.1. The preview-request form booked a real Google event, created the
// contact, the preview task and a funnel event — and never touched the booking
// ledger. Everything that reads bookings could not see it: the Meetings screen,
// the monthly client report, `bookingStats`, and the attendance / no-show
// outcomes. A call could happen and there was no record to mark attended, so
// the meetings target could never count it.
//
// The funnel and the ledger are different records on purpose: the funnel says
// HOW MANY, the ledger is the meeting itself. Both have to be written.

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  SOURCE, BOOKING_STATUS, recordProviderBooking, getBooking,
  listBookings, bookingStats, recordOutcome,
} from '../lib/bookings.js';

// ---------------------------------------------------------------------------
section('B1  a provider-confirmed booking is its own kind of record');
check('it is not a webhook', SOURCE.PROVIDER !== SOURCE.WEBHOOK);
check('and not owner-recorded', SOURCE.PROVIDER !== SOURCE.OWNER,
  'nobody called us and nobody typed it — collapsing it into either would misstate where it came from');

const EV = `evt_test_${Date.now()}`;
const made = await recordProviderBooking({
  providerId: EV, provider: 'google', contactId: 'c_ledger_test',
  startAt: Date.UTC(2026, 10, 12, 15, 0), minutes: 30, kind: 'preview-walkthrough',
  meetingUrl: 'https://meet.google.com/test-abc-def',
  manageUrl: 'https://calendar.google.com/event?eid=test',
});
check('it is recorded', made.ok === true, JSON.stringify(made).slice(0, 160));
check('as scheduled', made.booking.status === BOOKING_STATUS.SCHEDULED);
check('and VERIFIED, because the provider returned an id', made.booking.verified === true);
check('carrying the provider id', made.booking.providerId === EV);
check('the joining link survives', /meet\.google\.com/.test(made.booking.meetingUrl));
check('and the reschedule link survives', /calendar\.google\.com/.test(made.booking.manageUrl));
check('attribution points at the form', made.booking.attribution.source === 'preview-request-form');

section('B1b  it needs the provider id, or it is not provider-confirmed');
const noId = await recordProviderBooking({ startAt: Date.now() });
check('without one it is refused', noId.ok === false, JSON.stringify(noId));
check('and says why', /event id/.test(noId.reason), noId.reason);

// ---------------------------------------------------------------------------
section('B2  the same event confirmed twice is ONE booking');
// This is the duplicate-event case: a retried submit, a replayed call, a
// reconciliation sweep re-reading the same Google event.
const again = await recordProviderBooking({
  providerId: EV, provider: 'google', contactId: 'c_ledger_test',
  startAt: Date.UTC(2026, 10, 12, 15, 0), minutes: 30,
});
check('the second call does not create a second booking', again.alreadyRecorded === true, JSON.stringify(again).slice(0, 140));
check('and returns the original', again.booking.id === made.booking.id);
const all = await listBookings({ limit: 500 });
check('exactly one booking carries that event id',
  all.filter((b) => b.providerId === EV).length === 1,
  String(all.filter((b) => b.providerId === EV).length));

// ---------------------------------------------------------------------------
section('B3  it is visible to everything that reads bookings');
const found = await getBooking(made.booking.id);
check('readable by id', !!found);
check('and listed', all.some((b) => b.id === made.booking.id));
const stats = await bookingStats();
check('counted as a verified booking', stats.verifiedBookings >= 1, JSON.stringify(stats));
check('and as scheduled', stats.scheduled >= 1, JSON.stringify(stats));

section('B3b  a call that happened can now be marked attended');
// The thing that was impossible before: with no ledger record there was no id
// to record an outcome against, so attendance could never be asserted.
const out = await recordOutcome(made.booking.id, BOOKING_STATUS.ATTENDED, { by: 'owner' });
check('attendance is recordable', out.ok === true, JSON.stringify(out).slice(0, 160));
check('and sticks', (await getBooking(made.booking.id)).status === BOOKING_STATUS.ATTENDED);

// ---------------------------------------------------------------------------
section('B4  the form writes the ledger only where the provider confirmed');
const { readFile } = await import('node:fs/promises');
const src = await readFile(new URL('../lib/preview-request.js', import.meta.url), 'utf8');
check('the ledger is written in the confirmed branch',
  /if \(res\.ok\)[\s\S]{0,1400}recordProviderBooking\(/.test(src), 'lib/preview-request.js');
check('and never on the taken path',
  !/res\.taken[\s\S]{0,400}recordProviderBooking/.test(src),
  'a slot somebody else took is not a meeting');
check('and never on the uncertain path',
  !/res\.uncertain[\s\S]{0,500}recordProviderBooking/.test(src),
  'an uncertain provider answer must not create a booking that may not exist');
check('it carries the provider id through',
  /providerId: res\.providerId/.test(src), 'lib/preview-request.js');
check('and cannot fail the submission',
  /try \{[\s\S]{0,700}recordProviderBooking[\s\S]{0,700}\} catch/.test(src),
  'the appointment is already real in the calendar; a ledger write that fails must not error the visitor');
check('the result surfaces the ledger id', /bookingLedgerId,/.test(src));

done();
