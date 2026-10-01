// R7.7 — the owner's side: draft-only vs automatic, takeover, and the send path
// that makes the loop brakes mean something.
//
// The reviewer caught that recordAutoReply() was never called by any production
// path, so the turn counter stayed at zero and the brakes could never fire. The
// send path did not exist. It does now, and these checks prove the counter
// moves through it.
import { W, check, section, done } from './world.mjs';
import {
  REPLY_MODES, getReplyMode, setReplyMode, sendDraft, takeOver, conversationFor,
  ingestReplies, prospectReplyLookup, listReplies, attachDraft, recordReply, REPLY_KINDS,
} from '../lib/replies.js';
import { conversationState, LOOP_LIMITS } from '../lib/knowledge.js';
import { createCampaign, addMember, markStepSent, CAMPAIGN_TYPES } from '../lib/campaigns.js';
import { upsertContact, field } from '../lib/contacts.js';
import { saveSettings } from '../lib/settings.js';

const E = (v) => field(v, { confidence: 1, source: 'manual' });
await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' } });

const camp = (await createCampaign({ name: 'inbox test', type: CAMPAIGN_TYPES.COLD_NO_SITE })).campaign;
const mk = async (name, email) => {
  const c = (await upsertContact({ source: 'discovery', name: E(name), businessName: E(name + ' Co'), email: E(email) })).contact;
  await addMember(camp.id, c);
  await markStepSent(camp.id, c.id, 0);
  return c;
};
const draftFor = async (contact, body) => {
  await ingestReplies({
    listMail: async () => [{ id: 'x' + Math.random(), from: contact.email.value, subject: 're:', body, at: Date.now() }],
    isKnownContact: (addr) => prospectReplyLookup(addr),
  });
  const all = await listReplies({ limit: 200 });
  return all.filter((r) => r.contactId === contact.id).sort((a, b) => b.at - a.at)[0];
};

// ---------------------------------------------------------------------------
section('I1  draft-only is the default and cannot be assumed away');
check('the default mode is draft-only', (await getReplyMode()) === REPLY_MODES.DRAFT_ONLY);
check('there are exactly two modes', Object.keys(REPLY_MODES).length === 2);

const a = await mk('Maple', 'maple@maple.test');
let rep = await draftFor(a, 'how much is it?');
check('a draft was prepared', rep?.draft?.body?.length > 0, JSON.stringify(rep?.draft));
check('and it is awaiting review', rep.draft.status === 'awaiting-review');

let out = await sendDraft(rep.id, { send: async () => ({ ok: true }) });
check('in draft-only mode an unapproved draft does NOT go', out.sent === false, JSON.stringify(out));
check('and it says a person has to approve it', /a person has to approve/.test(out.reason), out.reason);

// ---------------------------------------------------------------------------
section('I2  sending counts the turn — the gap the reviewer found');
let before = await conversationState(a.id);
check('the conversation starts with a full automatic budget', before.automaticRepliesRemaining === LOOP_LIMITS.maxAutoTurns, JSON.stringify(before));

let sentBodies = [];
out = await sendDraft(rep.id, { approvedBy: 'owner', send: async ({ body }) => { sentBodies.push(body); return { ok: true }; } });
check('an approved draft is sent', out.sent === true, JSON.stringify(out));
check('the transport actually received it', sentBodies.length === 1);
check('and it records who approved it', out.approvedBy === 'owner');

let after = await conversationState(a.id);
check('THE TURN COUNTER MOVED', after.autoTurns === before.autoTurns + 1, `${before.autoTurns} -> ${after.autoTurns}`);
check('so the remaining budget went down', after.automaticRepliesRemaining === before.automaticRepliesRemaining - 1);

// which means the cooldown brake now actually bites
rep = await draftFor(a, 'and how long does it take?');
out = await sendDraft(rep.id, { approvedBy: 'owner', send: async () => ({ ok: true }) });
check('a second send straight after is stopped by the cooldown', out.sent === false, JSON.stringify(out));
check('the brake is named', out.brake === 'cooldown', out.brake);
check('and it escalates', out.escalate === true);

// the same draft cannot be sent twice
const b = await mk('Nettle', 'nettle@nettle.test');
rep = await draftFor(b, 'how much is it?');
out = await sendDraft(rep.id, { approvedBy: 'owner', send: async () => ({ ok: true }) });
check('a fresh contact can be replied to', out.sent === true, JSON.stringify(out));
out = await sendDraft(rep.id, { approvedBy: 'owner', send: async () => ({ ok: true }) });
check('but the same draft cannot be sent twice', out.sent === false && /already been sent/.test(out.reason), out.reason);

// ---------------------------------------------------------------------------
section('I3  automatic mode still obeys every guard');
await setReplyMode(REPLY_MODES.AUTOMATIC);
check('the mode switched', (await getReplyMode()) === REPLY_MODES.AUTOMATIC);

const c = await mk('Olive', 'olive@olive.test');
rep = await draftFor(c, 'how much is it?');
out = await sendDraft(rep.id, { send: async () => ({ ok: true }) });
check('automatic mode sends without a person', out.sent === true, JSON.stringify(out));
check('and records that it was automatic, not a person', out.approvedBy === REPLY_MODES.AUTOMATIC, out.approvedBy);

// an edited draft containing a forbidden claim is refused even in automatic mode
const d = await mk('Privet', 'privet@privet.test');
rep = await draftFor(d, 'how much is it?');
await attachDraft(rep.id, { body: 'Sure — I can do 30% off if you sign this week.', status: 'awaiting-review' });
out = await sendDraft(rep.id, { send: async () => ({ ok: true }) });
check('an edited draft with a discount is refused', out.sent === false, JSON.stringify(out));
check('and names what it found', (out.findings || []).includes('offers a discount'), JSON.stringify(out.findings));

await setReplyMode(REPLY_MODES.DRAFT_ONLY);
check('the mode can be put back', (await getReplyMode()) === REPLY_MODES.DRAFT_ONLY);

// ---------------------------------------------------------------------------
section('I4  with no transport connected, nothing can go out');
const e = await mk('Quince', 'quince@quince.test');
rep = await draftFor(e, 'how much is it?');
out = await sendDraft(rep.id, { approvedBy: 'owner' }); // no send function
check('an approved draft with no transport does not send', out.sent === false, JSON.stringify(out));
check('and it says the transport is missing, not that the draft is bad', out.disconnected === true && /no sending transport is connected/.test(out.reason), out.reason);

// a transport that refuses is reported as a transport problem
out = await sendDraft(rep.id, { approvedBy: 'owner', send: async () => ({ ok: false, reason: 'provider rejected the address' }) });
check('a refusing transport is reported as such', out.sent === false && out.transport === true, JSON.stringify(out));
check('with the provider reason carried through', /provider rejected/.test(out.reason));
check('and the turn was NOT counted for a send that failed', (await conversationState(e.id)).autoTurns === 0, JSON.stringify(await conversationState(e.id)));

// ---------------------------------------------------------------------------
section('I5  manual takeover ends the automation for that thread');
const f = await mk('Rowan', 'rowan@rowan.test');
rep = await draftFor(f, 'how much is it?');
check('a draft exists first', rep.draft.body.length > 0);

const over = await takeOver(f.id, 'Mondo');
check('takeover records who owns it', over.takenOverBy === 'Mondo' || over.ownedBy === 'Mondo', JSON.stringify(over));
check('no automatic replies remain', over.automaticRepliesRemaining === 0);
check('and it says so plainly', /No further automatic replies/.test(over.note));

out = await sendDraft(rep.id, { approvedBy: 'Mondo', send: async () => ({ ok: true }) });
check('after takeover even an approved draft is stopped', out.sent === false, JSON.stringify(out));
check('because the automatic budget is spent', out.brake === 'max-turns', out.brake);

// ---------------------------------------------------------------------------
section('I6  the conversation view shows the history a person needs');
const convo = await conversationFor(a.id);
check('it returns the messages for that contact', convo.messages.length >= 2, String(convo.messages.length));
check('oldest first, so it reads as a conversation', convo.messages[0].at <= convo.messages[convo.messages.length - 1].at);
check('it reports the automatic budget', typeof convo.automaticRepliesRemaining === 'number');
check('and whether the contact is stopped', typeof convo.stopped === 'boolean');
check('each message keeps its classification', convo.messages.every((m) => !!m.kind));
check('and the draft history is visible', convo.messages.some((m) => m.draft));

check('no real email was sent at any point', W.emails.length === 0, String(W.emails.length));

done();
