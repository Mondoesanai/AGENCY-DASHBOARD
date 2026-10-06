// The Send button's actual path, from permission to the provider's door.
//
// R16.5. What this test exists to stop: the dashboard had a Send button that
// asked "Send this text? It goes to a real phone if a provider is connected",
// called `sms-schedule`, and stopped. Nothing drained the queue —
// `lib/sms-send.js:send` had no caller anywhere in production — so every
// message ever "sent" sat in a queue for ever while the interface implied it
// had gone. The reachability audit missed it because `send` is four letters
// that appear in `adapter.send` and a hundred comments; that detector now
// checks imports for names this generic.
//
// The path is driven here in the order it really runs: permission → compose →
// schedule → send → provider boundary. The checks that matter most are the
// refusals, because with no Twilio account every real send ends in one, and a
// refusal that is vague or wrong is how a consent failure gets mistaken for a
// provider outage.
import { check, section, done } from './world.mjs';
import { upsertContact, getContact, field, optOut } from '../lib/contacts.js';
import { recordPermission, contactStatus, HAND_RECORDED_MAX_SCOPE } from '../lib/optin.js';
import { compose, schedule, send, getMessage, SMS_DELIVERY } from '../lib/sms-send.js';

// 555-01xx is reserved for FICTION and lib/phone.js refuses it outright (S1b),
// so exercising the rest of the path needs a number outside that range.
// 555-7777 sits in the mostly-unassigned part of the 555 exchange: not a real
// subscriber, but not auto-refused either. Nothing is ever dialled — every send
// in this file runs with `env: {}`, so no adapter is configured.
const PHONE = '+12145557777';
const FICTION = '+12145550143';
// Each fixture gets its OWN email and number: `upsertContact` deduplicates on
// identity, so three contacts sharing one address silently become one, and the
// second and third lookups return null. (Which is correct behaviour — it is the
// same rule that stops two people at one company being merged — but it makes a
// careless fixture look like a broken test.)
let seq = 0;
const mk = async (id, extra = {}) => {
  seq += 1;
  await upsertContact({
    id, name: field(`Pat Example ${seq}`, 'test'), business: field(`Example Co ${seq}`, 'test'),
    email: field(`pat${seq}@example.invalid`, 'test'), phone: field(PHONE.slice(0, -2) + String(70 + seq), 'test'),
    ...extra,
  });
  return getContact(id);
};

// ---------------------------------------------------------------------------
section('S1  a phone number on file is not permission to text it');
let c = await mk('sp_plain');
let draft = await compose({ contact: c, body: 'Your preview is ready.' });
check('composing is refused', draft.ok === false, JSON.stringify(draft).slice(0, 160));
check('and the reason names the permission, not the provider', /permission/i.test(draft.reason || ''), draft.reason);
check('a known number did not make them textable', /"none"/.test(draft.reason || '') || /none/.test(draft.reason || ''),
  'this is the whole rule: a discovered or card-scanned number is not consent');

section('S1b  a number reserved for fiction is refused outright');
// Worth keeping as its own check: this caught my first draft of this very test,
// which used 555-0143 and could not get past composing. A permission record
// cannot override it, because the number is not a person.
const fic = await mk('sp_fiction', { phone: field(FICTION, 'test') });
await recordPermission(fic, {
  source: 'said yes in person', wording: 'text me the preview', evidence: 'card #120',
});
const ficDraft = await compose({ contact: await getContact('sp_fiction'), body: 'Preview ready.' });
check('composing to it is refused even WITH recorded permission', ficDraft.ok === false, JSON.stringify(ficDraft).slice(0, 140));
check('and it says the number is not real', /reserved for fiction/.test(ficDraft.reason || ''), ficDraft.reason);

section('S2  nor does a bulk assertion dressed as a record');
// recordPermission is the honest alternative, and it REFUSES the shapes that
// would make it a checkbox with extra steps.
let bad = await recordPermission(c, { source: '', wording: '', evidence: '' });
check('a permission with no source, wording or evidence is refused', bad.ok === false, JSON.stringify(bad).slice(0, 120));
check('and it names all three missing parts', (bad.missing || []).length === 3, JSON.stringify(bad.missing));
check('saying why they matter', /check it later/.test(bad.why || ''), bad.why);

bad = await recordPermission(c, { source: 'they said ok', wording: 'texts', evidence: '' });
check('evidence alone missing is still refused', bad.ok === false && (bad.missing || []).length === 1, JSON.stringify(bad.missing));

bad = await recordPermission(c, {
  scope: 'promotional', source: 'met at an event', wording: 'marketing texts', evidence: 'my notes',
});
check('PROMOTIONAL consent cannot be typed in on someone\'s behalf', bad.ok === false, JSON.stringify(bad).slice(0, 140));
check('because it needs their own action', /own action/.test(bad.why || ''), bad.why);
check('and it points at the honest alternative', /one-time follow-up/i.test(bad.why || ''), bad.why);

section('S3  a real per-person permission, with evidence, does work');
const good = await recordPermission(c, {
  source: 'asked me to text her the preview link, at her counter, 4 Oct',
  wording: 'I will text you a link to the free preview once it is built.',
  evidence: 'photo of the signed card in the shared drive, card #118',
  by: 'mondoe',
});
check('it is accepted', good.ok === true, JSON.stringify(good).slice(0, 160));
check('capped at a one-time follow-up', good.scope === HAND_RECORDED_MAX_SCOPE, good.scope);
check('the record keeps what they were told', /free preview/.test(good.record.wording), good.record.wording);
check('and who recorded it', /recorded by mondoe/.test(good.record.evidence), good.record.evidence);
check('and where the proof lives', /shared drive/.test(good.record.evidence));

c = await getContact('sp_plain');
const st = await contactStatus(c);
check('the contact now reads as textable', st.sms?.eligible === true, JSON.stringify(st.sms));
check('for ONE message, not a series', /one message, not a series/.test(st.sms?.reason || ''), st.sms?.reason);
check('and not for promotional sending', st.sms?.promotional === false, String(st.sms?.promotional));

// ---------------------------------------------------------------------------
section('S4  with permission, the message composes and queues');
draft = await compose({ contact: c, body: 'Hi Pat — your preview is ready: https://example.invalid/p/1' });
check('composing is allowed', draft.ok === true, JSON.stringify(draft).slice(0, 200));
check('it costs something and says so', draft.cost != null || draft.segments != null, JSON.stringify(draft).slice(0, 160));

const queued = await schedule({ contact: c, body: draft.body, sendAt: Date.now() });
check('it queues', queued.ok === true, JSON.stringify(queued).slice(0, 160));
const msgId = queued.message.id;
check('and is scheduled, not sent', (await getMessage(msgId)).state === SMS_DELIVERY.SCHEDULED,
  (await getMessage(msgId)).state);

section('S5  THE BOUNDARY: send reaches the provider and stops there');
let sent = await send(msgId, { contact: c, env: {} });
check('it is not sent', sent.ok === false, JSON.stringify(sent).slice(0, 200));
check('because no provider is connected', sent.disconnected === true, JSON.stringify(sent).slice(0, 160));
check('and it says so in plain words', /no SMS provider is connected/.test(sent.error || ''), sent.error);
check('the message goes back to draft rather than failing', (await getMessage(msgId)).state === SMS_DELIVERY.DRAFT,
  (await getMessage(msgId)).state);
check('nothing claims it was delivered', (await getMessage(msgId)).state !== SMS_DELIVERY.ACCEPTED);

// ---------------------------------------------------------------------------
section('S6  permission withdrawn between queueing and sending stops the send');
// The queue must never outrun consent. This is why `send` re-composes rather
// than trusting the draft it was handed.
const c2 = await mk('sp_withdraw');
await recordPermission(c2, {
  source: 'verbal at the counter', wording: 'text me the preview', evidence: 'card #119',
});
const d2 = await compose({ contact: await getContact('sp_withdraw'), body: 'Preview ready.' });
check('it composes while permission stands', d2.ok === true, JSON.stringify(d2).slice(0, 140));
const q2 = await schedule({ contact: await getContact('sp_withdraw'), body: d2.body, sendAt: Date.now() });
check('and queues', q2.ok === true);

// optOut takes an object — passing the id as a bare string silently opts
// nobody out, which is how an earlier version of this test "passed" the send.
const withdrawee = await getContact('sp_withdraw');
await optOut({ contactId: 'sp_withdraw', phone: withdrawee.phone?.value, channel: 'sms', reason: 'texted STOP' });
const after = await getContact('sp_withdraw');
const s2 = await send(q2.message.id, { contact: after, env: {} });
check('the queued message is NOT sent', s2.ok === false, JSON.stringify(s2).slice(0, 200));
check('and the refusal is about permission, not the provider',
  s2.permissionChanged === true || /permitted|opted out|suppress/i.test(s2.error || ''),
  JSON.stringify(s2).slice(0, 200));
check('a withdrawal after queueing beats the queue',
  (await getMessage(q2.message.id)).state !== SMS_DELIVERY.ACCEPTED,
  (await getMessage(q2.message.id)).state);

// ---------------------------------------------------------------------------
section('S7  an already-sent message cannot be sent twice');
const again = await send(msgId, { contact: c, env: {} });
check('a second send of a drafted message is handled, not duplicated',
  typeof again.ok === 'boolean', JSON.stringify(again).slice(0, 140));

done();
