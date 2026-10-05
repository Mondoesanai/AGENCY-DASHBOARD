// SMS as a product workflow: compose, cost, schedule, send, deliver, converse.
//
// The backend gates already existed and are reused here rather than
// reimplemented — `mayText` for permission, quiet hours for timing, the Twilio
// adapter for transport. What is tested is the workflow built on top, and in
// particular the four refusals that make it safe to put in front of a person:
//
//   · permission is re-checked at SEND time, not trusted from schedule time
//   · a reply pauses every channel, not the one they replied on
//   · manual takeover CANCELS queued automatic replies rather than flagging them
//   · an unanswered cold email never becomes a text
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  segmentsFor, encodingOf, estimateCost, compose, schedule, send, getMessage,
  applyDeliveryReceipt, stats as smsStats, reconcileUsage, SMS_DELIVERY,
} from '../lib/sms-send.js';
import {
  record, thread, conversationFor, isPaused, setPaused, takeOver, ownership,
  mayAutoReply, chooseChannel, CHANNEL, DIRECTION, OWNER, MAX_AUTOMATIC_TURNS,
} from '../lib/conversations.js';

const NOW = Date.UTC(2026, 9, 6, 16); // a Tuesday afternoon — inside quiet hours
const consented = (over = {}) => ({
  id: 'sms-c1',
  name: { value: 'Jordan Hale' },
  phone: { value: '+12145550201' },
  email: { value: 'jordan@haleflooring.example' },
  consentLog: [{ scope: 'promotional', channel: 'sms', at: new Date(NOW - 86400e3).toISOString(), source: 'written opt-in at Plano Chamber', wording: 'Yes, text me about the preview' }],
  ...over,
});

// ---------------------------------------------------------------------------
section('M1  segments and cost are counted the way the carrier counts them');
check('a short message is one segment', segmentsFor('Hi Jordan').segments === 1);
check('160 GSM characters is still one', segmentsFor('a'.repeat(160)).segments === 1);
check('161 tips into two', segmentsFor('a'.repeat(161)).segments === 2);
check('an emoji forces UCS-2', encodingOf('hi 👋') === 'UCS2');
check('which halves the budget to 70', segmentsFor('中'.repeat(70)).segments === 1 && segmentsFor('中'.repeat(71)).segments === 2,
  JSON.stringify(segmentsFor('中'.repeat(71))));
check('an empty message is zero segments, not one', segmentsFor('').segments === 0);
check('an extended character costs two septets', segmentsFor('€'.repeat(80)).segments === 1 && segmentsFor('{'.repeat(81)).segments === 2);

const cost = await estimateCost('a'.repeat(200));
check('cost is reported', cost.estimatedCents > 0, JSON.stringify(cost));
check('and labelled an ESTIMATE', cost.isEstimate === true);
check('saying where a real number would come from', /provider's billing/i.test(cost.note), cost.note);

const noBilling = await reconcileUsage(null);
check('with no billing data, no actual cost is invented', noBilling.haveActual === false, JSON.stringify(noBilling));
check('and it says so plainly', /only the estimate/i.test(noBilling.reason), noBilling.reason);
const withBilling = await reconcileUsage({ totalCents: 412, period: '2026-10' });
check('with real billing, an actual is reported', withBilling.haveActual === true && withBilling.actualCents === 412);
check('and compared against the estimate', typeof withBilling.differenceCents === 'number');

// ---------------------------------------------------------------------------
section('M2  composing shows permission, cost and timing before anything is sent');
const draft = await compose({ contact: consented(), body: 'Hey Jordan, it\'s Mondoe with Inspiring Websites. Want me to send the preview here when it\'s ready?', at: NOW });
check('a permitted message composes', draft.ok === true, JSON.stringify(draft).slice(0, 220));
check('it reports the cost', draft.cost.segments >= 1);
check('and whether now is a sensible time', typeof draft.sendableNow === 'boolean');

const noConsent = await compose({ contact: consented({ consentLog: [] }), body: 'hello', at: NOW });
check('without SMS consent it refuses', noConsent.ok === false, JSON.stringify(noConsent).slice(0, 180));
check('and names consent as the reason', /permission|consent/i.test(noConsent.reason), noConsent.reason);

const empty = await compose({ contact: consented(), body: '   ', at: NOW });
check('an empty message is refused', empty.ok === false, JSON.stringify(empty));

// R9.8 prohibitions apply to texts as well as email
const priceText = await compose({ contact: consented(), body: 'Half price this week only!', at: NOW });
check('a price claim in a text is refused', priceText.ok === false, JSON.stringify(priceText).slice(0, 180));
check('naming the prohibition', /not allowed/i.test(priceText.reason || ''), priceText.reason);
const guarantee = await compose({ contact: consented(), body: 'Guaranteed #1 on Google', at: NOW });
check('so is a guarantee', guarantee.ok === false);

// ---------------------------------------------------------------------------
section('M3  permission is re-checked at SEND time, not trusted from scheduling');
await store.set('suppress:phone:+12145550201', '').catch(() => {});
const queued = await schedule({ contact: consented(), body: 'Hey Jordan, quick question about your site.', sendAt: NOW });
check('the message is queued', queued.ok === true, JSON.stringify(queued).slice(0, 180));
check('as scheduled, not sent', queued.message.state === SMS_DELIVERY.SCHEDULED);
check('carrying its segment count', queued.message.segments >= 1);

// they opt out in the gap between scheduling and sending
await store.set('suppress:phone:+12145550201', JSON.stringify({ at: new Date().toISOString(), reason: 'STOP' }));
const afterStop = await send(queued.message.id, { contact: consented(), env: {}, now: NOW });
check('the send is REFUSED because they opted out in the meantime', afterStop.ok === false, JSON.stringify(afterStop).slice(0, 200));
check('and it is marked as permission having changed', afterStop.permissionChanged === true || /opted out|permission/i.test(afterStop.error || ''), afterStop.error);
const deadMsg = await getMessage(queued.message.id);
check('the message is not left looking sendable', deadMsg.state !== SMS_DELIVERY.SCHEDULED, deadMsg.state);
await store.set('suppress:phone:+12145550201', '').catch(() => {});

// ---------------------------------------------------------------------------
section('M4  with no provider connected, nothing is sent and it says so');
const q2 = await schedule({ contact: consented(), body: 'Second try, all permitted.', sendAt: NOW });
const noProvider = await send(q2.message.id, { contact: consented(), env: {}, now: NOW });
check('it refuses', noProvider.ok === false, JSON.stringify(noProvider).slice(0, 160));
check('as disconnected rather than failed', noProvider.disconnected === true, JSON.stringify(noProvider).slice(0, 160));
check('and says no provider is connected', /no SMS provider/i.test(noProvider.error), noProvider.error);

// with a fixture provider it goes through
const sent = [];
const fetchImpl = async (url, opts) => {
  sent.push({ url, body: opts && opts.body });
  return { ok: true, status: 201, async json() { return { sid: 'SM_fixture_1', status: 'queued' }; }, async text() { return '{}'; } };
};
const env = { TWILIO_ACCOUNT_SID: 'AC_fixture', TWILIO_AUTH_TOKEN: 'tok_fixture', TWILIO_SMS_FROM: '+15550000000' };
const ok = await send(q2.message.id, { contact: consented(), env, fetchImpl, now: NOW });
check('with a provider it is accepted', ok.ok === true, JSON.stringify(ok).slice(0, 180));
check('exactly one outbound call', sent.length === 1, String(sent.length));
check('to the provider, carrying the number and the text', /twilio\.com/.test(sent[0].url) && /2145550201/.test(String(sent[0].body)),
  String(sent[0] && sent[0].body).slice(0, 120));
const accepted = await getMessage(q2.message.id);
check('state is ACCEPTED, not delivered', accepted.state === SMS_DELIVERY.ACCEPTED, accepted.state);
check('because accepted is not delivered', SMS_DELIVERY.ACCEPTED !== SMS_DELIVERY.DELIVERED);
check('and it is in the conversation', (await thread('sms-c1')).messages.some((m) => m.channel === CHANNEL.SMS && m.direction === DIRECTION.OUT));

// ---------------------------------------------------------------------------
section('M5  a delivery receipt is what turns accepted into delivered');
const receipt = await applyDeliveryReceipt({ providerId: 'SM_fixture_1', status: 'delivered' });
check('the receipt matches the message', receipt.ok === true, JSON.stringify(receipt));
check('and it becomes delivered', (await getMessage(q2.message.id)).state === SMS_DELIVERY.DELIVERED);
const unmatched = await applyDeliveryReceipt({ providerId: 'SM_does_not_exist', status: 'delivered' });
check('a receipt for an unknown message is reported, not swallowed', unmatched.ok === false && unmatched.unmatched === true);

const s = await smsStats();
check('the report separates attempted, delivered and unknown', typeof s.attempted === 'number' && typeof s.delivered === 'number' && typeof s.deliveryUnknown === 'number', JSON.stringify(s));
check('and flags the cost as an estimate', s.costIsEstimate === true);

// ---------------------------------------------------------------------------
section('M6  a reply pauses EVERY channel, not just the one they used');
await record({ contactId: 'sms-c1', channel: CHANNEL.SMS, direction: DIRECTION.IN, body: 'Send it here', at: NOW + 1000 });
const paused = await isPaused('sms-c1');
check('the conversation is paused', paused.paused === true, JSON.stringify(paused));
check('and says it was because they replied', /replied/i.test(paused.reason), paused.reason);

const chosen = await chooseChannel(consented(), { purpose: 'promotional' });
check('nothing is scheduled while paused', chosen.ok === false, JSON.stringify(chosen));

// ---------------------------------------------------------------------------
section('M7  manual takeover CANCELS queued automatic replies');
const { enqueue, getJob, JOB_STATE } = await import('../lib/jobs.js');
const queuedReply = await enqueue({ type: 'auto-answer', payload: { contactId: 'sms-c1', draft: 'an AI answer' } });
check('an automatic reply is queued', !!queuedReply.job, JSON.stringify(queuedReply).slice(0, 120));

const over = await takeOver('sms-c1', { by: 'owner' });
check('takeover succeeds', over.ok === true, JSON.stringify(over).slice(0, 160));
check('and it CANCELLED the queued reply', over.cancelledQueuedReplies >= 1, JSON.stringify(over).slice(0, 180));
const cancelled = await getJob(queuedReply.job.id);
check('the job really is cancelled', cancelled.state === JOB_STATE.CANCELLED, cancelled.state);
check('with the reason recorded', /took over/i.test(cancelled.cancelledReason || ''), cancelled.cancelledReason);

// and a worker that finishes it afterwards must not undo the cancellation
const { complete } = await import('../lib/jobs.js');
const late = await complete(queuedReply.job.id, { sent: true });
check('a worker completing it afterwards is refused', late.ok === false && late.cancelled === true, JSON.stringify(late).slice(0, 140));

const own = await ownership('sms-c1');
check('the conversation now belongs to a person', own.mode === OWNER.PERSON, own.mode);
const auto = await mayAutoReply('sms-c1');
check('and nothing automatic may answer', auto.ok === false, JSON.stringify(auto));
check('saying a person has taken over', /took over|taken over/i.test(auto.reason), auto.reason);

// ---------------------------------------------------------------------------
section('M8  automatic answering is bounded and escalates');
await store.set('conv:owner:bounded', JSON.stringify({ mode: OWNER.AUTOMATIC, by: 'owner', at: NOW }));
await store.set('conv:paused:bounded', '').catch(() => {});
for (let i = 0; i < MAX_AUTOMATIC_TURNS; i++) {
  await record({ contactId: 'bounded', channel: CHANNEL.SMS, direction: DIRECTION.OUT, body: `auto ${i}`, by: 'automatic', at: NOW + i });
}
const spent = await mayAutoReply('bounded');
check('after the turn budget, automatic answering stops', spent.ok === false, JSON.stringify(spent));
check('and escalates to a person', spent.escalate === true);
check('saying how many already went', new RegExp(String(MAX_AUTOMATIC_TURNS)).test(spent.reason), spent.reason);

await store.set('conv:owner:lowconf', JSON.stringify({ mode: OWNER.AUTOMATIC, by: 'owner', at: NOW }));
const lowConf = await mayAutoReply('lowconf', { confidence: 0.3 });
check('a low-confidence draft is not sent unseen', lowConf.ok === false && lowConf.escalate === true, JSON.stringify(lowConf));
const offTopic = await mayAutoReply('lowconf', { confidence: 0.99, topicApproved: false });
check('nor is an unapproved topic', offTopic.ok === false && offTopic.escalate === true, JSON.stringify(offTopic));
const fine = await mayAutoReply('lowconf', { confidence: 0.9, topicApproved: true });
check('a confident, approved reply on an automatic conversation is allowed', fine.ok === true, JSON.stringify(fine));

// ---------------------------------------------------------------------------
section('M9  an unanswered cold email NEVER becomes a text');
const coldGuy = { id: 'cold-1', name: { value: 'Pat' }, phone: { value: '+12145550299' },
  email: { value: 'pat@coldbiz.example' },
  consentLog: [{ scope: 'promotional', channel: 'sms', at: new Date(NOW).toISOString(), source: 'written opt-in', wording: 'yes' }] };
await store.set('conv:paused:cold-1', '').catch(() => {});
await record({ contactId: 'cold-1', channel: CHANNEL.EMAIL, direction: DIRECTION.OUT, body: 'cold pitch', campaignId: 'cold-camp', at: NOW });

const escalation = await chooseChannel(coldGuy, { purpose: 'promotional' });
check('switching them to SMS is REFUSED', escalation.ok === false, JSON.stringify(escalation));
check('and it is named as a prohibition', escalation.prohibited === true);
check('saying the answer is to stop, not to switch channel', /stop, not to switch/i.test(escalation.reason), escalation.reason);

// but once they reply, the conversation continues where they are
await record({ contactId: 'cold-1', channel: CHANNEL.SMS, direction: DIRECTION.IN, body: 'who is this?', at: NOW + 5000 });
await setPaused('cold-1', false, { reason: 'owner resumed to answer' });
const afterReply = await chooseChannel(coldGuy, { purpose: 'one_time_followup' });
check('after they reply on SMS, SMS is the channel', afterReply.ok === true && afterReply.channel === CHANNEL.SMS, JSON.stringify(afterReply));
check('because that is where they answered', /replied on sms/i.test(afterReply.reason), afterReply.reason);

// ---------------------------------------------------------------------------
section('M10  the inbox shows one conversation per person, both channels');
const conv = await conversationFor('cold-1');
check('the conversation reads', conv.ok === true);
check('it holds both channels', new Set(conv.messages.map((m) => m.channel)).size === 2, JSON.stringify(conv.messages.map((m) => m.channel)));
check('it knows the last inbound', !!conv.lastInbound && conv.lastInbound.body === 'who is this?');
check('and who owns it', !!conv.ownership && !!conv.ownership.mode);

done();
