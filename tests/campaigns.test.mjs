// R5 — campaigns. The theme throughout: the composer must be unable to say
// something the evidence does not support, and a reply must kill every pending
// follow-up everywhere, not just the current step.
import { check, section, done } from './world.mjs';
import {
  CAMPAIGN_TYPES, CADENCE_BOUNDS, defaultCadence, clampCadence,
  observationFor, composeCold, composeWarm,
  createCampaign, getCampaign, listCampaigns, planSends, addMember, getMember,
  stopContact, dueSends, withinWindow, markStepSent, setCampaignStatus,
  mayEscalateToSms, MEMBER_STATE,
} from '../lib/campaigns.js';
import { WEB_STATUS } from '../lib/discovery.js';
import { saveSettings } from '../lib/settings.js';
import { upsertContact, optOut, field } from '../lib/contacts.js';
import { store } from '../lib/store.js';

const E = (v) => field(v, { confidence: 1, source: 'manual' });
const OWNER = { name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '123 Example St, Plano TX 75024' };

// ---------------------------------------------------------------------------
section('C1  a cold message needs an honest observation, or there is no message');
const noSite = { name: 'Lone Star Flooring', industry: 'flooring', web: { status: WEB_STATUS.NOT_LINKED } };
const weak = { name: 'Metroplex Floors', industry: 'flooring', web: { status: WEB_STATUS.INACCESSIBLE } };
const hasSite = { name: 'Trinity Tile', industry: 'flooring', web: { status: WEB_STATUS.PRESENT } };
const unsure = { name: 'Vague Co', web: { status: WEB_STATUS.UNCERTAIN } };

check('a not-linked listing gives an observation', observationFor(noSite).kind === 'no-site-found');
check('a dead listed site gives a different one', observationFor(weak).kind === 'weak-site');
check('a working website gives NOTHING to open with', observationFor(hasSite) === null);
check('an uncertain result gives nothing either', observationFor(unsure) === null);

let m = await composeCold(hasSite, { owner: OWNER });
check('so no cold message can be built for a business that has a site', m.ok === false, JSON.stringify(m));
check('and the refusal names the status', /verified-present/.test(m.reason), m.reason);

// ---------------------------------------------------------------------------
section('C2  the message cannot claim what was not observed');
await saveSettings({ targeting: { geography: { label: 'Dallas–Fort Worth' } } });
m = await composeCold(noSite, { owner: OWNER });
check('a message is produced', m.ok === true, m.reason);
check('it says "couldn\'t find a website linked from your listing"', /couldn't find a website linked from your listing/.test(m.body), m.body.slice(0, 200));
check('it NEVER says they have no website', !/(you )?(have|has) no website|don't have a website/i.test(m.body), m.body);
check('it offers a way to correct us', /if you do have one/i.test(m.body));
check('the subject matches the observation', /Couldn't find a website/.test(m.subject), m.subject);

// no invented performance claims
for (const bad of [/losing (money|customers|revenue)/i, /conversion rate/i, /your forms? (is|are) broken/i, /ranking (badly|poorly)/i, /google (hates|penalis)/i]) {
  check(`no claim matching ${bad}`, !bad.test(m.body), m.body);
}
// no invented familiarity
check('it does not claim we have met', !/(great|good) to meet|as we discussed|last time we spoke/i.test(m.body));
check('it does not invent urgency', !/act now|limited time|only \d+ spots/i.test(m.body));
check('it does not claim testimonials or results', !/\d+% (more|increase)|our clients see/i.test(m.body));

// CAN-SPAM essentials
check('it identifies the sender by name', m.body.includes(OWNER.name));
check('it gives the business name', m.body.includes(OWNER.business));
check('it carries a postal address', m.body.includes(OWNER.postalAddress));
check('it carries an opt-out', /STOP|unsubscribe/i.test(m.body));
const noId = await composeCold(noSite, { owner: { name: 'X' } });
check('an incomplete sender identity blocks the message entirely', noId.ok === false && /postal address/.test(noId.reason), noId.reason);

// ---------------------------------------------------------------------------
section('C3  a preview is mentioned only when one exists (R5.2)');
check('with no preview, none is mentioned', !/I built a rough version/.test(m.body));
check('and the flag says so', m.mentionsPreview === false);
let withPrev = await composeCold(noSite, { owner: OWNER, preview: { exists: true, url: 'https://preview.example.com/lone-star' } });
check('with a real preview it is mentioned', withPrev.mentionsPreview === true && /preview\.example\.com/.test(withPrev.body));
let fakePrev = await composeCold(noSite, { owner: OWNER, preview: { exists: false, url: 'https://preview.example.com/nope' } });
check('a preview that does not exist is NOT mentioned, even with a URL', fakePrev.mentionsPreview === false && !/preview\.example\.com/.test(fakePrev.body));

// ---------------------------------------------------------------------------
section('C4  price appears only when pricing is configured (G1)');
await saveSettings({ pricing: { buildPrice: '', monthlyFee: '' } });
m = await composeCold(noSite, { owner: OWNER });
check('unset pricing means no price sentence', m.mentionsPrice === false, m.body);
check('and no stray currency symbol', !/\$\s*(undefined|null|NaN|0\b)/.test(m.body), m.body);
await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' } });
m = await composeCold(noSite, { owner: OWNER });
check('configured pricing is quoted', m.mentionsPrice === true && /\$2,500 to build, then \$197\/month/.test(m.body), m.body);

// ---------------------------------------------------------------------------
section('C5  warm follow-up never claims a meeting that did not happen (R3.12)');
let w = await composeWarm({ name: E('Angie'), businessName: E('OMT'), relationship: 'met_in_person', event: 'the Plano chamber breakfast' }, { owner: OWNER });
check('having met, it may say so', w.ok === true && /Good to meet you at the Plano chamber breakfast/.test(w.body), w.body);
w = await composeWarm({ name: E('Bob'), businessName: E('BobCo'), relationship: 'same_networking_group', networkingGroup: 'BNI Plano' }, { owner: OWNER });
check('sharing a group is stated as NOT having met', /don't think we've actually met/.test(w.body), w.body);
check('and it never says "good to meet you"', !/good to meet you/i.test(w.body));
w = await composeWarm({ name: E('Nobody'), relationship: 'none' }, { owner: OWNER });
check('no recorded relationship means no warm message at all', w.ok === false && /nothing truthful/.test(w.reason), w.reason);

// ---------------------------------------------------------------------------
section('C6  cadence is editable but bounded (R5.3)');
let c = clampCadence(CAMPAIGN_TYPES.COLD_NO_SITE, { gapDays: 4, followUps: 2 });
check('a sane cadence passes through', c.gapDays === 4 && c.followUps === 2 && c.notes.length === 0);
c = clampCadence(CAMPAIGN_TYPES.COLD_NO_SITE, { gapDays: 0, followUps: 99 });
check('a same-day gap is raised', c.gapDays === CADENCE_BOUNDS.minGapDays);
check('and 99 follow-ups are capped at 2', c.followUps === 2, String(c.followUps));
check('the clamping is explained, not silent', c.notes.length === 2, JSON.stringify(c.notes));
c = clampCadence(CAMPAIGN_TYPES.WARM_CARD, { followUps: 5 });
check('a warm campaign allows at most ONE reminder', c.followUps === 1, String(c.followUps));
c = clampCadence(CAMPAIGN_TYPES.COLD_NO_SITE, { gapDays: 'abc', followUps: null });
check('garbage falls back to the default rather than NaN', c.gapDays === 4 && Number.isFinite(c.followUps));

// ---------------------------------------------------------------------------
section('C7  a campaign is never created running');
let r = await createCampaign({ name: 'DFW flooring — no site found', type: CAMPAIGN_TYPES.COLD_NO_SITE });
check('it is created', r.ok === true, r.reason);
const camp = r.campaign;
check('status is draft, not running', camp.status === 'draft');
check('it records whether outreach was even active when it was made', camp.outreachActiveAtCreation === false);
check('an unknown type is refused', (await createCampaign({ name: 'x', type: 'nope' })).ok === false);

const plan = planSends(camp, 1000);
check('the plan is intro plus the follow-ups', plan.length === 3, String(plan.length));
check('the intro is immediate', plan[0].at === 1000 && plan[0].kind === 'intro');
check('follow-ups are spaced by the cadence', plan[1].at === 1000 + 4 * 86400000 && plan[2].at === 1000 + 8 * 86400000);

// ---------------------------------------------------------------------------
section('C8  a reply cancels EVERY pending follow-up, in every campaign (R5.4)');
const a = await upsertContact({ source: 'discovery', name: E('Pat Lee'), businessName: E('Lone Star Flooring'), email: E('pat@lonestarflooring.com') });
const contact = a.contact;
const c2 = (await createCampaign({ name: 'second campaign', type: CAMPAIGN_TYPES.COLD_WEAK_SITE })).campaign;

let add = await addMember(camp.id, contact);
check('a contact can be added', add.ok === true, add.reason);
await addMember(c2.id, contact);
let mem = await getMember(camp.id, contact.id);
check('with three scheduled sends', mem.plan.length === 3 && mem.state === MEMBER_STATE.SCHEDULED);

await markStepSent(camp.id, contact.id, 0);
mem = await getMember(camp.id, contact.id);
check('after the intro, two are still pending', mem.sentSteps.length === 1);

const stop = await stopContact(contact.id, 'replied');
check('stopping touches both campaigns', stop.stopped.length === 2, JSON.stringify(stop.stopped));
check('and cancels the pending sends', stop.totalCancelled >= 4, String(stop.totalCancelled));
mem = await getMember(camp.id, contact.id);
check('the member is stopped', mem.state === MEMBER_STATE.STOPPED);
check('the reason is recorded', mem.stoppedReason === 'replied');
check('and NOTHING pending survives in the plan', mem.plan.every((p) => mem.sentSteps.includes(p.step)), JSON.stringify(mem.plan));

await setCampaignStatus(camp.id, 'running');
let due = await dueSends(camp.id, { now: Date.now() + 30 * 86400000 });
check('a month later, a stopped contact is still not due', !due.due.some((d) => d.contactId === contact.id), JSON.stringify(due.due));
await markStepSent(camp.id, contact.id, 1);
mem = await getMember(camp.id, contact.id);
check('and a late worker cannot resurrect them', mem.state === MEMBER_STATE.STOPPED && !mem.sentSteps.includes(1));

// ---------------------------------------------------------------------------
section('C9  an opted-out contact cannot be added at all');
const b = await upsertContact({ source: 'discovery', name: E('Sam Ortiz'), businessName: E('Metroplex Floors'), email: E('sam@metroplexfloors.com') });
await optOut({ email: 'sam@metroplexfloors.com', reason: 'unsubscribed' });
const refreshed = (await upsertContact({ source: 'discovery', name: E('Sam Ortiz'), businessName: E('Metroplex Floors'), email: E('sam@metroplexfloors.com') })).contact;
add = await addMember(camp.id, refreshed);
check('adding an opted-out contact is refused', add.ok === false && add.refused === true, JSON.stringify(add));
check('and the reason is consent', /opted out/i.test(add.reason), add.reason);

// ---------------------------------------------------------------------------
section('C10  a draft campaign sends nothing, and the window holds sends');
const c3 = (await createCampaign({ name: 'draft one', type: CAMPAIGN_TYPES.COLD_NO_SITE })).campaign;
const d = await upsertContact({ source: 'discovery', name: E('Dana Kim'), businessName: E('Trinity Tile'), email: E('dana@trinitytile.com') });
await addMember(c3.id, d.contact);
due = await dueSends(c3.id, { now: Date.now() });
check('a draft campaign has nothing due', due.due.length === 0);
check('and says why', /draft, not running/.test(due.note), due.note);

await setCampaignStatus(c3.id, 'running');
// a Wednesday at 14:00 US Central
const wed2pm = Date.UTC(2026, 9, 7, 19, 0);
check('2pm on a Wednesday is inside the window', withinWindow(wed2pm, { startHour: 8, endHour: 17 }) === true);
check('3am is not', withinWindow(Date.UTC(2026, 9, 7, 8, 0), { startHour: 8, endHour: 17 }) === false);
const sat = Date.UTC(2026, 9, 10, 19, 0);
check('Saturday is not, whatever the hour', withinWindow(sat, { startHour: 8, endHour: 17 }) === false);

due = await dueSends(c3.id, { now: wed2pm, window: { startHour: 8, endHour: 17 } });
check('inside the window a due send appears', due.due.length === 1, JSON.stringify(due));
due = await dueSends(c3.id, { now: sat, window: { startHour: 8, endHour: 17 } });
check('on a Saturday it is held, not sent', due.due.length === 0 && due.held === 1, JSON.stringify(due));
check('and the hold is explained', /outside the sending window/.test(due.note), due.note);

// ---------------------------------------------------------------------------
section('C11  email never escalates into a text (R5.8)');
const esc = mayEscalateToSms();
check('escalation is refused', esc.allowed === false);
check('and the rule is stated', /never becomes a text/.test(esc.reason), esc.reason);

const all = await listCampaigns();
check('campaigns are listed newest first', all.length >= 3 && all[0].createdAt >= all[all.length - 1].createdAt);
check('none of them is running by accident', all.filter((x) => x.status === 'running').length === 2, all.map((x) => `${x.name}:${x.status}`).join(', '));

done();
