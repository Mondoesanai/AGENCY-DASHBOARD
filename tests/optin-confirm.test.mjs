// Could somebody sign up a number that is not theirs?
//
// R17.2. Before this, yes. A probe confirmed it: a third party submitted the
// public form with a contact's number, and that contact became promotional-SMS
// eligible. The form proved somebody typed a number; it was treated as proof
// that the number was theirs.
//
// The fix is possession, not paperwork. The form records an INTENT. Promotional
// permission arrives only when a message is received FROM that handset, which a
// web page cannot fake. And nothing is sent to an unconfirmed number at all —
// not even a "did you mean to sign up?" prompt, because a text to a stranger is
// the harm regardless of what it says.
//
// C3 is the control the brief asks for: no campaign send occurs before
// confirmation.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { upsertContact, getContact, field, optOut } from '../lib/contacts.js';
import {
  recordWebOptIn, recordKeywordOptIn, pendingWebOptIn, OPTIN_KEYWORD, PENDING_TTL_SEC,
} from '../lib/optin-public.js';
import { recordPermission } from '../lib/optin.js';
import { mayText } from '../lib/phone.js';
import { compose } from '../lib/sms-send.js';
import { rateLimit } from '../lib/ratelimit.js';

const VICTIM = '+12145558801';
const mk = async (id, phone, n = 1) => {
  await upsertContact({
    id, name: field(`Person ${n}`, 't'), business: field(`Business ${n}`, 't'),
    email: field(`${id}@example.invalid`, 't'), phone: field(phone, 't'),
  });
  return getContact(id);
};

// ---------------------------------------------------------------------------
section('C1  THE HOLE: a third party submitting someone else\'s number');
const victim = await mk('cf_victim', VICTIM);
check('they are not textable to begin with',
  (await mayText({ contact: victim, purpose: 'promotional' })).ok === false);

const attack = await recordWebOptIn({
  phone: VICTIM, agreed: true, name: 'definitely not them',
  pageUrl: 'https://example.invalid/optin',
});
check('the form accepts the submission', attack.ok === true, JSON.stringify(attack).slice(0, 160));
check('but grants NOTHING', attack.scope === 'none', attack.scope);
check('it is explicitly pending', attack.pending === true);
check('and says what would confirm it', /text PREVIEW from that phone/i.test(attack.confirmBy || ''), attack.confirmBy);

const still = await getContact('cf_victim');
check('THE VICTIM IS STILL NOT TEXTABLE', (await mayText({ contact: still, purpose: 'promotional' })).ok === false,
  JSON.stringify(await mayText({ contact: still, purpose: 'promotional' })));
check('not even for a one-time follow-up', (await mayText({ contact: still, purpose: 'one_time_followup' })).ok === false);
check('nothing was written to their consent log',
  (still.consentLog || []).length === 0, JSON.stringify(still.consentLog));

section('C2  the pending record exists, separately, and expires');
const p = await pendingWebOptIn(VICTIM);
check('it is held against the number', !!p, JSON.stringify(p).slice(0, 140));
check('marked as awaiting confirmation', p.state === 'awaiting-confirmation', p.state);
check('with the wording they were shown', /Message and data rates may apply/.test(p.wording || ''));
check('and a version for it', p.wordingVersion === 'public-optin-v1', p.wordingVersion);
check('it is not kept for ever', PENDING_TTL_SEC <= 60 * 60 * 24 * 14, String(PENDING_TTL_SEC));

// ---------------------------------------------------------------------------
section('C3  NO SEND HAPPENS BEFORE CONFIRMATION');
// The control. A pending opt-in must not let any message be composed — which is
// the gate every send path in this system goes through.
const draft = await compose({ contact: await getContact('cf_victim'), body: 'Your preview is ready!' });
check('composing to a pending number is refused', draft.ok === false, JSON.stringify(draft).slice(0, 180));
check('and the reason is the missing permission', /permission/i.test(draft.reason || ''), draft.reason);
check('a pending record is never read as consent',
  !/pending|awaiting/i.test(String((await getContact('cf_victim')).consentLog?.map((r) => r.scope).join(',') || '')),
  'pending lives outside the consent log entirely, so nothing can mistake it for a grant');

// ---------------------------------------------------------------------------
section('C4  the handset confirms it, and only then');
const confirmed = await recordKeywordOptIn({
  e164: VICTIM, rawText: OPTIN_KEYWORD, business: 'Inspiring Websites',
  findContact: async () => getContact('cf_victim'),
});
check('the keyword is accepted', confirmed.ok === true, JSON.stringify(confirmed).slice(0, 140));
check('NOW it is promotional', confirmed.scope === 'promotional', confirmed.scope);
check('and BOTH acts are cited', /form submitted/.test(confirmed.record.evidence) && /confirmed from/.test(confirmed.record.evidence),
  confirmed.record.evidence);
check('the source names the confirmation', /confirmed by texting/.test(confirmed.record.source), confirmed.record.source);
check('the wording recorded is the one the FORM showed, not a fresh one',
  confirmed.record.wordingVersion === 'public-optin-v1', confirmed.record.wordingVersion);

check('the contact is now textable', (await mayText({ contact: await getContact('cf_victim'), purpose: 'promotional' })).ok === true);
check('and composing works', (await compose({ contact: await getContact('cf_victim'), body: 'Your preview is ready.' })).ok === true);
check('the pending record is consumed', (await pendingWebOptIn(VICTIM)) === null);

// ---------------------------------------------------------------------------
section('C5  a suppressed number cannot even be made pending');
const stopped = await mk('cf_stopped', '+12145558802', 2);
await optOut({ contactId: 'cf_stopped', phone: '+12145558802', channel: 'sms', reason: 'texted STOP' });
const blocked = await recordWebOptIn({ phone: '+12145558802', agreed: true });
check('the form refuses', blocked.ok === false, JSON.stringify(blocked).slice(0, 140));
check('and routes it to a person', blocked.needsPerson === true);
check('no pending record is created', (await pendingWebOptIn('+12145558802')) === null);

section('C6  owner-recorded follow-up stays separate from all of this');
const owned = await mk('cf_owner', '+12145558803', 3);
await recordPermission(owned, {
  source: 'she asked me at the counter', wording: 'text me the preview', evidence: 'card #140',
});
const o = await getContact('cf_owner');
check('a one-time follow-up is allowed', (await mayText({ contact: o, purpose: 'one_time_followup' })).ok === true);
check('and promotional is still refused', (await mayText({ contact: o, purpose: 'promotional' })).ok === false);
check('no pending web record was involved', (await pendingWebOptIn('+12145558803')) === null,
  'the owner path and the public path are different mechanisms and must not blur');

// ---------------------------------------------------------------------------
section('C7  the public write has a ceiling');
const key = `test:${Date.now()}`;
let last = null;
for (let i = 0; i < 4; i++) last = await rateLimit(key, { max: 3, windowSec: 60 });
check('the fourth request over a limit of three is refused', last.ok === false, JSON.stringify(last));
check('it counts', last.count === 4, String(last.count));
check('and says when it resets', last.resetSec > 0 && last.resetSec <= 60, String(last.resetSec));
check('a different key is unaffected', (await rateLimit(`${key}:other`, { max: 3, windowSec: 60 })).ok === true);

section('C7b  a store failure does NOT quietly allow the request');
// R18.1 corrected this. It used to fail OPEN, justified as "a KV outage must
// not take the opt-out path down with it" — which was simply wrong: opt-out
// arrives at ?hook=sms and is not rate-limited by anything. Failing open only
// ever made new enrolment easier during an outage, which is the one moment when
// nothing about it can be checked. The limiter now reports the failure and the
// caller decides; tests/optin-ordering.test.mjs O7 proves the public endpoint
// returns 503, and O7b proves STOP still gets through during the same outage.
const realIncr = store.incr;
store.incr = async () => { throw new Error('kv down'); };
const degraded = await rateLimit('anything', { max: 1, windowSec: 60 });
store.incr = realIncr;
check('it does NOT report a clean pass', degraded.ok === false, JSON.stringify(degraded));
check('and is explicitly marked degraded', degraded.degraded === true,
  'a caller reading only `ok` must not mistake an outage for a pass');
check('with the reason, so it can be logged', /could not be read/.test(degraded.reason || ''), degraded.reason);

done();
