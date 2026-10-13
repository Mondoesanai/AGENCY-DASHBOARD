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
 * Work backwards: how much of everything does one sale a week need?
 *
 * Every rate it cannot measure is taken from the planning assumptions and
 * flagged. The output is a plan with its assumptions attached, not a forecast.
 */
export function requiredVolume({
  salesPerWeek = 1,
  closeRate = OWNER_BASELINE.closeRate,
  showRate = 0.7,
  bookingRate = 0.35,
  replyRate = 0.03,
  economics = DEFAULT_ECONOMICS,
  assumed = {},
} = {}) {
  const up = (n) => Math.ceil(n);
  const attended = salesPerWeek / closeRate;
  const booked = attended / showRate;
  const submitted = booked / bookingRate;
  const invited = submitted / replyRate;

  const previewHours = up(booked) * economics.previewHoursPerBuild;
  const overCapacity = previewHours > economics.ownerPreviewHoursPerWeek;

  return {
    goal: { salesPerWeek, revenuePerWeekUsd: salesPerWeek * economics.buildPriceUsd },
    perWeek: {
      attendedCalls: up(attended),
      confirmedBookings: up(booked),
      formSubmissions: up(submitted),
      invitationsSent: up(invited),
    },
    rates: { closeRate, showRate, bookingRate, replyRate },
    assumedRates: assumed,
    ownerCapacity: {
      previewsPromised: up(booked),
      hoursNeeded: previewHours,
      hoursAvailable: economics.ownerPreviewHoursPerWeek,
      overCapacity,
      // The constraint nobody notices until prospects are waiting.
      note: overCapacity
        ? `${up(booked)} confirmed bookings means ${previewHours}h of preview building against `
          + `${economics.ownerPreviewHoursPerWeek}h available. Offer fewer slots or shorten the preview — `
          + 'do not promise previews that cannot be built.'
        : `${previewHours}h of preview building against ${economics.ownerPreviewHoursPerWeek}h available.`,
    },
    bottleneck: overCapacity
      ? 'owner preview capacity'
      : (replyRate <= 0.01 ? 'reply rate — the top of the funnel dominates everything below it' : 'none obvious'),
    health: 'This is arithmetic from assumed rates, not a forecast. Every rate not yet measured is an assumption.',
  };
}

/** The whole picture: measured where possible, assumed where not, said plainly. */
export async function funnelPlan({ salesPerWeek = 1, economics = DEFAULT_ECONOMICS } = {}) {
  const m = await measuredRates();
  if (!m.readable) return { readable: false, why: m.why };

  const close = planningRate(m.rates.close);
  const show = planningRate(m.rates.show, 0.7);
  const booking = planningRate(m.rates.booking, 0.35);
  const reply = planningRate(m.rates.reply, 0.03);

  const assumed = Object.entries({ close, show, booking, reply })
    .filter(([, r]) => r.from !== 'measured')
    .map(([k]) => k);

  return {
    readable: true,
    measured: m,
    planningRates: { close, show, booking, reply },
    required: requiredVolume({
      salesPerWeek,
      closeRate: close.value,
      showRate: show.value,
      bookingRate: booking.value,
      replyRate: reply.value,
      economics,
      assumed,
    }),
    targetAmbiguity: interpretTarget(),
    honesty: assumed.length === 4
      ? 'Every rate here is an assumption. Nothing has been measured yet, because nothing has been sent.'
      : `${assumed.length} of 4 rates are still assumptions: ${assumed.join(', ')}.`,
  };
}
