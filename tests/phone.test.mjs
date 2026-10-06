// R6.12 — a number's TYPE says whether a text can arrive. It never says
// whether one may be sent.
//
// This is an easy mistake and an expensive one: a lookup returns a clean,
// confident `{ "type": "mobile" }` at exactly the moment you are asking "can I
// text this person?", and it answers a different question. "Mobile" is a fact
// about wires. Consent is a fact about a person. Only the second is permission.
//
// The central test is P5: every line type is run against every consent scope,
// and NO combination exists in which the line type makes the answer more
// permissive. That is the requirement, stated as an exhaustive check rather
// than as a comment.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  LINE_TYPE, SMS_CAPABLE, LOOKUP_PROVIDER,
  parseNumber, isValidNumber, recordLineType, getLineType, deliverability, mayText,
  createTwilioLookupAdapter, createDisconnectedLookupAdapter, getLookupAdapter,
} from '../lib/phone.js';
import { makeConsentRecord, field as E } from '../lib/contacts.js';

const REAL = '+12145557709';

// ---------------------------------------------------------------------------
section('P1  validation, with no provider involved');
let p = parseNumber('(214) 555-7709');
check('a formatted US number parses', p.ok === true && p.e164 === REAL, JSON.stringify(p));
check('and keeps the national digits', p.national === '2145557709');
check('a leading 1 is handled', parseNumber('1-214-555-7709').e164 === REAL);
check('an already-E.164 number passes through', parseNumber(REAL).e164 === REAL);
check('an international number is kept', parseNumber('+44 20 7946 0958').e164 === '+442079460958');
check('an extension is separated, not treated as digits', parseNumber('214-555-7709 x204').ext === '204');
check('and the number itself still parses', parseNumber('214-555-7709 x204').e164 === REAL);

// the ones that are impossible, not merely unusual
check('too short is refused', parseNumber('555-1234').ok === false);
check('and says how many digits it had', /has 7 digits/.test(parseNumber('555-1234').problems[0].text));
check('an area code starting with 1 is impossible', parseNumber('123-456-7890').ok === false);
check('an exchange starting with 0 is impossible', parseNumber('214-055-1234').ok === false);
check('and the reason names the exchange', /Exchange 055/.test(parseNumber('214-055-1234').problems[0].text));
check('empty is refused without guessing', parseNumber('').ok === false);
check('letters alone are refused', parseNumber('call me').ok === false);
check('isValidNumber agrees with parseNumber', isValidNumber('214-555-7709') === true && isValidNumber('123-456-7890') === false);

// ---------------------------------------------------------------------------
section('P2  a placeholder parses, and is still nobody');
// A well-formed number can be nobody. Storing and displaying one must work;
// SENDING to one must not, because nothing would arrive and, if the digits are
// a typo for a real number, a stranger would.
p = parseNumber('972-555-0101');
check('the fiction range parses', p.ok === true, JSON.stringify(p));
check('but is marked a placeholder', p.placeholder === true);
check('and says it is reserved for fiction', /reserved for fiction/.test(p.problems[0].text));
check('repeated digits are a placeholder', parseNumber('222-222-2222').placeholder === true);
check('sequential digits are caught', parseNumber('123-456-7890').problems.some((x) => x.code === 'sequential'));
check('a real number is not a placeholder', parseNumber('214-555-7709').placeholder === false);
check('a placeholder still yields an e164 for display', !!parseNumber('972-555-0101').e164);

// ---------------------------------------------------------------------------
section('P3  line type is recorded with where it came from');
await store.set(`phone:type:${REAL}`, '').catch(() => {});
let lt = await getLineType(REAL);
check('unknown until something says otherwise', lt.type === LINE_TYPE.UNKNOWN && lt.source === null);
check('a line type with no source is refused', (await recordLineType(REAL, { type: 'mobile' })).ok === false);
check('and says why', /where it came from/.test((await recordLineType(REAL, { type: 'mobile' })).error));
check('an invented type is refused', (await recordLineType(REAL, { type: 'satellite', source: 'x' })).ok === false);
await recordLineType(REAL, { type: LINE_TYPE.MOBILE, source: 'twilio-lookup', carrier: 'Verizon' });
lt = await getLineType(REAL);
check('a sourced type is kept', lt.type === LINE_TYPE.MOBILE && lt.source === 'twilio-lookup', JSON.stringify(lt));
check('with the carrier', lt.carrier === 'Verizon');

// ---------------------------------------------------------------------------
section('P4  deliverability is the only question line type answers');
const good = parseNumber(REAL);
check('a mobile can receive SMS', deliverability(good, LINE_TYPE.MOBILE).deliverable === true);
check('a landline cannot', deliverability(good, LINE_TYPE.LANDLINE).deliverable === false);
check('and says so plainly', /cannot receive SMS/.test(deliverability(good, LINE_TYPE.LANDLINE).reason));
// VoIP is the honest-uncertainty case
let d = deliverability(good, LINE_TYPE.VOIP);
check('VoIP is unproven rather than yes or no', d.deliverable === null && d.certain === false, JSON.stringify(d));
check('and says sometimes-yes-sometimes-no', /sometimes receive SMS and sometimes do not/.test(d.reason));
d = deliverability(good, LINE_TYPE.UNKNOWN);
check('unknown stays unknown', d.deliverable === null && d.certain === false);
check('an unusable number is undeliverable, certainly', deliverability(parseNumber('123'), LINE_TYPE.MOBILE).deliverable === false);
check('only mobile is capable-true', Object.entries(SMS_CAPABLE).filter(([, v]) => v === true).map(([k]) => k).join(',') === 'mobile');

// ---------------------------------------------------------------------------
section('P5  no line type makes permission more permissive');
// The requirement, as an exhaustive check. For every consent scope and every
// line type, the answer must never be MORE permissive than the same scope with
// an unknown line type.
const scopes = ['none', 'one_time_followup', 'transactional', 'promotional'];
const types = Object.values(LINE_TYPE);
const contactWith = (scope, phone = REAL) => ({
  id: `c-${scope}`,
  phone: E(phone),
  consentLog: scope === 'none' ? [] : [makeConsentRecord({ scope, channel: 'sms', source: 'test' })],
});

let upgrades = [];
for (const scope of scopes) {
  for (const purpose of ['one_time_followup', 'promotional', 'transactional']) {
    // baseline: line type unknown
    await store.set(`phone:type:${REAL}`, '').catch(() => {});
    const base = await mayText({ contact: contactWith(scope), purpose });
    for (const type of types) {
      await recordLineType(REAL, { type, source: 'test' });
      const got = await mayText({ contact: contactWith(scope), purpose });
      if (got.ok === true && base.ok !== true) {
        upgrades.push(`${scope}/${purpose}/${type}: unknown=${base.ok} ${type}=${got.ok}`);
      }
    }
  }
}
check('NO line type ever turns a refusal into permission', upgrades.length === 0, upgrades.join(' | '));

// and the converse: it can still refuse
await recordLineType(REAL, { type: LINE_TYPE.LANDLINE, source: 'test' });
let m = await mayText({ contact: contactWith('promotional'), purpose: 'promotional' });
check('a landline is refused even with full consent', m.ok === false && m.code === 'undeliverable', JSON.stringify(m));
await recordLineType(REAL, { type: LINE_TYPE.MOBILE, source: 'test' });
m = await mayText({ contact: contactWith('promotional'), purpose: 'promotional' });
check('a mobile with consent is allowed', m.ok === true, JSON.stringify(m));
m = await mayText({ contact: contactWith('none'), purpose: 'one_time_followup' });
check('a mobile with NO consent is refused', m.ok === false && m.code === 'no-consent', JSON.stringify(m));
check('and the reason is about permission, not the number', /permission is "none"/.test(m.reason), m.reason);

// consent scope must actually cover the purpose
m = await mayText({ contact: contactWith('one_time_followup'), purpose: 'promotional' });
check('one-time permission does not cover marketing', m.ok === false && m.code === 'no-consent');
m = await mayText({ contact: contactWith('promotional'), purpose: 'one_time_followup' });
check('promotional permission covers a single follow-up', m.ok === true);

// ---------------------------------------------------------------------------
section('P6  the things that outrank consent');
await recordLineType(REAL, { type: LINE_TYPE.MOBILE, source: 'test' });
await store.set(`suppress:phone:${REAL}`, JSON.stringify({ at: new Date().toISOString(), reason: 'stop' }));
m = await mayText({ contact: contactWith('promotional'), purpose: 'promotional' });
check('an opt-out beats recorded consent', m.ok === false && m.code === 'opted-out', JSON.stringify(m));
await store.set(`suppress:phone:${REAL}`, '').catch(() => {});

// an unreadable suppression list must not read as "not suppressed"
{
  const realGet = store.get;
  store.get = async (k) => { if (String(k).startsWith('suppress:phone:')) throw new Error('store down'); return realGet.call(store, k); };
  m = await mayText({ contact: contactWith('promotional'), purpose: 'promotional' });
  check('if the opt-out list cannot be read, the answer is no', m.ok === false, JSON.stringify(m));
  check('and it says the state is unknown rather than clear', /could not be read/.test(m.reason), m.reason);
  store.get = realGet;
}

m = await mayText({ contact: { id: 'x', phone: E('972-555-0101'), consentLog: [makeConsentRecord({ scope: 'promotional', channel: 'sms', source: 't' })] }, purpose: 'promotional' });
check('a placeholder is refused even with full consent', m.ok === false && m.code === 'placeholder-number', JSON.stringify(m));
m = await mayText({ contact: { id: 'y', phone: E('123'), consentLog: [makeConsentRecord({ scope: 'promotional', channel: 'sms', source: 't' })] }, purpose: 'promotional' });
check('an unusable number is refused even with full consent', m.ok === false && m.code === 'invalid-number');

// ---------------------------------------------------------------------------
section('P7  the lookup adapter, disconnected, and honest in its result');
check('it is documented', /twilio\.com\/docs\/lookup/.test(LOOKUP_PROVIDER.docs));
check('and says the type costs money, unlike validation', /billed per lookup/.test(LOOKUP_PROVIDER.billing));
check('with no credentials it is the disconnected one', getLookupAdapter({ env: {} }).configured() === false);
const off = await createDisconnectedLookupAdapter('not connected').lookup(REAL);
check('the disconnected adapter refuses', off.ok === false && off.disconnected === true);

const ad = createTwilioLookupAdapter({
  env: { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' },
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ valid: true, line_type_intelligence: { type: 'mobile', carrier_name: 'T-Mobile' } }) }),
});
const r = await ad.lookup(REAL);
check('a mobile result is mapped', r.ok === true && r.type === LINE_TYPE.MOBILE, JSON.stringify(r));
check('the carrier is kept', r.carrier === 'T-Mobile');
// the result itself carries the warning, where a future caller will read it
check('the result says what it does and does not mean', /not consent and must never be used as consent/.test(r.meaning), r.meaning);
const land = createTwilioLookupAdapter({
  env: { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' },
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ valid: true, line_type_intelligence: { type: 'landline' } }) }),
});
check('a landline result is mapped', (await land.lookup(REAL)).type === LINE_TYPE.LANDLINE);
const failing = createTwilioLookupAdapter({
  env: { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't' },
  fetchImpl: async () => { throw new Error('socket hang up'); },
});
check('a network failure does not throw out of the adapter', (await failing.lookup(REAL)).ok === false);

// ---------------------------------------------------------------------------
section('P8  the real send path asks the permission question');
{
  const { sendProspectSms } = await import('../lib/sms-outreach.js');
  const out = await sendProspectSms({
    contact: contactWith('promotional'), campaignId: 'k', type: 'sms-promotional', body: 'hi',
    env: { TWILIO_ACCOUNT_SID: 'AC', TWILIO_AUTH_TOKEN: 't', TWILIO_SMS_FROM: '+15550002222' },
  });
  // it is refused by the standing owner decision long before this, which is
  // the point — but the permission path must still be the one that is wired
  check('the SMS send still refuses', out.sent === false, JSON.stringify(out).slice(0, 140));
}
check('canContact uses the real validator', await (async () => {
  const { canContact } = await import('../lib/contacts.js');
  const bad = await canContact({ id: 'z', phone: E('123-456-7890'), phoneType: 'mobile', consentLog: [makeConsentRecord({ scope: 'promotional', channel: 'sms', source: 't' })] }, { channel: 'sms', purpose: 'promotional' });
  return bad.ok === false && /cannot start with 0 or 1/.test(bad.reason || '');
})(), 'an impossible number should be refused by canContact');

await store.set(`phone:type:${REAL}`, '').catch(() => {});
done();
