// R9.9 — stop sending by itself when the numbers say the sending is harming
// people, and never start again by itself.
//
// The asymmetry in that sentence is the whole design. Automation may PAUSE and
// may never RESUME. A wrong pause costs a few days of outreach the owner can
// undo in one click; a wrong resume costs the sending domain, and with it
// every message to every client. Nothing here is symmetrical, and it should
// not be.
//
// THE THING THAT MAKES THIS HARD IS THE DENOMINATOR.
//
// This business sends about 25 messages a week. One hard bounce in a week is
// 4%, which is over any sane bounce threshold — and it is also completely
// unremarkable, because one event out of 25 tells you almost nothing. A system
// that pauses on that pauses most weeks, the owner switches it off within a
// month, and then it is not protecting anything at all. The failure mode of a
// safety trip is not being too slow; it is being so noisy that it gets
// disabled.
//
// So the rate triggers use the LOWER bound of the Wilson interval (R9.5, the
// same arithmetic as the experiment comparison, deliberately not a second
// implementation). Pausing happens when we are confident the true rate is
// above the threshold — not when a small sample happened to look bad. With 25
// sends and one bounce the lower bound is near zero and nothing trips; with
// 200 sends and 10 bounces it is comfortably above 2% and it does.
//
// That alone would be too slow for complaints, where the provider acts on
// absolute numbers and two is already a problem, so complaints also have a
// COUNT backstop that does not wait for a rate to become significant.
//
// Three more rules that matter:
//
//  * A ROLLING WINDOW, not lifetime totals. A bad week last year must not keep
//    the system paused, and must not dilute a bad week now. The counters this
//    reads are per-day buckets for exactly that reason.
//  * UNKNOWN IS NOT HEALTHY, and it is also not a reason to pause. If the
//    counters cannot be read, this says it cannot tell. Pausing on a flaky
//    store would be the same noise problem in a different coat.
//  * THE PAUSE SAYS WHAT TO FIX. "Paused: deliverability" is a dead end. The
//    reason names the signal, the numbers behind it, and what the owner is
//    expected to do before resuming.

import { store } from './store.js';
import { wilson } from './significance.js';

export const WINDOW_DAYS = 14;

/**
 * The signals, their thresholds, and why each number is what it is.
 *
 * These are settings-shaped (an object, not constants scattered through the
 * code) but they are NOT owner-editable: R9.8 puts spending limits and consent
 * out of reach of optimisation, and a safety trip the system can relax for
 * itself is not a safety trip. The owner can resume; the owner cannot raise
 * the threshold from inside the optimisation path.
 */
export const SIGNALS = Object.freeze([
  {
    id: 'complaint-rate',
    label: 'Spam complaints',
    numerator: 'complained',
    denominator: 'delivered',
    warnAt: 0.001,   // Gmail and Yahoo's published guidance: stay under 0.10%
    pauseAt: 0.003,  // their stated hard line is 0.30%; past it, filtering follows
    countBackstop: 2, // and two complaints is a problem before any rate is significant
    why: 'Gmail and Yahoo publish 0.10% as the level to stay under and 0.30% as the line where filtering starts. Past it, every message to every client on this domain is affected, not just the outreach.',
    fix: 'Stop sending, read the last few messages that went out, and work out who is receiving them who should not be.',
  },
  {
    id: 'hard-bounce-rate',
    label: 'Hard bounces',
    numerator: 'bounced',
    denominator: 'delivered',
    warnAt: 0.02,
    pauseAt: 0.05,   // most providers suspend an account somewhere around here
    countBackstop: 0,
    why: 'A hard bounce means the address never existed. A run of them tells the provider the list was not verified, and that reputation is applied to the sending domain, not to the campaign.',
    fix: 'Check where these addresses came from. Addresses guessed from a pattern rather than found on the business’s own site are the usual cause.',
  },
  {
    id: 'opt-out-rate',
    label: 'Opt-outs',
    numerator: 'unsubscribed',
    denominator: 'delivered',
    warnAt: 0.02,
    pauseAt: 0.05,
    countBackstop: 0,
    why: 'Opting out is lawful and expected, and a few are fine. A high rate is the message being unwelcome to the people chosen to receive it, which is a targeting problem that becomes a complaint problem if it carries on.',
    fix: 'Look at who is being contacted before looking at the wording. A rate this high is usually the list, not the copy.',
  },
]);

export const signal = (id) => SIGNALS.find((s) => s.id === id) || null;

const dayKey = (at) => new Date(at).toISOString().slice(0, 10);
const COUNT = (day, type) => `delivery:day:${day}:${type}`;

/** Record one delivery event into today's bucket. Called beside the lifetime counter. */
export async function countDailyEvent(type, at = Date.now()) {
  if (!type) return { ok: false };
  try {
    // four keys a day, never read beyond the window; small enough to keep
    await store.incr(COUNT(dayKey(at), type), 1);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Totals over the window.
 *
 * `known` is false if ANY day could not be read: a window with holes in it
 * produces a rate computed over the wrong denominator, which is worse than no
 * rate because it looks like one.
 */
export async function windowTotals({ days = WINDOW_DAYS, now = Date.now() } = {}) {
  const types = ['delivered', 'bounced', 'complained', 'unsubscribed'];
  const totals = Object.fromEntries(types.map((t) => [t, 0]));
  let known = true;
  for (let i = 0; i < days; i++) {
    const day = dayKey(now - i * 24 * 3600e3);
    for (const t of types) {
      try {
        const v = await store.get(COUNT(day, t));
        const n = Number(v || 0);
        if (!Number.isFinite(n)) { known = false; continue; }
        totals[t] += n;
      } catch {
        known = false;
      }
    }
  }
  return { ...totals, known, days };
}

export const LEVEL = Object.freeze({ OK: 'ok', WARN: 'warn', PAUSE: 'pause', UNKNOWN: 'unknown' });

/**
 * Assess one signal against its thresholds.
 *
 * The rate trip uses the lower bound of the 95% interval, so a pause means
 * "the true rate is probably above the line", not "this small sample looked
 * bad". The count backstop is the exception and says so.
 */
export function assess(sig, totals) {
  if (!sig) return { level: LEVEL.UNKNOWN, reason: 'unknown signal' };
  if (!totals || totals.known === false) {
    return {
      id: sig.id, label: sig.label, level: LEVEL.UNKNOWN,
      reason: `${sig.label.toLowerCase()} could not be read for the last ${totals?.days ?? WINDOW_DAYS} days, so the rate is unknown. Unknown is not the same as fine.`,
    };
  }
  const bad = Number(totals[sig.numerator] || 0);
  const n = Number(totals[sig.denominator] || 0);
  const observed = n > 0 ? bad / n : 0;

  // the count backstop runs first and without a denominator, because the
  // provider does not wait for our sample to become significant
  if (sig.countBackstop > 0 && bad >= sig.countBackstop) {
    return {
      id: sig.id, label: sig.label, level: LEVEL.PAUSE, observed, bad, n, viaCount: true,
      reason: `${bad} ${sig.label.toLowerCase()} in the last ${totals.days} days. ${sig.why}`,
      fix: sig.fix,
    };
  }

  if (n === 0) {
    return { id: sig.id, label: sig.label, level: LEVEL.OK, observed: 0, bad, n, reason: `nothing sent in the last ${totals.days} days` };
  }

  const ci = wilson(bad, n);
  const lower = ci && Number.isFinite(ci.lo) ? ci.lo : 0;
  const upper = ci && Number.isFinite(ci.hi) ? ci.hi : 1;

  if (lower > sig.pauseAt) {
    return {
      id: sig.id, label: sig.label, level: LEVEL.PAUSE, observed, bad, n, lower, upper,
      reason: `${sig.label.toLowerCase()}: ${bad} of ${n} in the last ${totals.days} days (${pct(observed)}). Even allowing for the small number of messages, the real rate is above ${pct(sig.pauseAt)}. ${sig.why}`,
      fix: sig.fix,
    };
  }
  // "the rate could already be worse than it looks" only makes sense when
  // something has actually gone wrong. With a 0.30% threshold the upper bound
  // of 0-in-500 is still 0.76%, so without the `bad > 0` guard a PERFECT
  // record warns — and at 25 messages a week it would warn for ever, which is
  // the noise that gets a safety trip switched off.
  if (observed > sig.warnAt || (bad > 0 && upper > sig.pauseAt)) {
    const becauseSmall = observed <= sig.warnAt;
    return {
      id: sig.id, label: sig.label, level: LEVEL.WARN, observed, bad, n, lower, upper,
      reason: becauseSmall
        ? `${sig.label.toLowerCase()}: ${bad} of ${n} (${pct(observed)}). Too few messages to be sure, but the rate could already be above ${pct(sig.pauseAt)}. Nothing has been paused.`
        : `${sig.label.toLowerCase()}: ${bad} of ${n} (${pct(observed)}), above the ${pct(sig.warnAt)} level to stay under. Not yet enough to be confident it is above ${pct(sig.pauseAt)}, so nothing has been paused.`,
      fix: sig.fix,
    };
  }
  return { id: sig.id, label: sig.label, level: LEVEL.OK, observed, bad, n, lower, upper, reason: `${bad} of ${n} (${pct(observed)})` };
}

const pct = (x) => `${(Number(x) * 100).toFixed(x < 0.01 ? 2 : 1)}%`;

/** The whole picture: every signal, and the worst level across them. */
export async function check({ days = WINDOW_DAYS, now = Date.now() } = {}) {
  const totals = await windowTotals({ days, now });
  const signals = SIGNALS.map((s) => assess(s, totals));
  const worst = signals.some((s) => s.level === LEVEL.PAUSE)
    ? LEVEL.PAUSE
    : signals.some((s) => s.level === LEVEL.UNKNOWN)
      ? LEVEL.UNKNOWN
      : signals.some((s) => s.level === LEVEL.WARN)
        ? LEVEL.WARN
        : LEVEL.OK;
  return { totals, signals, worst, tripping: signals.filter((s) => s.level === LEVEL.PAUSE) };
}

const TRIP_KEY = 'deliverability:trip';

/**
 * The stop this sets is SPECIFIC TO OUTREACH, not the global automation pause.
 *
 * That distinction is the point. The global pause also stops client site
 * improvements, and a prospect's address bouncing is not a reason to stop work
 * the clients are paying for. So this writes its own flag, `sendReadiness`
 * reads it as a blocker, and `maySend` therefore refuses — while everything
 * else carries on.
 */
export async function stopState() {
  try {
    const raw = await store.get(TRIP_KEY);
    if (!raw) return { known: true, stopped: false };
    const t = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { known: true, stopped: !!t.stopped, ...t };
  } catch {
    // UNKNOWN is not "not stopped". A send gate that cannot read its own stop
    // flag must not let sending through on the strength of a failed read.
    return { known: false, stopped: false, unreadable: true };
  }
}

/**
 * Clear the stop. OWNER ONLY, and deliberately not callable from `enforce`.
 *
 * `by` is recorded and refused unless it is the owner, so that a later caller
 * passing 'automatic' — which is exactly what a future "let's make this
 * self-healing" change would do — is refused at the point of the write rather
 * than by a convention someone has to remember.
 */
export async function clearStop({ by = 'owner', note = '' } = {}) {
  if (by !== 'owner') {
    return {
      ok: false,
      error: 'only the owner may start sending again. "The numbers recovered" and "nothing is being sent, so nothing is bouncing" produce the same numbers, and only one of them means it is safe to start.',
    };
  }
  const prev = await stopState();
  await store.set(TRIP_KEY, JSON.stringify({
    ...prev, stopped: false, clearedAt: Date.now(), clearedBy: 'owner', note: String(note).slice(0, 200),
  }));
  return { ok: true, stopped: false };
}

/**
 * Run the check and stop outreach if anything trips.
 *
 * ONE DIRECTION ONLY. This never clears the stop and never relaxes a
 * threshold. If the numbers recover, the stop stays until a person looks at
 * what happened — because "it got better" and "nobody is sending, so nothing
 * is bouncing" are the same numbers, and only one of them means it is safe.
 */
export async function enforce({ days = WINDOW_DAYS, now = Date.now() } = {}) {
  const result = await check({ days, now });
  if (result.worst !== LEVEL.PAUSE) {
    return { ...result, stopped: false, action: 'none' };
  }

  const prev = await stopState();
  if (prev.stopped) {
    // already stopped; rewriting would lose what tripped it first
    return { ...result, stopped: true, action: 'already-stopped' };
  }

  const first = result.tripping[0];
  const reason = `${first ? first.reason : 'a deliverability threshold was crossed'}${first && first.fix ? ` What to do: ${first.fix}` : ''}`.trim();
  try {
    await store.set(TRIP_KEY, JSON.stringify({
      stopped: true,
      at: now,
      by: 'automatic',
      signals: result.tripping.map((s) => ({ id: s.id, label: s.label, bad: s.bad, n: s.n, observed: s.observed, viaCount: !!s.viaCount })),
      reason,
    }));
  } catch {
    // the write failed, so sending is NOT stopped — say so rather than
    // reporting a stop that does not exist
    return { ...result, stopped: false, action: 'failed-to-stop', reason, error: 'the stop could not be written, so outreach is still able to send' };
  }

  return { ...result, stopped: true, action: 'stopped', reason };
}

/**
 * Plain words for the panel.
 *
 * "Healthy" is only ever said when every signal was actually read and every
 * one was under its warn level. Anything else says what is unknown.
 */
export function summarise(result) {
  if (!result) return { word: 'cannot tell', tone: 'warn', detail: 'Deliverability has not been checked yet.' };
  if (result.worst === LEVEL.PAUSE) {
    const t = result.tripping && result.tripping[0];
    return { word: 'sending stopped', tone: 'neg', detail: t ? t.reason : 'A deliverability threshold was crossed.' };
  }
  if (result.worst === LEVEL.UNKNOWN) {
    return { word: 'cannot tell', tone: 'warn', detail: 'At least one signal could not be read. This is not an all-clear.' };
  }
  if (result.worst === LEVEL.WARN) {
    const w = (result.signals || []).find((s) => s.level === LEVEL.WARN);
    return { word: 'worth watching', tone: 'warn', detail: w ? w.reason : '' };
  }
  const n = result.totals ? result.totals.delivered : 0;
  if (!n) return { word: 'nothing sent', tone: '', detail: `No messages were delivered in the last ${result.totals ? result.totals.days : WINDOW_DAYS} days, so there is nothing to judge.` };
  return { word: 'healthy', tone: 'good', detail: `${n} delivered in the last ${result.totals.days} days, with every signal under its level.` };
}
