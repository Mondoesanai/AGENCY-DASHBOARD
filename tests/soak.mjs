// R12.6 — the real seven-day staging soak: the PROCEDURE, and the thing that
// stops anyone claiming it before seven real days have passed.
//
// WHY THIS IS A SCRIPT AND NOT JUST A DOCUMENT.
//
// A soak is the one check in this plan that cannot be accelerated. R12.5
// simulates a week on a controlled clock and is honest about being a
// simulation; this is the opposite — it refuses to move faster than real time,
// because the whole value of a soak is the things that only appear over real
// days: a scheduler that quietly stops at 3am, a lease that never expires, a
// token that expires on day six, memory that creeps, a cron that fires twice
// on a daylight-saving boundary.
//
// The failure mode this guards against is not technical. It is someone — me —
// running seven simulated days, seeing green, and writing "soak complete" in a
// plan. So the elapsed time comes from the wall clock, the start is recorded
// once and cannot be moved forward, and the verdict is NOT_YET until the
// seventh day genuinely arrives.
//
//   node tests/soak.mjs start     record the start of a soak window
//   node tests/soak.mjs check     take a daily observation
//   node tests/soak.mjs status    where the window stands, honestly
//
// Nothing here starts, stops or changes the system under test. It observes.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE = join(ROOT, '.soak', 'state.json');
const SOAK_DAYS = 7;
const DAY_MS = 24 * 3600 * 1000;

const read = () => {
  if (!existsSync(STATE)) return null;
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return null; }
};
const write = (s) => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
};

/**
 * How far through the window we are, from the WALL CLOCK.
 *
 * `complete` is the only thing that may be reported as a finished soak, and it
 * is false until seven real days have elapsed. There is deliberately no flag,
 * environment variable or argument that shortens this.
 */
export function windowStatus(state, now = Date.now()) {
  if (!state || !state.startedAt) {
    return { started: false, complete: false, verdict: 'NOT_STARTED', elapsedMs: 0, remainingMs: SOAK_DAYS * DAY_MS };
  }
  const elapsedMs = Math.max(0, now - state.startedAt);
  const remainingMs = Math.max(0, SOAK_DAYS * DAY_MS - elapsedMs);
  const complete = elapsedMs >= SOAK_DAYS * DAY_MS;
  return {
    started: true,
    complete,
    verdict: complete ? 'ELAPSED' : 'NOT_YET',
    elapsedMs,
    remainingMs,
    elapsedDays: +(elapsedMs / DAY_MS).toFixed(2),
    remainingDays: +(remainingMs / DAY_MS).toFixed(2),
    observations: (state.observations || []).length,
  };
}

/**
 * Did the soak actually get WATCHED, as opposed to merely waited out?
 *
 * Seven days of nobody looking is not a soak, it is a delay. The procedure
 * asks for one observation per day, and a window with gaps says so rather than
 * reporting a clean pass.
 */
export function coverage(state, now = Date.now()) {
  const obs = (state && state.observations) || [];
  if (!state || !state.startedAt) return { days: 0, covered: 0, gaps: [], ok: false };
  const elapsedDays = Math.min(SOAK_DAYS, Math.floor((now - state.startedAt) / DAY_MS) + 1);
  const covered = new Set();
  for (const o of obs) {
    const d = Math.floor((o.at - state.startedAt) / DAY_MS);
    if (d >= 0 && d < SOAK_DAYS) covered.add(d);
  }
  const gaps = [];
  for (let d = 0; d < elapsedDays; d++) if (!covered.has(d)) gaps.push(d + 1);
  return { days: elapsedDays, covered: covered.size, gaps, ok: gaps.length === 0 };
}

/** Everything the procedure asks to be observed, once a day. */
export async function observe({ origin = process.env.SOAK_ORIGIN || '', now = Date.now() } = {}) {
  const out = { at: now, origin, checks: {}, problems: [] };

  if (!origin) {
    out.problems.push('no SOAK_ORIGIN set, so nothing was actually observed — this is not an observation');
    return out;
  }

  const get = async (path) => {
    try {
      const res = await fetch(origin + path, { cache: 'no-store' });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: res.status, json, text: text.slice(0, 400) };
    } catch (e) {
      return { status: 0, error: String(e.message || e) };
    }
  };

  // 1. is it up at all
  const health = await get('/api/admin?do=system-health');
  out.checks.health = { status: health.status, ok: health.status === 200 };
  if (health.status !== 200) out.problems.push(`health endpoint answered ${health.status}`);

  // 2. are the workers still checking in — the single most valuable thing a
  //    soak catches, because a scheduler that stops does not raise an error
  const auto = await get('/api/admin?do=automation-status');
  const workers = (auto.json && auto.json.automation && auto.json.automation.workers) || [];
  out.checks.workers = workers.map((w) => ({ id: w.id, status: w.status, text: w.text }));
  for (const w of workers) {
    if (w.status === 'stalled' || w.status === 'never') out.problems.push(`${w.label || w.id} is ${w.status}: ${w.text}`);
  }
  if (!workers.length) out.problems.push('no worker check-ins were readable, so "running" cannot be claimed');

  // 3. is anything stranded
  const h = health.json || {};
  if (h.queue && Number(h.queue.dead) > 0) out.problems.push(`${h.queue.dead} job(s) in the dead letter`);

  return out;
}

function render(state, now = Date.now()) {
  const w = windowStatus(state, now);
  const c = coverage(state, now);
  const lines = [];
  lines.push('');
  lines.push('  SEVEN-DAY STAGING SOAK (R12.6)');
  lines.push('  ------------------------------');
  if (!w.started) {
    lines.push('  Not started. Run `node tests/soak.mjs start` on the staging deployment.');
    lines.push('');
    return lines.join('\n');
  }
  lines.push(`  Started:    ${new Date(state.startedAt).toISOString()}`);
  lines.push(`  Now:        ${new Date(now).toISOString()}`);
  lines.push(`  Elapsed:    ${w.elapsedDays} of ${SOAK_DAYS} real days`);
  lines.push(`  Verdict:    ${w.verdict}${w.complete ? '' : `  (${w.remainingDays} days still to run)`}`);
  lines.push(`  Observed:   ${c.covered} of ${c.days} elapsed days${c.gaps.length ? `  — NO OBSERVATION on day ${c.gaps.join(', ')}` : ''}`);
  const problems = (state.observations || []).flatMap((o) => o.problems || []);
  lines.push(`  Problems:   ${problems.length === 0 ? 'none recorded' : `${problems.length} recorded`}`);
  for (const p of problems.slice(-5)) lines.push(`              · ${p}`);
  lines.push('');
  if (!w.complete) {
    lines.push('  THIS SOAK IS NOT COMPLETE. Seven real days have not elapsed, and nothing');
    lines.push('  may record it as done — a simulated week is R12.5 and is a different claim.');
  } else if (!c.ok) {
    lines.push('  Seven days have elapsed, but there are days with NO observation, so this');
    lines.push(`  is a wait rather than a soak. Missing: day ${c.gaps.join(', ')}.`);
  } else if (problems.length) {
    lines.push('  Seven days elapsed and every day was observed, but problems were recorded.');
    lines.push('  Fix them and start a new window; a soak with known faults is not a pass.');
  } else {
    lines.push('  Seven real days elapsed, every day observed, no problems recorded.');
  }
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
const cmd = process.argv[2] || 'status';

if (cmd === 'start') {
  const existing = read();
  const w = windowStatus(existing);
  if (existing && w.started && !w.complete) {
    console.log(render(existing));
    console.log('  A window is already running. Starting again would reset the clock, which is');
    console.log('  the one thing this script exists to prevent. Delete .soak/state.json by hand');
    console.log('  if you genuinely mean to abandon it.\n');
    process.exit(1);
  }
  const state = { startedAt: Date.now(), startedBy: 'owner', observations: [] };
  write(state);
  console.log(render(state));
} else if (cmd === 'check') {
  const state = read();
  if (!state || !state.startedAt) {
    console.log('\n  No soak window is running. `node tests/soak.mjs start` first.\n');
    process.exit(1);
  }
  const obs = await observe({});
  state.observations = [...(state.observations || []), obs];
  write(state);
  console.log(render(state));
  if (obs.problems.length) {
    console.log('  This observation recorded problems:');
    for (const p of obs.problems) console.log(`   · ${p}`);
    console.log('');
    process.exit(1);
  }
} else {
  console.log(render(read()));
}
