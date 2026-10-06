// The two numbers R13.8 asked for and nothing computed.
//
// `sms-send.stats()` counted messages and `previews.stats()` counted promises.
// Neither answers what the owner actually wants to know after a networking
// event: was that worth doing, and am I keeping up with the people who
// answered?
//
// Both new metrics are built to refuse rather than to flatter, and most of
// these checks are about the refusing.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  responseTime, costPerQualifiedConversation, relationshipReport,
  MIN_CONVERSATIONS_FOR_COST, QUALIFYING_KINDS,
} from '../lib/relationship-report.js';
import { renderSmsStats } from '../public/sms-inbox.js';

const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const H = 3600e3;

// Sets are not cleared by setting the key to '' — they need srem per member.
// Getting that wrong made replies accumulate across sections and a later
// count read 6 when the fixture had placed 2.
const clearSet = async (key) => {
  for (const m of await store.smembers(key).catch(() => [])) await store.srem(key, m);
};
const reset = async () => {
  await clearSet('conv:all');
  await clearSet('replies:inbox');
  await clearSet('sms:messages');
};

/**
 * A conversation with a known inbound, and optionally an answer.
 *
 * `thread()` stores the message array ITSELF at conv:<id>, not an object
 * wrapping it — a wrapper reads back as zero messages, which looks exactly
 * like "nobody has ever replied".
 */
async function convo(id, { repliedAgo, answeredAfter = null }) {
  const msgs = [{ at: NOW - repliedAgo, direction: 'inbound', channel: 'sms', body: 'hi' }];
  if (answeredAfter != null) msgs.push({ at: NOW - repliedAgo + answeredAfter, direction: 'outbound', channel: 'sms', body: 'hello' });
  await store.set(`conv:${id}`, JSON.stringify(msgs));
  await store.sadd('conv:all', id);
}

// ---------------------------------------------------------------------------
section('T1  how long people wait for an answer');
await reset();
await convo('c1', { repliedAgo: 10 * H, answeredAfter: 2 * H });
await convo('c2', { repliedAgo: 20 * H, answeredAfter: 4 * H });
await convo('c3', { repliedAgo: 30 * H, answeredAfter: 6 * H });
let rt = await responseTime({ now: NOW });
check('it reports over answered conversations', rt.answered === 3, String(rt.answered));
check('the median is the middle one', rt.medianHours === 4, String(rt.medianHours));
check('and the worst is the worst', rt.worstHours === 6, String(rt.worstHours));
check('nobody is waiting', rt.stillWaiting === 0);

section('T2  people still waiting are counted SEPARATELY, never averaged in');
await convo('c4', { repliedAgo: 96 * H }); // four days, no answer
rt = await responseTime({ now: NOW });
check('the median is unchanged by an unanswered one', rt.medianHours === 4, String(rt.medianHours));
check('the worst is unchanged too', rt.worstHours === 6, String(rt.worstHours),
  'a four-day silence folded into a mean as "pending" hides a slow response time');
check('but it is reported', rt.stillWaiting === 1);
check('with how long they have waited', rt.longestWaitHours === 96, String(rt.longestWaitHours));

await reset();
await convo('c9', { repliedAgo: 50 * H });
rt = await responseTime({ now: NOW });
check('with nothing answered there is no median at all', rt.medianHours === null);
check('and it says so rather than reporting 0', /nobody has been answered/.test(rt.note || ''), rt.note);
check('0 would read as "we answer instantly"', rt.medianHours !== 0);

// ---------------------------------------------------------------------------
section('T3  cost per qualified conversation refuses small numbers');
await reset();
const reply = (id, kind, contactId) => ({ id, kind, contactId, text: 'x', at: NOW });
async function setReplies(list) {
  await clearSet('replies:inbox');
  for (const r of list) { await store.set(`reply:${r.id}`, JSON.stringify(r)); await store.sadd('replies:inbox', r.id); }
}
async function setSms(cents) {
  await store.set('sms:msg:m1', JSON.stringify({ id: 'm1', state: 'delivered', segments: 1, estimatedCents: cents }));
  await store.sadd('sms:messages', 'm1');
}

await setSms(400);
await setReplies([reply('r1', 'interested', 'p1'), reply('r2', 'wants-details', 'p2')]);
let c = await costPerQualifiedConversation({});
check('two qualified is too few', c.costPerQualifiedCents === null, String(c.costPerQualifiedCents));
check('and the reason says how many are needed',
  new RegExp(String(MIN_CONVERSATIONS_FOR_COST)).test(c.reason || ''), c.reason);
check('the qualified count is still reported', c.qualified === 2);

await setReplies(['p1', 'p2', 'p3', 'p4', 'p5'].map((p, i) => reply(`r${i}`, 'interested', p)));
c = await costPerQualifiedConversation({});
check('at the floor it computes', c.costPerQualifiedCents === 80, String(c.costPerQualifiedCents));
check('and still says it is an estimate', c.isEstimate === true);
check('with the reason the word matters', /estimate until/.test(c.costNote || ''), c.costNote);

section('T4  qualified means they said something, not that we sent something');
await setReplies([
  reply('a', 'interested', 'p1'), reply('b', 'not-interested', 'p2'), reply('c', 'opt-out', 'p3'),
  reply('d', 'auto-reply', 'p4'), reply('e', 'delivery-failure', 'p5'), reply('f', 'wants-call', 'p6'),
]);
c = await costPerQualifiedConversation({ minConversations: 1 });
check('only the interested ones count', c.qualified === 2, String(c.qualified));
check('an opt-out is not a qualified conversation', !QUALIFYING_KINDS.includes('opt-out'));
check('an auto-reply is not a person', !QUALIFYING_KINDS.includes('auto-reply'));
check('a delivery failure certainly is not', !QUALIFYING_KINDS.includes('delivery-failure'));

await setReplies([reply('a', 'interested', 'p1'), reply('b', 'wants-details', 'p1'), reply('c', 'wants-call', 'p1')]);
c = await costPerQualifiedConversation({ minConversations: 1 });
check('one person replying three times is ONE conversation', c.qualified === 1, String(c.qualified));

// ---------------------------------------------------------------------------
section('T5  relationship work is reported apart from cold discovery');
const rep = await relationshipReport({ now: NOW });
check('the scope is stated in the payload', rep.scope === 'relationship');
check('and what it excludes, so a renderer cannot merge them', /cold/i.test(rep.excludes || ''), rep.excludes);
check('it carries the response time', !!rep.responseTime);
check('and the cost', !!rep.cost);
check('and says a card is not a lead',
  /card is not a lead/i.test(rep.relationships?.note || ''), rep.relationships?.note);

// ---------------------------------------------------------------------------
section('T6  the screen says the same things the data does');
let html = renderSmsStats({
  sms: { attempted: 10, delivered: 7, deliveryUnknown: 2, failed: 1, estimatedCents: 400 },
  previews: { promised: 3, delivered: 1, brokenPromises: 2 },
  responseTime: { ok: true, answered: 3, medianHours: 4, worstHours: 6, stillWaiting: 1, longestWaitHours: 96 },
  cost: { ok: true, qualified: 5, costPerQualifiedCents: 80, isEstimate: true },
  excludes: 'cold discovery is reported separately',
});
check('the median is on screen', /within 4h/.test(html), html.slice(0, 200));
check('the people still waiting are on screen', /1 still waiting/.test(html));
check('and flagged, not buried', /tone-warn/.test(html));
check('the per-conversation cost is shown', /\$0\.80/.test(html), html);
check('still labelled an estimate', /estimate/i.test(html));
check('and the separation is stated', /cold discovery is reported separately/.test(html));

html = renderSmsStats({
  sms: {}, previews: {},
  responseTime: { ok: true, answered: 0, medianHours: null, stillWaiting: 2, longestWaitHours: 30, note: 'nobody has been answered yet' },
  cost: { ok: true, qualified: 2, costPerQualifiedCents: null, reason: 'too few to divide by' },
});
check('with nothing answered it does NOT print a time', !/within \d/.test(html), html.slice(0, 220));
check('it says so instead', /nobody has been answered yet/.test(html));
check('and the cost says why there is no number', /not reported — too few to divide by/.test(html), html);

html = renderSmsStats({ sms: {}, previews: {}, responseTime: { ok: false }, cost: { ok: false } });
check('an unreadable response time is reported, not shown as zero', /could not be read/.test(html));
check('and an uncomputable cost likewise', /could not be computed/.test(html));

// ---------------------------------------------------------------------------
section('T7  unreadable storage is not a quiet zero');
const realS = store.smembers;
store.smembers = async (k) => { if (k === 'conv:all') throw new Error('down'); return realS.call(store, k); };
rt = await responseTime({ now: NOW });
store.smembers = realS;
check('it reports the failure', rt.ok === false);
check('rather than "everyone is answered"', rt.medianHours === undefined || rt.medianHours === null);

await reset();
done();
