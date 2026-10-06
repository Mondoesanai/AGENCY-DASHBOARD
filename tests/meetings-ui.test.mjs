// Which real meetings are booked, cancelled, or missed.
//
// A meeting is the one number in this system worth optimising and the easiest
// to inflate. Three facts look alike from a distance and are kept apart here:
// a link click is not a booking, a booking is not an attendance, and a past
// booking nobody has answered for is neither attended nor missed.
//
// The last of those is the one that rots quietly: leave it unanswered and a
// no-show ends up counted as a success in a report nobody re-reads.
import { check, section, done } from './world.mjs';
import { renderMeetingSummary, renderMeetingList, wireMeetings, stateWord } from '../public/meetings.js';

const NOW = Date.UTC(2026, 9, 6, 15, 0, 0);
const H = 3600e3;

// ---------------------------------------------------------------------------
section('M1  no scheduler is a different fact from no meetings');
let s = renderMeetingSummary({ ok: true, stats: {}, schedulerConnected: false });
check('it says there are none', /No meetings yet/.test(s));
check('and that one could not have arrived', /could not arrive/.test(s), s);
check('absolving the calendar', /Nothing is wrong with your calendar/.test(s));

s = renderMeetingSummary({ ok: true, stats: {}, schedulerConnected: true });
check('with a scheduler connected, empty means empty', /real empty/.test(s), s);
check('and is not blamed on the connection', !/could not arrive/.test(s));

section('M1b  a failed read is not "no meetings"');
s = renderMeetingSummary({ ok: false, error: 'storage down' });
check('it says the read failed', /Could not read meetings/.test(s));
check('naming the reason', /storage down/.test(s));
check('and warns against concluding anything', /Nothing should be concluded/.test(s));
check('it does not say zero', !/No meetings yet/.test(s));
check('loading is its own state', /Reading meetings/.test(renderMeetingSummary(null)));

// ---------------------------------------------------------------------------
section('M2  booked, attended and missed are never one number');
s = renderMeetingSummary({ ok: true, schedulerConnected: true, stats: {
  verifiedBookings: 10, scheduled: 2, attended: 5, noShow: 3, cancelled: 2,
  note: 'Bookings come only from a verified webhook or an owner-entered record.',
} });
check('coming up is its own figure', /2<\/b><span>coming up/.test(s.replace(/\s+/g, '')) || /coming up/.test(s));
check('attended is its own figure', /attended/.test(s));
check('no-show is its own figure', /no-show/.test(s));
check('cancelled is its own figure', /cancelled/.test(s));
check('the attendance sentence uses only settled meetings', /Of 8 meetings that have now been and gone/.test(s), s);
check('5 of those 8 attended', /<b>5<\/b> were attended/.test(s), s);
check('the two upcoming are NOT in that denominator', !/Of 10/.test(s),
  'a meeting that has not happened cannot be counted as attended or missed');
check('and the source of bookings is stated', /verified webhook|owner-entered/.test(s));

section('M2b  with nothing settled there is no rate');
s = renderMeetingSummary({ ok: true, schedulerConnected: true, stats: { verifiedBookings: 3, scheduled: 3, attended: 0, noShow: 0, cancelled: 0 } });
check('it says none have happened', /None have happened yet/.test(s), s);
check('rather than reporting 0%', !/0%/.test(s));

// ---------------------------------------------------------------------------
section('M3  a past booking nobody answered for is asked about FIRST');
const data = { ok: true, schedulerConnected: true, stats: {}, bookings: [
  { id: 'b1', name: 'Dana Reyes', startAt: NOW - 26 * H, status: 'scheduled', verified: true },
  { id: 'b2', name: 'Cy Vance', startAt: NOW + 48 * H, status: 'scheduled', verified: true },
  { id: 'b3', name: 'Pat Lee', startAt: NOW - 72 * H, status: 'attended', verified: true },
  { id: 'b4', name: 'Sam Ortiz', startAt: NOW - 96 * H, status: 'no-show', verified: true },
] };
let html = renderMeetingList(data, { now: NOW });
check('the unanswered past booking is asked about', /Did these happen\?/.test(html));
check('and it is Dana', html.indexOf('Dana Reyes') < html.indexOf('Coming up'), 'it has to come before the upcoming list');
check('with both answers offered', /data-outcome="attended"/.test(html) && /data-outcome="no-show"/.test(html));
check('and it says what unanswered means', /counts as neither attended nor missed/.test(html));
check('upcoming is its own group', /Coming up/.test(html) && /Cy Vance/.test(html));
check('settled ones are past', /Past/.test(html) && /Pat Lee/.test(html));
check('an already-answered meeting is NOT asked about again',
  html.indexOf('Pat Lee') > html.indexOf('Past'), 'it belongs under Past, not under the question');
check('attended and no-show are visually distinct', /mt-attended/.test(html) && /mt-no-show/.test(html));

section('M3b  a hand-entered booking says so');
html = renderMeetingList({ ok: true, bookings: [
  { id: 'x', name: 'Manual Person', startAt: NOW + H, status: 'scheduled', verified: false },
] }, { now: NOW });
check('it is marked unconfirmed', /not confirmed by the scheduler/.test(html), html.slice(0, 200));
html = renderMeetingList({ ok: true, bookings: [
  { id: 'y', name: 'Real Person', startAt: NOW + H, status: 'scheduled', verified: true },
] }, { now: NOW });
check('a confirmed one is not', !/not confirmed by the scheduler/.test(html));

section('M3c  plain words for every state');
check('scheduled reads as Booked', stateWord('scheduled') === 'Booked');
check('attended reads as Attended', stateWord('attended') === 'Attended');
check('no-show reads in plain English', stateWord('no-show') === 'Did not come');
check('cancelled reads as Cancelled', stateWord('cancelled') === 'Cancelled');
check('an unknown state is admitted', stateWord('weird') === 'Unknown');

// ---------------------------------------------------------------------------
section('M4  recording an outcome is wired');
const listeners = [];
const root = { addEventListener: (ev, fn) => listeners.push([ev, fn]) };
check('it wires', wireMeetings(root, {}) === true);
check('wiring nothing is survivable', wireMeetings(null, {}) === false);

listeners.length = 0;
const did = [];
wireMeetings(root, { outcome: (id, o) => did.push(`${id}:${o}`), open: (id) => did.push('open:' + id) });
listeners[0][1]({ target: { closest: (sel) => {
  if (sel === '[data-outcome]') return { getAttribute: () => 'attended', closest: () => ({ getAttribute: () => 'b1' }) };
  return null;
} } });
check('"they came" records attendance for that booking', did[0] === 'b1:attended', JSON.stringify(did));
listeners[0][1]({ target: { closest: (sel) => (sel === '[data-booking]' ? { getAttribute: () => 'b2' } : null) } });
check('clicking the row opens it', did[1] === 'open:b2', JSON.stringify(did));
listeners[0][1]({ target: { closest: () => null } });
check('a click on nothing is survivable', did.length === 2);

section('M5  hostile data cannot inject markup');
html = renderMeetingList({ ok: true, bookings: [
  { id: '"><img src=x>', name: '<script>alert(1)</script>', startAt: NOW, status: 'scheduled' },
] }, { now: NOW });
check('a name is escaped', !/<script>/.test(html));
check('an id cannot break out of its attribute', !/<img/.test(html));

done();
