// Never invent an open slot.
//
// R19.1. A visitor who picks a time that is not really free gets a confirmation
// for a meeting that will not happen, and finds out when nobody joins. That is
// worse than showing no times at all, so every check here is about refusing
// rather than offering.
//
// The provider is faked at the `lib/google.js` boundary — the adapter's own
// logic is real throughout.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  DEFAULT_RULES, getRules, saveRules, candidateSlots, removeBusy,
  schedulingProvider, getScheduler, createDisconnectedScheduler, SCHED,
} from '../lib/scheduling.js';

const TZ = 'America/Chicago';
// Monday 2026-10-12, 14:00 UTC = 09:00 Chicago
const MON = Date.UTC(2026, 9, 12, 14, 0, 0);
const H = 3600e3;

// ---------------------------------------------------------------------------
section('S1  the provider is chosen by credentials, not by hope');
check('Google wins when its three variables are set',
  schedulingProvider({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b', GOOGLE_REFRESH_TOKEN: 'c' }) === SCHED.GOOGLE);
check('two out of three is not enough',
  schedulingProvider({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' }) === SCHED.NONE,
  'a partial credential set would fail at the first call, so it is not a provider');
check('nothing configured is disconnected', schedulingProvider({}) === SCHED.NONE);

section('S1b  disconnected offers a REQUEST, never a fake appointment');
const off = createDisconnectedScheduler('no calendar is connected');
const avail = await off.availability();
check('availability is not ok', avail.ok === false, JSON.stringify(avail));
check('and says it is not connected', avail.connected === false);
check('the empty slot list is NOT the answer on its own', avail.reason.length > 10,
  'an empty list alone reads as "fully booked"; the caller must be able to tell them apart');
const bk = await off.book({});
check('booking is refused', bk.ok === false);
check('and marked request-only', bk.requestOnly === true,
  'with no calendar the honest product is a call request, not a confirmed appointment');

// ---------------------------------------------------------------------------
section('S2  owner rules narrow availability and never widen it');
const rules = { ...DEFAULT_RULES, timezone: TZ };
let slots = candidateSlots(rules, { now: MON });

check('slots are produced', slots.length > 0, String(slots.length));
check('none is sooner than the minimum lead time',
  slots.every((s) => s.startAt - MON >= rules.minLeadHours * H),
  `earliest is ${Math.round((Math.min(...slots.map((s) => s.startAt)) - MON) / H)}h out`);
check('none is beyond the horizon',
  slots.every((s) => s.startAt - MON <= rules.horizonDays * 86400e3));
check('every slot is the configured length',
  slots.every((s) => s.endAt - s.startAt === rules.slotMinutes * 60e3));

const perDay = new Map();
for (const s of slots) {
  const d = new Date(s.startAt).toLocaleDateString('en-US', { timeZone: TZ });
  perDay.set(d, (perDay.get(d) || 0) + 1);
}
check('capacity is respected every day',
  [...perDay.values()].every((n) => n <= rules.maxPerDay),
  JSON.stringify([...perDay.entries()].slice(0, 4)));
check('weekends are not offered',
  slots.every((s) => rules.workdays.includes(new Date(new Date(s.startAt).toLocaleString('en-US', { timeZone: TZ })).getDay())),
  'the owner does not work Saturdays and the form must not say they do');

section('S2b  a call sooner than production capacity is called what it is');
const soon = slots.filter((s) => s.startAt - MON < rules.previewLeadHours * H);
const later = slots.filter((s) => s.startAt - MON >= rules.previewLeadHours * H);
check('early slots are introductory, not preview walkthroughs',
  soon.every((s) => s.kind === 'introductory'), `${soon.length} early slots`);
check('later ones are walkthroughs', later.every((s) => s.kind === 'preview-walkthrough'), `${later.length} later slots`);
check('both kinds exist with the default lead time', soon.length > 0 && later.length > 0,
  'if every slot were one kind, the distinction would be untested');

// ---------------------------------------------------------------------------
section('S3  a busy calendar removes slots, with the buffer');
const first = slots[0];
const busy = [{ start: first.startAt, end: first.endAt }];
let free = removeBusy(slots, busy, rules);
check('the colliding slot is gone', !free.some((s) => s.startAt === first.startAt), String(free.length));
check('and so is the one inside the buffer',
  !free.some((s) => Math.abs(s.startAt - first.endAt) < rules.bufferMinutes * 60e3),
  'a back-to-back call with no gap is not really available');
check('slots on other days are untouched', free.length > 0);

section('S3b  THE RULE: "unknown" must never be treated as "free"');
let threw = false;
try { removeBusy(slots, null, rules); } catch { threw = true; }
check('a null busy list is refused outright', threw,
  'an outage that returned null would otherwise offer the owner\'s entire week');
check('an EMPTY list is accepted, because it means something different',
  removeBusy(slots, [], rules).length === slots.length,
  '[] is "the calendar says nothing is booked"; null is "we could not ask"');
check('an unparseable busy entry is treated as busy, not ignored',
  removeBusy(slots, [{ start: 'nonsense', end: 'nonsense' }], rules).length === 0,
  'failing open on a malformed response is the same bug in a different coat');

// ---------------------------------------------------------------------------
section('S4  the Google adapter fails CLOSED when the calendar cannot be read');
const { createGoogleScheduler } = await import('../lib/scheduling-google.js');
const g = createGoogleScheduler({ now: MON });

// Fake the provider boundary only.
const realFetch = globalThis.fetch;
// The token refresh reads `.json()` while `gcall` reads `.text()`, so a fake
// response has to offer BOTH. An earlier version provided only `text()`: the
// token call threw, every free/busy read failed, and S4 ("fails closed when the
// calendar cannot be read") passed for entirely the wrong reason. Its own
// negative control, S4b, is what caught it.
const res = (status, payload) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
  json: async () => (typeof payload === 'string' ? JSON.parse(payload || '{}') : payload),
});
const fakeGoogle = (busyList, { fail = false } = {}) => {
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('oauth2') || u.includes('/token')) return res(200, { access_token: 't', expires_in: 3600 });
    if (u.includes('freeBusy')) {
      if (fail) return res(503, 'upstream unavailable');
      return res(200, { calendars: { primary: { busy: busyList } } });
    }
    if (u.includes('/events')) {
      const body = JSON.parse(opts?.body || '{}');
      return res(200, {
        id: 'ev_' + Math.random().toString(36).slice(2, 8),
        htmlLink: 'https://cal.example/e',
        hangoutLink: 'https://meet.example/x',
        status: 'confirmed',
        summary: body.summary,
      });
    }
    return res(200, {});
  };
};

await saveRules({ timezone: TZ });
fakeGoogle([], { fail: true });
let a = await g.availability({ from: MON });
check('an unreadable calendar offers NOTHING', a.ok === false && a.slots.length === 0, JSON.stringify(a).slice(0, 150));
check('and says why', /could not be read/.test(a.reason), a.reason);
check('it does NOT report as disconnected — the calendar exists, it just did not answer',
  a.connected === true, String(a.connected));

section('S4b  NEGATIVE CONTROL: a readable calendar does offer times');
fakeGoogle([]);
a = await g.availability({ from: MON });
check('slots are offered', a.ok === true && a.slots.length > 0, `${a.slots?.length} slots`);
check('the timezone is named', a.timezone === TZ, a.timezone);
check('and the call length is stated', a.rules?.minutes === DEFAULT_RULES.slotMinutes, String(a.rules?.minutes));

section('S4c  a real busy period removes the slot end to end');
const target = a.slots[2];
fakeGoogle([{ start: new Date(target.startAt).toISOString(), end: new Date(target.endAt).toISOString() }]);
const a2 = await g.availability({ from: MON });
check('the busy slot is no longer offered', !a2.slots.some((s) => s.startAt === target.startAt),
  'this is the whole point of the free/busy read');

// ---------------------------------------------------------------------------
section('S5  two visitors race for one slot — exactly one wins');
fakeGoogle([]);
const open = (await g.availability({ from: MON })).slots[0];
const person = (n) => ({
  startAt: open.startAt, minutes: open.minutes, name: `P${n}`,
  email: `p${n}@example.invalid`, businessName: `B${n}`, timezone: TZ,
});
const [r1, r2] = await Promise.all([g.book(person(1)), g.book(person(2))]);
const wins = [r1, r2].filter((x) => x.ok);
const loses = [r1, r2].filter((x) => !x.ok);
check('EXACTLY ONE BOOKING SUCCEEDS', wins.length === 1, JSON.stringify([r1.ok, r2.ok]));
check('and the other is told the time went', loses[0].taken === true, JSON.stringify(loses[0]));
check('the winner has a provider id', !!wins[0].providerId, String(wins[0].providerId));
check('and a real meeting link from the provider', /meet\.example/.test(wins[0].meetingUrl || ''), wins[0].meetingUrl);

section('S5b  the claimed slot is no longer offered to anyone else');
const after = await g.availability({ from: MON });
check('it is gone from availability', !after.slots.some((s) => s.startAt === open.startAt),
  'a slot held by an in-flight booking must not be offered again');

section('S6  an uncertain provider answer is NOT retried');
const open2 = after.slots[0];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('oauth2') || u.includes('/token')) return res(200, { access_token: 't', expires_in: 3600 });
  if (u.includes('freeBusy')) return res(200, { calendars: { primary: { busy: [] } } });
  throw new Error('socket hang up');
};
const unsure = await g.book({ ...person(3), startAt: open2.startAt, minutes: open2.minutes });
check('it is reported as uncertain', unsure.uncertain === true, JSON.stringify(unsure).slice(0, 150));
check('and explicitly says not to retry', unsure.doNotRetry === true,
  'one click must not be able to create two appointments');
check('the slot stays CLAIMED, not released',
  !!(await store.get(`sched:slot:${Math.floor(open2.startAt / 1000)}`)),
  'releasing a slot that may already hold a real appointment is how a double booking happens');

section('S6b  but a 4xx refusal DOES release the slot');
const after2 = await g.availability({ from: MON });
const open3 = after2.slots[0];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('oauth2') || u.includes('/token')) return res(200, { access_token: 't', expires_in: 3600 });
  if (u.includes('freeBusy')) return res(200, { calendars: { primary: { busy: [] } } });
  const err = new Error('invalid attendee'); err.status = 400; throw err;
};
const refused = await g.book({ ...person(4), startAt: open3.startAt, minutes: open3.minutes });
check('it is a plain failure, not uncertain', refused.ok === false && !refused.uncertain, JSON.stringify(refused).slice(0, 140));
check('and the slot is handed back',
  !(await store.get(`sched:slot:${Math.floor(open3.startAt / 1000)}`)),
  'a provider that rejected the request definitely did not create it, so the time is free again');

globalThis.fetch = realFetch;

// ---------------------------------------------------------------------------
section('S7  rules are owner-editable and an unreadable set still constrains');
const saved = await saveRules({ maxPerDay: 2, previewLeadHours: 72 });
check('a change is kept', saved.maxPerDay === 2 && saved.previewLeadHours === 72, JSON.stringify(saved).slice(0, 120));
const reread = await getRules();
check('and read back', reread.maxPerDay === 2, String(reread.maxPerDay));

const realGet = store.get;
store.get = async () => { throw new Error('kv down'); };
const fallback = await getRules();
store.get = realGet;
check('an unreadable rule set falls back to the DEFAULTS, not to nothing',
  fallback.minLeadHours === DEFAULT_RULES.minLeadHours && fallback.maxPerDay === DEFAULT_RULES.maxPerDay,
  'falling back to {} would drop the lead time and offer a call in ten minutes');
await saveRules({ maxPerDay: DEFAULT_RULES.maxPerDay, previewLeadHours: DEFAULT_RULES.previewLeadHours });

done();
