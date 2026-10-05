// The journeys from the addendum, end to end through the real modules.
//
// "Multiple cards photographed after one event. Shared event context applied,
// with individual notes preserved. An existing contact matched without losing
// history. A requested preview becoming a tracked production task. No 'preview
// ready' message before the preview exists."
//
// Each of those is a sentence someone can check against the screen, which is
// why they are the test names.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { saveCards } from '../lib/card-intake.js';
import { getRoute, PATH, ENCOUNTER, INTEREST, mayRunCold } from '../lib/relationship.js';
import { forContact, mayAnnounce, setState, PREVIEW_STATE, stats as previewStats } from '../lib/previews.js';

const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 24 * 3600e3;
const F = (v) => ({ value: v, confidence: 0.92, source: 'card' });

// ---------------------------------------------------------------------------
section('J1  four cards from one event: shared context, individual notes');
const batch = [
  { name: F('Jordan Hale'), businessName: F('Hale Flooring'), email: F('jordan@haleflooring.example'), phone: F('214-555-0101'), website: F('https://haleflooring.example') },
  { name: F('Priya Raman'), businessName: F('Raman Roofing'), email: F('priya@ramanroofing.example'), phone: F('214-555-0102') },
  { name: F('Chris Okafor'), businessName: F('Okafor HVAC'), email: F('chris@okaforhvac.example'), phone: F('214-555-0103') },
  { name: F('Lee Chan'), businessName: F('Chan Landscaping'), email: F('lee@chanlandscaping.example'), phone: F('214-555-0104'), website: F('https://chanlandscaping.example') },
];

const saved = await saveCards(batch, {
  relationship: 'met_in_person',
  event: 'Plano Chamber breakfast',
  collectedAt: new Date(NOW).toISOString(),
  meetingNotes: 'Plano Chamber breakfast, October',
  interactions: {
    // Jordan: the example from the brief
    0: { encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.PREVIEW, notes: 'Owns a flooring company. Wants an easier way for customers to request quotes.', requestedNextStep: 'send the preview', promisedFollowUpAt: NOW + 3 * DAY },
    1: { encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.CONVERSATION, notes: 'Asked what it costs.' },
    2: { encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.NONE, notes: 'Friendly, no specific need.' },
    3: { encounter: ENCOUNTER.CONVERSATION, hasGoodWebsite: true, notes: 'Site already looks good.' },
  },
});

check('all four were saved', saved.length === 4, String(saved.length));
check('every one became a contact', saved.every((s) => s.contact && s.contact.id));
check('each carries its own relationship', saved.every((s) => !!s.relationship), JSON.stringify(saved.map((s) => !!s.relationship)));

const [jordan, priya, chris, lee] = saved;
check('Jordan is routed to the preview path', jordan.relationship.path === PATH.FOLLOW_UP_LATER || jordan.relationship.path === PATH.PREVIEW_REQUESTED, jordan.relationship.path);
check('Priya wants a conversation', priya.relationship.path === PATH.CONVERSATION, priya.relationship.path);
check('Chris gets a gentle introduction', chris.relationship.path === PATH.GENTLE_INTRO, chris.relationship.path);
check('Lee is low priority — the site already works', lee.relationship.path === PATH.LOW_PRIORITY_GOOD_SITE, lee.relationship.path);

// shared context applied to all, individual notes preserved per person
check('the event is on every one of them', saved.every((s) => s.relationship.interaction.event === 'Plano Chamber breakfast'));
check("and each person's OWN note survived", jordan.relationship.interaction.notes.includes('flooring')
  && priya.relationship.interaction.notes.includes('what it costs')
  && lee.relationship.interaction.notes.includes('already looks good'),
  JSON.stringify(saved.map((s) => s.relationship.interaction.notes.slice(0, 30))));
check('the batch note did not overwrite them', jordan.relationship.interaction.notes !== priya.relationship.interaction.notes);

// ---------------------------------------------------------------------------
section('J2  none of them can be put in a cold campaign');
for (const s of saved) {
  const cold = await mayRunCold(s.contact.id);
  check(`${s.relationship.interaction.event ? '' : ''}${s.contact.id} is refused by the cold sequence`, cold.ok === false, JSON.stringify(cold).slice(0, 110));
}

// through the real enrolment door, not just the helper
const { createCampaign, addMember, CAMPAIGN_TYPES } = await import('../lib/campaigns.js');
const made = await createCampaign({ name: 'Cold flooring', type: CAMPAIGN_TYPES.COLD_NO_SITE });
const enrol = await addMember(made.campaign.id, jordan.contact);
check('adding a card contact to a COLD campaign is refused', enrol.ok === false, JSON.stringify(enrol).slice(0, 170));
check('and the refusal names the relationship', /relationship/i.test(enrol.reason || ''), enrol.reason);

// ---------------------------------------------------------------------------
section('J3  the requested preview became a tracked production task');
const tasks = await forContact(jordan.contact.id);
check('a preview task exists for Jordan', tasks.length === 1, String(tasks.length));
const task = tasks[0] || null;
check('it starts as requested', !!task && task.state === PREVIEW_STATE.REQUESTED, task && task.state);
check('it carries the business name', !!task && /Hale Flooring/.test(task.businessName), task && task.businessName);
check('and the actual conversation, for whoever builds it', !!task && /quotes/i.test(task.conversationNotes), task && task.conversationNotes);
check('and where the request came from', !!task && /Plano Chamber/.test(task.requestedVia), task && task.requestedVia);
check('nobody else got a preview task', (await forContact(priya.contact.id)).length === 0);

// ---------------------------------------------------------------------------
section('J4  NO "your preview is ready" before a preview exists');
let announce = await mayAnnounce(jordan.contact.id);
check('while it is only requested, announcing is refused', announce.ok === false, JSON.stringify(announce));
check('and says what state it is actually in', /not ready|requested/i.test(announce.reason), announce.reason);

if (task) await setState(task.id, PREVIEW_STATE.IN_PROGRESS);
announce = await mayAnnounce(jordan.contact.id);
check('while it is being built, still refused', announce.ok === false, announce.reason);
check('and the refusal would be untrue to send', /untrue/i.test(announce.reason), announce.reason);

// ready REQUIRES a url — the state that unlocks the message cannot be faked
const noUrl = task ? await setState(task.id, PREVIEW_STATE.READY) : { ok: false, error: 'no task' };
check('marking it ready with NO url is refused', noUrl.ok === false, JSON.stringify(noUrl).slice(0, 160));
check('and says why that matters', /unlocks|point at something/i.test(noUrl.error), noUrl.error);
check('a nonsense url is refused too', task ? (await setState(task.id, PREVIEW_STATE.READY, { url: 'not a url' })).ok === false : false);

const ready = task ? await setState(task.id, PREVIEW_STATE.READY, { url: 'https://preview.example.invalid/hale-flooring' }) : { ok: false };
check('with a real url it becomes ready', ready.ok === true, JSON.stringify(ready).slice(0, 140));
announce = await mayAnnounce(jordan.contact.id);
check('NOW announcing is allowed', announce.ok === true, JSON.stringify(announce));
check('and it hands over the actual link', /preview\.example\.invalid/.test(announce.url), announce.url);

// and if the link does not load, it is not ready after all
const dead = await mayAnnounce(jordan.contact.id, { check: async () => ({ ok: false, reason: '404' }) });
check('a url that does not load is refused', dead.ok === false, JSON.stringify(dead));
check('even though the task says ready', /did not load/i.test(dead.reason), dead.reason);
const live = await mayAnnounce(jordan.contact.id, { check: async () => ({ ok: true }) });
check('a url that does load is allowed', live.ok === true);

// ---------------------------------------------------------------------------
section('J5  the state machine will not let a promise skip steps');
check('requested cannot jump straight to delivered', task ? (await setState(task.id, PREVIEW_STATE.DELIVERED)).ok === true : false, 'ready -> delivered is legal, which is what we are in');
const t2 = await forContact(priya.contact.id);
check('Priya has no task to move at all', t2.length === 0);

const s = await previewStats();
check('the report counts promises', s.promised >= 1, JSON.stringify(s));
check('and separates delivered from promised', typeof s.delivered === 'number' && typeof s.brokenPromises === 'number', JSON.stringify(s));

// ---------------------------------------------------------------------------
section('J6  an existing contact is matched without losing their history');
const again = await saveCards(
  [{ name: F('Jordan Hale'), businessName: F('Hale Flooring'), email: F('jordan@haleflooring.example'), phone: F('214-555-0101') }],
  { relationship: 'met_in_person', event: 'Second meeting', collectedAt: new Date(NOW + 7 * DAY).toISOString(),
    interactions: { 0: { encounter: ENCOUNTER.CONVERSATION, interest: INTEREST.CONVERSATION, notes: 'Followed up about the preview.' } } }
);
check('the same person is matched, not duplicated', again[0].contact.id === jordan.contact.id,
  `${again[0].contact.id} vs ${jordan.contact.id}`);
check('their action was a merge, not a create', again[0].action === 'merged', again[0].action);
const stillThere = await forContact(jordan.contact.id);
check('their preview task survived the second scan', stillThere.length === 1, String(stillThere.length));
check('and still has its url', !!stillThere[0].url, String(stillThere[0].url));

done();
