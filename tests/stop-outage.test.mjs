// Does STOP survive a store outage? Not "did it return 200".
//
// R19.6. The previous report said STOP is accepted during a KV outage. That
// was true in the only sense that does not matter: the endpoint returned 200.
// What actually happened was that the suppression write failed, `.catch(() => {})`
// swallowed it, the result said `suppressed: true` anyway, the person got a
// "you have been unsubscribed" reply, and nothing ever reconciled it.
//
// So this file does not check status codes as evidence. It checks the only two
// things that protect a person who said stop:
//
//   A. THE RECORD. If the write succeeded, suppression is permanent and the
//      send path refuses them for ever.
//   B. INDEPENDENT ENFORCEMENT. If the write failed, sending must be refused
//      ANYWAY, for as long as the outage lasts — because `mayText` fails
//      closed on an unreadable suppression list. And the failure must be
//      REPORTED, not hidden, so the opt-out can be re-applied.
//
// The negative control is the one that matters most: with the store healthy,
// the same calls must SUCCEED. Otherwise everything below passes simply
// because nothing can ever be sent.

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { startLocalApi } from './harness/local-api.mjs';
import { signedInboundReq, TEST_AUTH_TOKEN } from './harness/twilio-sign.mjs';

process.env.TWILIO_AUTH_TOKEN = TEST_AUTH_TOKEN;

const { handleInboundSms, INBOUND } = await import('../lib/sms-inbound.js');
const { mayText } = await import('../lib/phone.js');

const NUM = '+15557770222';
const OTHER = '+15557770333';

/**
 * A contact who HAS promotional permission.
 *
 * Deliberate: testing suppression against a contact with no consent would pass
 * for the wrong reason — `mayText` refuses them for having no consent and never
 * reaches the suppression check at all. The only way to prove STOP is doing the
 * work is to give the contact everything else it needs.
 */
const consented = (id, phone) => ({
  id, phone: { value: phone },
  consentLog: [{
    at: Date.now() - 1000, channel: 'sms', kind: 'granted',
    basis: 'handset confirmation', scope: 'promotional', evidence: 'texted PREVIEW',
  }],
});

/** The reply we send someone who opted out, in whatever words it uses. */
const soundsLikeAStopConfirmation = (t) =>
  /not receive any further|unsubscrib|no more messages|you will not receive/i.test(String(t || ''));

/** Make every write fail, the way a KV outage does. */
function breakStore() {
  const real = { set: store.set, get: store.get, incr: store.incr, del: store.del };
  store.set = async () => { throw new Error('kv unavailable'); };
  store.get = async () => { throw new Error('kv unavailable'); };
  store.incr = async () => { throw new Error('kv unavailable'); };
  store.del = async () => { throw new Error('kv unavailable'); };
  return () => Object.assign(store, real);
}

// ---------------------------------------------------------------------------
section('A  with the store healthy, STOP is recorded and permanent');
const healthy = await handleInboundSms({ from: NUM, body: 'STOP', business: 'Inspiring Websites' });
check('it is recognised as a stop', healthy.kind === INBOUND.STOP);
check('and REPORTED as recorded', healthy.recorded === true, JSON.stringify(healthy).slice(0, 200));
check('nothing is left unreconciled', healthy.unreconciled === false);
check('the person is told', soundsLikeAStopConfirmation(healthy.reply), healthy.reply);

const raw = await store.get(`suppress:phone:${NUM}`);
check('the suppression really is in the store', !!raw, String(raw));

const afterStop = await mayText({ contact: consented('c1', NUM), purpose: 'one_time_followup' });
check('and the send path now refuses that number', afterStop.ok === false, JSON.stringify(afterStop));
check('naming the opt-out as the reason', afterStop.code === 'opted-out', afterStop.code);

// NEGATIVE CONTROL: a different number must still be sendable, or the refusal
// above proves nothing.
const control = await mayText({ contact: consented('c2', OTHER), purpose: 'one_time_followup' });
check('NEGATIVE CONTROL: a consented, unsuppressed number is NOT refused for opt-out',
  control.code !== 'opted-out' && control.code !== 'opted-out-unknown',
  `${control.code}: ${control.reason}`);

// ---------------------------------------------------------------------------
section('B  during an outage the write fails — and is reported, not claimed');
let restore = breakStore();
const outage = await handleInboundSms({ from: OTHER, body: 'STOP', business: 'Inspiring Websites' });
restore();

check('it is still recognised as a stop', outage.kind === INBOUND.STOP);
check('but it does NOT claim to have recorded it', outage.recorded === false,
  'this is the exact assertion the old code failed: it said suppressed:true regardless');
check('and `suppressed` agrees with `recorded`', outage.suppressed === false,
  'one field meaning both "we intend to" and "we did" is how the loss stayed invisible');
check('it is flagged as unreconciled', outage.unreconciled === true);
check('the store error is carried, not swallowed', !!outage.storeError, String(outage.storeError));
check('and it says what IS protecting them meanwhile',
  /mayText fails closed|blocked only while/i.test(outage.enforcement || ''), outage.enforcement);
check('the person is still told they are unsubscribed',
  soundsLikeAStopConfirmation(outage.reply), outage.reply);

section('B2  INDEPENDENT ENFORCEMENT: nothing can be sent during the outage');
restore = breakStore();
const duringOutage = await mayText({ contact: consented('c2', OTHER), purpose: 'one_time_followup' });
const duringOutageOther = await mayText({ contact: consented('c3', '+15557770444'), purpose: 'one_time_followup' });
restore();
check('the number that just said STOP cannot be texted', duringOutage.ok === false, JSON.stringify(duringOutage));
check('because the suppression list is unreadable, not because it was read',
  duringOutage.code === 'opted-out-unknown', duringOutage.code);
check('and NO consented number can be texted either', duringOutageOther.ok === false,
  'this is the property that makes the lost write survivable: the outage that loses it also stops every send');
check('so the lost opt-out cannot be violated while it is lost',
  duringOutage.ok === false && duringOutageOther.ok === false);

section('B3  the enforcement ends with the outage, which is why it is reported');
const afterRecovery = await mayText({ contact: consented('c2', OTHER), purpose: 'one_time_followup' });
check('once the store recovers, that number IS sendable again',
  afterRecovery.code !== 'opted-out' && afterRecovery.code !== 'opted-out-unknown',
  `${afterRecovery.code}: ${afterRecovery.reason}`);
check('which is exactly why the failure had to be reported rather than swallowed',
  outage.recorded === false && outage.unreconciled === true,
  'the protection is temporary, so the record of its absence is the thing that closes the gap');

// Re-applying it works and is permanent, so reconciliation is a real action.
const reapplied = await handleInboundSms({ from: OTHER, body: 'STOP', business: 'Inspiring Websites' });
check('re-applying the opt-out records it', reapplied.recorded === true);
const sealed = await mayText({ contact: consented('c2', OTHER), purpose: 'one_time_followup' });
check('and it is refused permanently thereafter', sealed.ok === false && sealed.code === 'opted-out');

// ---------------------------------------------------------------------------
section('C  the webhook does not answer 200 for an opt-out it could not record');
const api = await startLocalApi({ port: 0 });

const post = (signed) => api.request(signed.url, {
  method: 'POST',
  headers: signed.headers,
  body: new URLSearchParams(signed.body).toString(),
});

const okRes = await post(signedInboundReq({ From: '+15557770555', Body: 'STOP', MessageSid: `SM${Date.now()}a` }));
check('a recorded STOP answers 200', okRes.status === 200, String(okRes.status));

restore = breakStore();
const badRes = await post(signedInboundReq({ From: '+15557770666', Body: 'STOP', MessageSid: `SM${Date.now()}b` }));
restore();
check('an UNRECORDED STOP does not answer 200', badRes.status !== 200, String(badRes.status));
check('it answers 503, so it appears in the provider error log', badRes.status === 503, String(badRes.status));
check('and the person is still sent the stop confirmation',
  /Message>/.test(String(badRes.text || '')), String(badRes.text || '').slice(0, 200));

section('C1b  the dedupe override is NARROW: only opt-outs get through');
// The bug behind the one above: when the store cannot answer, `claimEventOnce`
// says "not fresh", and every inbound message was discarded as a duplicate —
// including every STOP, with an empty 200 and no record. The fix must not
// become "process everything twice during an outage": re-applying a STOP is a
// no-op, re-applying a consent keyword is not.
const { claimEventOnce } = await import('../lib/webhooks.js');
const known = await claimEventOnce('stop-outage-test', 'evt-1');
check('a first sighting is fresh', known.fresh === true);
const second = await claimEventOnce('stop-outage-test', 'evt-1');
check('a genuine duplicate is marked as one', second.fresh === false && second.duplicate === true);
check('and is NOT marked unknown', !second.unknown,
  'a known duplicate must stay droppable — the override applies only where we cannot tell');

restore = breakStore();
const cannotTell = await claimEventOnce('stop-outage-test', 'evt-2');
restore();
check('an unanswerable check is marked unknown', cannotTell.fresh === false && cannotTell.unknown === true,
  'this is the flag that lets the caller treat a lost opt-out differently from a duplicate one');

restore = breakStore();
const keywordDuringOutage = await post(signedInboundReq({ From: '+15557770777', Body: 'PREVIEW', MessageSid: `SM${Date.now()}c` }));
restore();
check('a CONSENT keyword during an outage is still dropped, not applied',
  keywordDuringOutage.status === 200 && /^<Response\/>$/.test(String(keywordDuringOutage.text || '').trim()),
  `${keywordDuringOutage.status} ${String(keywordDuringOutage.text || '').slice(0, 120)}`);
check('so no promotional permission can be granted while the ledger is unreadable',
  !(await store.get('optin:pending:+15557770777').catch(() => null)));

section('C2  what a 200 does and does not prove');
check('a 200 on this endpoint now means the write succeeded',
  okRes.status === 200 && !!(await store.get('suppress:phone:+15557770555')),
  'previously a 200 was returned either way, which is why the report could say STOP was accepted when it was lost');

done();
