// R2.2 — a client's own work lives on that client's card.
//
// The dashboard already gave each client analytics, to-dos, their report and
// their settings. Revisions were the exception: every client's change requests
// sat in one global list, so answering "what is outstanding for Renewity?"
// meant scanning a shared queue and filtering by eye.
//
// That is exactly the scattering R2.2 is about. The global queue stays — it is
// the right view for "what needs doing today" — but each client now also sees
// their own, with the state machine's blocked reason rendered where the person
// who can fix it will actually look (R1.5, which until now had no UI).

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tickets belonging to one client, newest first. */
export function ticketsForSlug(tickets, slug) {
  return (tickets || [])
    .filter((t) => t.slug === slug)
    .sort((a, b) => (b.at || b.createdAt || 0) - (a.at || a.createdAt || 0));
}

export const STATE_LABEL = Object.freeze({
  queued: 'waiting to start',
  validating: 'checking',
  running: 'being worked on',
  awaiting_review: 'shipped, confirming it went live',
  succeeded: 'done',
  retryable: 'failed, will retry',
  blocked: 'stuck — needs you',
  cancelled: 'cancelled',
});

/** Which tickets need the owner rather than the machine. */
export function needsOwner(tickets) {
  return (tickets || []).filter((t) => t.state === 'blocked' || t.needsOwner === true);
}

export function renderClientRevisions(state) {
  const { tickets = [], slug, loading = false, revisionsConfigured = true } = state;

  if (loading) return '<div class="loading">Loading this client\'s requests…</div>';

  if (!revisionsConfigured) {
    return `<div class="note">The revision inbox is not connected, so change requests from this client
      are not being picked up automatically. Nothing has been missed — there is simply nothing watching yet.</div>`;
  }

  const mine = ticketsForSlug(tickets, slug);
  if (!mine.length) {
    return `<div class="note"><b>No change requests from this client.</b> When they email one in, it
      appears here and on the Automations queue. An empty list means none have arrived — not that any were lost.</div>`;
  }

  const stuck = needsOwner(mine);
  const head = stuck.length
    ? `<div class="note warn"><b>${stuck.length} request${stuck.length === 1 ? '' : 's'} stuck and waiting on you.</b>
         The work is saved and resumes by itself once the cause is fixed.</div>`
    : '<div class="note">Nothing here is waiting on you.</div>';

  const rows = mine
    .map((t) => {
      const label = STATE_LABEL[t.state] || t.state || 'unknown';
      const isStuck = t.state === 'blocked' || t.needsOwner;
      // R1.5 finally rendered: the actionable recovery text, next to the thing
      // that is stuck, for the person who can actually fix it.
      const fix = t.blockedBy
        ? `<div class="note warn" style="margin-top:6px">
             <b>${esc(t.blockedBy.label || 'Needs attention')}</b>
             ${t.blockedBy.hint ? `<br />${esc(t.blockedBy.hint)}` : ''}
             ${t.blockedBy.action ? `<br /><button class="btn sm" data-fix="${esc(t.blockedBy.action)}" data-slug="${esc(slug)}">${esc(fixLabel(t.blockedBy.action))}</button>` : ''}
           </div>`
        : '';
      return `<div class="acq-card">
        <div class="acq-card-h">
          <span class="pill sm ${isStuck ? 'warn' : ''}">${esc(label)}</span>
          <span class="faint" style="margin-left:auto">${t.at ? new Date(t.at).toLocaleDateString() : ''}</span>
        </div>
        <div>${esc(t.summary || t.request || '(no description recorded)')}</div>
        ${t.attempts ? `<div class="faint">${t.attempts} attempt${t.attempts === 1 ? '' : 's'}</div>` : ''}
        ${fix}
      </div>`;
    })
    .join('');

  return `${head}${rows}`;
}

// ---------------------------------------------------------------------------
// What each recovery button actually DOES.
//
// The first version of this file rendered the buttons and wired nothing to
// them, which is worse than no button: it tells the owner there is a fix one
// click away and then does nothing when they click it. Each action here either
// takes them to the control that fixes it, or says plainly that the fix is not
// in this dashboard and names the exact thing to change.
//
// `pane` + `focus` — the fix lives in the UI; go there and put the cursor on it.
// `env`            — the fix is a Vercel environment variable; say which one.
// neither          — the fix is outside the product; say so rather than pretend.
// ---------------------------------------------------------------------------
const FIX_ACTIONS = Object.freeze({
  'link-repo': {
    label: 'Link a repository',
    pane: 'settings',
    focus: '#cf_repo',
    message:
      'Settings is open below — put this site’s repository in the GitHub repo field (or use “Find / pick repo”) and Save. The request stays queued and resumes by itself.',
  },
  'check-repo': {
    label: 'Check the repository',
    pane: 'settings',
    focus: '#cf_repo',
    message:
      'Settings is open below. Confirm the repository name still matches GitHub — it may have been renamed, deleted, made private, or shared with another client. Nothing is lost while it is wrong.',
  },
  'fix-permissions': {
    label: 'Fix permissions',
    pane: 'settings',
    focus: '#cf_repo',
    env: 'GITHUB_TOKEN',
    message:
      'The token can see this repository but cannot write to it. Re-issue GITHUB_TOKEN on GitHub with Contents: read & write for this repo, then update it in Vercel → Settings → Environment Variables. The repository below is the one it needs access to. Nothing needs re-sending.',
  },
  'enable-agent': {
    label: 'Turn automation on',
    pane: 'settings',
    expand: '#agentDetail',
    focus: '#agentToggle',
    message:
      'Automation is switched off for this site, so queued requests are not worked. The automation box below is open — turn it on and the queue picks up on the next cycle.',
  },
  'reconnect-github': {
    label: 'Reconnect GitHub',
    env: 'GITHUB_TOKEN',
    message:
      'This one is not in the dashboard. GITHUB_TOKEN is missing in Vercel → Settings → Environment Variables. Add it and redeploy; the request resumes on the next cycle — nothing needs re-sending.',
  },
  'add-ai-key': {
    label: 'Add the AI key',
    env: 'ANTHROPIC_API_KEY',
    message:
      'This one is not in the dashboard. ANTHROPIC_API_KEY is missing in Vercel → Settings → Environment Variables, so no work can be planned. Add it and redeploy; the request resumes on the next cycle.',
  },
  'owner-review': {
    label: 'Review this yourself',
    message:
      'This cannot be done by editing the site’s files — it depends on something outside the code (a third-party dashboard, a live database value, DNS, or billing). It needs you to handle it and then mark the request done.',
  },
});

/** The words on the button. Every label here has a handler in FIX_ACTIONS. */
function fixLabel(action) {
  return FIX_ACTIONS[action]?.label || 'Fix this';
}

export const FIX_HANDLED = Object.freeze(Object.keys(FIX_ACTIONS));

/**
 * Carry out a recovery action. Pure apart from the callbacks handed in, so the
 * real click path can be driven in a test without a browser.
 * Returns what it did — never throws on an action it does not know.
 */
export function applyFix(action, ctx = {}) {
  const { slug, switchPane, focus, expand } = ctx;
  const spec = FIX_ACTIONS[action];

  if (!spec) {
    return {
      action: action || null,
      slug: slug || null,
      handled: false,
      pane: null,
      focused: null,
      expanded: null,
      env: null,
      message:
        'There is no shortcut for this one yet — open the request in the Automations queue to see the full reason. Nothing has been lost.',
    };
  }

  let pane = null;
  let focused = null;
  let expanded = null;

  if (spec.pane && typeof switchPane === 'function') {
    switchPane(spec.pane);
    pane = spec.pane;
  }
  if (spec.expand && typeof expand === 'function') {
    expand(spec.expand);
    expanded = spec.expand;
  }
  if (spec.focus && typeof focus === 'function') {
    focus(spec.focus);
    focused = spec.focus;
  }

  return {
    action,
    slug: slug || null,
    handled: true,
    pane,
    focused,
    expanded,
    env: spec.env || null,
    message: spec.message,
  };
}

/**
 * Attach the one delegated click handler the rendered buttons need.
 * `ui` supplies `switchPane`, `focus`, `expand` and `note`; any it leaves out
 * is simply skipped, so a partly-wired host degrades to showing the message
 * rather than throwing.
 */
export function wireFixButtons(root, ui = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-fix]') : null;
    if (!btn) return;
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const read = (k) => (btn.dataset ? btn.dataset[k] : btn.getAttribute && btn.getAttribute(`data-${k}`));
    const result = applyFix(read('fix'), {
      slug: read('slug'),
      switchPane: ui.switchPane,
      focus: ui.focus,
      expand: ui.expand,
    });
    if (typeof ui.note === 'function') ui.note(result.message, btn, result);
  });
  return true;
}

/** A one-line summary for the client card header. */
export function revisionSummary(tickets, slug) {
  const mine = ticketsForSlug(tickets, slug);
  if (!mine.length) return { count: 0, stuck: 0, text: 'no requests' };
  const stuck = needsOwner(mine).length;
  const open = mine.filter((t) => !['succeeded', 'cancelled'].includes(t.state)).length;
  return {
    count: mine.length,
    open,
    stuck,
    text: stuck ? `${stuck} stuck` : open ? `${open} open` : 'all done',
  };
}
