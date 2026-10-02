// R2.8 — the five primary actions, and the bookings screen they point at.
//
// The interesting part is not that five buttons render. It is that a number on
// a button is a measurement or it is absent: if the replies did not load, the
// button must say nothing rather than "0", because "0 waiting" reads as
// "nobody has answered", which is a different and possibly false fact.
import { check, section, done } from './world.mjs';
import { PRIMARY_ACTIONS, buildActions, renderActions, wireActions, actionById } from '../public/actions.js';
import { renderBookings, TABS, renderBody, BOOKING_STATUS_LABEL } from '../public/acquisition.js';
import { needsPerson } from '../public/attention.js';
import { BOOKING_STATUS, SOURCE } from '../lib/bookings.js';

// ---------------------------------------------------------------------------
section('P1  the five the requirement names, and nothing invented');
const ids = PRIMARY_ACTIONS.map((a) => a.id);
check('all five are present', ids.length === 5, ids.join(','));
for (const id of ['scan-cards', 'import-contacts', 'create-campaign', 'review-replies', 'view-bookings'])
  check(`"${id}" is one of them`, ids.includes(id), ids.join(','));
check('each one says what it does', PRIMARY_ACTIONS.every((a) => a.hint && a.hint.length > 20));
check('each one has somewhere to go', PRIMARY_ACTIONS.every((a) => a.go && a.go.view && a.go.tab));
// every destination must be a tab that exists, or the button is a dead end
const tabIds = TABS.map((t) => t.id);
check('every destination tab exists', PRIMARY_ACTIONS.every((a) => tabIds.includes(a.go.tab)), `${tabIds.join(',')}`);
check('and every destination renders something', PRIMARY_ACTIONS.every((a) => {
  const h = renderBody(a.go.tab, { loading: false });
  return typeof h === 'string' && h.length > 20 && !/Unknown tab/.test(h);
}), PRIMARY_ACTIONS.map((a) => a.go.tab).join(','));

// ---------------------------------------------------------------------------
section('P2  a count is a measurement or it is absent');
// the one that matters: replies not loaded
let acts = buildActions({});
let replies = actionById(acts, 'review-replies');
check('with nothing loaded the reply button carries no number', replies.count === null && replies.countLabel === '', JSON.stringify(replies));
let html = renderActions(acts);
check('and renders no count at all', !/act-n/.test(html), html.slice(0, 300));
check('it does NOT say zero', !/0 waiting/.test(html));

acts = buildActions({ replies: [], bookings: [] });
replies = actionById(acts, 'review-replies');
check('a real empty list may say none', replies.count === 0 && replies.countLabel === 'none waiting', JSON.stringify(replies));
check('and that is different from the absent case', replies.countLabel !== '');

acts = buildActions({
  replies: [{ kind: 'interested', handled: false }, { kind: 'interested', handled: true }, { kind: 'opt-out', handled: false }],
  needsPerson,
});
replies = actionById(acts, 'review-replies');
check('only the ones still waiting on a person are counted', replies.count === 1, JSON.stringify(replies));
check('and it says so in words', replies.countLabel === '1 waiting', replies.countLabel);

acts = buildActions({ bookings: [{ id: 'b1' }, { id: 'b2' }] });
check('bookings are counted when loaded', actionById(acts, 'view-bookings').count === 2);
acts = buildActions({});
check('and left blank when not', actionById(acts, 'view-bookings').count === null);

acts = buildActions({ contacts: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] });
check('the intake actions show how many exist so far', actionById(acts, 'scan-cards').countLabel === '3 so far');
check('and say nothing when there are none rather than "0 so far"', actionById(buildActions({ contacts: [] }), 'scan-cards').countLabel === '');

// ---------------------------------------------------------------------------
section('P3  an action that cannot fully work still appears, and says why');
acts = buildActions({ readiness: { ready: false, blockers: [{ text: 'no account' }] } });
let camp = actionById(acts, 'create-campaign');
check('create campaign stays available', camp.available === true);
check('because composing is safe', /build and preview/.test(camp.note), camp.note);
check('and it says sending is off', /sending is still switched off/.test(camp.note));
acts = buildActions({});
camp = actionById(acts, 'create-campaign');
check('with readiness unknown it says unknown, not ready', /not known right now/.test(camp.note), camp.note);
acts = buildActions({ readiness: { ready: true, blockers: [] } });
check('when sending really is live it adds no caveat', actionById(acts, 'create-campaign').note === '');

// ---------------------------------------------------------------------------
section('P4  the buttons go somewhere');
const spy = () => { const c = []; const f = (...a) => c.push(a); f.calls = c; return f; };
function fakeRoot() {
  const ls = [];
  return { ls, addEventListener: (t, fn) => ls.push([t, fn]),
    click(target) { ls.forEach(([, fn]) => fn({ target })); } };
}
acts = buildActions({});
const root = fakeRoot();
const go = spy();
check('wiring reports success', wireActions(root, acts, { go }) === true);
check('one delegated listener', root.ls.length === 1);
root.click({ closest: (s) => (s === '[data-act]' ? { dataset: { act: 'view-bookings' } } : null) });
check('clicking an action hands over its destination', go.calls[0]?.[0]?.tab === 'bookings', JSON.stringify(go.calls));
check('and the action itself', go.calls[0]?.[1]?.id === 'view-bookings');
root.click({ closest: () => null });
check('a click elsewhere does nothing', go.calls.length === 1);
root.click({ closest: (s) => (s === '[data-act]' ? { dataset: { act: 'invented' } } : null) });
check('an unknown action id does nothing rather than throwing', go.calls.length === 1);

html = renderActions(acts, { loading: true });
check('loading is its own state', /Loading what you can do/.test(html));
check('and shows no buttons it cannot describe yet', !/data-act/.test(html));

// ---------------------------------------------------------------------------
section('P5  the bookings screen: a click is not a booking');
// lib/bookings.js has been tested since it was written and had NO screen.
html = renderBookings({ bookings: [], bookingStats: { verifiedBookings: 0, scheduled: 0, cancelled: 0, attended: 0, noShow: 0, note: 'Link clicks are counted separately and are not bookings.' } });
check('an empty list explains what creates a booking', /scheduler confirms it by webhook/.test(html), html.slice(0, 220));
check('and states that a click is not one', /click on a booking link does/.test(html) && /<b>not<\/b> create one/.test(html));
check('the note from the library is carried through', /counted separately/.test(html));

const B = (over = {}) => ({ id: 'bk1', status: BOOKING_STATUS.SCHEDULED, source: SOURCE.WEBHOOK, verified: true,
  startAt: new Date('2026-10-22T15:00:00Z').toISOString(), inviteeEmail: 'dana@fox.test',
  attribution: { campaignId: 'k1' }, updatedAt: 1, ...over });

html = renderBookings({ bookings: [B()], bookingStats: { verifiedBookings: 1, scheduled: 1, cancelled: 0, attended: 0, noShow: 0, note: 'n' } });
check('a real booking is listed', /dana@fox\.test/.test(html));
check('its status is in plain words', /booked/.test(html) && !/>scheduled</.test(html));
check('how we know it is shown', /confirmed by the scheduler/.test(html));
check('and the campaign it came from', /k1/.test(html));

html = renderBookings({ bookings: [B({ verified: false, source: SOURCE.OWNER })], bookingStats: null });
check('an unverified record is marked as such', /not verified/.test(html));
check('with no stats it refuses to imply zero', /not a report of zero bookings/.test(html), html.slice(0, 200));

html = renderBookings({ bookings: [B({ attribution: {} })], bookingStats: null });
check('a booking with no campaign says "not attributed"', /not attributed/.test(html));
check('rather than guessing the likeliest one', /shown as unknown rather than assigned/.test(html));

html = renderBookings({ bookings: [B({ startAt: null })], bookingStats: null });
check('a missing time says so instead of inventing one', /time not given/.test(html));

html = renderBookings({ load: { bookings: { error: 'the store refused' } }, bookings: [] });
check('a failed load is not an empty list', /Could not load bookings/.test(html), html.slice(0, 160));
check('and does not claim there are none', !/No bookings yet/.test(html));

html = renderBookings({ bookings: [B({ inviteeEmail: '<img src=x onerror=alert(1)>' })], bookingStats: null });
check('hostile text is escaped', !/<img src=x/.test(html) && /&lt;img/.test(html));

check('every status has a human label', Object.values(BOOKING_STATUS_LABEL).every((l) => l.length > 3));
check('and every library status has one', Object.values(BOOKING_STATUS).every((s) => !!BOOKING_STATUS_LABEL[s]),
  Object.values(BOOKING_STATUS).filter((s) => !BOOKING_STATUS_LABEL[s]).join(','));

done();
