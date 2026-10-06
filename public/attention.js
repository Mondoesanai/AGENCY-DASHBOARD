// R2.4 — the Overview answers one question: what needs me?
//
// What was there before was a row of six metric tiles and a banner that read
// "⚠ Needs attention: acme, beta, renewity" — a list of slugs, with no way to
// tell what was wrong, how bad it was, or what to do about it. It could also be
// dismissed into localStorage under a key built from the set of slugs, so the
// same set of real problems never came back. That is the opposite of what an
// overview is for.
//
// Three rules hold this file together:
//
//  1. An item is a FACT plus a NEXT ACTION. If there is nothing the owner could
//     do about it, it is a metric, and metrics belong lower down the page.
//  2. Nothing here can be dismissed. Items leave when the thing is fixed. A
//     dashboard that lets you hide a stuck client request is worse than no
//     dashboard, because you then believe you have seen everything.
//  3. Silence must be EARNED. If a source did not load, the summary says which
//     one, rather than showing an empty list that reads as "all clear".
//     `checked`/`notChecked` carry that; `allClear` is only true when every
//     source was actually looked at.
//
// Everything here is pure: the caller passes what it already fetched. That
// keeps it drivable in tests and keeps the Overview from needing a new
// serverless function (the deployment is at its 12-function limit).

export const SEVERITY = Object.freeze({ act: 0, watch: 1, info: 2 });
export const SEVERITY_LABEL = Object.freeze({
  act: 'needs you',
  watch: 'worth a look',
  info: 'for information',
});

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const nameOf = (s) => s?.name || s?.client || s?.slug || 'a client';

// Order inside a severity, decided rather than alphabetical. Work a paying
// client is already waiting on comes before chasing new business, and a cause
// ("no repository linked") comes before the symptom it will produce.
export const KIND_RANK = Object.freeze({
  // a worker that has stopped is above everything: while it is down, none of
  // the other items can resolve themselves either
  'automation-stalled': 0,
  'request-stuck': 1,
  'no-repo': 2,
  'report-overdue': 3,
  'trial-ending': 4,
  // R9.9 — outreach stopping itself ranks above a waiting reply but below
  // every paying client's item, for the reason stated above: client work the
  // business already owes comes before chasing new business. It is here rather
  // than lower because nothing else will start sending again, and nothing
  // about the dashboard otherwise looks wrong while it is stopped.
  'deliverability-stopped': 5,
  'reply-waiting': 6,
  'deliverability-unknown': 8,
  'automation-paused': 9,
  'deliverability-warn': 14,
  'request-retrying': 10,
  'audit-failed': 11,
  'traffic-drop': 12,
  'no-tracker': 13,
  'audit-quota': 20,
  stale: 21,
});

/**
 * Build the ranked attention list.
 *
 * Every argument is optional, and leaving one out is NOT the same as it being
 * empty — an absent source is recorded in `notChecked` so the empty state
 * cannot claim more than it knows.
 *
 * @param {object} input
 * @param {Array}  [input.sites]      rows from /api/sites
 * @param {object} [input.portfolio]  the portfolio block from /api/sites
 * @param {Array}  [input.tickets]    revision tickets
 * @param {Array}  [input.replies]    prospect replies
 * @param {number} [input.generatedAt] when the feed was built
 * @param {number} [input.now]
 */
export function buildAttention(input = {}) {
  const now = input.now || Date.now();
  const items = [];
  const checked = [];
  const notChecked = [];

  // ---- client requests -----------------------------------------------------
  if (Array.isArray(input.tickets)) {
    checked.push('change requests');
    const stuck = input.tickets.filter((t) => t.state === 'blocked' || t.needsOwner === true);
    for (const t of stuck) {
      items.push({
        id: `stuck:${t.slug}:${t.id || t.at || ''}`,
        kind: 'request-stuck',
        severity: 'act',
        slug: t.slug,
        title: `${nameOf(siteFor(input.sites, t.slug)) } — a change request is stuck`,
        detail: t.blockedBy?.label
          ? `${t.blockedBy.label}. The work is saved and resumes by itself once this is fixed.`
          : 'It is waiting on something only you can do. The work is saved.',
        action: { label: 'Open the request', view: 'clients', slug: t.slug, pane: 'revisions' },
      });
    }
    // Repeated failures that the machine is still retrying: not yours to fix
    // yet, but you should know before the client asks.
    const grinding = input.tickets.filter((t) => t.state === 'retryable' && (t.attempts || 0) >= 3);
    for (const t of grinding) {
      items.push({
        id: `retrying:${t.slug}:${t.id || t.at || ''}`,
        kind: 'request-retrying',
        severity: 'watch',
        slug: t.slug,
        title: `${nameOf(siteFor(input.sites, t.slug))} — a change request has failed ${t.attempts} times`,
        detail: 'It is still retrying on its own. If it runs out of attempts it will appear here as stuck.',
        action: { label: 'Open the request', view: 'clients', slug: t.slug, pane: 'revisions' },
      });
    }
  } else {
    notChecked.push('change requests');
  }

  // ---- prospect replies waiting on a person --------------------------------
  if (Array.isArray(input.replies)) {
    checked.push('replies');
    const waiting = input.replies.filter(needsPerson);
    if (waiting.length) {
      items.push({
        id: 'replies:waiting',
        kind: 'reply-waiting',
        severity: 'act',
        count: waiting.length,
        title: `${waiting.length} repl${waiting.length === 1 ? 'y' : 'ies'} handed to you`,
        detail: 'These were held back on purpose — nothing has been answered automatically.',
        action: { label: 'Open the inbox', view: 'acquisition', tab: 'inbox' },
      });
    }
  } else {
    notChecked.push('replies');
  }

  // ---- per-site problems ---------------------------------------------------
  if (Array.isArray(input.sites)) {
    checked.push('client sites');
    for (const s of input.sites) {
      const who = nameOf(s);

      // automation on with nowhere to work: every request for this client will
      // stick, so this is the cause of a future stuck item, not a duplicate.
      if (s.seoAgent !== false && !s.repo) {
        items.push({
          id: `no-repo:${s.slug}`,
          kind: 'no-repo',
          severity: 'act',
          slug: s.slug,
          title: `${who} — automation is on but no repository is linked`,
          detail: 'Nothing can be changed on this site until it has one. Any request that arrives will queue and wait.',
          action: { label: 'Link a repository', view: 'clients', slug: s.slug, pane: 'settings' },
        });
      }

      // a report the client is expecting
      if (reportOverdue(s, now)) {
        items.push({
          id: `report:${s.slug}`,
          kind: 'report-overdue',
          severity: 'act',
          slug: s.slug,
          title: `${who} — this month's report has not been generated`,
          detail: `Billing day was the ${s.billingDay}${ordinal(s.billingDay)} and the newest report is ${s.report?.month ? `from ${s.report.month}` : 'missing'}.`,
          action: { label: 'Generate the report', view: 'clients', slug: s.slug, pane: 'report' },
        });
      }

      // a trial that is about to decide itself
      if (s.onTrial && typeof s.trialDaysLeft === 'number' && s.trialDaysLeft <= 3) {
        items.push({
          id: `trial:${s.slug}`,
          kind: 'trial-ending',
          severity: 'act',
          slug: s.slug,
          title:
            s.trialDaysLeft <= 0
              ? `${who} — the trial has ended`
              : `${who} — the trial ends in ${s.trialDaysLeft} day${s.trialDaysLeft === 1 ? '' : 's'}`,
          detail: 'Nothing happens automatically at the end of a trial. Convert it or close it.',
          action: { label: 'Open the client', view: 'clients', slug: s.slug, pane: 'settings' },
        });
      }

      // no measurements at all — the reason half the numbers on this page are blank
      if (!s.hasTracker && !s.awaitingData) {
        items.push({
          id: `no-tracker:${s.slug}`,
          kind: 'no-tracker',
          severity: 'watch',
          slug: s.slug,
          title: `${who} — the tracking snippet is not reporting`,
          detail: 'Visitors and conversions for this client are blank because nothing is being measured, not because they are zero.',
          action: { label: 'Get the snippet', view: 'clients', slug: s.slug, pane: 'overview' },
        });
      }

      // the audit could not run. Quota is a different problem with a different fix.
      if (s.audit && !s.audit.ok && !s.audit.pending) {
        const quota = /quota|rate.?limit|429/i.test(s.audit.error || '');
        items.push({
          id: `audit:${s.slug}`,
          kind: quota ? 'audit-quota' : 'audit-failed',
          severity: quota ? 'info' : 'watch',
          slug: s.slug,
          title: quota
            ? `${who} — the speed check was rate-limited`
            : `${who} — the speed and SEO check could not run`,
          detail: quota
            ? 'Google is throttling anonymous checks. A free PAGESPEED_API_KEY in Vercel removes this.'
            : `The site may be down or blocking the checker. ${String(s.audit.error || '').slice(0, 120)}`,
          action: quota
            ? { label: 'See the setup note', view: 'settings' }
            : { label: 'Open the client', view: 'clients', slug: s.slug, pane: 'overview' },
        });
      }

      // a real fall in traffic, with the number in it
      const drop = s.stats?.hasData ? s.stats.deltas?.visitors ?? 0 : null;
      if (drop != null && drop <= -25) {
        items.push({
          id: `drop:${s.slug}`,
          kind: 'traffic-drop',
          severity: 'watch',
          slug: s.slug,
          weight: drop,
          title: `${who} — visitors are down ${Math.abs(Math.round(drop))}%`,
          detail: 'Month on month. Worth knowing before the client notices it themselves.',
          action: { label: 'See the numbers', view: 'clients', slug: s.slug, pane: 'overview' },
        });
      }
    }
  } else {
    notChecked.push('client sites');
  }

  // ---- the automation's own check-ins (R2.6) -------------------------------
  if (input.automation) {
    checked.push('automation');
    const a = input.automation;
    if (a.pause?.paused) {
      items.push({
        id: 'automation:paused',
        kind: 'automation-paused',
        severity: 'watch',
        title: 'Automation is paused',
        detail: 'You paused it, so no new site work or outreach is being started. Queued work is waiting, not lost.',
        action: { label: 'Open automations', view: 'automations' },
      });
    } else {
      for (const w of a.workers || []) {
        if (w.status !== 'stalled' && w.status !== 'never') continue;
        items.push({
          id: `automation:${w.id}`,
          kind: 'automation-stalled',
          severity: 'act',
          title: `${w.label} has ${w.status === 'never' ? 'never run' : 'stopped running'}`,
          detail: `${w.text} Nothing it does is happening until this is fixed.`,
          action: { label: 'Open automations', view: 'automations' },
        });
      }
    }
  } else {
    notChecked.push('automation');
  }

  // ---- the deliverability trip (R9.9) --------------------------------------
  // Outreach stopping itself is the one thing here the owner cannot find out
  // any other way: nothing breaks, nothing errors, messages simply stop going.
  // It belongs at the top of what needs you, because only the owner can start
  // it again and nothing will do it for them.
  if (input.deliverability) {
    checked.push('deliverability');
    const d = input.deliverability;
    if (d.stop && d.stop.stopped) {
      items.push({
        id: 'deliverability:stopped',
        kind: 'deliverability-stopped',
        severity: 'act',
        title: 'Outreach stopped itself',
        detail: `${d.stop.reason || 'A deliverability threshold was crossed.'} Client site work is unaffected. Sending stays stopped until you start it again.`,
        action: { label: 'Open acquisition', view: 'acquisition' },
      });
    } else if (d.stop && d.stop.known === false) {
      items.push({
        id: 'deliverability:unknown',
        kind: 'deliverability-unknown',
        severity: 'watch',
        title: 'Whether outreach was stopped cannot be read',
        detail: 'Sending is being held until it can be. This is not the same as sending being fine.',
        action: { label: 'Open acquisition', view: 'acquisition' },
      });
    } else if (d.result && d.result.worst === 'warn') {
      const w = (d.result.signals || []).find((x) => x.level === 'warn');
      items.push({
        id: 'deliverability:warn',
        kind: 'deliverability-warn',
        severity: 'watch',
        title: 'Deliverability is worth watching',
        detail: `${w ? w.reason : ''} Nothing has been stopped.`.trim(),
        action: { label: 'Open acquisition', view: 'acquisition' },
      });
    }
  } else {
    notChecked.push('deliverability');
  }

  // ---- the feed itself -----------------------------------------------------
  if (input.generatedAt) {
    const age = now - input.generatedAt;
    if (age > 6 * 3600e3) {
      items.push({
        id: 'stale-feed',
        kind: 'stale',
        severity: 'info',
        title: `These figures are ${Math.round(age / 3600e3)} hours old`,
        detail: 'Nothing has refreshed them since. Reload, or check that the scheduled run is still happening.',
        action: { label: 'Refresh now', refresh: true },
      });
    }
  }

  items.sort(
    (a, b) =>
      SEVERITY[a.severity] - SEVERITY[b.severity] ||
      (KIND_RANK[a.kind] ?? 50) - (KIND_RANK[b.kind] ?? 50) ||
      (a.weight ?? 0) - (b.weight ?? 0) ||
      String(a.title).localeCompare(String(b.title))
  );

  const counts = { act: 0, watch: 0, info: 0 };
  for (const i of items) counts[i.severity]++;

  return {
    items,
    counts,
    checked,
    notChecked,
    // "nothing needs you" is only sayable when nothing was skipped
    allClear: items.length === 0 && notChecked.length === 0,
  };
}

// The reply kinds that are deliberately held for a person rather than answered.
// This mirrors NOTIFY_KINDS in lib/replies.js, which cannot be imported here
// (it pulls in the server-side store). A test pins the two together, so drift
// fails the suite instead of quietly dropping a reply off this list.
export const PERSON_KINDS = Object.freeze(['interested', 'wants-call', 'wants-preview', 'wants-details', 'ambiguous']);

/** A reply that is still waiting on the owner. */
export function needsPerson(r) {
  if (!r || r.handled === true) return false;
  if (r.needsPerson === true || r.handedOver === true) return true;
  return PERSON_KINDS.includes(r.kind);
}

function siteFor(sites, slug) {
  return (Array.isArray(sites) ? sites : []).find((s) => s.slug === slug) || { slug };
}

/**
 * Has the client's billing day passed this month without a report for it?
 * Deliberately conservative: no billing day, or no way to tell, is not overdue.
 */
export function reportOverdue(site, now = Date.now()) {
  if (!site?.billingDay) return false;
  const d = new Date(now);
  if (d.getDate() < site.billingDay) return false;
  const thisMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const have = site.report?.month || '';
  if (!have) return true;
  // reports are stored as "2026-10" or as a month name; compare on whichever we have
  if (/^\d{4}-\d{2}$/.test(have)) return have < thisMonth;
  const asDate = site.report?.generatedAt ? new Date(site.report.generatedAt) : null;
  if (!asDate || Number.isNaN(asDate.getTime())) return false;
  return asDate.getFullYear() !== d.getFullYear() || asDate.getMonth() !== d.getMonth();
}

function ordinal(n) {
  const v = Number(n) % 100;
  if (v >= 11 && v <= 13) return 'th';
  return { 1: 'st', 2: 'nd', 3: 'rd' }[v % 10] || 'th';
}

/** One line for the top of the Overview. Never overstates. */
export function attentionSummary(result) {
  const { counts, items, notChecked, allClear } = result;
  if (allClear) return 'Nothing needs you right now.';
  if (!items.length) {
    return `Nothing needs you in what could be checked — ${listOut(notChecked)} did not load, so that part is unknown.`;
  }
  const parts = [];
  if (counts.act) parts.push(`${counts.act} need${counts.act === 1 ? 's' : ''} you`);
  if (counts.watch) parts.push(`${counts.watch} worth a look`);
  if (counts.info) parts.push(`${counts.info} for information`);
  return parts.join(' · ');
}

function listOut(xs) {
  const a = (xs || []).slice();
  if (!a.length) return 'nothing';
  if (a.length === 1) return a[0];
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}

export const SHOW_FIRST = 6;

/**
 * Render the Overview's attention block.
 *
 * `loading` and `error` are distinct from "nothing to do" on purpose: an
 * overview that renders blank while it is still fetching, or after a failed
 * fetch, is a dashboard telling you everything is fine when it has no idea.
 */
/**
 * R16.12 — setting the thing up is not the same job as running it.
 *
 * A new employee opening Today was met by six boxes about Vercel crons, GitHub
 * Actions, a missing repository and a tracking snippet, before a single line
 * about a person. All six are real and worth fixing — but they are ONE-OFF
 * PLUMBING, done once by whoever set the account up, and they are not what
 * anybody comes to this screen for. Sorting purely by severity put them on top
 * every single day, which is most of why the dashboard "feels terrible": the
 * first thing it says is always that something technical is broken.
 *
 * So they are separated rather than hidden. Work first, plumbing underneath
 * with a count. Nothing is removed, and a setup item still says it needs doing.
 */
const SETUP_KINDS = new Set([
  'automation-stalled', // the cron or the GitHub schedule was never set up
  'no-repo', // nobody linked a repository
  'no-tracker', // the snippet was never installed on the client's site
  'deliverability-unknown', // nothing has been checked yet
]);

export const isSetup = (item) => SETUP_KINDS.has(item?.kind);

export function renderAttention(result, opts = {}) {
  const { loading = false, error = '', expanded = false } = opts;

  if (loading) {
    return `<div class="attn-block"><div class="loading">Checking what needs you…</div></div>`;
  }
  if (error) {
    return `<div class="attn-block"><div class="note warn"><b>Could not work out what needs you.</b>
      ${esc(error)} This is not an all-clear — nothing has been checked.</div></div>`;
  }

  const { items, notChecked, allClear } = result;

  if (!items.length) {
    const body = allClear
      ? `<b>Nothing needs you right now.</b> Checked: ${esc(listOut(result.checked))}.`
      : `<b>Nothing needs you in what could be checked.</b> ${esc(listOut(notChecked))} did not load,
         so that part is unknown — this is not a full all-clear.`;
    return `<div class="attn-block"><div class="note${allClear ? ' good' : ' warn'}">${body}</div></div>`;
  }

  // Work first, one-off plumbing underneath. Order within each group is
  // unchanged, so severity still decides what comes first among real work.
  const work = items.filter((i) => !isSetup(i));
  const setup = items.filter(isSetup);

  const shown = expanded ? work : work.slice(0, SHOW_FIRST);
  const rest = work.length - shown.length;

  const row = (i) => `<div class="attn-item sev-${esc(i.severity)}">
        <span class="attn-sev">${esc(SEVERITY_LABEL[i.severity] || i.severity)}</span>
        <div class="attn-body">
          <div class="attn-t">${esc(i.title)}</div>
          <div class="attn-d">${esc(i.detail || '')}</div>
        </div>
        ${
  // only the things that need a person get a loud button — six equally
  // bright calls to action is the same as none
  i.action
    ? `<button class="btn sm${i.severity === 'act' ? '' : ' ghost'} attn-go" data-attn="${esc(i.id)}">${esc(i.action.label)}</button>`
    : ''
}
      </div>`;

  const rows = shown.map(row).join('');

  const skipped = notChecked.length
    ? `<div class="note" style="margin:8px 0 0">${esc(listOut(notChecked))} could not be checked, so
         anything there is not in this list.</div>`
    : '';

  const more = rest > 0 ? `<button class="link attn-more" type="button">Show ${rest} more</button>` : '';

  const nothingToDo = !work.length
    ? `<div class="note good"><b>Nothing needs you right now.</b>${setup.length
      ? ' The only open items are setting things up, below.' : ''}</div>`
    : '';

  // Open by default when there is no real work, so an empty day does not look
  // like an empty dashboard — and closed when there is, so it stays out of the
  // way of the actual job.
  const setupBlock = setup.length
    ? `<details class="attn-setup"${work.length ? '' : ' open'}>
        <summary>${esc(setup.length)} thing${setup.length === 1 ? '' : 's'} still to set up</summary>
        <p class="note faint">One-off plumbing — done once by whoever sets the account up, not part of
          the daily job. Everything here is real and still needs doing.</p>
        ${setup.map(row).join('')}
      </details>`
    : '';

  // The headline counts the WORK, with setup named separately. Counting both
  // together said "3 need you" while all three sat folded away in the setup
  // block — a true total that pointed at nothing the reader could see.
  const head = headlineFor(work, setup, result);

  return `<div class="attn-block">
    <div class="attn-head"><b>${esc(head)}</b></div>
    ${nothingToDo}${rows}${more}${setupBlock}${skipped}
  </div>`;
}

/** "2 for information · 5 still to set up" — never a count you cannot see. */
export function headlineFor(work, setup, result) {
  if (!work.length && !setup.length) return attentionSummary(result);
  const c = { act: 0, watch: 0, info: 0 };
  for (const i of work) c[i.severity] = (c[i.severity] || 0) + 1;
  const parts = [];
  if (c.act) parts.push(`${c.act} need${c.act === 1 ? 's' : ''} you`);
  if (c.watch) parts.push(`${c.watch} worth a look`);
  if (c.info) parts.push(`${c.info} for information`);
  if (!parts.length) parts.push('Nothing needs you right now');
  if (setup.length) parts.push(`${setup.length} still to set up`);
  return parts.join(' · ');
}

/** Look an item up by the id its button carries. */
export function itemById(result, id) {
  return (result?.items || []).find((i) => i.id === id) || null;
}

/**
 * Attach the one delegated listener the block needs. `go` receives the item's
 * action; `expand` is called when "show N more" is pressed.
 */
export function wireAttention(root, result, handlers = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const more = t.closest('.attn-more');
    if (more) {
      if (typeof handlers.expand === 'function') handlers.expand();
      return;
    }
    const btn = t.closest('[data-attn]');
    if (!btn) return;
    const id = btn.dataset ? btn.dataset.attn : btn.getAttribute('data-attn');
    const item = itemById(result, id);
    if (item && typeof handlers.go === 'function') handlers.go(item.action, item);
  });
  return true;
}
