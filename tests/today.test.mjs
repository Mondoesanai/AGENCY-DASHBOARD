// The landing screen.
//
// The check that matters most is the booking one. Four situations look
// identical on a quiet day and mean completely different things, and
// collapsing them into "no bookings" is how a broken integration looks like a
// slow week for a month.
import { check, section, done } from './world.mjs';
import { renderBookings, renderWork, renderHealth, wireToday, bookingState, BOOKING_STATE } from '../public/today.js';

// ---------------------------------------------------------------------------
section('T1  the four booking situations are four different answers');
check('nothing yet is loading', bookingState(null) === BOOKING_STATE.LOADING);
check('an error is failed', bookingState({ error: 'boom' }) === BOOKING_STATE.FAILED);
check('no scheduler is disconnected', bookingState({ connected: false, bookings: [] }) === BOOKING_STATE.DISCONNECTED);
check('connected and empty is none', bookingState({ connected: true, bookings: [] }) === BOOKING_STATE.NONE);
check('connected with rows is some', bookingState({ connected: true, bookings: [{ id: 'b1' }] }) === BOOKING_STATE.SOME);
check('all five are distinct', new Set(Object.values(BOOKING_STATE)).size === 5);

let html = renderBookings({ connected: false, bookings: [] });
check('disconnected says a booking COULD NOT arrive', /could not arrive/i.test(html), html.slice(0, 120));
check('and that nothing is wrong with the calendar', /Nothing is wrong with the calendar/i.test(html));
check('and offers the one thing to do', /Connect it in Settings/.test(html));
check('it does NOT say there are no bookings', !/No bookings yet/.test(html));

html = renderBookings({ connected: true, bookings: [] });
check('a real empty says no bookings yet', /No bookings yet/.test(html));
check('and distinguishes itself from a failed check', /not a failed check/i.test(html));
check('without implying a fault', !/could not/i.test(html));

html = renderBookings({ error: 'the request timed out' });
check('a failed check says so', /Could not check for bookings/i.test(html));
check('names the reason', /timed out/.test(html));
check('warns that somebody may have booked', /may have booked/i.test(html));
check('and offers a retry', /data-retry="bookings"/.test(html));

html = renderBookings(null);
check('loading is its own state', !/No bookings|could not/i.test(html), html.slice(0, 100));

// ---------------------------------------------------------------------------
section('T2  a hand-entered booking is not presented as confirmed');
html = renderBookings({ connected: true, bookings: [
  { id: 'b1', startAt: Date.now() + 86400e3, contactName: 'Jordan Hale', verified: true },
  { id: 'b2', startAt: Date.now() + 172800e3, contactName: 'Priya Raman', verified: false },
] });
check('both appear', /Jordan Hale/.test(html) && /Priya Raman/.test(html));
check('a verified one says the scheduler confirmed it', /confirmed by the scheduler/.test(html));
check('a manual one says it was NOT', /not confirmed by the scheduler/.test(html));
check('and is visually marked', /tone-warn/.test(html));
check('times are in words', /tomorrow|today|\w{3} \w{3}/.test(html), html.slice(0, 200));
check('a hostile name is escaped', !/<img/.test(renderBookings({ connected: true, bookings: [{ id: 'x', startAt: Date.now() + 1e6, contactName: '<img src=x onerror=alert(1)>' }] })));

// ---------------------------------------------------------------------------
section('T3  work in flight is a summary, not a table');
check('nothing in flight says so plainly', /Nothing in flight/.test(renderWork({})));
html = renderWork({ followUpsDue: 2, previewsOwed: 1, queued: 3 });
check('it counts what is outstanding', /2 follow-ups due/.test(html) && /1 preview to build/.test(html), html.slice(0, 160));
check('and offers a way through to it', /data-go="followups"/.test(html));
check('a failed read is an error, not "nothing"', /Could not read/.test(renderWork({ error: 'storage down' })));
check('loading is distinct from empty', !/Nothing in flight/.test(renderWork(null)));

// ---------------------------------------------------------------------------
section('T4  automation health is one line, about SUCCESS not starting');
html = renderHealth({ workers: [
  { id: 'tick', label: 'Site improvements', status: 'ok', hasOutcomeTelemetry: true, lastSuccessAt: Date.now() - 6e5 },
], pause: { paused: false } });
check('all good says everything is running', /Everything is running/.test(html));
check('and names the most recent COMPLETED work', /Most recent completed work/.test(html));

html = renderHealth({ workers: [
  { id: 'tick', label: 'Site improvements', status: 'ok', hasOutcomeTelemetry: true, lastSuccessAt: null },
], pause: { paused: false } });
check('running but never succeeding is called out', /not completed successfully/i.test(html), html.slice(0, 140));
check('saying starting is not finishing', /Starting is not the same as finishing/.test(html));

html = renderHealth({ workers: [{ id: 'daily', label: 'Daily pass', status: 'never' }], pause: { paused: false } });
check('a worker that is not running is the headline', /Daily pass.*not running/is.test(html), html.slice(0, 120));

html = renderHealth({ workers: [], pause: { paused: true } });
check('paused says so, and that nothing is lost', /paused/i.test(html) && /not lost/.test(html));
check('and that replies still work', /Replies and opt-outs still work/.test(html));

check('a failed read is not an all-clear', /not an all-clear/.test(renderHealth({ error: 'unreadable' })));
check('and loading is not "everything is running"', !/Everything is running/.test(renderHealth(null)));

// ---------------------------------------------------------------------------
section('T5  every button goes somewhere');
const listeners = [];
const root = { addEventListener: (ev, fn) => listeners.push([ev, fn]) };
check('it wires', wireToday(root, {}) === true);
check('wiring nothing is survivable', wireToday(null, {}) === false);

listeners.length = 0;
const went = [];
wireToday(root, { go: (v) => went.push(v), retry: () => went.push('retry') });
listeners[0][1]({ target: { closest: (s) => (s === '[data-go]' ? { getAttribute: () => 'followups' } : null) } });
check('a "go there" button navigates', went[0] === 'followups', JSON.stringify(went));
listeners[0][1]({ target: { closest: (s) => (s === '[data-retry="bookings"]' ? {} : null) } });
check('and retry retries', went[1] === 'retry', JSON.stringify(went));
listeners[0][1]({ target: { closest: () => null } });
check('a click on nothing is survivable', went.length === 2);

done();
