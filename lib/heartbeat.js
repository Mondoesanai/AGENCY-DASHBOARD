// R2.6 — "is the automation running?" answered from real check-ins.
//
// The dashboard's automation tile was a countdown. It ticked down whether or
// not anything was running, so it read as a sign of life when it was really a
// clock. A worker that died at 3am produced exactly the same cheerful tile as
// one that ran a minute ago.
//
// Three rules:
//
//  1. Status is DERIVED from a timestamp a worker wrote when it actually ran.
//     Nothing here is allowed to report "running" because a config flag says
//     automation is enabled.
//  2. Each worker is judged against its OWN schedule. The SEO tick runs on
//     GitHub's free scheduler, which is genuinely bursty — hours between runs
//     is normal there and alarming for the daily pass. One global threshold
//     would cry wolf on one and stay silent on the other.
//  3. A timestamp that cannot be read is UNKNOWN, never "fine" and never
//     "stalled". The difference matters: unknown means go and look.
//
// Pause lives here too, because pause only means something if the workers
// check it. `reserveCost` already refused to spend while paused, but anything
// that does not cost money — the SEO tick, the job queue — ran straight
// through it. `pauseGate()` is what those call.

import { store } from './store.js';

/**
 * The workers that check in, and how often each is genuinely expected to.
 *
 * `every` is the schedule. `stale` is when silence starts to mean something,
 * and it is deliberately far looser than `every` for the tick: GitHub's free
 * scheduler has delivered a "30 minute" job every 4-6 hours in practice, so a
 * two-hour gap there is normal, not a fault.
 */
export const WORKERS = Object.freeze({
  tick: {
    key: 'auto:lastTick',
    label: 'Site improvements',
    what: 'Picks the most overdue client site and runs one improvement cycle.',
    every: 30 * 60e3,
    stale: 9 * 3600e3,
    dead: 24 * 3600e3,
    runBy: 'GitHub Actions (.github/workflows/seo-automation.yml)',
    unit: 'ms',
  },
  daily: {
    key: 'cron:daily:lastRun',
    label: 'Daily pass',
    what: 'Monthly reports, billing emails and the health check.',
    every: 24 * 3600e3,
    stale: 36 * 3600e3,
    dead: 72 * 3600e3,
    runBy: 'Vercel cron (api/cron-daily.js)',
    unit: 'ms',
  },
  revisions: {
    key: 'revisions:lastCheck',
    label: 'Revision inbox',
    what: 'Reads client change requests out of email.',
    every: 15 * 60e3,
    stale: 2 * 3600e3,
    dead: 12 * 3600e3,
    runBy: 'the automation tick',
    // this one was stored in SECONDS by the code that already existed.
    // Reading it as milliseconds would date it to 1970 and report every
    // healthy inbox as dead.
    unit: 's',
  },
  jobs: {
    key: 'jobs:lastDrain',
    label: 'Outreach queue',
    what: 'Works through queued sends, reply ingestion and retries.',
    every: 30 * 60e3,
    stale: 6 * 3600e3,
    dead: 24 * 3600e3,
    runBy: 'the automation tick',
    unit: 'ms',
  },
});

export const BEAT = Object.freeze({
  OK: 'ok',
  SLOW: 'slow',
  STALLED: 'stalled',
  NEVER: 'never',
  UNKNOWN: 'unknown',
  PAUSED: 'paused',
});

const PAUSE_KEY = 'automation:pause';

/** A worker says "I ran". Called at the START of a run, not the end: a run
 *  that crashes half way still proves the scheduler is alive. */
export async function recordBeat(worker, at = Date.now()) {
  const w = WORKERS[worker];
  if (!w) return { ok: false, error: `unknown worker ${worker}` };
  const value = w.unit === 's' ? Math.floor(at / 1000) : at;
  try {
    await store.set(w.key, String(value), { ex: 60 * 60 * 24 * 45 });
    return { ok: true, worker, at };
  } catch (e) {
    // a beat that cannot be written is not fatal to the run itself
    return { ok: false, error: String(e?.message || e) };
  }
}

/**
 * Record what a run actually ACHIEVED, which is a different fact from having
 * started.
 *
 * A check-in timestamp proves a process began. It says nothing about whether
 * the work succeeded, and reading "last ran 3 minutes ago" as "it is working"
 * is exactly the misreading this exists to prevent — especially here, where
 * loading the dashboard pokes the tick, so a fresh timestamp can mean nothing
 * more than "somebody opened the page".
 */
export async function recordOutcome(worker, { ok = true, processed = 0, failed = 0, note = '', at = Date.now() } = {}) {
  const w = WORKERS[worker];
  if (!w) return { ok: false, error: `unknown worker ${worker}` };
  const prev = (await readOutcome(worker)) || {};
  const rec = {
    lastAttemptAt: at,
    lastSuccessAt: ok ? at : (prev.lastSuccessAt || null),
    lastFailureAt: ok ? (prev.lastFailureAt || null) : at,
    lastFailure: ok ? (prev.lastFailure || null) : String(note || 'failed').slice(0, 200),
    processed: Number(prev.processed || 0) + Number(processed || 0),
    failed: Number(prev.failed || 0) + Number(failed || 0),
    lastProcessed: Number(processed || 0),
    runs: Number(prev.runs || 0) + 1,
    note: String(note || '').slice(0, 200),
  };
  try {
    await store.set(`beat:outcome:${worker}`, JSON.stringify(rec), { ex: 60 * 60 * 24 * 45 });
    return { ok: true, outcome: rec };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

/** null = nothing recorded, undefined = could not read. */
export async function readOutcome(worker) {
  if (!WORKERS[worker]) return undefined;
  let raw;
  try {
    raw = await store.get(`beat:outcome:${worker}`);
  } catch {
    return undefined;
  }
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return undefined;
  }
}

/** Read one worker's last check-in. null = never, undefined = could not read. */
export async function readBeat(worker) {
  const w = WORKERS[worker];
  if (!w) return undefined;
  let raw;
  try {
    raw = await store.get(w.key);
  } catch {
    return undefined; // unknown, which is NOT the same as never
  }
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return w.unit === 's' ? n * 1000 : n;
}

/**
 * Turn a last-seen timestamp into a status, judged against that worker's own
 * schedule. Pure, so every boundary below is testable without a store.
 */
export function statusFor(worker, lastAt, { now = Date.now(), paused = false } = {}) {
  const w = WORKERS[worker];
  if (!w) return { status: BEAT.UNKNOWN, text: 'unknown worker' };

  if (lastAt === undefined) {
    return {
      status: BEAT.UNKNOWN,
      ageMs: null,
      text: 'Cannot tell — its last check-in could not be read. This is not a report that it is running.',
    };
  }
  if (lastAt === null || lastAt === 0) {
    return {
      status: BEAT.NEVER,
      ageMs: null,
      text: `Has never checked in. It is run by ${w.runBy}, which may not be set up yet.`,
    };
  }

  const ageMs = Math.max(0, now - lastAt);

  // Paused is reported, but the age is still shown: the owner needs to know
  // both that it is off AND when it last did anything.
  if (paused) {
    return { status: BEAT.PAUSED, ageMs, text: `Paused. Last ran ${ago(ageMs)}; nothing new is being started.` };
  }
  if (ageMs >= w.dead) {
    return { status: BEAT.STALLED, ageMs, text: `Last ran ${ago(ageMs)} — well past its schedule. Check ${w.runBy}.` };
  }
  if (ageMs >= w.stale) {
    return { status: BEAT.SLOW, ageMs, text: `Last ran ${ago(ageMs)}, which is slower than usual but not yet a fault.` };
  }
  return { status: BEAT.OK, ageMs, text: `Last ran ${ago(ageMs)}.` };
}

/** Plain words. "2 minutes ago" beats an ISO string on a status line. */
export function ago(ms) {
  if (ms == null || !Number.isFinite(ms)) return 'at an unknown time';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${Math.max(1, s)} second${s === 1 ? '' : 's'} ago`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? '' : 's'} ago`;
  return `${Math.round(h / 24)} days ago`;
}

// ---------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------

/**
 * Pause state. Stored with who and when, because "why is nothing happening?"
 * is a question the dashboard should be able to answer a week later.
 */
export async function pauseState() {
  let raw;
  try {
    raw = await store.get(PAUSE_KEY);
  } catch {
    // UNKNOWN must not be treated as "not paused" — see pauseGate below.
    return { known: false, paused: false, at: null, by: '', reason: '' };
  }
  if (!raw) return { known: true, paused: false, at: null, by: '', reason: '' };
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { known: true, paused: !!p.paused, at: p.at || null, by: p.by || '', reason: p.reason || '' };
  } catch {
    return { known: false, paused: false, at: null, by: '', reason: '' };
  }
}

export async function setPaused({ paused, by = 'owner', reason = '' } = {}) {
  const rec = { paused: !!paused, at: Date.now(), by: String(by).slice(0, 60), reason: String(reason).slice(0, 200) };
  await store.set(PAUSE_KEY, JSON.stringify(rec));
  return { ok: true, ...rec, known: true };
}

/**
 * What a worker calls before doing anything. Returns `{ run: false }` to stop.
 *
 * Deliberately fails SAFE rather than open: if the pause flag cannot be read,
 * work does NOT start. A pause is something the owner pressed to make the
 * machine stop, and "the store was flaky" is not a good reason to override it.
 * Essential work — answering someone who replied, honouring an opt-out — is
 * exempt, because stopping those causes the harm pausing is meant to avoid.
 */
export async function pauseGate({ essential = false } = {}) {
  const p = await pauseState();
  if (essential) return { run: true, paused: p.paused, essential: true, reason: '' };
  if (!p.known) {
    return { run: false, paused: false, unknown: true, reason: 'could not read whether automation is paused — not starting work' };
  }
  if (p.paused) {
    return { run: false, paused: true, reason: `automation is paused${p.by ? ` (by ${p.by})` : ''}${p.reason ? `: ${p.reason}` : ''}` };
  }
  return { run: true, paused: false, reason: '' };
}

/**
 * Everything the Automation panel needs: every worker's real last check-in,
 * its status against its own schedule, and the pause state.
 */
export async function automationStatus(now = Date.now()) {
  const pause = await pauseState();
  const workers = [];
  for (const [id, w] of Object.entries(WORKERS)) {
    const lastAt = await readBeat(id);
    const st = statusFor(id, lastAt, { now, paused: pause.paused });
    const outcome = await readOutcome(id);
    workers.push({
      id,
      label: w.label,
      what: w.what,
      runBy: w.runBy,
      everyMs: w.every,
      lastAt: lastAt ?? null,
      // An ATTEMPT and a SUCCESS are different facts and are reported
      // separately. "Last ran 3 minutes ago" has repeatedly been read as "it
      // is working"; on this system it can mean nothing more than that
      // somebody loaded the dashboard, because the page pokes the tick.
      lastAttemptAt: lastAt ?? null,
      lastSuccessAt: outcome === undefined ? undefined : (outcome?.lastSuccessAt ?? null),
      lastFailureAt: outcome?.lastFailureAt ?? null,
      lastFailure: outcome?.lastFailure ?? null,
      processed: outcome?.processed ?? null,
      lastProcessed: outcome?.lastProcessed ?? null,
      runsRecorded: outcome?.runs ?? null,
      // when it should next be expected, from its own schedule
      nextDueAt: lastAt ? lastAt + w.every : null,
      // whether we have ANY outcome telemetry for this worker, as opposed to
      // only a check-in. Without this the panel cannot tell "it succeeded" from
      // "nobody has ever recorded whether it succeeded".
      hasOutcomeTelemetry: !!outcome,
      ...st,
    });
  }

  // The headline is the worst thing happening, not an average — an average
  // would let one dead worker hide behind three healthy ones.
  const rank = { [BEAT.STALLED]: 0, [BEAT.NEVER]: 1, [BEAT.UNKNOWN]: 2, [BEAT.SLOW]: 3, [BEAT.PAUSED]: 4, [BEAT.OK]: 5 };
  const worst = workers.slice().sort((a, b) => rank[a.status] - rank[b.status])[0] || null;

  return {
    at: now,
    pause,
    workers,
    worst: worst ? worst.status : BEAT.UNKNOWN,
    anyUnknown: workers.some((w) => w.status === BEAT.UNKNOWN),
    allOk: workers.length > 0 && workers.every((w) => w.status === BEAT.OK),
  };
}
