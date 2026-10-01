// R7.3 / R7.4 — answers come from approved material or they do not happen.
import { check, section, done } from './world.mjs';
import { draftAnswer, getKnowledge, defaultKnowledge, wantsInformationFirst, containsUnapprovedClaim, saveKnowledge } from '../lib/knowledge.js';
import { REPLY_KINDS } from '../lib/replies.js';
import { saveSettings, getSettings } from '../lib/settings.js';

// ---------------------------------------------------------------------------
section('B1  a question with no approved answer is escalated, not improvised');
let r = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'do you do Shopify stores with custom checkout?' });
check('no answer is produced', r.ok === false, JSON.stringify(r));
check('it escalates to a person', r.escalate === true);
check('and says why, in words', /rather than being improvised/.test(r.reason), r.reason);

r = await draftAnswer({ kind: REPLY_KINDS.AMBIGUOUS, text: 'who gave you my address' });
check('an ambiguous reply is escalated too', r.escalate === true);

// ---------------------------------------------------------------------------
section('B2  approved questions are answered from approved text');
r = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'what do you do exactly?' });
check('an approved question is answered', r.ok === true, JSON.stringify(r));
check('and it names which entries it used', r.usedEntries.includes('what-you-do'), JSON.stringify(r.usedEntries));
check('the answer is marked as sourced only', r.sourcedOnly === true);

r = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'am I tied into a contract?' });
check('a contract question is answered from approved text', r.ok === true && /month to month/.test(r.body), JSON.stringify(r).slice(0, 180));
r = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'who owns the website?' });
check('ownership is answered', /domain stays in your name/.test(r.body), r.body);

// ---------------------------------------------------------------------------
section('B3  a price is never invented when pricing is unset (G1)');
await saveSettings({ pricing: { buildPrice: '', monthlyFee: '' } });
r = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'how much do you charge?' });
check('no answer is produced', r.ok === false, JSON.stringify(r).slice(0, 200));
check('it escalates rather than guessing', r.escalate === true);
check('and names the missing configuration', /Pricing is not set/.test(r.reason), r.reason);
check('no currency symbol leaks into anything', !/\$/.test(JSON.stringify(r.body || '')));

await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' } });
r = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'how much do you charge?' });
check('with pricing set, the price question is answered', r.ok === true, JSON.stringify(r).slice(0, 160));
check('and the figures come from settings', /\$2,500 to build, then \$197\/month/.test(r.body), r.body);

// ---------------------------------------------------------------------------
section('B4  "send me information first" is an instruction, not an objection');
check('the phrase is recognised', wantsInformationFirst('can you send me some info first') === true);
check('so is "email me the details"', wantsInformationFirst('just email me the details please') === true);
check('so is "not ready for a call"', wantsInformationFirst('not ready for a call yet') === true);
check('an ordinary reply is not', wantsInformationFirst('sounds good, what do you do?') === false);

const BOOK = 'https://cal.example.com/mondo';
r = await draftAnswer({ kind: REPLY_KINDS.WANTS_CALL, text: 'can you give me a call? how much is it', bookingUrl: BOOK });
check('someone asking for a call gets the booking link', r.offeredBooking === true && r.body.includes(BOOK), r.body);

r = await draftAnswer({ kind: REPLY_KINDS.WANTS_CALL, text: 'send me information first, how much is it', bookingUrl: BOOK });
check('but "information first" suppresses the link', r.offeredBooking === false, r.body);
check('the link does not appear anywhere in the body', !r.body.includes(BOOK), r.body);
check('and the draft records that it respected the instruction', r.respectedInformationFirst === true);
check('the question itself is still answered', /\$2,500/.test(r.body), r.body);

r = await draftAnswer({ kind: REPLY_KINDS.NOT_NOW, text: 'how much is it, maybe next year', bookingUrl: BOOK });
check('a "not now" reply is not pushed a booking link', r.offeredBooking === false, r.body);
r = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'how much is it', bookingUrl: null });
check('with no booking URL configured, none is offered', r.offeredBooking === false);

// ---------------------------------------------------------------------------
section('B5  automated mail and opt-outs are never answered');
r = await draftAnswer({ kind: REPLY_KINDS.AUTO_REPLY, text: 'out of office, how much is it' });
check('an auto-reply gets no answer', r.ok === false && r.escalate === false, JSON.stringify(r));
check('and the reason is explicit', /never replied to conversationally/.test(r.reason));
r = await draftAnswer({ kind: REPLY_KINDS.BOUNCE, text: 'undeliverable' });
check('a bounce gets no answer', r.ok === false && r.escalate === false);
r = await draftAnswer({ kind: REPLY_KINDS.OPT_OUT, text: 'remove me. also how much is it' });
check('an opt-out is actioned, not answered', r.ok === false, JSON.stringify(r));
check('and never argued with', /never argued with/.test(r.reason), r.reason);

// ---------------------------------------------------------------------------
section('B6  R7.4 — the outbound guard catches invented claims');
let g = containsUnapprovedClaim('Happy to help. I can do 20% off if you sign this week.');
check('a discount is caught', g.clean === false && g.findings.includes('offers a discount'), JSON.stringify(g));
check('a guarantee is caught', containsUnapprovedClaim('I guarantee you will rank first').clean === false);
check('invented availability is caught', containsUnapprovedClaim("I'm free on Tuesday at 2").clean === false, JSON.stringify(containsUnapprovedClaim("I'm free on Tuesday at 2")));
check('promised results are caught', containsUnapprovedClaim('guaranteed leads every month').clean === false);
check('contract terms are caught', containsUnapprovedClaim('the terms are twelve months').clean === false);

// and it does not cry wolf on the approved text we actually send
const approved = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'how much is it and am I tied in?' });
g = containsUnapprovedClaim(approved.body);
check('the approved answer passes the guard', g.clean === true, JSON.stringify(g) + ' :: ' + approved.body);

// the one legitimate use of "free" is the complimentary preview
check('a free preview is allowed', containsUnapprovedClaim('I built a free preview for you').clean === true);
check('but "free hosting forever" is not', containsUnapprovedClaim('free hosting forever').clean === false);

// ---------------------------------------------------------------------------
section('B7  the knowledge base is the owner\'s, and unapproved entries are inert');
const kb = await getKnowledge();
check('the default base has entries', kb.length >= 5, String(kb.length));
check('all defaults are approved', kb.every((e) => e.approved === true));

// an unapproved entry must never be used
const withDraft = [...defaultKnowledge(), { id: 'wild-claim', approved: false, matches: [/anything/i], answer: 'We can do absolutely anything.' }];
r = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'can you do anything?', knowledge: withDraft });
check('an unapproved entry is not used', !/absolutely anything/.test(r.body || ''), JSON.stringify(r));
check('and with nothing else matching, it escalates', r.escalate === true, JSON.stringify(r));

// saving strips anything executable
const saved = await saveKnowledge([{ id: 'test', approved: true, answer: 'plain text only', matchPhrases: ['widget integration'] }]);
check('saved entries keep only safe fields', Object.keys(saved[0]).every((k) => ['id', 'approved', 'answer', 'needs', 'matchPhrases'].includes(k)), JSON.stringify(saved[0]));

// REGRESSION: a save used to drop `matches`, which silently made the whole
// knowledge base unmatchable the moment the owner edited it once.
let round = await getKnowledge();
const custom = round.find((e) => e.id === 'test');
check('a custom entry survives the round trip', !!custom, JSON.stringify(round.map((e) => e.id)));
check('and is still matchable afterwards', (custom.matches || []).some((re) => re.test('do you support widget integration?')), JSON.stringify(custom.matchPhrases));
r = await draftAnswer({ kind: REPLY_KINDS.WANTS_DETAILS, text: 'do you support widget integration?', knowledge: round });
check('so it can actually answer', r.ok === true && /plain text only/.test(r.body), JSON.stringify(r));

// an owner phrase with regex characters cannot become a catch-all
await saveKnowledge([{ id: 'odd', approved: true, answer: 'x', matchPhrases: ['.*'] }]);
round = await getKnowledge();
const odd = round.find((e) => e.id === 'odd');
check('regex characters in a phrase are escaped, not executed', !(odd.matches || []).some((re) => re.test('completely unrelated text')), JSON.stringify(odd.matchPhrases));

// restore the defaults so later sections see the real base
await saveKnowledge(defaultKnowledge().map((e) => ({ id: e.id, approved: true, needs: e.needs })));
round = await getKnowledge();
check('the built-in entries come back with their matchers intact', round.find((e) => e.id === 'price')?.matches?.length > 0, JSON.stringify(round.map((e) => e.id)));

// ---------------------------------------------------------------------------
section('B8  ingestion attaches a DRAFT and never sends it');
const { W } = await import('./world.mjs');
const { ingestReplies, prospectReplyLookup, listReplies } = await import('../lib/replies.js');
const { createCampaign, addMember, markStepSent, CAMPAIGN_TYPES } = await import('../lib/campaigns.js');
const { upsertContact, field } = await import('../lib/contacts.js');
const E = (v) => field(v, { confidence: 1, source: 'manual' });

const camp = (await createCampaign({ name: 'draft test', type: CAMPAIGN_TYPES.COLD_NO_SITE })).campaign;
const who = (await upsertContact({ source: 'discovery', name: E('Ivy'), businessName: E('Ivy Co'), email: E('ivy@ivy.test') })).contact;
await addMember(camp.id, who);
await markStepSent(camp.id, who.id, 0);

await ingestReplies({
  listMail: async () => [{ id: 'd1', from: 'ivy@ivy.test', subject: 're:', body: 'how much is it, and am I tied into a contract?', at: Date.now() }],
  isKnownContact: (addr) => prospectReplyLookup(addr),
  bookingUrl: BOOK,
});
let replies = await listReplies();
const mine = replies.find((x) => x.contactId === who.id);
check('a draft was attached to the reply', !!mine?.draft, JSON.stringify(mine?.draft));
check('it is awaiting review, not sent', mine.draft.status === 'awaiting-review', mine.draft.status);
check('the draft answers from approved entries', /\$2,500/.test(mine.draft.body) && /month to month/.test(mine.draft.body), mine.draft.body);
check('it records which entries it used', (mine.draft.usedEntries || []).length >= 2, JSON.stringify(mine.draft.usedEntries));
check('NOTHING was emailed', W.emails.length === 0, String(W.emails.length));

// a question with no approved answer leaves a draft marked for a person
const who2 = (await upsertContact({ source: 'discovery', name: E('Juniper'), businessName: E('Juniper Co'), email: E('juniper@juniper.test') })).contact;
await addMember(camp.id, who2);
await markStepSent(camp.id, who2.id, 0);
await ingestReplies({
  listMail: async () => [{ id: 'd2', from: 'juniper@juniper.test', subject: 're:', body: 'do you integrate with my booking software?', at: Date.now() }],
  isKnownContact: (addr) => prospectReplyLookup(addr),
});
replies = await listReplies();
const theirs = replies.find((x) => x.contactId === who2.id);
check('an unanswerable question produces no draft body', theirs.draft.body === null, JSON.stringify(theirs.draft));
check('and is marked as needing a person', theirs.draft.status === 'needs-a-person', theirs.draft.status);
check('still nothing emailed', W.emails.length === 0);

// ---------------------------------------------------------------------------
section('B9  R7.6 — four brakes, and every one escalates rather than stopping');
const { mayAutoReply, recordAutoReply, handOver, conversationState, LOOP_LIMITS } = await import('../lib/knowledge.js');
const CID = 'loop-test-contact';

let m = await mayAutoReply(CID, 'first reply');
check('the first automatic reply is allowed', m.ok === true, JSON.stringify(m));

// --- cooldown ---
await recordAutoReply(CID, 'first reply');
m = await mayAutoReply(CID, 'a different second reply');
check('a second reply straight away is refused', m.ok === false, JSON.stringify(m));
check('the brake is the cooldown', m.brake === 'cooldown', m.brake);
check('it says how long ago and what the window is', /minutes ago; the cooldown is 30 minutes/.test(m.reason), m.reason);
check('it escalates rather than silently stopping', m.escalate === true);
check('and it says when it could retry', typeof m.retryAt === 'number');

// --- duplicate ---
const future = Date.now() + 60 * 60000; // past the cooldown
m = await mayAutoReply(CID, 'first reply', { now: future });
check('past the cooldown, repeating the SAME text is still refused', m.ok === false, JSON.stringify(m));
check('the brake is duplicate detection', m.brake === 'duplicate', m.brake);
check('and the reason explains how it looks from outside', /how a loop looks from the outside/.test(m.reason), m.reason);
m = await mayAutoReply(CID, 'genuinely different text', { now: future });
check('but new text is allowed', m.ok === true, JSON.stringify(m));
check('whitespace-only differences still count as duplicates', (await mayAutoReply(CID, '  FIRST   reply  ', { now: future })).brake === 'duplicate');

// --- max turns ---
await recordAutoReply(CID, 'reply two', { now: future });
await recordAutoReply(CID, 'reply three', { now: future });
m = await mayAutoReply(CID, 'reply four', { now: future + 60 * 60000 });
check('after the turn limit, no more automatic replies', m.ok === false, JSON.stringify(m));
check('the brake is max-turns', m.brake === 'max-turns', m.brake);
check('and it hands over rather than abandoning the thread', /a person should take it from here/.test(m.reason), m.reason);
check('the limit is small on purpose', LOOP_LIMITS.maxAutoTurns <= 3, String(LOOP_LIMITS.maxAutoTurns));

let cs = await conversationState(CID);
check('the conversation state reports the turns used', cs.autoTurns >= 3, JSON.stringify(cs));
check('and that no automatic replies remain', cs.automaticRepliesRemaining === 0);

// --- handover ---
const fresh = 'handover-contact';
check('a fresh contact has its full budget', (await conversationState(fresh)).automaticRepliesRemaining === LOOP_LIMITS.maxAutoTurns);
await handOver(fresh, 'owner');
cs = await conversationState(fresh);
check('a human taking over stops automatic replies', cs.automaticRepliesRemaining === 0, JSON.stringify(cs));
check('and records who owns the thread', cs.takenOverBy === 'owner');
check('after handover nothing automatic may go out', (await mayAutoReply(fresh, 'anything')).ok === false);

// ---------------------------------------------------------------------------
section('B10  the brakes are wired into ingestion, not just available');
const who3 = (await upsertContact({ source: 'discovery', name: E('Larch'), businessName: E('Larch Co'), email: E('larch@larch.test') })).contact;
await addMember(camp.id, who3);
await markStepSent(camp.id, who3.id, 0);

// burn the automatic budget for this contact
await recordAutoReply(who3.id, 'one');
await recordAutoReply(who3.id, 'two');
await recordAutoReply(who3.id, 'three');

await ingestReplies({
  listMail: async () => [{ id: 'loop1', from: 'larch@larch.test', subject: 're:', body: 'how much is it?', at: Date.now() }],
  isKnownContact: (addr) => prospectReplyLookup(addr),
});
const loopReplies = await listReplies();
const larch = loopReplies.find((x) => x.contactId === who3.id);
check('a reply is still recorded', !!larch);
check('but the draft is marked for a person', larch.draft.status === 'needs-a-person', JSON.stringify(larch.draft));
check('with the brake named', larch.draft.brake === 'max-turns', larch.draft.brake);
check('and the draft text is still kept for them to use', typeof larch.draft.body === 'string' && larch.draft.body.length > 0);
check('nothing was sent', W.emails.length === 0, String(W.emails.length));

done();
