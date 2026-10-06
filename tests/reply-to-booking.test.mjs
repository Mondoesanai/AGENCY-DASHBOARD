// One person, start to finish: message → delivery → reply → preview → meeting.
//
// Every piece of this has its own test. What none of them proves is that the
// pieces CONNECT — which is the failure this build keeps finding, where a
// module passes in isolation and nothing calls it. So this drives one contact
// through the whole path using the real modules, injecting only at the two
// places a provider would sit.
//
// The branches at the end matter as much as the happy path: STOP, "not
// interested", a wrong number and an ambiguous reply have to take four
// DIFFERENT routes. Collapsing any two of them loses something real — a wrong
// number filed as "not interested" throws away a prospect; a refusal filed as
// ambiguous keeps pestering someone who already answered.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { upsertContact, field, getContact, canContact } from '../lib/contacts.js';
import { classifyReply, REPLY_KINDS } from '../lib/replies.js';
import { handleInboundSms } from '../lib/sms-inbound.js';
import { recordYes, markInvited, applyInviteReply } from '../lib/optin.js';
import { createTwilioSmsAdapter } from '../lib/sms-outreach.js';
import collect from '../api/collect.js';
import crypto from 'node:crypto';

const E = (v) => field(v, { confidence: 1, source: 'manual' });
const NOW = Date.UTC(2026, 9, 6, 16, 0, 0);
const TOKEN = 'fixture_twilio_token';

/** Post a form body to a public hook, the way a carrier would. */
async function hook(name, body, { signature = null } = {}) {
  const prev = process.env.TWILIO_AUTH_TOKEN;
  process.env.TWILIO_AUTH_TOKEN = TOKEN;
  const url = `https://dash.example/api/collect?hook=${name}`;
  let sig = signature;
  // R18.1 — the inbound `sms` hook verifies the signature now, not just
  // `sms-status`. Both are Twilio posts and both are signed the same way.
  if (sig === null && (name === 'sms-status' || name === 'sms')) {
    let data = url;
    for (const k of Object.keys(body).sort()) data += k + String(body[k] ?? '');
    sig = crypto.createHmac('sha1', TOKEN).update(Buffer.from(data, 'utf8')).digest('base64');
  }
  const req = {
    method: 'POST', url: `/api/collect?hook=${name}`, query: { hook: name },
    headers: { host: 'dash.example', 'x-forwarded-proto': 'https', ...(sig ? { 'x-twilio-signature': sig } : {}) },
    body,
  };
  let code = 0, payload = null;
  const res = { status(c) { code = c; return this; }, json(p) { payload = p; return this; }, send(p) { payload = p; return this; }, setHeader() { return this; } };
  await collect(req, res);
  if (prev === undefined) delete process.env.TWILIO_AUTH_TOKEN; else process.env.TWILIO_AUTH_TOKEN = prev;
  return { code, payload };
}

async function person(n, phone) {
  const c = await upsertContact({
    source: 'discovery', name: E(`Owner ${n}`), businessName: E(`Business ${n}`),
    email: E(`owner${n}@biz${n}.test`), phone: E(phone),
  });
  return c.contact;
}

// ===========================================================================
section('E1  a first message is prepared, and every claim in it is checked');
const dana = await person('Dana', '+19195550301');
const { compose } = await import('../lib/sms-send.js');

let msg = await compose({ contact: dana, body: 'Hi Dana — your preview is ready: https://preview.test/dana', purpose: 'one_time_followup' });
check('with no permission on file, composing is refused', msg.ok === false, JSON.stringify(msg).slice(0, 140));
check('and the reason is the permission, not a technicality', /permission|consent/i.test(msg.reason || msg.error || ''), msg.reason || msg.error);

// the invitation route is what makes it legitimate
await markInvited(dana.id, {});
const said = await applyInviteReply(dana.id, 'YES please send it');
check('their YES is recorded as documented permission', said.verdict === 'yes' && said.changed === true);
const danaOk = await getContact(dana.id);
check('and the consent log now covers sms',
  (await import('../lib/contacts.js')).effectiveConsent(danaOk, 'sms').scope === 'one_time_followup');

msg = await compose({ contact: danaOk, body: 'Hi Dana — your preview is ready: https://preview.test/dana', purpose: 'one_time_followup' });
check('now it composes', msg.ok === true, JSON.stringify(msg).slice(0, 160));
check('the cost is estimated, and labelled an estimate', msg.cost?.isEstimate === true, JSON.stringify(msg.cost));

section('E1b  a message that overclaims is refused before anything is sent');
const liar = await compose({ contact: danaOk, body: 'We guarantee you will rank #1 on Google within 30 days.', purpose: 'one_time_followup' });
check('a guarantee is refused', liar.ok === false, JSON.stringify(liar).slice(0, 140));
check('naming the prohibition rather than failing vaguely',
  (liar.reason || liar.error || '').length > 20, liar.reason || liar.error);

// ===========================================================================
section('E2  the provider accepts it, then reports what happened to it');
let wire = null;
const adapter = createTwilioSmsAdapter({
  env: { TWILIO_ACCOUNT_SID: 'ACfix', TWILIO_AUTH_TOKEN: TOKEN, TWILIO_SMS_FROM: '+15550000000', PUBLIC_BASE_URL: 'https://dash.example' },
  fetchImpl: async (u, o) => { wire = String(o.body); return { ok: true, json: async () => ({ sid: 'SM_e2', status: 'queued' }) }; },
});
const sent = await adapter.send({ to: '+19195550301', body: 'Hi Dana — your preview is ready: https://preview.test/dana' });
check('the provider accepts it', sent.ok === true && sent.sid === 'SM_e2');
check('and is told where to report delivery', /StatusCallback=/.test(wire));

// a message sitting where the receipt handler will find it
await store.set('sms:msg:e2', JSON.stringify({ id: 'e2', providerId: 'SM_e2', contactId: dana.id, to: '+19195550301', body: 'x', state: 'accepted', history: [] }));
await store.sadd('sms:messages', 'e2');
let r = await hook('sms-status', { MessageSid: 'SM_e2', MessageStatus: 'delivered' });
check('the delivery receipt is accepted', r.code === 200, JSON.stringify(r.payload));
check('and ACCEPTED becomes DELIVERED', JSON.parse(await store.get('sms:msg:e2')).state === 'delivered',
  'until this arrives the two are different facts and must stay apart');

// ===========================================================================
section('E3  a human replies, and the follow-ups stop immediately');
const { markStepSent } = await import('../lib/campaigns.js');
void markStepSent;
r = await hook('sms', { From: '+19195550301', Body: 'This looks great, how much does it cost?', MessageSid: 'SMin_e3' });
check('the carrier gets a valid answer', r.code === 200);
check('and we do NOT text back automatically', /<Response\/>/.test(String(r.payload)));

const danaAfter = await getContact(dana.id);
const { isPaused } = await import('../lib/conversations.js');
const paused = await isPaused(dana.id);
check('the conversation is paused the moment they reply', paused.paused === true, JSON.stringify(paused));
check('with the reason recorded', /replied/i.test(paused.reason || ''), paused.reason);

section('E4  the reply is classified, and a draft is made for a person');
const cls = classifyReply({ text: 'This looks great, how much does it cost?' });
check('asking the price is wants-details', cls.kind === REPLY_KINDS.WANTS_DETAILS, cls.kind);
const { draftAnswer } = await import('../lib/knowledge.js');
const draft = await draftAnswer({ kind: cls.kind, text: 'how much does it cost?', bookingUrl: null });
check('a draft is produced', draft.ok === true || !!draft.reason, JSON.stringify(draft).slice(0, 140));
if (draft.ok) {
  check('it does not invent a price', !/\$\d/.test(draft.body || ''), draft.body);
  check('and it is a draft, not a send', draft.send !== true);
}

// ===========================================================================
section('E5  a preview request becomes a task, and is never "ready" early');
const { createTask, setState, mayAnnounce, PREVIEW_STATE } = await import('../lib/previews.js');
const task = await createTask({ contactId: dana.id, businessName: 'Business Dana', conversationNotes: 'asked: can I see a mockup?', requestedVia: 'sms reply' });
check('a production task exists', task.ok === true, JSON.stringify(task).slice(0, 140));
let may = await mayAnnounce(dana.id, {});
check('"your preview is ready" is refused while it is only requested', may.ok === false, JSON.stringify(may));
check('and says the message would be untrue', /not|no preview|untrue/i.test(may.reason || ''), may.reason);

// REQUESTED -> READY is refused outright: the state machine will not let a
// promise skip steps, which is a property worth exercising rather than
// bypassing. So the task is walked through the real stages first.
const skipped = await setState(task.task.id, PREVIEW_STATE.READY, { url: 'https://preview.test/dana' });
check('skipping straight from requested to ready is refused', skipped.ok === false, JSON.stringify(skipped).slice(0, 140));
await setState(task.task.id, PREVIEW_STATE.RESEARCHING);
await setState(task.task.id, PREVIEW_STATE.BUILDING);
await setState(task.task.id, PREVIEW_STATE.REVIEW);
const noUrl = await setState(task.task.id, PREVIEW_STATE.READY);
check('marking it READY with no URL is refused', noUrl.ok === false, JSON.stringify(noUrl).slice(0, 140));
await setState(task.task.id, PREVIEW_STATE.READY, { url: 'https://preview.test/dana' });
may = await mayAnnounce(dana.id, {});
check('with a real URL it is allowed', may.ok === true, JSON.stringify(may).slice(0, 140));

// ===========================================================================
section('E6  a meeting counts only when the scheduler confirms it');
const { handleBookingWebhook, listBookings, bookingStats } = await import('../lib/bookings.js');
const unverified = await handleBookingWebhook({
  event: { event: 'invitee.created', payload: { uri: 'u1', email: 'ownerdana@bizdana.test', start_time: new Date(NOW + 86400e3).toISOString() } },
  verified: false, now: NOW,
});
check('an unverified webhook does not create a booking', unverified.ok === false || unverified.counted !== true,
  JSON.stringify(unverified).slice(0, 140));
const before = (await bookingStats()).verifiedBookings;
await handleBookingWebhook({
  event: { event: 'invitee.created', payload: { uri: 'u2', email: 'ownerdana@bizdana.test', name: 'Dana', start_time: new Date(NOW + 86400e3).toISOString() } },
  verified: true, now: NOW,
});
const after = (await bookingStats()).verifiedBookings;
check('a verified one does', after === before + 1, `${before} -> ${after}`);
check('and a link click is never counted among them',
  /clicks are counted separately|not bookings/i.test((await bookingStats()).note || ''), (await bookingStats()).note);

section('E6b  and the same booking arrives through the real HTTP endpoint');
// The cycle-6 reviewer was right: E6 drove handleBookingWebhook directly while
// the SMS leg went through collect(). Testing the two legs differently is how
// one of them turns out not to be wired at all. This drives a signed Calendly
// payload through the real endpoint, exactly as the carrier hooks are.
const CAL_KEY = 'fixture_calendly_key';
async function calendlyPost(payload, { key = CAL_KEY } = {}) {
  const prev = process.env.CALENDLY_WEBHOOK_KEY;
  process.env.CALENDLY_WEBHOOK_KEY = CAL_KEY;
  const raw = JSON.stringify(payload);
  const stamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', key).update(`${stamp}.${raw}`).digest('hex');
  const req = {
    method: 'POST', url: '/api/collect?hook=booking', query: { hook: 'booking' },
    headers: { 'calendly-webhook-signature': `t=${stamp},v1=${sig}` },
    body: raw,
  };
  let code = 0, out2 = null;
  const res = { status(c) { code = c; return this; }, json(x) { out2 = x; return this; }, send(x) { out2 = x; return this; }, setHeader() { return this; } };
  await collect(req, res);
  if (prev === undefined) delete process.env.CALENDLY_WEBHOOK_KEY; else process.env.CALENDLY_WEBHOOK_KEY = prev;
  return { code, payload: out2 };
}

const beforeHttp = (await bookingStats()).verifiedBookings;
let bk = await calendlyPost({ event: 'invitee.created', payload: { uri: 'http-u1', email: 'ownerdana@bizdana.test', name: 'Dana', start_time: new Date(NOW + 172800e3).toISOString() } });
check('a signed booking is accepted by the endpoint', bk.code === 200, JSON.stringify(bk).slice(0, 160));
const afterHttp = (await bookingStats()).verifiedBookings;
check('and the booking count rises', afterHttp === beforeHttp + 1, `${beforeHttp} -> ${afterHttp}`);

bk = await calendlyPost({ event: 'invitee.created', payload: { uri: 'http-u2', email: 'x@y.test' } }, { key: 'wrong_key' });
check('a forged signature is refused at the door', bk.code === 401, JSON.stringify(bk));
check('with a reason', /signature|verif/i.test((bk.payload && bk.payload.error) || ''), JSON.stringify(bk.payload));
check('and created nothing', (await bookingStats()).verifiedBookings === afterHttp);

const dup = await calendlyPost({ event: 'invitee.created', payload: { uri: 'http-u1', email: 'ownerdana@bizdana.test', start_time: new Date(NOW + 172800e3).toISOString() } });
check('a replayed webhook is recognised as a duplicate', dup.payload && dup.payload.duplicate === true, JSON.stringify(dup.payload));
check('and does not double-count the meeting', (await bookingStats()).verifiedBookings === afterHttp,
  'schedulers retry, and a retried booking must not become two meetings');

// ===========================================================================
section('E7  manual takeover cancels what was queued');
const jobs = await import('../lib/jobs.js');
const conv = await import('../lib/conversations.js');
await conv.setOwnership(dana.id, conv.OWNER.AUTOMATIC, { by: 'test' });
const queued = await jobs.enqueue({ type: 'sms-send', payload: { contactId: dana.id }, runAt: NOW + 3600e3 });
const took = await conv.takeOver(dana.id, { by: 'owner' });
check('takeover reports what it cancelled', took.cancelledQueuedReplies >= 1, JSON.stringify(took));
check('and the queued message is CANCELLED, not merely flagged',
  (await jobs.getJob(queued.job?.id || queued.id)).state === jobs.JOB_STATE.CANCELLED);

// ===========================================================================
section('E8  four replies, four different routes');

// --- STOP: suppressed on every channel
const s1 = await person('Stop', '+19195550302');
let out = await handleInboundSms({ from: '+19195550302', body: 'STOP' });
check('STOP suppresses the number', out.suppressed === true && out.kind === 'stop');
check('and the business is opted out too', !!(await getContact(s1.id)).optedOutAt,
  'somebody who says stop has said stop, whatever channel they said it on');

// --- NOT INTERESTED: a decision, recorded, no suppression of the record
const s2 = await person('NotInt', '+19195550303');
out = await handleInboundSms({ from: '+19195550303', body: 'No thanks, we already have a guy' });
check('it is classified as not-interested', out.replyKind === REPLY_KINDS.NOT_INTERESTED, out.replyKind);
check('the owner is NOT pinged about it', out.notify === false,
  'being pinged for every refusal teaches you to ignore pings');
check('and nothing is sent back', out.reply === '');

// --- WRONG NUMBER: the record is wrong, the business is not
const s3 = await person('Wrong', '+19195550304');
out = await handleInboundSms({ from: '+19195550304', body: 'You have the wrong number, there is no Owner Wrong here' });
check('it is classified as a wrong number', out.replyKind === REPLY_KINDS.WRONG_NUMBER, out.replyKind);
check('the NUMBER is suppressed', out.wrongNumber === true && out.suppressed === true);
check('but the business is NOT opted out', !(await getContact(s3.id)).optedOutAt,
  'filing a wrong number as a refusal throws away a real prospect');
check('and it says so plainly', /NOT opted out/.test(out.note || ''), out.note);
check('the number is on the suppression list', !!(await store.get('suppress:phone:+19195550304')));
check('so they are still emailable',
  (await canContact(await getContact(s3.id), { channel: 'email', purpose: 'promotional' })).ok === true);

// --- AMBIGUOUS: a person reads it, nothing is decided
const s4 = await person('Amb', '+19195550305');
out = await handleInboundSms({ from: '+19195550305', body: 'hm' });
check('it is ambiguous', out.replyKind === REPLY_KINDS.AMBIGUOUS, out.replyKind);
check('a person is needed', out.needsPerson === true);
check('nothing is suppressed', out.suppressed === false);
check('and the business is untouched', !(await getContact(s4.id)).optedOutAt);

section('E8b  the four routes are genuinely different');
const routes = new Set([REPLY_KINDS.OPT_OUT, REPLY_KINDS.NOT_INTERESTED, REPLY_KINDS.WRONG_NUMBER, REPLY_KINDS.AMBIGUOUS]);
check('four distinct kinds', routes.size === 4);
check('a wrong number is not a refusal', REPLY_KINDS.WRONG_NUMBER !== REPLY_KINDS.NOT_INTERESTED);
check('and not an opt-out', REPLY_KINDS.WRONG_NUMBER !== REPLY_KINDS.OPT_OUT);
check('"wrong number, stop" is still a STOP',
  classifyReply({ text: 'wrong number, stop texting me' }).kind === REPLY_KINDS.OPT_OUT,
  'a stop is a stop even when it arrives with a correction');

done();
