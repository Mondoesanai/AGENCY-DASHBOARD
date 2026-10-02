// R9.4 — opens and raw clicks may not decide anything.
//
// This is not a preference about metrics. An open rate stopped measuring
// attention years ago, and the reasons are specific and checkable:
//
//   · Apple Mail Privacy Protection (iOS 15, 2021) pre-fetches the tracking
//     pixel for every message sent to a Mail Privacy user, whether or not the
//     message is ever displayed. A large and unknowable share of "opens" are
//     Apple's servers.
//   · Gmail has proxied and cached remote images since 2013. The pixel is
//     fetched by Google, once, and re-reads are invisible.
//   · Corporate security appliances fetch every link and image in every
//     message before delivering it (R9.3 classifies those clicks).
//
// Put together: an open rate is substantially a measurement of WHICH MAIL
// CLIENTS the recipients use. Optimising a message against it optimises for
// writing to people with Apple devices. The same applies, less severely, to
// raw clicks, which include every scanner that walks the message.
//
// So this module is a gate, not a report. It names what may order variants —
// the four primary outcomes, which require a human act — and refuses the rest
// with the reason attached. Opens are still COUNTED and still SHOWN, because
// hiding a number invites someone to go and find it somewhere else; they are
// shown with what they actually measure written next to them.

import { PRIMARY, LADDER } from './outcomes.js';

/** The only metrics that may order one variant above another. */
export const RANKABLE = Object.freeze(LADDER.map((l) => l.id));

/**
 * Metrics that may never rank, and why. The reason travels with the refusal
 * because "not allowed" without a reason is the kind of rule people route
 * around the moment it is inconvenient.
 */
export const UNRANKABLE = Object.freeze([
  {
    id: 'opened',
    why:
      'An open rate is substantially a measure of which mail clients your recipients use. Apple Mail Privacy Protection ' +
      'pre-fetches the pixel for every message sent to its users whether or not anyone reads it, Gmail proxies and caches ' +
      'images, and security appliances fetch everything before delivery. Ranking by opens ranks by device ownership.',
  },
  {
    id: 'click-raw',
    why:
      'Raw clicks include every scanner that walks the message. The most heavily filtered recipients would look like the ' +
      'most interested ones, so a variant could win by being sent to people behind stricter security.',
  },
  {
    id: 'click-filtered',
    why: 'These are the machine clicks themselves. Ranking by them would be ranking by how aggressively a recipient is protected.',
  },
  {
    id: 'click-human',
    why:
      'A click that is not obviously automated is still only a click: it says someone, or something we could not identify, ' +
      'followed a link. It is kept as a weak signal and is not permitted to order variants.',
  },
  {
    id: 'delivered',
    why: 'Delivery is a denominator. A variant does not win by arriving.',
  },
]);

export const unrankableReason = (id) => UNRANKABLE.find((u) => u.id === id)?.why || null;

/**
 * May this metric decide which variant is better?
 *
 * Returns a refusal with its reason rather than a boolean, so a caller that
 * ignores it has to ignore something explicit.
 */
export function mayRankBy(metric) {
  if (RANKABLE.includes(metric)) return { ok: true, metric };
  const why = unrankableReason(metric);
  if (why) return { ok: false, metric, reason: why };
  return {
    ok: false,
    metric,
    reason: `"${metric}" is not a primary outcome. Only ${RANKABLE.join(', ')} may order variants, because each of those requires a person to have done something.`,
  };
}

/**
 * Order variants by a permitted metric.
 *
 * Refuses outright on a forbidden metric — it does not fall back to a
 * permitted one, because a silent substitution would mean a caller asking for
 * "opens" quietly receives something else and reports it as opens.
 *
 * It also does NOT declare a winner. Ordering by a count is arithmetic;
 * concluding that the top one is better needs a sample size, which is R9.5.
 */
export function rankVariants(breakdown, metric) {
  const gate = mayRankBy(metric);
  if (!gate.ok) return { ok: false, ...gate, ranked: null };
  if (!breakdown?.ok) return { ok: false, metric, reason: 'no breakdown to rank', ranked: null };

  const ranked = [...(breakdown.arms || [])]
    .map((a) => ({ variantId: a.variantId, label: a.label, assigned: a.assigned, count: a.rungs?.[metric] ?? 0 }))
    .sort((x, y) => y.count - x.count || String(x.variantId).localeCompare(String(y.variantId)));

  return {
    ok: true,
    metric,
    ranked,
    // said in the result, where a caller will see it
    note: 'This is an ordering by count, not a verdict. Whether the difference means anything depends on the sample size.',
  };
}

// ---------------------------------------------------------------------------
// Reporting opens honestly instead of hiding them
// ---------------------------------------------------------------------------

/**
 * What an open count actually measures, stated alongside the number.
 *
 * It does not invent a contamination percentage. The share of opens caused by
 * Apple's pre-fetch is not knowable from our side — claiming "about 40% are
 * machines" would be exactly the kind of confident-sounding number this whole
 * requirement exists to prevent.
 */
export function openCaveat(opens = 0) {
  return {
    opens,
    usableForRanking: false,
    measures: 'How many times a tracking pixel was fetched.',
    doesNotMeasure: 'Whether anyone read the message.',
    causes: [
      'Apple Mail Privacy Protection pre-fetches the pixel for its users whether or not the message is opened.',
      'Gmail proxies and caches images, so one fetch covers every later re-read.',
      'Security appliances fetch images and links before delivery.',
    ],
    contaminatedShare: null,
    contaminationNote:
      'The share of these that are machines is not knowable from our side, and no estimate is offered. ' +
      'A number here would be a guess wearing a percentage sign.',
  };
}

/**
 * The statement that goes with any experiment report.
 * Built from the real counts so it cannot drift from what is displayed.
 */
export function rankingStatement({ opens = 0, humanClicks = 0, filteredClicks = 0 } = {}) {
  const totalClicks = humanClicks + filteredClicks;
  const pct = totalClicks > 0 ? Math.round((filteredClicks / totalClicks) * 100) : null;
  return {
    rankableMetrics: RANKABLE,
    refusedMetrics: UNRANKABLE.map((u) => ({ id: u.id, why: u.why })),
    opens: openCaveat(opens),
    clicks: {
      human: humanClicks,
      filtered: filteredClicks,
      // this one IS knowable, because we classified them ourselves
      filteredSharePct: pct,
      note: pct === null
        ? 'No clicks have been recorded, so nothing is known about how many would be machines.'
        : `${pct}% of recorded clicks were classified as machine activity. Raw click counts would include all of them.`,
    },
    summary:
      'Variants are ordered only by outcomes that required a person to do something: a qualified reply, a booking, ' +
      'an attended call, or a recorded sale. Opens and clicks are shown because hiding a number invites someone to go ' +
      'looking for it elsewhere, and they are shown with what they actually measure.',
  };
}
