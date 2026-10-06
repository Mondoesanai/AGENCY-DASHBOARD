// An alert you cannot put down is an alert you learn to ignore.
//
// R16.6/R16.7. `clearEscalation` existed and had no caller, so the dashboard
// could raise an alert and never clear one. Worse, there was no index over the
// escalation records at all — they were written to `recovery:escalated:<id>`
// and nothing could enumerate them, so even a button would have had nothing to
// show. Both halves are fixed here, and the cycle is driven end to end:
// raise → list → acknowledge → gone → raise again when it comes back.
//
// The last step matters most. Acknowledging clears the ALERT, not the CAUSE,
// and a system that treats an acknowledgement as a fix is worse than one with
// no acknowledgement at all.
import { check, section, done } from './world.mjs';
import {
  escalateOnce, listEscalations, clearEscalation, recordSweep, sweepHistory, sweepHealth,
  RE_ESCALATE_AFTER_MS,
} from '../lib/recovery.js';
import { renderEscalations, renderSweeps } from '../public/automation.js';

const finding = (id, what) => ({ id, what, action: 'Go and look at it', severity: 'stuck' });

// ---------------------------------------------------------------------------
section('A1  a raised alert can be found again');
let before = await listEscalations();
check('nothing is raised to begin with', before.length === 0, JSON.stringify(before));

const r1 = await escalateOnce(finding('stuck_worker', 'The reply worker has not run for 3 hours'));
check('it is raised', r1.sent === true, JSON.stringify(r1));

let list = await listEscalations();
check('and it can be listed', list.length === 1, JSON.stringify(list));
check('with what is wrong', /has not run for 3 hours/.test(list[0].title), list[0].title);
check('and what to do about it', /Go and look at it/.test(list[0].detail), list[0].detail);
check('and when it started', Number(list[0].at) > 0, String(list[0].at));

section('A2  raising the same thing twice does not shout twice');
const r2 = await escalateOnce(finding('stuck_worker', 'The reply worker has not run for 3 hours'));
check('the second raise is suppressed', r2.sent === false, JSON.stringify(r2));
check('because it was already raised', /already raised/.test(r2.reason || ''), r2.reason);
check('and the list still shows one, not two', (await listEscalations()).length === 1);

// ---------------------------------------------------------------------------
section('A3  acknowledging puts it down');
await clearEscalation('stuck_worker');
list = await listEscalations();
check('it is gone from the list', list.length === 0, JSON.stringify(list));

section('A4  but acknowledging is not fixing');
// The whole risk of an acknowledge button: somebody clears the alert and the
// underlying problem carries on unseen. It must come back.
const r3 = await escalateOnce(finding('stuck_worker', 'The reply worker has not run for 3 hours'));
check('the same problem CAN be raised again after acknowledgement', r3.sent === true, JSON.stringify(r3));
check('and it is back on the list', (await listEscalations()).length === 1);
check('the re-raise window is a real duration, not instant',
  RE_ESCALATE_AFTER_MS >= 3600e3, String(RE_ESCALATE_AFTER_MS));
await clearEscalation('stuck_worker');

section('A5  a record that expired does not haunt the list');
// The records carry a 30-day TTL but the index does not, so an id whose record
// is gone has to be dropped as it is found, or the list grows for ever.
await escalateOnce(finding('ghost', 'Something transient'));
const { store } = await import('../lib/store.js');
await store.del('recovery:escalated:ghost');
check('an id with no record is not listed', (await listEscalations()).length === 0,
  JSON.stringify(await listEscalations()));
check('and it is removed from the index rather than retried every time',
  (await store.smembers('recovery:escalated:all') || []).length === 0,
  JSON.stringify(await store.smembers('recovery:escalated:all')));

// ---------------------------------------------------------------------------
section('A6  "the sweep found nothing" and "the sweep did not run" look different');
const h0 = await sweepHealth({});
check('with no sweep recorded, health says so', !!h0, JSON.stringify(h0).slice(0, 140));

await recordSweep({ now: Date.now(), findings: [], escalated: [], actions: [] });
const hist = await sweepHistory({ limit: 5 });
const runs = hist?.sweeps || (Array.isArray(hist) ? hist : []);
check('a sweep that ran is recorded', runs.length >= 1, JSON.stringify(hist).slice(0, 160));

const fresh = await sweepHealth({});
check('and a recent sweep is not stale', fresh.ok === true, JSON.stringify(fresh).slice(0, 140));

const old = await sweepHealth({ now: Date.now() + 48 * 3600e3 });
check('while a sweep from two days ago IS stale', old.ok === false, JSON.stringify(old).slice(0, 140));
check('and it says how long it has been', /has not run for 48h/.test(old.note || ''), old.note);

// ---------------------------------------------------------------------------
section('A7  the screen says both things');
let html = renderEscalations([{ id: 'x', title: 'The reply worker stopped', detail: 'Go and look', at: Date.now() - 3600e3 }]);
check('a raised alert is shown', /The reply worker stopped/.test(html), html.slice(0, 160));
check('with an acknowledge button', /auto-ack/.test(html));
check('and it says what acknowledging does NOT do', /clears the alert, not the cause/.test(html));
check('nothing renders when nothing is raised', renderEscalations([]) === '' && renderEscalations(null) === '');

html = renderSweeps({ sweeps: [{ at: Date.now() - 600e3, findings: 0 }] }, { ok: true });
check('a healthy sweep is reported', /running on schedule/.test(html), html.slice(0, 200));

html = renderSweeps({ sweeps: [] }, { ok: false, note: 'the self-healing sweep has not run for 72h' });
check('a stalled sweep is called out', /has not run recently/.test(html), html.slice(0, 200));
check('and it is open by default rather than hidden in a fold', /<details[^>]* open/.test(html), html.slice(0, 120));
check('saying why the rest of the screen cannot be trusted',
  /looks exactly like a sweep that found nothing wrong/.test(html));
check('nothing renders with no data at all', renderSweeps(null, null) === '');

done();
