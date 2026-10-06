// R11.12 — an ambiguous timeout is reconciled, never guessed.
//
// A send times out. Did it go? Genuinely unknown: the request may have been
// processed with only the response lost. Both naive answers are wrong — retry
// and a stranger may get the same cold email twice; give up and the owner
// believes a message went that did not.
import { check, section, done } from './world.mjs';
import {
  SEND_OUTCOME, recordSendAttempted, recordSendOutcome, getSendAttempt,
  isAmbiguousFailure, reconcileBeforeRetry,
} from '../lib/outreach-email.js';
import { clampToSchema } from '../lib/untrusted.js';
import { normaliseCard } from '../lib/card-intake.js';
import { outboundProspectInput } from './harness/outbound-prospect.mjs';

// ---------------------------------------------------------------------------
section('Z1  a timeout is distinguished from a refusal');
for (const e of ['socket hang up', 'The operation timed out', 'ECONNRESET', 'fetch failed', 'AbortError: aborted']) {
  check(`"${e}" is ambiguous`, isAmbiguousFailure(new Error(e)) === true, e);
}
for (const e of ['401 Unauthorized', 'invalid recipient address', '422 validation failed']) {
  check(`"${e}" is a definite failure, not ambiguous`, isAmbiguousFailure(new Error(e)) === false, e);
}

// ---------------------------------------------------------------------------
section('Z2  with no previous attempt, sending is simply allowed');
let r = await reconcileBeforeRetry('fresh-key');
check('it sends', r.action === 'send', JSON.stringify(r));
check('and says why', /no previous attempt/.test(r.reason));

// ---------------------------------------------------------------------------
section('Z3  a CONFIRMED send is never repeated');
await recordSendAttempted('key-confirmed');
await recordSendOutcome('key-confirmed', SEND_OUTCOME.CONFIRMED, { providerId: 'msg_123' });
r = await reconcileBeforeRetry('key-confirmed');
check('it is skipped', r.action === 'skip', JSON.stringify(r));
check('with the provider id kept', r.providerId === 'msg_123');

// ---------------------------------------------------------------------------
section('Z4  a DEFINITE failure is safe to retry');
await recordSendAttempted('key-failed');
await recordSendOutcome('key-failed', SEND_OUTCOME.FAILED, { error: 'invalid recipient' });
r = await reconcileBeforeRetry('key-failed');
check('it sends', r.action === 'send');
check('because nothing was delivered', /definitely failed/.test(r.reason), r.reason);

// ---------------------------------------------------------------------------
section('Z5  THE AMBIGUOUS CASE — it is reconciled, not guessed');
await recordSendAttempted('key-ambiguous');
await recordSendOutcome('key-ambiguous', SEND_OUTCOME.AMBIGUOUS, { error: 'socket hang up' });

// no way to ask -> park it. Not retry, not drop.
r = await reconcileBeforeRetry('key-ambiguous');
check('with no lookup available it is PARKED', r.action === 'park', JSON.stringify(r));
check('not retried, because that could duplicate', r.action !== 'send');
check('not dropped either', r.action !== 'skip');
check('a person is asked', r.needsHuman === true);
check('and the reason explains the risk in words', /could send a duplicate/.test(r.reason), r.reason);

// the provider HAS it -> it went, do not resend
r = await reconcileBeforeRetry('key-ambiguous', { lookup: async () => ({ exists: true, id: 'msg_456' }) });
check('when the provider has it, the send is skipped', r.action === 'skip', JSON.stringify(r));
check('and the reason names what actually happened', /only the response being lost/.test(r.reason), r.reason);
check('the provider id is recorded', r.providerId === 'msg_456');
const after = await getSendAttempt('key-ambiguous');
check('the attempt is upgraded to confirmed, so it is settled for good', after.state === SEND_OUTCOME.CONFIRMED, after.state);
r = await reconcileBeforeRetry('key-ambiguous');
check('and a later retry skips without needing the provider again', r.action === 'skip');

// the provider does NOT have it -> safe to send
await recordSendAttempted('key-ambiguous-2');
await recordSendOutcome('key-ambiguous-2', SEND_OUTCOME.AMBIGUOUS, { error: 'timeout' });
r = await reconcileBeforeRetry('key-ambiguous-2', { lookup: async () => ({ exists: false }) });
check('a definite "no" permits the send', r.action === 'send', JSON.stringify(r));
check('with the reason stated', /does not have this message/.test(r.reason));

// the provider cannot tell us -> park, do not guess
r = await reconcileBeforeRetry('key-ambiguous-2', { lookup: async () => ({ exists: null }) });
check('an uncertain provider answer parks it', r.action === 'park', JSON.stringify(r));
check('rather than resending on a maybe', r.action !== 'send');

// the lookup itself fails -> park, and mark it transient
r = await reconcileBeforeRetry('key-ambiguous-2', { lookup: async () => { throw new Error('provider down'); } });
check('an unreachable provider parks it', r.action === 'park');
check('marked transient, so it can be tried again later', r.transient === true);
check('and names the cause', /could not reach the provider/.test(r.reason), r.reason);

// ---------------------------------------------------------------------------
section('Z6  an in-flight attempt is treated as ambiguous, not as "never sent"');
// The record is written BEFORE the request, so a process killed mid-send leaves
// "in-flight" — which must behave like ambiguous, not like nothing happened.
await recordSendAttempted('key-inflight');
r = await reconcileBeforeRetry('key-inflight');
check('an in-flight record parks rather than sending', r.action === 'park', JSON.stringify(r));
check('because the process may have died after the request went out', r.needsHuman === true);

// ---------------------------------------------------------------------------
section('Z7  R11.11 — clamping is actually CALLED on the card path');
// The reviewer noted clampToSchema was imported but never called. It is now
// used inside normaliseCard, so an invented `side` cannot reach the merge step.
const bad = normaliseCard({
  side: 'OWNER_APPROVED',
  name: { value: 'Pat Lee', confidence: 0.95 },
  otherText: 'x'.repeat(2000),
});
check('an invented side value is replaced with the default', bad.side === 'unknown', bad.side);
check('an over-long otherText is cut to the schema limit', bad.otherText.length === 500, String(bad.otherText.length));
check('the real field still comes through', bad.name.value === 'Pat Lee');
const good = normaliseCard({ side: 'back', name: { value: 'Jo', confidence: 0.9 }, otherText: 'fine' });
check('a valid side passes through', good.side === 'back');

// ---------------------------------------------------------------------------
section('Z8  the reconciliation is CALLED by the real send path');
// The reviewer's point: these functions were defined and nothing invoked them.
// sendProspectEmail is the single declared exit, so it is where they belong.
const { sendProspectEmail } = await import('../lib/outreach-email.js');
const { upsertContact, field } = await import('../lib/contacts.js');
const { saveSettings, saveSender } = await import('../lib/settings.js');
const { store } = await import('../lib/store.js');
const E = (v) => field(v, { confidence: 1, source: 'manual' });

await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' }, targeting: { status: 'confirmed' } });
// R6.9 — a real deployment cannot send without a CAN-SPAM sender identity,
// so the tests that exercise "ready to send" configure one.
await saveSender({ name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '2201 Preston Rd Suite 405, Plano TX 75093' });
const raw = JSON.parse(await store.get('settings:business'));
await store.set('settings:business', JSON.stringify({ ...raw, outreach: { ...raw.outreach, active: true } }));
const envOK = { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'outreach.test', PUBLIC_BASE_URL: 'https://dash.test', UNSUBSCRIBE_SECRET: 'unsub-test-secret' };

const person = (await upsertContact({ ...outboundProspectInput(), name: E('Timeout Test'), businessName: E('TT Co'), email: E('tt@timeout.test') })).contact;

// 1. a send that TIMES OUT is recorded as ambiguous, not as a failure
let calls = 0;
let out = await sendProspectEmail({
  contact: person, campaignId: 'camp-timeout', message: {}, env: envOK,
  fetchImpl: async () => { calls++; throw new Error('socket hang up'); },
});
check('the timeout does not report a send', out.sent === false, JSON.stringify(out));
check('it is marked ambiguous, not a plain failure', out.ambiguous === true, JSON.stringify(out));
check('and says it will be reconciled before any retry', /reconciled with the provider before any retry/.test(out.reason), out.reason);
const rec = await getSendAttempt('camp-timeout:' + person.id);
check('the attempt is on record as ambiguous', rec.state === SEND_OUTCOME.AMBIGUOUS, rec.state);

// 2. the RETRY does not blindly resend — with no lookup it parks
const before = calls;
out = await sendProspectEmail({
  contact: person, campaignId: 'camp-timeout', message: {}, env: envOK,
  fetchImpl: async () => { calls++; return { ok: true, status: 200, text: async () => '{}' }; },
});
check('the retry does NOT call the provider', calls === before, `${before} -> ${calls}`);
check('it parks for a person instead', out.code === 'needs-reconciliation', JSON.stringify(out));
check('and says a duplicate is the risk', /duplicate/.test(out.reason), out.reason);

// 3. with a lookup saying the provider HAS it, the retry is skipped as delivered
out = await sendProspectEmail({
  contact: person, campaignId: 'camp-timeout', message: {}, env: envOK,
  fetchImpl: async () => { calls++; return { ok: true, status: 200, text: async () => '{}' }; },
  lookup: async () => ({ exists: true, id: 'msg_live_1' }),
});
check('it is recognised as already delivered', out.alreadySent === true, JSON.stringify(out));
check('the provider was still not called again', calls === before, `${before} -> ${calls}`);
check('and the provider id is carried through', out.providerId === 'msg_live_1');

// 4. a clean send records CONFIRMED
const person2 = (await upsertContact({ ...outboundProspectInput(), name: E('Clean Send'), businessName: E('CS Co'), email: E('cs@timeout.test') })).contact;
out = await sendProspectEmail({
  contact: person2, campaignId: 'camp-clean', message: {}, env: envOK,
  fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ id: 'msg_clean' }) }),
});
check('a clean send succeeds', out.sent === true, JSON.stringify(out));
const rec2 = await getSendAttempt('camp-clean:' + person2.id);
check('and is recorded as confirmed', rec2.state === SEND_OUTCOME.CONFIRMED, rec2.state);

// put outreach back to off so nothing inherits an active state
const raw2 = JSON.parse(await store.get('settings:business'));
await store.set('settings:business', JSON.stringify({ ...raw2, outreach: { active: false, reason: 'returned to off by the test suite' } }));

done();
