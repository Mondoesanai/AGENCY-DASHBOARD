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

function fixLabel(action) {
  return (
    {
      'link-repo': 'Link a repository',
      'reconnect-github': 'Reconnect GitHub',
      'check-repo': 'Check the repository',
      'fix-permissions': 'Fix permissions',
      'enable-agent': 'Turn automation on',
      'add-ai-key': 'Add the AI key',
      'owner-review': 'Review this yourself',
    }[action] || 'Fix this'
  );
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
