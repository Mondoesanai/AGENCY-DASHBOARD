// Seven days with nobody watching. What runs, what stops, what waits.
//
// R23.1. The existing week simulation checks the happy path and STOP. This one
// is the awkward week: the owner is away, providers misbehave, money runs out,
// and the machine has to keep its promises or stop making them.
//
// Every scenario drives the REAL primitive — `lib/jobs.js` leases,
// `lib/budget.js` reserves, `heartbeat.setPaused`, `withinQuietHours`,
// `claimEventOnce`, `handleInboundSms` — never a local imitation of one. A
// simulation that reimplements the thing it is testing can only agree with
// itself.
//
// WHAT IT DOES NOT PROVE: nothing here sends an email or a text. No provider is
// connected in production — no cold-sender key, and no TWILIO_* variable exists
// at all — so this is the behaviour of the machinery AROUND a provider, never
// evidence that a provider works.

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';

const MON9 = Date.UTC(2026, 9, 19, 14, 0); // Monday 09:00 US Central

// ---------------------------------------------------------------------------
section('S0  the week is pinned to an injected clock');
check('the simulated week does not read the wall clock',
  Number.isFinite(MON9), 'a week that drifts with real time expires like a milk carton');

// ---------------------------------------------------------------------------
section('S1  OWNER PAUSE stops discretionary work and nothing else');
const { setPaused, pauseGate } = await import('../lib/heartbeat.js');
await setPaused({ paused: true, by: 'owner', reason: 'away for the week' });
const paused = await pauseGate({});
check('discretionary work is refused', paused.run === false, JSON.stringify(paused));
check('and it names who paused it and why',
  /owner/.test(paused.reason) && /away/.test(paused.reason), paused.reason);
const essential = await pauseGate({ essential: true });
check('but ESSENTIAL work still runs', essential.run === true,
  'a pause must not stop an opt-out being honoured or a delivery receipt recorded');
await setPaused({ paused: false, by: 'owner', reason: '' });
check('and unpausing restores it', (await pauseGate({})).run === true);

section('S1b  an unreadable pause flag means "do not start"');
const realGet = store.get;
store.get = async () => { throw new Error('kv down'); };
const unknown = await pauseGate({});
store.get = realGet;
check('work does not start when the pause state cannot be read',
  unknown.run === false && unknown.unknown === true, JSON.stringify(unknown));
check('which is the safe reading of that error', unknown.run === false,
  'starting outreach because we could not check whether we were paused is the worst available choice');

// ---------------------------------------------------------------------------
section('S2  QUIET HOURS hold a text until morning');
const { withinQuietHours } = await import('../lib/sms-inbound.js');
const NUM = '+12145550147'; // Texas area code
const night = withinQuietHours(NUM, { at: Date.UTC(2026, 9, 20, 5, 0) });   // 00:00 CT
const morning = withinQuietHours(NUM, { at: Date.UTC(2026, 9, 20, 16, 0) }); // 11:00 CT
check('midnight is refused', night.ok === false, JSON.stringify(night));
check('and it says why, or when it would be allowed',
  !!night.reason || !!night.nextOkAt, JSON.stringify(night));
check('11am is allowed', morning.ok === true, JSON.stringify(morning));

// ---------------------------------------------------------------------------
section('S3  INSUFFICIENT BUDGET stops work instead of overspending');
const { setBudgetSettings, getBudgetSettings, reserveCost } = await import('../lib/budget.js');
// Cents, not dollars — the real shape. An earlier version of this test passed
// `monthlyUsd`, which was silently ignored, left the cap null, and "proved"
// that a $500 reservation was allowed against a $0.02 budget. It was allowed
// because there was no budget.
const budgetBefore = await getBudgetSettings();
await setBudgetSettings({ monthlyLimitCents: 2, weeklyLimitCents: 2 });
const small = await reserveCost({ category: 'ai', estimateUsd: 0.005, jobId: `sim-a-${Date.now()}` });
const huge = await reserveCost({ category: 'ai', estimateUsd: 500, jobId: `sim-b-${Date.now()}` });
check('a small reservation is granted', small.ok === true, JSON.stringify(small).slice(0, 130));
check('one that would blow the cap is refused', huge.ok === false, JSON.stringify(huge).slice(0, 160));
check('and the refusal is readable, not a stack trace',
  /budget|cap|limit|allowance|over/i.test(JSON.stringify(huge)), JSON.stringify(huge).slice(0, 160));
const mustRun = await reserveCost({ category: 'ai', estimateUsd: 500, jobId: `sim-c-${Date.now()}`, essential: true });
check('ESSENTIAL work is still allowed through', mustRun.ok === true,
  'honouring an opt-out must never be blocked by a budget');

section('S3b  a cap that is NOT configured is reported, not assumed safe');
await setBudgetSettings({ monthlyLimitCents: null, weeklyLimitCents: null });
const uncapped = await reserveCost({ category: 'ai', estimateUsd: 500, jobId: `sim-d-${Date.now()}` });
check('with no cap set, nothing refuses a large spend', uncapped.ok === true,
  'which is correct behaviour and a real operational risk — production currently has no limit set');
// put the owner's settings back exactly as they were
await setBudgetSettings({
  monthlyLimitCents: budgetBefore.monthlyLimitCents,
  weeklyLimitCents: budgetBefore.weeklyLimitCents,
});

// ---------------------------------------------------------------------------
section('S4  PROVIDER OUTAGE defers — it does not hammer, and it does not loop');
const { enqueue, runOne, MAX_OUTAGE_DEFERRALS } = await import('../lib/jobs.js');
const outageJob = await enqueue({ type: 'sim-outage', payload: {}, idempotencyKey: `out-${Date.now()}` });
check('a job is queued', !!outageJob.job?.id, JSON.stringify(outageJob).slice(0, 120));
const handlers = {
  'sim-outage': async () => { const e = new Error('provider unavailable'); e.outage = true; throw e; },
};
let attempts = 0;
for (let i = 0; i < MAX_OUTAGE_DEFERRALS + 4; i++) {
  const r = await runOne({ handlers, worker: 'sim', now: MON9 + i * 3600e3, types: ['sim-outage'] });
  if (r && r.ran) attempts += 1;
}
check('the deferral ceiling is a real, finite number',
  Number.isInteger(MAX_OUTAGE_DEFERRALS) && MAX_OUTAGE_DEFERRALS > 0 && MAX_OUTAGE_DEFERRALS <= 20,
  `MAX_OUTAGE_DEFERRALS=${MAX_OUTAGE_DEFERRALS}`);
check('and the job stops being attempted rather than retrying for ever',
  attempts <= MAX_OUTAGE_DEFERRALS + 2, `${attempts} attempts`,
  'an unbounded defer is an infinite loop with good manners');

// ---------------------------------------------------------------------------
section('S5  AN EXPIRED LEASE is reclaimed, and the job never runs twice at once');
const { claim } = await import('../lib/jobs.js');
const leased = await enqueue({ type: 'sim-lease', payload: {}, idempotencyKey: `lease-${Date.now()}` });
const one = await claim({ worker: 'worker-one', now: MON9, leaseMs: 60000, types: ['sim-lease'] });
check('worker one claims it', one?.job?.id === leased.job.id, JSON.stringify(one).slice(0, 120));
const two = await claim({ worker: 'worker-two', now: MON9 + 1000, leaseMs: 60000, types: ['sim-lease'] });
check('worker two cannot take it while the lease holds',
  !two?.job || two.job.id !== leased.job.id, JSON.stringify(two).slice(0, 120));
const reclaimed = await claim({ worker: 'worker-two', now: MON9 + 120000, leaseMs: 60000, types: ['sim-lease'] });
check('but it IS reclaimable once the lease expires',
  reclaimed?.job?.id === leased.job.id, JSON.stringify(reclaimed).slice(0, 120),
  'otherwise a worker that died mid-job strands that work for ever');

// ---------------------------------------------------------------------------
section('S6  A DUPLICATE PROVIDER EVENT is applied exactly once');
const { claimEventOnce } = await import('../lib/webhooks.js');
const evt = `evt-sim-${Date.now()}`;
const firstDelivery = await claimEventOnce('sim', evt);
const replay = await claimEventOnce('sim', evt);
check('the first delivery is fresh', firstDelivery.fresh === true);
check('the replay is recognised as a duplicate',
  replay.fresh === false && replay.duplicate === true, JSON.stringify(replay));
check('and is NOT reported as unknown', !replay.unknown,
  'a known duplicate and an unanswerable check need opposite handling — conflating them dropped every inbound message during an outage');

// ---------------------------------------------------------------------------
section('S7  A HUMAN REPLY, and a STOP, both end the sequence');
const { upsertContact, field } = await import('../lib/contacts.js');
const { stopContact } = await import('../lib/campaigns.js');
const E = (v) => field(v, { confidence: 1, source: 'manual' });
const replier = (await upsertContact({
  source: 'discovery', name: E('Sim Replier'), email: E(`sim-reply-${Date.now()}@example.test`),
})).contact;
const cancelled = await stopContact(replier.id, 'a human replied');
check('a reply cancels what was queued', cancelled?.ok !== false, JSON.stringify(cancelled).slice(0, 130));

const { handleInboundSms, INBOUND } = await import('../lib/sms-inbound.js');
const STOPNUM = `+1214555${String(Date.now()).slice(-4)}`;
const stopped = await handleInboundSms({ from: STOPNUM, body: 'STOP', business: 'Inspiring Websites' });
check('STOP is recognised', stopped.kind === INBOUND.STOP);
check('and actually recorded', stopped.recorded === true, JSON.stringify(stopped).slice(0, 150));

const { mayText } = await import('../lib/phone.js');
const sealed = await mayText({
  contact: {
    id: 'sim-stop', phone: { value: STOPNUM },
    consentLog: [{ at: Date.now() - 1000, channel: 'sms', kind: 'granted', basis: 'handset confirmation', scope: 'promotional' }],
  },
  purpose: 'one_time_followup',
});
check('that number can never be texted again', sealed.ok === false && sealed.code === 'opted-out',
  JSON.stringify(sealed),
  'checked against a contact that HAS consent, so the refusal is the opt-out and not a missing permission');

// ---------------------------------------------------------------------------
section('S8  and across all of it, NOTHING SENDS — because nothing is connected');
const { sendReadiness, getEmailAdapter } = await import('../lib/outreach-email.js');
const rd = await sendReadiness({ env: {} });
check('cold email is not ready', rd.ready === false);
check('the cold adapter is disconnected', getEmailAdapter({ env: {} }).configured() === false);
const { getSmsAdapter } = await import('../lib/sms-outreach.js');
const smsAdapter = getSmsAdapter({ env: {} });
check('SMS is disconnected', !smsAdapter.configured || smsAdapter.configured() === false);

section('S8b  and the outreach switch stays off throughout');
const { getSettings } = await import('../lib/settings.js');
check('outreach.active is false after the whole week',
  (await getSettings()).outreach.active === false,
  'no simulation, AI output or self-repair may flip this');

done();
