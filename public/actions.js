// R2.8 — the five things the owner actually came here to do.
//
// Scan cards · Import contacts · Create campaign · Review replies · View bookings.
//
// All five already existed, and every one of them was two or three clicks deep
// inside a tab inside a section. The point of naming them as primary actions is
// that the dashboard should answer "what needs me?" (R2.4) and then "what can I
// do?" without the owner having to remember which tab holds what.
//
// Two rules, both of which are really R2.9 arriving early:
//
//  1. A count on a button is a measurement or it is absent. "Review replies"
//     may say "3 waiting" only when three were counted. If the replies did not
//     load, the button says nothing rather than "0" — a zero would read as
//     "nobody has answered", which is a different and possibly false fact.
//  2. An action that cannot work yet still appears, and says why. Hiding
//     "Create campaign" until sending is configured would leave the owner
//     wondering where it went; greying it out with the reason is honest.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The five, in the order the work actually happens: get people in, reach them,
 * answer them, count what came of it.
 */
export const PRIMARY_ACTIONS = Object.freeze([
  {
    id: 'scan-cards',
    label: 'Scan cards',
    hint: 'Photograph business cards and read them into contacts.',
    go: { view: 'acquisition', tab: 'intake' },
  },
  {
    id: 'import-contacts',
    label: 'Import contacts',
    hint: 'Bring in a CSV. Nothing is written until you confirm the preview.',
    go: { view: 'acquisition', tab: 'intake' },
  },
  {
    id: 'create-campaign',
    label: 'Create campaign',
    hint: 'A message plus a cadence, pointed at a group. Composing is always safe.',
    go: { view: 'acquisition', tab: 'campaigns' },
  },
  {
    id: 'review-replies',
    label: 'Review replies',
    hint: 'Read what came back and answer it yourself.',
    go: { view: 'acquisition', tab: 'inbox' },
  },
  {
    id: 'view-bookings',
    label: 'View bookings',
    hint: 'Confirmed meetings only. Link clicks are counted separately.',
    go: { view: 'acquisition', tab: 'bookings' },
  },
]);

/**
 * Attach live counts and availability.
 *
 * @param {object} data
 * @param {Array}  [data.replies]   undefined = not loaded, which is NOT zero
 * @param {Array}  [data.bookings]
 * @param {Array}  [data.contacts]
 * @param {object} [data.readiness] the sending gate, if known
 * @param {function} [data.needsPerson] which replies are still waiting
 */
export function buildActions(data = {}) {
  const countOf = (arr, pick) => {
    if (!Array.isArray(arr)) return null; // not loaded — say nothing, never "0"
    return pick ? arr.filter(pick).length : arr.length;
  };

  const waiting = Array.isArray(data.replies)
    ? data.replies.filter((r) => (typeof data.needsPerson === 'function' ? data.needsPerson(r) : !r.handled)).length
    : null;

  return PRIMARY_ACTIONS.map((a) => {
    const out = { ...a, count: null, countLabel: '', note: '', available: true };

    if (a.id === 'review-replies') {
      out.count = waiting;
      out.countLabel = waiting === null ? '' : waiting === 0 ? 'none waiting' : `${waiting} waiting`;
    }
    if (a.id === 'view-bookings') {
      const n = countOf(data.bookings);
      out.count = n;
      out.countLabel = n === null ? '' : n === 0 ? 'none yet' : `${n}`;
    }
    if (a.id === 'import-contacts' || a.id === 'scan-cards') {
      const n = countOf(data.contacts);
      out.countLabel = n === null || n === 0 ? '' : `${n} so far`;
    }
    if (a.id === 'create-campaign') {
      // the action stays available: composing is safe and only sending is gated
      if (data.readiness && data.readiness.ready === false) {
        out.note = 'You can build and preview one; sending is still switched off.';
      } else if (!data.readiness) {
        out.note = 'Whether sending is possible is not known right now.';
      }
    }
    return out;
  });
}

/** The row itself. `loading` is distinct from "no counts". */
export function renderActions(actions, opts = {}) {
  const { loading = false } = opts;
  if (loading) return '<div class="actions-row"><div class="loading">Loading what you can do…</div></div>';
  if (!actions || !actions.length) return '';

  return `<div class="actions-row" role="group" aria-label="Primary actions">
    ${actions
      .map(
        (a) => `<button class="act" data-act="${esc(a.id)}" ${a.available ? '' : 'disabled'}>
          <span class="act-l">${esc(a.label)}${a.countLabel ? ` <span class="act-n">${esc(a.countLabel)}</span>` : ''}</span>
          <span class="act-h">${esc(a.note || a.hint)}</span>
        </button>`
      )
      .join('')}
  </div>`;
}

export function actionById(actions, id) {
  return (actions || []).find((a) => a.id === id) || null;
}

/** One delegated listener; `go` receives the destination. */
export function wireActions(root, actions, handlers = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const btn = t.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset ? btn.dataset.act : btn.getAttribute('data-act');
    const a = actionById(actions, id);
    if (a && typeof handlers.go === 'function') handlers.go(a.go, a);
  });
  return true;
}
