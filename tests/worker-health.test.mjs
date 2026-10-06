// "It ran" and "it worked" are different facts.
//
// R18.5. `statusFor` decided health from one thing: when the worker last
// checked in. That is an ATTEMPT, and on this system an attempt can mean
// nothing more than that somebody opened the dashboard, because the page pokes
// the tick. So a worker that started every ten minutes and failed every single
// time reported `ok` — the "looks healthy while nothing works" failure, in the
// one component whose job is noticing that failure everywhere else.
//
// H2 is the check that did not exist before and is the reason this file does.
import { check, section, done } from './world.mjs';
import { startLocalApi } from './harness/local-api.mjs';
import {
  workerHealth, answerFor, HEALTH, HEALTH_RANK, HEALTH_WORD, SUCCESS_TOLERANCE_CYCLES,
} from '../lib/worker-health.js';
import { renderAnswer } from '../public/automation.js';

const NOW = Date.UTC(2026, 9, 6, 20, 0, 0);
const MIN = 60e3;
const w = (over = {}) => ({
  id: 'tick', label: 'Site improvements', runBy: 'GitHub Actions', everyMs: 10 * MIN,
  lastAttemptAt: NOW - 2 * MIN, lastSuccessAt: NOW - 2 * MIN, ...over,
});

// ---------------------------------------------------------------------------
section('H1  healthy means it STARTED and it FINISHED');
let h = workerHealth(w(), { now: NOW });
check('recent attempt plus recent success is healthy', h.health === HEALTH.HEALTHY, JSON.stringify(h));
check('and nothing is asked of the owner', h.ownerAction === null);

section('H2  THE BUG: starting on time and never succeeding is NOT healthy');
h = workerHealth(w({ lastSuccessAt: null }), { now: NOW });
check('it is BLOCKED, not ok', h.health === HEALTH.BLOCKED, JSON.stringify(h));
check('and says it starts but does not finish', /starts on schedule.*never recorded a success/i.test(h.why), h.why);
check('with something for the owner to do', !!h.ownerAction, h.ownerAction);

section('H2b  …and a success that has gone stale is blocked too');
h = workerHealth(w({ lastSuccessAt: NOW - 60 * MIN }), { now: NOW });
check('still starting, nothing succeeding for an hour', h.health === HEALTH.BLOCKED, JSON.stringify(h));
check('the reason gives the real duration', /60 minutes/.test(h.why), h.why);

check('a success one cycle old is fine', workerHealth(w({ lastSuccessAt: NOW - 11 * MIN }), { now: NOW }).health === HEALTH.HEALTHY);
check(`the tolerance is ${SUCCESS_TOLERANCE_CYCLES} cycles, not a fixed number of minutes`,
  SUCCESS_TOLERANCE_CYCLES === 3,
  'a daily worker and a ten-minute worker must be judged on their own schedule');

// ---------------------------------------------------------------------------
section('H3  late means the attempts themselves stopped');
h = workerHealth(w({ lastAttemptAt: NOW - 90 * MIN, lastSuccessAt: NOW - 90 * MIN }), { now: NOW });
check('it is late', h.health === HEALTH.LATE, JSON.stringify(h));
check('and points at the scheduler, not at the work', /GitHub Actions/.test(h.ownerAction || ''), h.ownerAction);

section('H4  never-ran is a fact about the record, not proof of breakage');
h = workerHealth(w({ lastAttemptAt: null, lastSuccessAt: null }), { now: NOW });
check('it is never-ran', h.health === HEALTH.NEVER, JSON.stringify(h));
check('and says what may simply not be set up', /may not be set up yet/.test(h.why), h.why);
check('with the thing to check', /GitHub Actions/.test(h.ownerAction || ''), h.ownerAction);

section('H5  an unreadable record is never an all-clear');
h = workerHealth(w({ lastAttemptAt: undefined }), { now: NOW });
check('it is unknown', h.health === HEALTH.UNKNOWN, JSON.stringify(h));
check('and says so rather than implying it runs', /not a report that it is running/.test(h.why), h.why);

section('H5b  no outcome telemetry at all is unknown, never healthy');
h = workerHealth({ ...w(), lastSuccessAt: undefined }, { now: NOW });
check('it is unknown, not healthy', h.health === HEALTH.UNKNOWN, JSON.stringify(h));
check('and explains that a timestamp proves it began', /proves it began, not that it worked/.test(h.why), h.why);
check('flagged so the view can show it separately', h.noTelemetry === true);

// ---------------------------------------------------------------------------
section('H6  a NAMED blocker outranks a timing problem');
// A missing credential is not "late", and calling it late sends the owner to
// look at the scheduler instead of at the thing that is actually missing.
h = workerHealth(w({ lastAttemptAt: NOW - 90 * MIN }), {
  now: NOW,
  blocker: { code: 'no-github-token', text: 'GITHUB_TOKEN is not set.', ownerAction: 'Set GITHUB_TOKEN in Vercel.' },
});
check('it is blocked, not late', h.health === HEALTH.BLOCKED, JSON.stringify(h));
check('the reason is the named one', /GITHUB_TOKEN is not set/.test(h.why), h.why);
check('and the action is the named one', /Set GITHUB_TOKEN in Vercel/.test(h.ownerAction), h.ownerAction);
check('the code is kept for grouping', h.blockerCode === 'no-github-token');

check('blocked outranks late in the ordering', HEALTH_RANK[HEALTH.BLOCKED] < HEALTH_RANK[HEALTH.LATE]);
check('and healthy is last, so the worst thing leads', HEALTH_RANK[HEALTH.HEALTHY] === 4);
check('every state has a plain word', Object.values(HEALTH).every((s) => !!HEALTH_WORD[s]));

// ---------------------------------------------------------------------------
section('H7  the one answer: needs you / running / blocked / what unblocks it');
const ans = answerFor([
  w({ id: 'a', label: 'Revision inbox' }),
  w({ id: 'b', label: 'Daily pass', lastSuccessAt: null }),
  w({ id: 'c', label: 'Site improvements', lastAttemptAt: null, lastSuccessAt: null }),
  w({ id: 'd', label: 'Outreach queue', lastSuccessAt: undefined }),
], { now: NOW });
check('it counts what is running', ans.running === 1, String(ans.running));
check('and what is blocked, including never-run', ans.blocked === 2, String(ans.blocked));
check('and how many things need a person', ans.needsYou === 2, String(ans.needsYou));
check('each action names why it is needed', ans.actions.every((a) => !!a.because), JSON.stringify(ans.actions));
check('the headline is a sentence, not a number', /need you/.test(ans.headline), ans.headline);
check('a worker with no telemetry is counted separately, not as running',
  ans.counts.unknown === 1 && ans.running === 1, JSON.stringify(ans.counts));

section('H7b  three workers blocked by ONE cause is one thing to do');
const shared = { code: 'no-token', text: 'GITHUB_TOKEN is not set.', ownerAction: 'Set GITHUB_TOKEN in Vercel.' };
const dedup = answerFor(
  [w({ id: 'a' }), w({ id: 'b' }), w({ id: 'c' })],
  { now: NOW, blockers: [{ worker: 'a', ...shared }, { worker: 'b', ...shared }, { worker: 'c', ...shared }] },
);
check('all three are blocked', dedup.counts.blocked === 3, JSON.stringify(dedup.counts));
check('BUT THE OWNER IS ASKED FOR ONE THING', dedup.actions.length === 1, JSON.stringify(dedup.actions));
check('and it is the real action', /Set GITHUB_TOKEN/.test(dedup.actions[0].action), dedup.actions[0].action);

section('H7c  a pause stays a pause');
const paused = answerFor([w(), w({ id: 'b' })], { now: NOW, paused: true });
check('nothing counts as running while paused', paused.running === 0, String(paused.running));
check('and the headline says so', /paused/i.test(paused.headline), paused.headline);

section('H7d  NEGATIVE CONTROL: all good says all good, with no false all-clear');
const good = answerFor([w(), w({ id: 'b' })], { now: NOW });
check('nothing needs the owner', good.needsYou === 0 && good.actions.length === 0, JSON.stringify(good.actions));
check('and it says everything is running', /Everything is running/.test(good.headline), good.headline);
const partial = answerFor([w(), w({ id: 'b', lastSuccessAt: undefined })], { now: NOW });
check('but one silent worker prevents a full all-clear',
  /not a full all-clear/.test(partial.headline), partial.headline);

// ---------------------------------------------------------------------------
section('H8  the screen shows it');
let html = renderAnswer(ans);
check('the four figures are rendered', /need you/.test(html) && /running/.test(html) && /blocked/.test(html), html.slice(0, 200));
check('the actions are listed, not just counted', /Check that GitHub Actions is configured/.test(html), html.slice(0, 400));
check('and the silent worker is explained rather than hidden',
  /proves it started, not that it achieved anything/.test(html));
check('nothing renders without data', renderAnswer(null) === '');

// ---------------------------------------------------------------------------
section('H9  it reaches the real endpoint');
const api = await startLocalApi();
const live = await api.request('/api/admin?do=automation-status');
check('automation-status answers', live.status === 200, `${live.status}`);
check('and now carries the health answer', !!live.json?.automation?.health,
  Object.keys(live.json?.automation || {}).join(','));
const lh = live.json.automation.health;
check('with counts', !!lh.counts, JSON.stringify(lh.counts));
check('a headline', typeof lh.headline === 'string' && lh.headline.length > 5, lh.headline);
check('and the per-worker rows', Array.isArray(lh.rows) && lh.rows.length > 0, String(lh.rows?.length));
check('every row states a health and a reason', lh.rows.every((x) => !!x.health && !!x.why),
  JSON.stringify(lh.rows[0] || {}).slice(0, 160));
check('the old `status` field still exists, so nothing reading it broke',
  !!live.json.automation.workers?.[0]?.status, JSON.stringify(live.json.automation.workers?.[0]?.status));

await api.stop();
done();
