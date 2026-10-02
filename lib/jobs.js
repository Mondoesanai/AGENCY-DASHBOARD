// R11.1–R11.4 — durable background work.
//
// The constraint that shapes this: there is no long-lived worker process. Vercel
// functions are killed at 60s (300s on the admin function), deploys replace them
// mid-run, and the "scheduler" is three unreliable triggers — a daily Vercel
// cron, a GitHub Actions schedule that in practice fires every few HOURS rather
// than every ten minutes, and a rate-limited public poke.
//
// So durability cannot mean "the worker keeps going". It has to mean: every unit
// of work is a record in KV that survives the process dying, and any tick can
// pick up where the last one was killed.
//
//   LEASE        a worker claims a job for a bounded time, not forever. A
//                process that dies mid-job loses nothing — the lease expires
//                and the next tick reclaims it.
//   IDEMPOTENCY  a job declares a key; the same key cannot run twice to a
//                successful result. This is what makes "retry after a crash"
//                safe when the crash happened AFTER the side effect.
//   RETRIES      bounded, with backoff, and a dead-letter at the end rather
//                than infinite retrying or silent disappearance.
//   RECOVERY     a stale lease is visible and reclaimable, and the dead letter
//                is a queue a person can inspect and replay — not a bin.

import { store } from './store.js';

const JOB = (id) => `job:${id}`;
const QUEUE = 'jobs:queue';
const DEAD = 'jobs:dead';
const IDEM = (key) => `job:idem:${key}`;

export const JOB_STATE = Object.freeze({
  QUEUED: 'queued',
  LEASED: 'leased',
  DONE: 'done',
  FAILED: 'failed',
  DEAD: 'dead',
});

export const DEFAULTS = Object.freeze({
  leaseMs: 5 * 60 * 1000, // longer than any single function invocation
  maxAttempts: 5,
  baseBackoffMs: 60 * 1000,
  maxBackoffMs: 6 * 60 * 60 * 1000,
});

export function backoffFor(attempt, { baseBackoffMs = DEFAULTS.baseBackoffMs, maxBackoffMs = DEFAULTS.maxBackoffMs } = {}) {
  return Math.min(baseBackoffMs * Math.pow(2, Math.max(0, attempt - 1)), maxBackoffMs);
}

let seq = 0;
function newId() {
  seq = (seq + 1) % 1e6;
  return `${Date.now()}-${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Put work on the queue.
 *
 * `idempotencyKey` is the contract: enqueueing the same key twice returns the
 * existing job rather than a second one. Without it a tick that is retried
 * after a timeout would duplicate every job it had already created.
 */
export async function enqueue({ type, payload = {}, idempotencyKey = null, runAt = Date.now(), maxAttempts = DEFAULTS.maxAttempts }) {
  if (!type) return { ok: false, reason: 'a job needs a type' };

  if (idempotencyKey) {
    const existing = await store.get(IDEM(idempotencyKey)).catch(() => null);
    if (existing) {
      const job = await getJob(existing);
      return { ok: true, duplicate: true, job, note: 'a job with this idempotency key already exists' };
    }
  }

  const job = {
    id: newId(),
    type,
    payload,
    idempotencyKey,
    state: JOB_STATE.QUEUED,
    attempts: 0,
    maxAttempts,
    runAt,
    createdAt: Date.now(),
    lease: null,
    history: [],
  };
  await putJob(job);
  await store.sadd(QUEUE, job.id);
  if (idempotencyKey) await store.set(IDEM(idempotencyKey), job.id);
  return { ok: true, job };
}

/**
 * Claim one due job for a bounded time.
 *
 * The lease is the whole mechanism: it is a timestamp, not a flag, so a worker
 * that is killed does not hold the job forever. Nothing has to detect the death.
 */
export async function claim({ worker = 'tick', now = Date.now(), leaseMs = DEFAULTS.leaseMs, types = null } = {}) {
  const ids = await store.smembers(QUEUE).catch(() => []);
  for (const id of ids) {
    const job = await getJob(id);
    if (!job) { await store.srem(QUEUE, id); continue; }
    if (job.state === JOB_STATE.DONE || job.state === JOB_STATE.DEAD) { await store.srem(QUEUE, id); continue; }
    if (types && !types.includes(job.type)) continue;
    if (Number(job.runAt || 0) > now) continue;

    // a live lease belongs to someone else; an expired one is free to take
    if (job.lease && Number(job.lease.until) > now) continue;

    // R12.4 — THE LEASE IS TAKEN ATOMICALLY.
    //
    // Reading "no live lease" and then writing one is correct for one worker
    // and wrong for two. This system genuinely has several: the GitHub
    // Actions tick, the Vercel cron and the dashboard's public poke can all
    // run at once, by design, because no single scheduler here is reliable.
    // Measured before this: ten workers claiming from one queue were handed
    // the SAME job, every time — which for a send queue means one prospect
    // receiving the same message ten times.
    //
    // The token is the job's CLAIM EPOCH, which only ever advances and only on
    // a successful claim. Workers racing each other all read the same epoch, so
    // exactly one can win it; once a claim succeeds the epoch moves on, so the
    // job can legitimately be claimed again later — after its lease expires, or
    // after a deferral put it back in the queue.
    //
    // It deliberately is NOT derived from `attempts` or from the lease expiry:
    // the outage path gives an attempt back, so an attempts-based token repeats
    // and would permanently block a job from ever being claimed again.
    const epoch = Number(job.claimEpoch || 0);
    const won = await store.claimOnce(`job:lease:${id}:${epoch}`, { ttlSec: Math.ceil(leaseMs / 1000) * 4, now })
      .catch(() => ({ won: false }));
    if (!won.won) continue; // another worker took this one; try the next job

    const reclaimed = !!job.lease;
    job.state = JOB_STATE.LEASED;
    job.lease = { worker, until: now + leaseMs, takenAt: now };
    job.claimEpoch = epoch + 1;
    job.attempts += 1;
    job.history = [...(job.history || []), { at: now, event: reclaimed ? 'lease-reclaimed' : 'leased', worker }].slice(-20);
    await putJob(job);
    return { ok: true, job, reclaimed };
  }
  return { ok: true, job: null, note: 'nothing due' };
}

/** Mark a leased job finished. Idempotent: completing twice is harmless. */
export async function complete(jobId, result = null, { now = Date.now() } = {}) {
  const job = await getJob(jobId);
  if (!job) return { ok: false, reason: 'unknown job' };
  if (job.state === JOB_STATE.DONE) return { ok: true, alreadyDone: true, job };
  job.state = JOB_STATE.DONE;
  job.lease = null;
  job.result = result;
  job.completedAt = now;
  job.history = [...(job.history || []), { at: now, event: 'done' }].slice(-20);
  await putJob(job);
  await store.srem(QUEUE, jobId);
  return { ok: true, job };
}

/**
 * Report a failure. Retries with backoff until the attempt budget is gone, then
 * the job goes to the dead letter — visible and replayable, never discarded.
 */
/**
 * How many times an outage may give an attempt back before the job is treated
 * as failing normally again.
 *
 * "Give the attempt back" must not mean "forever". A provider that 500s
 * permanently would otherwise be retried for ever, the queue would never
 * report a problem, and the work would sit there looking healthy — which is
 * worse than a dead job, because a dead job is visible.
 */
export const MAX_OUTAGE_DEFERRALS = 8;

export async function fail(jobId, reason, { now = Date.now(), permanent = false, rateLimited = false, outage = false, retryAfterSec = null } = {}) {
  const job = await getJob(jobId);
  if (!job) return { ok: false, reason: 'unknown job' };

  job.lastError = String(reason || 'unknown').slice(0, 400);
  job.lease = null;

  // R11.6 — being rate limited is NOT the job failing.
  //
  // The provider is saying "not right now", which says nothing about whether
  // this work can succeed. Counting it against the attempt budget would retire
  // perfectly good jobs during a busy hour — five 429s and the work is dead.
  // So the attempt is given back and the wait comes from Retry-After when the
  // provider supplied one, since the provider knows better than our backoff.
  if (rateLimited) {
    job.attempts = Math.max(0, job.attempts - 1);
    const wait = retryAfterSec != null ? Math.max(1000, Number(retryAfterSec) * 1000) : backoffFor(job.attempts + 1);
    job.state = JOB_STATE.QUEUED;
    job.runAt = now + wait;
    job.rateLimitedCount = (job.rateLimitedCount || 0) + 1;
    job.history = [...(job.history || []), { at: now, event: 'rate-limited', waitMs: wait, honouredRetryAfter: retryAfterSec != null }].slice(-20);
    await putJob(job);
    return { ok: true, rateLimited: true, retryIn: wait, honouredRetryAfter: retryAfterSec != null, attemptsUnchanged: job.attempts, job };
  }

  // R12.3 — a provider OUTAGE is not this job failing either, and it is the
  // same argument as the rate limit above: a 503 says nothing about whether
  // this work can succeed, so counting it against the attempt budget retires
  // good jobs during exactly the window where losing them hurts most. The
  // difference is that an outage carries no Retry-After, so the wait comes
  // from backoff — and it is capped, because a provider that is permanently
  // broken must eventually produce a dead job rather than an invisible one.
  if (outage && (job.outageCount || 0) < MAX_OUTAGE_DEFERRALS) {
    job.attempts = Math.max(0, job.attempts - 1);
    const wait = backoffFor((job.outageCount || 0) + 1);
    job.state = JOB_STATE.QUEUED;
    job.runAt = now + wait;
    job.outageCount = (job.outageCount || 0) + 1;
    job.history = [...(job.history || []), { at: now, event: 'provider-outage', waitMs: wait, deferral: job.outageCount }].slice(-20);
    await putJob(job);
    return { ok: true, outage: true, retryIn: wait, deferral: job.outageCount, of: MAX_OUTAGE_DEFERRALS, attemptsUnchanged: job.attempts, job };
  }

  const exhausted = permanent || job.attempts >= job.maxAttempts;
  if (exhausted) {
    job.state = JOB_STATE.DEAD;
    job.deadAt = now;
    job.deadReason = permanent ? `permanent failure: ${job.lastError}` : `gave up after ${job.attempts} attempts: ${job.lastError}`;
    job.history = [...(job.history || []), { at: now, event: 'dead', reason: job.deadReason }].slice(-20);
    await putJob(job);
    await store.srem(QUEUE, jobId);
    await store.sadd(DEAD, jobId);
    return { ok: true, dead: true, job };
  }

  const wait = backoffFor(job.attempts);
  job.state = JOB_STATE.QUEUED;
  job.runAt = now + wait;
  job.history = [...(job.history || []), { at: now, event: 'retry', in: wait, reason: job.lastError }].slice(-20);
  await putJob(job);
  return { ok: true, retryIn: wait, attempt: job.attempts, of: job.maxAttempts, job };
}

/**
 * Turn a provider adapter's result into the right kind of throw.
 *
 * Every adapter in this codebase returns `{ok:false, status, transient,
 * retryAfter}` rather than throwing, which is right for a caller that wants to
 * branch — but the job system needs the distinction to survive as an exception.
 * Without this bridge the queue's rate-limit handling is half a feature: the
 * plumbing exists and nothing ever triggers it.
 */
export function throwFromProviderResult(res, { what = 'provider call' } = {}) {
  if (!res || res.ok) return res;

  const status = Number(res.status) || 0;
  const isRateLimit = status === 429 || res.rateLimited === true || /rate.?limit|too many requests/i.test(res.error || '');

  const err = new Error(`${what} failed: ${res.error || `HTTP ${status}`}`);
  if (isRateLimit) {
    err.rateLimited = true;
    // adapters expose this as `retryAfter` in SECONDS
    if (res.retryAfter != null) err.retryAfterSec = Number(res.retryAfter);
  } else if (status === 401 || status === 403 || status === 404) {
    // credentials, permission and "it does not exist" do not improve by waiting
    err.permanent = true;
  } else if (status >= 500 || status === 408 || res.transient === true) {
    // R12.3 — the provider is broken or unreachable, which is not this job
    // being wrong. Treated like a rate limit: the attempt is given back, up to
    // a cap.
    err.outage = true;
  } else if (status === 400 || status === 422) {
    // our request is malformed. Retrying an identical malformed request three
    // times is pointless, and the attempt budget is better spent elsewhere.
    err.permanent = true;
  }
  throw err;
}

/**
 * Run one job end to end with every guard in place.
 *
 * The idempotency check happens AFTER the claim and BEFORE the handler, because
 * the dangerous case is a crash between a side effect and the completion write:
 * the retry must not repeat the side effect.
 */
export async function runOne({ handlers, worker = 'tick', now = Date.now(), types = null, leaseMs = DEFAULTS.leaseMs } = {}) {
  const c = await claim({ worker, now, types, leaseMs });
  if (!c.job) return { ran: false, note: c.note };
  const job = c.job;

  const handler = handlers?.[job.type];
  if (typeof handler !== 'function') {
    await fail(job.id, `no handler registered for job type "${job.type}"`, { now, permanent: true });
    // `handled: true` matters. This used to return ran:false, which drain() read
    // as "nothing due" and broke its loop — so ONE job with an unregistered type
    // silently stopped the queue being drained for every job behind it.
    return { ran: false, handled: true, jobId: job.id, dead: true, failed: true, reason: 'no handler' };
  }

  // Did a previous attempt already complete the side effect?
  if (job.idempotencyKey) {
    const doneMark = await store.get(`job:done:${job.idempotencyKey}`).catch(() => null);
    if (doneMark) {
      await complete(job.id, { skipped: 'the side effect was already performed by an earlier attempt' }, { now });
      return { ran: false, jobId: job.id, skippedAsAlreadyDone: true };
    }
  }

  try {
    const result = await handler(job.payload, job);
    // mark the side effect BEFORE completing, so a crash here still prevents a repeat
    if (job.idempotencyKey) await store.set(`job:done:${job.idempotencyKey}`, String(now));
    await complete(job.id, result ?? null, { now });
    return { ran: true, jobId: job.id, result };
  } catch (e) {
    // A handler signals rate limiting by throwing an error carrying
    // `rateLimited` (and optionally `retryAfterSec`), so the distinction
    // survives the throw rather than being guessed from a message string.
    const f = await fail(job.id, e?.message || String(e), {
      now,
      permanent: !!e?.permanent,
      rateLimited: !!e?.rateLimited,
      outage: !!e?.outage,
      retryAfterSec: e?.retryAfterSec ?? null,
    });
    return {
      ran: true,
      jobId: job.id,
      // a 429 and a provider outage are both deferrals, not this job failing
      failed: !f.rateLimited && !f.outage,
      deferred: !!f.rateLimited || !!f.outage,
      outage: !!f.outage,
      dead: !!f.dead,
      retryIn: f.retryIn,
    };
  }
}

/** A bounded sweep for one tick. */
export async function drain({ handlers, max = 5, worker = 'tick', now = Date.now(), types = null } = {}) {
  const out = { ran: 0, failed: 0, dead: 0, skipped: 0, deferred: 0 };
  for (let i = 0; i < max; i++) {
    const r = await runOne({ handlers, worker, now, types });
    // Stop only when there is genuinely nothing due. A job that was CLAIMED and
    // then failed — including one with no registered handler — has been handled
    // and must not end the sweep, or one bad job type blocks the whole queue.
    const didSomething = r.ran || r.handled || r.skippedAsAlreadyDone;
    if (!didSomething) break;
    if (r.skippedAsAlreadyDone) out.skipped++;
    else if (r.deferred) {
      out.deferred++;
      // The provider just told us to slow down. Carrying on through the queue
      // would hit the same limit with the next job and burn the whole sweep.
      break;
    } else if (r.failed) { out.failed++; if (r.dead) out.dead++; }
    else out.ran++;
  }
  return out;
}

// --- inspection and recovery ------------------------------------------------

export async function getJob(id) {
  const raw = await store.get(JOB(id)).catch(() => null);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

async function putJob(job) {
  await store.set(JOB(job.id), JSON.stringify(job));
  return job;
}

export async function listQueue({ limit = 100 } = {}) {
  const ids = await store.smembers(QUEUE).catch(() => []);
  const out = [];
  for (const id of ids.slice(0, limit)) {
    const j = await getJob(id);
    if (j) out.push(j);
  }
  return out.sort((a, b) => (a.runAt || 0) - (b.runAt || 0));
}

export async function listDeadLetter({ limit = 100 } = {}) {
  const ids = await store.smembers(DEAD).catch(() => []);
  const out = [];
  for (const id of ids.slice(0, limit)) {
    const j = await getJob(id);
    if (j) out.push(j);
  }
  return out.sort((a, b) => (b.deadAt || 0) - (a.deadAt || 0));
}

/** Put a dead job back on the queue, deliberately, with its attempts reset. */
export async function replayDead(jobId, { now = Date.now(), by = 'owner' } = {}) {
  const job = await getJob(jobId);
  if (!job) return { ok: false, reason: 'unknown job' };
  if (job.state !== JOB_STATE.DEAD) return { ok: false, reason: `this job is ${job.state}, not dead` };

  // Replaying clears the idempotency mark on purpose: the owner is saying the
  // side effect did NOT happen. That is a judgement only a person can make.
  if (job.idempotencyKey) await store.set(`job:done:${job.idempotencyKey}`, '', { ex: 1 }).catch(() => {});

  job.state = JOB_STATE.QUEUED;
  job.attempts = 0;
  job.runAt = now;
  job.lease = null;
  job.replayedBy = by;
  job.history = [...(job.history || []), { at: now, event: 'replayed', by }].slice(-20);
  await putJob(job);
  await store.srem(DEAD, jobId);
  await store.sadd(QUEUE, jobId);
  return { ok: true, job };
}

/** What a person needs to see to trust that background work is alive. */
export async function queueHealth({ now = Date.now() } = {}) {
  const queued = await listQueue({ limit: 500 });
  const dead = await listDeadLetter({ limit: 500 });
  const stale = queued.filter((j) => j.lease && Number(j.lease.until) <= now);
  return {
    queued: queued.filter((j) => j.state === JOB_STATE.QUEUED).length,
    leased: queued.filter((j) => j.state === JOB_STATE.LEASED && j.lease && Number(j.lease.until) > now).length,
    staleLeases: stale.length,
    dead: dead.length,
    oldestDueAt: queued.length ? Math.min(...queued.map((j) => j.runAt || 0)) : null,
    note: stale.length
      ? `${stale.length} job(s) were left mid-run by a worker that stopped. They are reclaimable and the next tick will pick them up — nothing is lost.`
      : 'No stranded work.',
  };
}
