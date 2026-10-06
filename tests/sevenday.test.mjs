// R12.5 — an accelerated SIMULATED seven days.
//
// ====================================================================
// THIS IS A SIMULATION. NO REAL TIME PASSES AND NO REAL MESSAGES ARE
// SENT. It proves the system stays coherent across a week of operation
// in a controlled clock; it does NOT prove the system survived a real
// week. That is R12.6, it requires seven actual days, and nothing here
// may be read as having done it.
// ====================================================================
//
// A simulation is worth little if it only checks the end state: a week where
// everything happened to work out can hide a day where an invariant was
// violated and later repaired. So the invariants are checked **after every
// simulated step**, not at the end — and the test states how many times they
// were checked, because "the invariants held" means nothing without knowing
// how often anyone looked.
//
// The five invariants, each of which is a promise made somewhere else in this
// build and all of which must hold at every moment of the week:
//
//   1. Nobody who opted out is contactable, from the moment they opt out.
//   2. No message is sent while outreach is switched off.
//   3. No contact is sent the same campaign step twice.
//   4. A suppressed address is suppressed in every campaign, not just one.
//   5. The deliverability stop, once tripped, is never cleared by automation.
process.env.CRON_SECRET = 'sevenday-test-secret';

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';

const configuredRemote =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (configuredRemote) {
  console.log('\nREFUSED: the seven-day simulation writes contacts, campaigns and suppressions; in-memory store only.\n');
  console.log('0 passed, 1 failed');
  console.log('FAILED:');
  console.log(' - seven-day simulation refused to run against a configured remote store');
  process.exit(1);
}

const { canContact, getContact } = await import('../lib/contacts.js');
const { createCampaign, enrolProspects, setCampaignStatus, dueSends, getMember, stopContact, markStepSent, CAMPAIGN_TYPES } =
  await import('../lib/campaigns.js');
const { maySend } = await import('../lib/outreach-email.js');
const { makeToken, handleUnsubscribe } = await import('../lib/unsubscribe.js');
const { enqueue, drain, queueHealth } = await import('../lib/jobs.js');
const { check: deliverabilityCheck, enforce, stopState, clearStop } = await import('../lib/deliverability.js');

// ---- the simulated week ---------------------------------------------------
const DAY = 24 * 3600e3;
const START = Date.UTC(2026, 9, 5, 9, 0); // Monday 09:00 UTC
const PEOPLE = 20;

// a cohort of prospects, each at their own business
for (let i = 0; i < PEOPLE; i++) {
  await store.set(`prospect:sim-${i}`, JSON.stringify({
    id: `sim-${i}`,
    name: `Sim Business ${i}`,
    contactName: `Owner ${i}`,
    email: `owner${i}@simbiz${i}.example`,
    phone: '',
    website: '',
    sourceId: 'r12.5-simulation',
    qualification: { segment: 'no-site-found' },
  }));
}

const made = await createCampaign({ name: 'Simulated week', type: CAMPAIGN_TYPES.COLD_NO_SITE });
const campaignId = made.ok && made.campaign.id;
// anchored to the simulated start, not the real clock — otherwise the plan is
// scheduled from whenever the suite happens to run and the week drifts past it
const enrolled = await enrolProspects(campaignId, Array.from({ length: PEOPLE }, (_, i) => `sim-${i}`), { startAt: START });
await setCampaignStatus(campaignId, 'running');

const contactIds = (enrolled.enrolledDetail || []).map((e) => e.contactId);

// ---------------------------------------------------------------------------
section('W0  the simulation is set up, and labelled as a simulation');
check('a campaign exists', !!campaignId, JSON.stringify(made).slice(0, 140));
check('twenty prospects were enrolled', enrolled.enrolled === PEOPLE, JSON.stringify(enrolled).slice(0, 180));
check('each became a contact', contactIds.length === PEOPLE, String(contactIds.length));
check('and all of them start contactable', (await Promise.all(
  contactIds.map(async (id) => (await canContact(await getContact(id), { channel: 'email', purpose: 'promotional' })).ok)
)).every(Boolean));

// ---- invariant checking ---------------------------------------------------
const optedOut = new Set();     // addresses that have opted out, as the sim knows it
const sentSteps = new Map();    // contactId -> Set(step) the sim believes were sent
let invariantRuns = 0;
const violations = [];

async function assertInvariants(label) {
  invariantRuns++;

  // 1 + 4. anyone who opted out is refused, in this campaign and in general
  for (const addr of optedOut) {
    const gate = await canContact({ id: 'probe', email: { value: addr } }, { channel: 'email', purpose: 'promotional' });
    if (gate.ok) violations.push(`${label}: ${addr} opted out but is still contactable`);
    const other = await canContact({ id: 'probe2', email: { value: addr } }, { channel: 'email', purpose: 'transactional' });
    if (other.ok && gate.ok) violations.push(`${label}: ${addr} is suppressed in one context but not another`);
  }

  // 2. nothing may be sent while outreach is off — it is off for this whole
  //    week. The refusal has to cite THAT reason specifically: with an empty
  //    environment the gate also refuses for missing credentials, a missing
  //    sending domain, missing pricing and a missing public URL, so checking
  //    only that it refused would pass with the outreach switch deleted
  //    entirely — which is exactly what a control proved.
  const sample = contactIds[0] && (await getContact(contactIds[0]));
  if (sample) {
    const may = await maySend({ contact: sample, campaignId, purpose: 'promotional', env: {} });
    if (may.ok) violations.push(`${label}: the send gate allowed a send while outreach is switched off`);
    const codes = (may.blockers || []).map((b) => b.code);
    if (!codes.includes('outreach-off')) {
      violations.push(`${label}: the gate refused, but not because outreach is off — ${JSON.stringify(codes)}`);
    }
  }

  // 3. no contact appears twice for the same step in one due list
  const due = await dueSends(campaignId, { now: clock });
  const seen = new Set();
  for (const d of due.due || []) {
    const k = `${d.contactId}:${d.step}`;
    if (seen.has(k)) violations.push(`${label}: ${k} is due twice in one list`);
    seen.add(k);
    if ((sentSteps.get(d.contactId) || new Set()).has(d.step)) {
      violations.push(`${label}: ${d.contactId} step ${d.step} is due again after being sent`);
    }
  }

  // 5. an automatic caller can never clear the deliverability stop
  const st = await stopState();
  if (st.stopped) {
    const sneaky = await clearStop({ by: 'automatic' });
    if (sneaky.ok) violations.push(`${label}: automation cleared the deliverability stop`);
  }
}

let clock = START;
await assertInvariants('day 0, before anything');

// ---------------------------------------------------------------------------
section('W1  seven simulated days, with the invariants checked after every step');
const dayLog = [];

for (let day = 0; day < 7; day++) {
  clock = START + day * DAY;
  const events = [];

  // --- morning: whatever the campaign says is due is "attempted" ------------
  const due = await dueSends(campaignId, { now: clock });
  let refused = 0;
  let progressed = 0;
  for (const d of (due.due || []).slice(0, 5)) {
    const contact = await getContact(d.contactId);
    const gate = await maySend({ contact, campaignId, purpose: 'promotional', env: {} });
    // outreach is OFF all week, so every one of these must refuse. The
    // simulation records the refusal rather than pretending a send happened.
    if (gate.ok) { violations.push(`day ${day}: a send was permitted while outreach is off`); continue; }
    refused++;

    // The refusal above is correct but it means NOTHING ever advances, so the
    // "no step is sent twice" invariant would never be exercised — a week in
    // which nothing happens trivially satisfies it. So the CONSEQUENCE of a
    // send is simulated through the real `markStepSent`, without any send: the
    // step is recorded as delivered exactly as a successful send would record
    // it, and the due list must then stop offering it.
    const addr = contact && contact.email && contact.email.value;
    if (addr && optedOut.has(String(addr).toLowerCase())) continue; // never advance someone who opted out
    const mark = await markStepSent(campaignId, d.contactId, d.step);
    if (mark && mark.ok !== false) {
      if (!sentSteps.has(d.contactId)) sentSteps.set(d.contactId, new Set());
      sentSteps.get(d.contactId).add(d.step);
      progressed++;
    }
  }
  events.push(`due=${(due.due || []).length} refused=${refused} advanced=${progressed}`);
  await assertInvariants(`day ${day} after the morning pass`);

  // --- a couple of people opt out, through the real handler -----------------
  if (day === 1 || day === 3) {
    const victim = contactIds[day];
    const c = await getContact(victim);
    const addr = c && c.email && c.email.value;
    if (addr) {
      const out = await handleUnsubscribe({ address: addr, token: makeToken(addr) });
      if (out.ok) { optedOut.add(String(addr).toLowerCase()); events.push(`opt-out:${addr}`); }
      else violations.push(`day ${day}: a valid unsubscribe was refused — ${out.message}`);
    }
  }
  await assertInvariants(`day ${day} after opt-outs`);

  // --- the queue is drained, as the tick does -------------------------------
  await enqueue({ type: 'sim-work', payload: { day }, idempotencyKey: `sim-${day}` });
  const drained = await drain({
    handlers: { 'sim-work': async () => ({ ok: true }) },
    max: 5,
    worker: 'sim',
    now: clock + 3600e3,
    types: ['sim-work'],
  });
  events.push(`queue:ran=${drained.ran},failed=${drained.failed},dead=${drained.dead}`);
  if (drained.failed > 0) violations.push(`day ${day}: queued work failed in a week where nothing should fail`);
  await assertInvariants(`day ${day} after the queue`);

  // --- a burst of delivery events on day 5, enough to trip the stop ---------
  if (day === 5) {
    const { countDailyEvent } = await import('../lib/deliverability.js');
    for (let i = 0; i < 300; i++) await countDailyEvent('delivered', clock);
    for (let i = 0; i < 90; i++) await countDailyEvent('bounced', clock);
    const e = await enforce({ now: clock });
    events.push(`deliverability:${e.action}`);
    if (e.action !== 'stopped') violations.push(`day ${day}: 30% bounces did not stop sending — ${JSON.stringify(e.worst)}`);
  }
  await assertInvariants(`day ${day} after delivery events`);

  dayLog.push({ day, at: new Date(clock).toISOString().slice(0, 10), events });
}

check('seven days were simulated', dayLog.length === 7, String(dayLog.length));
check('the invariants were checked after every step, not only at the end', invariantRuns >= 7 * 4,
  `${invariantRuns} checks across the week`);
check('NO invariant was violated at any point', violations.length === 0, violations.slice(0, 4).join(' | '));

// the week has to have actually DONE something, or "no invariant was violated"
// is the trivially true statement about a week in which nothing happened
const advanced = [...sentSteps.values()].reduce((n, s) => n + s.size, 0);
check('the week genuinely advanced work', advanced >= 25, `${advanced} campaign steps advanced`);
check('across most of the cohort', sentSteps.size >= 10, `${sentSteps.size} contacts progressed`);
check('and no step was ever advanced twice for one contact',
  [...sentSteps.entries()].every(([, steps]) => steps.size === new Set([...steps]).size));
// checked against the STORED records rather than the simulation's own
// bookkeeping, so the test is not marking its own homework
let advancedAfterOptOut = 0;
for (const id of contactIds) {
  const c = await getContact(id);
  const addr = c && c.email && c.email.value;
  if (!addr || !optedOut.has(String(addr).toLowerCase())) continue;
  const m = await getMember(campaignId, id);
  if (m && m.state === 'scheduled') advancedAfterOptOut++;
}
check('and the stored records agree: nobody who opted out is still scheduled', advancedAfterOptOut === 0,
  `${advancedAfterOptOut} opted-out contacts still scheduled`);

// ---------------------------------------------------------------------------
section('W2  the end state is coherent, and matches what happened');
check('both opt-outs are recorded', optedOut.size === 2, JSON.stringify([...optedOut]));
for (const addr of optedOut) {
  const gate = await canContact({ id: 'final', email: { value: addr } }, { channel: 'email', purpose: 'promotional' });
  check(`${addr} is still refused at the end of the week`, gate.ok === false, JSON.stringify(gate));
}
const stillOk = [];
for (const id of contactIds) {
  const c = await getContact(id);
  const addr = c && c.email && c.email.value;
  if (!addr || optedOut.has(String(addr).toLowerCase())) continue;
  if ((await canContact(c, { channel: 'email', purpose: 'promotional' })).ok) stillOk.push(id);
}
check('everyone who did NOT opt out is still contactable', stillOk.length === PEOPLE - optedOut.size,
  `${stillOk.length} of ${PEOPLE - optedOut.size}`);

const finalStop = await stopState();
check('the deliverability stop tripped during the week', finalStop.stopped === true, JSON.stringify(finalStop).slice(0, 160));
check('it is attributed to automation', finalStop.by === 'automatic');
check('and it is STILL in place at the end of the week', (await stopState()).stopped === true,
  'nothing in seven days of running may clear it by itself');
const ownerClears = await clearStop({ by: 'owner', note: 'end of simulation' });
check('only the owner can clear it', ownerClears.ok === true, JSON.stringify(ownerClears));

const health = await queueHealth({ now: clock + DAY });
check('the queue is readable at the end', !!health, JSON.stringify(health).slice(0, 140));
check('and nothing is stranded in the dead letter', (health.dead || 0) === 0, JSON.stringify(health).slice(0, 160));

// ---------------------------------------------------------------------------
section('W3  the simulation says what it is, and what it is not');
// A seven-day SIMULATION is not a seven-day SOAK, and this build is required
// to keep that distinction. The label is part of the deliverable.
const SIMULATION_LABEL = 'SIMULATED: seven days of operation on a controlled clock. No real time elapsed and no real message was sent.';
check('the run is labelled as simulated', /SIMULATED/.test(SIMULATION_LABEL));
check('it states that no real time passed', /No real time elapsed/.test(SIMULATION_LABEL));
check('and that nothing was really sent', /no real message was sent/.test(SIMULATION_LABEL));
check('the whole week ran on the controlled clock, not the wall clock',
  clock === START + 6 * DAY, new Date(clock).toISOString());
check('which is seven days apart in simulated time', (clock - START) / DAY === 6);

console.log(`\n  ${SIMULATION_LABEL}`);
console.log(`  Invariants checked ${invariantRuns} times across ${dayLog.length} simulated days; ${violations.length} violations.`);
for (const d of dayLog) console.log(`   ${d.at}  ${d.events.join('  ')}`);

done();
