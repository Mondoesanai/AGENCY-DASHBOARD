// R9.6 — a holdout is always retained, never reassigned mid-experiment, and
// reported alongside every variant.
//
// WHY A HOLDOUT, AND NOT JUST TWO VARIANTS
// Comparing variants to each other answers "which of these is better?" It
// cannot answer "is any of these better than what we were already sending?" —
// and those come apart in the case that matters. If all the new wordings are
// worse than the current message, an A/B test still names a winner: the
// least-bad of a bad set, promoted with a straight face. The holdout is the
// only thing in the design that can detect a whole experiment being a
// regression, which is also the outcome nobody running the experiment wants to
// find, which is exactly why it has to be structural rather than optional.
//
// So the rules are enforced, not documented:
//
//   · an experiment cannot be created without one;
//   · it cannot be removed, renamed, zero-weighted or given content;
//   · nobody assigned to it is ever moved out of it;
//   · every report shows it, first, labelled as the baseline.

export const HOLDOUT_ID = 'holdout';

export const HOLDOUT_RULES = Object.freeze([
  'Always present: an experiment without a baseline cannot tell improvement from the least-bad option.',
  'Never removed or zero-weighted while the experiment runs.',
  'Never given content: the holdout IS the current message, unchanged.',
  'Nobody is ever reassigned out of it.',
  'Reported alongside every variant, not as an optional extra.',
]);

/** The holdout arm, as it must always look. */
export function holdoutArm(weight = 1) {
  return {
    id: HOLDOUT_ID,
    label: 'Holdout (current message, unchanged)',
    weight,
    content: null,
    holdout: true,
  };
}

export const isHoldout = (v) => v?.id === HOLDOUT_ID || v?.variantId === HOLDOUT_ID || v?.holdout === true;

/**
 * Make sure a proposed variant list is legal.
 *
 * Returns `{ ok, variants, error }`. When no holdout was supplied one is
 * ADDED rather than the call being refused: the point is that an experiment
 * always has a baseline, and refusing would just teach callers to construct
 * one themselves and get it subtly wrong.
 */
export function withHoldout(variants = []) {
  const list = Array.isArray(variants) ? [...variants] : [];
  const existing = list.filter(isHoldout);

  if (existing.length > 1) {
    return { ok: false, error: 'an experiment may have only one holdout' };
  }

  if (existing.length === 1) {
    const h = existing[0];
    if (h.content != null) {
      return {
        ok: false,
        error: 'the holdout may not carry content. It is the current message, unchanged — giving it content makes it a third variant and leaves the experiment with no baseline.',
      };
    }
    if (h.weight != null && Number(h.weight) <= 0) {
      return { ok: false, error: 'the holdout may not have a zero weight; an empty baseline is the same as no baseline' };
    }
    // normalise it so later code can rely on the shape
    const normalised = list.map((v) => (isHoldout(v) ? holdoutArm(v.weight == null ? 1 : Number(v.weight)) : v));
    return { ok: true, variants: normalised, added: false };
  }

  // none supplied — add one
  return { ok: true, variants: [holdoutArm(1), ...list], added: true };
}

/**
 * Check a proposed CHANGE to an experiment's arms.
 *
 * This is the rule that actually bites in practice: the holdout is not removed
 * when an experiment is designed, it is removed three weeks later by someone
 * who wants more traffic on the variant that looks promising. That is the
 * moment the baseline is worth most and the moment it is most tempting to drop.
 */
export function checkVariantChange(current = [], proposed = []) {
  const had = current.some(isHoldout);
  const has = proposed.some(isHoldout);

  if (had && !has) {
    return {
      ok: false,
      error:
        'the holdout cannot be removed while the experiment is running. It is the only arm that can show whether the ' +
        'variants are better than the message you were already sending, and it is most valuable exactly when a variant looks promising.',
    };
  }
  if (has) {
    const h = proposed.find(isHoldout);
    if (h.content != null) return { ok: false, error: 'the holdout may not be given content' };
    if (h.weight != null && Number(h.weight) <= 0) {
      return { ok: false, error: 'the holdout may not be reduced to zero weight; that is removing it by another name' };
    }
  }
  if (!had && !has) {
    return { ok: false, error: 'this experiment has no holdout, which should not be possible — refusing to carry the fault forward' };
  }
  return { ok: true };
}

/**
 * Would this reassignment move someone out of the holdout?
 *
 * R9.1 already makes every assignment sticky, so this is a second lock on the
 * one arm where moving somebody would be worst: a holdout member who drifts
 * into a variant takes their outcomes with them AND shrinks the baseline, so
 * the comparison is wrong twice in the same direction.
 */
export function mayReassign({ currentVariantId, toVariantId }) {
  if (currentVariantId === HOLDOUT_ID && toVariantId !== HOLDOUT_ID) {
    return {
      ok: false,
      reason:
        'this contact is in the holdout. Moving them into a variant would take their outcomes with them and shrink the ' +
        'baseline at the same time, so the comparison would be wrong twice in the same direction.',
    };
  }
  return { ok: true };
}

/**
 * Order arms for reporting with the holdout first, and say what it is.
 *
 * Reporting order is not cosmetic here: a baseline shown last is a baseline
 * read last, and the whole point is that every variant is read against it.
 */
export function withBaselineFirst(arms = []) {
  const holdout = arms.find(isHoldout) || null;
  const rest = arms.filter((a) => !isHoldout(a));
  const ordered = holdout ? [{ ...holdout, baseline: true }, ...rest] : rest;
  return {
    arms: ordered,
    baseline: holdout ? { ...holdout, baseline: true } : null,
    missingBaseline: !holdout,
    note: holdout
      ? 'The first row is the holdout: the message that was already being sent, unchanged. Every variant should be read against it, not only against the other variants.'
      : 'This experiment has NO holdout, so nothing here can tell you whether any variant beats the message you were already sending.',
  };
}

/**
 * Compare each variant against the baseline rather than against each other.
 *
 * `compare` is injected so this stays free of the statistics module's details
 * and can be tested on its own.
 */
export function againstBaseline(arms, compare) {
  const { baseline, arms: ordered, missingBaseline, note } = withBaselineFirst(arms);
  if (missingBaseline) return { ok: false, error: 'no holdout to compare against', note };

  const comparisons = ordered
    .filter((a) => !isHoldout(a))
    .map((a) => ({
      variantId: a.variantId,
      vsBaseline: compare(
        { variantId: baseline.variantId, successes: baseline.successes || 0, n: baseline.assigned || 0 },
        { variantId: a.variantId, successes: a.successes || 0, n: a.assigned || 0 },
      ),
    }));

  return {
    ok: true,
    baseline: { variantId: baseline.variantId, assigned: baseline.assigned || 0, successes: baseline.successes || 0 },
    comparisons,
    note:
      'Each variant is compared with the holdout. A variant that beats the other variants but not the holdout has not ' +
      'improved anything — it is the least-bad of a set that is worse than where you started.',
  };
}
