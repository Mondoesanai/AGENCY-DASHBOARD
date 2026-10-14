// How many businesses must we contact to get one paying client?
//
// R23.2. The owner's goal is one $2,500 build per week. Everything upstream of
// that — attended calls, bookings, replies, eligible contacts — is arithmetic
// once the rates are known, and guesswork before. This module keeps the
// arithmetic and the honesty about the rates in the same place.
//
// THREE RULES IT WILL NOT BEND:
//
//  1. A self-reported rate is labelled as one, for ever. The owner said he
//     closes "about 33%" of calls he gets on. That is a useful planning number
//     and it is NOT a measured rate: no sample size, no date range, no record
//     of which calls counted. It is stored with that provenance attached so it
//     can never be quoted back as though the system measured it.
//
//  2. A measured rate from a handful of events is not a rate. Three calls and
//     one sale is not "33%", it is "we have seen three calls". Below a floor the
//     measured number is shown as an observation and the planning number is used
//     for arithmetic — and the output always says which one it used.
//
//  3. The ambiguity in the goal is surfaced, never resolved silently. "Four to
//     six a week" may mean attended calls or paying clients. Those differ by
//     roughly 3x in required volume. Both readings are returned.

import { store } from './store.js';

/** The agency's own numbers. Editable settings, not constants in the code. */
export const DEFAULT_ECONOMICS = Object.freeze({
  buildPriceUsd: 2500,        // the one-off website build
  monthlyFeeUsd: null,        // stated separately; the owner sets it
  previewHoursPerBuild: 4,    // how long a custom preview actually takes
  ownerPreviewHoursPerWeek: 20, // what the owner can really spend building them
});

/**
 * The owner's estimate, with everything that makes it an estimate.
 *
 * Deliberately verbose. A bare `0.33` in a dashboard becomes "our close rate is
 * 33%" within a week of somebody reading it.
 */
export const OWNER_BASELINE = Object.freeze({
  closeRate: 0.33,
  source: 'owner-provided',
  statedOn: '2026-10-13',
  sampleSize: null,
  basis: 'The owner\'s recollection of calls he has got on, not a counted set.',
  confidence: 'low',
  caveat: 'Self-reported, sample size unknown, no date range. Use for planning. '
    + 'Do not present as a measured close rate.',
});

/** Below this many observations, a ratio is an anecdote, not a rate. */
export const MIN_SAMPLE = Object.freeze({
  close: 10,      // calls attended before a close rate means anything
  show: 8,        // bookings before an attendance rate means anything
  booking: 20,    // replies before a booking rate means anything
  reply: 100,     // sends before a reply rate means anything
});

/**
 * What the goal might mean, both ways.
 *
 * The owner said four to six a week. If that is calls, six calls at the planning
 * close rate is about two sales. If it is clients, six clients needs about
 * eighteen calls — a different business. Nobody should have to guess which was
 * meant, and nobody should silently pick one.
 */
export function interpretTarget({ floor = 4, target = 6, closeRate = OWNER_BASELINE.closeRate } = {}) {
  const r = (n) => Math.round(n * 10) / 10;
  return {
    ambiguous: true,
    question: `Did "${floor}–${target} a week" mean attended preview calls, or paying clients?`,
    asAttendedCalls: {
      meaning: `${floor}–${target} attended preview calls per week`,
      impliedSalesPerWeek: { floor: r(floor * closeRate), target: r(target * closeRate) },
      note: `At the planning close rate of ${Math.round(closeRate * 100)}%, ${target} calls suggest about `
        + `${r(target * closeRate)} sales in an average week. Real weeks vary a lot at this volume.`,
    },
    asPayingClients: {
      meaning: `${floor}–${target} paying clients per week`,
      impliedAttendedCallsPerWeek: { floor: Math.ceil(floor / closeRate), target: Math.ceil(target / closeRate) },
      note: `That needs about ${Math.ceil(target / closeRate)} attended calls a week — roughly `
        + `${Math.round((target / closeRate) / target * 10) / 10}x the other reading.`,
    },
    usedForPlanning: 'asAttendedCalls',
    whyThatOne: 'The brief describes four as a floor and six as a planning target for CALLS. '
      + 'Recorded here so the other reading is visible rather than lost.',
  };
}

/** One stage's measured performance, with its denominator stated. */
function rate(label, numerator, denominator, minSample, definition) {
  const enough = denominator >= minSample;
  return {
    label,
    definition,
    numerator,
    denominator,
    observed: denominator > 0 ? numerator / denominator : null,
    sampleSize: denominator,
    enoughToTrust: enough,
    note: denominator === 0
      ? 'Nothing observed yet.'
      : enough
        ? `${numerator} of ${denominator}.`
        : `${numerator} of ${denominator} — too few to call a rate. Shown as an observation only.`,
  };
}

/**
 * The funnel as it has actually behaved, with every denominator named.
 *
 * Reads the funnel counters. A counter that cannot be read is reported as
 * unreadable, never as zero: "nobody replied" and "I could not count" lead to
 * opposite decisions.
 */
export async function measuredRates() {
  const keys = {
    invited: 'funnel:invitation-sent',
    visits: 'funnel:form-visit',
    submitted: 'funnel:request-submitted',
    booked: 'funnel:booking-confirmed',
    attended: 'funnel:call-attended',
    noShow: 'funnel:no-show',
  };
  const n = {};
  for (const [k, key] of Object.entries(keys)) {
    try {
      n[k] = Number(await store.get(key)) || 0;
    } catch {
      return { readable: false, why: 'the funnel counters could not be read, so no rate is being shown' };
    }
  }
  // Sales are not a funnel counter — they are a booking outcome plus money.
  let won = 0;
  try {
    const raw = await store.get('funnel:sale-won');
    won = Number(raw) || 0;
  } catch { /* counted as zero sales observed, which is honest here */ }

  return {
    readable: true,
    counts: { ...n, won },
    rates: {
      reply: rate('reply rate', n.submitted, n.invited, MIN_SAMPLE.reply,
        'form submissions ÷ invitations sent. Not opens, not clicks.'),
      booking: rate('booking rate', n.booked, n.submitted, MIN_SAMPLE.booking,
        'provider-confirmed bookings ÷ form submissions.'),
      show: rate('show rate', n.attended, n.booked, MIN_SAMPLE.show,
        'attended calls ÷ confirmed bookings. A no-show is counted, not ignored.'),
      close: rate('close rate', won, n.attended, MIN_SAMPLE.close,
        'paid builds ÷ attended calls. A verbal yes is not a sale.'),
    },
  };
}

/**
 * Which number to plan with, and an explicit statement of why.
 *
 * Measured wins once there is enough of it. Until then the owner's estimate is
 * used and SAID to be used — the one thing that must never happen is a planning
 * number of unknown origin.
 */
export function planningRate(measured, baseline = OWNER_BASELINE.closeRate) {
  if (measured && measured.enoughToTrust && measured.observed != null) {
    return {
      value: measured.observed,
      from: 'measured',
      basis: `${measured.numerator} of ${measured.denominator} attended calls`,
      confidence: 'measured, small sample — keep watching',
    };
  }
  return {
    value: baseline,
    from: 'owner-estimate',
    basis: OWNER_BASELINE.basis,
    confidence: OWNER_BASELINE.confidence,
    caveat: OWNER_BASELINE.caveat,
    observedSoFar: measured && measured.denominator > 0 ? measured.note : 'nothing observed yet',
  };
}

/**
 * The planning rates, and the fact that every one of them is a guess.
 *
 * R24.2. These four numbers decide everything downstream — "413 invitations a
 * week" is 1 ÷ 0.33 ÷ 0.7 ÷ 0.35 ÷ 0.03 and nothing else — and three of them
 * were bare literals in a function signature with no provenance at all. A
 * number nobody can trace is a number nobody can argue with, which is how an
 * invented 3% reply rate becomes a plan.
 *
 * Each one carries where it came from and what would replace it.
 */
export const ASSUMED_RATES = Object.freeze({
  close: Object.freeze({
    value: 0.33,
    label: 'ESTIMATE',
    definition: 'paid builds ÷ attended calls',
    source: 'owner-provided, 2026-10-13',
    basis: OWNER_BASELINE.basis,
    replacedBy: `${MIN_SAMPLE.close} attended calls with their outcomes recorded`,
  }),
  show: Object.freeze({
    value: 0.7,
    label: 'ESTIMATE',
    definition: 'attended calls ÷ confirmed bookings',
    source: 'industry-typical placeholder chosen for this plan',
    basis: 'Not measured here and not owner-provided. A plausible mid-range figure for a '
      + 'free consultation booked by a stranger. Real no-show rates on cold-sourced calls '
      + 'are often worse.',
    replacedBy: `${MIN_SAMPLE.show} confirmed bookings with attendance recorded`,
  }),
  booking: Object.freeze({
    value: 0.35,
    label: 'ESTIMATE',
    definition: 'confirmed bookings ÷ form submissions',
    source: 'industry-typical placeholder chosen for this plan',
    basis: 'Not measured here and not owner-provided. Assumes a third of people who fill the '
      + 'form pick a time and confirm it.',
    replacedBy: `${MIN_SAMPLE.booking} form submissions`,
  }),
  reply: Object.freeze({
    value: 0.03,
    label: 'ESTIMATE',
    definition: 'form submissions ÷ invitations sent — not opens, not clicks',
    source: 'industry-typical placeholder chosen for this plan',
    basis: 'Not measured here and not owner-provided. 3% is an optimistic figure for cold '
      + 'email to small businesses; it is also the rate the whole plan is most sensitive to. '
      + 'At 1% the same goal needs roughly three times the sending.',
    replacedBy: `${MIN_SAMPLE.reply} sends with replies counted`,
  }),
});

/** The most promises the owner can keep in a week, from hours alone. */
export function previewCapacity(economics = DEFAULT_ECONOMICS) {
  const perWeek = Math.floor(economics.ownerPreviewHoursPerWeek / economics.previewHoursPerBuild);
  return {
    previewsPerWeek: perWeek,
    hoursPerPreview: economics.previewHoursPerBuild,
    hoursPerWeek: economics.ownerPreviewHoursPerWeek,
    basis: `${economics.ownerPreviewHoursPerWeek}h available ÷ ${economics.previewHoursPerBuild}h per preview`,
  };
}

/**
 * Work backwards from a goal, showing the arithmetic at every stage.
 *
 * Driven EITHER by sales per week or by attended calls per week. Both exist
 * because the owner's stated target is "four to six CALLS", and planning from
 * sales instead quietly answers a different question: one sale a week needs
 * about 4 calls, so the two readings nearly coincide at the floor and diverge
 * badly above it.
 *
 * Rounding is shown, not hidden. People are integers: 4.3 bookings is 5
 * bookings, and saying "4.3" in a plan invites someone to offer four slots.
 */
export function requiredVolume({
  salesPerWeek = null,
  attendedCallsPerWeek = null,
  closeRate = ASSUMED_RATES.close.value,
  showRate = ASSUMED_RATES.show.value,
  bookingRate = ASSUMED_RATES.booking.value,
  replyRate = ASSUMED_RATES.reply.value,
  economics = DEFAULT_ECONOMICS,
  assumed = {},
} = {}) {
  const up = (n) => Math.ceil(n);
  const r1 = (n) => Math.round(n * 10) / 10;

  // Exactly one driver. Sales is the default so existing callers are unchanged.
  const drivenBy = attendedCallsPerWeek != null ? 'attendedCalls' : 'sales';
  const sales = attendedCallsPerWeek != null
    ? attendedCallsPerWeek * closeRate
    : (salesPerWeek == null ? 1 : salesPerWeek);
  const attended = attendedCallsPerWeek != null ? attendedCallsPerWeek : sales / closeRate;

  const booked = attended / showRate;
  const submitted = booked / bookingRate;
  const invited = submitted / replyRate;

  // The promise is one preview per CONFIRMED booking, not per attended call.
  // A no-show still got a preview built for them; that time is spent either way.
  const previewsPromised = up(booked);
  const capacity = previewCapacity(economics);
  const previewHours = previewsPromised * economics.previewHoursPerBuild;
  const overCapacity = previewsPromised > capacity.previewsPerWeek;

  // What the owner COULD serve, at these rates and these hours. The honest
  // ceiling on the whole operation, and the number the booking form enforces.
  const servableAttendedCalls = Math.floor(capacity.previewsPerWeek * showRate);
  const servableSalesPerWeek = r1(servableAttendedCalls * closeRate);

  return {
    drivenBy,
    goal: {
      salesPerWeek: r1(sales),
      attendedCallsPerWeek: r1(attended),
      revenuePerWeekUsd: Math.round(sales * economics.buildPriceUsd),
    },
    // Unrounded expectation and the integer plan, side by side, because the
    // difference between them is where over-promising hides.
    perWeek: {
      attendedCalls: up(attended),
      confirmedBookings: up(booked),
      formSubmissions: up(submitted),
      invitationsSent: up(invited),
    },
    expected: {
      attendedCalls: r1(attended),
      confirmedBookings: r1(booked),
      formSubmissions: r1(submitted),
      invitationsSent: r1(invited),
    },
    // The chain in full, so the biggest number in the plan can be checked by
    // hand rather than believed.
    arithmetic: drivenBy === 'attendedCalls'
      ? `${r1(attended)} attended calls ÷ ${showRate} show = ${r1(booked)} bookings `
        + `÷ ${bookingRate} booking = ${r1(submitted)} form submissions `
        + `÷ ${replyRate} reply = ${r1(invited)} invitations → ${up(invited)} to send`
      : `${r1(sales)} sale ÷ ${closeRate} close = ${r1(attended)} attended calls `
        + `÷ ${showRate} show = ${r1(booked)} bookings ÷ ${bookingRate} booking = `
        + `${r1(submitted)} form submissions ÷ ${replyRate} reply = ${r1(invited)} invitations `
        + `→ ${up(invited)} to send`,
    rates: { closeRate, showRate, bookingRate, replyRate },
    // Every rate, with its label and provenance, so a reader never has to ask
    // where a number came from.
    rateProvenance: Object.fromEntries(Object.entries(ASSUMED_RATES).map(([k, a]) => {
      const live = { close: closeRate, show: showRate, booking: bookingRate, reply: replyRate }[k];
      const stillAssumed = live === a.value;
      return [k, {
        value: live,
        percent: `${Math.round(live * 1000) / 10}%`,
        label: stillAssumed ? a.label : 'MEASURED',
        definition: a.definition,
        source: stillAssumed ? a.source : 'measured from this system\'s own counters',
        basis: stillAssumed ? a.basis : undefined,
        replacedBy: stillAssumed ? a.replacedBy : undefined,
      }];
    })),
    assumedRates: assumed,
    ownerCapacity: {
      previewsPromised,
      hoursNeeded: previewHours,
      hoursAvailable: capacity.hoursPerWeek,
      maxPreviewsPerWeek: capacity.previewsPerWeek,
      servableAttendedCalls,
      servableSalesPerWeek,
      overCapacity,
      // The constraint nobody notices until prospects are waiting.
      note: overCapacity
        ? `${previewsPromised} confirmed bookings means ${previewHours}h of preview building `
          + `against ${capacity.hoursPerWeek}h available. At ${economics.previewHoursPerBuild}h a `
          + `preview the ceiling is ${capacity.previewsPerWeek} promises a week, which at a `
          + `${Math.round(showRate * 100)}% show rate is about ${servableAttendedCalls} attended `
          + 'calls. Shorten the preview, add build capacity, or lower the call target — '
          + 'do not promise previews that cannot be built.'
        : `${previewHours}h of preview building against ${capacity.hoursPerWeek}h available.`,
    },
    bottleneck: overCapacity
      ? 'owner preview capacity'
      : (replyRate <= 0.01 ? 'reply rate — the top of the funnel dominates everything below it' : 'none obvious'),
    health: 'This is arithmetic from assumed rates, not a forecast. Every rate labelled ESTIMATE '
      + 'is a guess, and the invitation count is the product of all four of them.',
  };
}

/**
 * The owner's stated target, checked against the hours he actually has.
 *
 * His words were four to six calls a week. At a 4-hour preview and 20 hours,
 * even the FLOOR does not fit — and that is the finding, not a rounding detail.
 */
export function targetVsCapacity({
  floorCalls = 4, targetCalls = 6, economics = DEFAULT_ECONOMICS,
  showRate = ASSUMED_RATES.show.value,
} = {}) {
  const cap = previewCapacity(economics);
  const need = (calls) => ({
    attendedCalls: calls,
    confirmedBookings: Math.ceil(calls / showRate),
    previewHours: Math.ceil(calls / showRate) * economics.previewHoursPerBuild,
    fits: Math.ceil(calls / showRate) <= cap.previewsPerWeek,
  });
  const floor = need(floorCalls);
  const target = need(targetCalls);
  return {
    capacity: cap,
    showRate,
    showRateLabel: ASSUMED_RATES.show.label,
    floor,
    target,
    // Stated plainly because every version of this that rounded kindly ended
    // with somebody waiting for a preview nobody had time to build.
    verdict: floor.fits && target.fits
      ? 'Both the floor and the target fit within the available preview hours.'
      : !floor.fits
        ? `Neither fits. ${floorCalls} attended calls needs ${floor.confirmedBookings} confirmed `
          + `bookings and therefore ${floor.previewHours}h of preview building, against `
          + `${cap.hoursPerWeek}h available. The stated FLOOR is already over capacity.`
        : `The floor fits; the target does not. ${targetCalls} attended calls needs `
          + `${target.confirmedBookings} bookings and ${target.previewHours}h against `
          + `${cap.hoursPerWeek}h available.`,
    options: floor.fits && target.fits ? [] : [
      {
        option: 'shorten the preview',
        requires: `a preview that holds up at about ${Math.floor((cap.hoursPerWeek / target.confirmedBookings) * 10) / 10}h `
          + `instead of ${economics.previewHoursPerBuild}h`,
        unlocks: `${targetCalls} attended calls a week`,
        risk: 'quality and turnaround must be verified on real builds before the public promise changes',
      },
      {
        option: 'add build capacity',
        requires: `about ${target.previewHours - cap.hoursPerWeek}h a week more preview time`,
        unlocks: `${targetCalls} attended calls a week at the current ${economics.previewHoursPerBuild}h preview`,
        risk: 'a second pair of hands has to produce work the owner will show on a call',
      },
      {
        option: 'lower the call target',
        requires: 'accepting the ceiling the hours impose',
        unlocks: `${Math.floor(cap.previewsPerWeek * showRate)} attended calls a week, about `
          + `${Math.round(Math.floor(cap.previewsPerWeek * showRate) * ASSUMED_RATES.close.value * 10) / 10} sales`,
        risk: 'slower than the stated goal; nothing is over-promised',
      },
    ],
  };
}

/** The whole picture: measured where possible, assumed where not, said plainly. */
export async function funnelPlan({
  salesPerWeek = 1, attendedCallsPerWeek = null, economics = DEFAULT_ECONOMICS,
} = {}) {
  const m = await measuredRates();
  if (!m.readable) return { readable: false, why: m.why };

  const close = planningRate(m.rates.close);
  const show = planningRate(m.rates.show, ASSUMED_RATES.show.value);
  const booking = planningRate(m.rates.booking, ASSUMED_RATES.booking.value);
  const reply = planningRate(m.rates.reply, ASSUMED_RATES.reply.value);

  const assumed = Object.entries({ close, show, booking, reply })
    .filter(([, r]) => r.from !== 'measured')
    .map(([k]) => k);

  return {
    readable: true,
    measured: m,
    planningRates: { close, show, booking, reply },
    required: requiredVolume({
      salesPerWeek: attendedCallsPerWeek == null ? salesPerWeek : null,
      attendedCallsPerWeek,
      closeRate: close.value,
      showRate: show.value,
      bookingRate: booking.value,
      replyRate: reply.value,
      economics,
      assumed,
    }),
    // The owner's target in his own units, against the hours he actually has.
    // Shown always, not only when the caller thinks to ask for it.
    statedTarget: targetVsCapacity({ economics, showRate: show.value }),
    capacity: previewCapacity(economics),
    assumedRateTable: ASSUMED_RATES,
    targetAmbiguity: interpretTarget(),
    honesty: assumed.length === 4
      ? 'Every rate here is an assumption. Nothing has been measured yet, because nothing has been sent.'
      : `${assumed.length} of 4 rates are still assumptions: ${assumed.join(', ')}.`,
  };
}
