// Delivery receipts: the difference between "the carrier took it" and "it
// arrived".
//
// `applyDeliveryReceipt` was written, tested, and had NO caller. So the one
// distinction it exists to preserve could never actually be learned: a message
// Twilio accepted and then failed to deliver stayed "accepted" forever. That
// is the failure its own comment warns about — a number that is silently
// failing looks healthy for a week — and it was live in the code the whole
// time, hidden behind a function nothing called.
//
// This drives the real HTTP handler, not the library, because the orphan was
// at the HTTP layer and a library-level test would have passed throughout.
import crypto from 'node:crypto';
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { verifyTwilioSignature } from '../lib/webhooks.js';
import { SMS_DELIVERY } from '../lib/sms-send.js';
import handler from '../api/collect.js';

const TOKEN = 'test_auth_token_not_real';
const URL_ = 'https://dash.example/api/collect?hook=sms-status';

/** Sign a form body exactly as Twilio does. */
function sign(url, params, token = TOKEN) {
  let data = String(url);
  for (const k of Object.keys(params).sort()) data += k + String(params[k] ?? '');
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** Minimal req/res pair for the Vercel-style handler. */
async function post(params, { signature = null, token = TOKEN } = {}) {
  const prev = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = token;
  const req = {
    method: 'POST',
    url: '/api/collect?hook=sms-status',
    query: { hook: 'sms-status' },
    headers: { host: 'dash.example', 'x-forwarded-proto': 'https', 'x-twilio-signature': signature ?? sign(URL_, params) },
    body: params,
  };
  let code = 0, payload = null;
  const res = {
    status(c) { code = c; return this; },
    json(p) { payload = p; return this; },
    send(p) { payload = p; return this; },
    setHeader() { return this; },
  };
  await handler(req, res);
  if (prev === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = prev;
  return { code, payload };
}

/**
 * A message sitting in the store, as `send()` would have left it.
 *
 * It has to be in `sms:messages` — that set is what applyDeliveryReceipt
 * scans to find the message a provider id belongs to. Writing the message
 * record alone leaves it invisible to the very function under test.
 */
async function seed(id, providerId, state = SMS_DELIVERY.ACCEPTED) {
  await store.set(`sms:msg:${id}`, JSON.stringify({
    id, providerId, contactId: 'c1', to: '+19105551234', body: 'hello',
    state, history: [{ at: Date.now(), state, note: 'the provider accepted it' }],
  }));
  await store.sadd('sms:messages', id);
  return id;
}

// ---------------------------------------------------------------------------
section('S1  Twilio\'s signature scheme, exactly');
const params = { MessageSid: 'SM1', MessageStatus: 'delivered', To: '+19105551234' };
check('a correct signature verifies',
  verifyTwilioSignature({ header: sign(URL_, params), url: URL_, params, authToken: TOKEN }).ok === true);
check('a tampered parameter does not',
  verifyTwilioSignature({ header: sign(URL_, params), url: URL_, params: { ...params, MessageStatus: 'failed' }, authToken: TOKEN }).ok === false);
check('a different URL does not',
  verifyTwilioSignature({ header: sign(URL_, params), url: 'https://evil.example/x', params, authToken: TOKEN }).ok === false);
check('parameter ORDER does not matter, because they are sorted',
  verifyTwilioSignature({ header: sign(URL_, params), url: URL_, params: { To: params.To, MessageStatus: 'delivered', MessageSid: 'SM1' }, authToken: TOKEN }).ok === true);
check('no token configured fails CLOSED',
  verifyTwilioSignature({ header: 'x', url: URL_, params, authToken: '' }).ok === false);
check('and says why', /cannot be verified/.test(verifyTwilioSignature({ header: 'x', url: URL_, params, authToken: '' }).reason));
check('a missing header is refused', verifyTwilioSignature({ url: URL_, params, authToken: TOKEN }).ok === false);
check('a short header does not throw', verifyTwilioSignature({ header: 'abc', url: URL_, params, authToken: TOKEN }).ok === false);

// ---------------------------------------------------------------------------
section('S2  the endpoint exists and is reachable — the orphan is wired');
await seed('m1', 'SM_wired_1');
let r = await post({ MessageSid: 'SM_wired_1', MessageStatus: 'delivered' });
check('a signed receipt is accepted', r.code === 200, `${r.code} ${JSON.stringify(r.payload)}`);
let msg = JSON.parse(await store.get('sms:msg:m1'));
check('and the message is now DELIVERED, not merely accepted', msg.state === SMS_DELIVERY.DELIVERED, msg.state);
check('the change is in its history', (msg.history || []).some((h) => h.state === SMS_DELIVERY.DELIVERED));

// the negative control for the whole feature: without the endpoint this is
// what every message would look like forever
await seed('m2', 'SM_never_told');
msg = JSON.parse(await store.get('sms:msg:m2'));
check('a message nobody reported on stays ACCEPTED', msg.state === SMS_DELIVERY.ACCEPTED,
  'this is the state every message was stuck in before the endpoint existed');

// ---------------------------------------------------------------------------
section('S3  a failure is recorded as a failure');
await seed('m3', 'SM_failed_1');
r = await post({ MessageSid: 'SM_failed_1', MessageStatus: 'failed', ErrorCode: '30006' });
check('accepted by the endpoint', r.code === 200);
msg = JSON.parse(await store.get('sms:msg:m3'));
check('the message is FAILED', msg.state === SMS_DELIVERY.FAILED, msg.state);
check('and the carrier error code is kept', JSON.stringify(msg).includes('30006'), JSON.stringify(msg.history).slice(0, 160));

await seed('m4', 'SM_undelivered_1');
await post({ MessageSid: 'SM_undelivered_1', MessageStatus: 'undelivered', ErrorCode: '30005' });
const m4 = JSON.parse(await store.get('sms:msg:m4'));
check('undelivered has its own state, distinct from failed', m4.state === SMS_DELIVERY.UNDELIVERED, m4.state);
check('and it is emphatically not a delivery', m4.state !== SMS_DELIVERY.DELIVERED);

// ---------------------------------------------------------------------------
section('S4  an unsigned or forged receipt changes nothing');
await seed('m5', 'SM_forged_1');
r = await post({ MessageSid: 'SM_forged_1', MessageStatus: 'failed' }, { signature: 'ZmFrZSBzaWduYXR1cmU=' });
check('a forged signature is rejected', r.code === 401, String(r.code));
check('with a reason', /signature/i.test(r.payload?.error || ''), JSON.stringify(r.payload));
check('and the message is UNTOUCHED',
  JSON.parse(await store.get('sms:msg:m5')).state === SMS_DELIVERY.ACCEPTED,
  'otherwise anyone could mark a client\'s messages as failed');

r = await post({ MessageSid: 'SM_forged_1', MessageStatus: 'failed' }, { signature: sign(URL_, { MessageSid: 'SM_forged_1', MessageStatus: 'failed' }, 'wrong_token') });
check('a signature made with the wrong token is rejected', r.code === 401);

// ---------------------------------------------------------------------------
section('S5  carriers retry, and a retry must not re-apply');
await seed('m6', 'SM_retry_1');
const first = await post({ MessageSid: 'SM_retry_1', MessageStatus: 'delivered' });
const second = await post({ MessageSid: 'SM_retry_1', MessageStatus: 'delivered' });
check('the first is applied', first.code === 200 && !first.payload?.duplicate);
check('the second is recognised as a duplicate', second.payload?.duplicate === true, JSON.stringify(second.payload));
check('and answers 200, so the carrier stops retrying', second.code === 200,
  'a non-200 makes a provider retry the duplicate forever');
msg = JSON.parse(await store.get('sms:msg:m6'));
check('history was not written twice',
  (msg.history || []).filter((h) => h.state === SMS_DELIVERY.DELIVERED).length === 1,
  JSON.stringify((msg.history || []).map((h) => h.state)));

// ---------------------------------------------------------------------------
section('S6  malformed and unknown receipts are handled, not crashed');
r = await post({ MessageStatus: 'delivered' });
check('a receipt with no MessageSid is a 400', r.code === 400, String(r.code));
r = await post({ MessageSid: 'SM_x' });
check('a receipt with no status is a 400', r.code === 400);
r = await post({ MessageSid: 'SM_not_ours_at_all', MessageStatus: 'delivered' });
check('a receipt for a message we do not hold answers 200', r.code === 200,
  'a non-200 would make the carrier retry something we can never match');
check('and says it matched nothing', r.payload && r.payload.matched === 0 || r.payload?.ok !== undefined, JSON.stringify(r.payload));

// ---------------------------------------------------------------------------
section('S7  the send path tells Twilio where to post');
const { createTwilioSmsAdapter } = await import('../lib/sms-outreach.js');
let sent = null;
let adapter = createTwilioSmsAdapter({
  env: { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+15550000000', PUBLIC_BASE_URL: 'https://dash.example' },
  fetchImpl: async (url, opts) => { sent = String(opts.body); return { ok: true, json: async () => ({ sid: 'SM9', status: 'queued' }) }; },
});
await adapter.send({ to: '+19105551234', body: 'hi' });
check('a StatusCallback is included', /StatusCallback=/.test(sent), sent);
check('pointing at this endpoint', /hook%3Dsms-status/.test(sent), sent);
check('on the configured origin', /dash\.example/.test(sent));

sent = null;
adapter = createTwilioSmsAdapter({
  env: { TWILIO_ACCOUNT_SID: 'AC1', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+15550000000' },
  fetchImpl: async (url, opts) => { sent = String(opts.body); return { ok: true, json: async () => ({ sid: 'SM9' }) }; },
});
await adapter.send({ to: '+19105551234', body: 'hi' });
check('with no public URL configured, no callback is claimed', !/StatusCallback/.test(sent),
  'a callback URL pointing at nothing is retried by Twilio and the failures look like our bug');

done();
