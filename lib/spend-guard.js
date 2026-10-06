// The one boundary every paid discretionary job passes through.
//
// R16.1. `lib/budget.js` had a complete reserve → run → reconcile design and no
// caller, so the limits on the Spending panel were preferences rather than a
// cap. The twelve Anthropic call sites share no chokepoint, so rather than
// hoping each one remembers to check a budget, this module becomes the chokepoint
// and `tests/spend-exempt.test.mjs` fails if a paid path bypasses it.
//
// FOUR THINGS A CAP HAS TO SURVIVE, and each one is a real failure mode rather
// than a hypothetical:
//
//  1. CONCURRENCY. Two workers reading "spent < limit" and then both spending is
//     the classic way to blow a budget. `reserveCost` is an atomic INCR with a
//     headroom bound (`store.reserve`), so whichever request pushes past the cap
//     has its own increment rolled back and is refused. Nothing here reads then
//     writes.
//
//  2. RETRIES. A retried job must not pay twice. Every call carries a `jobId`,
//     and a terminal outcome for that id is final: a second attempt returns the
//     record and **does not run `fn` again**. That matters more than the
//     accounting — re-running is what makes the second charge.
//     Terminal means DONE or UNCERTAIN. A REFUSED job is NOT terminal, because
//     nothing ran and nothing was charged; burning the id there would mean a
//     job refused once could never run again even after the period reset.
//
//  3. ACTUAL COST. An estimate reserves; the provider's real figure settles.
//     `ctx.reportCost(usd)` is how a caller supplies it. Without one the
//     estimate stands, which keeps the ledger conservative rather than flattering.
//
//  4. UNCERTAIN OUTCOMES. A timeout is not a refund. If a request may have
//     reached the provider, the money is booked at the estimate, the job is
//     parked for a person, and the id is burned so no retry re-runs it. The
//     default classification is "uncertain" precisely because the safe
//     assumption is that we were charged. Only errors raised before the request
//     could leave this process are treated as certainly unspent.
//
// WHAT THIS CANNOT DO, stated here and on screen: it caps what the app CHOOSES
// to spend. It cannot cap a provider's direct billing — a subscription, a
// minimum commitment, usage already in flight when a job stops, or a charge that
// posts days later. `uncappableNote()` says so wherever the limits are shown.
//
// ESSENTIAL WORK IS NEVER REFUSED. Inbound replies, opt-outs and monitoring pass
// even with the allowance at zero, and are still recorded so the ledger stays
// truthful. Refusing to process an opt-out for want of budget would be unlawful,
// not merely rude.

import { reserveCost, reconcileCost, releaseCost, CATEGORIES } from './budget.js';
import { store } from './store.js';

/** Terminal states a job id can hold. A job in one of these never re-runs. */
export const JOB = Object.freeze({
  DONE: 'done',
  REFUSED: 'refused',
  RELEASED: 'released',
  UNCERTAIN: 'uncertain',
});

const jobKey = (id) => `spend:job:${id}`;
const JOB_TTL = 60 * 60 * 24 * 14;

/**
 * Did this error happen before the request could possibly have left?
 *
 * Deliberately a SHORT allow-list rather than a long deny-list. Anything not
 * named here is treated as uncertain, because a wrong "certainly unspent" hands
 * back money that was actually charged and lets a retry charge it again, while
 * a wrong "uncertain" only over-books an estimate that reconciliation corrects.
 */
export function certainlyUnspent(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || err);
  if (['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN', 'ERR_INVALID_URL'].includes(code)) return true;
  // Our own pre-flight refusals, thrown before any network call.
  if (err.preflight === true) return true;
  if (/^not connected: /.test(msg)) return true;
  if (/missing (credentials|api key)/i.test(msg)) return true;

  // A provider that answered with a 4xx REJECTED the request and did not bill
  // it: a bad key, a malformed body, an over-rate call. The response proves the
  // request arrived and was not processed, which is as certain as this gets.
  // 408 and 425 are excluded because they describe a request the server may
  // still have been working on. A 5xx stays uncertain — the provider may have
  // done the work and failed to tell us.
  const status = Number(err.status ?? err.statusCode ?? NaN);
  if (Number.isFinite(status) && status >= 400 && status < 500 && status !== 408 && status !== 425) return true;

  return false;
}

async function readJob(jobId) {
  if (!jobId) return null;
  const raw = await store.get(jobKey(jobId)).catch(() => null);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function writeJob(jobId, rec) {
  if (!jobId) return;
  await store.set(jobKey(jobId), JSON.stringify(rec), { ex: JOB_TTL }).catch(() => {});
}

/**
 * Run a paid job inside the budget.
 *
 * Returns `{ ok, refused?, reason, result?, uncertain?, replayed?, cents }`.
 * It does NOT throw on refusal — a refusal is the normal path when the
 * allowance is gone, and a caller that ignores it is the bug this exists to
 * prevent, so the shape makes it awkward to ignore.
 *
 * `fn` receives `{ reportCost, reservationId, jobId }`.
 */
export async function withSpend(opts, fn) {
  const {
    category, estimateUsd, jobId = null,
    essential = false, conversational = false, meta = {},
  } = opts || {};

  if (!CATEGORIES.includes(category)) throw new Error(`unknown cost category: ${category}`);
  if (typeof fn !== 'function') throw new Error('withSpend needs something to run');

  // 2. RETRIES — a job id that already reached a terminal state never re-runs.
  const prior = await readJob(jobId);
  if (prior && prior.state) {
    return {
      ok: prior.state === JOB.DONE,
      replayed: true,
      state: prior.state,
      // Always says it is a replay FIRST. A caller that logs only the reason
      // should still be able to tell "this was refused now" from "this was
      // refused an hour ago and is not being tried again".
      reason: `this job already finished as "${prior.state}"`
        + (prior.reason ? ` — ${prior.reason}` : ''),
      result: prior.result ?? null,
      uncertain: prior.state === JOB.UNCERTAIN,
      cents: prior.cents ?? 0,
    };
  }

  // 1. CONCURRENCY — atomic reserve, or a refusal.
  const res = await reserveCost({ category, estimateUsd, jobId, essential, conversational, meta });
  if (!res.ok) {
    // Deliberately NOT recorded as terminal. A refusal means nothing ran and
    // nothing was charged, so the same job is free to try again next week when
    // there is allowance. Burning the id here would mean a job refused once was
    // refused for ever, which is a worse bug than the one this module fixes.
    return { ok: false, refused: true, reason: res.reason, state: JOB.REFUSED, cents: 0 };
  }

  let actualUsd = null;
  const ctx = {
    reservationId: res.reservationId,
    jobId,
    /** 3. ACTUAL COST — the provider's real figure, when the caller knows it. */
    reportCost(usd) {
      const n = Number(usd);
      if (Number.isFinite(n) && n >= 0) actualUsd = n;
    },
  };

  try {
    const result = await fn(ctx);
    await reconcileCost(res.reservationId, actualUsd == null ? estimateUsd : actualUsd, {
      note: actualUsd == null ? 'settled at the estimate — the caller reported no actual cost' : null,
    });
    await writeJob(jobId, { state: JOB.DONE, at: Date.now(), cents: res.cents });
    return { ok: true, result, state: JOB.DONE, cents: res.cents, estimated: actualUsd == null };
  } catch (err) {
    if (certainlyUnspent(err)) {
      // Nothing left this process, so hand the money straight back. The id is
      // NOT burned: a job that provably did not run is safe to try again.
      await releaseCost(res.reservationId);
      if (jobId) await store.del(jobKey(jobId)).catch(() => {});
      throw err;
    }

    // 4. UNCERTAIN — book it, park it, and burn the id so no retry re-runs it.
    await reconcileCost(res.reservationId, estimateUsd, {
      note: `uncertain outcome: ${String(err && err.message || err).slice(0, 200)}`,
    });
    await writeJob(jobId, {
      state: JOB.UNCERTAIN,
      at: Date.now(),
      cents: res.cents,
      reason: 'the provider\'s response was never seen, so this may or may not have been charged',
    });
    try {
      const { openRepairTask, SEVERITY } = await import('./recovery.js');
      await openRepairTask({
        title: `Uncertain ${category} spend — a person needs to check the provider`,
        severity: SEVERITY.DATA || undefined,
        diagnostics: `job ${jobId || '(no id)'} · reservation ${res.reservationId}\n`
          + `estimated $${Number(estimateUsd || 0).toFixed(4)} and booked at the estimate.\n`
          + `error: ${String(err && err.message || err)}\n\n`
          + 'The request may have reached the provider. It has NOT been retried, because retrying '
          + 'an unknown outcome is how one charge becomes two. Check the provider\'s own records, '
          + 'then close this task.',
      });
    } catch { /* a parked task is best-effort; the booking above is not */ }

    return {
      ok: false,
      uncertain: true,
      state: JOB.UNCERTAIN,
      // The original cause is carried through, not replaced. A report that says
      // only "the outcome is unknown" has lost the one fact that tells the
      // owner whether this was a timeout, an outage, or something new.
      reason: `the provider's response was never seen (${String(err && err.message || err).slice(0, 160)}); `
        + 'booked at the estimate and parked for a person',
      cause: err,
      cents: res.cents,
    };
  }
}

/**
 * For the exemption test and the Spending panel: the paid paths this build
 * knows about, and how each is guarded.
 *
 * `guard: 'withSpend'` means it passes through this module. `guard: 'own-cap'`
 * means the module enforces its own refusal and is listed on screen as such.
 * `guard: 'unreachable'` means no production path reaches it at all, which is a
 * fact recorded by `tests/reachability.test.mjs`, not a claim made here.
 */
export const PAID_PATHS = Object.freeze([
  { what: 'Anthropic model calls', where: 'lib/ai-client.js', guard: 'withSpend', category: 'ai' },
  { what: 'Rank tracking (DataForSEO)', where: 'lib/agent.js', guard: 'withSpend', category: 'enrichment' },
  { what: 'Web search (Brave)', where: 'lib/search-adapter.js', guard: 'withSpend', category: 'discovery' },
  { what: 'Prospect email (Resend)', where: 'lib/outreach-email.js', guard: 'unreachable', category: 'messaging' },
  { what: 'Prospect SMS (Twilio)', where: 'lib/sms-outreach.js', guard: 'unreachable', category: 'messaging' },
  { what: 'Phone line-type lookup (Twilio)', where: 'lib/phone.js', guard: 'unreachable', category: 'lookup' },
  { what: 'Owner alert texts (Twilio)', where: 'lib/sms.js', guard: 'own-cap', category: 'messaging' },
  { what: 'Compass chat', where: 'lib/coach.js', guard: 'withSpend', category: 'ai' },
  { what: 'SEO agent', where: 'lib/agent.js', guard: 'withSpend', category: 'ai' },
]);
