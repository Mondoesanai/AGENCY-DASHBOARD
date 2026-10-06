// The opt-in path under every ordering that could grant the wrong thing.
//
// R18.1. Driven through the REAL HTTP boundary, because the defect this file
// exists for was invisible from the module side.
//
// THE DEFECT. R17.2 made the web form grant nothing, reasoning that only a
// message FROM the handset proves possession — "the one thing a web page cannot
// fake". But `/api/collect?hook=sms` had no signature check, so anyone could
// POST `From=<somebody else's number>&Body=PREVIEW` and be granted PROMOTIONAL
// consent for a number they did not own. The possession channel was itself
// forgeable, which made the fix decorative. Worse than the hole it closed: the
// form only ever created a pending record; this granted the real permission.
//
// Everything here uses reserved/unassigned numbers and `.test` addresses, and
// no number is printed in any assertion message.
import crypto from 'node:crypto';
import { check, section, done } from './world.mjs';
import { startLocalApi } from './harness/local-api.mjs';
import { store } from '../lib/store.js';
import { upsertContact, getContact, field } from '../lib/contacts.js';
import { mayText } from '../lib/phone.js';
import { pendingWebOptIn, recordWebOptIn, OPTIN_KEYWORD } from '../lib/optin-public.js';

const TOKEN = 'test-auth-token';
const api = await startLocalApi();

// A real Twilio signature: HMAC-SHA1 over the full URL plus every parameter,
// sorted by name and concatenated without separators, base64.
const sign = (url, params) => {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + String(params[k] ?? ''), String(url));
  return crypto.createHmac('sha1', TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
};
const inbound = async (params, { signed = true, host = 'localhost' } = {}) => {
  const path = '/api/collect?hook=sms';
  const url = `https://${host}${path}`;
  return api.request(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': host,
      ...(signed ? { 'x-twilio-signature': sign(url, params) } : {}),
    },
    body: new URLSearchParams(params).toString(),
  });
};

// Unassigned 555 numbers — real enough to validate, nobody's to ring.
const N = (n) => `+121455577${String(n).padStart(2, '0')}`;
const mk = async (id, phone, i) => {
  await upsertContact({
    id, name: field(`Person ${i}`, 't'), business: field(`Business ${i}`, 't'),
    email: field(`${id}@example.invalid`, 't'), phone: field(phone, 't'),
  });
  return getContact(id);
};
const promoOk = async (id) => (await mayText({ contact: await getContact(id), purpose: 'promotional' })).ok;

const envWas = process.env.TWILIO_AUTH_TOKEN;
process.env.TWILIO_AUTH_TOKEN = TOKEN;

// ---------------------------------------------------------------------------
section('O1  THE DEFECT: an unsigned inbound cannot grant anything');
const victim = N(1);
await mk('oo_victim', victim, 1);
check('they start with no promotional permission', (await promoOk('oo_victim')) === false);

const forged = await inbound({ From: victim, Body: OPTIN_KEYWORD, MessageSid: 'SMforged1' }, { signed: false });
check('an unsigned inbound is refused', forged.status === 401, `${forged.status}`);
check('AND NO PERMISSION WAS GRANTED', (await promoOk('oo_victim')) === false,
  'this is the whole point: the possession channel must not be forgeable');

const badSig = await api.request('/api/collect?hook=sms', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'not-a-signature', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'localhost' },
  body: new URLSearchParams({ From: victim, Body: OPTIN_KEYWORD, MessageSid: 'SMforged2' }).toString(),
});
check('a wrong signature is refused too', badSig.status === 401, `${badSig.status}`);
check('still no permission', (await promoOk('oo_victim')) === false);

section('O1b  NEGATIVE CONTROL: a correctly signed inbound DOES work');
// Without this, a hook that refused everything would look identical.
const genuine = await inbound({ From: victim, Body: OPTIN_KEYWORD, MessageSid: 'SMgenuine1' });
check('a signed inbound is accepted', genuine.status === 200, `${genuine.status}`);
check('and the permission is granted', (await promoOk('oo_victim')) === true);

section('O1c  and it fails CLOSED with no token configured');
delete process.env.TWILIO_AUTH_TOKEN;
const noToken = await inbound({ From: N(2), Body: OPTIN_KEYWORD, MessageSid: 'SMnotoken' });
check('with no TWILIO_AUTH_TOKEN the inbound is refused', noToken.status === 401, `${noToken.status}`);
check('and the refusal names the missing token', /TWILIO_AUTH_TOKEN/.test(noToken.json?.error || ''),
  JSON.stringify(noToken.json).slice(0, 120));
process.env.TWILIO_AUTH_TOKEN = TOKEN;

// ---------------------------------------------------------------------------
section('O2  a replayed inbound is processed once');
await mk('oo_replay', N(3), 3);
const sid = 'SMreplay1';
const first = await inbound({ From: N(3), Body: OPTIN_KEYWORD, MessageSid: sid });
check('the first delivery is accepted', first.status === 200);
const before = ((await getContact('oo_replay')).consentLog || []).length;
const replay = await inbound({ From: N(3), Body: OPTIN_KEYWORD, MessageSid: sid });
check('the retry is accepted by the carrier', replay.status === 200, `${replay.status}`);
check('but adds no second consent record',
  ((await getContact('oo_replay')).consentLog || []).length === before, 'a carrier retry must not double-record');

// ---------------------------------------------------------------------------
section('O3  an unrelated inbound is NOT consent, pending record or not');
const curious = N(4);
await mk('oo_curious', curious, 4);
await recordWebOptIn({ phone: curious, agreed: true, pageUrl: 'https://x.invalid/optin' });
check('a pending record exists', !!(await pendingWebOptIn(curious)));

for (const text of ['yes', 'ok sure', 'sounds good', 'send me a preview', 'YES PLEASE', 'y']) {
  await inbound({ From: curious, Body: text, MessageSid: `SMu${Math.random().toString(36).slice(2, 8)}` });
  check(`"${text}" does not become promotional consent`, (await promoOk('oo_curious')) === false,
    'only the exact published keyword confirms; anything else is a reply for a person');
}
check('and the pending record is still pending, not consumed', !!(await pendingWebOptIn(curious)));

section('O3b  the exact keyword, from that number, does confirm');
await inbound({ From: curious, Body: OPTIN_KEYWORD, MessageSid: 'SMconfirm4' });
check('now it is promotional', (await promoOk('oo_curious')) === true);
const rec = ((await getContact('oo_curious')).consentLog || []).slice(-1)[0];
check('the terms version is stored', rec.wordingVersion === 'public-optin-v1', rec.wordingVersion);
check('the inbound evidence is stored', /confirmed from/.test(rec.evidence), 'evidence must cite the message');
check('and the form submission is cited too', /form submitted/.test(rec.evidence));
check('the pending record is consumed', (await pendingWebOptIn(curious)) === null);

section('O3c  the keyword from a DIFFERENT number does not confirm it');
const other = N(5);
await mk('oo_other', other, 5);
const pendingFor = N(6);
await mk('oo_pending', pendingFor, 6);
await recordWebOptIn({ phone: pendingFor, agreed: true });
await inbound({ From: other, Body: OPTIN_KEYWORD, MessageSid: 'SMcross1' });
check('the other number got its own permission', (await promoOk('oo_other')) === true);
check('but the pending one did NOT', (await promoOk('oo_pending')) === false,
  'the pending record is keyed to its own number; another handset cannot confirm it');
check('and its pending record is untouched', !!(await pendingWebOptIn(pendingFor)));

// ---------------------------------------------------------------------------
section('O4  STOP and suppression outrank any pending enrolment');
const stopper = N(7);
await mk('oo_stop', stopper, 7);
await recordWebOptIn({ phone: stopper, agreed: true });
await inbound({ From: stopper, Body: 'STOP', MessageSid: 'SMstop1' });
check('STOP is honoured', (await promoOk('oo_stop')) === false);
await inbound({ From: stopper, Body: OPTIN_KEYWORD, MessageSid: 'SMstop2' });
check('the keyword afterwards does NOT re-enrol', (await promoOk('oo_stop')) === false,
  'a standing STOP is not overturned by one word');

section('O4b  a form submitted AFTER a STOP creates no pending record');
const after = await recordWebOptIn({ phone: stopper, agreed: true });
check('the form refuses', after.ok === false);
check('and no pending record is created', (await pendingWebOptIn(stopper)) === null);

section('O4c  a wrong-number reply suppresses the number');
const wrong = N(8);
await mk('oo_wrong', wrong, 8);
await inbound({ From: wrong, Body: OPTIN_KEYWORD, MessageSid: 'SMwrong0' });
check('they are enrolled first', (await promoOk('oo_wrong')) === true);
await inbound({ From: wrong, Body: 'you have the wrong number', MessageSid: 'SMwrong1' });
check('a wrong-number statement stops texting that number', (await promoOk('oo_wrong')) === false,
  'the number is wrong even though the business may be right');

// ---------------------------------------------------------------------------
section('O5  an expired pending record does not quietly confirm');
const expired = N(9);
await mk('oo_expired', expired, 9);
await recordWebOptIn({ phone: expired, agreed: true });
await store.del(`optin:pending:${expired}`); // what the 7-day TTL does
check('the pending record is gone', (await pendingWebOptIn(expired)) === null);
await inbound({ From: expired, Body: OPTIN_KEYWORD, MessageSid: 'SMexp1' });
check('the keyword still works on its own', (await promoOk('oo_expired')) === true,
  'texting the published keyword is a valid opt-in by itself');
const expRec = ((await getContact('oo_expired')).consentLog || []).slice(-1)[0];
check('but it is recorded as keyword-only, not as a confirmed form',
  !/form submitted/.test(expRec.evidence),
  'citing an expired form as evidence would overstate what happened');

// ---------------------------------------------------------------------------
section('O6  a one-time follow-up stays separate from recurring consent');
const { recordPermission } = await import('../lib/optin.js');
const onetime = N(10);
const c10 = await mk('oo_onetime', onetime, 10);
await recordPermission(c10, { source: 'asked at the counter', wording: 'text me the preview', evidence: 'card #150' });
check('a one-time follow-up is allowed',
  (await mayText({ contact: await getContact('oo_onetime'), purpose: 'one_time_followup' })).ok === true);
check('recurring promotional is still refused', (await promoOk('oo_onetime')) === false);

// ---------------------------------------------------------------------------
section('O7  enrolment fails CLOSED when the rate-limit store is unreadable');
// The previous design failed OPEN here, justified as preserving opt-out. That
// was wrong: opt-out arrives at ?hook=sms, which is not rate-limited at all. So
// failing open only ever made NEW enrolment easier during an outage — the one
// moment when nothing about it can be checked.
const realIncr = store.incr;
store.incr = async () => { throw new Error('kv down'); };
const degraded = await api.post('/api/collect?hook=optin', { phone: '2145557799', agreed: true });
check('the public form refuses during a store outage', degraded.status === 503, `${degraded.status}`);
check('and says it is retryable rather than blaming the person',
  degraded.json?.retryable === true, JSON.stringify(degraded.json).slice(0, 120));

section('O7b  …but STOP still gets through, because it never touches the limiter');
const stopDuringOutage = await inbound({ From: N(11), Body: 'STOP', MessageSid: 'SMoutage1' });
check('a STOP during the same outage is still accepted', stopDuringOutage.status === 200, `${stopDuringOutage.status}`);
store.incr = realIncr;

section('O7c  NEGATIVE CONTROL: the form works again once the store is back');
const recovered = await api.post('/api/collect?hook=optin', { phone: '2145557798', agreed: true });
check('a normal submission is accepted', recovered.status === 200, `${recovered.status}`);

// ---------------------------------------------------------------------------
section('O8  the page does not promise a keyword when nothing is configured');
const fromWas = process.env.TWILIO_SMS_FROM;
delete process.env.TWILIO_SMS_FROM;
const unconfigured = await api.request('/api/collect?hook=optin-terms');
check('the terms still load', unconfigured.status === 200);
check('but SMS is reported as not live', unconfigured.json?.smsLive === false, String(unconfigured.json?.smsLive));
check('and no number is offered to text', unconfigured.json?.to === null,
  'offering a number that does not answer is worse than offering none');
check('the terms themselves are still published', /Message and data rates/.test(unconfigured.json?.terms || ''),
  'the programme is still described; only the promise that it works today is withheld');
if (fromWas) process.env.TWILIO_SMS_FROM = fromWas;

process.env.TWILIO_AUTH_TOKEN = envWas;
await api.stop();
done();
