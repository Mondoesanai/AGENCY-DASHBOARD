// What still has to be true before a new client is actually being looked after.
//
// Adding a site writes a config row, and that is where it used to end. Whether
// the site was reachable, whether the repository mapping worked, whether
// anything was scheduled, whether a report could be produced — all of that was
// discovered later, usually by noticing that nothing had happened.
//
// This computes the answer from what the system already knows. It is a READ
// MODEL: it runs the checks that already exist and reports them. It does not
// invent credentials, does not enable a billable service, and does not switch
// on prospect outreach — adding a client is not consent to start prospecting,
// and the two have no connection here.
//
// Each incomplete step carries ONE action. Not a list of things to try: the
// specific next thing, because an onboarding screen that offers six options is
// one the owner closes.

import { store } from './store.js';

export const STEP_STATE = Object.freeze({
  DONE: 'done',
  WAITING: 'waiting',       // we are waiting on something automatic
  NEEDS_OWNER: 'needs-owner',
  UNKNOWN: 'unknown',       // we could not find out — never reported as done
});

const step = (id, label, state, detail, action = null) => ({ id, label, state, detail, action });

/**
 * Where is this client up to?
 *
 * Ordered by what blocks what: a site nobody can reach cannot be improved, and
 * a repository that is not linked blocks every change regardless of anything
 * else.
 */
export async function statusFor(site, { now = Date.now() } = {}) {
  if (!site) return { ok: false, error: 'no site' };
  const steps = [];

  // 1. Is the site actually reachable? Written by the daily health check, so
  //    this reuses that rather than fetching again — an onboarding screen that
  //    hits a client's site on every render is a small denial of service.
  let health = null;
  try {
    const raw = await store.get(`health:${site.slug}`);
    health = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    health = undefined;
  }
  if (health === undefined) {
    steps.push(step('reachable', 'Site reachable', STEP_STATE.UNKNOWN,
      'The last check could not be read, so whether the site responds is unknown.'));
  } else if (!health) {
    steps.push(step('reachable', 'Site reachable', STEP_STATE.WAITING,
      'Not checked yet. The daily pass checks every site; this fills in on its next run.'));
  } else if (health.up) {
    steps.push(step('reachable', 'Site reachable', STEP_STATE.DONE,
      `Responded ${health.status || 200}${health.ms ? ` in ${health.ms}ms` : ''}.`));
  } else {
    steps.push(step('reachable', 'Site reachable', STEP_STATE.NEEDS_OWNER,
      `The site did not respond (${health.status || health.error || 'no response'}).`,
      'Check the URL is right and the site is live. Nothing can be measured or improved until it loads.'));
  }

  // 2. Repository mapping — the thing that blocks every change.
  if (!site.repo) {
    steps.push(step('repo', 'Repository linked', site.seoAgent ? STEP_STATE.NEEDS_OWNER : STEP_STATE.WAITING,
      site.seoAgent
        ? 'Automation is on for this client but no repository is linked, so no change can be made.'
        : 'No repository linked. Needed before any site change can be made.',
      'Link the GitHub repository on this client\'s card.'));
  } else {
    // reuse the audit the tick already runs rather than calling GitHub again
    let audit = null;
    try {
      const raw = await store.get(`repoaudit:site:${site.slug}`);
      audit = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    } catch { audit = undefined; }
    if (audit && audit.error) {
      steps.push(step('repo', 'Repository linked', STEP_STATE.NEEDS_OWNER,
        `${site.repo} — ${audit.error}`,
        audit.action || 'Check the repository name and that the token can write to it.'));
    } else {
      steps.push(step('repo', 'Repository linked', STEP_STATE.DONE, site.repo));
    }
  }

  // 3. Measurement. Blank numbers because nothing is measuring is a different
  //    thing from blank numbers because nothing happened, and the client will
  //    ask about it either way.
  steps.push(site.hasTracker
    ? step('tracker', 'Analytics reporting', STEP_STATE.DONE, 'The tracking snippet is reporting.')
    : step('tracker', 'Analytics reporting', STEP_STATE.NEEDS_OWNER,
      'No data is arriving, so visitors and conversions will read as zero rather than as unknown.',
      'Add the tracking snippet to the site — the client card has a copy button.'));

  // 4. Monitoring and schedules. Nothing per-client to switch on: every site
  //    is covered by the same workers, so this reports whether THOSE are alive.
  try {
    const { automationStatus } = await import('./heartbeat.js');
    const a = await automationStatus(now);
    const dead = (a.workers || []).filter((w) => w.status === 'stalled' || w.status === 'never');
    steps.push(dead.length
      ? step('monitoring', 'Monitoring running', STEP_STATE.NEEDS_OWNER,
        `${dead.map((w) => w.label).join(', ')} not running, so this client is not actually being worked on.`,
        'Open Automations — the fix is the same for every client.')
      : step('monitoring', 'Monitoring running', STEP_STATE.DONE,
        'Health checks, improvements and the revisions inbox all cover this client.'));
  } catch {
    steps.push(step('monitoring', 'Monitoring running', STEP_STATE.UNKNOWN,
      'The worker check-ins could not be read.'));
  }

  // 5. Reporting — has one ever been produced for this client?
  let report = null;
  try {
    report = await store.get(`report:${site.slug}:latest`);
  } catch { report = undefined; }
  if (report === undefined) {
    steps.push(step('reports', 'Reporting ready', STEP_STATE.UNKNOWN, 'Could not read whether a report exists.'));
  } else if (report) {
    steps.push(step('reports', 'Reporting ready', STEP_STATE.DONE, 'A report has been produced for this client.'));
  } else if (!site.billingDay) {
    steps.push(step('reports', 'Reporting ready', STEP_STATE.NEEDS_OWNER,
      'No billing day is set, so no report is scheduled.',
      'Set the billing day on this client\'s card.'));
  } else {
    steps.push(step('reports', 'Reporting ready', STEP_STATE.WAITING,
      `Scheduled for day ${site.billingDay} of the month. The first one is produced on that day.`));
  }

  // 6. Revision processing — the inbox is shared, so this is about whether the
  //    client can actually reach it.
  steps.push(site.email
    ? step('revisions', 'Change requests', STEP_STATE.DONE, `Requests from ${site.email} are picked up automatically.`)
    : step('revisions', 'Change requests', STEP_STATE.NEEDS_OWNER,
      'No client email on file, so a request from them cannot be matched to this site.',
      'Add the client\'s email address to their card.'));

  const done = steps.filter((s) => s.state === STEP_STATE.DONE).length;
  const blocked = steps.filter((s) => s.state === STEP_STATE.NEEDS_OWNER);
  const unknown = steps.filter((s) => s.state === STEP_STATE.UNKNOWN);

  return {
    ok: true,
    slug: site.slug,
    name: site.name || site.slug,
    steps,
    done,
    total: steps.length,
    // "complete" requires every step to be DONE. An unknown step is never
    // counted as done, because the whole point is to stop a client looking
    // onboarded when nobody has established that they are.
    complete: done === steps.length,
    blocked,
    unknown,
    // the ONE thing to do next, not a list
    nextAction: blocked.length ? { step: blocked[0].id, label: blocked[0].label, action: blocked[0].action } : null,
  };
}

/** Every client's onboarding state, least complete first. */
export async function allStatuses({ now = Date.now() } = {}) {
  let sites = [];
  try {
    const { listSites } = await import('./registry.js');
    sites = await listSites();
  } catch (e) {
    return { ok: false, error: 'the client list could not be read', clients: [] };
  }
  const clients = [];
  for (const s of sites) clients.push(await statusFor(s, { now }));
  clients.sort((a, b) => (a.done / a.total) - (b.done / b.total));
  return {
    ok: true,
    clients,
    incomplete: clients.filter((c) => !c.complete).length,
    needingOwner: clients.filter((c) => c.blocked && c.blocked.length).length,
  };
}

/**
 * Recover once access is supplied.
 *
 * The owner adds the repository, and the work that was waiting on it should
 * start without anyone going to find it. Re-running the status is enough to
 * re-evaluate; this additionally nudges the queue, which is where anything
 * that was actually blocked is sitting.
 */
export async function recheck(slug, { now = Date.now() } = {}) {
  const { listSites } = await import('./registry.js');
  const site = (await listSites()).find((s) => s.slug === slug);
  if (!site) return { ok: false, error: `no client "${slug}"` };
  const before = await statusFor(site, { now });

  // anything dead purely because configuration was missing can now be retried
  let resumed = { resumed: 0 };
  try {
    const { resumeBlocked } = await import('./recovery.js');
    resumed = await resumeBlocked({ now });
  } catch { /* reported as zero */ }

  return { ok: true, status: before, resumed: resumed.resumed || 0 };
}
