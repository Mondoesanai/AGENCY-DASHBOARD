// Budget controls and the cost ledger.
//
// Every paid job reserves its estimated cost BEFORE it runs and reconciles the
// actual afterwards. Reservation is an atomic INCR against the period counter
// (store.reserve), so two workers racing the same allowance cannot both be
// told "yes" — whichever pushes past the cap has its own increment rolled back
// and is refused. Reading "spent < cap" and then spending is the classic way
// to blow a budget with concurrency; this never does that.
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
    enforced: limit != null,
  };
}

/** Everything the dashboard needs to show the budget honestly. */
export async function budgetStatus(at = new Date()) {
  const settings = await getBudgetSettings();
  const [week, month] = await Promise.all([getPeriodState('week', at), getPeriodState('month', at)]);
  return {
    settings,
    week,
    month,
    paused: !!settings.pausedAt,
    // which window is actually the binding constraint right now
    bindingPeriod: !week.enforced ? (month.enforced ? 'month' : null) : !month.enforced ? 'week' : week.remainingCents <= month.remainingCents ? 'week' : 'month',
    uncappableNote: uncappableNote(),
  };
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
export async function withBudget({ category, estimateUsd, essential, conversational, meta }, fn) {
  const r = await reserveCost({ category, estimateUsd, essential, conversational, meta });
  if (!r.ok) return { ok: false, skipped: true, reason: r.reason, state: r.state };
  try {
    const result = await fn();
    await reconcileCost(r.reservationId, result?.actualUsd ?? estimateUsd, { note: result?.note });
    return { ok: true, result };
  } catch (e) {
    await releaseCost(r.reservationId).catch(() => {});
    throw e;
  }
}
