// Can the watchdog tell you whether the watchdog is running?
//
// The recovery sweep has been firing every ~10 minutes from GitHub Actions for
// a long time and recorded NOTHING. So "is anything actually sweeping?" had no
// answer, and if that workflow ever stopped, the one component whose job is to
// notice problems would have been the single problem nobody could notice. Its
// own source comments admit the gap: "if GitHub Actions itself stops firing,
// nothing here notices."
//
// These checks cover the recording, the staleness detection, and the ordering
// rule that stops the daily pass from starving its own fallback.
import fs from 'node:fs';
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { recordSweep, sweepHealth, sweepHistory, SWEEP_HISTORY, diagnose } from '../lib/recovery.js';
import { WORKERS, automationStatus } from '../lib/heartbeat.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const H = 3600e3;

const reset = async () => {
  await store.set('recovery:history', '');
  await store.set('recovery:lastRun', '');
};

// ---------------------------------------------------------------------------
section('V1  never having run is not the same as being healthy');
await reset();
let h = await sweepHealth({ now: NOW });
check('a sweep that never ran is not ok', h.ok === false);
check('and says it has never run', h.everRan === false, JSON.stringify(h));
check('which is distinguished from having stopped', /never recorded a run/.test(h.note), h.note);

// ---------------------------------------------------------------------------
section('V2  a sweep records that it happened');
await reset();
let rec = await recordSweep({ now: NOW, findings: [{ id: 'worker-stalled:tick' }, { id: 'client-unanswered' }], escalated: ['client-unanswered'] });
check('the write succeeds', rec.ok === true, JSON.stringify(rec).slice(0, 120));
h = await sweepHealth({ now: NOW });
check('it is now healthy', h.ok === true);
check('with the time it ran', h.lastAt === NOW, String(h.lastAt));
check('and no complaint', h.note === null);

const hist = await sweepHistory({});
check('the sweep is in the history', hist.sweeps.length === 1);
check('with what it found', hist.sweeps[0].findings === 2, JSON.stringify(hist.sweeps[0]));
check('and what it raised', hist.sweeps[0].escalated.includes('client-unanswered'));
check('and which findings they were', hist.sweeps[0].ids.includes('worker-stalled:tick'));

// ---------------------------------------------------------------------------
section('V3  a sweep that has stopped is detected');
await reset();
await recordSweep({ now: NOW - 9 * H, findings: [] });
h = await sweepHealth({ now: NOW });
check('9 hours of silence is not ok', h.ok === false);
check('it reports how long', /has not run for 9h/.test(h.note), h.note);
check('but it HAS run before', h.everRan === true);

await reset();
await recordSweep({ now: NOW - 2 * H, findings: [] });
check('2 hours ago is still fine', (await sweepHealth({ now: NOW })).ok === true);
check('a tighter threshold can be asked for', (await sweepHealth({ now: NOW, staleMs: H })).ok === false);

// ---------------------------------------------------------------------------
section('V4  history is bounded and newest-first');
await reset();
// chronological, the way sweeps actually happen
for (let i = 0; i < SWEEP_HISTORY + 15; i++) await recordSweep({ now: NOW - (SWEEP_HISTORY + 15 - i) * 60000, findings: [] });
const all = await sweepHistory({ limit: 1000 });
check(`history is capped at ${SWEEP_HISTORY}`, all.sweeps.length === SWEEP_HISTORY, String(all.sweeps.length));
check('newest first', all.sweeps[0].at > all.sweeps[1].at);
check('the oldest entries are the ones dropped', all.sweeps[all.sweeps.length - 1].at > NOW - (SWEEP_HISTORY + 1) * 60000);

// order is guaranteed by sorting, not by luck: a replayed or clock-skewed run
// must not misorder the activity view
await reset();
await recordSweep({ now: NOW - H, findings: [] });
await recordSweep({ now: NOW - 5 * H, findings: [] }); // arrives late, older timestamp
await recordSweep({ now: NOW, findings: [] });
const ordered = (await sweepHistory({})).sweeps;
check('an out-of-order write is still sorted newest-first',
  ordered[0].at === NOW && ordered[1].at === NOW - H && ordered[2].at === NOW - 5 * H,
  ordered.map((s) => s.at - NOW).join(','));
check('a malformed entry is skipped rather than crashing the view',
  (await (async () => {
    await store.set('recovery:history', JSON.stringify([{ at: NOW }, null, { nope: 1 }, { at: NOW - H }]));
    return (await sweepHistory({})).sweeps.length;
  })()) === 2);

// ---------------------------------------------------------------------------
section('V5  the sweep is a monitored worker like any other');
check('recovery is in the worker registry', !!WORKERS.recovery);
check('it names what runs it', /GitHub Actions/.test(WORKERS.recovery.runBy), WORKERS.recovery.runBy);
check('and mentions the daily floor', /daily/.test(WORKERS.recovery.runBy));
check('its key is the one sweepHealth writes', WORKERS.recovery.key === 'recovery:lastRun');

await reset();
await recordSweep({ now: NOW, findings: [] });
const a = await automationStatus(NOW);
const w = (a.workers || []).find((x) => x.id === 'recovery');
check('it appears in the automation panel', !!w, JSON.stringify((a.workers || []).map((x) => x.id)));
check('and reads as running', w && w.status === 'ok', w && w.status);

// ---------------------------------------------------------------------------
section('V6  unreadable storage is reported, not treated as healthy');
const realGet = store.get;
store.get = async (k) => { if (k === 'recovery:lastRun') throw new Error('storage down'); return realGet.call(store, k); };
h = await sweepHealth({ now: NOW });
store.get = realGet;
check('it does not claim to be ok', h.ok === false);
check('it says the state is unknown', h.unknown === true, JSON.stringify(h));
check('and that unknown is not healthy', /unknown/.test(h.note), h.note);

// ---------------------------------------------------------------------------
section('V7  the daily pass cannot starve its own fallback');
const cron = fs.readFileSync(new URL('../api/cron-daily.js', import.meta.url), 'utf8');
const head = cron.slice(0, cron.indexOf('Health + billing'));
check('it checks the sweep health before doing any work', /sweepHealth/.test(head), 'must be before the budget is spent');
check('and runs the sweep first when it is overdue', /recover\(/.test(head));
check('recording that it did', /action:\s*'recovery-first'/.test(head));
check('the later block stands down if it already ran', /if\s*\(\s*sweptEarly\s*\)/.test(cron));
check('a stopped watchdog is reported to the owner', /The watchdog stopped/.test(cron));
check('naming the workflow to check', /check-revisions\.yml/.test(cron));
// the ordering is the point: the early block must precede the late one
check('the early sweep really is before the late one',
  cron.indexOf("action: 'recovery-first'") < cron.indexOf("action: 'recovery'"),
  `${cron.indexOf("action: 'recovery-first'")} vs ${cron.indexOf("action: 'recovery'")}`);

// ---------------------------------------------------------------------------
section('V8  recovering does not disturb what it is watching');
await reset();
await store.set('revisions:all', JSON.stringify([]));
const before = await store.get('revisions:all');
await diagnose({ now: NOW });
check('diagnose leaves the tickets alone', (await store.get('revisions:all')) === before);

await reset();
done();
