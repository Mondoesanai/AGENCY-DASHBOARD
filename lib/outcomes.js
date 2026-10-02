// R9.2 — the four primary outcomes, and what each one actually requires.
//
// Qualified positive reply · qualified booking · attended call · recorded sale.
//
// The load-bearing word is QUALIFIED, and the shape that matters is that these
// are a LADDER, not a list:
//
//     replies      cheap, noisy, fast           hundreds
//     bookings     scarcer, verifiable           some
//     attended     only a person knows           fewer
//     sales        only the owner can say        the one that pays
//
// Volume falls at every rung and truth rises. Three rules follow, and they are
// the whole of this file:
//
//  1. NOTHING IS PROMOTED WITHOUT THE EVIDENCE FOR ITS OWN RUNG.
//     A booking does not mean someone turned up. Someone turning up does not
//     mean they bought. Each rung needs its own assertion, from a source that
//     could actually know, and inferring one from the one below is how a
//     dashboard ends up reporting revenue that never existed.
//
//  2. THE RUNGS ARE NEVER SUMMED.
//     "12 outcomes" is a meaningless number if it is 11 replies and one sale.
//     They are reported side by side, always, and the reporting object has no
//     field that adds them up.
//
//  3. A POSITIVE REPLY IS NOT AUTOMATICALLY A QUALIFIED ONE.
//     Enthusiasm from someone who cannot buy — wrong segment, outside the
//     service area, an assistant with no authority, or a prospect we were
//     never confident about — is a real reply and a bad signal, and treating
//     it as the primary outcome optimises the message towards the wrong
//     audience. It is counted, separately, as unqualified.
//
// Opens and clicks are deliberately absent: they are not outcomes, and R9.4
// makes that explicit.

export const PRIMARY = Object.freeze({
  QUALIFIED_REPLY: 'qualified-positive-reply',
  QUALIFIED_BOOKING: 'qualified-booking',
  ATTENDED_CALL: 'attended-call',
  RECORDED_SALE: 'recorded-sale',
});

/**
 * The ladder, in order, with who can assert each rung and what that assertion
 * has to carry. `inferableFrom: null` is the point of the table: nothing is.
 */
export const LADDER = Object.freeze([
  {
    id: PRIMARY.QUALIFIED_REPLY,
    rung: 1,
    label: 'Qualified positive reply',
    assertedBy: ['reply-classifier'],
    requires: 'A reply classified as positive AND a prospect who could actually buy.',
    inferableFrom: null,
  },
  {
    id: PRIMARY.QUALIFIED_BOOKING,
    rung: 2,
    label: 'Qualified booking',
    assertedBy: ['verified-webhook', 'owner'],
    requires: 'A booking confirmed by a signature-verified scheduler webhook, or entered by the owner. A link click is never a booking.',
    inferableFrom: null,
  },
  {
    id: PRIMARY.ATTENDED_CALL,
    rung: 3,
    label: 'Attended call',
    assertedBy: ['owner'],
    requires: 'Someone has to say the call happened. A booking in the past is not attendance.',
    inferableFrom: null,
  },
  {
    id: PRIMARY.RECORDED_SALE,
    rung: 4,
    label: 'Recorded sale',
    assertedBy: ['owner'],
    requires: 'The owner records it, with an amount. Nothing else in this system can know that money changed hands.',
    inferableFrom: null,
  },
]);

export const ladderFor = (id) => LADDER.find((l) => l.id === id) || null;

// ---------------------------------------------------------------------------
// Rung 1: is this positive reply a QUALIFIED one?
// ---------------------------------------------------------------------------

/** Reply kinds that are positive at all. Everything else is not rung 1. */
export const POSITIVE_KINDS = Object.freeze(['interested', 'wants-call', 'wants-preview', 'wants-details']);

/**
 * Decide whether a positive reply counts as a qualified primary outcome.
 *
 * Returns `{ qualified, reasons }` either way — an unqualified reply is still
 * a reply and is still counted, in its own column. The reasons are kept
 * because "why did this not count?" is the first question anyone asks of a
 * number that looks too low.
 */
export function qualifyReply({ replyKind, prospect = null, contact = null, targetingConfirmed = true } = {}) {
  const reasons = [];

  if (!POSITIVE_KINDS.includes(replyKind)) {
    return { qualified: false, positive: false, reasons: [`"${replyKind}" is not a positive reply`] };
  }

  // the prospect has to be someone who could buy
  const segment = prospect?.qualification?.segment || null;
  if (segment === 'has-site') {
    // not disqualifying on its own — a business with a site can still buy —
    // but it is a different conversation and worth recording as such
    reasons.push('they already have a working website, so this is an improvement conversation rather than a first build');
  }
  if (segment === 'uncertain') {
    reasons.push('we were never confident this listing matched the business, so the reply cannot be credited to the targeting');
  }

  if (prospect && prospect.withinTargeting === false) {
    reasons.push('this prospect is outside the configured service area or industries');
  }
  if (!targetingConfirmed) {
    reasons.push('targeting is still a draft, so "qualified" has no agreed meaning yet');
  }

  // someone who can actually decide
  const evidence = prospect?.decisionMaker?.evidence || contact?.decisionMaker?.evidence || null;
  const claimed = prospect?.decisionMaker?.titleClaim || contact?.role?.value || null;
  if (!evidence && !claimed) {
    reasons.push('nothing we read says this person can decide, so enthusiasm may not be authority');
  }

  // opted out between send and reply — a reply that is also a stop
  if (contact?.optedOutAt) {
    reasons.push('this contact has since opted out');
  }

  const disqualifying = reasons.filter((r) =>
    /outside the configured|never confident|targeting is still a draft|since opted out/.test(r));

  return {
    qualified: disqualifying.length === 0,
    positive: true,
    reasons,
    disqualifying,
  };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export const ASSERTION_SOURCES = Object.freeze(['reply-classifier', 'verified-webhook', 'owner']);

/**
 * Check an assertion before it becomes an outcome.
 *
 * This is where rule 1 lives. An "attended call" asserted by a webhook, or a
 * sale asserted by anything other than the owner, is refused — not downgraded,
 * not recorded with a caveat. The point of a primary outcome is that it can be
 * trusted without reading a footnote.
 */
export function checkAssertion({ outcome, source, evidence = null, amount = null }) {
  const rung = ladderFor(outcome);
  if (!rung) return { ok: false, error: `"${outcome}" is not a primary outcome` };
  if (!ASSERTION_SOURCES.includes(source)) {
    return { ok: false, error: `"${source}" is not a source that can assert anything; expected one of ${ASSERTION_SOURCES.join(', ')}` };
  }
  if (!rung.assertedBy.includes(source)) {
    return {
      ok: false,
      error: `a ${rung.label.toLowerCase()} cannot be asserted by ${source}. ${rung.requires}`,
    };
  }
  if (outcome === PRIMARY.QUALIFIED_BOOKING && source === 'verified-webhook' && !evidence) {
    return { ok: false, error: 'a webhook-asserted booking must carry the event it came from' };
  }
  if (outcome === PRIMARY.RECORDED_SALE) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, error: 'a recorded sale needs the amount. A sale with no number is a feeling.' };
    }
  }
  return { ok: true, rung: rung.rung };
}

/**
 * Record a primary outcome against an experiment arm.
 *
 * Delegates storage to the experiments module so there is one place outcomes
 * live, and refuses before storing anything the ladder does not permit.
 */
export async function recordPrimaryOutcome({ experimentId, contactId, outcome, source, evidence = null, amount = null, at = Date.now() }) {
  const check = checkAssertion({ outcome, source, evidence, amount });
  if (!check.ok) return { ok: false, ...check };

  const { recordOutcome } = await import('./experiments.js');
  const out = await recordOutcome({
    experimentId,
    contactId,
    kind: outcome,
    at,
    evidence: { source, rung: check.rung, amount: amount ?? null, detail: evidence },
  });
  return out.ok ? { ok: true, outcome: out.outcome, rung: check.rung } : out;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * The four rungs per arm, side by side and never summed.
 *
 * There is deliberately no `total`, no `conversionRate` and no `score`. A
 * single number across rungs would have to decide how many replies equal a
 * sale, and nothing in this system is entitled to that opinion.
 */
export function primaryBreakdown(tallyResult) {
  if (!tallyResult?.ok) return { ok: false, error: tallyResult?.error || 'no tally' };

  const arms = (tallyResult.arms || []).map((arm) => {
    const rungs = {};
    for (const l of LADDER) rungs[l.id] = arm.outcomes?.[l.id] || 0;
    // positive replies that did NOT qualify are counted, separately
    const unqualified = arm.outcomes?.['unqualified-positive-reply'] || 0;
    return {
      variantId: arm.variantId,
      label: arm.label,
      assigned: arm.assigned,
      retired: !!arm.retired,
      rungs,
      unqualifiedPositiveReplies: unqualified,
      // what the numbers above are made of, so nobody has to guess
      denominator: arm.assigned,
    };
  });

  // R9.6 — the baseline is shown FIRST. A baseline read last is a baseline
  // read last; the point is that every variant is read against it.
  const holdoutFirst = [...arms].sort((x, y) => (x.variantId === 'holdout' ? -1 : y.variantId === 'holdout' ? 1 : 0));

  return {
    ok: true,
    experimentId: tallyResult.experimentId,
    baseline: holdoutFirst.find((a) => a.variantId === 'holdout') || null,
    hasBaseline: holdoutFirst.some((a) => a.variantId === 'holdout'),
    arms: holdoutFirst,
    ladder: LADDER.map((l) => ({ id: l.id, rung: l.rung, label: l.label, requires: l.requires })),
    unattributedOutcomes: tallyResult.unattributedOutcomes || 0,
    note:
      'The four rungs are reported side by side and are never added together: a reply is not a sale. ' +
      'No rate is computed here, and no winner is implied — see the sample-size statement before reading anything into a difference.',
  };
}
