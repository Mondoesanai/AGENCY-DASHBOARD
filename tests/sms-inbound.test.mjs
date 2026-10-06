// R6.14 — STOP is immediate and ours. HELP answers. Quiet hours are the
// recipient's. A provider failure is never silence.
//
// What this replaces is one line of trust:
//
//     if (cmd === 'stop') return ''; // Twilio handles STOP/opt-out itself
//
// Twilio does handle STOP at the carrier level, but relying on that alone
// means OUR records never learn it: the dashboard keeps showing the person as
// contactable, campaigns keep queueing, and the opt-out does not survive a
// change of provider or travel to email.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  INBOUND, STOP_WORDS, HELP_WORDS, QUIET_HOURS, SEND_FAILURE,
  classifyInbound, helpReply, stopReply, handleInboundSms,
  timezoneForNumber, hourIn, withinQuietHours,
  classifySendFailure, applySendFailure,
} from '../lib/sms-inbound.js';

const TX = '+12145557709'; // Dallas — Central
const CA = '+14155550134'; // San Francisco — Pacific
const UNKNOWN = '+13075551234'; // Wyoming 307, deliberately not in the map

// ---------------------------------------------------------------------------
section('Q1  STOP is recognised generously, START strictly');
for (const w of STOP_WORDS) {
  check(`"${w}" is a stop`, classifyInbound(w).kind === INBOUND.STOP);
  check(`"${w.toUpperCase()}." is a stop`, classifyInbound(`${w.toUpperCase()}.`).kind === INBOUND.STOP);
}
check('"please stop" is a stop', classifyInbound('please stop').kind === INBOUND.STOP);
check('"stop texting me" is a stop', classifyInbound('stop texting me').kind === INBOUND.STOP);
check('"Stop!" with punctuation is a stop', classifyInbound('Stop!').kind === INBOUND.STOP);
// ambiguity resolves towards stopping, because the cost of getting it wrong is
// continuing to message someone who told you to stop
check('a long message mentioning stop is left for a person', classifyInbound('I could not get the bus to stop at the right place this morning so I was late').kind === INBOUND.MESSAGE);

for (const w of HELP_WORDS) check(`"${w}" asks for help`, classifyInbound(w).kind === INBOUND.HELP);
check('"START" alone is a resubscribe', classifyInbound('START').kind === INBOUND.START);
check('but "yes please send details" is a reply, not a resubscribe', classifyInbound('yes please send details').kind === INBOUND.MESSAGE);
check('an ordinary reply is a message', classifyInbound('Sure, send it over').kind === INBOUND.MESSAGE);
check('an empty message does not throw', classifyInbound('').kind === INBOUND.MESSAGE);

// ---------------------------------------------------------------------------
section('Q2  the mandated replies say what carriers require');
const help = helpReply({ business: 'Inspiring Websites LLC', supportEmail: 'mondo@inspiring.test' });
check('HELP names the sender', /Inspiring Websites LLC/.test(help), help);
check('says why they are getting messages', /because you asked us to follow up/.test(help));
check('says how to stop', /Reply STOP to stop/.test(help));
check('and warns about rates', /Msg&data rates may apply/.test(help));
check('with support contact when there is one', /mondo@inspiring\.test/.test(help));
check('and still works with no business name set', helpReply({}).length > 30);
const bye = stopReply({ business: 'Inspiring Websites LLC' });
check('the STOP reply confirms it has stopped', /will not receive any further messages/.test(bye));
check('and offers a way back', /Reply START/.test(bye));

// ---------------------------------------------------------------------------
section('Q3  STOP is recorded by US, immediately');
await store.set(`suppress:phone:${TX}`, '').catch(() => {});
let out = await handleInboundSms({ from: TX, body: 'STOP', business: 'Inspiring Websites LLC' });
check('it is treated as a stop', out.kind === INBOUND.STOP, JSON.stringify(out));
check('the number is suppressed in our own store', !!(await store.get(`suppress:phone:${TX}`)));
check('and a confirmation is returned', /will not receive any further messages/.test(out.reply));
check('the stored reason says what they sent', /replied stop/.test(String(await store.get(`suppress:phone:${TX}`))));

// the promise: suppression happens even when everything downstream fails
{
  await store.set(`suppress:phone:${CA}`, '').catch(() => {});
  const realGet = store.get;
  // break contact lookup, campaign cancellation, everything after the write
  store.get = async (k) => {
    if (String(k).startsWith('contacts:') || String(k).startsWith('campaign')) throw new Error('store down');
    return realGet.call(store, k);
  };
  const o = await handleInboundSms({ from: CA, body: 'unsubscribe' });
  store.get = realGet;
  check('with everything downstream broken, the number is STILL suppressed', !!(await store.get(`suppress:phone:${CA}`)), JSON.stringify(o));
  check('and it still confirms to the person', o.suppressed === true);
}

// a stranger who was never a contact can still stop us
await store.set('suppress:phone:+12125550199', '').catch(() => {});
out = await handleInboundSms({ from: '+1 212 555 0199', body: 'STOP' });
check('a number we have no contact for is still suppressed', !!(await store.get('suppress:phone:+12125550199')), JSON.stringify(out));

// HELP must not suppress
await store.set(`suppress:phone:${TX}`, '').catch(() => {});
out = await handleInboundSms({ from: TX, body: 'HELP', business: 'B' });
check('HELP does not opt anyone out', !(await store.get(`suppress:phone:${TX}`)), JSON.stringify(out));
check('and answers', /Reply STOP to stop/.test(out.reply));

// START does not silently resubscribe
out = await handleInboundSms({ from: TX, body: 'START' });
check('START is not acted on automatically', out.needsPerson === true, JSON.stringify(out));
check('and says why a person decides', /Resubscribing is not automatic/.test(out.note));
check('it sends no reply of its own', out.reply === '');

out = await handleInboundSms({ from: TX, body: 'Sure, what would it cost?' });
check('a real reply goes to a person', out.needsPerson === true && out.kind === INBOUND.MESSAGE);
check('with nothing sent back automatically', out.reply === '');
check('and the text kept', /what would it cost/.test(out.text));

// ---------------------------------------------------------------------------
section('Q4  quiet hours are the RECIPIENT\'s');
check('a Dallas number is Central', timezoneForNumber(TX) === 'America/Chicago', String(timezoneForNumber(TX)));
check('a San Francisco number is Pacific', timezoneForNumber(CA) === 'America/Los_Angeles');
check('an unmapped area code is unknown, not guessed', timezoneForNumber(UNKNOWN) === null);
check('a non-NANP number is unknown', timezoneForNumber('+442079460958') === null);
check('the hour can be read for a known zone', typeof hourIn('America/Chicago') === 'number');
check('an invented zone yields null rather than a wrong hour', hourIn('Mars/Olympus') === null);

// 15:00 UTC is 09:00 Pacific and 10:00 Central — inside the window for both
const midday = Date.parse('2026-10-02T15:00:00Z');
check('mid-morning is allowed in Central', withinQuietHours(TX, { at: midday }).ok === true, JSON.stringify(withinQuietHours(TX, { at: midday })));
check('and in Pacific', withinQuietHours(CA, { at: midday }).ok === true);

// 13:00 UTC is 06:00 Pacific — too early THERE, though 08:00 Central is fine
const early = Date.parse('2026-10-02T13:00:00Z');
check('08:00 Central is allowed', withinQuietHours(TX, { at: early }).ok === true, JSON.stringify(withinQuietHours(TX, { at: early })));
// the whole point of the requirement
let q = withinQuietHours(CA, { at: early });
check('the SAME moment is refused for a Pacific number', q.ok === false, JSON.stringify(q));
check('and says what time it is where they are', /it is 6:00 where they are/.test(q.reason), q.reason);
check('with the hour it may resume', q.retryAfterHour === QUIET_HOURS.earliest);

// 03:00 UTC is 22:00 Central the previous evening — past the window
const late = Date.parse('2026-10-03T03:00:00Z');
check('10pm is refused', withinQuietHours(TX, { at: late }).ok === false, JSON.stringify(withinQuietHours(TX, { at: late })));

// the refusal that matters most
q = withinQuietHours(UNKNOWN, { at: midday });
check('an unknown timezone REFUSES rather than defaulting to allowed', q.ok === false, JSON.stringify(q));
check('and says why refusing is the safer error', /rather than risking the middle of the night/.test(q.reason), q.reason);
check('an explicit timezone overrides the area-code guess', withinQuietHours(UNKNOWN, { at: midday, timezone: 'America/Chicago' }).ok === true);

// ---------------------------------------------------------------------------
section('Q5  a provider failure is classified, never swallowed');
let v = classifySendFailure({ code: 21610 });
check('a carrier opt-out is recognised', v.kind === SEND_FAILURE.SUPPRESSED, JSON.stringify(v));
check('it must not be retried', v.retry === false);
check('and it tells us to record the opt-out ourselves', v.recordOptOut === true);
check('the message form is recognised too', classifySendFailure({ message: 'The message was blocked: recipient unsubscribed' }).kind === SEND_FAILURE.SUPPRESSED);

check('an invalid number is permanent', classifySendFailure({ code: 21211 }).kind === SEND_FAILURE.PERMANENT);
check('and is not retried', classifySendFailure({ code: 21211 }).retry === false);
check('a rate limit is transient', classifySendFailure({ code: 429 }).kind === SEND_FAILURE.TRANSIENT);
check('with a wait before retrying', classifySendFailure({ code: 429 }).retryAfterMs > 0);
check('a server error is transient', classifySendFailure({ status: 503 }).kind === SEND_FAILURE.TRANSIENT);
// the one that is not a failure at all
v = classifySendFailure({ message: 'socket hang up' });
check('a timeout is AMBIGUOUS, not a failure', v.kind === SEND_FAILURE.AMBIGUOUS, JSON.stringify(v));
check('and says it must be reconciled before any retry', /reconciled before any retry/.test(v.reason));
check('an unrecognised error is transient rather than discarded', classifySendFailure({ message: 'something new' }).kind === SEND_FAILURE.TRANSIENT);

// and the carrier's opt-out becomes ours
const CARRIER = '+12145550143';
await store.set(`suppress:phone:${CARRIER}`, '').catch(() => {});
v = await applySendFailure(CARRIER, { code: 21610 });
check('a carrier-reported opt-out is written into our records', !!(await store.get(`suppress:phone:${CARRIER}`)), JSON.stringify(v));
check('and flagged as locally suppressed', v.suppressedLocally === true);
check('the stored reason says where it came from', /carrier reported an opt-out/.test(String(await store.get(`suppress:phone:${CARRIER}`))));
await store.set(`suppress:phone:${CARRIER}`, '').catch(() => {});

// ---------------------------------------------------------------------------
section('Q6  the real send path refuses outside quiet hours');
{
  const { smsRefusal, SMS_REFUSAL } = await import('../lib/sms-outreach.js');
  // The send path is unreachable while SMS is off — every call is refused by
  // the standing owner decision long before quiet hours is reached — so the
  // sequence itself is what gets tested. An earlier version of this check just
  // grepped the source for `withinQuietHours(`, and a control that deleted the
  // REFUSAL while leaving the CALL passed it. Greps prove words, not behaviour.
  const ok = { ok: true };
  const base = { readiness: { ready: true }, number: '+12145557709', suppressed: false, permission: ok, sequence: ok, quiet: ok, adapterConfigured: true };
  check('with everything satisfied, nothing refuses', smsRefusal(base) === null);

  let r = smsRefusal({ ...base, quiet: { ok: false, reason: 'it is 6:00 where they are' } });
  check('quiet hours refuses the send', r?.code === SMS_REFUSAL.QUIET_HOURS, JSON.stringify(r));
  check('and carries the reason to the caller', /6:00 where they are/.test(r?.reason || ''));

  // the ORDER is the policy, so it is asserted rather than assumed
  r = smsRefusal({ ...base, readiness: { ready: false, blockers: [{ text: 'outreach is off' }] }, quiet: { ok: false, reason: 'late' } });
  check('readiness is checked before quiet hours', r.code === SMS_REFUSAL.NOT_READY, r.code);
  r = smsRefusal({ ...base, suppressed: true, permission: { ok: false, reason: 'no consent' } });
  check('an opt-out is checked before consent', r.code === SMS_REFUSAL.SUPPRESSED, r.code);
  r = smsRefusal({ ...base, permission: { ok: false, reason: 'no consent' }, quiet: { ok: false, reason: 'late' } });
  check('consent is checked before quiet hours', r.code === SMS_REFUSAL.NO_CONSENT, r.code);
  r = smsRefusal({ ...base, number: null, suppressed: true });
  check('a missing number is caught before anything about it', r.code === SMS_REFUSAL.NO_NUMBER, r.code);
  r = smsRefusal({ ...base, adapterConfigured: false });
  check('an unconfigured provider refuses last', r.code === SMS_REFUSAL.NOT_READY, r.code);
}

// ---------------------------------------------------------------------------
section('Q7  through the real webhook, as a carrier posts it');
{
  const handler = (await import('../api/collect.js')).default;
  const mk = () => {
    const r = { statusCode: 0, body: '', headers: {} };
    r.setHeader = (k, v) => { r.headers[k] = v; };
    r.status = (c) => { r.statusCode = c; return r; };
    r.send = (b) => { r.body = String(b); return r; };
    r.json = (b) => { r.body = JSON.stringify(b); return r; };
    r.end = () => r;
    return r;
  };
  // R18.1 — the hook verifies the Twilio signature now, so these sign properly.
  const { signedInboundReq, TEST_AUTH_TOKEN } = await import('./harness/twilio-sign.mjs');
  const tokenWas = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = TEST_AUTH_TOKEN;
  const NUM = '+12145550177';
  await store.set(`suppress:phone:${NUM}`, '').catch(() => {});

  let res = mk();
  await handler(signedInboundReq({ From: NUM, Body: 'STOP', MessageSid: 'SMt1' }), res);
  check('the webhook answers', res.statusCode === 200, String(res.statusCode));
  check('as TwiML', /text\/xml/.test(String(res.headers['Content-Type'] || '')));
  check('with a confirmation message', /<Message>/.test(res.body), res.body.slice(0, 120));
  check('and the number is suppressed', !!(await store.get(`suppress:phone:${NUM}`)));

  res = mk();
  await handler(signedInboundReq({ From: NUM, Body: 'Sure, what would it cost?', MessageSid: 'SMt2' }), res);
  check('an ordinary reply sends nothing back', res.body === '<Response/>', res.body);

  res = mk();
  await handler(signedInboundReq({ From: NUM, Body: 'HELP', MessageSid: 'SMt3' }), res);
  check('HELP replies', /<Message>/.test(res.body));
  await store.set(`suppress:phone:${NUM}`, '').catch(() => {});
  // Put the env back: leaving a token set would let a later section pass a
  // signature check it was not meant to reach.
  if (tokenWas == null) delete process.env.TWILIO_AUTH_TOKEN;
  else process.env.TWILIO_AUTH_TOKEN = tokenWas;
}

await store.set(`suppress:phone:${TX}`, '').catch(() => {});
await store.set(`suppress:phone:${CA}`, '').catch(() => {});
done();
