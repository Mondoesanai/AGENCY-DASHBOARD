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

done();
