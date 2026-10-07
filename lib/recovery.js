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
const ESCALATION_INDEX = 'recovery:escalated:all';
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

  // --- did a real person ask us for something and get nothing? -------------
  //
  // WHY THIS SECTION EXISTS. Everything above watches the MACHINERY: workers,
  // queues, jobs. Every check above was green on the two days a real client's
  // request died. Angie's was dropped by a dedupe bug; Isha Lo's shipped
  // 90%-done and was reported as finished. No worker stalled, no job failed,
  // no queue backed up. The machine was healthy and the client was ignored.
  //
  // So this watches the OUTCOME instead: a request that went quiet is a
  // failure even when nothing threw. Silence is the symptom both real
  // failures shared, and nothing was looking for it.
  try {
    const raw = await store.get('revisions:all');
    const tickets = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    const open = tickets.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    const age = (t) => (t.receivedAt ? now - t.receivedAt : 0);
    const days = (ms) => Math.floor(ms / 86400e3);

    // 1. They wrote to us and we never even acknowledged it.
    const unanswered = open.filter((t) => !t.repliedAt && age(t) > 24 * 3600e3);
    if (unanswered.length) {
      const worst = unanswered.sort((a, b) => age(b) - age(a))[0];
      findings.push(finding('client-unanswered', SEVERITY.STUCK,
        `${unanswered.length} client request(s) have had no reply at all — the oldest is ${days(age(worst))} days old.`,
        `Open Revisions and reply to "${String(worst.summary || worst.subject || '').slice(0, 60)}". They are waiting and have heard nothing.`,
        { count: unanswered.length, oldestId: worst.id, oldestDays: days(age(worst)) }));
    }

    // 2. Waiting on a file we never asked them for. This is Isha's case: the
    //    work stops, correctly, but the ask has to actually reach a person or
    //    it waits forever.
    const awaitingAsset = open.filter((t) => t.blockedBy?.action === 'request-asset');
    if (awaitingAsset.length) {
      const t = awaitingAsset[0];
      findings.push(finding('awaiting-client-asset', SEVERITY.CONFIG,
        `${awaitingAsset.length} request(s) are finished apart from a file only the client can send.`,
        `Ask ${t.siteName || 'the client'} for it — "${String(t.outstanding || t.summary || '').slice(0, 80)}". It completes by itself once the file is in the repo.`,
        { count: awaitingAsset.length, ticketId: t.id }));
    }

    // 3. Shipped, but nobody ever confirmed it actually went live.
    const unconfirmed = open.filter((t) => t.state === 'awaiting_review' && t.receivedAt && now - t.receivedAt > 3 * 86400e3);
    if (unconfirmed.length) {
      findings.push(finding('shipped-unconfirmed', SEVERITY.STUCK,
        `${unconfirmed.length} request(s) shipped but have sat unconfirmed for over 3 days.`,
        'Open Revisions and check the live site, then mark them done. Shipped is not the same as delivered.',
        { count: unconfirmed.length }));
    }

    // 4. A genuine request we could not match to a site, still unassigned.
    const orphans = open.filter((t) => !t.slug && age(t) > 24 * 3600e3);
    if (orphans.length) {
      findings.push(finding('unmatched-request', SEVERITY.CONFIG,
        `${orphans.length} request(s) could not be matched to a client site.`,
        'Open Revisions and assign each one to a site. Until then nothing can work on them.',
        { count: orphans.length }));
    }

    // 5. Open far longer than we tell clients it will take.
    const overdue = open.filter((t) => age(t) > 14 * 86400e3);
    if (overdue.length) {
      const worst = overdue.sort((a, b) => age(b) - age(a))[0];
      findings.push(finding('request-overdue', SEVERITY.STUCK,
        `${overdue.length} request(s) have been open over 2 weeks — the oldest is ${days(age(worst))} days.`,
        `Look at "${String(worst.summary || worst.subject || '').slice(0, 60)}" for ${worst.siteName || 'this client'}. Either finish it or tell them where it stands.`,
        { count: overdue.length, oldestDays: days(age(worst)) }));
    }
  } catch (e) {
    findings.push(finding('revisions-unreadable', SEVERITY.DEGRADED,
      'Client requests could not be read, so whether anyone is waiting is unknown.',
      'This is usually storage. Unknown is not the same as nobody waiting.', { error: String(e.message || e) }));
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

  // --- the lead path, checked rather than assumed ------------------------
  //
  // The agency site's form posts here from another origin. If this endpoint
  // starts refusing — a bad deploy, a broken import, CORS changing, the route
  // renamed — the form fails quietly on a page nobody on our side ever loads,
  // and leads stop arriving with no error anywhere. That is the same shape as
  // the revisions that sat for days: everything looks fine from the inside.
  //
  // So: an actual POST to our own public endpoint with a DELIBERATELY invalid
  // email. A healthy system answers with field errors and creates nothing; a
  // broken one answers 500, or does not answer. Nothing is written either way,
  // which is what makes this safe to run every sweep.
  try {
    // The URL CUSTOMERS use, not the one this deployment happens to be at.
    //
    // `VERCEL_URL` is the per-deployment hostname and sits behind Vercel's
    // deployment protection, so probing it returns 401 and reports a broken
    // lead form while the real one is fine. A false alarm costs more than no
    // alarm: it teaches the owner that findings can be ignored. So the probe
    // only ever runs against a stable public origin, and says nothing at all
    // when it does not know one.
    // Only when actually DEPLOYED. A constant origin is always truthy, so
    // without this gate the probe fired on every local run and every test,
    // making real network calls from a suite that must not need one.
    const deployed = !!env.VERCEL_ENV || !!env.PUBLIC_BASE_URL;
    const base = deployed ? (env.PUBLIC_BASE_URL || PUBLIC_ORIGIN) : null;
    if (base) {
      const url = `${base.startsWith('http') ? base : `https://${base}`}/api/collect?hook=request`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let probe;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // UNIQUE each run, and still deliberately invalid (no @, so it can
          // never validate). A fixed address shared a per-email rate-limit
          // bucket with itself: the limit is 4/hour, the sweep runs 6/hour, so
          // two probes an hour were answered 429 before reaching validation —
          // reported as alive while testing nothing, and still reported alive
          // if validation itself had broken.
          body: JSON.stringify({
            name: '', businessName: '',
            email: `probe-${now.toString(36)}-not-an-email`,
            __probe: true,
          }),
          signal: ctrl.signal,
        });
        probe = { status: r.status, body: await r.json().catch(() => ({})) };
      } finally {
        clearTimeout(timer);
      }
      // 400 + named field errors is the HEALTHY answer: validation ran, and it
      // refused without writing anything.
      const healthy = probe.status === 400 && probe.body && probe.body.fieldErrors;
      // 429 and 503 are the rate limiter and the fail-closed store guard doing
      // their jobs. They mean the route is alive, so they are not failures.
      const alive = healthy || probe.status === 429 || probe.status === 503;
      if (probe.status === 401 || probe.status === 403) {
        // Not an outage — the origin is sitting behind authentication, which
        // would also block every real visitor's submission. Named as the
        // configuration problem it is, so the fix is obvious.
        findings.push(finding('lead-form-protected', SEVERITY.CONFIG,
          'The lead form endpoint is behind deployment protection.',
          'The website posts here from a visitor\'s browser, which cannot authenticate. '
          + 'Turn off Vercel Deployment Protection for this project, or set PUBLIC_BASE_URL '
          + 'to the public domain, or no form submission can get through.',
          { status: probe.status, probed: url }));
      } else if (!alive) {
        findings.push(finding('lead-form-broken', SEVERITY.STUCK,
          `The website's lead form endpoint answered ${probe.status}, not a validation error.`,
          'Submissions from inspiringwebsites.org go to this endpoint. Until it answers properly, '
          + 'the form on the site fails silently and leads are not being recorded. Check the latest deploy.',
          { status: probe.status }));
      }
    }
  } catch (e) {
    findings.push(finding('lead-form-unreachable', SEVERITY.STUCK,
      'The website\'s lead form endpoint could not be reached at all.',
      'Submissions from inspiringwebsites.org go to this endpoint. While it is unreachable the form on '
      + 'the site fails and leads are not being recorded. Check the deployment is live.',
      { error: String(e?.message || e).slice(0, 120) }));
  }


  // --- can the booking form actually offer a time? -----------------------
  //
  // R21.6. The form was live and telling every visitor "online booking is not
  // available", because the Google grant had `calendar.events` but not a scope
  // that permits `freeBusy.query`. Nothing reported that: the adapter failed
  // closed correctly and quietly, which is right for a visitor and useless for
  // the owner. A missing scope is a permanent outage that no retry fixes, so it
  // is named here with the exact scope to add.
  try {
    if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) {
      const body = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        refresh_token: env.GOOGLE_REFRESH_TOKEN,
        grant_type: 'refresh_token',
      });
      const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(8000),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        findings.push(finding('google-token-rejected', SEVERITY.STUCK,
          'Google is refusing the saved credentials.',
          'Booking and the revision inbox both use this grant. Re-authorise it and replace '
          + 'GOOGLE_REFRESH_TOKEN. Nothing is reaching the calendar or Gmail until then.',
          { status: r.status, error: String(j.error || '').slice(0, 60), ownerAction: true }));
      } else {
        const { missingScopes } = await import('./google.js');
        const missing = missingScopes(j.scope);
        if (missing.length) {
          findings.push(finding('google-scopes-missing', SEVERITY.CONFIG,
            `The Google grant is missing ${missing.length} scope(s), so part of the product cannot work.`,
            `Re-authorise with these added and replace GOOGLE_REFRESH_TOKEN: ${missing.join(' ')}. `
            + 'Without calendar.readonly the booking form cannot read free/busy, so it offers no '
            + 'times and every visitor is told online booking is unavailable.',
            { missing, ownerAction: true }));
        }
      }
    }
  } catch { /* a credential check that cannot run is not itself an incident */ }
  return { ok: true, at: now, findings, counts: countBy(findings) };
}

/**
 * The stable public origin this app is reachable at.
 *
 * Deliberately a constant and not `VERCEL_URL`: that variable is the
 * per-deployment hostname, which deployment protection answers 401 for. This
 * is the origin the agency website actually posts to, so it is the only one
 * worth asking "does the lead form work?".
 *
 * Set `PUBLIC_BASE_URL` to override it — that is also what unsubscribe links
 * need, so setting it once fixes both.
 */
const PUBLIC_ORIGIN = 'https://agency-dashboard-omega-red.vercel.app';

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

  // 2b. A requirement blocked on a missing file: look again before anyone is
  //     asked for it a second time. This is what makes "resumes by itself when
  //     the asset arrives" true rather than aspirational — the file turning up
  //     in a reply, in the repo, or in the agency's own brand folder restarts
  //     the work without anybody remembering to go and do it.
  try {
    const { recheckBlockedAssets } = await import('./asset-search.js');
    const raw = await store.get('revisions:all');
    const tickets = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    const open = (Array.isArray(tickets) ? tickets : []).filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    if (open.length) {
      const { listSites } = await import('./registry.js');
      const sites = await listSites().catch(() => []);
      const found = await recheckBlockedAssets(open, { siteFor: (t) => sites.find((s) => s.slug === t.slug) || null });
      if (found.count) {
        await store.set('revisions:all', JSON.stringify(tickets));
        actions.push({ action: 'assets-found', count: found.count, resumed: found.resumed });
      }
    }
  } catch { /* reported by the revisions finding in diagnose() if it matters */ }

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

  // 4. Record that the sweep ran, and what it did.
  //
  // This swept every ~10 minutes for a long time and wrote down nothing, so
  // "is anything actually sweeping?" had no answer and a stopped sweep was
  // invisible — the watchdog was the one thing with no watchdog. The beat
  // feeds the same automation panel as every other worker; the history gives
  // the activity view something truthful to show.
  await recordSweep({ now, findings: diag.findings, escalated, actions });

  return { ok: true, at: now, findings: diag.findings, actions };
}

/** How many sweeps are kept for the activity view. */
export const SWEEP_HISTORY = 50;

/**
 * Persist one sweep. Best-effort by design: a sweep that genuinely recovered
 * something must not be reported as failed because the bookkeeping write
 * failed afterwards.
 */
export async function recordSweep({ now = Date.now(), findings = [], escalated = [], actions = [] } = {}) {
  try {
    const { recordBeat, recordOutcome } = await import('./heartbeat.js');
    await recordBeat('recovery', now).catch(() => {});
    await recordOutcome('recovery', {
      ok: true,
      processed: findings.length,
      note: findings.length ? `${findings.length} finding(s), ${escalated.length} raised` : 'nothing wrong',
    }).catch(() => {});
  } catch { /* the history entry below is the load-bearing part */ }
  try {
    const raw = await store.get('recovery:history');
    const prev = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    const entry = {
      at: now,
      findings: findings.length,
      ids: findings.map((f) => f.id).slice(0, 12),
      escalated: escalated.slice(0, 12),
      acted: actions.filter((a) => a.action !== 'escalated').map((a) => a.action),
    };
    const next = [entry, ...(Array.isArray(prev) ? prev : [])].slice(0, SWEEP_HISTORY);
    await store.set('recovery:history', JSON.stringify(next));
    await store.set('recovery:lastRun', String(now));
    return { ok: true, entry };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/**
 * Has the sweep itself stopped?
 *
 * A sweep cannot detect its own absence while it is not running, so this is
 * read by the things that DO run — the daily pass and the dashboard — and by
 * the automation panel. `ran: false` with `everRan: false` means it has never
 * recorded a run, which is different from having stopped.
 */
export async function sweepHealth({ now = Date.now(), staleMs = 6 * 3600e3 } = {}) {
  let last = null;
  try {
    const v = await store.get('recovery:lastRun');
    last = v ? Number(v) : null;
  } catch {
    return { ok: false, unknown: true, note: 'the sweep history could not be read, so whether it is running is unknown' };
  }
  if (!last || !Number.isFinite(last)) {
    return { ok: false, everRan: false, lastAt: null, note: 'the self-healing sweep has never recorded a run' };
  }
  const age = now - last;
  return {
    ok: age <= staleMs,
    everRan: true,
    lastAt: last,
    ageMs: age,
    note: age <= staleMs ? null : `the self-healing sweep has not run for ${Math.round(age / 3600e3)}h`,
  };
}

/** The last N sweeps, newest first — what ran, what it found, what it did. */
export async function sweepHistory({ limit = 20 } = {}) {
  try {
    const raw = await store.get('recovery:history');
    const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
    // Sorted, not merely insertion-ordered. Prepending happens to produce
    // newest-first while sweeps arrive in clock order, but a replayed run or a
    // clock correction would quietly misorder the activity view — and an
    // activity history that lies about order is worse than none.
    const sweeps = (Array.isArray(list) ? list : [])
      .filter((s) => s && Number.isFinite(Number(s.at)))
      .sort((a, b) => Number(b.at) - Number(a.at));
    return { ok: true, sweeps: sweeps.slice(0, limit) };
  } catch (e) {
    return { ok: false, error: String(e.message || e), sweeps: [] };
  }
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
    at: now, count: Number(prev?.count || 0) + 1, what: f.what, action: f.action || '', severity: f.severity || '',
  }), { ex: 60 * 60 * 24 * 30 }).catch(() => {});
  // R16.6 — indexed on the way up, so what was raised can be listed and put
  // down again. Without this the records existed but nothing could find them,
  // which is why the dashboard could raise an alert and never clear one.
  await store.sadd(ESCALATION_INDEX, f.id).catch(() => {});
  return { sent: true, firstRaisedAt: now };
}

/**
 * Everything currently raised, for the panel that offers to acknowledge it.
 *
 * An id in the index whose record has expired is dropped from the index as it
 * is found, so a 30-day TTL cannot leave the list growing for ever.
 */
export async function listEscalations() {
  const ids = await store.smembers(ESCALATION_INDEX).catch(() => []);
  const out = [];
  for (const id of ids || []) {
    let rec = null;
    try {
      const raw = await store.get(ESCALATION(id));
      rec = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    } catch { rec = null; }
    if (!rec || !rec.at) { await store.srem(ESCALATION_INDEX, id).catch(() => {}); continue; }
    out.push({
      id,
      title: rec.what || 'Something needs looking at',
      detail: rec.action || '',
      severity: rec.severity || '',
      at: rec.at,
      count: rec.count || 1,
    });
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}

/** An issue that has cleared may be raised again if it comes back. */
export async function clearEscalation(id) {
  // `del`, not `set('')`: a blank value still reads as a record to anything
  // that only checks for existence, and the index entry has to go with it.
  await store.del(ESCALATION(id)).catch(() => {});
  await store.srem(ESCALATION_INDEX, id).catch(() => {});
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
