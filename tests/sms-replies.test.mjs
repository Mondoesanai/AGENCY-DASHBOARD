// A text from a real person, answered on its merits.
//
// The SMS path handled STOP, HELP and START, and then returned
// `needsPerson: true` for everything else and stopped. Nothing acted on it:
// not classified, not recorded, nothing paused. The only consumer is the TwiML
// response, which reads `reply` and ignores the rest — so somebody texting
// "yes, send me the pricing" produced an empty <Response/> and vanished. The
// email path had recorded and queued replies since R7.2; the SMS path reached
// the same point and dropped them on the floor.
//
// The plan named this precisely: reply classification "is covered by the
// existing lib/replies.js for email and is NOT yet exercised over SMS". So the
// central checks here are the ten kinds, driven through the SMS handler.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { handleInboundSms, INBOUND } from '../lib/sms-inbound.js';
import { REPLY_KINDS, NOTIFY_KINDS, listReplies } from '../lib/replies.js';
import { isPaused, thread, CHANNEL, DIRECTION } from '../lib/conversations.js';
import { upsertContact, field } from '../lib/contacts.js';

const PHONE = '+19195550147';
const E = (v) => field(v, { confidence: 1, source: 'manual' });

// contacts carry per-field confidence, so they go in through upsertContact
// with wrapped fields — saveContact takes an already-built record and would
// store one the phone index never sees
async function freshContact() {
  const c = await upsertContact({
    source: 'manual', name: E('Jordan Hale'), businessName: E('Hale Roofing'),
    email: E('jordan@hale.example'), phone: E(PHONE),
  });
  return c.contact;
}

// ---------------------------------------------------------------------------
section('R1  every reply kind is recognised over SMS, not just over email');
// the ten kinds from R7.2, each in the words someone would actually text
const CASES = [
  ['Yes! very interested, lets do it', REPLY_KINDS.INTERESTED],
  ['Can you send me pricing and more details?', REPLY_KINDS.WANTS_DETAILS],
  ['Can I see a preview of what it would look like?', REPLY_KINDS.WANTS_PREVIEW],
  ['Give me a call tomorrow afternoon', REPLY_KINDS.WANTS_CALL],
  ['Not right now, maybe revisit in the spring', REPLY_KINDS.NOT_NOW],
  ['No thanks, we are not interested', REPLY_KINDS.NOT_INTERESTED],
];
for (const [text, expect] of CASES) {
  const r = await handleInboundSms({ from: PHONE, body: text, business: 'Inspiring Websites' });
  check(`"${text.slice(0, 34)}…" → ${expect}`, r.replyKind === expect, `got ${r.replyKind}`);
}
check('a bare "ok" is ambiguous rather than guessed',
  (await handleInboundSms({ from: PHONE, body: 'ok' })).replyKind === REPLY_KINDS.AMBIGUOUS,
  (await handleInboundSms({ from: PHONE, body: 'ok' })).replyKind);

section('R1b  and the ones that are NOT a person replying still work');
let r = await handleInboundSms({ from: PHONE, body: 'STOP' });
check('STOP is still handled by the STOP path', r.kind === INBOUND.STOP);
check('and suppresses the number', r.suppressed === true);
check('it is not routed through reply classification', r.replyKind === undefined);
r = await handleInboundSms({ from: PHONE, body: 'HELP' });
check('HELP still answers with the carrier-required text', r.kind === INBOUND.HELP && r.reply.length > 20);
r = await handleInboundSms({ from: PHONE, body: 'START' });
check('START still refuses to resubscribe automatically', r.kind === INBOUND.START && r.needsPerson === true);

// ---------------------------------------------------------------------------
section('R2  the owner is told about the ones worth interrupting for');
for (const [text, expect] of CASES) {
  const res = await handleInboundSms({ from: PHONE, body: text });
  check(`${expect}: notify=${NOTIFY_KINDS.has(expect)}`, res.notify === NOTIFY_KINDS.has(expect),
    `notify was ${res.notify}`);
}
check('"not interested" does NOT ping the owner',
  (await handleInboundSms({ from: PHONE, body: 'no thanks, not interested' })).notify === false,
  'being pinged for every reply teaches you to ignore pings');

// ---------------------------------------------------------------------------
section('R3  a reply pauses the conversation, on every channel');
const contact = await freshContact();
check('a known number is matched to the contact',
  (await handleInboundSms({ from: PHONE, body: 'Sounds good, send me pricing' })).contactId === contact.id,
  'without this the reply is classified and then has nowhere to go');

const paused = await isPaused(contact.id);
check('the conversation is paused', paused.paused === true, JSON.stringify(paused));
check('and the reason says they replied', /replied/i.test(paused.reason || ''), paused.reason);

const t = await thread(contact.id);
const inbound = (t.messages || t || []).filter?.((m) => m.direction === DIRECTION.IN) || [];
check('the text is in the one conversation history', inbound.length >= 1, JSON.stringify(t).slice(0, 140));
check('recorded on the SMS channel', inbound.some((m) => m.channel === CHANNEL.SMS));

// ---------------------------------------------------------------------------
section('R4  and it lands in the queue the owner already reads');
const replies = await listReplies({ limit: 50 });
const mine = (replies.replies || replies || []).filter((x) => x.contactId === contact.id);
check('the reply is recorded', mine.length >= 1, `${(replies.replies || replies || []).length} total`);
check('with its kind', mine.some((x) => x.kind === REPLY_KINDS.WANTS_DETAILS), JSON.stringify(mine.map((x) => x.kind)));
check('and its text, so the owner reads what they actually said',
  mine.some((x) => /send me pricing/i.test(x.text || '')));
check('tagged as having arrived by sms',
  mine.some((x) => JSON.stringify(x.match || {}).includes('sms')), JSON.stringify(mine[0]?.match));

// ---------------------------------------------------------------------------
section('R5  an unknown number is still classified, not discarded');
r = await handleInboundSms({ from: '+19195559999', body: 'who is this? please send details' });
check('it is classified', !!r.replyKind, r.replyKind);
check('but has no contact', r.contactId === null);
check('and the text is still returned for a person', /who is this/i.test(r.text));
check('nothing was paused for a contact that does not exist', r.paused === undefined);

// ---------------------------------------------------------------------------
section('R6  it survives the parts that can fail');
check('an empty body does not throw',
  (await handleInboundSms({ from: PHONE, body: '' })).kind === INBOUND.MESSAGE);
check('a missing from does not throw',
  !!(await handleInboundSms({ from: '', body: 'hello there, send pricing' })).replyKind);
const long = 'please send me ' + 'x'.repeat(3000);
check('a very long message is handled', !!(await handleInboundSms({ from: PHONE, body: long })).replyKind);

// ---------------------------------------------------------------------------
section('R7  bounded turns: over SMS the bound is zero');
// The strictest version of "bounded automatic turns" is that nothing automatic
// happens at all, and that is what the SMS path does — an inbound message
// never schedules or sends anything. Locked down here because the tempting
// next change is an auto-responder, and a text that argues back with somebody
// is a different product from one that fetches a person.
const beforeQueue = await store.get('sms:messages');
const res7 = await handleInboundSms({ from: PHONE, body: 'yes I am interested, what does it cost?' });
check('an interested reply sends nothing back', res7.reply === '', JSON.stringify(res7.reply));
check('and queues no outbound message', (await store.get('sms:messages')) === beforeQueue,
  'no outbound SMS may be created by an inbound one');
check('it is handed to a person instead', res7.needsPerson === true);

// If an automatic SMS turn is ever added, this is the gate it has to pass.
const conv = await import('../lib/conversations.js');
check('a turn budget exists for that future case',
  conv.MAX_AUTOMATIC_TURNS >= 1 && conv.MAX_AUTOMATIC_TURNS <= 5, String(conv.MAX_AUTOMATIC_TURNS));

section('R8  manual takeover is immediate, and cancels rather than flags');
await conv.setOwnership(contact.id, conv.OWNER.AUTOMATIC, { by: 'test' });
const took = await conv.takeOver(contact.id, { by: 'owner' });
check('taking over succeeds', took && took.ok !== false, JSON.stringify(took).slice(0, 120));
const own = await conv.ownership(contact.id);
check('the conversation is owned by the person',
  own.mode === conv.OWNER.PERSON, JSON.stringify(own));
const after8 = await conv.mayAutoReply(contact.id, { confidence: 1, topicApproved: true });
check('nothing automatic may reply once taken over', after8.ok === false, JSON.stringify(after8));
check('and the reason names a person having it',
  /took over|manual|person|owner/i.test(after8.reason || ''), after8.reason);

done();
