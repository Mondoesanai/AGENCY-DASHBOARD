// The landing screen: four questions, in the order they get asked.
//
//   What needs me?      (already lives in attention.js — not duplicated here)
//   What is coming up?  upcoming bookings
//   What is in flight?  work the system is currently doing
//   Is it all running?  automation health, as one line
//
// WHAT THIS SCREEN IS NOT FOR. Every setting, every metric, every technical
// status. Those have places of their own, and putting them here is what made
// the dashboard feel like a wall. Each block below is a summary with a way
// through to the detail, and anything that is not a summary belongs elsewhere.
//
// THE BOOKING STATES. Four outcomes that look alike on a quiet day and mean
// completely different things:
//
//   disconnected  no scheduler is connected, so a booking COULD NOT arrive
//   none          connected, working, nobody has booked
//   loading       we have not finished asking
//   failed        we asked and could not find out
//
// Collapsing these into "no bookings" is how a broken integration looks like a
// slow week for a month.

import { renderPanel, PANEL } from './states.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const BOOKING_STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  NONE: 'none',
  LOADING: 'loading',
  FAILED: 'failed',
  SOME: 'some',
});

/** Which of the five situations are we actually in? */
export function bookingState(data) {
  if (!data) return BOOKING_STATE.LOADING;
  if (data.error) return BOOKING_STATE.FAILED;
  if (data.connected === false) return BOOKING_STATE.DISCONNECTED;
  const list = data.bookings || [];
  return list.length ? BOOKING_STATE.SOME : BOOKING_STATE.NONE;
}

const when = (at) => {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return '';
  const days = Math.round((n - Date.now()) / 86400000);
  const d = new Date(n);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 0) return `${d.toDateString()} (past)`;
  return `${d.toDateString()} ${time}`;
};

export function renderBookings(data) {
  const state = bookingState(data);

  if (state === BOOKING_STATE.LOADING) {
    return renderPanel({ status: PANEL.LOADING }, { thing: 'upcoming bookings', loading: 'Checking the calendar…' });
  }
  if (state === BOOKING_STATE.FAILED) {
    return `<div class="note neg"><b>Could not check for bookings.</b> ${esc(data.error)}
      <div class="faint">This is not "no bookings" — the question was asked and not answered. Somebody may have booked.</div>
      <button class="btn sm ghost" data-retry="bookings">Try again</button></div>`;
  }
  if (state === BOOKING_STATE.DISCONNECTED) {
    return `<div class="note warn"><b>No scheduler is connected, so a booking could not arrive.</b>
      <div class="faint">Calendly has not been set up. Nothing is wrong with the calendar — there is no link between it and this
        dashboard yet, and every booking payload is refused until there is.</div>
      <button class="btn sm" data-go="settings">Connect it in Settings</button></div>`;
  }
  if (state === BOOKING_STATE.NONE) {
    return `<div class="note"><b>No bookings yet.</b>
      <div class="faint">The scheduler is connected and working — nobody has booked. This is a real "none", not a failed check.</div></div>`;
  }

  const list = (data.bookings || []).slice(0, 5);
  return `<div class="book-list">${list.map((b) => `
    <div class="book-row ${b.verified ? '' : 'tone-warn'}">
      <div class="book-when"><b>${esc(when(b.startAt))}</b></div>
      <div class="book-who">${esc(b.contactName || b.contactId || 'someone')}</div>
      <div class="faint">${esc(b.verified ? 'confirmed by the scheduler' : 'entered by hand — not confirmed by the scheduler')}</div>
    </div>`).join('')}
    ${(data.bookings || []).length > 5 ? `<div class="faint">and ${(data.bookings || []).length - 5} more</div>` : ''}
    <button class="btn sm ghost" data-go="acquisition">All bookings</button>
  </div>`;
}

/**
 * What the system is doing right now. Deliberately a count and a verb, not a
 * table — the table is one click away and does not belong on a landing screen.
 */
export function renderWork(data) {
  if (!data) return renderPanel({ status: PANEL.LOADING }, { thing: 'current work', loading: 'Looking…' });
  if (data.error) {
    return `<div class="note neg"><b>Could not read what is in progress.</b> ${esc(data.error)}</div>`;
  }
  const bits = [];
  if (data.revisions) bits.push(`${data.revisions} client request${data.revisions === 1 ? '' : 's'} in progress`);
  if (data.previewsOwed) bits.push(`${data.previewsOwed} preview${data.previewsOwed === 1 ? '' : 's'} to build`);
  if (data.followUpsDue) bits.push(`${data.followUpsDue} follow-up${data.followUpsDue === 1 ? '' : 's'} due`);
  if (data.queued) bits.push(`${data.queued} queued job${data.queued === 1 ? '' : 's'}`);

  if (!bits.length) {
    return `<div class="note"><b>Nothing in flight.</b>
      <div class="faint">No client requests, previews or follow-ups are outstanding.</div></div>`;
  }
  return `<div class="note"><b>${esc(bits[0])}</b>${bits.length > 1 ? ` · ${bits.slice(1).map(esc).join(' · ')}` : ''}
    <div class="work-actions">
      ${data.revisions ? '<button class="btn sm ghost" data-go="clients">Client requests</button>' : ''}
      ${(data.previewsOwed || data.followUpsDue) ? '<button class="btn sm ghost" data-go="followups">Follow-ups</button>' : ''}
    </div></div>`;
}

/**
 * Automation health as ONE line.
 *
 * It says whether things are running and when something last SUCCEEDED, not
 * merely when it last started — the distinction that made "last ran 3 minutes
 * ago" misleading on a system where loading this page pokes the tick.
 */
export function renderHealth(a) {
  if (!a) return renderPanel({ status: PANEL.LOADING }, { thing: 'automation health', loading: 'Checking…' });
  if (a.error) return `<div class="note warn"><b>Automation health is unknown.</b> ${esc(a.error)} — this is not an all-clear.</div>`;

  const workers = a.workers || [];
  const bad = workers.filter((w) => w.status === 'stalled' || w.status === 'never');
  const noSuccess = workers.filter((w) => w.hasOutcomeTelemetry && !w.lastSuccessAt);

  if (a.pause && a.pause.paused) {
    return `<div class="note warn"><b>Automation is paused.</b> Queued work is waiting, not lost. Replies and opt-outs still work.
      <button class="btn sm ghost" data-go="automations">Open automations</button></div>`;
  }
  if (bad.length) {
    return `<div class="note neg"><b>${esc(bad.map((w) => w.label).join(', '))} ${bad.length === 1 ? 'is' : 'are'} not running.</b>
      <div class="faint">Nothing they do is happening until that is fixed.</div>
      <button class="btn sm" data-go="automations">Open automations</button></div>`;
  }
  if (noSuccess.length) {
    return `<div class="note warn"><b>Running, but ${esc(noSuccess.map((w) => w.label).join(', '))} ${noSuccess.length === 1 ? 'has' : 'have'} not completed successfully.</b>
      <div class="faint">Starting is not the same as finishing.</div>
      <button class="btn sm ghost" data-go="automations">See why</button></div>`;
  }
  const newest = workers.reduce((m, w) => (w.lastSuccessAt && w.lastSuccessAt > (m?.lastSuccessAt || 0) ? w : m), null);
  return `<div class="note"><b>Everything is running.</b>
    ${newest ? `<span class="faint">Most recent completed work: ${esc(newest.label)}.</span>` : '<span class="faint">No completed work has been recorded yet.</span>'}
    <button class="btn sm ghost" data-go="automations">Details</button></div>`;
}

/** One delegated listener for every "go there" button on this screen. */
export function wireToday(root, handlers = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const go = t.closest('[data-go]');
    if (go) { if (typeof handlers.go === 'function') handlers.go(go.getAttribute('data-go')); return; }
    if (t.closest('[data-retry="bookings"]')) { if (typeof handlers.retry === 'function') handlers.retry(); }
  });
  return true;
}
