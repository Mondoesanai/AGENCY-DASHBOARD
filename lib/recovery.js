// Routine operation without the owner diagnosing things.
//
// The parts that already existed and are reused rather than rebuilt: leases
// expire so a dead worker strands nothing (lib/jobs.js), failures back off and
// end in a visible dead letter, provider outages defer instead of burning the
// attempt budget, ambiguous sends are reconciled before any retry
// (lib/outreach-email.js), and idempotency keys stop a retry repeating a side
// effect. This module is the sweep over all of it, plus the two things that
// were missing: **resuming work that was blocked by configuration once the
// configuration is fixed**, and **escalating once** instead of every cycle.
//
// WHAT IT WILL NOT DO
//
// It does not repair code. A defect that needs a code change produces a
// **repair task** with sanitised diagnostics, and that is where its authority
// ends. A production worker that can rewrite and deploy itself is a worker
// that can deploy a mistake at 3am with nobody watching, and no amount of
// test-passing makes that a good trade.
//
// IT IS ALSO NOT ITS OWN MONITOR, and that limit is worth stating plainly.
// This sweep runs inside the same system it is checking, so it cannot report
// that the whole thing is down — a process that is not running cannot tell you
// it is not running. The independent check is the GitHub Actions workflow,
// which lives on different infrastructure, runs on its own schedule, and
// reaches the deployment from outside. If Vercel is down, GitHub notices. If
// GitHub is down, nothing here notices, and that gap is real.

import { store } from './store.js';

const ESCALATION = (id) => `recovery:escalated:${id}`;
const REPAIR = (id) => `repair:${id}`;
const REPAIR_INDEX = 'repair:all';

/** How long before the same unresolved issue may be raised again. */
export const RE_ESCALATE_AFTER_MS = 24 * 3600e3;

export const SEVERITY = Object.freeze({
  CONFIG: 'needs-configuration',   // a person must supply something
  STUCK: 'stuck',                  // work is not moving but could
  DEGRADED: 'degraded',            // running, but something failed
  CODE: 'needs-code-change',       // a defect; becomes a repair task
});

/**
 * One finding, in the shape the dashboard and the notifier both want.
 *
 * `action` is deliberately singular. A list of six things to try is how an
 * owner ends up doing none of them; one precise next step is actionable.
 */
const finding = (id, severity, what, action, detail = {}) => ({
  id, severity, what, action, ...detail,
});

/**
 * Look at everything, change nothing. Separating the looking from the acting
 * means the sweep can be run to ask "what is wrong?" without side effects —
 * which is what the dashboard does on every load.
 */
export async function diagnose({ now = Date.now(), env = process.env } = {}) {
  const findings = [];

  // --- scheduled runs that did not happen ---------------------------------
  try {
    const { automationStatus, WORKERS } = await import('./heartbeat.js');
    const a = await automationStatus(now);
    for (const w of a.workers || []) {
      if (w.status === 'stalled') {
        findings.push(finding(`worker-stalled:${w.id}`, SEVERITY.STUCK,
          `${w.label} has not run since ${new Date(w.lastAt).toISOString().slice(0, 16).replace('T', ' ')}.`,
          `Check that ${w.runBy} is still enabled. Nothing it does is happening until it runs.`,
          { worker: w.id, lastAt: w.lastAt }));
      } else if (w.status === 'never' && WORKERS[w.id]) {
        findings.push(finding(`worker-never:${w.id}`, SEVERITY.CONFIG,
          `${w.label} has never recorded a run.`,
          `Confirm ${w.runBy} is set up. If it runs but does not report, the schedule is fine and the reporting is not.`,
          { worker: w.id }));
      }
      // running, but failing every time
      if (w.hasOutcomeTelemetry && w.lastFailureAt && !w.lastSuccessAt) {
        findings.push(finding(`worker-never-succeeded:${w.id}`, SEVERITY.DEGRADED,
          `${w.label} runs but has never completed successfully.`,
          w.lastFailure ? `Last failure: ${w.lastFailure}` : 'Open the automation panel for the last error.',
          { worker: w.id }));
      }
    }
  } catch (e) {
    findings.push(finding('heartbeat-unreadable', SEVERITY.DEGRADED,
      'The worker check-ins could not be read, so their health is unknown.',
      'This is usually storage. Unknown is not the same as healthy.', { error: String(e.message || e) }));
  }

  // --- work that is stuck rather than failing ------------------------------
  try {
    const { queueHealth } = await import('./jobs.js');
    const q = await queueHealth({ now });
    if (q.staleLeases > 0) {
      findings.push(finding('stale-leases', SEVERITY.STUCK,
        `${q.staleLeases} job(s) were left mid-run by a worker that stopped.`,
        'Nothing is lost — the next tick reclaims them. If this keeps happening, the worker is being killed mid-job.',
        { count: q.staleLeases }));
    }
    if (q.dead > 0) {
      findings.push(finding('dead-letter', SEVERITY.DEGRADED,
        `${q.dead} job(s) gave up after exhausting their retries.`,
        'Open the dead letter, fix the cause, and replay them. They are kept, not discarded.',
        { count: q.dead }));
    }
    // queued work that is overdue by a lot means nothing is draining it
    if (q.oldestDueAt && now - q.oldestDueAt > 6 * 3600e3 && q.queued > 0) {
      findings.push(finding('queue-not-draining', SEVERITY.STUCK,
        `${q.queued} job(s) have been waiting over ${Math.round((now - q.oldestDueAt) / 3600e3)} hours.`,
        'The queue is not being drained. Check that the automation tick is running.',
        { queued: q.queued }));
    }
  } catch (e) {
    findings.push(finding('queue-unreadable', SEVERITY.DEGRADED,
      'The job queue could not be read.', 'Check storage connectivity.', { error: String(e.message || e) }));
  }

  // --- configuration that blocks real work --------------------------------
  // Only reported when something is actually WAITING on it. An unconfigured
  // integration nobody is using is a setup task, not an incident, and
  // reporting it as one is how an alert list becomes wallpaper.
  try {
    const { stopState } = await import('./deliverability.js');
    const stop = await stopState();
    if (stop.stopped) {
      findings.push(finding('outreach-stopped', SEVERITY.CONFIG,
        'Outreach stopped itself because of deliverability.',
        `${stop.reason || 'Open Acquisition to see the numbers.'} It stays stopped until you start it again.`,
        { since: stop.at }));
    }
  } catch { /* reported by its own panel */ }

  return { ok: true, at: now, findings, counts: countBy(findings) };
}

const countBy = (f) => f.reduce((acc, x) => ({ ...acc, [x.severity]: (acc[x.severity] || 0) + 1 }), {});

/**
 * Act on what was found, within strict bounds.
 *
 * Everything here is reversible and bounded. Nothing deploys, nothing sends,
 * nothing rewrites code.
 */
export async function recover({ now = Date.now(), notify = null, env = process.env } = {}) {
  const diag = await diagnose({ now, env });
  const actions = [];

  // 1. Reclaim stranded work. The lease already makes this safe; this just
  //    makes it happen promptly rather than on the next natural tick.
  try {
    const { listJobs, JOB_STATE } = await import('./jobs.js');
    const { jobs } = await listJobs({ limit: 300 });
    const stranded = (jobs || []).filter((j) => j.state === JOB_STATE.LEASED && j.lease && Number(j.lease.until) <= now);
    if (stranded.length) actions.push({ action: 'reclaimable', count: stranded.length, note: 'left for the next tick to claim — the lease has already expired, so nothing needs forcing' });
  } catch { /* diagnosed above */ }

  // 2. Resume work that was blocked by configuration which is now present.
  //    This is the one the owner actually feels: they fix a key, and the thing
  //    that was waiting starts by itself instead of needing to be found.
  const resumed = await resumeBlocked({ env, now });
  if (resumed.resumed) actions.push({ action: 'resumed-blocked-work', ...resumed });

  // 3. Escalate, ONCE. A notification that arrives every fifteen minutes is a
  //    notification that gets muted, and a muted channel is worse than none.
  const escalated = [];
  for (const f of diag.findings) {
    if (f.severity === SEVERITY.DEGRADED || f.severity === SEVERITY.STUCK || f.severity === SEVERITY.CONFIG) {
      const sent = await escalateOnce(f, { now, notify });
      if (sent.sent) escalated.push(f.id);
    }
  }
  if (escalated.length) actions.push({ action: 'escalated', ids: escalated });

  return { ok: true, at: now, findings: diag.findings, actions };
}

/**
 * Raise an issue at most once per window.
 *
 * Keyed on the finding's id, so "the daily pass is stalled" is one issue no
 * matter how many times the sweep notices it. Resolving it clears the record,
 * so it can legitimately be raised again if it recurs later.
 */
export async function escalateOnce(f, { now = Date.now(), notify = null, windowMs = RE_ESCALATE_AFTER_MS } = {}) {
  if (!f || !f.id) return { sent: false, reason: 'no finding' };
  let prev = null;
  try {
    const raw = await store.get(ESCALATION(f.id));
    prev = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    // if we cannot tell whether this was already raised, do NOT raise it —
    // a duplicate alert is the failure mode this function exists to prevent
    return { sent: false, reason: 'could not read whether this was already raised' };
  }
  if (prev && now - Number(prev.at || 0) < windowMs) {
    return { sent: false, reason: 'already raised', firstRaisedAt: prev.at, count: prev.count };
  }

  if (typeof notify === 'function') {
    try {
      await notify(`${f.what}\n\nWhat to do: ${f.action}`);
    } catch { /* recording it still prevents a storm */ }
  }
  await store.set(ESCALATION(f.id), JSON.stringify({
    at: now, count: Number(prev?.count || 0) + 1, what: f.what,
  }), { ex: 60 * 60 * 24 * 30 }).catch(() => {});
  return { sent: true, firstRaisedAt: now };
}

/** An issue that has cleared may be raised again if it comes back. */
export async function clearEscalation(id) {
  await store.set(ESCALATION(id), '').catch(() => {});
  return { ok: true };
}

/**
 * Restart work that was blocked purely by missing configuration.
 *
 * Jobs that died because a provider was not connected are permanently dead by
 * the queue's rules — correctly, because retrying them changed nothing. But
 * once the provider IS connected the original reason is gone, and making the
 * owner find and replay them by hand is the kind of chore that makes a system
 * feel broken when it is merely pedantic.
 */
export async function resumeBlocked({ env = process.env, now = Date.now() } = {}) {
  const nowConfigured = {
    email: !!(env.INSTANTLY_API_KEY && env.OUTREACH_FROM_DOMAIN),
    sms: !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_SMS_FROM),
  };
  if (!nowConfigured.email && !nowConfigured.sms) {
    return { resumed: 0, reason: 'nothing has been configured that was not before' };
  }

  let replayed = 0;
  const ids = [];
  try {
    const { listDeadLetter, replayDead } = await import('./jobs.js');
    const dead = await listDeadLetter({ limit: 200 });
    for (const job of dead || []) {
      const why = String(job.deadReason || job.lastError || '');
      const wasEmail = /no email provider is connected|not connected/i.test(why);
      const wasSms = /no SMS provider|sms.*not connected/i.test(why);
      if ((wasEmail && nowConfigured.email) || (wasSms && nowConfigured.sms)) {
        const r = await replayDead(job.id, { now, by: 'recovery' });
        if (r && r.ok) { replayed++; ids.push(job.id); }
      }
    }
  } catch {
    return { resumed: 0, reason: 'the dead letter could not be read' };
  }
  return { resumed: replayed, ids, reason: replayed ? 'the provider these were waiting on is now connected' : 'nothing was waiting on it' };
}

// ---------------------------------------------------------------------------
// Repair tasks — where automation stops and a person starts
// ---------------------------------------------------------------------------

/**
 * Record a defect that needs a code change.
 *
 * Diagnostics are sanitised before they are stored, because a stack trace is
 * exactly the kind of thing that carries a key or an address in it, and this
 * record is meant to be readable and shareable.
 */
export async function openRepairTask({ title, diagnostics = '', severity = SEVERITY.CODE, now = Date.now() }) {
  if (!title) return { ok: false, error: 'a repair task needs a title' };
  const id = `rp_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const task = {
    id, title: String(title).slice(0, 200), severity,
    diagnostics: sanitise(diagnostics),
    openedAt: now, state: 'open',
    // said explicitly on the record itself
    note: 'A person decides what to change. Nothing in this system edits or deploys code on its own.',
  };
  await store.set(REPAIR(id), JSON.stringify(task)).catch(() => {});
  await store.sadd(REPAIR_INDEX, id).catch(() => {});
  return { ok: true, task };
}

/** Strip anything that looks like a credential or a personal address. */
export function sanitise(text) {
  return String(text || '')
    .replace(/\b(sk-ant-|re_|ghp_|AC[0-9a-f]{30,}|AKIA)[A-Za-z0-9_-]+/g, '[redacted-credential]')
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[redacted-email]')
    .replace(/\b\+?\d[\d\s().-]{7,}\d\b/g, '[redacted-number]')
    .slice(0, 4000);
}

export async function listRepairTasks({ limit = 50 } = {}) {
  let ids = [];
  try {
    ids = await store.smembers(REPAIR_INDEX);
  } catch {
    return { ok: false, error: 'the repair list could not be read', tasks: [] };
  }
  const tasks = [];
  for (const id of ids) {
    try {
      const raw = await store.get(REPAIR(id));
      if (raw) tasks.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch { /* skip */ }
  }
  tasks.sort((a, b) => b.openedAt - a.openedAt);
  return { ok: true, tasks: tasks.slice(0, limit) };
}
