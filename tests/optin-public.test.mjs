// The two ways a person can give SMS permission themselves — and the one way
// they cannot.
//
// R17.1. The owner wanted a blanket checkbox plus a first automated "reply YES"
// text to discovered numbers, read the provider requirements, and cancelled
// that flow. This is the replacement, and the test that matters most is S4:
// an owner's assertion, however sincere and however detailed, can never produce
// permission for a PROMOTIONAL message. Only the recipient's own act can.
//
// The three sources, weakest to strongest:
//   owner-recorded  a conversation the owner had          → one-time follow-up
//   web/QR form     they typed their own number, agreeing → promotional
//   keyword         they texted the keyword themselves    → promotional
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { upsertContact, getContact, field, optOut, effectiveConsent } from '../lib/contacts.js';
import { recordPermission } from '../lib/optin.js';
import {
  OPTIN_KEYWORD, publishedTerms, isOptInKeyword, recordKeywordOptIn, recordWebOptIn,
  pendingKeywordOptIn, describeSource, SOURCE_STRENGTH,
} from '../lib/optin-public.js';
import { mayText } from '../lib/phone.js';
import { handleInboundSms } from '../lib/sms-inbound.js';

const NUM = '+12145557701';
const mk = async (id, phone) => {
  await upsertContact({
    id, name: field('Jordan Hale', 't'), business: field('Hale Flooring', 't'),
    email: field(`${id}@example.invalid`, 't'), phone: field(phone, 't'),
  });
  return getContact(id);
};
const findBy = (c) => async () => c;

// ---------------------------------------------------------------------------
section('P1  the published terms are a single source of truth');
const terms = publishedTerms({ business: 'Inspiring Websites' });
check('the keyword is in them', terms.includes(OPTIN_KEYWORD), terms);
check('so is who is sending', /Inspiring Websites/.test(terms));
check('and how often', /messages a month/.test(terms), terms);
check('rates are disclosed', /Message and data rates may apply/.test(terms));
check('and both required replies are named', /STOP/.test(terms) && /HELP/.test(terms));

section('P2  only an exact keyword is an enrolment');
check('the bare keyword counts', isOptInKeyword('PREVIEW') && isOptInKeyword(' preview '));
check('with trailing punctuation', isOptInKeyword('preview!'));
check('but a sentence containing it does NOT', !isOptInKeyword('can you send me a preview'),
  'a word inside a sentence is a question for a person, not a consent event');
check('nor does something else entirely', !isOptInKeyword('yes please'));
check('nor empty', !isOptInKeyword('') && !isOptInKeyword(null));

// ---------------------------------------------------------------------------
section('P3  the recipient texting the keyword IS promotional consent');
const c1 = await mk('op_kw', NUM);
const kw = await recordKeywordOptIn({ e164: NUM, rawText: 'PREVIEW', business: 'Inspiring Websites', findContact: findBy(c1) });
check('it is accepted', kw.ok === true, JSON.stringify(kw).slice(0, 140));
check('at promotional scope', kw.scope === 'promotional', kw.scope);
check('their own message is the evidence', /their own message from/.test(kw.record.evidence), kw.record.evidence);
check('and the exact text is kept', /PREVIEW/.test(kw.record.evidence));
check('the wording they saw is recorded', kw.record.wording === terms, kw.record.wording);
check('and which version of it', kw.record.wordingVersion === 'public-optin-v1', kw.record.wordingVersion);

const after1 = await getContact('op_kw');
check('the contact now holds promotional consent',
  (typeof effectiveConsent(after1, 'sms') === 'string' ? effectiveConsent(after1, 'sms') : effectiveConsent(after1, 'sms')?.scope) === 'promotional',
  JSON.stringify(effectiveConsent(after1, 'sms')));
check('so a PROMOTIONAL message is allowed', (await mayText({ contact: after1, purpose: 'promotional' })).ok === true,
  JSON.stringify(await mayText({ contact: after1, purpose: 'promotional' })));

section('P4  THE RULE: an owner assertion can never reach promotional');
// This is the flow the owner asked for, then cancelled. It must stay impossible.
const c2 = await mk('op_owner', '+12145557702');
const owned = await recordPermission(c2, {
  source: 'spoke to Jordan at the Plano Chamber breakfast, he asked me to text him',
  wording: 'I will text you about our website service',
  evidence: 'my notes and two colleagues who were there',
  by: 'owner',
});
check('a detailed, sincere owner record is accepted', owned.ok === true, JSON.stringify(owned).slice(0, 140));
check('but capped at a one-time follow-up', owned.scope === 'one_time_followup', owned.scope);

const c2b = await getContact('op_owner');
check('a one-time follow-up message is allowed', (await mayText({ contact: c2b, purpose: 'one_time_followup' })).ok === true);
const promo = await mayText({ contact: c2b, purpose: 'promotional' });
check('A PROMOTIONAL MESSAGE IS REFUSED', promo.ok === false, JSON.stringify(promo));
check('and the refusal names the scope it actually holds', /one_time_followup|one time followup/.test(promo.reason || ''), promo.reason);
check('the software judges the RECORD against the MESSAGE, not the owner\'s word',
  promo.ok === false && owned.ok === true,
  'the record was accepted and the promotional send still refused — those are two different questions');

// and it cannot be raised by asking for it
const askedUp = await recordPermission(c2, {
  scope: 'promotional', source: 'he really did say yes to everything', wording: 'anything', evidence: 'my notes',
});
check('asking for promotional scope directly is refused', askedUp.ok === false, JSON.stringify(askedUp).slice(0, 140));
check('because it needs their own action', /own action/.test(askedUp.why || ''), askedUp.why);

// ---------------------------------------------------------------------------
section('P5  the web/QR form, and the three ways it refuses');
const c3 = await mk('op_web', '+12145557703');
let web = await recordWebOptIn({ phone: '+12145557703', agreed: false, findContact: findBy(c3) });
check('an unticked box is refused', web.ok === false, JSON.stringify(web).slice(0, 140));
check('and says a pre-ticked box is not permission either', /pre-ticked/.test(web.why || ''), web.why);

web = await recordWebOptIn({ phone: 'not a number', agreed: true, findContact: findBy(c3) });
check('an unusable number is refused', web.ok === false, JSON.stringify(web).slice(0, 140));

web = await recordWebOptIn({
  phone: '+12145557703', agreed: true, name: 'Jordan Hale',
  pageUrl: 'https://example.invalid/optin', business: 'Inspiring Websites', findContact: findBy(c3),
});
check('a real submission is accepted', web.ok === true, JSON.stringify(web).slice(0, 140));
// R17.2 — this used to grant promotional scope outright, which meant anybody
// could sign up anybody. The form now records an intention; possession of the
// handset is what grants. tests/optin-confirm.test.mjs drives the whole flow.
check('but it grants NOTHING on its own', web.scope === 'none' && web.pending === true, JSON.stringify(web).slice(0, 160));
check('the page it came from is recorded', /example\.invalid\/optin/.test(web.record.source), web.record.source);
check('and it names what would confirm it', /text PREVIEW from that phone/i.test(web.confirmBy || ''), web.confirmBy);

// ---------------------------------------------------------------------------
section('P6  a permission that arrives before the contact is not thrown away');
const held = await recordKeywordOptIn({ e164: '+12145557799', rawText: 'PREVIEW', business: 'Inspiring Websites' });
check('it is still recorded', held.ok === true, JSON.stringify(held).slice(0, 120));
check('and marked as held against the number', held.held === true && !held.contactId, JSON.stringify(held).slice(0, 120));
const pending = await pendingKeywordOptIn('+12145557799');
check('it can be read back', pending?.scope === 'promotional', JSON.stringify(pending).slice(0, 120));

section('P7  a standing STOP is not overturned by one keyword');
const c4 = await mk('op_stopped', '+12145557704');
await optOut({ contactId: 'op_stopped', phone: '+12145557704', channel: 'sms', reason: 'texted STOP' });
const retry = await recordKeywordOptIn({ e164: '+12145557704', rawText: 'PREVIEW', findContact: findBy(await getContact('op_stopped')) });
check('the enrolment is refused', retry.ok === false, JSON.stringify(retry).slice(0, 140));
check('it goes to a person instead', retry.needsPerson === true);
check('and says why one word is not enough', /standing STOP/.test(retry.why || ''), retry.why);

// ---------------------------------------------------------------------------
section('P8  the real inbound handler routes the keyword correctly');
const c5 = await mk('op_inbound', '+12145557705');
const inbound = await handleInboundSms({ from: '+12145557705', body: 'PREVIEW', business: 'Inspiring Websites' });
check('it is recognised as an opt-in, not as a reply', inbound.kind === 'optin', JSON.stringify(inbound).slice(0, 160));
check('at promotional scope', inbound.scope === 'promotional');
check('the confirmation repeats the terms', /Message and data rates may apply/.test(inbound.reply || ''), inbound.reply);
check('and nothing is suppressed', inbound.suppressed === false);

section('P8b  STOP then the keyword does NOT re-enrol');
const stopFirst = await handleInboundSms({ from: '+12145557706', body: 'STOP', business: 'Inspiring Websites' });
check('STOP is honoured first', stopFirst.suppressed === true, JSON.stringify(stopFirst).slice(0, 120));
const thenKeyword = await handleInboundSms({ from: '+12145557706', body: 'PREVIEW', business: 'Inspiring Websites' });
check('the keyword afterwards is refused', thenKeyword.kind === 'optin-refused', JSON.stringify(thenKeyword).slice(0, 160));
check('nothing is sent back that would read as a confirmation', !thenKeyword.reply, JSON.stringify(thenKeyword.reply));
check('and a person is asked to decide', thenKeyword.needsPerson === true);

section('P8c  a sentence containing the keyword is still a reply for a person');
const sentence = await handleInboundSms({ from: '+12145557707', body: 'can you send me a preview of my site', business: 'Inspiring Websites' });
check('it is NOT treated as an enrolment', sentence.kind !== 'optin', JSON.stringify(sentence).slice(0, 140));

// ---------------------------------------------------------------------------
section('P9  the screen can say how each permission was obtained');
check('a keyword record is described as their own act',
  describeSource({ source: 'texted PREVIEW to our number' }) === SOURCE_STRENGTH.keyword);
check('a form record likewise', describeSource({ source: 'opt-in form at https://x.invalid' }) === SOURCE_STRENGTH['web-form']);
check('an owner record is the weakest', describeSource({ source: 'spoke at an event' }) === SOURCE_STRENGTH['owner-recorded']);
check('and only the owner one is capped below promotional',
  SOURCE_STRENGTH['owner-recorded'].max === 'one_time_followup'
  && SOURCE_STRENGTH.keyword.max === 'promotional'
  && SOURCE_STRENGTH['web-form'].max === 'promotional');

// ---------------------------------------------------------------------------
section('P10  one suppression, whichever key format it was written under');
// A real bug, found by P7 failing: suppressions were written in TWO formats.
// contacts.js, phone.js and sms-inbound.js used E.164; retention.js and
// sms-outreach.js used digits only. So an erased person's suppression was
// invisible to every consent gate, and the prospect sender's own opt-out check
// read a key nothing writes — masked by mayText refusing a moment later for a
// different reason, which is how a dead safety check survives review.
const { suppressionKeys, isPhoneSuppressed } = await import('../lib/contacts.js');
const keys = suppressionKeys('+12145557710');
check('the canonical E.164 key is checked', keys.includes('suppress:phone:+12145557710'), JSON.stringify(keys));
check('and the legacy digits-only key too', keys.some((k) => /suppress:phone:1?2145557710$/.test(k)), JSON.stringify(keys));

await store.set('suppress:phone:12145557711', 'erased'); // the OLD format
check('a suppression written the old way is still honoured',
  (await isPhoneSuppressed('+12145557711')) === true,
  'dropping the second lookup would start messaging somebody who said stop');

await store.set('suppress:phone:+12145557712', JSON.stringify({ reason: 'STOP' })); // the new format
check('and one written the new way', (await isPhoneSuppressed('+12145557712')) === true);
check('an unsuppressed number is still clear', (await isPhoneSuppressed('+12145557713')) === false);

section('P10b  every gate agrees, whichever format was used');
const legacyContact = await mk('op_legacy', '+12145557714');
await recordPermission(legacyContact, {
  source: 'said yes at the counter', wording: 'text me the preview', evidence: 'card #130',
});
await store.set('suppress:phone:12145557714', 'erased'); // old format only
const gate = await mayText({ contact: await getContact('op_legacy'), purpose: 'one_time_followup' });
check('mayText honours an old-format suppression', gate.ok === false, JSON.stringify(gate));
check('and says they opted out, not that permission is missing',
  gate.code === 'opted-out', JSON.stringify(gate));
check('the keyword path honours it too',
  (await recordKeywordOptIn({ e164: '+12145557714', rawText: 'PREVIEW' })).ok === false);

done();
