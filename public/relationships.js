// The business-card-to-follow-up workflow, on screen.
//
// What this screen has to answer, for every person who handed over a card:
// which path are they on, WHY, what happens next, and when. All four, visible
// without clicking, and all four editable — because the routing is a
// suggestion from what was typed at intake, and the person who was actually
// there is the authority on it.
//
// The thing it must never do is show a preview as sendable when no preview
// exists. That state comes from the task, not from the path.

import { renderPanel, PANEL } from './states.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const PATH_WORD = Object.freeze({
  'preview-requested': 'Asked for a preview',
  conversation: 'Wants a conversation',
  'follow-up-later': 'Follow up later',
  'gentle-intro': 'Met, nothing specific',
  'group-context': 'Same group, never met',
  'low-priority-good-site': 'Already has a good site',
  ended: 'Ended',
});

export const PREVIEW_WORD = Object.freeze({
  requested: 'Requested',
  'in-progress': 'Being built',
  ready: 'Ready to send',
  delivered: 'Sent to them',
  reviewed: 'They looked at it',
  abandoned: 'Not going ahead',
});

const when = (at) => {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return 'nothing scheduled';
  const days = Math.round((n - Date.now()) / 86400000);
  const date = new Date(n).toDateString();
  // A day late is LATE. Rounding it to "due now" understates a promise to a
  // real person that has already been missed, which is the one direction this
  // wording must not err in.
  if (days < 0) return `${date} — ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  if (days === 0) return `${date} — due today`;
  if (days === 1) return `${date} — tomorrow`;
  return `${date} — in ${days} days`;
};

/** One line for the Overview: how many promises are owed, and how many are late. */
export function headline(data) {
  if (!data) return { word: 'loading', tone: '', detail: '' };
  const due = (data.followUps && data.followUps.due) || [];
  const previews = (data.previews && data.previews.tasks) || [];
  const late = due.filter((d) => d.dueAt && d.dueAt < Date.now()).length;
  const owed = previews.filter((p) => p.state === 'requested' || p.state === 'in-progress').length;
  if (!due.length && !owed) return { word: 'nothing due', tone: '', detail: 'No follow-up has come round yet.' };
  if (late) return { word: `${late} follow-up${late === 1 ? '' : 's'} overdue`, tone: 'neg', detail: 'Someone was promised something and has not heard back.' };
  return {
    word: `${due.length} follow-up${due.length === 1 ? '' : 's'} due`,
    tone: 'warn',
    detail: owed ? `${owed} preview${owed === 1 ? '' : 's'} still to build.` : '',
  };
}

function previewBlock(task) {
  if (!task) return '';
  const ready = task.state === 'ready' || task.state === 'delivered' || task.state === 'reviewed';
  return `<div class="rel-preview ${ready ? 'ok' : 'warn'}">
    <b>Preview:</b> ${esc(PREVIEW_WORD[task.state] || task.state)}
    ${task.url ? ` — <a href="${esc(task.url)}" target="_blank" rel="noopener">open it</a>` : ''}
    ${!ready ? '<div class="faint">Nothing may be sent saying their preview is ready until it is built and has a link.</div>' : ''}
    <div class="rel-preview-actions">
      ${task.state === 'requested' ? `<button class="btn sm ghost" data-pv="in-progress" data-task="${esc(task.id)}">Start building</button>` : ''}
      ${task.state === 'in-progress' ? `<button class="btn sm" data-pv="ready" data-task="${esc(task.id)}">Mark ready (needs a link)</button>` : ''}
      ${task.state === 'ready' ? `<button class="btn sm" data-pv="delivered" data-task="${esc(task.id)}">Mark as sent</button>` : ''}
    </div>
  </div>`;
}

function row(rel, previews) {
  const task = (previews || []).find((p) => p.contactId === rel.contactId) || null;
  const overdue = rel.dueAt && rel.dueAt < Date.now();
  const i = rel.interaction || {};
  const met = i.encounter === 'conversation';
  return `<div class="rel-row ${overdue ? 'tone-neg' : ''}" data-contact="${esc(rel.contactId)}">
    <div class="rel-head">
      <span class="pill sm ${overdue ? 'neg' : ''}">${esc(PATH_WORD[rel.path] || rel.path)}</span>
      ${rel.editedAt ? '<span class="pill sm">edited by you</span>' : ''}
      ${met ? '' : '<span class="pill sm warn">never met — do not say you did</span>'}
    </div>
    <div class="rel-why"><b>Why:</b> ${esc(rel.why)}</div>
    <div class="rel-next"><b>Next:</b> ${esc(rel.nextAction)}</div>
    <div class="rel-when"><b>When:</b> ${esc(when(rel.dueAt))}</div>
    ${i.notes ? `<div class="faint rel-notes">${esc(i.notes)}</div>` : ''}
    ${previewBlock(task)}
    <div class="rel-actions">
      <button class="btn sm ghost" data-rel-edit="${esc(rel.contactId)}">Change the plan</button>
      <button class="btn sm ghost" data-rel-open="${esc(rel.contactId)}">Open conversation</button>
    </div>
  </div>`;
}

export function renderRelationships(data, opts = {}) {
  const { error = '', busy = false } = opts;
  if (error) return renderPanel({ status: PANEL.ERROR, error }, { thing: 'the follow-up list', retryKey: 'relationships' });
  if (!data) return renderPanel({ status: PANEL.LOADING }, { thing: 'the follow-up list', loading: 'Reading what you promised people…' });

  // every relationship, soonest first — not only the ones that have come round.
  // Someone filed under the wrong path a week ago is only fixable if they are
  // visible before their date arrives.
  const all = (data.followUps && data.followUps.all) || (data.followUps && data.followUps.due) || [];
  const previews = (data.previews && data.previews.tasks) || [];
  const h = headline(data);

  const unbuilt = previews.filter((p) => p.state === 'requested' || p.state === 'in-progress');
  const buildQueue = unbuilt.length
    ? `<div class="note warn"><b>${unbuilt.length} preview${unbuilt.length === 1 ? '' : 's'} promised and not built.</b>
         Until each one exists at a working link, nothing can tell those people it is ready.
         ${unbuilt.map((p) => `<div class="rel-queue-item">${esc(p.businessName || p.contactId)} — ${esc(PREVIEW_WORD[p.state])}${p.conversationNotes ? `<span class="faint"> · ${esc(p.conversationNotes.slice(0, 90))}</span>` : ''}</div>`).join('')}
       </div>`
    : '';

  const rows = all.length
    ? all.map((r) => row(r, previews)).join('')
    : `<p class="note">Nobody here yet. People appear once you scan a business card or import a group list —
         with the path they were put on, why, and what happens next.</p>`;

  return `<div class="note ${h.tone === 'good' ? '' : h.tone}"><b>${esc(h.word)}</b>${h.detail ? ` — ${esc(h.detail)}` : ''}</div>
    ${buildQueue}
    ${rows}
    <p class="note faint">Everyone here came from a business card or a shared group. None of them can be put into a
      cold campaign — the system refuses it — because the first message to someone you have met should not read
      like the first message to someone you have not.</p>`;
}

/** One delegated listener: edit a plan, move a preview along, open a thread. */
export function wireRelationships(root, handlers = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const edit = t.closest('[data-rel-edit]');
    if (edit) { if (typeof handlers.edit === 'function') handlers.edit(edit.getAttribute('data-rel-edit')); return; }
    const open = t.closest('[data-rel-open]');
    if (open) { if (typeof handlers.open === 'function') handlers.open(open.getAttribute('data-rel-open')); return; }
    const pv = t.closest('[data-pv]');
    if (pv) {
      if (typeof handlers.preview === 'function') handlers.preview(pv.getAttribute('data-task'), pv.getAttribute('data-pv'));
      return;
    }
    if (t.closest('[data-retry="relationships"]')) {
      if (typeof handlers.retry === 'function') handlers.retry();
    }
  });
  return true;
}
