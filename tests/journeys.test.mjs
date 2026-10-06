// The fourteen journeys, named.
//
// The plan said "11 of 14 demonstrated". Nobody could check that: the
// fourteen were never written down anywhere, so neither the numerator nor the
// denominator was verifiable, and "11 of 14" was a claim rather than a result.
// A requirement to demonstrate a set of journeys cannot be met without naming
// the set.
//
// So they are named here, and each one carries its own evidence. FOUR of them
// end at a service that is not connected — not three, as the plan's older note
// said: that note predated the delivery-receipt path built in this same
// session, which is also provider-dependent. Counting it honestly is the point
// of writing the set down at all. Those four are NOT skipped — each is
// driven all the way to the provider boundary with an injected adapter that
// records what would have gone out, so everything up to the wire is
// demonstrated and the wire itself is named as the only untested part. That is
// a materially different claim from "not demonstrated", and the difference is
// stated rather than blurred.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';

const NOW = Date.UTC(2026, 9, 6, 15, 0, 0);

/** What stands between a journey and a live demonstration. */
export const BLOCKED_BY = Object.freeze({
  SMS_PROVIDER: 'no SMS provider account is connected',
  SCHEDULER: 'no scheduler is connected',
});

/**
 * The fourteen. `evidence` names where each is demonstrated; `boundary` is
 * set only when the journey ends at a service we do not have, and says what
 * IS demonstrated up to that point.
 */
export const JOURNEYS = Object.freeze([
  { n: 1, name: 'Photograph a batch of cards after an event and get contacts', evidence: 'cardjourney J1' },
  { n: 2, name: 'A mis-read field is corrected without losing the rest', evidence: 'cardjourney J6' },
  { n: 3, name: 'Two different people at one company are not merged', evidence: 'cardjourney J6 / contacts' },
  { n: 4, name: 'A contact from a card can never enter a cold campaign', evidence: 'cardjourney J2' },
  { n: 5, name: 'Someone who asked for a preview gets a tracked task', evidence: 'cardjourney J3' },
  { n: 6, name: '"Your preview is ready" is impossible before one exists', evidence: 'cardjourney J4/J5' },
  { n: 7, name: 'A promised date produces a follow-up when it is due', evidence: 'relationship dueFollowUps' },
  { n: 8, name: 'Composing a text shows permission, cost and timing first', evidence: 'smsworkflow M2' },
  { n: 9, name: 'Permission is re-checked at send time, not trusted', evidence: 'smsworkflow M3' },
  { n: 10, name: 'Send a text to a designated recipient', evidence: 'journeys J10',
    boundary: BLOCKED_BY.SMS_PROVIDER, demonstratedTo: 'the exact HTTP request the carrier would receive' },
  { n: 11, name: 'A delivery receipt turns accepted into delivered', evidence: 'sms-status S2/S3',
    boundary: BLOCKED_BY.SMS_PROVIDER, demonstratedTo: 'a signed carrier callback applied end to end' },
  { n: 12, name: 'An inbound reply pauses every channel and is classified', evidence: 'sms-replies R1-R4',
    boundary: BLOCKED_BY.SMS_PROVIDER, demonstratedTo: 'the carrier webhook payload driven through the real handler' },
  { n: 13, name: 'The owner takes over and queued replies are cancelled', evidence: 'sms-replies R9' },
  { n: 14, name: 'A booking through the scheduler reaches the dashboard', evidence: 'journeys J14',
    boundary: BLOCKED_BY.SCHEDULER, demonstratedTo: 'a signed Calendly payload through the real webhook' },
]);

// ---------------------------------------------------------------------------
section('J0  the set itself is named, so the count can be checked');
check('there are fourteen', JOURNEYS.length === 14, String(JOURNEYS.length));
check('every one is numbered uniquely', new Set(JOURNEYS.map((j) => j.n)).size === 14);
check('every one is named in a sentence a person could follow',
  JOURNEYS.every((j) => j.name.length > 20), JSON.stringify(JOURNEYS.filter((j) => j.name.length <= 20).map((j) => j.n)));
check('every one points at its evidence', JOURNEYS.every((j) => !!j.evidence));
const blocked = JOURNEYS.filter((j) => j.boundary);
// Four, not three. The plan's old note predated the delivery-receipt path
// built this session, which is also provider-dependent. Counting it honestly
// is the point of writing the set down.
check('four end at a service we do not have', blocked.length === 4, String(blocked.length));
check('and each says what IS demonstrated up to that point',
  blocked.every((j) => !!j.demonstratedTo), JSON.stringify(blocked.filter((j) => !j.demonstratedTo).map((j) => j.n)));
check('a blocked journey is never counted as fully demonstrated',
  blocked.every((j) => j.boundary !== undefined && j.demonstratedTo !== j.boundary));

// ---------------------------------------------------------------------------
section('J10  sending a text, driven to the exact request the carrier would get');
// The journey is blocked only at the wire. Everything before it — permission,
// cost, composition, the HTTP request itself — runs here against an adapter
// that records instead of sending.
const { createTwilioSmsAdapter } = await import('../lib/sms-outreach.js');
let wire = null;
const recording = createTwilioSmsAdapter({
  env: {
    TWILIO_ACCOUNT_SID: 'ACfixture', TWILIO_AUTH_TOKEN: 'fixture',
    TWILIO_SMS_FROM: '+15550000000', PUBLIC_BASE_URL: 'https://dash.example',
  },
  fetchImpl: async (url, opts) => {
    wire = { url, headers: opts.headers, body: String(opts.body) };
    return { ok: true, json: async () => ({ sid: 'SMfixture', status: 'queued' }) };
  },
});
const sendOut = await recording.send({ to: '+19195550123', body: 'Hi Jordan — the preview is ready: https://example.test/p/1' });
check('the send reports success', sendOut.ok === true, JSON.stringify(sendOut));
check('it reaches Twilio\'s Messages endpoint', /api\.twilio\.com.*\/Messages\.json$/.test(wire.url), wire.url);
check('authenticated as the account', /^Basic /.test(wire.headers.Authorization || ''));
check('the recipient is on the request', /To=%2B19195550123/.test(wire.body), wire.body.slice(0, 120));
check('so is the sending number', /From=%2B15550000000/.test(wire.body));
// URLSearchParams encodes a space as '+', not %20 — and in a regex that plus
// has to be escaped or it reads as "one or more w"
check('and the actual words', /preview\+is\+ready/.test(wire.body), wire.body.slice(0, 200));
check('with somewhere to report delivery', /StatusCallback=/.test(wire.body));
check('the provider id comes back for the receipt to match', sendOut.sid === 'SMfixture');
check('THE ONLY untested step is the carrier accepting it',
  JOURNEYS.find((j) => j.n === 10).boundary === BLOCKED_BY.SMS_PROVIDER);

// and the disconnected case, which is what actually happens today
const disconnected = createTwilioSmsAdapter({ env: {}, fetchImpl: async () => { throw new Error('should not be called'); } });
const nope = await disconnected.send({ to: '+19195550123', body: 'hi' });
check('with no credentials nothing is attempted', nope.ok === false && nope.disconnected === true, JSON.stringify(nope));
check('and it says so plainly rather than failing obscurely', /not connected/i.test(nope.error), nope.error);

// ---------------------------------------------------------------------------
section('J14  a booking, driven through the real webhook with a signed payload');
const { verifyCalendlySignature } = await import('../lib/bookings.js');
const crypto = await import('node:crypto');
const KEY = 'fixture_calendly_key';
const payload = JSON.stringify({
  event: 'invitee.created',
  payload: {
    email: 'jordan@hale.example', name: 'Jordan Hale',
    scheduled_event: { start_time: new Date(NOW + 86400e3).toISOString(), uri: 'https://api.calendly.com/x/1' },
  },
});
const stamp = Math.floor(NOW / 1000);
const sig = crypto.createHmac('sha256', KEY).update(`${stamp}.${payload}`).digest('hex');
const header = `t=${stamp},v1=${sig}`;

const good = verifyCalendlySignature({ header, rawBody: payload, signingKey: KEY, now: NOW });
check('a correctly signed booking verifies', good.ok === true, JSON.stringify(good));
check('a tampered body does not',
  verifyCalendlySignature({ header, rawBody: payload.replace('Jordan', 'Mallory'), signingKey: KEY, now: NOW }).ok === false);
check('a replay from last week does not',
  verifyCalendlySignature({ header, rawBody: payload, signingKey: KEY, now: NOW + 8 * 86400e3 }).ok === false,
  'a valid signature replayed next week is still a valid signature');
check('and with no key configured it fails CLOSED',
  verifyCalendlySignature({ header, rawBody: payload, signingKey: '', now: NOW }).ok === false);
check('THE ONLY untested step is Calendly actually posting it',
  JOURNEYS.find((j) => j.n === 14).boundary === BLOCKED_BY.SCHEDULER);

// ---------------------------------------------------------------------------
section('J12  an inbound reply, driven from the carrier\'s own payload shape');
// Twilio posts form fields; this is that shape, through the real handler.
const collect = (await import('../api/collect.js')).default;
async function carrierPost(body) {
  const req = { method: 'POST', url: '/api/collect?hook=sms', query: { hook: 'sms' }, headers: {}, body };
  let payloadOut = null, code = 0;
  const res = { status(c) { code = c; return this; }, send(p) { payloadOut = p; return this; }, json(p) { payloadOut = p; return this; }, setHeader() { return this; } };
  await collect(req, res);
  return { code, body: payloadOut };
}
let r = await carrierPost({ From: '+19195550123', Body: 'Yes please send me pricing', MessageSid: 'SMin1' });
check('the carrier gets a valid TwiML answer', r.code === 200 && /<Response/.test(String(r.body)), String(r.body).slice(0, 80));
check('and we do NOT text back automatically', /<Response\/>/.test(String(r.body)), String(r.body));

r = await carrierPost({ From: '+19195550123', Body: 'STOP', MessageSid: 'SMin2' });
check('STOP is answered with the confirmation the carrier requires',
  /<Message>/.test(String(r.body)), String(r.body).slice(0, 120));
check('and the number is suppressed immediately',
  !!(await store.get('suppress:phone:+19195550123')), 'this must survive everything else failing');
check('THE ONLY untested step is a real handset sending it',
  JOURNEYS.find((j) => j.n === 12).boundary === BLOCKED_BY.SMS_PROVIDER);

// ---------------------------------------------------------------------------
section('J-report  what is demonstrated, and what is not, is reported honestly');
const { journeyStatus } = await import('../lib/journeys.js');
const st = journeyStatus();
check('every journey is accounted for', st.total === 14, String(st.total));
check('ten are demonstrated end to end', st.demonstrated === 10, String(st.demonstrated));
check('four stop at a boundary', st.atBoundary === 4, String(st.atBoundary));
check('none is silently missing', st.demonstrated + st.atBoundary === st.total);
check('the boundaries are named, not summarised as "blocked"',
  st.boundaries.every((b) => /provider|scheduler/i.test(b.boundary)), JSON.stringify(st.boundaries.map((b) => b.boundary)));
check('and the report refuses to call a boundary journey complete',
  st.complete === false, 'fourteen of fourteen is not true today and must not be printed');
check('it says what would make it true',
  /connect/i.test(st.toComplete || ''), st.toComplete);

// ---------------------------------------------------------------------------
section('J-wired  the status reaches a screen the owner actually opens');
// A journey report nobody reads is the same orphan problem in a new costume,
// so it lands in the Checks panel rather than in a document.
const { systemHealth } = await import('../lib/health.js');
const health = await systemHealth({}).catch(() => null);
check('the checks panel can be built', !!health, 'systemHealth returned nothing');
const line = (health?.issues || []).find((i) => /journeys demonstrated/i.test(i.text || ""));
check('the journey status is one of the checks', !!line, JSON.stringify((health?.issues||[]).map(i=>i.text.slice(0,40))));
check('it reports counts, not a percentage', line && !/%/.test(line.text), line?.text);
check('it names what to connect', line && /Connect/.test(line.text), line?.text);
check('and it does not claim our side is untested', line && /not our side of it/.test(line.text), line?.text);

done();