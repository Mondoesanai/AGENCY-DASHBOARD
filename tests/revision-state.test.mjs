import { check, section, done } from './world.mjs';
import {
  STATES,
  transition,
  classifyReason,
  isDue,
  backoffMs,
  legacyStatus,
  deriveLegacyState,
  explain,
  maxAttemptsFor,
} from '../lib/revision-state.js';

section('R1  REGRESSION (live): a site with no linked repo was retried forever');
// Renewity's real ticket: every tick produced "not eligible yet — no GitHub repo
// set (Settings → Automation)", a new attempt line each time, no failure counted,
// no escalation, no recovery action. It would have done that indefinitely.
let t = { state: STATES.QUEUED, attempts: 0 };
const noRepo = 'no GitHub repo set (Settings → Automation)';
for (let i = 0; i < 5; i++) t = { ...t, ...transition(t, { type: 'ineligible', reason: noRepo }) };
check('it blocks instead of retrying', t.state === STATES.BLOCKED, t.state);
check('it stops being picked up by the worker', isDue(t) === false);
check('it names an action the owner can actually take', t.blockedBy?.action === 'link-repo' && /Link this site/.test(t.blockedBy.label), JSON.stringify(t.blockedBy));
check('it explains that the request is preserved and resumes by itself', /resumes automatically/.test(t.blockedBy.hint));
check('repeated ineligible events do not inflate the attempt count', (t.attempts || 0) === 0, String(t.attempts));
check('the owner is flagged exactly once, not every tick', t.needsOwner === true && typeof t.blockedAt === 'number');

section('R2  pacing and budget are NOT failures — they self-resolve and must stay queued');
for (const reason of [
  'paced — a change just shipped; spreading the work out instead of front-loading it. Next improvement in ~20h',
  'paced — a cycle just ran on this site; next attempt in ~5 min',
  "this month's budget is used ($23.85 / $20)",
  'already running — Reading the repo (started 12s ago)',
]) {
  const before = { state: STATES.QUEUED, attempts: 0 };
  const after = { ...before, ...transition(before, { type: 'ineligible', reason }) };
  check(`"${reason.slice(0, 34)}…" stays queued, no attempt burned`, after.state === STATES.QUEUED && (after.attempts || 0) === 0 && after.needsOwner !== true, after.state);
  check('  …and is still picked up when its window opens', isDue(after) === true);
}

section('R3  permanent integration failures block immediately with the right recovery');
const permanents = [
  ['GITHUB_TOKEN not set in Vercel', 'reconnect-github'],
  ['github 404 /repos/acme/site: Not Found', 'check-repo'],
  ['github 403 /repos/acme/site: Resource not accessible', 'fix-permissions'],
  ['agent turned off for this site', 'enable-agent'],
  ['no Anthropic key for the agent', 'add-ai-key'],
];
for (const [reason, action] of permanents) {
  const r = transition({ state: STATES.QUEUED, attempts: 0 }, { type: 'failed', reason });
  check(`"${reason.slice(0, 32)}…" → blocked, recovery=${action}`, r.state === STATES.BLOCKED && r.blockedBy?.action === action, `${r.state} / ${r.blockedBy?.action}`);
}
check('a permanent failure never schedules a next attempt', !transition({ state: STATES.QUEUED }, { type: 'failed', reason: 'GITHUB_TOKEN not set in Vercel' }).nextAttemptAt);

section('R4  transient failures retry with backoff, then stop');
let tr = { state: STATES.QUEUED, attempts: 0 };
const timeout = 'commit: The operation was aborted due to timeout';
const delays = [];
for (let i = 0; i < maxAttemptsFor('transient'); i++) {
  tr = { ...tr, ...transition(tr, { type: 'failed', reason: timeout, at: 1_000_000 }) };
  if (tr.state === STATES.RETRYABLE) delays.push(tr.nextAttemptAt - 1_000_000);
}
check('retries are bounded, then it blocks', tr.state === STATES.BLOCKED && tr.attempts === maxAttemptsFor('transient'), `${tr.state} after ${tr.attempts}`);
check('each wait is longer than the last (exponential backoff)', delays.every((d, i) => i === 0 || d > delays[i - 1]), JSON.stringify(delays));
check('backoff is capped, not unbounded', backoffMs(99) === backoffMs(50) && backoffMs(99) <= 6 * 60 * 60 * 1000, String(backoffMs(99)));
check('a retryable ticket is not worked before its time', isDue({ state: STATES.RETRYABLE, nextAttemptAt: Date.now() + 60000 }) === false);
check('…and is worked once the wait has passed', isDue({ state: STATES.RETRYABLE, nextAttemptAt: Date.now() - 1 }) === true);
check('the final block explains retries stopped to protect spend', /spending/.test(tr.blockedBy?.hint || ''), tr.blockedBy?.hint);

section('R5  content failures get fewer tries than network blips');
check('content max < transient max', maxAttemptsFor('content') < maxAttemptsFor('transient'));
let cf = { state: STATES.QUEUED, attempts: 0 };
for (let i = 0; i < 3; i++) cf = { ...cf, ...transition(cf, { type: 'failed', reason: 'plan failed safety check — index.html: added text looks like keyword stuffing' }) };
check('three bad plans → blocked, not a fourth paid attempt', cf.state === STATES.BLOCKED && cf.attempts === 3, `${cf.state}/${cf.attempts}`);

section('R6  the happy path, and a shipped change is not called done until it is verified');
let h = { state: STATES.QUEUED, attempts: 2 };
h = { ...h, ...transition(h, { type: 'claim' }) };
check('claimed → running', h.state === STATES.RUNNING);
h = { ...h, ...transition(h, { type: 'shipped' }) };
check('shipped → awaiting review (NOT done)', h.state === STATES.AWAITING_REVIEW && legacyStatus(h.state) === 'needs attention');
check('shipping clears the failure count', h.attempts === 0);
h = { ...h, ...transition(h, { type: 'verified' }) };
check('verified → succeeded', h.state === STATES.SUCCEEDED && legacyStatus(h.state) === 'done' && !!h.doneAt);
check('a finished revision is never shown as failed', explain(h) === 'Done and live.');

section('R7  QA says the live site does not match → owner review, not a silent retry loop');
const rej = transition({ state: STATES.AWAITING_REVIEW }, { type: 'rejected', reason: 'the three quizzes are not on the page' });
check('stays awaiting review and flags the owner', rej.state === STATES.AWAITING_REVIEW && rej.needsOwner === true);
check('it does not get auto-reworked', isDue({ ...rej }) === false);

section('R8  a human retry after fixing the cause gives a clean slate');
const fixed = transition({ state: STATES.BLOCKED, attempts: 5, blockedBy: { action: 'link-repo' }, needsOwner: true }, { type: 'retry' });
check('back to queued with counters cleared', fixed.state === STATES.QUEUED && fixed.attempts === 0 && !fixed.blockedBy && fixed.needsOwner === false);
check('and it is picked up again', isDue({ ...fixed }) === true);

section('R9  old tickets created before this existed still read correctly');
check('done → succeeded', deriveLegacyState({ status: 'done' }) === STATES.SUCCEEDED);
check('cancelled → cancelled', deriveLegacyState({ status: 'cancelled' }) === STATES.CANCELLED);
check('scheduled → queued', deriveLegacyState({ status: 'scheduled' }) === STATES.QUEUED);
check('needs attention + permanent cause → blocked', deriveLegacyState({ status: 'needs attention', lastAttempt: { reason: 'no GitHub repo set (Settings → Automation)' } }) === STATES.BLOCKED);
check('needs attention + failed QA → blocked', deriveLegacyState({ status: 'needs attention', verify: { verified: false, note: 'live page missing the events' } }) === STATES.BLOCKED);
check('an existing state is never overwritten', deriveLegacyState({ state: STATES.RUNNING, status: 'done' }) === STATES.RUNNING);

section('R10  classifier does not mistake a real instruction for a config error');
check('a normal client request is unknown, not permanent', classifyReason('change the hours to 9-5').permanent === false);
check('empty reason is safe', classifyReason('').kind === 'unknown' && classifyReason(null).permanent === false);
check('"not a file edit" blocks with owner review', classifyReason("I can't do this by editing files — it's in a third-party dashboard").recovery?.action === 'owner-review');

done();
