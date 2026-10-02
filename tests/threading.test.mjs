// R6.7 — matching a reply to the message it actually answers.
//
// The defect: the campaign was resolved by iterating `campaigns:all` and taking
// the FIRST campaign the contact had been sent anything in. A prospect who
// ignored a "no website found" campaign and was later enrolled in a follow-up
// is exactly the person who eventually replies — and the credit landed on
// whichever campaign the key scan hit first. Every number built on that
// attribution (which message works, cost per booking, whether to send more)
// inherits the error.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  MATCH, CONFIDENCE, normaliseId, referencedIds, recordSentMessage,
  matchByHeaders, campaignsSentTo, matchReply, addressOf,
} from '../lib/threading.js';
import { recordReply, prospectReplyLookup } from '../lib/replies.js';

const C1 = 'contact-dana';
const K1 = 'camp-no-site';
const K2 = 'camp-followup';

async function enrol(campaignId, contactId, sentSteps, lastSentAt) {
  await store.sadd('campaigns:all', campaignId);
  await store.set(`campaign:member:${campaignId}:${contactId}`, JSON.stringify({ sentSteps, lastSentAt }));
}
const reset = async () => {
  for (const k of [`campaign:member:${K1}:${C1}`, `campaign:member:${K2}:${C1}`]) await store.set(k, '').catch(() => {});
};

// ---------------------------------------------------------------------------
section('T1  reading the headers an email actually carries');
check('angle brackets and case are ignored', normaliseId('<ABC@Mail.Test>') === 'abc@mail.test');
check('an empty id is empty, not "undefined"', normaliseId(undefined) === '');
let ids = referencedIds({ 'In-Reply-To': '<a@x.test>', References: '<root@x.test> <a@x.test>' });
check('the direct parent comes first', ids[0] === 'a@x.test', ids.join(','));
check('the ancestry is included', ids.includes('root@x.test'));
check('and nothing is listed twice', new Set(ids).size === ids.length);
check('header names are matched case-insensitively', referencedIds({ 'in-reply-to': '<z@x.test>' })[0] === 'z@x.test');
check('references are read nearest-ancestor first', referencedIds({ References: '<old@x.test> <new@x.test>' })[0] === 'new@x.test');
check('no headers yields nothing rather than throwing', referencedIds().length === 0);
check('a sender address is extracted from a display name', addressOf('Dana Fox <Dana@Fox.test>') === 'dana@fox.test');
check('and a bare address still works', addressOf('dana@fox.test') === 'dana@fox.test');

// ---------------------------------------------------------------------------
section('T2  a reply that quotes our message is matched exactly');
await reset();
await recordSentMessage({ messageId: '<sent-1@us.test>', contactId: C1, campaignId: K1, step: 0 });
let m = await matchByHeaders({ 'In-Reply-To': '<sent-1@us.test>' });
check('the message we sent is found by its id', m && m.campaignId === K1, JSON.stringify(m));
check('a message we never sent is not invented', (await matchByHeaders({ 'In-Reply-To': '<never@them.test>' })) === null);
check('an id with no brackets still matches', (await matchByHeaders({ 'In-Reply-To': 'sent-1@us.test' }))?.campaignId === K1);
check('recording needs an id and a contact', (await recordSentMessage({ messageId: '', contactId: C1 })).ok === false);

// ---------------------------------------------------------------------------
section('T3  the defect: a contact in two campaigns');
await reset();
await enrol(K1, C1, [0], 1000);
await enrol(K2, C1, [0], 5000);
const sent = await campaignsSentTo(C1);
check('both campaigns are candidates', sent.length === 2, JSON.stringify(sent));
check('and the most recent is listed first', sent[0].campaignId === K2, sent.map((s) => s.campaignId).join(','));

const findDana = async () => ({ id: C1 });

// with a threading header, the answer is exact — and it is the OLDER campaign,
// which is precisely the case "first one found" would get wrong
let r = await matchReply({ from: 'Dana <dana@fox.test>', headers: { 'In-Reply-To': '<sent-1@us.test>' } }, { findContact: findDana });
check('the header decides, not the scan order', r.campaignId === K1, JSON.stringify(r));
check('and it is reported as certain', r.confidence === 'certain' && r.how === MATCH.THREAD);
check('with the reason in words', /quotes a message we sent/.test(r.reason));

// without a header, two candidates means UNKNOWN, not a guess
r = await matchReply({ from: 'dana@fox.test', headers: {} }, { findContact: findDana });
check('the contact is still identified', r.contactId === C1);
check('but the campaign is NOT guessed', r.campaignId === null, JSON.stringify(r));
check('it is reported as unknown', r.confidence === 'unknown' && r.how === MATCH.AMBIGUOUS);
check('and both candidates are kept for a person to decide', r.candidates.length === 2);
check('the reason says why it could not be settled', /quotes none of them/.test(r.reason), r.reason);

// one campaign only: safe to attribute
await reset();
await enrol(K1, C1, [0], 1000);
r = await matchReply({ from: 'dana@fox.test', headers: {} }, { findContact: findDana });
check('with exactly one campaign sent, the reply is attributed', r.campaignId === K1 && r.how === MATCH.SOLE_CAMPAIGN);
check('and reported as likely rather than certain', r.confidence === 'likely');

// ---------------------------------------------------------------------------
section('T4  enrolment is not a send');
await reset();
await enrol(K1, C1, [], 0); // enrolled, nothing sent
check('a campaign that never sent is not a candidate', (await campaignsSentTo(C1)).length === 0);
r = await matchReply({ from: 'dana@fox.test', headers: {} }, { findContact: findDana });
check('so the reply is not attributed to it', r.campaignId === null, JSON.stringify(r));
check('and it says nothing was sent to this person', /nothing has been sent to them/.test(r.reason), r.reason);

// ---------------------------------------------------------------------------
section('T5  a stranger is not matched to anyone');
r = await matchReply({ from: 'nobody@elsewhere.test', headers: {} }, { findContact: async () => null });
check('an unknown sender matches no contact', r.contactId === null && r.how === MATCH.NONE);
check('and says which address it could not place', /nobody@elsewhere\.test/.test(r.reason), r.reason);
r = await matchReply({ from: '', headers: {} }, { findContact: async () => null });
check('a message with no sender says so', /no usable sender address/.test(r.reason), r.reason);
check('every match kind has a confidence', Object.values(MATCH).every((k) => !!CONFIDENCE[k]));

// ---------------------------------------------------------------------------
section('T6  the provider thread id is used when there is one');
await reset();
await enrol(K1, C1, [0], 1000);
await enrol(K2, C1, [0], 5000);
await recordSentMessage({ messageId: '<sent-2@us.test>', contactId: C1, campaignId: K2, step: 1, threadId: 'thr-77' });
r = await matchReply({ from: 'dana@fox.test', headers: {}, threadId: 'thr-77' }, { findContact: findDana });
check('a provider thread resolves the campaign', r.campaignId === K2 && r.how === MATCH.PROVIDER_THREAD, JSON.stringify(r));
check('and is certain', r.confidence === 'certain');
check('a thread id we do not know falls back rather than inventing',
  (await matchReply({ from: 'dana@fox.test', headers: {}, threadId: 'thr-unknown' }, { findContact: findDana })).how === MATCH.AMBIGUOUS);

// ---------------------------------------------------------------------------
section('T7  the lookup no longer picks a campaign it cannot justify');
await reset();
await enrol(K1, C1, [0], 1000);
await enrol(K2, C1, [0], 5000);
const { upsertContact } = await import('../lib/contacts.js');
const made = await upsertContact({ name: 'Dana Fox', email: 'dana-lookup@fox.test', relationship: 'none', source: 'test' });
const realId = made.contact.id;
// enrol the contact that actually exists, in TWO campaigns
await enrol(K1, realId, [0], 1000);
await enrol(K2, realId, [0], 5000);
const look = await prospectReplyLookup('dana-lookup@fox.test');
check('a contact with sends is found', !!look && look.contactId === realId, JSON.stringify(look));
check('with two campaigns the lookup refuses to name one', look.campaignId === null, JSON.stringify(look));
check('and hands over both candidates instead', (look.candidates || []).length === 2, JSON.stringify(look.candidates));
// and with only one, naming it is safe
await store.set(`campaign:member:${K2}:${realId}`, '').catch(() => {});
const one = await prospectReplyLookup('dana-lookup@fox.test');
check('with one campaign it is named', one.campaignId === K1, JSON.stringify(one));
check('a stranger returns nothing', (await prospectReplyLookup('nobody@elsewhere.test')) === null);

// ---------------------------------------------------------------------------
section('T8  the evidence survives into the recorded reply');
const rec = await recordReply({
  contactId: C1, kind: 'interested', text: 'yes please', campaignId: K1,
  match: { how: MATCH.THREAD, confidence: 'certain', reason: 'quoted our message', candidates: [] },
});
check('the reply records how it was matched', rec.reply.match.how === MATCH.THREAD, JSON.stringify(rec.reply.match));
check('and how confident that is', rec.reply.match.confidence === 'certain');
const direct = await recordReply({ contactId: C1, kind: 'interested', text: 'typed in by hand' });
check('a reply recorded by hand says it was not matched', direct.reply.match.how === 'not-attempted', JSON.stringify(direct.reply.match));
check('rather than implying a certain match', direct.reply.match.confidence === 'none');

await reset();

// ---------------------------------------------------------------------------
section('T9  a contact saved with a bare string is still findable by opt-out');
// Found while writing T7. Every field on a contact is { value, ... }, and
// indexContact / findDuplicates / optOut all read .value — so a contact saved
// with `email: 'a@b.test'` was stored but NEVER INDEXED. Every caller in this
// codebase passes the right shape, so this was not live; but `contacts-save`
// forwards a request body straight through, and an unindexed contact is one
// that **opt-out cannot find**, which is the worst way to fail.
{
  const { upsertContact, optOut, getContact, asField } = await import('../lib/contacts.js');
  const bare = await upsertContact({ name: 'Bare String', email: 'bare@fox.test', relationship: 'none', source: 'manual' });
  check('a bare string is stored as a proper field', bare.contact.email?.value === 'bare@fox.test', JSON.stringify(bare.contact.email));
  check('and the contact is indexed by that email', (await store.smembers('contacts:byEmail:bare@fox.test')).includes(bare.contact.id));

  // the one that matters
  await optOut({ email: 'bare@fox.test', reason: 'asked to stop' });
  const after = await getContact(bare.contact.id);
  check('an opt-out finds and suppresses that contact', !!after.optedOutAt, JSON.stringify({ id: bare.contact.id, optedOutAt: after.optedOutAt }));
  check('and the reason is recorded', after.suppressedReason === 'asked to stop');

  check('an already-correct field object is left alone', asField({ value: 'x', confidence: 0.5 }).confidence === 0.5);
  check('an empty value stays null rather than becoming an empty field', asField('') === null && asField(null) === null);
  check('and an object with no value is refused rather than indexed as undefined', asField({ nope: 1 }) === null);
}

done();
