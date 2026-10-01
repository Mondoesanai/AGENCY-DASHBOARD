// R11.1–R11.4 — durable jobs, leases, idempotency, dead letter.
//
// The scenario that matters is a worker dying mid-job. There is no long-lived
// process here: Vercel kills functions at 60s and deploys replace them mid-run.
// So these checks simulate death by simply never completing a claimed job, and
// then assert the work is recovered rather than lost or repeated.
import { check, section, done } from './world.mjs';
import {
  JOB_STATE, DEFAULTS, backoffFor, enqueue, claim, complete, fail, runOne,
  drain, getJob, listQueue, listDeadLetter, replayDead, queueHealth,
} from '../lib/jobs.js';

const MIN = 60000;

// ---------------------------------------------------------------------------
section('J1  work survives the process that created it');
let e = await enqueue({ type: 'send-email', payload: { to: 'a@b.test' } });
check('a job is created', e.ok === true && e.job.state === JOB_STATE.QUEUED, JSON.stringify(e).slice(0, 140));
check('it is persisted, not held in memory', (await getJob(e.job.id)).id === e.job.id);
check('it starts with no attempts', e.job.attempts === 0);
check('a job without a type is refused', (await enqueue({})).ok === false);

// ---------------------------------------------------------------------------
section('J2  the same idempotency key cannot create two jobs');
const k = 'send:campaign-1:contact-1:step-0';
const first = await enqueue({ type: 'send-email', payload: { x: 1 }, idempotencyKey: k });
const second = await enqueue({ type: 'send-email', payload: { x: 1 }, idempotencyKey: k });
check('the second is recognised as a duplicate', second.duplicate === true, JSON.stringify(second));
check('and returns the SAME job', second.job.id === first.job.id);
check('so a retried tick does not double the queue', (await listQueue()).filter((j) => j.idempotencyKey === k).length === 1);

// ---------------------------------------------------------------------------
section('J3  a lease is a deadline, not a lock — a dead worker loses nothing');
const t0 = Date.now();
let c = await claim({ worker: 'worker-A', now: t0, types: ['send-email'] });
check('a worker claims a due job', c.job !== null, JSON.stringify(c).slice(0, 120));
check('the job is leased', c.job.state === JOB_STATE.LEASED);
check('the lease names the worker', c.job.lease.worker === 'worker-A');
check('and has an expiry', c.job.lease.until > t0);
check('claiming counts an attempt', c.job.attempts === 1);

// worker-A dies here. It never completes, never fails.
let c2 = await claim({ worker: 'worker-B', now: t0 + 1000, types: ['send-email'] });
check('a second worker cannot steal a LIVE lease', c2.job?.id !== c.job.id, JSON.stringify(c2?.job?.id));

// the lease expires
c2 = await claim({ worker: 'worker-B', now: t0 + DEFAULTS.leaseMs + 1000, types: ['send-email'] });
check('once the lease expires the job is reclaimable', c2.job?.id === c.job.id, JSON.stringify(c2).slice(0, 140));
check('and it is marked as a reclaim, not a fresh start', c2.reclaimed === true);
check('the attempt count carries over', c2.job.attempts === 2);
check('the history records the reclaim', c2.job.history.some((h) => h.event === 'lease-reclaimed'));

// ---------------------------------------------------------------------------
section('J4  retries back off, then go to the dead letter — never silence');
const r = await enqueue({ type: 'flaky', payload: {}, maxAttempts: 3 });
const id = r.job.id;
check('backoff grows', backoffFor(1) < backoffFor(2) && backoffFor(2) < backoffFor(3));
check('and is capped', backoffFor(99) === DEFAULTS.maxBackoffMs, String(backoffFor(99)));

let now = Date.now();
await claim({ worker: 'w', now, types: ['flaky'] });
let f = await fail(id, 'provider timeout', { now });
check('the first failure schedules a retry', f.retryIn > 0 && !f.dead, JSON.stringify(f).slice(0, 140));
check('it says which attempt it was', f.attempt === 1 && f.of === 3);
check('and the job goes back to queued, not lost', (await getJob(id)).state === JOB_STATE.QUEUED);
check('with a future runAt so it is not picked up instantly', (await getJob(id)).runAt > now);

now += f.retryIn + 1;
await claim({ worker: 'w', now, types: ['flaky'] });
f = await fail(id, 'provider timeout again', { now });
check('the second failure backs off further', f.retryIn > 0 && !f.dead);

now += f.retryIn + 1;
await claim({ worker: 'w', now, types: ['flaky'] });
f = await fail(id, 'still failing', { now });
check('the third exhausts the budget', f.dead === true, JSON.stringify(f).slice(0, 140));
const deadJob = await getJob(id);
check('the job is DEAD, not deleted', deadJob.state === JOB_STATE.DEAD);
check('it records why it gave up', /gave up after 3 attempts/.test(deadJob.deadReason), deadJob.deadReason);
check('it keeps the last error', /still failing/.test(deadJob.lastError));
check('it is off the live queue', !(await listQueue()).some((j) => j.id === id));
check('and it is in the dead letter, where a person can see it', (await listDeadLetter()).some((j) => j.id === id));

// a permanent failure skips the retries entirely
const perm = await enqueue({ type: 'flaky', payload: {} });
await claim({ worker: 'w', now, types: ['flaky'] });
f = await fail(perm.job.id, 'the repository does not exist', { now, permanent: true });
check('a permanent failure dies on the first attempt', f.dead === true);
check('and says it was permanent', /permanent failure/.test((await getJob(perm.job.id)).deadReason));

// ---------------------------------------------------------------------------
section('J5  the dangerous crash: AFTER the side effect, BEFORE completion');
let sideEffects = 0;
const handlers = {
  'charge-once': async () => { sideEffects++; return { charged: true }; },
  'always-throws': async () => { throw new Error('boom'); },
};
const key = 'charge:order-99';
await enqueue({ type: 'charge-once', payload: {}, idempotencyKey: key });
let run = await runOne({ handlers, now: Date.now(), types: ['charge-once'] });
check('the job runs', run.ran === true, JSON.stringify(run));
check('the side effect happened once', sideEffects === 1, String(sideEffects));

// simulate the crash: the same work is enqueued again under the same key
const again = await enqueue({ type: 'charge-once', payload: {}, idempotencyKey: key });
check('re-enqueueing the same key returns the finished job', again.duplicate === true);
check('the side effect was NOT repeated', sideEffects === 1, String(sideEffects));

// and a genuinely new job with the same key, forced onto the queue, is skipped
const forced = await enqueue({ type: 'charge-once', payload: {}, idempotencyKey: 'charge:order-99-forced' });
await (await import('../lib/store.js')).store.set('job:done:charge:order-99-forced', String(Date.now()));
run = await runOne({ handlers, now: Date.now(), types: ['charge-once'] });
check('a job whose side effect already happened is skipped, not rerun', run.skippedAsAlreadyDone === true, JSON.stringify(run));
check('the side effect still happened only once', sideEffects === 1, String(sideEffects));
check('and the job is marked done rather than left hanging', (await getJob(forced.job.id)).state === JOB_STATE.DONE);

// ---------------------------------------------------------------------------
section('J6  a handler that throws is caught, not propagated');
await enqueue({ type: 'always-throws', payload: {} });
run = await runOne({ handlers, now: Date.now(), types: ['always-throws'] });
check('the failure is handled', run.failed === true, JSON.stringify(run));
check('and scheduled for retry rather than crashing the tick', run.dead !== true);

// an unregistered type dies immediately rather than retrying forever
await enqueue({ type: 'no-such-handler', payload: {} });
run = await runOne({ handlers, now: Date.now(), types: ['no-such-handler'] });
check('an unhandled job type dies at once', run.dead === true, JSON.stringify(run));
check('rather than retrying something nothing can run', (await listDeadLetter()).some((j) => j.type === 'no-such-handler'));

// REGRESSION: a no-handler job returned ran:false, which drain() read as
// "nothing due" and broke its loop — so one unregistered job type silently
// stopped every job behind it from being drained.
await enqueue({ type: 'no-such-handler', payload: { first: true } });
await enqueue({ type: 'charge-once', payload: { behind: true }, idempotencyKey: 'behind-the-bad-job' });
const blocked = await drain({ handlers, max: 5, now: Date.now(), types: ['no-such-handler', 'charge-once'] });
check('the bad job does not stop the sweep', blocked.dead >= 1 && blocked.ran >= 1, JSON.stringify(blocked));
check('the job queued behind it still ran', sideEffects >= 2, String(sideEffects));

// ---------------------------------------------------------------------------
section('J7  stranded work is visible and recoverable');
await enqueue({ type: 'send-email', payload: { to: 'stranded@x.test' } });
const strandedClaim = await claim({ worker: 'doomed', now: Date.now(), types: ['send-email'] });
check('a job is claimed', !!strandedClaim.job);

// the worker dies; look at the queue some time later
let health = await queueHealth({ now: Date.now() + DEFAULTS.leaseMs + 1000 });
check('the stranded job is reported', health.staleLeases >= 1, JSON.stringify(health));
check('and the note says nothing is lost', /nothing is lost/.test(health.note), health.note);
check('the dead letter is counted separately from stranded work', typeof health.dead === 'number');

// ---------------------------------------------------------------------------
section('J8  a dead job can be replayed, deliberately, by a person');
const replay = await replayDead(id, { by: 'Mondo' });
check('it goes back on the queue', replay.ok === true && replay.job.state === JOB_STATE.QUEUED, JSON.stringify(replay).slice(0, 140));
check('its attempts are reset', replay.job.attempts === 0);
check('it records who replayed it', replay.job.replayedBy === 'Mondo');
check('and it leaves the dead letter', !(await listDeadLetter()).some((j) => j.id === id));
check('replaying a job that is not dead is refused', (await replayDead(id)).ok === false);
check('replaying an unknown job is refused', (await replayDead('nope')).ok === false);

// ---------------------------------------------------------------------------
section('J9  a tick drains a bounded amount and stops');
for (let i = 0; i < 8; i++) await enqueue({ type: 'charge-once', payload: { i }, idempotencyKey: `bulk-${i}` });
const out = await drain({ handlers, max: 3, now: Date.now(), types: ['charge-once'] });
check('it runs at most the cap', out.ran <= 3, JSON.stringify(out));
check('and leaves the rest queued for the next tick', (await listQueue()).some((j) => j.type === 'charge-once'));

// ---------------------------------------------------------------------------
section('J10  the queue is drained by the real tick, not just by tests');
const { runAutoTick, JOB_HANDLERS } = await import('../lib/tick.js');
const { saveProspects, updateProspect } = await import('../lib/discovery.js');

check('the tick exports its handler registry', typeof JOB_HANDLERS === 'object' && JOB_HANDLERS !== null);
check('and registers at least one real job type', Object.keys(JOB_HANDLERS).length >= 1, Object.keys(JOB_HANDLERS).join(','));

await saveProspects([{ sourceId: 'osm:node/9001', name: 'Queue Test Co', website: 'queuetest.test', evidence: {} }]);
await updateProspect('osm-node-9001', { web: { status: 'not-linked-in-listing', observation: 'none', checkedAt: 0 } });

const queued = await enqueue({ type: 'recheck-website', payload: { prospectId: 'osm-node-9001' }, idempotencyKey: 'recheck:9001' });
check('a real job is queued', queued.ok === true);

const bad = await enqueue({ type: 'recheck-website', payload: { prospectId: 'does-not-exist' }, idempotencyKey: 'recheck:ghost' });

const tick = await runAutoTick();
check('the tick reports a jobs phase', tick.jobs !== undefined, JSON.stringify(Object.keys(tick)));
check('and it drained a bounded amount', (tick.jobs.ran + tick.jobs.failed + tick.jobs.skipped) <= 5, JSON.stringify(tick.jobs));

// the tick is bounded, so drive the rest of this job type explicitly — which is
// exactly what the next tick would do
await drain({ handlers: JOB_HANDLERS, max: 10, now: Date.now(), types: ['recheck-website'] });
check('the real recheck job completed through the tick handlers', (await getJob(queued.job.id)).state === JOB_STATE.DONE, (await getJob(queued.job.id)).state);

const badJob = await getJob(bad.job.id);
check('an unknown prospect dies rather than retrying forever', badJob.state === JOB_STATE.DEAD, badJob.state);
check('and says it was permanent', /permanent failure/.test(badJob.deadReason || ''), badJob.deadReason);

// ---------------------------------------------------------------------------
section('J11  R11.6 — a rate limit is a deferral, not a failure');
// The provider saying "not right now" says nothing about whether the work can
// succeed. Counting 429s against the attempt budget would retire perfectly good
// jobs during a busy hour — five of them and the work is dead.
const rl = await enqueue({ type: 'rate-limited-thing', payload: {}, maxAttempts: 3 });
let rlNow = Date.now();
await claim({ worker: 'w', now: rlNow, types: ['rate-limited-thing'] });
check('the claim counted an attempt', (await getJob(rl.job.id)).attempts === 1);

f = await fail(rl.job.id, 'HTTP 429', { now: rlNow, rateLimited: true });
check('it is reported as rate limited, not failed', f.rateLimited === true, JSON.stringify(f).slice(0, 140));
check('THE ATTEMPT IS GIVEN BACK', (await getJob(rl.job.id)).attempts === 0, String((await getJob(rl.job.id)).attempts));
check('the job is requeued, not dead', (await getJob(rl.job.id)).state === JOB_STATE.QUEUED);
check('with a future runAt', (await getJob(rl.job.id)).runAt > rlNow);
check('and the rate limit is counted separately', (await getJob(rl.job.id)).rateLimitedCount === 1);

// many rate limits in a row must never exhaust the budget
for (let i = 0; i < 10; i++) {
  rlNow += 10 * MIN;
  await claim({ worker: 'w', now: rlNow, types: ['rate-limited-thing'] });
  await fail(rl.job.id, 'HTTP 429', { now: rlNow, rateLimited: true });
}
const afterMany = await getJob(rl.job.id);
check('ten rate limits do not kill a 3-attempt job', afterMany.state === JOB_STATE.QUEUED, afterMany.state);
check('attempts are still zero', afterMany.attempts === 0, String(afterMany.attempts));
check('but the rate limits are visible', afterMany.rateLimitedCount === 11, String(afterMany.rateLimitedCount));

// a REAL failure after a rate limit still counts
rlNow += 10 * MIN;
await claim({ worker: 'w', now: rlNow, types: ['rate-limited-thing'] });
f = await fail(rl.job.id, 'genuine error', { now: rlNow });
check('a real failure still consumes an attempt', (await getJob(rl.job.id)).attempts === 1, String((await getJob(rl.job.id)).attempts));
check('and schedules a normal retry', f.retryIn > 0 && !f.rateLimited);

// ---------------------------------------------------------------------------
section('J12  Retry-After is honoured when the provider gives one');
const ra = await enqueue({ type: 'rate-limited-thing', payload: {} });
const raNow = Date.now();
await claim({ worker: 'w', now: raNow, types: ['rate-limited-thing'] });
f = await fail(ra.job.id, 'HTTP 429', { now: raNow, rateLimited: true, retryAfterSec: 120 });
check('the wait comes from Retry-After', f.retryIn === 120000, String(f.retryIn));
check('and it records that the provider was obeyed', f.honouredRetryAfter === true);
check('the runAt reflects it', (await getJob(ra.job.id)).runAt === raNow + 120000);

await claim({ worker: 'w', now: raNow + 200000, types: ['rate-limited-thing'] });
f = await fail(ra.job.id, 'HTTP 429', { now: raNow + 200000, rateLimited: true });
check('with no Retry-After it falls back to our own backoff', f.honouredRetryAfter === false && f.retryIn > 0, JSON.stringify(f).slice(0, 120));

// ---------------------------------------------------------------------------
section('J13  a handler can signal a rate limit, and the sweep stops');
let calls = 0;
const limitHandlers = {
  'rate-limited-thing': async () => {
    calls++;
    const e = new Error('provider says slow down');
    e.rateLimited = true;
    e.retryAfterSec = 30;
    throw e;
  },
};
// three jobs of the same type, all due
for (let i = 0; i < 3; i++) await enqueue({ type: 'rate-limited-thing', payload: { i }, idempotencyKey: `rl-${i}` });
calls = 0;
const sweep = await drain({ handlers: limitHandlers, max: 5, now: Date.now() + 60 * MIN, types: ['rate-limited-thing'] });
check('the sweep stops at the first rate limit', calls === 1, String(calls));
check('and reports it as deferred, not failed', sweep.deferred === 1 && sweep.failed === 0, JSON.stringify(sweep));
check('carrying on would just hit the same limit again', sweep.ran === 0);

done();
