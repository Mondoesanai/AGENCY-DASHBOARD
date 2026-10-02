// R6.11 — the SMS adapter and its registration, built and left disconnected.
//
// "Left disconnected" is the easiest requirement to fake: ship nothing, say it
// is off. So the checks here are about the opposite — that the thing is real
// enough to connect later, and that every door is shut now:
//
//   * the real provider call exists and is correct, and is unreachable;
//   * the registration the carriers actually require is modelled item by item,
//     with who can supply each, so connecting it is supplying facts rather
//     than rediscovering requirements;
//   * nothing in code can mark it approved or switch it on;
//   * the owner-alert texter is not quietly reused for prospects.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  SMS_STATE, REGISTRATION_REQUIREMENTS, SMS_PROVIDER, SMS_REFUSAL,
  sampleMessages, getRegistration, saveRegistration, recordCarrierDecision,
  registrationStatus, createTwilioSmsAdapter, createDisconnectedSmsAdapter,
  getSmsAdapter, smsReadiness, sendProspectSms,
} from '../lib/sms-outreach.js';
import { renderSms } from '../public/acquisition.js';

const reset = async () => { await store.set('sms:registration', '').catch(() => {}); };
const FULL_ENV = {
  TWILIO_ACCOUNT_SID: 'ACtest', TWILIO_AUTH_TOKEN: 'tok', TWILIO_SMS_FROM: '+15550002222',
  TWILIO_FROM: '+15550001111',
};

// ---------------------------------------------------------------------------
section('S1  the registration carriers actually require is modelled');
await reset();
check('every requirement is listed', REGISTRATION_REQUIREMENTS.length >= 8, String(REGISTRATION_REQUIREMENTS.length));
for (const r of REGISTRATION_REQUIREMENTS) {
  check(`${r.id} says who supplies it`, r.who === 'owner' || r.who === 'builder', r.who);
  check(`${r.id} explains what it means`, r.what.length > 20, r.what);
}
check('the EIN is required', REGISTRATION_REQUIREMENTS.some((r) => r.id === 'ein'));
check('sample messages are required', REGISTRATION_REQUIREMENTS.some((r) => r.id === 'sample-messages'));
// the one that cannot be fudged
const optIn = REGISTRATION_REQUIREMENTS.find((r) => r.id === 'opt-in-description');
check('the opt-in description is required', !!optIn);
check('and is described as a sworn statement about real consent', /sworn|cannot be fudged/.test(optIn?.what || ''), optIn?.what);
check('most items are the owner\'s to supply, not the builder\'s',
  REGISTRATION_REQUIREMENTS.filter((r) => r.who === 'owner').length > REGISTRATION_REQUIREMENTS.filter((r) => r.who === 'builder').length);

const samples = sampleMessages({ business: 'Inspiring Websites LLC', ownerName: 'Mondo' });
check('sample messages are generated', samples.length >= 2);
check('and every one carries the opt-out wording', samples.every((m) => /STOP/.test(m)), samples.join(' | '));
check('they name the business, as the carriers require', samples.every((m) => m.includes('Inspiring Websites LLC')));

// ---------------------------------------------------------------------------
section('S2  nothing in code can mark the registration approved');
await reset();
let st = await registrationStatus();
check('it starts not-started', st.state === SMS_STATE.NOT_STARTED && st.approved === false, st.state);
check('and every fact is listed as missing', st.missing.length === REGISTRATION_REQUIREMENTS.length);

await saveRegistration({ ein: '12-3456789', 'legal-entity': 'Inspiring Websites LLC' });
st = await registrationStatus();
check('supplying facts moves it to drafted', st.state === SMS_STATE.DRAFTED, st.state);
check('and counts what is supplied', st.supplied === 2, `${st.supplied}/${st.total}`);
check('but it is still NOT approved', st.approved === false);

// the important one
await saveRegistration({ state: 'approved', approved: 'yes', ein: '12-3456789' });
st = await registrationStatus();
check('writing "approved" as a field does not approve it', st.approved === false, st.state);

let dec = await recordCarrierDecision({ approved: true, reference: '' });
check('an approval with no carrier reference is refused', dec.ok === false, JSON.stringify(dec));
check('and says why a bare flag is not evidence', /just a flag we set ourselves/.test(dec.error), dec.error);
dec = await recordCarrierDecision({ approved: true, reference: 'BN-12345' });
check('an approval with a reference is recorded', dec.ok === true && dec.state === SMS_STATE.APPROVED);
check('and the reference is kept', (await registrationStatus()).reference === 'BN-12345');
dec = await recordCarrierDecision({ approved: false, note: 'opt-in evidence insufficient' });
check('a rejection needs no reference', dec.ok === true && dec.state === SMS_STATE.REJECTED);
check('and keeps the carrier\'s reason', (await registrationStatus()).note === 'opt-in evidence insufficient');
await reset();

// ---------------------------------------------------------------------------
section('S3  the adapter is real, and unreachable');
check('the provider is documented', /twilio\.com\/docs/.test(SMS_PROVIDER.docs));
check('the endpoint is the documented one', /Messages\.json/.test(SMS_PROVIDER.endpoint));
check('it needs its OWN number, separate from the alert number',
  SMS_PROVIDER.envKeys.includes('TWILIO_SMS_FROM') && !SMS_PROVIDER.envKeys.includes('TWILIO_FROM'), SMS_PROVIDER.envKeys.join(','));

check('with no credentials the adapter is the disconnected one', getSmsAdapter({ env: {} }).configured() === false);
const dis = createDisconnectedSmsAdapter('switched off');
const out0 = await dis.send({ to: '+15551234567', body: 'hi' });
check('the disconnected adapter refuses', out0.ok === false && out0.disconnected === true, JSON.stringify(out0));

// the real adapter, exercised against a fake so the request shape is proven
let posted = null;
const adapter = createTwilioSmsAdapter({
  env: FULL_ENV,
  fetchImpl: async (url, init) => {
    posted = { url, body: init.body, auth: init.headers.Authorization };
    return { ok: true, status: 201, json: async () => ({ sid: 'SM1', status: 'queued' }) };
  },
});
check('with credentials it reports configured', adapter.configured() === true);
const sent = await adapter.send({ to: '+15551234567', body: 'hello' });
check('a send returns the provider id', sent.ok === true && sent.sid === 'SM1', JSON.stringify(sent));
check('it posts to the documented endpoint', /ACtest\/Messages\.json$/.test(posted.url), posted.url);
check('with basic auth', /^Basic /.test(posted.auth));
check('and sends FROM the outreach number, not the alert number',
  posted.body.includes(encodeURIComponent('+15550002222')) && !posted.body.includes(encodeURIComponent('+15550001111')), posted.body);
// a provider error is reported, not thrown
const bad = createTwilioSmsAdapter({ env: FULL_ENV, fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ message: 'not registered' }) }) });
check('a provider refusal is returned as a result', (await bad.send({ to: '+1', body: 'x' })).error === 'not registered');
const threw = createTwilioSmsAdapter({ env: FULL_ENV, fetchImpl: async () => { throw new Error('socket hang up'); } });
const t = await threw.send({ to: '+1', body: 'x' });
check('a network failure does not throw out of the adapter', t.ok === false && t.transient === true, JSON.stringify(t));

// ---------------------------------------------------------------------------
section('S4  the gate refuses, and says everything that is in the way');
await reset();
let rd = await smsReadiness({ env: {} });
check('it is not ready', rd.ready === false);
check('and never claims to be connected', rd.connected === false);
check('the status says built, deliberately disconnected', /deliberately disconnected/.test(rd.displayStatus), rd.displayStatus);
let codes = rd.blockers.map((b) => b.code);
check('missing credentials are named', codes.includes('no-credentials'));
check('the unapproved registration is named', codes.includes('registration-not-approved'));
check('the owner decision is named as a standing one', rd.blockers.some((b) => b.code === 'owner-decision-sms-off' && b.standing === true));
check('and it says nothing in code can lift it', /Nothing in code can lift this/.test(rd.blockers.find((b) => b.code === 'owner-decision-sms-off')?.text || ''));

// sharing the owner-alert number would take the alert channel down with outreach
rd = await smsReadiness({ env: { ...FULL_ENV, TWILIO_SMS_FROM: '+15550001111' } });
check('reusing the alert number is refused', rd.blockers.some((b) => b.code === 'shared-number'), rd.blockers.map((b) => b.code).join(','));
check('and says what it would cost', /take the alert channel down with it/.test(rd.blockers.find((b) => b.code === 'shared-number')?.text || ''));

// even with everything else satisfied, the standing decision holds
await recordCarrierDecision({ approved: true, reference: 'BN-1' });
rd = await smsReadiness({ env: FULL_ENV });
check('with credentials AND an approved registration it is STILL not ready', rd.ready === false, JSON.stringify(rd.blockers.map((b) => b.code)));
check('because the owner decision stands', rd.blockers.some((b) => b.code === 'owner-decision-sms-off'));
await reset();

// ---------------------------------------------------------------------------
section('S5  the single exit refuses, every time');
const contact = { id: 'c1', phone: { value: '+15551234567' }, consentLog: [] };
let out = await sendProspectSms({ contact, campaignId: 'k1', type: 'sms-requested-followup', body: 'hi', env: FULL_ENV });
check('a send is refused', out.sent === false, JSON.stringify(out).slice(0, 140));
check('the reason is the readiness gate', out.code === SMS_REFUSAL.NOT_READY, out.code);
check('and it lists what is in the way', (out.blockers || []).length > 0);

// it must refuse before touching a provider
let called = 0;
out = await sendProspectSms({
  contact, campaignId: 'k1', type: 'sms-requested-followup', body: 'hi',
  env: FULL_ENV, fetchImpl: async () => { called++; return { ok: true, status: 201, json: async () => ({ sid: 'x' }) }; },
});
check('no provider call is made', called === 0, String(called));
check('not even with an approved registration and full credentials', out.sent === false);

// ---------------------------------------------------------------------------
section('S6  the owner-alert texter has not become an outreach channel');
// lib/sms.js hard-wires To: OWNER_PHONE. If a `to` parameter ever appears on
// it, every protection in sms-outreach.js is bypassed, so this is pinned.
{
  const smsSrc = await import('node:fs').then((fs) => fs.readFileSync(new URL('../lib/sms.js', import.meta.url), 'utf8'));
  check('sendSms still takes only the text', /export async function sendSms\(text\)/.test(smsSrc),
    smsSrc.match(/export async function sendSms\([^)]*\)/)?.[0]);
  check('and still sends only to the owner', /To: env\('OWNER_PHONE'\)/.test(smsSrc));
}

// ---------------------------------------------------------------------------
section('S7  the screen says built-and-off, not "coming soon"');
let html = renderSms({ sms: await smsReadiness({ env: {} }) });
check('it says it is built and switched off', /built and switched off/i.test(html), html.slice(0, 180));
check('and that nothing has ever been sent', /Nothing has ever been sent through it/.test(html));
check('it says the dashboard cannot turn it on', /nothing in the dashboard can turn it on/.test(html));
check('the carrier requirement is explained', /A2P 10DLC/.test(html));
check('including that unregistered traffic is filtered by carriers', /filtered by the carriers/.test(html), html.slice(html.indexOf('A2P'), html.indexOf('A2P') + 200));
check('the missing facts are listed with who supplies each', /Still needed/.test(html) && /Who/.test(html));
check('costs are flagged as the provider\'s, not verified here', /cannot verify a price/.test(html));
html = renderSms({});
check('not loaded is a spinner, not an empty panel', /Checking the SMS status/.test(html));
html = renderSms({ smsError: 'the admin call failed' });
check('a failed read says so', /Could not read the SMS status/.test(html));
check('and states nothing is being texted either way', /Nothing is being texted either way/.test(html));

await reset();
done();
