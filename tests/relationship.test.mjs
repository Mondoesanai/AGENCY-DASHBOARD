// Business cards start a relationship, not a cold lead.
//
// The journeys below are the ones from the addendum, driven through the real
// modules. The one that matters most is the last section: a contact who came
// from a card must be REFUSED by the cold sequence. Everything else here is
// bookkeeping if that one does not hold.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  ENCOUNTER, INTEREST, PATH, PATH_LABEL, route, assignRoute, getRoute, editRoute,
  mayRunCold, dueFollowUps, describe,
} from '../lib/relationship.js';

const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 24 * 3600e3;

// ---------------------------------------------------------------------------
section('P1  each stated outcome routes to its own path');
const r = (o) => route(o, { now: NOW });

check('asked for a preview', r({ encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.PREVIEW }).path === PATH.PREVIEW_REQUESTED);
check('wants to talk', r({ encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.CONVERSATION }).path === PATH.CONVERSATION);
check('asked to be contacted later', r({ encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.LATER }).path === PATH.FOLLOW_UP_LATER);
check('met, nothing specific', r({ encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.NONE }).path === PATH.GENTLE_INTRO);
check('same group, never met', r({ encounter: ENCOUNTER.SHARED_GROUP, networkingGroup: 'BNI' }).path === PATH.GROUP_CONTEXT);
check('already has a good site', r({ encounter: ENCOUNTER.CONVERSATION, hasGoodWebsite: true }).path === PATH.LOW_PRIORITY_GOOD_SITE);
check('not interested', r({ encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.NOT_INTERESTED }).path === PATH.ENDED);
check('a card with no conversation', r({ encounter: ENCOUNTER.CARD_ONLY }).path === PATH.GENTLE_INTRO);

check('every path carries a reason in words', Object.values(INTEREST).every((i) => {
  const d = r({ encounter: ENCOUNTER.CONVERSATION, interest: i });
  return typeof d.why === 'string' && d.why.length > 30;
}));
check('and a concrete next action', Object.values(INTEREST).every((i) => {
  const d = r({ encounter: ENCOUNTER.CONVERSATION, interest: i });
  return typeof d.nextAction === 'string' && d.nextAction.length > 5;
}));
check('NO path permits the cold sequence', Object.values(INTEREST).every((i) =>
  r({ encounter: ENCOUNTER.CONVERSATION, interest: i }).mayRunColdSequence === false));

// ---------------------------------------------------------------------------
section('P2  a date THEY named outranks anything we would have chosen');
const tuesday = NOW + 3 * DAY;
const promised = r({ encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.PREVIEW, promisedFollowUpAt: tuesday, event: 'Plano Chamber' });
check('a promised date wins even over a preview request', promised.path === PATH.FOLLOW_UP_LATER, promised.path);
check('the date is theirs, exactly', promised.dueAt === tuesday);
check('the reason says it was their date', /date is theirs/i.test(promised.why), promised.why);
check('and nothing goes out before it', promised.suppressUntil === tuesday);
check('the meeting place is in the reason', /Plano Chamber/.test(promised.why), promised.why);

const vague = r({ encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.LATER });
check('"later" with no date is scheduled, not guessed sooner', vague.dueAt === NOW + 14 * DAY);
check('and says it was not their date', /did not name a date/i.test(vague.why), vague.why);

// ---------------------------------------------------------------------------
section('P3  the system never claims a meeting that did not happen');
const neverMet = r({ encounter: ENCOUNTER.SHARED_GROUP, networkingGroup: 'Plano BNI' });
check('a group contact is flagged as never met', neverMet.mustNotClaimMeeting === true);
check('and the group is the only context offered', /never met/i.test(neverMet.why) && /Plano BNI/.test(neverMet.why), neverMet.why);
const cardOnly = r({ encounter: ENCOUNTER.CARD_ONLY });
check('a card with no conversation is flagged too', cardOnly.mustNotClaimMeeting === true);
check('and says the opening cannot claim one', /cannot claim/i.test(cardOnly.why), cardOnly.why);
const met = r({ encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.NONE, event: 'Plano Chamber' });
check('an actual conversation is NOT flagged', !met.mustNotClaimMeeting);
check('and describe() says whether a meeting may be claimed', (() => {
  const d = describe({ ...met, interaction: { encounter: ENCOUNTER.CONVERSATION } });
  const g = describe({ ...neverMet, interaction: { encounter: ENCOUNTER.SHARED_GROUP } });
  return d.mayClaimMeeting === true && g.mayClaimMeeting === false;
})());

// ---------------------------------------------------------------------------
section('P4  the decision is stored, visible and editable');
await store.set('relationship:rel-1', '').catch(() => {});
const assigned = await assignRoute('rel-1', {
  encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.PREVIEW,
  event: 'Plano Chamber', requestedNextStep: 'send the preview', notes: 'owns a flooring company',
}, { now: NOW });
check('it is assigned', assigned.ok === true, JSON.stringify(assigned).slice(0, 140));
let stored = await getRoute('rel-1');
check('and read back', !!stored && stored.path === PATH.PREVIEW_REQUESTED);
check('the interaction is kept, not just the verdict', stored.interaction.notes === 'owns a flooring company');
check('including what they asked for', stored.interaction.requestedNextStep === 'send the preview');

const edited = await editRoute('rel-1', { path: PATH.CONVERSATION, nextAction: 'call her', reason: 'she phoned me' }, { now: NOW + DAY });
check('the owner can change the path', edited.ok === true && edited.relationship.path === PATH.CONVERSATION);
check('the next action changes with it', edited.relationship.nextAction === 'call her');
check('the ORIGINAL reason is kept, with the change appended', /asked to see a preview/i.test(edited.relationship.why) && /changed to/i.test(edited.relationship.why),
  edited.relationship.why);
check('and it records that a person intervened', !!edited.relationship.editedAt);
check('an override still does not unlock the cold sequence', edited.relationship.mayRunColdSequence === false);
check('an unknown path is refused', (await editRoute('rel-1', { path: 'made-up' })).ok === false);
check('editing a contact with no relationship is refused', (await editRoute('nobody-at-all', { nextAction: 'x' })).ok === false);

// ---------------------------------------------------------------------------
section('P5  THE ONE THAT MATTERS: a card contact is refused by the cold sequence');
const cold = await mayRunCold('rel-1');
check('the cold sequence is refused', cold.ok === false, JSON.stringify(cold));
check('and the refusal explains the relationship', /relationship/i.test(cold.reason), cold.reason);
check('naming the path', !!cold.path);

check('a contact with NO relationship is still coldable', (await mayRunCold('never-seen-before')).ok === true);

// fails closed: an unreadable record must not become "treat as cold"
const realGet = store.get;
store.get = async (k) => { if (String(k).startsWith('relationship:')) throw new Error('store down'); return realGet.call(store, k); };
const unreadable = await mayRunCold('rel-1');
store.get = realGet;
check('an unreadable relationship is NOT treated as cold', unreadable.ok === false, JSON.stringify(unreadable));
check('and says why it refused', /could not be read/i.test(unreadable.reason), unreadable.reason);

// ---------------------------------------------------------------------------
section('P6  the owner gets a worklist of what is actually due');
await store.set('relationship:rel-2', '').catch(() => {});
await assignRoute('rel-2', { encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.LATER, promisedFollowUpAt: NOW - DAY }, { now: NOW });
await assignRoute('rel-3', { encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.LATER, promisedFollowUpAt: NOW + 30 * DAY }, { now: NOW });
const due = await dueFollowUps({ now: NOW });
check('the list reads', due.ok === true);
check('a promise that has come due is in it', (due.due || []).some((d) => d.contactId === 'rel-2'), JSON.stringify((due.due || []).map((d) => d.contactId)));
check('one that has not is NOT', !(due.due || []).some((d) => d.contactId === 'rel-3'));
check('an ended relationship never appears', (() => {
  return !(due.due || []).some((d) => d.path === PATH.ENDED);
})());

done();
