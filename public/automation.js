// R2.6 — the automation panel: what is actually running, from real check-ins.
//
// What this replaces: a tile that counted down to the next scheduled run. It
// counted down whether or not anything was alive, so a worker that died at 3am
// produced the same reassuring clock as one that ran a minute ago.
//
// Every line here comes from a timestamp a worker wrote when it ran. Where
// there is no timestamp, the panel says it cannot tell — never "fine".

import { renderPanel, PANEL } from './states.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const STATUS_WORD = Object.freeze({
  ok: 'running',
  slow: 'slower than usual',
  stalled: 'stalled',
  never: 'never run',
  unknown: 'cannot tell',
  paused: 'paused',
});

/** Which visual weight a status gets. Severity, not decoration. */
export const STATUS_TONE = Object.freeze({
  ok: 'good',
  slow: 'warn',
  stalled: 'neg',
  never: 'neg',
  unknown: 'warn',
  paused: 'warn',
});

/**
 * The one-line answer for the Overview tile.
 * It must never say "running" on the strength of a config flag.
 */
export function headline(a) {
  if (!a) return { word: 'cannot tell', tone: 'warn', detail: 'The automation has not reported in yet.' };
  if (a.pause?.paused) {
    return {
      word: 'paused',
      tone: 'warn',
      detail: `You paused it${a.pause.by ? ` (${a.pause.by})` : ''}${a.pause.reason ? ` — ${a.pause.reason}` : ''}. Nothing new is being started.`,
    };
  }
  const bad = (a.workers || []).filter((w) => w.status === 'stalled' || w.status === 'never');
  if (bad.length) {
    return {
      word: bad.length === 1 ? `${bad[0].label} stalled` : `${bad.length} stalled`,
      tone: 'neg',
      detail: bad.map((w) => `${w.label}: ${w.text}`).join(' '),
    };
  }
  if (a.anyUnknown) {
    return { word: 'partly unknown', tone: 'warn', detail: 'At least one worker’s last run could not be read. This is not an all-clear.' };
  }
  const slow = (a.workers || []).filter((w) => w.status === 'slow');
  if (slow.length) return { word: 'running slowly', tone: 'warn', detail: slow.map((w) => `${w.label}: ${w.text}`).join(' ') };
  if (a.allOk) {
    const newest = (a.workers || []).reduce((m, w) => (w.lastAt && w.lastAt > (m?.lastAt || 0) ? w : m), null);
    return { word: 'running', tone: 'good', detail: newest ? `Most recent check-in: ${esc(newest.label)} ${esc(newest.text.replace(/^Last ran /, ''))}` : '' };
  }
  return { word: 'cannot tell', tone: 'warn', detail: 'No worker reported a usable last-run time.' };
}

/**
 * The full panel. `error` and a missing `a` are different: one is a failed
 * request, the other is a request still in flight.
 */
export function renderAutomation(a, opts = {}) {
  const { error = '', busy = false } = opts;

  if (error) {
    return renderPanel({ status: PANEL.ERROR, error }, { thing: 'the automation status', retryKey: 'automation' });
  }
  if (!a) return renderPanel({ status: PANEL.LOADING }, { thing: 'the automation status', loading: 'Checking what is running…' });

  const h = headline(a);

  const pauseBox = a.pause?.paused
    ? `<div class="note warn">
         <b>Automation is paused.</b> ${a.pause.at ? `Since ${esc(new Date(a.pause.at).toLocaleString())}` : ''}${a.pause.by ? `, by ${esc(a.pause.by)}` : ''}${a.pause.reason ? ` — ${esc(a.pause.reason)}` : ''}.
         <br />Queued work is <b>not lost</b>; it waits. Replies and opt-outs are still honoured, because
         stopping those would cause the harm pausing is meant to avoid. Client reports and billing emails
         are <b>not</b> paused — those are commitments to paying clients, not automation.
         <br /><button class="btn sm" id="autoResume" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Resume automation'}</button>
       </div>`
    : `<div class="note">
         <b>Automation is running.</b> Pausing stops new site work and outreach sending.
         It does not stop replies, opt-outs, client reports or billing emails.
         <br /><button class="btn sm ghost" id="autoPause" ${busy ? 'disabled' : ''}>${busy ? 'Working…' : 'Pause automation'}</button>
       </div>`;

  const rows = (a.workers || []).map((w) => `<div class="auto-row tone-${esc(STATUS_TONE[w.status] || 'warn')}">
        <div class="auto-h">
          <b>${esc(w.label)}</b>
          <span class="pill sm ${esc(STATUS_TONE[w.status] === 'good' ? '' : STATUS_TONE[w.status])}">${esc(STATUS_WORD[w.status] || w.status)}</span>
        </div>
        <div class="auto-t">${esc(w.text)}</div>
        ${outcomeLine(w)}
        <div class="faint">${esc(w.what)} · expected about every ${esc(everyWords(w.everyMs))} · run by ${esc(w.runBy)}${w.nextDueAt ? ` · next expected ${esc(whenWords(w.nextDueAt))}` : ''}</div>
      </div>`).join('');

  return `${pauseBox}
    <div class="note ${h.tone === 'good' ? '' : h.tone}"><b>${esc(h.word)}</b>${h.detail ? ` — ${esc(h.detail)}` : ''}</div>
    ${rows}
    <p class="note faint">Every line above is the last time that worker actually checked in, not a schedule.
      A worker that stopped shows its real silence here rather than a countdown to a run that will not happen.</p>`;
}

/**
 * A check-in says a run STARTED. It does not say the work succeeded, and on
 * this system it can mean nothing more than that somebody opened the dashboard
 * — the page pokes the tick on load. So the attempt and the outcome are shown
 * as two separate lines, and a worker with no outcome telemetry says exactly
 * that rather than borrowing the timestamp's credibility.
 */
export function outcomeLine(w) {
  if (!w) return '';
  if (w.status === 'never') {
    return `<div class="auto-o faint">No run has ever been recorded. That is a fact about the <b>record</b>, not proof the worker is broken — if nothing schedules it here, this is what it correctly looks like.</div>`;
  }
  if (!w.hasOutcomeTelemetry) {
    return `<div class="auto-o warn">It checked in, but nothing recorded what it <b>achieved</b>. A timestamp proves it started, not that it worked.</div>`;
  }
  const bits = [];
  if (w.lastSuccessAt) bits.push(`last succeeded ${whenWords(w.lastSuccessAt)}`);
  else bits.push('<b>never recorded a success</b>');
  if (w.lastProcessed != null) bits.push(`${w.lastProcessed} item${w.lastProcessed === 1 ? '' : 's'} last run`);
  if (w.processed != null) bits.push(`${w.processed} in total`);
  const fail = w.lastFailureAt
    ? `<div class="auto-o neg">Last failure ${esc(whenWords(w.lastFailureAt))}${w.lastFailure ? ` — ${esc(w.lastFailure)}` : ''}</div>`
    : '';
  return `<div class="auto-o">${bits.join(' · ')}</div>${fail}`;
}

/** Relative time in words, past or future. */
export function whenWords(at) {
  const n = Number(at);
  if (!Number.isFinite(n) || n <= 0) return 'never';
  const ms = Date.now() - n;
  const abs = Math.abs(ms);
  if (abs < 60000) return ms >= 0 ? 'just now' : 'in under a minute';
  const m = Math.round(abs / 60000);
  const unit = m < 60 ? `${m} minute${m === 1 ? '' : 's'}`
    : abs < 36 * 3600e3 ? `${Math.round(m / 60)} hour${Math.round(m / 60) === 1 ? '' : 's'}`
      : `${Math.round(m / 1440)} day${Math.round(m / 1440) === 1 ? '' : 's'}`;
  return ms >= 0 ? `${unit} ago` : `in ${unit}`;
}

export function everyWords(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown';
  const m = Math.round(ms / 60000);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}

/** One delegated listener for pause and resume. */
export function wireAutomation(root, handlers = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('#autoPause')) {
      if (typeof handlers.pause === 'function') handlers.pause();
      return;
    }
    if (t.closest('#autoResume')) {
      if (typeof handlers.resume === 'function') handlers.resume();
      return;
    }
    if (t.closest('[data-retry="automation"]')) {
      if (typeof handlers.retry === 'function') handlers.retry();
    }
  });
  return true;
}
