// R9.7 + R9.8 — the optimisation ledger, the owner's bounds, and the six
// prohibitions, on screen.
//
// R9.7's whole stated value is being able to open the dashboard in six weeks
// and answer "when did this change, who changed it, and what was it before?".
// A ledger no screen reads cannot answer that, so until this panel existed the
// requirement was satisfied in the store and nowhere the owner could reach. It
// is one of the few places in this build where the interface IS the feature.
//
// Three things it must not do:
//
//  1. Show an empty ledger as "nothing has changed". A failed request and a
//     quiet week look identical in an empty array, and the difference matters
//     most exactly when someone is trying to work out what happened.
//  2. Offer an undo for a change that cannot be undone. A disabled button with
//     a reason beats a button that fails.
//  3. State the bounds from the defaults. They are settings; if the stored
//     value could not be read, that is what the panel says.

import { renderPanel, PANEL } from './states.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const KIND_WORD = Object.freeze({
  'experiment-created': 'experiment created',
  'experiment-state-changed': 'started or stopped',
  'variants-changed': 'arms edited',
  'contact-reassigned': 'someone moved between arms',
  'weights-changed': 'traffic split changed',
  'bounds-changed': 'limits changed',
});

const when = (at) => {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return 'at an unknown time';
  return new Date(n).toLocaleString();
};

/** A change can be undone only if it recorded what the value was before. */
export function undoability(c) {
  if (!c) return { can: false, why: 'there is no change here' };
  if (c.reverted) return { can: false, why: `already undone${c.revertedAt ? ` on ${when(c.revertedAt)}` : ''}` };
  if (c.before === null || c.before === undefined) {
    return { can: false, why: 'this change recorded no previous value, so there is nothing to put back' };
  }
  return { can: true, why: '' };
}

/** One-line summary for the tile. Never "all quiet" on a failed read. */
export function headline(data, { error = '' } = {}) {
  if (error) return { word: 'cannot tell', tone: 'warn', detail: 'The change history could not be read. This is not the same as no changes.' };
  if (!data) return { word: 'loading', tone: '', detail: '' };
  const changes = Array.isArray(data.changes) ? data.changes : [];
  const auto = changes.filter((c) => c.actor === 'automatic');
  if (!changes.length) return { word: 'no changes recorded', tone: '', detail: 'Nothing has altered an experiment since this log started.' };
  if (auto.length) {
    return {
      word: `${auto.length} automatic change${auto.length === 1 ? '' : 's'}`,
      tone: 'warn',
      detail: `${changes.length} change${changes.length === 1 ? '' : 's'} in total. Automatic ones are listed first.`,
    };
  }
  return {
    word: `${changes.length} change${changes.length === 1 ? '' : 's'}, all by you`,
    tone: 'good',
    detail: `Most recent: ${when(changes[0] && changes[0].at)}.`,
  };
}

function boundsBox(b) {
  if (!b) return '<div class="note warn"><b>The limits could not be read.</b> Treat nothing here as permitted until this loads.</div>';
  const unreadable = b.unreadable
    ? `<br /><b>These are the strictest defaults, not your saved settings</b> — the stored limits could not be read,
       and unknown limits are treated as the tightest ones rather than the loosest.`
    : '';
  return `<div class="note ${b.allowAutomaticChanges ? 'warn' : ''}">
    <b>${b.allowAutomaticChanges ? 'Automatic changes are switched ON.' : 'Nothing changes an experiment by itself.'}</b>
    ${b.allowAutomaticChanges
      ? `Within your limits: no single change may move more than
         ${esc(Math.round((b.maxWeightShiftPerChange || 0) * 100))}% of traffic, and no more than
         ${esc(b.maxChangesPerWeek)} change${b.maxChangesPerWeek === 1 ? '' : 's'} a week.`
      : 'Every change below was made by you. Turning this on is a settings change, and automation can never turn it on or widen these limits itself.'}
    ${b.requireOwnerForStateChange ? '<br />Starting and stopping an experiment stays your decision.' : ''}
    ${b.requireOwnerForReassignment ? '<br />So does moving anyone between arms.' : ''}
    ${unreadable}
  </div>`;
}

function prohibitionBox(domains) {
  const list = Array.isArray(domains) ? domains : [];
  if (!list.length) return '';
  return `<details class="note"><summary><b>Six things no experiment may touch</b></summary>
    <div class="faint" style="margin-top:6px">Checked in the wording of every arm, not just in what the experiment says it is testing —
      a price hidden in a subject-line test is still a price test.</div>
    ${list
      .map(
        (d) => `<div class="prohibit-row"><b>${esc(d.label)}</b>
          <div>${esc(d.rule)}</div>
          <div class="faint">${esc(d.why)}</div></div>`
      )
      .join('')}
  </details>`;
}

function changeRow(c, { busy = false } = {}) {
  const u = undoability(c);
  const kind = KIND_WORD[c.kind] || c.kind;
  return `<div class="change-row ${c.actor === 'automatic' ? 'tone-warn' : ''}">
    <div class="change-h">
      <b>${esc(kind)}</b>
      <span class="pill sm ${c.actor === 'automatic' ? 'warn' : ''}">${esc(c.actor === 'automatic' ? 'automatic' : 'you')}</span>
      ${c.reverted ? '<span class="pill sm">undone</span>' : ''}
    </div>
    <div class="faint">${esc(c.target || 'no target recorded')} · ${esc(when(c.at))}</div>
    ${c.reason ? `<div>${esc(c.reason)}</div>` : ''}
    <div class="change-undo">
      ${u.can
        ? `<button class="btn sm ghost" data-undo="${esc(c.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Put it back'}</button>`
        : `<button class="btn sm ghost" disabled title="${esc(u.why)}">Cannot be undone</button>
           <span class="faint">${esc(u.why)}</span>`}
    </div>
  </div>`;
}

/**
 * The panel. `error` and a missing `data` are different states and are
 * rendered differently — a failed read must never look like a quiet week.
 */
export function renderOptimisation(data, opts = {}) {
  const { error = '', busy = false, busyId = '' } = opts;
  if (error) {
    return renderPanel({ status: PANEL.ERROR, error }, { thing: 'the change history', retryKey: 'optimisation' });
  }
  if (!data) {
    return renderPanel({ status: PANEL.LOADING }, { thing: 'the change history', loading: 'Reading the change history…' });
  }

  const changes = Array.isArray(data.changes) ? data.changes : [];
  // automatic changes first: they are the ones nobody chose to make, so they
  // are what someone opening this panel is looking for
  const ordered = [...changes].sort((a, b) => {
    const aa = a.actor === 'automatic' ? 0 : 1;
    const bb = b.actor === 'automatic' ? 0 : 1;
    return aa !== bb ? aa - bb : Number(b.at || 0) - Number(a.at || 0);
  });

  const h = headline(data, { error });
  const rows = ordered.length
    ? ordered.map((c) => changeRow(c, { busy: busy && busyId === c.id })).join('')
    : `<p class="note">No change has been recorded yet. This log started empty and nothing has altered an
         experiment since — which is different from the history being unavailable, and that difference is why
         this says "nothing recorded" rather than "all fine".</p>`;

  return `<div class="note ${h.tone === 'good' ? '' : h.tone}"><b>${esc(h.word)}</b>${h.detail ? ` — ${esc(h.detail)}` : ''}</div>
    ${boundsBox(data.bounds)}
    ${prohibitionBox(data.domains)}
    ${rows}
    <p class="note faint">Every entry stores what the value was before it changed, which is what makes
      "put it back" possible. An entry that recorded no previous value says so instead of offering a button
      that would fail.</p>`;
}

/** One delegated listener for the undo buttons and the retry. */
export function wireOptimisation(root, handlers = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const undo = t.closest('[data-undo]');
    if (undo) {
      const id = undo.getAttribute('data-undo');
      if (id && typeof handlers.undo === 'function') handlers.undo(id);
      return;
    }
    if (t.closest('[data-retry="optimisation"]')) {
      if (typeof handlers.retry === 'function') handlers.retry();
    }
  });
  return true;
}
