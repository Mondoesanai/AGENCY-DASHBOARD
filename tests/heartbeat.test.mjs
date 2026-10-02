// R2.6 — automation status from real check-ins, and a pause the workers honour.
//
// Two things are being tested, and the second is the one that matters:
//   * a status line that comes from a timestamp a worker actually wrote,
//     with "cannot tell" kept distinct from "fine" and from "stopped";
//   * a pause that stops real work. Before this, pausing only refused to
//     SPEND — anything that cost nothing ran straight through it.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  WORKERS, BEAT, recordBeat, readBeat, statusFor, ago,
  pauseState, setPaused, pauseGate, automationStatus,
} from '../lib/heartbeat.js';
import { headline, renderAutomation, wireAutomation, everyWords, STATUS_WORD } from '../public/automation.js';

const NOW = Date.UTC(2026, 9, 20, 12, 0, 0);
const reset = async () => {
  for (const w of Object.values(WORKERS)) await store.set(w.key, '').catch(() => {});
  await store.set('automation:pause', '').catch(() => {});
};

// ---------------------------------------------------------------------------
section('H1  a beat is a real timestamp, written by a real worker');
await reset();
let r = await recordBeat('tick', NOW);
check('recording a beat succeeds', r.ok === true, JSON.stringify(r));
check('and reads back the same moment', (await readBeat('tick')) === NOW, String(await readBeat('tick')));
check('an unknown worker is refused rather than silently stored', (await recordBeat('nope')).ok === false);

// the inbox timestamp predates this module and is stored in SECONDS. Reading it
// as milliseconds would date every healthy inbox to 1970 and call it dead.
await store.set(WORKERS.revisions.key, String(Math.floor(NOW / 1000)));
check('a seconds-based beat is read as the same moment', (await readBeat('revisions')) === NOW, String(await readBeat('revisions')));
await recordBeat('revisions', NOW);
const rawRev = Number(await store.get(WORKERS.revisions.key));
check('and is written back in seconds, not milliseconds', rawRev === Math.floor(NOW / 1000), String(rawRev));

// ---------------------------------------------------------------------------
section('H2  each worker is judged against its own schedule');
// The SEO tick runs on GitHub's free scheduler, which really does deliver a
// "30 minute" job every few hours. One global threshold would cry wolf here
// and stay silent on the daily pass.
check('a 2-hour-old tick is fine', statusFor('tick', NOW - 2 * 3600e3, { now: NOW }).status === BEAT.OK);
check('the same age on the revision inbox is already slow', statusFor('revisions', NOW - 2 * 3600e3, { now: NOW }).status === BEAT.SLOW);
check('a 10-hour-old tick is slow', statusFor('tick', NOW - 10 * 3600e3, { now: NOW }).status === BEAT.SLOW);
check('a 25-hour-old tick is stalled', statusFor('tick', NOW - 25 * 3600e3, { now: NOW }).status === BEAT.STALLED);
check('a daily pass one hour late is not a fault', statusFor('daily', NOW - 25 * 3600e3, { now: NOW }).status === BEAT.OK);
check('but 40 hours of silence from it is slow', statusFor('daily', NOW - 40 * 3600e3, { now: NOW }).status === BEAT.SLOW);
check('a 4-day-old daily pass is stalled', statusFor('daily', NOW - 4 * 864e5, { now: NOW }).status === BEAT.STALLED);
check('a stalled worker names who runs it', /GitHub Actions/.test(statusFor('tick', NOW - 25 * 3600e3, { now: NOW }).text));

// ---------------------------------------------------------------------------
section('H3  "cannot tell" is never reported as "fine"');
let s = statusFor('tick', undefined, { now: NOW });
check('an unreadable timestamp is unknown', s.status === BEAT.UNKNOWN);
check('and says explicitly that it is not a report of running', /not a report that it is running/.test(s.text));
s = statusFor('tick', null, { now: NOW });
check('never having run is its own status', s.status === BEAT.NEVER);
check('and is not confused with unknown', s.status !== BEAT.UNKNOWN);
check('it says what was supposed to run it', /GitHub Actions/.test(s.text));
s = statusFor('tick', NOW - 60e3, { now: NOW, paused: true });
check('paused is reported as paused', s.status === BEAT.PAUSED);
check('but still shows when it last did anything', /1 minute ago|60 seconds ago/.test(s.text), s.text);

check('ago() says minutes', ago(5 * 60e3) === '5 minutes ago');
check('ago() says hours', ago(5 * 3600e3) === '5 hours ago');
check('ago() says days', ago(5 * 864e5) === '5 days ago');
check('ago() of nothing does not invent a time', ago(null) === 'at an unknown time');

// ---------------------------------------------------------------------------
section('H4  the pause is real: a worker asks before working');
await reset();
let g = await pauseGate();
check('nothing paused means work runs', g.run === true);

await setPaused({ paused: true, by: 'owner', reason: 'reviewing the copy' });
g = await pauseGate();
check('a pause stops ordinary work', g.run === false, JSON.stringify(g));
check('and says who paused it and why', /by owner/.test(g.reason) && /reviewing the copy/.test(g.reason), g.reason);
check('essential work is still allowed through', (await pauseGate({ essential: true })).run === true);

let p = await pauseState();
check('the pause records when', typeof p.at === 'number' && p.at > 0);
check('and who', p.by === 'owner');

await setPaused({ paused: false });
check('resuming lets work run again', (await pauseGate()).run === true);

// the one that decides whether this is a safety control or decoration
const realGet = store.get;
store.get = async (k) => { if (k === 'automation:pause') throw new Error('store down'); return realGet.call(store, k); };
g = await pauseGate();
check('if the pause flag cannot be read, work does NOT start', g.run === false, JSON.stringify(g));
check('and it says why rather than claiming a pause', /could not read whether automation is paused/.test(g.reason));
check('essential work still runs even then', (await pauseGate({ essential: true })).run === true);
p = await pauseState();
check('an unreadable pause is reported as not known', p.known === false && p.paused === false);
store.get = realGet;

// ---------------------------------------------------------------------------
section('H5  the overall status is the worst worker, not an average');
await reset();
await recordBeat('tick', NOW);
await recordBeat('daily', NOW);
await recordBeat('jobs', NOW);
await recordBeat('revisions', NOW);
let a = await automationStatus(NOW);
check('all four workers are reported', a.workers.length === 4, String(a.workers.length));
check('everything fresh is all ok', a.allOk === true, JSON.stringify(a.workers.map((w) => [w.id, w.status])));
check('and the headline says running', headline(a).word === 'running');

await store.set(WORKERS.jobs.key, String(NOW - 2 * 864e5));
a = await automationStatus(NOW);
check('one dead worker cannot hide behind three healthy ones', a.worst === BEAT.STALLED, a.worst);
check('the headline names it', /Outreach queue stalled/.test(headline(a).word), headline(a).word);
check('and allOk is false', a.allOk === false);

await reset();
a = await automationStatus(NOW);
check('with no beats at all nothing claims to be running', headline(a).word !== 'running', headline(a).word);

// ---------------------------------------------------------------------------
section('H6  the panel shows check-ins, never a countdown');
await reset();
await recordBeat('tick', NOW - 120e3);
await recordBeat('daily', NOW - 3600e3);
await recordBeat('jobs', NOW - 600e3);
await recordBeat('revisions', NOW - 300e3);
a = await automationStatus(NOW);
let html = renderAutomation(a);
check('each worker is listed by name', /Site improvements/.test(html) && /Outreach queue/.test(html) && /Revision inbox/.test(html) && /Daily pass/.test(html));
check('with when it actually last ran', /Last ran 2 minutes ago/.test(html), html.match(/Last ran [^<]*/)?.[0]);
check('and what it does', /Picks the most overdue client site/.test(html));
check('and who runs it', /GitHub Actions/.test(html));
check('the panel says these are check-ins, not a schedule', /rather than a countdown to a run that will not happen/.test(html));
check('a pause control is offered', /id="autoPause"/.test(html));

// paused
await setPaused({ paused: true, by: 'owner', reason: 'reviewing the copy' });
a = await automationStatus(NOW);
html = renderAutomation(a);
check('a paused panel offers resume instead of pause', /id="autoResume"/.test(html) && !/id="autoPause"/.test(html));
check('it says when and who', /by owner/.test(html) && /reviewing the copy/.test(html));
check('it promises queued work is not lost', /not lost/.test(html));
check('it is explicit that replies and opt-outs continue', /Replies and opt-outs are still honoured/.test(html));
check('and that client reports and billing are NOT paused', /Client reports and billing emails\s*are <b>not<\/b> paused/.test(html.replace(/\n\s*/g, ' ')), html.slice(html.indexOf('Client reports'), html.indexOf('Client reports') + 120));
await setPaused({ paused: false });

// loading and error are distinct from "all quiet"
check('no status yet renders as loading', /Checking what is running/.test(renderAutomation(null)));
html = renderAutomation(null, { error: 'the status call failed' });
check('a failed status call says so', /the status call failed/.test(html));
check('and does not read as an all-clear', /not an empty list|unknown/.test(html), html.slice(0, 200));

check('everyWords reads in minutes', everyWords(30 * 60e3) === '30 minutes');
check('everyWords reads in hours', everyWords(24 * 3600e3) === '24 hours');
check('every status has a plain word', Object.values(STATUS_WORD).every((w) => w.length > 2 && !/_/.test(w)));

// ---------------------------------------------------------------------------
section('H7  the pause buttons are wired');
const calls = [];
const root = {
  ls: [],
  addEventListener(t, fn) { this.ls.push([t, fn]); },
  click(sel) { this.ls.forEach(([, fn]) => fn({ target: { closest: (s) => (s === sel ? {} : null) } })); },
};
check('wiring reports success', wireAutomation(root, { pause: () => calls.push('pause'), resume: () => calls.push('resume'), retry: () => calls.push('retry') }) === true);
check('one delegated listener', root.ls.length === 1);
root.click('#autoPause');
check('the pause button calls pause', calls.join(',') === 'pause', calls.join(','));
root.click('#autoResume');
check('the resume button calls resume', calls.join(',') === 'pause,resume');
root.click('[data-retry="automation"]');
check('the retry button calls retry', calls.join(',') === 'pause,resume,retry');
root.click('.something-else');
check('a click elsewhere does nothing', calls.length === 3);

// ---------------------------------------------------------------------------
section('H8  the REAL tick honours the pause (not just a module that could)');
// The point of R2.6. A pause that only the budget checks is decoration: before
// this, pausing refused to SPEND, and everything that costs nothing — this
// tick, the job queue — ran straight through it.
await reset();
const { runAutoTick } = await import('../lib/tick.js');

await setPaused({ paused: true, by: 'owner', reason: 'test' });
const beforeBeat = await readBeat('tick');
const paused = await runAutoTick();
check('a paused tick does not do its work', paused.stoppedBecause !== undefined, JSON.stringify(paused).slice(0, 200));
check('and says it was the pause', /automation is paused/.test(paused.stoppedBecause || ''), paused.stoppedBecause);
check('it reports itself as paused', paused.paused === true);
check('no site was worked', paused.agent === null && (paused.ranks || []).length === 0);
// but it still records that the scheduler fired — otherwise pausing would make
// the dashboard report the automation as dead
check('the heartbeat is still written while paused', (await readBeat('tick')) !== beforeBeat && (await readBeat('tick')) > 0);

await setPaused({ paused: false });
const ran = await runAutoTick();
check('resuming lets the tick run its work again', ran.stoppedBecause === undefined, JSON.stringify(ran).slice(0, 200));

await reset();
done();
