// R12.3 — provider outages.
//
// The queue already knew that a 429 is not a failure: the provider saying "not
// right now" says nothing about whether the work can succeed, so counting it
// against the attempt budget would retire perfectly good jobs during a busy
// hour. That reasoning was written down, implemented, and then **not applied
// to a 503** — which is the same argument with a worse failure, because an
// outage lasts longer than a busy minute and it ends with the work silently
// dead instead of merely delayed.
//
// So this tests three distinctions the queue has to make from a status code:
//
//   429            → not right now. Give the attempt back; honour Retry-After.
//   5xx / 408 / 0  → the provider is broken. Give the attempt back, backoff,
//                    BUT cap it: "give the attempt back" must not mean
//                    "for ever", or a permanently broken provider produces a
//                    job that retries silently and never shows up as a
//                    problem. A dead job is visible; an eternally deferred one
//                    is not.
//   400 / 401 / 403 / 404 / 422 → waiting changes nothing. Stop.
//
// The one that matters most is the cap, because it is the one that trades a
// loud failure for a quiet one if it is missing.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  enqueue, claim, fail, getJob, runOne, throwFromProviderResult, MAX_OUTAGE_DEFERRALS, JOB_STATE,
} from '../lib/jobs.js';

// Every enqueue below passes `runAt: NOW`. Without it the job is queued at the
// WALL clock while everything else runs on this fixed one, so the whole file
// went red three days after it was written — nothing was due, because "now"
// had moved past the fixture. Same class of bug as the retention test that
// searched a timestamp for an area code: a test that depends on today's date
// is a test that is sometimes red for no reason.
const NOW = Date.UTC(2026, 9, 2, 12);

// A loop-local assertion that only reports when it FAILS. Asserting inside a
// 14-round loop would otherwise bury the sections that matter under a wall of
// identical passes — but silently skipping the check would hide a loop that
// never claimed anything, which looks identical to the cap not working.
let loopFailures = 0;
const check0 = (name, cond) => { if (!cond) { loopFailures++; check(name, false); } };

// ---------------------------------------------------------------------------
section('O1  a status code is turned into the right KIND of failure');
const kindOf = (res) => {
  try {
    throwFromProviderResult(res, { what: 'send' });
    return 'did-not-throw';
  } catch (e) {
    if (e.rateLimited) return 'rate-limited';
    if (e.outage) return 'outage';
    if (e.permanent) return 'permanent';
    return 'retryable';
  }
};

check('429 is a rate limit', kindOf({ ok: false, status: 429, error: 'slow down' }) === 'rate-limited');
check('500 is an outage', kindOf({ ok: false, status: 500, error: 'boom' }) === 'outage');
check('502 is an outage', kindOf({ ok: false, status: 502, error: 'bad gateway' }) === 'outage');
check('503 is an outage', kindOf({ ok: false, status: 503, error: 'unavailable' }) === 'outage');
check('504 is an outage', kindOf({ ok: false, status: 504, error: 'gateway timeout' }) === 'outage');
check('408 is an outage', kindOf({ ok: false, status: 408, error: 'request timeout' }) === 'outage');
check('a network error with no status is an outage', kindOf({ ok: false, status: 0, error: 'ECONNRESET', transient: true }) === 'outage');

check('401 is permanent — a rejected key does not improve by waiting', kindOf({ ok: false, status: 401, error: 'bad key' }) === 'permanent');
check('403 is permanent', kindOf({ ok: false, status: 403, error: 'forbidden' }) === 'permanent');
check('404 is permanent', kindOf({ ok: false, status: 404, error: 'no such thing' }) === 'permanent');
check('400 is permanent — retrying an identical malformed request is pointless',
  kindOf({ ok: false, status: 400, error: 'malformed' }) === 'permanent');
check('422 is permanent', kindOf({ ok: false, status: 422, error: 'unprocessable' }) === 'permanent');
check('an ok result is not turned into a throw', throwFromProviderResult({ ok: true, status: 200 }).ok === true);
check('nothing at all is survivable', throwFromProviderResult(null) === null);

// the three kinds must be distinct, or the queue cannot act differently
check('rate limit, outage and permanent are three different answers',
  new Set([
    kindOf({ ok: false, status: 429 }),
    kindOf({ ok: false, status: 503 }),
    kindOf({ ok: false, status: 401 }),
  ]).size === 3);

// ---------------------------------------------------------------------------
section('O2  an outage gives the attempt back — the work survives the outage');
let j = await enqueue({ type: 'outage-send', payload: { to: 'someone' }, maxAttempts: 3, runAt: NOW });
await claim({ worker: 'w', now: NOW, types: ['outage-send'] });
let before = await getJob(j.job.id);
const attemptsAfterClaim = before.attempts;
check('claiming counted an attempt', attemptsAfterClaim >= 1, String(attemptsAfterClaim));

let f = await fail(j.job.id, 'HTTP 503', { now: NOW, outage: true });
check('it is reported as an outage, not a failure', f.outage === true, JSON.stringify(f).slice(0, 160));
check('the attempt was given back', f.attemptsUnchanged === attemptsAfterClaim - 1, `${attemptsAfterClaim} -> ${f.attemptsUnchanged}`);
check('and it waits rather than dying', f.retryIn > 0 && !f.dead, JSON.stringify(f).slice(0, 120));
let job = await getJob(j.job.id);
check('the job is queued again', job.state === JOB_STATE.QUEUED, job.state);
check('the outage is on the record, distinguishable from a rate limit',
  (job.history || []).some((h) => h.event === 'provider-outage'), JSON.stringify(job.history));
check('and NOT recorded as a rate limit, because they are different problems',
  !(job.history || []).some((h) => h.event === 'rate-limited'));

// the thing this exists for: an outage longer than the attempt budget
j = await enqueue({ type: 'outage-long', payload: {}, maxAttempts: 3, runAt: NOW });
for (let i = 0; i < 5; i++) {
  await claim({ worker: 'w', now: NOW + i * 1000, types: ['outage-long'] });
  f = await fail(j.job.id, 'HTTP 503', { now: NOW + i * 1000, outage: true });
}
job = await getJob(j.job.id);
check('five outages do NOT kill a job with three attempts', job.state !== JOB_STATE.DEAD, job.state);
check('which is the whole point: the work survives to be sent when the provider recovers',
  job.state === JOB_STATE.QUEUED, job.state);
check('and the deferrals are counted', job.outageCount === 5, String(job.outageCount));

// and when the provider recovers, the job is still there to run
const ran = await runOne({
  handlers: { 'outage-long': async () => ({ ok: true, sent: true }) },
  worker: 'w',
  now: NOW + 10 * 3600e3,
  types: ['outage-long'],
});
check('once the provider recovers the job runs', ran && ran.ran === true, JSON.stringify(ran).slice(0, 160));
check('and is not reported as having failed', !ran.failed, JSON.stringify(ran).slice(0, 120));

// and the whole thing driven through runOne, which is what the tick calls:
// a handler that hits a 503 must come back as a DEFERRAL, not a failure. If
// runOne reports it as failed, every count the owner sees is wrong — the
// dashboard would show work failing during an outage that is simply waiting.
{
  const viaRunOne = await enqueue({ type: 'outage-runone', payload: {}, maxAttempts: 3, runAt: NOW });
  const out = await runOne({
    handlers: {
      'outage-runone': async () => throwFromProviderResult({ ok: false, status: 503, error: 'unavailable' }, { what: 'send' }),
    },
    worker: 'w',
    now: NOW,
    types: ['outage-runone'],
  });
  check('runOne ran the job', out && out.ran === true, JSON.stringify(out).slice(0, 160));
  check('and reports an outage as a DEFERRAL, not a failure', out.failed === false, JSON.stringify(out).slice(0, 160));
  check('naming it as an outage so the dashboard can say which', out.outage === true, JSON.stringify(out).slice(0, 160));
  check('it is deferred', out.deferred === true, JSON.stringify(out).slice(0, 120));
  check('and the job is not dead', out.dead !== true);
  const jr = await getJob(viaRunOne.job.id);
  check('the job is queued for another go', jr.state === JOB_STATE.QUEUED, jr.state);
  check('with the outage on its history', (jr.history || []).some((h) => h.event === 'provider-outage'), JSON.stringify(jr.history));

  // the contrast: a genuinely permanent failure through the same path
  const permJob = await enqueue({ type: 'perm-runone', payload: {}, maxAttempts: 3, runAt: NOW });
  const permOut = await runOne({
    handlers: {
      'perm-runone': async () => throwFromProviderResult({ ok: false, status: 401, error: 'bad key' }, { what: 'send' }),
    },
    worker: 'w',
    now: NOW,
    types: ['perm-runone'],
  });
  check('a permanent error through runOne IS reported as a failure', permOut.failed === true, JSON.stringify(permOut).slice(0, 160));
  check('and is not called an outage', permOut.outage !== true, JSON.stringify(permOut).slice(0, 120));
  check('and the job is dead', (await getJob(permJob.job.id)).state === JOB_STATE.DEAD);
}

// ---------------------------------------------------------------------------
section('O3  but "give the attempt back" is CAPPED — a broken provider must become visible');
// Without the cap, a provider that 500s for ever produces a job that retries
// silently and never surfaces. A dead job can be seen; an eternally deferred
// one cannot, and that is the worse outcome.
check('the cap exists and is a small number', MAX_OUTAGE_DEFERRALS > 0 && MAX_OUTAGE_DEFERRALS <= 20, String(MAX_OUTAGE_DEFERRALS));

j = await enqueue({ type: 'outage-forever', payload: {}, maxAttempts: 2, runAt: NOW });
let died = false;
// the clock has to move past the backoff each round, or the job is simply not
// due and `claim` returns nothing — which looks exactly like the cap failing
for (let i = 0; i < MAX_OUTAGE_DEFERRALS + 6; i++) {
  const t = NOW + i * 6 * 3600e3; // six hours apart: past any backoff
  const got = await claim({ worker: 'w', now: t, types: ['outage-forever'] });
  check0(`round ${i} claimed the job`, !!got && !!got.job);
  f = await fail(j.job.id, 'HTTP 503', { now: t, outage: true });
  if (f.dead) { died = true; break; }
}
job = await getJob(j.job.id);
check('a permanently broken provider eventually produces a DEAD job', died || job.state === JOB_STATE.DEAD,
  `${job.state}, outageCount ${job.outageCount}`);
check('rather than retrying silently for ever', job.state !== JOB_STATE.QUEUED, job.state);
check('the deferrals stopped at the cap', (job.outageCount || 0) <= MAX_OUTAGE_DEFERRALS, String(job.outageCount));
check('and the reason is on the job', !!job.deadReason, String(job.deadReason));

// ---------------------------------------------------------------------------
section('O4  a permanent failure is NOT given the outage treatment');
j = await enqueue({ type: 'bad-request', payload: {}, maxAttempts: 5, runAt: NOW });
await claim({ worker: 'w', now: NOW, types: ['bad-request'] });
f = await fail(j.job.id, 'HTTP 400 malformed', { now: NOW, permanent: true });
job = await getJob(j.job.id);
check('a permanent failure kills the job immediately', job.state === JOB_STATE.DEAD, job.state);
check('without spending the remaining attempts on an identical request', job.attempts < 5, String(job.attempts));
check('and says it was permanent', /permanent failure/.test(job.deadReason || ''), job.deadReason);
check('it did not record an outage', !(job.history || []).some((h) => h.event === 'provider-outage'));

// ---------------------------------------------------------------------------
section('O5  the send adapter flags an outage, so the queue can tell');
// the gap this closes: the adapter returned `{ok:false, status:503}` with no
// transient flag, so the queue could not distinguish a broken provider from a
// malformed request, and treated both as the job's own fault
const { getEmailAdapter } = await import('../lib/outreach-email.js');
const makeRes = (status) => ({
  ok: status < 400,
  status,
  headers: { get: () => null },
  async text() { return JSON.stringify({ message: `http ${status}` }); },
});
// `createCampaign` is used because it is the simplest call that goes through
// the adapter's shared HTTP path — the status handling under test is in that
// one place, not per endpoint
const adapterFor = (status) =>
  getEmailAdapter({
    env: { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'o.example.invalid' },
    fetchImpl: async () => makeRes(status),
  });
check('the adapter is the connected one, not the disconnected stub',
  adapterFor(200).configured() === true, JSON.stringify(adapterFor(200).name));

for (const [status, expectTransient] of [[503, true], [500, true], [408, true], [400, false], [401, false], [404, false]]) {
  const res = await adapterFor(status)
    .createCampaign({ name: 'probe', schedule: {} })
    .catch((e) => ({ ok: false, thrown: String(e.message) }));
  const flagged = res && res.transient === true;
  check(`a ${status} from the provider is ${expectTransient ? '' : 'NOT '}marked transient`,
    flagged === expectTransient, JSON.stringify(res).slice(0, 160));
  // and the queue turns that into the right kind
  const kind = kindOf(res);
  check(`so the queue treats a ${status} as ${expectTransient ? 'an outage' : 'permanent'}`,
    expectTransient ? kind === 'outage' : kind === 'permanent', `${status} -> ${kind}`);
}

await store.set('jobs:queue', '').catch(() => {});
done();
