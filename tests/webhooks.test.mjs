// R11.5 — one discipline for every webhook, and R6.6/R6.8 delivery events.
import crypto from 'node:crypto';
import { W, check, section, done } from './world.mjs';
import {
  verifySignature, parseTimestampedHeader, parseBareHeader,
  claimEventOnce, isNewer, acceptWebhook, DEFAULT_TOLERANCE_SEC,
} from '../lib/webhooks.js';
import { DELIVERY_EVENTS, applyDeliveryEvent, isSuppressed } from '../lib/outreach-email.js';
import { upsertContact, field, canContact } from '../lib/contacts.js';
import { createCampaign, addMember, getMember, CAMPAIGN_TYPES, MEMBER_STATE } from '../lib/campaigns.js';
import collectHandler from '../api/collect.js';

const KEY = 'hook-key';
const E = (v) => field(v, { confidence: 1, source: 'manual' });
const sign = (body, ts) => {
  const t = ts ?? Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', KEY).update(`${t}.${body}`).digest('hex')}`;
};
const mkRes = () => ({ code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, end() { return this; } });

// ---------------------------------------------------------------------------
section('W1  all four checks, and each one independently');
const body = JSON.stringify({ id: 'evt-1', type: 'bounced', email: 'a@b.test' });

check('a valid signature passes', verifySignature({ header: sign(body), rawBody: body, signingKey: KEY }).ok === true);
check('a wrong key fails', verifySignature({ header: sign(body), rawBody: body, signingKey: 'other' }).ok === false);
check('a tampered body fails', verifySignature({ header: sign(body), rawBody: body + 'x', signingKey: KEY }).ok === false);
check('a missing header fails', verifySignature({ rawBody: body, signingKey: KEY }).ok === false);

// fail closed
let v = verifySignature({ header: sign(body), rawBody: body, signingKey: null });
check('no configured key means nothing is trusted', v.ok === false && v.failClosed === true, JSON.stringify(v));
check('and it says so rather than silently allowing', /no signing key is configured/.test(v.reason));

// freshness
v = verifySignature({ header: sign(body, Math.floor(Date.now() / 1000) - 3600), rawBody: body, signingKey: KEY });
check('an hour-old signature is refused', v.ok === false && v.replay === true);
check('and the reason explains why a valid signature is not enough', /replayed later is still a valid signature/.test(v.reason), v.reason);
check('the default window is minutes, not hours', DEFAULT_TOLERANCE_SEC <= 600, String(DEFAULT_TOLERANCE_SEC));

// header shapes
check('the t=,v1= shape parses', parseTimestampedHeader('t=123,v1=abc').signature === 'abc');
check('a bare sha256= header parses', parseBareHeader('sha256=deadbeef').signature === 'deadbeef');

// ---------------------------------------------------------------------------
section('W2  the same event is applied at most once');
let c = await claimEventOnce('test', 'evt-100');
check('the first claim is fresh', c.fresh === true);
c = await claimEventOnce('test', 'evt-100');
check('the second is not', c.fresh === false);
check('and it says it was already processed', /already processed/.test(c.reason));
check('an event with no id is refused rather than risking a double apply', (await claimEventOnce('test', null)).fresh === false);
check('different scopes do not collide', (await claimEventOnce('other-scope', 'evt-100')).fresh === true);

// ---------------------------------------------------------------------------
section('W3  out-of-order events cannot undo newer ones');
const t = Date.now();
check('the first event for a subject applies', (await isNewer('test', 'subject-1', t)).newer === true);
check('a newer one applies', (await isNewer('test', 'subject-1', t + 1000)).newer === true);
let o = await isNewer('test', 'subject-1', t - 5000);
check('an OLDER one is ignored', o.newer === false, JSON.stringify(o));
check('and it says what is already applied', /newer update for this record is already applied/.test(o.reason), o.reason);
check('a different subject has its own watermark', (await isNewer('test', 'subject-2', t - 5000)).newer === true);

// ---------------------------------------------------------------------------
section('W4  acceptWebhook refuses correctly, and with the right status code');
let a = await acceptWebhook({ scope: 'w4', header: sign(body), rawBody: body, signingKey: KEY, eventId: 'w4-1' });
check('a good webhook is accepted', a.accept === true && a.status === 200, JSON.stringify(a));

a = await acceptWebhook({ scope: 'w4', header: sign(body), rawBody: body, signingKey: KEY, eventId: 'w4-1' });
check('a duplicate is refused', a.accept === false && a.duplicate === true);
// the status code matters: an error makes the provider retry the duplicate forever
check('but answered 200, so the provider stops retrying it', a.status === 200, String(a.status));

a = await acceptWebhook({ scope: 'w4', header: 'garbage', rawBody: body, signingKey: KEY, eventId: 'w4-2' });
check('a bad signature is a 401', a.accept === false && a.status === 401, String(a.status));

await acceptWebhook({ scope: 'w4', header: sign(body), rawBody: body, signingKey: KEY, eventId: 'w4-3', subject: 'thing', stamp: t + 10000 });
a = await acceptWebhook({ scope: 'w4', header: sign(body), rawBody: body, signingKey: KEY, eventId: 'w4-4', subject: 'thing', stamp: t });
check('an out-of-order event is refused', a.accept === false && a.outOfOrder === true, JSON.stringify(a));
check('also with 200, for the same reason', a.status === 200);

// ---------------------------------------------------------------------------
section('W5  a bounce or complaint is an instruction, not telemetry');
const contact = (await upsertContact({ source: 'discovery', name: E('Bounce Co'), businessName: E('Bounce Co'), email: E('bouncer@test.test') })).contact;
const camp = (await createCampaign({ name: 'delivery test', type: CAMPAIGN_TYPES.COLD_NO_SITE })).campaign;
await addMember(camp.id, contact);
check('they are contactable first', (await canContact(contact, { channel: 'email', purpose: 'promotional' })).ok === true);

let d = await applyDeliveryEvent({ type: DELIVERY_EVENTS.DELIVERED, email: 'bouncer@test.test' });
check('a delivery is counted', d.counted === true);
check('and changes nothing', d.changedState === false);

d = await applyDeliveryEvent({ type: DELIVERY_EVENTS.OPENED, email: 'bouncer@test.test' });
check('an open is counted but means nothing on its own', d.changedState === false && /means nothing on its own/.test(d.note), d.note);

d = await applyDeliveryEvent({ type: DELIVERY_EVENTS.BOUNCED, email: 'bouncer@test.test', hard: false });
check('a SOFT bounce does not suppress', d.changedState === false, JSON.stringify(d));
check('and says why', /temporary/.test(d.note), d.note);

d = await applyDeliveryEvent({ type: DELIVERY_EVENTS.BOUNCED, email: 'bouncer@test.test', hard: true });
check('a HARD bounce suppresses the address', d.suppressed === 'bouncer@test.test', JSON.stringify(d));
check('globally, not just in one campaign', d.globallySuppressed === true);
check('and the note says so', /every campaign, not only the one/.test(d.note), d.note);
check('the address is now suppressed', (await isSuppressed('bouncer@test.test')).suppressed === true);
check('their pending sends are stopped', (await getMember(camp.id, contact.id)).state === MEMBER_STATE.STOPPED);

const refetched = (await upsertContact({ source: 'discovery', name: E('Bounce Co'), businessName: E('Bounce Co'), email: E('bouncer@test.test') })).contact;
check('and the consent gate now refuses them', (await canContact(refetched, { channel: 'email', purpose: 'promotional' })).ok === false);

// a complaint is treated as strongly as an unsubscribe
const c2 = (await upsertContact({ source: 'discovery', name: E('Spam Co'), businessName: E('Spam Co'), email: E('complainer@test.test') })).contact;
d = await applyDeliveryEvent({ type: DELIVERY_EVENTS.COMPLAINED, email: 'complainer@test.test' });
check('a complaint suppresses', d.globallySuppressed === true, JSON.stringify(d));
check('an unknown event type is refused', (await applyDeliveryEvent({ type: 'nonsense', email: 'x@y.test' })).ok === false);
check('an event with no address is refused', (await applyDeliveryEvent({ type: DELIVERY_EVENTS.BOUNCED })).ok === false);

// ---------------------------------------------------------------------------
section('W6  through the real public endpoint');
process.env.OUTREACH_WEBHOOK_KEY = KEY;
const evt = JSON.stringify({ id: 'live-1', type: 'bounced', email: 'endpoint@test.test', at: Date.now() });

let res = mkRes();
await collectHandler({ method: 'POST', query: { hook: 'delivery' }, body: evt, headers: {}, }, res);
check('an unsigned delivery webhook is rejected', res.code === 401, String(res.code));
check('and no suppression happened', (await isSuppressed('endpoint@test.test')).suppressed === false);

res = mkRes();
await collectHandler({ method: 'POST', query: { hook: 'delivery' }, body: evt, headers: { 'x-webhook-signature': sign(evt) } }, res);
check('a signed one is accepted', res.code === 200, JSON.stringify(res.body).slice(0, 120));
check('and the address is suppressed', (await isSuppressed('endpoint@test.test')).suppressed === true);

res = mkRes();
await collectHandler({ method: 'POST', query: { hook: 'delivery' }, body: evt, headers: { 'x-webhook-signature': sign(evt) } }, res);
check('a replayed identical event is not applied twice', res.body.error && /already processed/.test(res.body.error), JSON.stringify(res.body));
check('and still answers 200 so the provider stops retrying', res.code === 200);

// with no key configured nothing is trusted, even correctly signed
delete process.env.OUTREACH_WEBHOOK_KEY;
res = mkRes();
await collectHandler({ method: 'POST', query: { hook: 'delivery' }, body: evt, headers: { 'x-webhook-signature': sign(evt) } }, res);
check('with no key configured the webhook is refused', res.code === 401, String(res.code));
process.env.OUTREACH_WEBHOOK_KEY = KEY;

check('no email was sent anywhere in this suite', W.emails.length === 0, String(W.emails.length));

done();
