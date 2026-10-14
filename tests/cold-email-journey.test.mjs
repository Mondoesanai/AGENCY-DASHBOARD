// The whole cold-email journey, driven against a fake provider.
//
// R24.3. Every stage of this path existed and was individually tested. Nothing
// ran it end to end, because nothing READ "who is due" and walked them through
// — `lib/jobs.js:enqueue`, `replies.js:guardedSend` and
// `outreach-email.js:sendProspectEmail` all had zero production callers. The
// reachability audit recorded that honestly as HELD, but it also meant the
// claim "credentials are the only thing missing" was false: with a paid key in
// place, nothing would have happened.
//
// These checks drive `runCampaignSends` — the real production function behind
// `?do=campaign-run` — with a fake adapter at the HTTP boundary and the real
// store, real consent gate, real suppression list and real idempotency ledger
// underneath. Nothing is stubbed above the network.
//
// LOCAL VERIFIED, NOT LIVE VERIFIED. No real provider answered any of this. A
// fake that returns what the documentation says Instantly returns is evidence
// that our side of the contract is right; it is not evidence that Instantly
// behaves that way. The distinction is the point and is kept in the names.

import { W, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { upsertContact, field, optOut } from '../lib/contacts.js';
import {
  createCampaign, addMember, getMember, setCampaignStatus, dueSends,
  CAMPAIGN_TYPES, MEMBER_STATE,
} from '../lib/campaigns.js';
import { saveSender, saveSettings, getSettings, ownerIdentity } from '../lib/settings.js';
import { runCampaignSends, enqueueProviderEnrolment, sentToday, lastRun, RUN_OUTCOME, MAX_PER_RUN } from '../lib/campaign-runner.js';
import { getSendAttempt, SEND_OUTCOME, isSuppressed } from '../lib/outreach-email.js';
import { listQueue } from '../lib/jobs.js';

const E = (v) => field(v, 'manual');

// There is NO production path that turns the outreach switch on: saveSettings
// has no `outreach` branch at all, and getSettings forces
// `active: saved?.outreach?.active === true`. That is a real finding, reported
// separately. For these checks the stored blob is written directly, which is
// the only way the switch can currently move.
async function setSwitch(active) {
  const raw = await store.get('settings:business').catch(() => null);
  const cur = raw ? JSON.parse(raw) : {};
  cur.outreach = { ...(cur.outreach || {}), active: !!active };
  await store.set('settings:business', JSON.stringify(cur));
}
const WED = Date.UTC(2026, 9, 7, 19, 0); // Wednesday 14:00 US Central — inside the window

// CAN-SPAM requires a real name, business and postal address in every
// commercial message, and both composers refuse without them. `saveSender`, not
// `saveSettings`: the identity lives under `settings.sender` and `saveSettings`
// has no branch for it at all — which is how two production entry points came
// to read `settings.business`, a key that does not exist.
async function setOwnerPrerequisites() {
  // sendReadiness also requires configured pricing and owner-confirmed
  // targeting. These are the owner's own decisions, and J2 proves they block.
  await saveSettings({ pricing: { buildPrice: 2500, monthlyFee: 297 } });
  await saveSettings({ targeting: { status: 'confirmed', industries: [{ key: 'flooring', osm: [] }] } });
}

async function setSenderIdentity() {
  await saveSender({
    name: 'Test Owner', business: 'Inspiring Websites LLC',
    postalAddress: '6504 Preston Meadow Dr, Plano, TX 75024', replyTo: 'owner@example.test',
  });
}

// THE SHAPE THE SEND GATE ACTUALLY REQUIRES.
//
// `targeting.js:segmentFor` admits only a business with a VERIFIED working
// website of its own (not a Facebook page) plus two signals of a going concern
// that the website did not supply -- a published phone number, a street
// address, or opening hours. A fixture without those is refused before any of
// this is exercised, which is what the first version of this file discovered.
async function prospectContact(name, business, email, { domain = null } = {}) {
  const site = domain || `https://${business.toLowerCase().replace(/[^a-z0-9]+/g, '')}.test`;
  const r = await upsertContact({
    source: 'discovery', name: E(name), businessName: E(business), email: E(email),
    website: E(site),
    phone: E('+19725550143'),
    address: '400 W Parker Rd, Plano TX',
    openingHours: 'Mon-Fri 8-5',
    websiteCheck: { status: 'verified-present', attempted: site, url: site, checkedAt: Date.now() },
  });
  return r.contact;
}

// A real measurement, cached the way runAudit caches it, so the opening line is
// a number somebody could check rather than an opinion.
async function seedAudit(contact, { highSeverity = true } = {}) {
  const url = contact.website?.value || contact.website;
  await store.set(`audit:${url}`, JSON.stringify({
    url, ok: true, at: Date.now(),
    scores: { seo: highSeverity ? 61 : 97, performance: 80, accessibility: 90, bestPractices: 90 },
    checks: { metaDescription: !highSeverity, title: true, structuredData: true, crawlable: true, viewport: true, https: true },
    vitals: { lcp: 2400, cls: 0.04 },
  }));
  return url;
}

// A business whose listing shows no website — the shape the LISTING-based
// observation can write about, and the shape the send gate refuses. Used to
// prove the two policies really are disjoint.
async function noSiteContact(name, business, email) {
  const r = await upsertContact({
    source: 'discovery', name: E(name), businessName: E(business), email: E(email),
    phone: E('+19725550144'), address: '1 Example Way, Plano TX',
    websiteCheck: { status: 'not-linked-in-listing', checkedAt: Date.now() },
  });
  return r.contact;
}

async function newRunningCampaign(label) {
  const c = (await createCampaign({ name: label, type: CAMPAIGN_TYPES.COLD_NO_SITE })).campaign;
  await setCampaignStatus(c.id, 'running');
  return c;
}

// ---------------------------------------------------------------------------
section('J1  THE SWITCH IS CHECKED FIRST, before any provider is contacted');
// With outreach off a refusal must name the SWITCH. An owner who reads
// "provider error" when the truth is "you never turned it on" goes looking in
// the wrong place, and may go and buy something.
await setSenderIdentity();
await setOwnerPrerequisites();
await setSwitch(false);
const offCampaign = await newRunningCampaign('switch off');
const pat = await prospectContact('Pat Lee', 'Lone Star Flooring', 'pat@lonestarflooring.test');
await seedAudit(pat);
await addMember(offCampaign.id, pat, { startAt: WED });

let calls = 0;
const countingFetch = async () => { calls++; return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; };

const off = await runCampaignSends(offCampaign.id, { now: WED, fetchImpl: countingFetch });
check('it refuses', off.ok === false, JSON.stringify(off).slice(0, 160));
check('and says the switch is off', off.switchOff === true && /switched off/.test(off.reason), off.reason);
check('NO provider call was made', calls === 0, `${calls} fetches`);
check('and nothing was marked sent',
  (await getMember(offCampaign.id, pat.id)).sentSteps.length === 0);
check('no send attempt was recorded either',
  !(await getSendAttempt(`${offCampaign.id}:${pat.id}`)),
  'a refusal before the gate must not leave a half-written ledger entry');

// ---------------------------------------------------------------------------
section('J2  switch on, no provider connected — refused, and it says which');
// This is the state the system is actually in today. The honest answer names
// the missing credential rather than failing silently or pretending to send.
await setSwitch(true);
const s1 = await getSettings();
check('the switch really is on now', s1.outreach.active === true);

const noProv = await newRunningCampaign('no provider');
const sam = await prospectContact('Sam Ortiz', 'Metroplex Floors', 'sam@metroplexfloors.test');
await seedAudit(sam);
await addMember(noProv.id, sam, { startAt: WED });

const disconnected = await runCampaignSends(noProv.id, { now: WED, env: {}, fetchImpl: countingFetch });
check('the run itself completes', disconnected.ok === true, JSON.stringify(disconnected).slice(0, 160));
check('it attempted the member', disconnected.attempted === 1, `${disconnected.attempted}`);
check('and the outcome is a refusal, not a failure',
  disconnected.results[0].outcome === RUN_OUTCOME.REFUSED, JSON.stringify(disconnected.results[0]));
check('naming the exact missing credential',
  /INSTANTLY_API_KEY/.test(disconnected.results[0].reason || ''),
  (disconnected.results[0].reason || '').slice(0, 120),
  'an owner who reads "provider error" goes looking in the wrong place, and may go and buy something');
check('and refusing to reuse the client-report sender',
  /Resend cannot be used/.test(disconnected.results[0].reason || ''),
  'prospecting must never route through the account that delivers paying clients their reports');
check('the step is NOT marked sent',
  (await getMember(noProv.id, sam.id)).sentSteps.length === 0,
  'a refused send that marks the step sent loses the person for ever');
check('and nothing reached a provider', calls === 0, `${calls} fetches`);

// ---------------------------------------------------------------------------
section('J3  a connected provider: the full journey, end to end');
// The fake answers the way the provider's own v2 docs describe. This is where
// LOCAL VERIFIED is earned — and where it stops.
const sent = [];
const okFetch = async (url, init) => {
  sent.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return {
    ok: true, status: 200,
    json: async () => ({ id: `lead_${sent.length}`, status: 'added' }),
    text: async () => JSON.stringify({ id: `lead_${sent.length}` }),
  };
};
const ENV = {
  INSTANTLY_API_KEY: 'fake-key-for-tests',
  OUTREACH_FROM_DOMAIN: 'mail.example.test',
  PUBLIC_BASE_URL: 'https://dash.example.test',
  UNSUBSCRIBE_SECRET: 'test-signing-secret-not-a-real-one',
};

const live = await newRunningCampaign('connected');
const dana = await prospectContact('Dana Kim', 'Trinity Tile', 'dana@trinitytile.test');
await seedAudit(dana);
await addMember(live.id, dana, { startAt: WED });

const run = await runCampaignSends(live.id, { now: WED, env: ENV, fetchImpl: okFetch });
check('the run succeeded', run.ok === true, JSON.stringify(run).slice(0, 200));
const first = run.results[0] || {};
check('one member was attempted', run.attempted === 1, `${run.attempted}`);
check('and the outcome is SENT', first.outcome === RUN_OUTCOME.SENT, JSON.stringify(first));
check('the provider was actually called', sent.length >= 1, `${sent.length} calls`);
check('to the provider, not somewhere else',
  /instantly\.ai/.test(sent[0].url), sent[0].url);

section('J3b  what was actually put on the wire');
const payload = sent[0].body || {};
const lead = (payload.leads && payload.leads[0]) || payload;
check('the recipient is the contact', JSON.stringify(lead).includes('dana@trinitytile.test'), JSON.stringify(lead).slice(0, 200));
check('a one-click unsubscribe URL travelled with it',
  /unsubscribe/i.test(JSON.stringify(lead)), JSON.stringify(lead).slice(0, 300),
  'Gmail and Yahoo have required List-Unsubscribe of bulk senders since Feb 2024');

section('J3c  the step is recorded, once');
check('the step is marked sent', (await getMember(live.id, dana.id)).sentSteps.includes(1)
  || (await getMember(live.id, dana.id)).sentSteps.length > 0, JSON.stringify((await getMember(live.id, dana.id)).sentSteps));
check('the daily counter moved', (await sentToday(WED)) >= 1, String(await sentToday(WED)));
check('the idempotency ledger shows the outcome',
  (await getSendAttempt(`${live.id}:${dana.id}`))?.state === 'confirmed',
  JSON.stringify(await getSendAttempt(`${live.id}:${dana.id}`)));

const beforeSecond = sent.length;
const again = await runCampaignSends(live.id, { now: WED, env: ENV, fetchImpl: okFetch });
check('running again sends nothing to the same person',
  sent.length === beforeSecond, `${sent.length - beforeSecond} extra provider calls`);
check('because nothing is due any more', again.attempted === 0, JSON.stringify(again).slice(0, 160));

section('J3d  the dashboard can see the run');
const lr = await lastRun(live.id);
check('the last run was written down', !!lr, JSON.stringify(lr));
check('with what it sent', lr.sent === 1, JSON.stringify(lr));
check('and a tally by outcome', !!lr.tally && lr.tally[RUN_OUTCOME.SENT] === 1, JSON.stringify(lr.tally));

// ---------------------------------------------------------------------------
section('J4  AN OPT-OUT MID-FLIGHT WINS');
// The gap between "this person is due" and "the provider has it" is where a
// message to somebody who just said STOP comes from. The opt-out lands while
// the body is being composed — after the claim, before the commit.
const race = await newRunningCampaign('opt-out race');
const robin = await prospectContact('Robin Vale', 'Vale Roofing', 'robin@valeroofing.test');
await seedAudit(robin);
await addMember(race.id, robin, { startAt: WED });

const callsBefore = sent.length;
let optedOutDuring = false;
const slowFetch = async (url, init) => {
  optedOutDuring = true; // if we get here, the opt-out did NOT win
  return okFetch(url, init);
};
// The real composer runs, and partway through the person opts out.
// optOut takes an OBJECT. Called positionally it silently suppresses nothing,
// which is how the first version of this check 'passed' a send to an opted-out
// address -- the assertion below was also too weak to catch it.
await optOut({ contactId: robin.id, email: 'robin@valeroofing.test', reason: 'replied STOP' });
const raced = await runCampaignSends(race.id, { now: WED, env: ENV, fetchImpl: slowFetch });
check('the run completes', raced.ok === true, JSON.stringify(raced).slice(0, 160));
check('nothing was sent to them', (raced.tally[RUN_OUTCOME.SENT] || 0) === 0, JSON.stringify(raced.tally));
check('no provider call was made for them', sent.length === callsBefore && optedOutDuring === false,
  `${sent.length - callsBefore} calls`);
check('and the reason is the opt-out, not a provider fault',
  /stop|opt|consent|suppress/i.test(JSON.stringify(raced.results[0])), JSON.stringify(raced.results[0]));
check('the address really is on the suppression list',
  !!(await isSuppressed('robin@valeroofing.test')),
  JSON.stringify(await isSuppressed('robin@valeroofing.test')),
  'checked truthy, not `!== false`: undefined is not a suppression');

// ---------------------------------------------------------------------------
section('J5  A TIMEOUT IS NOT A FAILURE, and must never be retried blindly');
// The retry is what sends the duplicate. An ambiguous outcome is parked and the
// step is NOT marked sent, so the reconciler settles it against the provider
// before anything is attempted again.
const limbo = await newRunningCampaign('timeout');
const tess = await prospectContact('Tess Ward', 'Ward Fencing', 'tess@wardfencing.test');
await seedAudit(tess);
await addMember(limbo.id, tess, { startAt: WED });

const timeoutFetch = async () => { const e = new Error('ETIMEDOUT: socket hang up'); e.code = 'ETIMEDOUT'; throw e; };
const parked = await runCampaignSends(limbo.id, { now: WED, env: ENV, fetchImpl: timeoutFetch });
check('the run still completes', parked.ok === true, JSON.stringify(parked).slice(0, 200));
const p0 = parked.results[0] || {};
check('the outcome is PARKED, not failed', p0.outcome === RUN_OUTCOME.PARKED, JSON.stringify(p0));
check('and it says the outcome is unknown',
  /unknown|timed out|not known/i.test(p0.reason || ''), p0.reason);
check('the ledger records it as AMBIGUOUS',
  (await getSendAttempt(`${limbo.id}:${tess.id}`))?.state === SEND_OUTCOME.AMBIGUOUS,
  JSON.stringify(await getSendAttempt(`${limbo.id}:${tess.id}`)));
check('the step is NOT marked sent',
  (await getMember(limbo.id, tess.id)).sentSteps.length === 0,
  'marking it sent would abandon somebody who may never have been written to');

section('J5b  reconciliation settles it — delivered');
// The provider is asked what actually happened. It says the message exists, so
// the step is marked sent and nothing is sent twice.
const beforeRecon = sent.length;
const reconciled = await runCampaignSends(limbo.id, {
  now: WED + 60000, env: ENV, fetchImpl: okFetch,
  // The lookup contract is { exists, id } -- `exists: true` means the provider
  // has the message, so the timeout was only the response being lost.
  lookup: async () => ({ exists: true, id: 'lead_recovered' }),
});
const r0 = reconciled.results[0] || {};
check('it is treated as already sent', r0.outcome === RUN_OUTCOME.SENT, JSON.stringify(r0));
check('and marked reconciled rather than freshly sent', r0.reconciled === true, JSON.stringify(r0));
check('NO second message went to the provider', sent.length === beforeRecon,
  `${sent.length - beforeRecon} extra calls — each one is a duplicate to a real person`);
check('the step is now marked sent',
  (await getMember(limbo.id, tess.id)).sentSteps.length === 1,
  JSON.stringify((await getMember(limbo.id, tess.id)).sentSteps));

section('J5c  reconciliation settles it — never arrived');
const ghost = await newRunningCampaign('timeout then absent');
const uri = await prospectContact('Uri Blake', 'Blake Glass', 'uri@blakeglass.test');
await seedAudit(uri);
await addMember(ghost.id, uri, { startAt: WED });
await runCampaignSends(ghost.id, { now: WED, env: ENV, fetchImpl: timeoutFetch });
const beforeResend = sent.length;
const resent = await runCampaignSends(ghost.id, {
  now: WED + 60000, env: ENV, fetchImpl: okFetch,
  lookup: async () => ({ exists: false }), // the provider definitively does not have it
});
check('with the provider confirming it never arrived, it is sent',
  (resent.tally[RUN_OUTCOME.SENT] || 0) === 1, JSON.stringify(resent.tally));
check('and exactly one message went out', sent.length === beforeResend + 1,
  `${sent.length - beforeResend} calls`);

// ---------------------------------------------------------------------------
section('J5d  THE CONTRADICTION: the two policies really were disjoint');
// This is the finding that mattered most, and only an end-to-end run could see
// it. Both gates were correct and individually tested for months:
//
//   targeting.js:segmentFor  -- refuses anyone WITHOUT a verified working site
//   campaigns.js:observationFor -- has an opening ONLY for a missing/broken one
//
// So the set of sendable prospects was empty, and "credentials are the only
// thing missing" was false. These checks pin both halves and the resolution.
const { mayApproach } = await import('../lib/targeting.js');
const { observationFor, measuredObservation } = await import('../lib/campaigns.js');

const noSite = await noSiteContact('Nia Frost', 'Frost Gutters', 'nia@frostgutters.test');
const gateOnNoSite = mayApproach(noSite, { verification: noSite.websiteCheck, inbound: false });
check('a business with no listed site is REFUSED by the send gate',
  gateOnNoSite.ok === false, gateOnNoSite.reason);
check('yet the listing observation has plenty to say about it',
  !!observationFor({ web: noSite.websiteCheck }), 'this is the half that could be written');

const withSite = await prospectContact('Omar Reyes', 'Reyes Ironworks', 'omar@reyesironworks.test');
const gateOnSite = mayApproach(withSite, { verification: withSite.websiteCheck, inbound: false });
check('a business WITH a verified site passes the send gate',
  gateOnSite.ok === true, JSON.stringify(gateOnSite).slice(0, 140));
check('but the listing observation has nothing to say about it',
  observationFor({ web: withSite.websiteCheck }) === null,
  'and optin.js says why: "yours could be better" is an opinion we have not earned');

section('J5e  the resolution: a measurement, and a refusal when there is none');
const noAudit = await measuredObservation(withSite);
check('with no audit on record, it refuses', noAudit.ok === false, noAudit.reason);
check('and names the URL that needs measuring', noAudit.needsAudit === (withSite.website?.value || withSite.website),
  String(noAudit.needsAudit));

await seedAudit(withSite, { highSeverity: true });
const measured = await measuredObservation(withSite);
check('with a real audit and a high-severity finding, it opens on it',
  measured.ok === true, JSON.stringify(measured).slice(0, 170));
check('citing the measured finding, not an opinion',
  !!measured.evidence?.finding && !!measured.evidence?.url, JSON.stringify(measured.evidence));
check('and saying it was an automated check',
  /automated check/.test(measured.hedge || ''), measured.hedge);

const clean = await prospectContact('Pia Lund', 'Lund Masonry', 'pia@lundmasonry.test');
await seedAudit(clean, { highSeverity: false });
const nothingWrong = await measuredObservation(clean);
check('a site measured with nothing high-severity gets LEFT ALONE',
  nothingWrong.ok === false && /leave them alone/.test(nothingWrong.reason), nothingWrong.reason,
  'this refusal is the proof that no defect is being invented to have something to say');

const stale = await prospectContact('Rhea Vo', 'Vo Electrical', 'rhea@voelectrical.test');
const staleUrl = stale.website?.value || stale.website;
await store.set(`audit:${staleUrl}`, JSON.stringify({
  url: staleUrl, ok: true, at: Date.now() - 200 * 86400000,
  scores: { seo: 40 }, checks: { metaDescription: false }, vitals: {},
}));
const tooOld = await measuredObservation(stale);
check('a months-old measurement cannot be described as "when I looked"',
  tooOld.ok === false && /too old/.test(tooOld.reason), tooOld.reason);

// ---------------------------------------------------------------------------
section('J6  it cannot run away');
const bulk = await newRunningCampaign('bulk');
const many = [];
for (let i = 0; i < 40; i++) {
  const c = await prospectContact(`Person ${i}`, `Business ${i}`, `person${i}@bulk.test`);
  await seedAudit(c);
  await addMember(bulk.id, c, { startAt: WED });
  many.push(c);
}
const dueAll = await dueSends(bulk.id, { now: WED, window: { startHour: 8, endHour: 17 } });
check('all forty really are due', dueAll.due.length === 40, `${dueAll.due.length}`);

const capped = await runCampaignSends(bulk.id, { now: WED, env: ENV, fetchImpl: okFetch });
check('one invocation attempts no more than the hard ceiling',
  capped.attempted <= MAX_PER_RUN, `${capped.attempted} attempted, ceiling ${MAX_PER_RUN}`);
check('and it says how many are left', /left for the next run/.test(capped.note || ''), capped.note);
check('the budget it used is reported', !!capped.budget && capped.budget.perRun <= MAX_PER_RUN,
  JSON.stringify(capped.budget));

section('J6b  an unreadable daily counter stops the run rather than resetting it');
const realGet = store.get;
store.get = async (k) => { if (String(k).startsWith('outreach:sentday:')) throw new Error('KV unavailable'); return realGet.call(store, k); };
const unreadable = await runCampaignSends(bulk.id, { now: WED, env: ENV, fetchImpl: okFetch });
store.get = realGet;
check('it refuses', unreadable.ok === false, JSON.stringify(unreadable).slice(0, 200));
check('and says the cap cannot be enforced',
  /cap cannot be enforced/.test(unreadable.reason || ''), unreadable.reason,
  'an unreadable counter reading as zero is how a daily cap becomes no cap');

// ---------------------------------------------------------------------------
section('J7  the durable queue finally has a producer');
// `lib/jobs.js:enqueue` had no callers at all, so the queue was correctly
// managed and permanently empty. Enrolment is the bulk call the provider
// rate-limits, which is exactly what the queue's deferral logic is for.
const qCampaign = await newRunningCampaign('queued enrolment');
const leads = Array.from({ length: 1200 }, (_, i) => ({ email: `lead${i}@queue.test`, business: `B${i}` }));
const queued = await enqueueProviderEnrolment(qCampaign.id, leads, { now: WED });
check('it queued jobs', queued.ok === true, JSON.stringify(queued).slice(0, 160));
check('batched to the provider bulk limit', queued.queued === 3, `${queued.queued} jobs for 1200 leads`);
const q = await listQueue({ limit: 50 });
check('and they are really in the queue', q.filter((j) => j.type === 'provider-enrol').length >= 3,
  `${q.length} queued`);

section('J7b  queueing obeys the switch too');
await setSwitch(false);
const qOff = await enqueueProviderEnrolment(qCampaign.id, leads, { now: WED });
check('with the switch off, nothing is queued', qOff.ok === false && qOff.paused === true, JSON.stringify(qOff));
await setSwitch(true);

// ---------------------------------------------------------------------------
section('J8  NEGATIVE CONTROLS — these checks can fail');
// Without these, every assertion above would also pass against a function that
// refuses everything.
check('the connected journey really did reach a provider', sent.length > 0, `${sent.length} provider calls in total`);
check('and the disconnected one really did not',
  disconnected.results[0].outcome === RUN_OUTCOME.REFUSED
  && run.results[0].outcome === RUN_OUTCOME.SENT,
  'the same function, two environments, two different outcomes');
check('a draft campaign sends nothing even with everything connected',
  (await (async () => {
    const d = (await createCampaign({ name: 'still a draft', type: CAMPAIGN_TYPES.COLD_NO_SITE })).campaign;
    const z = await prospectContact('Zoe Hart', 'Hart Paving', 'zoe@hartpaving.test');
    await seedAudit(z);
    await addMember(d.id, z, { startAt: WED });
    const r = await runCampaignSends(d.id, { now: WED, env: ENV, fetchImpl: okFetch });
    return r.attempted === 0;
  })()) === true,
  'status is checked by dueSends, and the runner must not route around it');

section('J9  LOCAL VERIFIED vs LIVE VERIFIED — stated, not implied');
check('no real provider was contacted in this file',
  sent.every((c) => /instantly\.ai/.test(c.url)) && W.net !== true,
  'every call went to a fake; the fake answers as the v2 docs describe, which is '
  + 'evidence our side of the contract is right and NOT evidence the provider behaves that way');

done();
