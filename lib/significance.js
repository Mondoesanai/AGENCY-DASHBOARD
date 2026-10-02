// R9.5 — adequate sample size and stated uncertainty.
// A winner is never declared from two replies.
//
// This is the part of an experimentation system that is easiest to fake and
// most expensive to fake, so three decisions are worth stating.
//
// WHY WILSON AND NOT THE NORMAL APPROXIMATION
// The textbook interval, p̂ ± z·√(p̂(1-p̂)/n), is wrong exactly where this
// system lives. With 1 reply from 20 it gives roughly [-0.04, 0.14] — a
// negative lower bound for a quantity that cannot be negative — and with 0
// replies it gives [0, 0], claiming certainty from no information at all. The
// Wilson score interval is well behaved at small n and at zero successes, so
// it is what is used. The difference is not academic: the naive interval is
// what lets a tool announce a winner from a handful of events.
//
// WHY THE REQUIRED SAMPLE SIZE IS SHOWN EVEN THOUGH IT IS DISCOURAGING
// At realistic cold-email reply rates, telling a 3% message from a 4% one
// needs thousands of prospects per arm. At a target of ~25 a week that is
// years. Stating that plainly is the single most useful true thing this
// system can tell its owner, because the alternative is months of reading
// noise as signal and changing the message every fortnight.
//
// WHY LOOKING REPEATEDLY IS ITS OWN PROBLEM
// Checking after every reply and stopping at the first apparent difference
// inflates the false-positive rate well past the nominal 5%. The number of
// times an experiment has been examined is therefore recorded and reported.

/** Standard normal quantiles for the confidence levels offered. */
const Z = Object.freeze({ 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96, 0.99: 2.5758 });
const Z_POWER = Object.freeze({ 0.8: 0.8416, 0.9: 1.2816 });

/**
 * Wilson score interval for a proportion.
 * Returns `[lo, hi]`, both within [0, 1], and sensible at n = 0.
 */
export function wilson(successes, n, confidence = 0.95) {
  const z = Z[confidence] ?? Z[0.95];
  if (!n || n <= 0) return { lo: 0, hi: 1, point: null, n: 0, successes: 0, unknown: true };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return {
    point: p,
    lo: Math.max(0, centre - half),
    hi: Math.min(1, centre + half),
    n,
    successes,
    unknown: false,
  };
}

/**
 * How many per arm would be needed to detect a given difference.
 *
 * Standard two-proportion formula:
 *   n = (z_α/2 + z_β)² · (p₁(1-p₁) + p₂(1-p₂)) / (p₂ - p₁)²
 */
export function requiredPerArm({ baseline, minDetectableEffect, confidence = 0.95, power = 0.8 }) {
  const p1 = Number(baseline);
  const delta = Number(minDetectableEffect);
  if (!Number.isFinite(p1) || p1 <= 0 || p1 >= 1) return { ok: false, error: 'baseline must be a rate between 0 and 1' };
  if (!Number.isFinite(delta) || delta <= 0) return { ok: false, error: 'the effect to detect must be a positive difference in rate' };
  const p2 = p1 + delta;
  if (p2 >= 1) return { ok: false, error: 'baseline plus the effect exceeds 100%' };

  const za = Z[confidence] ?? Z[0.95];
  const zb = Z_POWER[power] ?? Z_POWER[0.8];
  const n = ((za + zb) ** 2 * (p1 * (1 - p1) + p2 * (1 - p2))) / (delta * delta);
  return { ok: true, perArm: Math.ceil(n), total: Math.ceil(n) * 2, baseline: p1, target: p2, confidence, power };
}

/** How long that takes at a real sending rate. The honest timeline. */
export function timeToReach(perArm, arms = 2, perWeek = 25) {
  if (!perArm || !perWeek) return { weeks: null, note: 'not enough information to say' };
  const weeks = Math.ceil((perArm * arms) / perWeek);
  const years = weeks / 52;
  return {
    weeks,
    years: Math.round(years * 10) / 10,
    note: weeks > 104
      ? `At ${perWeek} prospects a week this takes about ${Math.round(years)} years, which means this comparison cannot be settled by sending more. Change what is being tested, not the arithmetic.`
      : `At ${perWeek} prospects a week this takes about ${weeks} weeks.`,
  };
}

export const VERDICT = Object.freeze({
  TOO_EARLY: 'too-early',
  NO_DIFFERENCE_DETECTABLE: 'no-difference-detectable',
  DIFFERENCE: 'difference',
});

/**
 * Compare two arms, honestly.
 *
 * `minOutcomes` is a floor beneath which nothing is said at all. It exists
 * because an interval comparison can technically separate at tiny counts when
 * one arm has zero, and "0/8 versus 3/8" is not a finding — it is eight people.
 */
export function compareArms(a, b, { confidence = 0.95, minOutcomes = 30 } = {}) {
  const ia = wilson(a.successes, a.n, confidence);
  const ib = wilson(b.successes, b.n, confidence);
  const totalOutcomes = (a.successes || 0) + (b.successes || 0);

  const base = {
    a: { ...a, interval: ia },
    b: { ...b, interval: ib },
    confidence,
    totalOutcomes,
  };

  if (!a.n || !b.n) {
    return { ...base, verdict: VERDICT.TOO_EARLY, reason: 'one of the arms has nobody in it yet' };
  }
  if (totalOutcomes < minOutcomes) {
    return {
      ...base,
      verdict: VERDICT.TOO_EARLY,
      reason: `${totalOutcomes} outcome${totalOutcomes === 1 ? '' : 's'} across both arms. Nothing is said below ${minOutcomes}, because a difference built from a handful of events is a difference between a handful of people.`,
      needed: minOutcomes - totalOutcomes,
    };
  }

  const separated = ia.hi < ib.lo || ib.hi < ia.lo;
  if (!separated) {
    return {
      ...base,
      verdict: VERDICT.NO_DIFFERENCE_DETECTABLE,
      reason:
        `The ranges overlap (${pct(ia.lo)}–${pct(ia.hi)} versus ${pct(ib.lo)}–${pct(ib.hi)}), ` +
        'so any difference in the raw counts is within what chance would produce. This is not evidence that the arms are the same — only that this much data cannot tell them apart.',
    };
  }

  const better = ia.lo > ib.hi ? a : b;
  const worse = better === a ? b : a;
  return {
    ...base,
    verdict: VERDICT.DIFFERENCE,
    better: better.variantId,
    reason:
      `The ranges do not overlap: ${better.variantId} is ${pct(wilson(better.successes, better.n, confidence).lo)}–${pct(wilson(better.successes, better.n, confidence).hi)} ` +
      `against ${worse.variantId} at ${pct(wilson(worse.successes, worse.n, confidence).lo)}–${pct(wilson(worse.successes, worse.n, confidence).hi)}.`,
    caveat:
      'A separation at one look is weaker than it appears if the experiment has been checked repeatedly — each look is another chance for noise to cross the line.',
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * The gate. Almost always refuses, and says what would change that.
 *
 * Nothing in this system acts on a winner automatically; this exists so that
 * when something eventually does, the answer has already been made hard to
 * fake.
 */
export function mayDeclareWinner(comparison, { looks = 0, maxLooksWithoutCorrection = 5 } = {}) {
  if (!comparison || comparison.verdict !== VERDICT.DIFFERENCE) {
    return {
      ok: false,
      reason: comparison?.reason || 'there is no comparison to act on',
      verdict: comparison?.verdict || VERDICT.TOO_EARLY,
    };
  }
  if (looks > maxLooksWithoutCorrection) {
    return {
      ok: false,
      verdict: comparison.verdict,
      reason:
        `This experiment has been examined ${looks} times. Checking repeatedly and stopping at the first apparent ` +
        'difference inflates the false-positive rate well past the stated confidence, so a separation found this way is not trustworthy without a correction that is not implemented here.',
    };
  }
  return {
    ok: true,
    winner: comparison.better,
    reason: comparison.reason,
    caveat: comparison.caveat,
  };
}

/**
 * The statement that goes on every experiment report, whatever the counts.
 * It answers "can I believe this yet?" before anyone reads the numbers.
 */
export function sampleSizeStatement({ arms = [], metric = 'qualified-positive-reply', baseline = 0.03, minDetectableEffect = 0.01, perWeek = 25, looks = 0 } = {}) {
  const need = requiredPerArm({ baseline, minDetectableEffect });
  const time = need.ok ? timeToReach(need.perArm, Math.max(arms.length, 2), perWeek) : { weeks: null, note: '' };

  const sized = arms.map((a) => ({
    variantId: a.variantId,
    assigned: a.assigned || 0,
    outcomes: a.successes || 0,
    interval: wilson(a.successes || 0, a.assigned || 0),
  }));

  const totalOutcomes = sized.reduce((t, a) => t + a.outcomes, 0);
  // R9.6 — each variant is read against the HOLDOUT, not against whichever
  // arm happens to be listed first. A variant that beats the other variants
  // but not the baseline has improved nothing.
  const holdout = sized.find((a) => a.variantId === 'holdout') || null;
  const reference = holdout || sized[0] || null;
  const challenger = sized.find((a) => a !== reference) || null;
  const comparison = reference && challenger
    ? compareArms(
      { variantId: reference.variantId, successes: reference.outcomes, n: reference.assigned },
      { variantId: challenger.variantId, successes: challenger.outcomes, n: challenger.assigned },
    )
    : null;

  return {
    metric,
    // the baseline is stated so a reader knows what the comparison is against
    baseline: holdout ? holdout.variantId : null,
    baselineWarning: holdout
      ? null
      : 'There is no holdout in this experiment, so a comparison can only say which variant is best — never whether any of them beats the message that was already being sent.',
    arms: sized,
    totalOutcomes,
    required: need.ok ? { perArm: need.perArm, total: need.total, toDetect: `${(minDetectableEffect * 100).toFixed(1)} percentage points on a ${(baseline * 100).toFixed(1)}% baseline` } : null,
    timeline: time,
    comparison,
    looks,
    canDeclareWinner: comparison ? mayDeclareWinner(comparison, { looks }).ok : false,
    headline: comparison
      ? comparison.verdict === VERDICT.DIFFERENCE
        ? `A difference is visible, with the caveats below.`
        : comparison.reason
      : 'Not enough arms to compare.',
  };
}
