// Budget controls and the cost ledger.
//
// READ THIS FIRST: THE RESERVE PATH IS NOT WIRED. The design below is complete
// and tested, and nothing in `api/` calls it — the R15.7 reachability audit
// found `withBudget` with zero production callers, and `reserveCost`,
// `reconcileCost`, `releaseCost`, `spendByCategory` and `setBudgetSettings`
// dead behind it. An earlier version of this comment said "every paid job
// reserves its estimated cost before it runs", which was a description of the
// intent presented as a description of the behaviour. No job reserves anything.
//
// What that means in practice, stated plainly because the Spending panel used
// to imply otherwise:
//   * `spent` and `reserved` here are always zero. Real AI spend accrues under
//     `coach:spend:<month>` and `agent:spend:<slug>:<month>`, written by
//     lib/coach.js and lib/agent.js and rolled up by lib/aicost.js.
//   * a limit typed into settings is a recorded preference, not a cap. It is
//     `limitConfigured`, and `enforced` stays false until `CAP_WIRED` does.
//   * the caps that DO refuse work are listed in `activeCaps()`, each with
//     whether it actually refuses or merely warns.
//
// THE DESIGN, for whoever wires it. Every paid job reserves its estimated cost
// BEFORE it runs and reconciles the actual afterwards. Reservation is an atomic
// INCR against the period counter (store.reserve), so two workers racing the
// same allowance cannot both be told "yes" — whichever pushes past the cap has
// its own increment rolled back and is refused. Reading "spent < cap" and then
// spending is the classic way to blow a budget with concurrency; this never
// does that. Wiring it means wrapping the twelve `@anthropic-ai/sdk` call
// sites, which share no chokepoint today.
//
// Three numbers are tracked separately and mean different things:
//   spent      reconciled, actually-incurred cost
//   reserved   money promised to jobs that are still running
//   committed  spent + reserved — what the cap is actually enforced against
//
// HONEST LIMIT: this caps what THIS APP chooses to spend. It cannot cap what a
// provider bills directly (a monthly subscription, a minimum commit, usage
// already in flight when a job is killed, or billing that lands days later).
// `uncappableNote()` states that plainly rather than implying a hard ceiling.

import { store } from './store.js';

export const CATEGORIES = Object.freeze([
  'discovery', // finding businesses
  'enrichment', // filling in details about them
  'verification', // checking an email address is real
  'ai', // analysis + message generation
  'lookup', // phone/number intelligence
  'messaging', // actually sending email/SMS
  'infrastructure', // allocated subscription/platform cost
]);

// Jobs that must keep working even when the budget is gone. Ignoring an
// opt-out because "the budget ran out" would be both rude and unlawful, and
// going silent mid-conversation with an interested lead is worse than not
// having started. These bypass the cap.
export const ESSENTIAL = Object.freeze(['reply_ingest', 'opt_out', 'monitoring', 'webhook']);

const PERIODS = Object.freeze(['week', 'month']);
const nowISO = () => new Date().toISOString();

/**
 * Does any production code path consult the limits in this module?
 *
 * TRUE since R16.1. `lib/spend-guard.js` wraps every paid discretionary job,
 * and `lib/ai-client.js` is the single door all twelve model call sites now go
 * through. `tests/spend-exempt.test.mjs` fails if a paid path appears outside
 * that door, and `tests/spend-enforcement.test.mjs` proves the refusal happens
 * BEFORE the provider is called rather than after.
 *
 * It exists so the dashboard can distinguish "the owner set a limit" from "a
 * limit is being applied" — the difference between a number on a screen and a
 * control. Set it back to false the moment that stops being true.
 */
export const CAP_WIRED = true;

/**
 * The spending limits that really do stop work today, named with where they
 * live so the owner changes the right thing.
 *
 * Deliberately a description rather than a second implementation: duplicating
 * the numbers here would drift from the modules that enforce them. `refuses`
 * is the field that matters — a cap that only warns is not a cap, and the
 * Compass one genuinely keeps answering past its budget by design.
 */
export function activeCaps(env = process.env) {
  const coachCap = Math.max(1, Number(env.COACH_MONTHLY_BUDGET || 15));
  return [
    {
      what: 'SEO agent, per client site',
      limit: 'the site\'s own monthly cap (Settings → Automation, $20 by default)',
      where: 'lib/agent.js',
      refuses: true,
      note: 'Once the month\'s spend reaches the cap the agent reports it as a reason and does not run.',
    },
    {
      what: 'Compass chat',
      limit: `$${coachCap.toFixed(0)} a month (COACH_MONTHLY_BUDGET)`,
      where: 'lib/coach.js',
      refuses: false,
      note: 'Warns when the month goes over and keeps answering. Spend carries past the cap on purpose, so a question is never refused mid-conversation.',
    },
    {
      what: 'Owner alert texts',
      limit: 'a daily message cap',
      where: 'lib/sms.js',
      refuses: true,
      note: 'Refuses once the day\'s cap is reached.',
    },
  ];
}

// ---------------------------------------------------------------------------
// Period maths. Weeks start Monday. Both are computed in UTC so a deploy in a
// different timezone can't silently shift a period boundary and double-spend.
// ---------------------------------------------------------------------------

export function periodKey(period, at = new Date()) {
  const d = new Date(at);
  if (period === 'month') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return `W${monday.toISOString().slice(0, 10)}`;
}

export function periodEnd(period, at = new Date()) {
  const d = new Date(at);
  if (period === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 7));
}

// money is stored in whole cents — floats silently lose pennies over thousands
// of small charges, and a budget that drifts is worse than no budget
export const toCents = (usd) => Math.round(Number(usd || 0) * 100);
export const toUsd = (cents) => Math.round(Number(cents || 0)) / 100;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTINGS_KEY = 'budget:settings';

export async function getBudgetSettings() {
  const raw = await store.get(SETTINGS_KEY).catch(() => null);
  let s = {};
  try {
    s = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
  } catch {
    s = {};
  }
  return {
    // null = that period is not being enforced at all
    weeklyLimitCents: s.weeklyLimitCents ?? null,
    monthlyLimitCents: s.monthlyLimitCents ?? null,
    // share of the allowance held back for live conversations, so a discovery
    // run can't eat the money needed to answer someone who actually replied
    conversationReservePct: s.conversationReservePct ?? 20,
    rollover: s.rollover === true, // default OFF — unused budget does not accumulate
    pausedAt: s.pausedAt || null,
    updatedAt: s.updatedAt || null,
  };
}

export async function setBudgetSettings(patch) {
  const cur = await getBudgetSettings();
  const next = { ...cur, ...patch, updatedAt: nowISO() };
  if (next.weeklyLimitCents != null) next.weeklyLimitCents = Math.max(0, Math.round(next.weeklyLimitCents));
  if (next.monthlyLimitCents != null) next.monthlyLimitCents = Math.max(0, Math.round(next.monthlyLimitCents));
  next.conversationReservePct = Math.min(90, Math.max(0, Math.round(next.conversationReservePct)));
  await store.set(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

// ---------------------------------------------------------------------------
// Counters. Both periods are tracked, but a charge is only ever counted ONCE
// per period type — spending $1 adds $1 to this week AND $1 to this month,
// which is correct: they are two different windows over the same money, not
// two separate budgets to be summed.
// ---------------------------------------------------------------------------

const spentKey = (p, k) => `budget:${p}:${k}:spent`;
const reservedKey = (p, k) => `budget:${p}:${k}:reserved`;

export async function getPeriodState(period, at = new Date()) {
  const key = periodKey(period, at);
  const settings = await getBudgetSettings();
  const limit = period === 'week' ? settings.weeklyLimitCents : settings.monthlyLimitCents;
  const spent = Number(await store.get(spentKey(period, key)).catch(() => 0)) || 0;
  const reserved = Number(await store.get(reservedKey(period, key)).catch(() => 0)) || 0;
  const committed = spent + reserved;
  return {
    period,
    key,
    limitCents: limit,
    spentCents: spent,
    reservedCents: reserved,
    committedCents: committed,
    remainingCents: limit == null ? null : Math.max(0, limit - committed),
    conversationReserveCents: limit == null ? 0 : Math.round((limit * settings.conversationReservePct) / 100),
    resetsAt: periodEnd(period, at).toISOString(),
    // "the owner typed a number in" and "a code path applies it" are different
    // facts, and collapsing them is what let the panel claim a limit was
    // "actually stopping work right now" while nothing consulted it.
    limitConfigured: limit != null,
    enforced: limit != null && CAP_WIRED,
  };
}

/**
 * Everything the dashboard needs to show the budget honestly.
 *
 * `observed` is the important field. The week/month rows come from this
 * module's own counters, which no job writes to, so they read zero; reporting
 * only those would tell the owner they had spent nothing while the SEO agent
 * was billing real money under its own keys. So the actual figure is read from
 * lib/aicost.js and returned beside them, labelled for what it is.
 */
export async function budgetStatus(at = new Date()) {
  const settings = await getBudgetSettings();
  const [week, month] = await Promise.all([getPeriodState('week', at), getPeriodState('month', at)]);

  // The real number, from the counters the AI features actually write.
  let observed = null;
  try {
    const { aiCostForMonth, MONTH_NOW } = await import('./aicost.js');
    const m = MONTH_NOW();
    const ai = await aiCostForMonth(m);
    observed = {
      month: m,
      totalUsd: ai.total,
      byFeature: [
        { what: 'Compass chat', usd: ai.coach },
        { what: 'SEO agent', usd: ai.agent },
      ],
      source: 'coach:spend / agent:spend — the counters the features write as they go',
      note: 'Model spend only. It does not include PageSpeed, hosting, or anything a provider bills directly.',
    };
  } catch {
    // A failed read is not zero spending, and must never be shown as zero.
    observed = { error: 'could not read the AI spend counters', note: 'This is not a report of zero spending.' };
  }

  return {
    settings,
    week,
    month,
    paused: !!settings.pausedAt,
    // which window WOULD be the binding constraint once the cap is wired
    bindingPeriod: !week.limitConfigured
      ? (month.limitConfigured ? 'month' : null)
      : !month.limitConfigured ? 'week'
        : week.remainingCents <= month.remainingCents ? 'week' : 'month',
    capWired: CAP_WIRED,
    capUnwiredNote: CAP_WIRED ? null
      : 'The weekly and monthly limits below are recorded preferences — no code path applies them yet, so they are not '
        + 'stopping anything, and their spent and reserved columns stay at zero. The spending that is really happening is '
        + 'shown under "What has actually been spent", and the limits that really do refuse work are listed beneath it.',
    activeCaps: activeCaps(),
    observed,
    // R16.2 — what the money went on, from real reservations.
    byCategory: await spendByCategory('month', at).catch(() => null),
    // R16.1 — every paid path and how it is guarded, so "what this cap covers"
    // is a list the owner can read rather than a claim they have to trust.
    paidPaths: await paidPathSummary(),
    // R16.4 — what keeps running when the allowance is gone. The owner should
    // not have to wonder whether hitting the limit means a client's reply stops
    // being read or an opt-out stops being honoured. It does not.
    essentialWork: {
      kinds: [...ESSENTIAL],
      note: 'These continue with the allowance at zero and are still recorded. Ignoring an opt-out because the '
        + 'budget ran out would be unlawful, and going quiet mid-conversation with an interested lead is worse '
        + 'than never having started.',
    },
    uncappableNote: uncappableNote(),
  };
}

/**
 * The paid paths, split into what this app can refuse and what it cannot.
 *
 * The distinction is the honest half of a spending limit: refusing our own
 * discretionary jobs is entirely within our control, while a provider's
 * subscription or a charge already in flight is not.
 */
async function paidPathSummary() {
  try {
    const { PAID_PATHS } = await import('./spend-guard.js');
    return {
      enforceable: PAID_PATHS.filter((p) => p.guard === 'withSpend'),
      ownCap: PAID_PATHS.filter((p) => p.guard === 'own-cap'),
      notConnected: PAID_PATHS.filter((p) => p.guard === 'unreachable'),
      note: 'Enforceable paths reserve against the limit before they run. The rest are listed so nothing is '
        + 'silently outside the cap.',
    };
  } catch {
    return null;
  }
}

export function uncappableNote() {
  return (
    'This limit controls what the app chooses to spend. It cannot cap charges a provider ' +
    'bills directly — monthly subscriptions, minimum commitments, usage already in flight ' +
    'when a job stops, or charges that post a few days later. Set a spending limit in each ' +
    'provider dashboard as well where one is offered.'
  );
}

// ---------------------------------------------------------------------------
// Reserve → run → reconcile
// ---------------------------------------------------------------------------

/**
 * Ask permission to spend. Returns { ok, reservationId, reason, state }.
 * Refusal is the normal path when the budget is gone — callers must check.
 *
 * `essential: true` bypasses the cap (replies, opt-outs, monitoring) but is
 * STILL recorded, so the ledger stays truthful about total spend.
 * `conversational: true` may draw on the reserve held back for live threads.
 */
export async function reserveCost({ category, estimateUsd, jobId, essential = false, conversational = false, meta = {} }) {
  if (!CATEGORIES.includes(category)) throw new Error(`unknown cost category: ${category}`);
  const cents = toCents(estimateUsd);
  const settings = await getBudgetSettings();

  if (settings.pausedAt && !essential) {
    return { ok: false, reason: 'automation is paused', state: await budgetStatus() };
  }

  const id = jobId || `r_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const at = new Date();

  // R16.1 — a caller that retries with the same job id must not reserve twice.
  // Without this, a retry holds the allowance a second time and the ledger
  // shows money committed that no job is spending. An id that was already
  // settled or handed back is finished, and is reported as such rather than
  // being quietly reserved again.
  if (jobId) {
    const existing = await store.get(`budget:res:${id}`).catch(() => null);
    if (existing) {
      let rec = null;
      try {
        rec = typeof existing === 'string' ? JSON.parse(existing) : existing;
      } catch { rec = null; }
      if (rec && !rec.reconciledAt && !rec.releasedAt) {
        return { ok: true, reservationId: id, cents: rec.cents, alreadyHeld: true };
      }
      // A RECONCILED job is finished and must never be charged again. A
      // RELEASED one is different: the money was handed back because the job
      // provably did not run, so trying it again is exactly what should happen
      // and refusing here would strand it for ever.
      if (rec && rec.reconciledAt) {
        return { ok: false, reason: `job ${id} has already been settled; it is not reserved again`, settled: true };
      }
    }
  }

  if (essential) {
    // never blocked, always recorded
    await Promise.all([
      store.incr(reservedKey('week', periodKey('week', at)), cents),
      store.incr(reservedKey('month', periodKey('month', at)), cents),
    ]);
    await store.set(`budget:res:${id}`, JSON.stringify({ id, cents, category, essential: true, at: nowISO(), meta }), { ex: 60 * 60 * 24 * 7 });
    return { ok: true, reservationId: id, essential: true, cents };
  }

  // Enforce every period that has a limit set. Reserve against each, and if a
  // later one refuses, release the earlier ones so a refusal never silently
  // eats allowance from the period that said yes.
  const granted = [];
  for (const period of PERIODS) {
    const limit = period === 'week' ? settings.weeklyLimitCents : settings.monthlyLimitCents;
    if (limit == null) continue;
    const key = periodKey(period, at);
    const spent = Number(await store.get(spentKey(period, key)).catch(() => 0)) || 0;
    // Discovery-type work may not touch the slice held back for live replies.
    const usable = conversational ? limit : limit - Math.round((limit * settings.conversationReservePct) / 100);
    const headroom = usable - spent;
    const r = await store.reserve(reservedKey(period, key), cents, Math.max(0, headroom));
    if (!r.ok) {
      for (const g of granted) await store.incr(reservedKey(g.period, g.key), -cents);
      return {
        ok: false,
        reason: conversational
          ? `the ${period}ly budget is used up`
          : `the ${period}ly budget is used up (the rest is held for replies to people already in a conversation)`,
        state: await budgetStatus(at),
      };
    }
    granted.push({ period, key });
  }

  await store.set(`budget:res:${id}`, JSON.stringify({ id, cents, category, at: nowISO(), periods: granted, meta }), { ex: 60 * 60 * 24 * 7 });
  return { ok: true, reservationId: id, cents };
}

/**
 * Settle a reservation with what it actually cost. Releases the held estimate
 * and books the real figure. Safe to call once per reservation — a second call
 * is ignored, so a retried worker cannot double-charge the ledger.
 */
export async function reconcileCost(reservationId, actualUsd, { note } = {}) {
  const raw = await store.get(`budget:res:${reservationId}`).catch(() => null);
  if (!raw) return { ok: false, reason: 'no such reservation (already reconciled, or expired)' };
  let res;
  try {
    res = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: 'unreadable reservation' };
  }
  if (res.reconciledAt) return { ok: true, alreadyDone: true };

  const actualCents = toCents(actualUsd);
  const at = new Date(res.at || Date.now());
  for (const period of PERIODS) {
    const key = periodKey(period, at);
    await store.incr(reservedKey(period, key), -res.cents); // release the hold
    await store.incr(spentKey(period, key), actualCents); // book the real cost
  }

  const entry = { ...res, actualCents, reconciledAt: nowISO(), note: note || null };
  await store.set(`budget:res:${reservationId}`, JSON.stringify(entry), { ex: 60 * 60 * 24 * 7 });
  await appendLedger(entry);
  return { ok: true, estimatedCents: res.cents, actualCents };
}

/** A job that never ran — hand the money back untouched. */
export async function releaseCost(reservationId) {
  const raw = await store.get(`budget:res:${reservationId}`).catch(() => null);
  if (!raw) return { ok: false, reason: 'no such reservation' };
  let res;
  try {
    res = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { ok: false, reason: 'unreadable reservation' };
  }
  if (res.reconciledAt || res.releasedAt) return { ok: true, alreadyDone: true };
  const at = new Date(res.at || Date.now());
  for (const period of PERIODS) {
    await store.incr(reservedKey(period, periodKey(period, at)), -res.cents);
  }
  await store.set(`budget:res:${reservationId}`, JSON.stringify({ ...res, releasedAt: nowISO() }), { ex: 60 * 60 * 24 * 7 });
  return { ok: true, released: res.cents };
}

// ---------------------------------------------------------------------------
// Ledger — an append-only record of what was actually spent, by category.
// ---------------------------------------------------------------------------

async function appendLedger(entry) {
  const dayKey = `budget:ledger:${new Date().toISOString().slice(0, 10)}`;
  const raw = await store.get(dayKey).catch(() => null);
  let list = [];
  try {
    const a = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    list = Array.isArray(a) ? a : [];
  } catch {
    list = [];
  }
  list.push({ id: entry.id, category: entry.category, cents: entry.actualCents, at: entry.reconciledAt, meta: entry.meta || null });
  await store.set(dayKey, JSON.stringify(list.slice(-500)), { ex: 60 * 60 * 24 * 120 });
  await store.incr(`budget:cat:${periodKey('month')}:${entry.category}`, entry.actualCents);
}

export async function spendByCategory(period = 'month', at = new Date()) {
  const key = periodKey(period, at);
  const out = {};
  for (const c of CATEGORIES) {
    out[c] = toUsd(Number(await store.get(`budget:cat:${key}:${c}`).catch(() => 0)) || 0);
  }
  return out;
}

/**
 * Convenience wrapper: reserve, run, reconcile — with the reservation always
 * released if the job throws, so a crash can't leave money held forever.
 */
// `withBudget` lived here and was deleted in R16.1. It was superseded by
// `lib/spend-guard.js:withSpend`, which does the same reserve → run →
// reconcile and additionally handles the three things this one got wrong:
// a retried job re-ran and paid twice, a timeout released money that may well
// have been charged, and nothing was ever parked for a person to check.
// Keeping both would have left two wrappers with one caller between them,
// which is how the next edit lands on the dead one.
