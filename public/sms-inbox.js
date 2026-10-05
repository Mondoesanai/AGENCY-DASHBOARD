// The unified inbox, with SMS as a first-class channel.
//
// One conversation per person, both channels in one thread, the contact's
// business context beside it, and the controls that decide who answers.
//
// Three things this screen is responsible for getting right:
//
//   · WHO OWNS THIS CONVERSATION has to be visible at a glance and changeable
//     in one click, because the moment that matters is the owner reading a
//     reply and wanting to answer it themselves before anything else does.
//   · ACCEPTED IS NOT DELIVERED. The provider taking a message is not the
//     carrier delivering it, and showing one as the other is how a number that
//     is silently failing looks healthy for a week.
//   · A DRAFT IS NOT A SENT MESSAGE. Composing shows what it will cost and
//     whether it is permitted; nothing leaves until someone presses send.

import { renderPanel, PANEL } from './states.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DELIVERY_WORD = Object.freeze({
  draft: 'Draft',
  scheduled: 'Scheduled',
  sending: 'Sending',
  accepted: 'Accepted by the provider',
  delivered: 'Delivered',
  failed: 'Failed',
  undelivered: 'Not delivered',
  unknown: 'Unconfirmed',
});

export const OWNER_WORD = Object.freeze({
  automatic: 'Answering automatically',
  'draft-only': 'Drafts only — you send',
  person: 'You have taken over',
});

const ago = (at) => {
  const ms = Date.now() - Number(at || 0);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/** The list of people waiting. Never claims "all answered" on a failed read. */
export function renderWaiting(data, opts = {}) {
  const { error = '' } = opts;
  if (error) return renderPanel({ status: PANEL.ERROR, error }, { thing: 'the inbox', retryKey: 'inbox' });
  if (!data) return renderPanel({ status: PANEL.LOADING }, { thing: 'the inbox', loading: 'Reading conversations…' });

  const list = data.conversations || [];
  if (!list.length) {
    return `<p class="note">Nobody is waiting for a reply. This is a real "nothing to do", not a failed read —
      if the inbox could not be loaded it would say so instead.</p>`;
  }
  return list.map((c) => {
    const last = c.lastInbound || {};
    const mode = (c.ownership && c.ownership.mode) || 'draft-only';
    return `<div class="sms-waiting" data-conv="${esc(c.contactId)}">
      <div class="sms-w-head">
        <b>${esc(c.contactId)}</b>
        <span class="pill sm ${last.channel === 'sms' ? '' : 'warn'}">${esc(last.channel || '')}</span>
        <span class="pill sm ${mode === 'person' ? '' : 'warn'}">${esc(OWNER_WORD[mode] || mode)}</span>
        <span class="faint">${esc(ago(last.at))}</span>
      </div>
      <div class="sms-w-body">${esc(String(last.body || '').slice(0, 160))}</div>
    </div>`;
  }).join('');
}

function bubble(m) {
  const out = m.direction === 'outbound';
  const state = m.state ? DELIVERY_WORD[m.state] || m.state : null;
  // accepted and delivered are deliberately different words on screen
  const tone = m.state === 'failed' || m.state === 'undelivered' ? 'neg'
    : m.state === 'delivered' ? 'good'
      : m.state === 'unknown' ? 'warn' : '';
  return `<div class="sms-msg ${out ? 'out' : 'in'}">
    <div class="sms-msg-meta">
      <span class="pill sm">${esc(m.channel)}</span>
      ${out ? `<span class="faint">${esc(m.by === 'automatic' ? 'sent automatically' : 'sent by you')}</span>` : '<span class="faint">they wrote</span>'}
      <span class="faint">${esc(ago(m.at))}</span>
      ${state ? `<span class="pill sm ${tone}">${esc(state)}</span>` : ''}
    </div>
    <div class="sms-msg-body">${esc(m.body)}</div>
  </div>`;
}

/**
 * One conversation: the thread, who owns it, the contact's context, and the
 * composer with its cost and permission shown before anything is sent.
 */
export function renderConversation(data, opts = {}) {
  // `body` is what the owner has typed. It is passed in rather than read from
  // the DOM because re-rendering replaces the textarea, and losing someone's
  // half-written message to a repaint is the kind of small betrayal that makes
  // people stop trusting a screen.
  const { error = '', draft = null, busy = false, body = '' } = opts;
  if (error) return renderPanel({ status: PANEL.ERROR, error }, { thing: 'this conversation', retryKey: 'conversation' });
  if (!data) return renderPanel({ status: PANEL.LOADING }, { thing: 'this conversation', loading: 'Opening…' });

  const conv = data.conversation || {};
  const msgs = conv.messages || [];
  const mode = (conv.ownership && conv.ownership.mode) || 'draft-only';
  const paused = conv.paused || {};

  const control = `<div class="note ${mode === 'person' ? '' : 'warn'}">
    <b>${esc(OWNER_WORD[mode] || mode)}.</b>
    ${mode === 'automatic' ? 'Replies may be sent without you seeing them first, within the turn limit.' : ''}
    ${mode === 'draft-only' ? 'Nothing goes out until you send it.' : ''}
    ${mode === 'person' ? 'Nothing automatic will answer this person. Any queued reply was cancelled.' : ''}
    <div class="sms-controls">
      ${mode !== 'person' ? '<button class="btn sm" id="smsTakeOver">Take over</button>' : ''}
      ${mode !== 'draft-only' ? '<button class="btn sm ghost" data-mode="draft-only">Drafts only</button>' : ''}
      ${mode !== 'automatic' ? '<button class="btn sm ghost" data-mode="automatic">Let it answer</button>' : ''}
      <button class="btn sm ghost" data-pause="${paused.paused ? 'resume' : 'pause'}">${paused.paused ? 'Resume this person' : 'Pause this person'}</button>
    </div>
  </div>`;

  const pausedNote = paused.paused
    ? `<div class="note warn"><b>Paused.</b> ${esc(paused.reason || 'Nothing scheduled will go to them.')}</div>`
    : '';

  const composer = `<div class="sms-composer">
    <textarea id="smsBody" rows="3" placeholder="Write a text…">${esc(body || (draft && draft.body) || '')}</textarea>
    ${draft ? `<div class="note ${draft.ok ? '' : 'neg'}">
        ${draft.ok
          ? `<b>${esc(draft.cost.segments)} segment${draft.cost.segments === 1 ? '' : 's'}</b> · about ${esc((draft.cost.estimatedCents / 100).toFixed(3))} — an estimate, not a bill.
             ${draft.sendableNow ? '' : '<br />Outside their quiet hours, so it would be held until morning.'}`
          : `<b>Cannot send.</b> ${esc(draft.reason || draft.error || 'no reason was given, which is itself a bug worth reporting')}`}
      </div>` : ''}
    <div class="sms-composer-actions">
      <button class="btn sm ghost" id="smsPreview" ${busy ? 'disabled' : ''}>Check it</button>
      <button class="btn sm" id="smsSend" ${busy || !draft || !draft.ok ? 'disabled' : ''}>${busy ? 'Working…' : 'Send'}</button>
    </div>
    <div class="faint">Checking shows the cost and whether it is permitted. Nothing is sent until you press send.</div>
  </div>`;

  return `${control}${pausedNote}
    <div class="sms-thread">${msgs.length ? msgs.map(bubble).join('') : '<p class="note">No messages yet.</p>'}</div>
    ${composer}`;
}

/** Counts, with the distinctions kept apart. */
export function renderSmsStats(s) {
  if (!s) return '';
  const sms = s.sms || {};
  const pv = s.previews || {};
  return `<div class="note">
    <b>Texts:</b> ${esc(sms.attempted || 0)} attempted · ${esc(sms.delivered || 0)} confirmed delivered ·
    ${esc(sms.deliveryUnknown || 0)} never confirmed · ${esc(sms.failed || 0)} failed.
    <div class="faint">Accepted by the provider is not the same as delivered by the carrier, so they are counted separately.
      Cost ${esc(((sms.estimatedCents || 0) / 100).toFixed(2))} is an <b>estimate</b> until provider billing is reconciled.</div>
    <div><b>Previews:</b> ${esc(pv.promised || 0)} promised · ${esc(pv.delivered || 0)} delivered ·
      ${esc(pv.brokenPromises || 0)} still owed.</div>
  </div>`;
}

/** One delegated listener for the whole inbox. */
export function wireSmsInbox(root, handlers = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const conv = t.closest('[data-conv]');
    if (conv) { if (typeof handlers.open === 'function') handlers.open(conv.getAttribute('data-conv')); return; }
    if (t.closest('#smsTakeOver')) { if (typeof handlers.takeOver === 'function') handlers.takeOver(); return; }
    const mode = t.closest('[data-mode]');
    if (mode) { if (typeof handlers.mode === 'function') handlers.mode(mode.getAttribute('data-mode')); return; }
    const pause = t.closest('[data-pause]');
    if (pause) { if (typeof handlers.pause === 'function') handlers.pause(pause.getAttribute('data-pause') === 'pause'); return; }
    if (t.closest('#smsPreview')) { if (typeof handlers.preview === 'function') handlers.preview(); return; }
    if (t.closest('#smsSend')) { if (typeof handlers.send === 'function') handlers.send(); return; }
    if (t.closest('[data-retry="inbox"]') || t.closest('[data-retry="conversation"]')) {
      if (typeof handlers.retry === 'function') handlers.retry();
    }
  });
  return true;
}
