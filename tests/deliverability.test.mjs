// R9.9 — stop sending when the numbers say it is harming people, and never
// start again by itself.
//
// The thing this test is really about is the DENOMINATOR. At ~25 messages a
// week, one hard bounce is 4% — over any sane threshold, and also completely
// unremarkable. A trip that fires on that fires most weeks, gets switched off
// within a month, and then protects nothing. So the tests that matter most
// here are the ones asserting it does NOT fire on small samples, and the ones
// asserting it still fires when the evidence is real.
import { check as t, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  WINDOW_DAYS, SIGNALS, signal, LEVEL,
  countDailyEvent, windowTotals, assess, check, enforce, stopState, clearStop, summarise,
} from '../lib/deliverability.js';

const dayKey = (at) => new Date(at).toISOString().slice(0, 10);
const NOW = Date.UTC(2026, 9, 1, 12);

const reset = async () => {
  await store.set('deliverability:trip', '').catch(() => {});
  for (let i = 0; i < 40; i++) {
    const d = dayKey(NOW - i * 24 * 3600e3);
    for (const type of ['delivered', 'bounced', 'complained', 'unsubscribed']) {
      await store.set(`delivery:day:${d}:${type}`, '0').catch(() => {});
    }
  }
};
/** put `n` events of `type` on the day `daysAgo` days before NOW */
const put = async (type, n, daysAgo = 0) => {
  await store.set(`delivery:day:${dayKey(NOW - daysAgo * 24 * 3600e3)}:${type}`, String(n));
};
const totals = (o) => ({ delivered: 0, bounced: 0, complained: 0, unsubscribed: 0, known: true, days: WINDOW_DAYS, ...o });

// ---------------------------------------------------------------------------
section('D1  the signals are declared with their numbers and their reasons');
t('there are signals', SIGNALS.length >= 3);
for (const s of SIGNALS) {
  t(`${s.id} has a warn level`, s.warnAt > 0 && s.warnAt < 1);
  t(`${s.id} has a higher stop level`, s.pauseAt > s.warnAt);
  t(`${s.id} says why that number`, typeof s.why === 'string' && s.why.length > 40);
  t(`${s.id} says what to do about it`, typeof s.fix === 'string' && s.fix.length > 30);
}
t('the complaint thresholds match what Gmail and Yahoo publish', (() => {
  const c = signal('complaint-rate');
  return !!c && Math.abs(c.warnAt - 0.001) < 1e-9 && Math.abs(c.pauseAt - 0.003) < 1e-9;
})());
t('and complaints have a count backstop, because two is already a problem', signal('complaint-rate').countBackstop === 2);
t('an unknown signal is not invented', signal('nonsense') === null);

// ---------------------------------------------------------------------------
section('D2  a small sample does NOT trip — the failure that gets this switched off');
// 25 sends a week is the real volume. One bounce in 25 is 4%, over the 5%?
// no — but two is 8%, which IS over, and still means almost nothing.
let a = assess(signal('hard-bounce-rate'), totals({ delivered: 25, bounced: 2 }));
t('2 bounces in 25 is 8%, well over the 5% stop level', a.observed > 0.05);
t('but it does NOT stop sending', a.level !== LEVEL.PAUSE, JSON.stringify(a));
t('it warns instead', a.level === LEVEL.WARN);
t('and says the sample is why nothing was stopped', /Not yet enough to be confident|Too few messages/.test(a.reason), a.reason);

a = assess(signal('hard-bounce-rate'), totals({ delivered: 25, bounced: 1 }));
t('1 bounce in 25 does not stop sending either', a.level !== LEVEL.PAUSE);
a = assess(signal('opt-out-rate'), totals({ delivered: 20, unsubscribed: 1 }));
t('one opt-out in 20 does not stop sending', a.level !== LEVEL.PAUSE, JSON.stringify(a));

// THE EXCEPTION, and it is the arithmetic rather than a special case.
// "One event is noise" holds because the bounce threshold is 5%. The complaint
// threshold is 0.30%, and one complaint in 30 is a 3.3% rate whose lower bound
// is still 0.59% — twice the line where Gmail starts filtering. When the
// threshold is that small, a single event IS the evidence, and refusing to act
// on it would be the same mistake in the other direction.
a = assess(signal('complaint-rate'), totals({ delivered: 30, complained: 1 }));
t('one complaint in 30 DOES stop sending', a.level === LEVEL.PAUSE, JSON.stringify(a));
t('and not via the count backstop — the rate itself is decisive', a.viaCount !== true);
t('because even its lower bound is above 0.30%', a.lower > 0.003, String(a.lower));
t('while the same single event at the bounce threshold is noise',
  assess(signal('hard-bounce-rate'), totals({ delivered: 30, bounced: 1 })).level !== LEVEL.PAUSE);

// and the other side of that: a perfect record must never be reported as a
// worry. With a 0.30% threshold the upper bound of 0-in-500 is 0.76%, so
// warning on the upper bound alone would warn for ever at this volume.
a = assess(signal('complaint-rate'), totals({ delivered: 500, complained: 0 }));
t('no complaints in 500 is fine, not "worth watching"', a.level === LEVEL.OK, JSON.stringify(a));
a = assess(signal('complaint-rate'), totals({ delivered: 25, complained: 0 }));
t('and no complaints in 25 is fine too', a.level === LEVEL.OK, JSON.stringify(a));

// ---------------------------------------------------------------------------
section('D3  a real problem DOES stop sending');
a = assess(signal('hard-bounce-rate'), totals({ delivered: 400, bounced: 48 }));
t('48 bounces in 400 (12%) stops sending', a.level === LEVEL.PAUSE, JSON.stringify(a));
t('the reason names the numbers', /48 of 400/.test(a.reason), a.reason);
t('and allows for the sample size out loud', /Even allowing for the small number of messages/.test(a.reason), a.reason);
t('and says what to do', /where these addresses came from/.test(a.fix || ''), a.fix);

a = assess(signal('opt-out-rate'), totals({ delivered: 300, unsubscribed: 45 }));
t('15% opting out stops sending', a.level === LEVEL.PAUSE, JSON.stringify(a));
t('and points at the list rather than the wording', /usually the list, not the copy/.test(a.fix || ''), a.fix);

// the boundary: a rate just over the line with a big enough sample
a = assess(signal('hard-bounce-rate'), totals({ delivered: 2000, bounced: 130 }));
t('6.5% over 2000 sends stops sending', a.level === LEVEL.PAUSE, JSON.stringify(a));
a = assess(signal('hard-bounce-rate'), totals({ delivered: 2000, bounced: 80 }));
t('4% over 2000 sends does not', a.level !== LEVEL.PAUSE, JSON.stringify(a));

// ---------------------------------------------------------------------------
section('D4  the complaint backstop does not wait for a rate to become significant');
a = assess(signal('complaint-rate'), totals({ delivered: 30, complained: 2 }));
t('2 complaints stops sending even on 30 messages', a.level === LEVEL.PAUSE, JSON.stringify(a));
t('and says it was the count, not the rate', a.viaCount === true);
t('the reason names the count', /2 spam complaints/.test(a.reason), a.reason);
a = assess(signal('complaint-rate'), totals({ delivered: 0, complained: 2 }));
t('2 complaints with no denominator at all still stops sending', a.level === LEVEL.PAUSE, JSON.stringify(a));
t('the other signals have no count backstop', signal('hard-bounce-rate').countBackstop === 0);
a = assess(signal('hard-bounce-rate'), totals({ delivered: 0, bounced: 2 }));
t('so 2 bounces with no denominator does not stop sending', a.level !== LEVEL.PAUSE, JSON.stringify(a));

// ---------------------------------------------------------------------------
section('D5  unknown is not healthy, and is not a reason to stop either');
a = assess(signal('hard-bounce-rate'), { ...totals({ delivered: 100, bounced: 1 }), known: false });
t('an unreadable window is unknown', a.level === LEVEL.UNKNOWN, JSON.stringify(a));
t('not ok', a.level !== LEVEL.OK);
t('and not a stop', a.level !== LEVEL.PAUSE);
t('and it says so in words', /Unknown is not the same as fine/.test(a.reason), a.reason);

// and the propagation that makes that reachable: ONE unreadable day in the
// window must make the whole window unknown. A window with a hole in it
// produces a rate over the wrong denominator, which is worse than no rate
// because it looks like one.
await reset();
await put('delivered', 300, 2);
await put('bounced', 90, 2);
const holeGet = store.get;
const holeDay = dayKey(NOW - 5 * 24 * 3600e3);
store.get = async (k) => { if (String(k).includes(holeDay)) throw new Error('store down'); return holeGet.call(store, k); };
let hole = await windowTotals({ now: NOW });
let holeCheck = await check({ now: NOW });
const holeEnforce = await enforce({ now: NOW });
store.get = holeGet;
t('one unreadable day makes the whole window unknown', hole.known === false, JSON.stringify(hole));
t('so every signal reports unknown', holeCheck.signals.every((x) => x.level === LEVEL.UNKNOWN), JSON.stringify(holeCheck.signals.map((x) => x.level)));
t('and the picture is unknown, not ok', holeCheck.worst === LEVEL.UNKNOWN, holeCheck.worst);
t('even though the readable days alone would have stopped sending', (await check({ now: NOW })).worst === LEVEL.PAUSE);
t('and an unknown window does NOT stop sending by itself', holeEnforce.action === 'none', holeEnforce.action);
t('because pausing on a flaky store is the same noise in a different coat', (await stopState()).stopped !== true);
await reset();

let s = summarise({ worst: LEVEL.UNKNOWN, signals: [], totals: totals({}) });
t('the summary of unknown is not an all-clear', s.word === 'cannot tell');
t('and says so explicitly', /not an all-clear/.test(s.detail), s.detail);
s = summarise(null);
t('no result at all is not healthy', s.word !== 'healthy');
s = summarise({ worst: LEVEL.OK, signals: [], totals: totals({ delivered: 0 }) });
t('nothing sent is not reported as healthy', s.word === 'nothing sent', s.word);
t('because there is nothing to judge', /nothing to judge/.test(s.detail));
s = summarise({ worst: LEVEL.OK, signals: [], totals: totals({ delivered: 200 }) });
t('200 delivered with everything under its level is healthy', s.word === 'healthy');

// ---------------------------------------------------------------------------
section('D6  the window rolls — an old bad week does not stop sending now');
await reset();
await put('delivered', 300, 20);   // outside the 14-day window
await put('bounced', 90, 20);
let w = await windowTotals({ now: NOW });
t('events outside the window are not counted', w.bounced === 0 && w.delivered === 0, JSON.stringify(w));
let r = await check({ now: NOW });
t('so nothing stops sending', r.worst !== LEVEL.PAUSE, r.worst);

await put('delivered', 300, 3);    // inside it
await put('bounced', 90, 3);
w = await windowTotals({ now: NOW });
t('events inside the window are counted', w.bounced === 90 && w.delivered === 300, JSON.stringify(w));
r = await check({ now: NOW });
t('and the same numbers now stop sending', r.worst === LEVEL.PAUSE, JSON.stringify(r.signals));

// ---------------------------------------------------------------------------
section('D7  the trip stops OUTREACH, not the clients\' site work');
await reset();
await put('delivered', 300, 2);
await put('bounced', 90, 2);

const { pauseState } = await import('../lib/heartbeat.js');
const pauseBefore = await pauseState();
let e = await enforce({ now: NOW });
t('it stopped sending', e.action === 'stopped', JSON.stringify({ action: e.action, worst: e.worst }));
const pauseAfter = await pauseState();
t('the GLOBAL automation pause is untouched', pauseAfter.paused === pauseBefore.paused, JSON.stringify(pauseAfter));
t('because a bounced prospect is not a reason to stop paying clients\' work', pauseAfter.paused === false);

let st = await stopState();
t('the outreach stop is recorded', st.stopped === true);
t('attributed to automation', st.by === 'automatic');
t('with what tripped it', Array.isArray(st.signals) && st.signals.length > 0 && st.signals[0].id === 'hard-bounce-rate', JSON.stringify(st.signals));
t('and the numbers behind it', st.signals[0].bad === 90 && st.signals[0].n === 300);
t('the reason names what to do', /What to do:/.test(st.reason || ''), st.reason);

// running again must not overwrite what tripped it first
e = await enforce({ now: NOW });
t('a second run does not re-stop', e.action === 'already-stopped', e.action);
st = await stopState();
t('and the original trip time is kept', st.at === NOW);

// ---------------------------------------------------------------------------
section('D8  it never starts sending again by itself');
// the numbers recover completely
await reset();
await put('delivered', 500, 1);
r = await check({ now: NOW });
t('the numbers are now clean', r.worst === LEVEL.OK, JSON.stringify(r.signals));
// but the stop was cleared by reset(), so set one up again and re-check
await store.set('deliverability:trip', JSON.stringify({ stopped: true, at: NOW - 3600e3, by: 'automatic', reason: 'it was bad', signals: [] }));
e = await enforce({ now: NOW });
t('a clean check does nothing', e.action === 'none', e.action);
st = await stopState();
t('and the stop is STILL in place', st.stopped === true, JSON.stringify(st));

let c = await clearStop({ by: 'automatic' });
t('automation may not clear the stop', c.ok === false, JSON.stringify(c));
t('and the refusal gives the reason', /nothing is being sent, so nothing is bouncing/.test(c.error || ''), c.error);
t('the stop survived the attempt', (await stopState()).stopped === true);

c = await clearStop({ by: 'owner', note: 'checked the list source' });
t('the owner may clear it', c.ok === true, JSON.stringify(c));
st = await stopState();
t('and sending is allowed again', st.stopped === false);
t('with who cleared it recorded', st.clearedBy === 'owner');
t('and their note', /checked the list source/.test(st.note || ''), st.note);

// ---------------------------------------------------------------------------
section('D9  the stop is actually read by the send gate');
// this is the wiring that matters: a flag nothing consults stops nothing
const { sendReadiness } = await import('../lib/outreach-email.js');
await store.set('deliverability:trip', JSON.stringify({ stopped: true, at: NOW, by: 'automatic', reason: 'hard bounces: 90 of 300.' }));
let ready = await sendReadiness({ env: {} });
t('the send gate reports the deliverability stop as a blocker',
  ready.blockers.some((b) => b.code === 'deliverability-stop'), JSON.stringify(ready.blockers.map((b) => b.code)));
t('and the blocker carries the reason', ready.blockers.some((b) => /90 of 300/.test(b.text)));
t('so nothing is ready to send', ready.ready === false);

await clearStop({ by: 'owner' });
ready = await sendReadiness({ env: {} });
t('once cleared, that blocker is gone', !ready.blockers.some((b) => b.code === 'deliverability-stop'),
  JSON.stringify(ready.blockers.map((b) => b.code)));

// ---------------------------------------------------------------------------
section('D10 a failed write is reported as a failure, not as a stop');
await reset();
await put('delivered', 300, 1);
await put('bounced', 90, 1);
const realSet = store.set;
store.set = async (k, v) => { if (String(k).startsWith('deliverability:')) throw new Error('store down'); return realSet.call(store, k, v); };
e = await enforce({ now: NOW });
store.set = realSet;
t('a stop that could not be written is NOT reported as stopped', e.stopped === false, JSON.stringify({ action: e.action, stopped: e.stopped }));
t('it is reported as a failure to stop', e.action === 'failed-to-stop', e.action);
t('and says sending is still possible', /still able to send/.test(e.error || ''), e.error);

// and an unreadable stop flag holds sending rather than letting it through
const realGet = store.get;
store.get = async (k) => { if (String(k) === 'deliverability:trip') throw new Error('store down'); return realGet.call(store, k); };
st = await stopState();
t('an unreadable flag is not read as "not stopped"', st.known === false, JSON.stringify(st));
ready = await sendReadiness({ env: {} });
store.get = realGet;
t('and the send gate holds sending', ready.blockers.some((b) => b.code === 'deliverability-unknown'),
  JSON.stringify(ready.blockers.map((b) => b.code)));

// ---------------------------------------------------------------------------
section('D11 the daily counter is what the window reads');
await reset();
await countDailyEvent('bounced', NOW);
await countDailyEvent('bounced', NOW);
await countDailyEvent('delivered', NOW);
w = await windowTotals({ now: NOW });
t('counted events show up in the window', w.bounced === 2 && w.delivered === 1, JSON.stringify(w));
t('an event with no type is refused', (await countDailyEvent('')).ok === false);

// and the real event path writes it
await reset();
const { applyDeliveryEvent } = await import('../lib/outreach-email.js');
await applyDeliveryEvent({ type: 'bounced', email: 'nobody@example.invalid', hard: true, at: NOW });
w = await windowTotals({ now: NOW });
t('a real delivery event lands in the day bucket', w.bounced === 1, JSON.stringify(w));

await reset();
done();
