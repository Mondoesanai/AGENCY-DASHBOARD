// R7.1 — an inbound reply stops that contact's follow-ups immediately,
// INCLUDING the already-queued race.
//
// The race is the whole point. A worker decides a follow-up is due; the person
// replies while the message is being prepared; the message still goes and asks
// why they haven't answered. These checks drive that exact interleaving.
import { W, check, section, done } from './world.mjs';
import {
  REPLY_KINDS, NON_HUMAN, claimSend, claimStillValid, recordReply,
  isStopped, listReplies, markHandled, guardedSend,
} from '../lib/replies.js';
import { createCampaign, addMember, getMember, CAMPAIGN_TYPES, MEMBER_STATE, dueSends, setCampaignStatus } from '../lib/campaigns.js';
import { upsertContact, field, canContact } from '../lib/contacts.js';

const E = (v) => field(v, { confidence: 1, source: 'manual' });

const mkContact = async (name, email) =>
  (await upsertContact({ source: 'discovery', name: E(name), businessName: E(name + ' Co'), email: E(email) })).contact;

// ---------------------------------------------------------------------------
section('P1  a reply stops every pending follow-up at once');
const camp = (await createCampaign({ name: 'cold run', type: CAMPAIGN_TYPES.COLD_NO_SITE, cadence: { gapDays: 4, followUps: 2 } })).campaign;
const a = await mkContact('Alder', 'alder@alder.test');
let add = await addMember(camp.id, a);
check('the contact is enrolled with three steps', add.ok === true && add.member.plan.length === 3, JSON.stringify(add).slice(0, 140));

let r = await recordReply({ contactId: a.id, kind: REPLY_KINDS.INTERESTED, text: 'yes please', campaignId: camp.id });
check('the reply is recorded', r.ok === true);
check('it reports that follow-ups were paused', r.reply.pausedFollowUps === true);
check('and counts what it cancelled', r.reply.cancelledSends >= 2, String(r.reply.cancelledSends));
check('the contact is flagged stopped', (await isStopped(a.id)) === true);

let mem = await getMember(camp.id, a.id);
check('the member is STOPPED', mem.state === MEMBER_STATE.STOPPED, mem.state);
await setCampaignStatus(camp.id, 'running');
const due = await dueSends(camp.id, { now: Date.now() + 60 * 86400000 });
check('two months later they are still not due', !due.due.some((d) => d.contactId === a.id), JSON.stringify(due.due));

// ---------------------------------------------------------------------------
section('P2  THE RACE — a reply lands while the message is being prepared');
const b = await mkContact('Birch', 'birch@birch.test');
await addMember(camp.id, b);

// a worker claims the send and begins its slow work
const claim = await claimSend(camp.id, b.id, 1);
check('the worker takes a claim', claim.ok === true, JSON.stringify(claim));

// ...and the person replies DURING that window
await recordReply({ contactId: b.id, kind: REPLY_KINDS.WANTS_CALL, text: 'call me', campaignId: camp.id });

// the worker finishes preparing and re-checks before committing
const still = await claimStillValid(camp.id, b.id, 1, claim.token);
check('the claim is no longer valid', still.ok === false);
check('and the reason names the race explicitly', /a reply arrived while this message was being prepared/.test(still.reason), still.reason);

// the same thing through the guarded shape a worker should actually use
const c = await mkContact('Cedar', 'cedar@cedar.test');
await addMember(camp.id, c);
let committed = false;
let sent = await guardedSend({
  campaignId: camp.id,
  contactId: c.id,
  step: 1,
  prepare: async () => {
    // the person replies in the middle of preparation
    await recordReply({ contactId: c.id, kind: REPLY_KINDS.NOT_INTERESTED, text: 'no thanks', campaignId: camp.id });
    return { ok: true, body: 'the follow-up that must not go' };
  },
  commit: async () => { committed = true; return { id: 'should-not-happen' }; },
});
check('the guarded send does NOT send', sent.sent === false, JSON.stringify(sent));
check('and commit was never called', committed === false);
check('it failed at the re-check, not at the claim', sent.stage === 'recheck', sent.stage);
check('nothing was emailed', W.emails.length === 0, String(W.emails.length));

// ---------------------------------------------------------------------------
section('P3  a worker cannot even start a send for someone who replied');
const already = await claimSend(camp.id, c.id, 2);
check('claiming is refused outright', already.ok === false);
check('with a reason about the reply', /replied/.test(already.reason), already.reason);

const sent2 = await guardedSend({
  campaignId: camp.id, contactId: c.id, step: 2,
  prepare: async () => { throw new Error('prepare must never run'); },
  commit: async () => { throw new Error('commit must never run'); },
});
check('the guarded send stops at the claim stage', sent2.sent === false && sent2.stage === 'claim', JSON.stringify(sent2));

// ---------------------------------------------------------------------------
section('P4  a clean send still works — the guard is not a blanket refusal');
const d = await mkContact('Dogwood', 'dogwood@dogwood.test');
await addMember(camp.id, d);
let committedClean = false;
const clean = await guardedSend({
  campaignId: camp.id, contactId: d.id, step: 0,
  prepare: async () => ({ ok: true, body: 'the intro' }),
  commit: async () => { committedClean = true; return { id: 'sent-1' }; },
});
check('an uninterrupted send goes through', clean.sent === true, JSON.stringify(clean));
check('commit ran', committedClean === true);
check('and it reports the commit stage', clean.stage === 'commit');

// a failed preparation does not send either
const prepFail = await guardedSend({
  campaignId: camp.id, contactId: d.id, step: 1,
  prepare: async () => ({ ok: false, reason: 'no honest observation for this prospect' }),
  commit: async () => { throw new Error('must not commit'); },
});
check('a refused composition does not send', prepFail.sent === false && prepFail.stage === 'prepare', JSON.stringify(prepFail));
check('and the composer reason is carried through', /no honest observation/.test(prepFail.reason));

// ---------------------------------------------------------------------------
section('P5  an auto-reply or bounce is NOT someone talking to us');
const e = await mkContact('Elm', 'elm@elm.test');
await addMember(camp.id, e);
r = await recordReply({ contactId: e.id, kind: REPLY_KINDS.AUTO_REPLY, text: 'I am on holiday until the 9th', campaignId: camp.id });
check('an out-of-office is recorded', r.ok === true);
check('but it does NOT pause follow-ups', r.reply.pausedFollowUps === false);
check('and the contact is not flagged stopped', (await isStopped(e.id)) === false);
mem = await getMember(camp.id, e.id);
check('their campaign membership is untouched', mem.state === MEMBER_STATE.SCHEDULED, mem.state);
check('auto-reply and bounce are both treated as non-human', NON_HUMAN.has(REPLY_KINDS.AUTO_REPLY) && NON_HUMAN.has(REPLY_KINDS.BOUNCE));

// ---------------------------------------------------------------------------
section('P6  an opt-out is a standing instruction, not just a stop');
const f = await mkContact('Fir', 'fir@fir.test');
await addMember(camp.id, f);
check('they are contactable first', (await canContact(f, { channel: 'email', purpose: 'promotional' })).ok === true);

await recordReply({ contactId: f.id, kind: REPLY_KINDS.OPT_OUT, text: 'stop emailing me', campaignId: camp.id });
check('they are stopped', (await isStopped(f.id)) === true);

// re-read the contact: the opt-out must persist on the record, not just in a flag
const refetched = (await upsertContact({ source: 'discovery', name: E('Fir'), businessName: E('Fir Co'), email: E('fir@fir.test') })).contact;
const stillAllowed = await canContact(refetched, { channel: 'email', purpose: 'promotional' });
check('and the opt-out survives as a consent fact, not just a stop flag', stillAllowed.ok === false, JSON.stringify(stillAllowed));

// ---------------------------------------------------------------------------
section('P7  the reply inbox is reviewable');
const all = await listReplies();
check('replies are listed', all.length >= 5, String(all.length));
check('newest first', all[0].at >= all[all.length - 1].at);
const unhandled = await listReplies({ onlyUnhandled: true });
check('all start unhandled', unhandled.length === all.length);
const handled = await markHandled(all[0].id, 'owner');
check('one can be marked handled', handled.handled === true && handled.handledBy === 'owner');
check('and it leaves the unhandled list', (await listReplies({ onlyUnhandled: true })).length === unhandled.length - 1);

check('no email or text was sent anywhere in this suite', W.emails.length === 0 && W.sms.length === 0);

done();
