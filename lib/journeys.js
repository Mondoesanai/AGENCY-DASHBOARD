// What the system can actually be shown to do, end to end.
//
// R13.9 asks for the real user journeys to be demonstrated. The plan recorded
// "11 of 14" and the fourteen were never written down anywhere — so neither
// the numerator nor the denominator could be checked, and the figure was a
// claim rather than a result. A set of journeys cannot be demonstrated without
// first being named.
//
// Three of them end at a service that is not connected. They are not reported
// as failures and they are emphatically not reported as done: each is driven
// to the provider boundary in `tests/journeys.test.mjs` — the exact HTTP
// request the carrier would receive, a signed callback applied end to end, a
// signed scheduler payload through the real webhook — and the one remaining
// step is named. "Demonstrated except for the carrier accepting it" is a
// different and more useful statement than either "done" or "not done".

export const BLOCKED_BY = Object.freeze({
  SMS_PROVIDER: 'no SMS provider account is connected',
  SCHEDULER: 'no scheduler is connected',
});

export const JOURNEYS = Object.freeze([
  { n: 1, name: 'Photograph a batch of cards after an event and get contacts', evidence: 'tests/cardjourney.test.mjs J1' },
  { n: 2, name: 'A mis-read field is corrected without losing the rest', evidence: 'tests/cardjourney.test.mjs J6' },
  { n: 3, name: 'Two different people at one company are not merged', evidence: 'tests/contacts.test.mjs' },
  { n: 4, name: 'A contact from a card can never enter a cold campaign', evidence: 'tests/cardjourney.test.mjs J2' },
  { n: 5, name: 'Someone who asked for a preview gets a tracked task', evidence: 'tests/cardjourney.test.mjs J3' },
  { n: 6, name: '"Your preview is ready" is impossible before one exists', evidence: 'tests/cardjourney.test.mjs J4/J5' },
  { n: 7, name: 'A promised date produces a follow-up when it is due', evidence: 'tests/relationship.test.mjs' },
  { n: 8, name: 'Composing a text shows permission, cost and timing first', evidence: 'tests/smsworkflow.test.mjs M2' },
  { n: 9, name: 'Permission is re-checked at send time, not trusted', evidence: 'tests/smsworkflow.test.mjs M3' },
  {
    n: 10, name: 'Send a text to a designated recipient',
    evidence: 'tests/journeys.test.mjs J10',
    boundary: BLOCKED_BY.SMS_PROVIDER,
    demonstratedTo: 'the exact HTTP request the carrier would receive — endpoint, auth, recipient, sender, body and status-callback all asserted',
    toClear: 'Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_SMS_FROM in Vercel, and complete A2P 10DLC registration.',
  },
  {
    n: 11, name: 'A delivery receipt turns accepted into delivered',
    evidence: 'tests/sms-status.test.mjs S2/S3',
    boundary: BLOCKED_BY.SMS_PROVIDER,
    demonstratedTo: 'a signed carrier callback applied end to end through the real HTTP handler, including a forged one being refused',
    toClear: 'Same provider account. The callback URL is supplied automatically once PUBLIC_BASE_URL is set.',
  },
  {
    n: 12, name: 'An inbound reply pauses every channel and is classified',
    evidence: 'tests/sms-replies.test.mjs R1–R4, tests/journeys.test.mjs J12',
    boundary: BLOCKED_BY.SMS_PROVIDER,
    demonstratedTo: 'the carrier\'s own form payload driven through the real webhook, including STOP suppressing the number',
    toClear: 'Same provider account, with the inbound webhook pointed at /api/collect?hook=sms.',
  },
  { n: 13, name: 'The owner takes over and queued replies are cancelled', evidence: 'tests/sms-replies.test.mjs R9' },
  {
    n: 14, name: 'A booking through the scheduler reaches the dashboard',
    evidence: 'tests/journeys.test.mjs J14',
    boundary: BLOCKED_BY.SCHEDULER,
    demonstratedTo: 'a correctly signed Calendly payload verified, with a tampered body and a week-old replay both refused',
    toClear: 'Connect Calendly in Settings and set CALENDLY_WEBHOOK_KEY in Vercel.',
  },
]);

/**
 * How many journeys are demonstrated, how many stop at a boundary, and what
 * would clear each boundary.
 *
 * `complete` is false while any boundary remains. It is deliberately not a
 * percentage: "79% of journeys" invites rounding up, where "11 demonstrated,
 * 3 waiting on two accounts" tells the owner what to do.
 */
export function journeyStatus() {
  const atBoundary = JOURNEYS.filter((j) => j.boundary);
  const demonstrated = JOURNEYS.filter((j) => !j.boundary);
  const services = [...new Set(atBoundary.map((j) => j.boundary))];
  return {
    total: JOURNEYS.length,
    demonstrated: demonstrated.length,
    atBoundary: atBoundary.length,
    complete: atBoundary.length === 0,
    boundaries: atBoundary.map((j) => ({
      n: j.n, name: j.name, boundary: j.boundary,
      demonstratedTo: j.demonstratedTo, toClear: j.toClear,
    })),
    services,
    toComplete: atBoundary.length
      ? `Connect ${services.length === 1 ? 'the missing service' : `${services.length} services`}: ${services.join('; ')}.`
      : null,
    // the sentence that should appear wherever this is summarised
    headline: atBoundary.length
      ? `${demonstrated.length} of ${JOURNEYS.length} journeys demonstrated end to end; ${atBoundary.length} are demonstrated up to a service that is not connected.`
      : `All ${JOURNEYS.length} journeys demonstrated end to end.`,
  };
}
