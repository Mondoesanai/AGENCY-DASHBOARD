// R9.2 — qualified positive replies · qualified bookings · attended calls ·
// owner-recorded sales.
//
// These are a LADDER, not a list. Volume falls at every rung and truth rises:
// a reply is cheap and noisy, a sale is rare and definite. Two things follow,
// and they are what these checks are about.
//
// Nothing may be promoted without the evidence for its own rung — a booking is
// not attendance, attendance is not a sale — and the rungs are never summed,
// because "12 outcomes" means nothing if it is 11 replies and one sale.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  PRIMARY, LADDER, POSITIVE_KINDS, ASSERTION_SOURCES,
  ladderFor, qualifyReply, checkAssertion, recordPrimaryOutcome, primaryBreakdown,
} from '../lib/outcomes.js';
import { createExperiment, setExperimentState, assign, tally } from '../lib/experiments.js';

const EID = 'exp-outcomes';
const reset = async () => {
  await store.set(`experiment:${EID}`, '').catch(() => {});
};

// ---------------------------------------------------------------------------
section('O1  the ladder says who can assert each rung, and nothing is inferable');
check('all four rungs are defined', LADDER.length === 4, String(LADDER.length));
check('they are in order', LADDER.map((l) => l.rung).join(',') === '1,2,3,4');
for (const l of LADDER) {
  check(`${l.id} says what it requires`, l.requires.length > 30, l.requires);
  check(`${l.id} names who may assert it`, Array.isArray(l.assertedBy) && l.assertedBy.length > 0);
  // the point of the table
  check(`${l.id} is NOT inferable from the rung below`, l.inferableFrom === null);
}
check('only the owner can assert a sale', ladderFor(PRIMARY.RECORDED_SALE).assertedBy.join(',') === 'owner');
check('only the owner can assert attendance', ladderFor(PRIMARY.ATTENDED_CALL).assertedBy.join(',') === 'owner');
check('a booking may come from a verified webhook', ladderFor(PRIMARY.QUALIFIED_BOOKING).assertedBy.includes('verified-webhook'));
check('and the booking rung says a click is never one', /click is never a booking/i.test(ladderFor(PRIMARY.QUALIFIED_BOOKING).requires));
check('opens are not a primary outcome', !LADDER.some((l) => /open/i.test(l.id)));
check('clicks are not a primary outcome', !LADDER.some((l) => /click/i.test(l.id)));

// ---------------------------------------------------------------------------
section('O2  a positive reply is not automatically a qualified one');
const strong = { qualification: { segment: 'no-site-found' }, withinTargeting: true, decisionMaker: { evidence: ['owner listed on the site'] } };
let q = qualifyReply({ replyKind: 'interested', prospect: strong });
check('a positive reply from a good prospect qualifies', q.qualified === true && q.positive === true, JSON.stringify(q));

q = qualifyReply({ replyKind: 'not-interested', prospect: strong });
check('a negative reply is not positive at all', q.positive === false && q.qualified === false);
check('and says which kind it was', /not a positive reply/.test(q.reasons[0]));
for (const k of POSITIVE_KINDS) check(`"${k}" counts as positive`, qualifyReply({ replyKind: k, prospect: strong }).positive === true);
check('an opt-out is not positive', qualifyReply({ replyKind: 'opt-out', prospect: strong }).positive === false);
check('an auto-reply is not positive', qualifyReply({ replyKind: 'auto-reply', prospect: strong }).positive === false);

// the disqualifying cases — each is still a reply, just not a PRIMARY outcome
q = qualifyReply({ replyKind: 'interested', prospect: { ...strong, withinTargeting: false } });
check('outside the service area does not qualify', q.qualified === false, JSON.stringify(q));
check('but is still recorded as positive', q.positive === true);
check('and says why it did not count', /outside the configured service area/.test(q.disqualifying.join(' ')));

q = qualifyReply({ replyKind: 'interested', prospect: { ...strong, qualification: { segment: 'uncertain' } } });
check('a prospect we were never confident about does not qualify', q.qualified === false);
check('because the reply cannot be credited to the targeting', /never confident/.test(q.disqualifying.join(' ')));

q = qualifyReply({ replyKind: 'interested', prospect: strong, targetingConfirmed: false });
check('while targeting is a draft, "qualified" has no agreed meaning', q.qualified === false, JSON.stringify(q));

q = qualifyReply({ replyKind: 'interested', prospect: strong, contact: { optedOutAt: '2026-10-01' } });
check('someone who has since opted out does not qualify', q.qualified === false);

// noted but not disqualifying — a business with a site can still buy
q = qualifyReply({ replyKind: 'interested', prospect: { ...strong, qualification: { segment: 'has-site' } } });
check('already having a website is noted, not disqualifying', q.qualified === true, JSON.stringify(q));
check('and the note explains the difference', /improvement conversation/.test(q.reasons.join(' ')));

// authority is noted when we have no evidence of it
q = qualifyReply({ replyKind: 'interested', prospect: { qualification: { segment: 'no-site-found' }, withinTargeting: true } });
check('no evidence of authority is recorded as a caveat', /enthusiasm may not be authority/.test(q.reasons.join(' ')), q.reasons.join(' | '));

// ---------------------------------------------------------------------------
section('O3  nothing is promoted without the evidence for its own rung');
// the three that matter
let c = checkAssertion({ outcome: PRIMARY.ATTENDED_CALL, source: 'verified-webhook' });
check('a webhook cannot assert that someone turned up', c.ok === false, JSON.stringify(c));
check('and the refusal says what would be needed', /Someone has to say the call happened/.test(c.error));
c = checkAssertion({ outcome: PRIMARY.RECORDED_SALE, source: 'verified-webhook', amount: 2500 });
check('a webhook cannot assert a sale', c.ok === false);
c = checkAssertion({ outcome: PRIMARY.RECORDED_SALE, source: 'reply-classifier', amount: 2500 });
check('nor can the reply classifier', c.ok === false);
c = checkAssertion({ outcome: PRIMARY.QUALIFIED_REPLY, source: 'owner' });
check('the owner cannot assert a classifier\'s job either', c.ok === false, JSON.stringify(c));

c = checkAssertion({ outcome: PRIMARY.RECORDED_SALE, source: 'owner' });
check('a sale with no amount is refused', c.ok === false, JSON.stringify(c));
check('and says why', /A sale with no number is a feeling/.test(c.error));
check('a zero amount is refused', checkAssertion({ outcome: PRIMARY.RECORDED_SALE, source: 'owner', amount: 0 }).ok === false);
check('a negative amount is refused', checkAssertion({ outcome: PRIMARY.RECORDED_SALE, source: 'owner', amount: -100 }).ok === false);
check('a sale with an amount is accepted', checkAssertion({ outcome: PRIMARY.RECORDED_SALE, source: 'owner', amount: 2500 }).ok === true);

check('a webhook booking must carry its event', checkAssertion({ outcome: PRIMARY.QUALIFIED_BOOKING, source: 'verified-webhook' }).ok === false);
check('and is accepted with one', checkAssertion({ outcome: PRIMARY.QUALIFIED_BOOKING, source: 'verified-webhook', evidence: { id: 'evt' } }).ok === true);
check('an owner-entered booking needs no webhook event', checkAssertion({ outcome: PRIMARY.QUALIFIED_BOOKING, source: 'owner' }).ok === true);

check('an unknown outcome is refused', checkAssertion({ outcome: 'went-well', source: 'owner' }).ok === false);
check('an unknown source is refused', checkAssertion({ outcome: PRIMARY.ATTENDED_CALL, source: 'vibes' }).ok === false);
check('and lists the sources that exist', ASSERTION_SOURCES.length === 3);

// ---------------------------------------------------------------------------
section('O4  recording goes through the same gate');
await reset();
await createExperiment({
  id: EID, variable: 'subject',
  variants: [{ id: 'control', weight: 1 }, { id: 'town', weight: 1 }],
});
await setExperimentState(EID, 'running');
await assign({ experimentId: EID, contactId: 'buyer-1' });

let out = await recordPrimaryOutcome({ experimentId: EID, contactId: 'buyer-1', outcome: PRIMARY.RECORDED_SALE, source: 'owner' });
check('a sale with no amount is refused at the recording step too', out.ok === false, JSON.stringify(out));
check('and nothing was stored', (await tally(EID)).totalOutcomes === 0);

out = await recordPrimaryOutcome({ experimentId: EID, contactId: 'buyer-1', outcome: PRIMARY.RECORDED_SALE, source: 'owner', amount: 2500 });
check('a sale with an amount is recorded', out.ok === true, JSON.stringify(out));
check('at rung 4', out.rung === 4);
check('with the amount kept as evidence', out.outcome.evidence.amount === 2500);
check('and attributed to the arm the contact was in', !!out.outcome.variantId);

out = await recordPrimaryOutcome({ experimentId: EID, contactId: 'buyer-1', outcome: PRIMARY.ATTENDED_CALL, source: 'verified-webhook' });
check('a webhook-asserted attendance is refused at recording', out.ok === false);

// ---------------------------------------------------------------------------
section('O5  the rungs are reported side by side and never summed');
await recordPrimaryOutcome({ experimentId: EID, contactId: 'buyer-1', outcome: PRIMARY.QUALIFIED_REPLY, source: 'reply-classifier' });
await recordPrimaryOutcome({ experimentId: EID, contactId: 'buyer-1', outcome: PRIMARY.ATTENDED_CALL, source: 'owner' });
const b = primaryBreakdown(await tally(EID));
check('the breakdown is produced', b.ok === true, JSON.stringify(b).slice(0, 160));
check('every arm reports all four rungs', b.arms.every((a) => Object.keys(a.rungs).length === 4), JSON.stringify(b.arms[0]));
check('a rung with nothing in it reads zero, not absent', b.arms.every((a) => Object.values(a.rungs).every((n) => typeof n === 'number')));
check('the denominator is reported next to them', b.arms.every((a) => typeof a.denominator === 'number'));
check('the ladder is included so a reader knows what each rung needs', b.ladder.length === 4 && b.ladder.every((l) => !!l.requires));

// the point
const text = JSON.stringify(b);
check('there is no total across rungs', !/"total"/.test(text), text.slice(0, 200));
check('no conversion rate', !/"conversionRate"|"rate"/.test(text));
check('no score', !/"score"/i.test(text));
check('no winner', !/"winner"/i.test(text));
check('and it says in words that a reply is not a sale', /a reply is not a sale/.test(b.note));
check('unattributed outcomes are carried through', typeof b.unattributedOutcomes === 'number');

// unqualified positive replies have their own column
const { recordOutcome } = await import('../lib/experiments.js');
await recordOutcome({ experimentId: EID, contactId: 'buyer-1', kind: 'unqualified-positive-reply' });
const b2 = primaryBreakdown(await tally(EID));
const arm = b2.arms.find((a) => a.unqualifiedPositiveReplies > 0);
check('an unqualified positive reply is counted separately', !!arm, JSON.stringify(b2.arms));
check('and does NOT appear in the qualified rung', arm?.rungs?.[PRIMARY.QUALIFIED_REPLY] === 1, JSON.stringify(arm?.rungs));

check('a breakdown of a missing experiment is refused', primaryBreakdown({ ok: false, error: 'nope' }).ok === false);

// ---------------------------------------------------------------------------
section('O6  the real paths record the right rungs');
{
  const src = await import('node:fs').then((fs) => ({
    replies: fs.readFileSync(new URL('../lib/replies.js', import.meta.url), 'utf8'),
    bookings: fs.readFileSync(new URL('../lib/bookings.js', import.meta.url), 'utf8'),
  }));
  // behavioural checks on the booking path: attendance must go through the gate
  const { recordOutcome: recordBookingOutcome } = await import('../lib/bookings.js');
  const bad = await recordBookingOutcome('no-such-booking', 'attended');
  check('recording an outcome for an unknown booking is refused', bad.ok === false);
  check('and only attended / no-show are accepted', (await recordBookingOutcome('x', 'went-well')).ok === false);

  check('bookings assert rung 2 as a verified webhook', /QUALIFIED_BOOKING/.test(src.bookings) && /verified-webhook/.test(src.bookings));
  check('and attendance as the owner', /ATTENDED_CALL/.test(src.bookings) && /source: 'owner'/.test(src.bookings));
}

// The reply path, driven for real. Greps on lib/replies.js are not enough: a
// control that INVERTED the qualified branch — making every positive reply a
// primary outcome — passed every grep in this file, because the words were all
// still there. ingestReplies takes an injected mail source and contact lookup,
// so the actual behaviour is reachable.
{
  const { ingestReplies } = await import('../lib/replies.js');
  const { listOutcomes } = await import('../lib/experiments.js');

  const runIngest = async (contactId, prospect) => {
    // a fresh arm member per case, so the counts are unambiguous
    await assign({ experimentId: EID, contactId });
    const before = (await listOutcomes(EID)).length;
    await ingestReplies({
      listMail: async () => [{ id: `m-${contactId}`, from: `x@${contactId}.test`, subject: 'Re:', body: 'Yes, that sounds interesting — send details', at: Date.now() }],
      isKnownContact: async () => ({ contactId, campaignId: 'k1', prospectId: prospect ? `p-${contactId}` : null }),
      max: 1,
    });
    const after = await listOutcomes(EID);
    return after.slice(before).filter((o) => o.contactId === contactId);
  };

  const { saveSettings, getSettings } = await import('../lib/settings.js');

  // With targeting CONFIRMED, a positive reply from a known contact qualifies.
  await saveSettings({ targeting: { status: 'confirmed' } });
  let got = await runIngest('ing-ok', null);
  let kinds = got.map((o) => o.kind);
  check('the real reply path records the raw reply', kinds.some((k) => k.startsWith('reply:')), kinds.join(','));
  check('and a qualifying reply reaches the primary rung', kinds.includes(PRIMARY.QUALIFIED_REPLY), kinds.join(','));

  // While targeting is a DRAFT, "qualified" has no agreed meaning, so the same
  // reply must not count as a primary outcome. This is the disqualifier the
  // production path was not supplying at all until this test drove it.
  await saveSettings({ targeting: { status: 'draft' } });
  got = await runIngest('ing-draft', null);
  kinds = got.map((o) => o.kind);
  check('with targeting still a draft the reply is NOT a qualified outcome',
    !kinds.includes(PRIMARY.QUALIFIED_REPLY), kinds.join(','));
  check('it is recorded in the unqualified column instead',
    kinds.includes('unqualified-positive-reply'), kinds.join(','));
  check('and the raw reply is still recorded either way', kinds.some((k) => k.startsWith('reply:')), kinds.join(','));
  await saveSettings({ targeting: { status: 'confirmed' } });
}

await reset();
done();
