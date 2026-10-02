// R12.6 — the soak PROCEDURE, and the guarantee that seven days cannot be
// claimed before they elapse.
//
// This requirement is unusual: the deliverable is not a passing soak, it is a
// procedure plus the thing that stops the soak being claimed early. So what is
// tested here is the refusal. The failure this prevents is not a technical one
// — it is somebody, realistically me, running an accelerated week, seeing
// green, and writing "soak complete" in the plan.
//
// R12.5 simulates a week and says so. This refuses to pretend.
import { check, section, done } from './world.mjs';
import { windowStatus, coverage, observe } from './soak.mjs';

const DAY = 24 * 3600e3;
const START = Date.UTC(2026, 9, 1, 9, 0);
const started = (over = {}) => ({ startedAt: START, startedBy: 'owner', observations: [], ...over });

// ---------------------------------------------------------------------------
section('K1  seven days cannot be claimed before seven days have passed');
check('with no window at all, nothing is complete', windowStatus(null).complete === false);
check('and it says it never started', windowStatus(null).verdict === 'NOT_STARTED');

for (const d of [0, 1, 3, 6, 6.99]) {
  const w = windowStatus(started(), START + d * DAY);
  check(`at ${d} days the soak is NOT complete`, w.complete === false, JSON.stringify(w));
  check(`and the verdict at ${d} days is NOT_YET`, w.verdict === 'NOT_YET', w.verdict);
}
const atSeven = windowStatus(started(), START + 7 * DAY);
check('at exactly seven days it is complete', atSeven.complete === true, JSON.stringify(atSeven));
check('and only then does the verdict change', atSeven.verdict === 'ELAPSED');
check('later still is also complete', windowStatus(started(), START + 30 * DAY).complete === true);

// the remaining time is reported honestly, so nobody has to guess
const mid = windowStatus(started(), START + 2.5 * DAY);
check('it reports how much is left', Math.abs(mid.remainingDays - 4.5) < 0.01, String(mid.remainingDays));
check('and how much has passed', Math.abs(mid.elapsedDays - 2.5) < 0.01, String(mid.elapsedDays));

// ---------------------------------------------------------------------------
section('K2  the clock is the wall clock, and there is no way to shorten it');
// the only input to completeness is elapsed real time; nothing in the state
// can be set to make it finish early
const tampered = windowStatus({ startedAt: START, complete: true, verdict: 'ELAPSED', elapsedDays: 99, observations: [] }, START + DAY);
check('a state claiming to be complete is still NOT complete', tampered.complete === false, JSON.stringify(tampered));
check('because completeness is computed, not read', tampered.verdict === 'NOT_YET');

// a start time in the FUTURE must not read as negative progress or wrap round
const future = windowStatus({ startedAt: START + 10 * DAY, observations: [] }, START);
check('a future start is not complete', future.complete === false);
check('and does not report negative elapsed time', future.elapsedMs >= 0, String(future.elapsedMs));

// ---------------------------------------------------------------------------
section('K3  seven days of nobody looking is a delay, not a soak');
const sevenDaysSilent = coverage(started(), START + 7 * DAY);
check('a window with no observations is not covered', sevenDaysSilent.ok === false, JSON.stringify(sevenDaysSilent));
check('and it names every day that was missed', sevenDaysSilent.gaps.length === 7, JSON.stringify(sevenDaysSilent.gaps));

const daily = started({ observations: Array.from({ length: 7 }, (_, d) => ({ at: START + d * DAY + 3600e3, problems: [] })) });
const full = coverage(daily, START + 7 * DAY);
check('a window observed every day is covered', full.ok === true, JSON.stringify(full));
check('all seven days counted', full.covered === 7, String(full.covered));

const missedDay4 = started({
  observations: [0, 1, 2, 4, 5, 6].map((d) => ({ at: START + d * DAY + 3600e3, problems: [] })),
});
const partial = coverage(missedDay4, START + 7 * DAY);
check('one missed day is reported', partial.ok === false, JSON.stringify(partial));
check('and named specifically', partial.gaps.join(',') === '4', JSON.stringify(partial.gaps));

// two observations on one day do not cover two days
const doubledUp = started({ observations: [{ at: START + 3600e3, problems: [] }, { at: START + 7200e3, problems: [] }] });
const dbl = coverage(doubledUp, START + 2 * DAY);
check('two looks on one day cover one day, not two', dbl.covered === 1, JSON.stringify(dbl));

// ---------------------------------------------------------------------------
section('K4  an observation that observed nothing says so');
// the quietest way for a soak to be worthless: the script runs daily, reaches
// nothing, and records a clean row
const nowhere = await observe({ origin: '' });
check('with no target, it does not record a clean observation', (nowhere.problems || []).length > 0,
  JSON.stringify(nowhere));
check('and says plainly that nothing was observed', /this is not an observation/.test(nowhere.problems.join(' ')),
  nowhere.problems.join(' '));

// a target that cannot be reached is a problem, not a pass
const unreachable = await observe({ origin: 'http://127.0.0.1:1' });
check('an unreachable target is recorded as a problem', (unreachable.problems || []).length > 0,
  JSON.stringify(unreachable).slice(0, 200));
check('and the health check is not reported as ok', unreachable.checks.health.ok !== true,
  JSON.stringify(unreachable.checks.health));

// ---------------------------------------------------------------------------
section('K5  a real observation, against a real server');
// the observation path has to work, or the procedure is a document about a
// script that does nothing
process.env.CRON_SECRET = process.env.CRON_SECRET || 'soak-test-secret';
const { startLocalApi } = await import('./harness/local-api.mjs');
const api = await startLocalApi();
const real = await observe({ origin: api.origin });
await api.stop();

check('it reached the health endpoint', real.checks.health.status === 200, JSON.stringify(real.checks.health));
check('and read the worker check-ins', Array.isArray(real.checks.workers), JSON.stringify(real.checks.workers).slice(0, 160));
check('a stalled or never-run worker would be reported', (() => {
  // the fixture here has never actually run anything, so this SHOULD complain
  return (real.problems || []).some((p) => /stalled|never|no worker check-ins/.test(p));
})(), JSON.stringify(real.problems));

// ---------------------------------------------------------------------------
section('K6  the procedure is written down, not just implied');
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const SOAK_MD = fileURLToPath(new URL('../SOAK.md', import.meta.url));
check('the procedure document exists', existsSync(SOAK_MD), SOAK_MD);
const doc = existsSync(SOAK_MD) ? readFileSync(SOAK_MD, 'utf8') : '';
check('it says how to start a window', /soak\.mjs start/.test(doc));
check('and how to take the daily observation', /soak\.mjs check/.test(doc));
check('it states what counts as an abort', /abort/i.test(doc));
check('it states that seven days means seven REAL days', /real days/i.test(doc));
check('and that a simulation is a different claim', /R12\.5|simulat/i.test(doc));
check('it names what is watched each day', /worker|check-in/i.test(doc));

done();
