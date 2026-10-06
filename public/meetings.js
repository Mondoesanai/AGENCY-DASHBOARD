// Which real meetings are booked, cancelled, or missed.
//
// This screen exists because "a meeting" is the one number in the whole system
// that is worth optimising, and it is also the easiest to inflate. Three
// things have to stay apart here, and they look alike from a distance:
//
//   a LINK CLICK        somebody opened the booking page. Not a meeting.
//   a BOOKED meeting    the scheduler confirmed a slot. Real, but not attended.
//   an ATTENDED meeting somebody actually turned up. The thing that matters.
//
// The system can only know the middle one by itself. Attendance has to be
// recorded by the owner, so the screen asks for it rather than assuming that a
// booking in the past was a meeting that happened — which is how a no-show
// quietly becomes a success in a report.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const when = (ts) => {
  if (!ts) return 'no time recorded';
  const d = new Date(ts);
  if (isNaN(d)) return 'no time recorded';
  return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

/**
 * The week against the target.
 *
 * Progress is attended meetings, never booked ones — a booking somebody did
 * not turn up to is not six-sevenths of a meeting. The two are shown together
 * because the gap between them is the most informative number here, but only
 * one is measured against the target.
 */
export function renderTarget(progress, volume) {
  if (!progress) return '';
  const { target = 0, attended = 0, booked = 0, upcoming = 0, remaining = 0, week, timezone } = progress;
  const pct = target ? Math.min(100, Math.round((attended / target) * 100)) : 0;
  return `<div class="mt-target">
    <div class="mt-target-h">
      <b>${esc(attended)} of ${esc(target)}</b> attended this week
      <span class="faint">${esc(week || '')}${timezone ? ` · ${esc(timezone)}` : ''}</span>
    </div>
    <div class="mt-bar"><span style="width:${pct}%"></span></div>
    <div class="note">${esc(booked)} booked · ${esc(upcoming)} still to come ·
      ${remaining ? `<b>${esc(remaining)}</b> more needed to hit the target` : 'target met'}.
      <span class="faint">Progress counts meetings people actually attended.</span></div>
    ${progress.note ? `<div class="note warn">${esc(progress.note)}</div>` : ''}
    ${volume ? renderVolume(volume) : ''}
  </div>`;
}

/** What the target implies about volume — a recommendation, never a permission. */
export function renderVolume(v) {
  if (!v) return '';
  if (v.ok === false) {
    return `<div class="note"><b>No volume recommendation.</b> ${esc(v.reason || '')}.
      ${v.wouldNeed ? `<span class="faint">Would need ${esc(v.wouldNeed)}.</span>` : ''}
      ${v.note ? `<div class="faint">${esc(v.note)}</div>` : ''}</div>`;
  }
  if (!v.need) return `<div class="note">${esc(v.note || '')}</div>`;
  return `<div class="note">To reach the target, roughly <b>${esc(v.invitationsNeeded)}</b> more invitations
    — from your own rates (${esc(Math.round((v.basis?.replyRate || 0) * 100))}% reply,
    ${esc(Math.round((v.basis?.bookRate || 0) * 100))}% book,
    ${esc(Math.round((v.basis?.attendRate || 0) * 100))}% attend).
    <div class="faint">${esc(v.note || '')}</div></div>`;
}

/**
 * Why the week fell short — as questions, not as an answer.
 *
 * The brief's example is the whole point: "six booked, four no-shows" has at
 * least six plausible causes and six events cannot separate them. So this
 * lists what the data can and cannot settle, marks the single suggestion as a
 * HYPOTHESIS, and states the sample it would take to mean anything.
 */
export function renderShortfall(sf) {
  if (!sf || (!sf.questions?.length && !sf.hypothesis)) return '';
  return `<div class="mt-diag">
    <h3>What the shortfall might be</h3>
    ${sf.verdict ? `<div class="note warn">${esc(sf.verdict)}</div>` : ''}
    ${sf.questions?.length ? `<ul class="mt-qs">${sf.questions.map((q) => `
      <li class="${q.settleable ? 'mt-q-now' : 'mt-q-later'}">
        <b>${esc(q.q)}</b>
        <div class="faint">${esc(q.why)}</div>
        <div class="mt-q-a">→ ${esc(q.action)}</div>
      </li>`).join('')}</ul>` : ''}
    ${sf.hypothesis ? `<div class="mt-hyp">
      <span class="mt-hyp-tag">${esc(sf.hypothesis.label)}</span>
      <div><b>${esc(sf.hypothesis.change)}</b></div>
      <div class="faint">${esc(sf.hypothesis.why)}</div>
      <div class="note warn">${esc(sf.hypothesis.caution)}</div>
      <div class="faint">Measured by: ${esc(sf.hypothesis.measure)}</div>
    </div>` : ''}
  </div>`;
}

/** Booked, attended, cancelled, missed — and clicks kept out of all of them. */
export function renderMeetingSummary(data) {
  if (!data) return '<div class="loading">Reading meetings…</div>';
  if (data.ok === false) {
    return `<div class="note neg">Could not read meetings — ${esc(data.error || 'unknown reason')}.
      <div class="faint">This is not "no meetings". Nothing should be concluded from a screen that failed to load.</div></div>`;
  }
  const s = data.stats || {};
  const booked = Number(s.verifiedBookings || 0);
  const attended = Number(s.attended || 0);
  const noShow = Number(s.noShow || 0);
  const cancelled = Number(s.cancelled || 0);
  const upcoming = Number(s.scheduled || 0);
  const settled = attended + noShow;

  if (!booked && !upcoming) {
    return `<div class="note">No meetings yet.
      ${data.schedulerConnected === false
        ? '<div class="faint">No scheduler is connected, so a booking could not arrive even if someone made one. Nothing is wrong with your calendar — there is no link between it and this dashboard yet.</div>'
        : '<div class="faint">The scheduler is connected and has reported nothing. That is a real empty, not a failed check.</div>'}</div>`;
  }

  return `<div class="mt-summary">
    <div class="mt-figs">
      <div class="mt-fig"><b>${esc(upcoming)}</b><span>coming up</span></div>
      <div class="mt-fig mt-good"><b>${esc(attended)}</b><span>attended</span></div>
      <div class="mt-fig mt-bad"><b>${esc(noShow)}</b><span>no-show</span></div>
      <div class="mt-fig"><b>${esc(cancelled)}</b><span>cancelled</span></div>
    </div>
    ${settled
      ? `<div class="note">Of ${esc(settled)} meeting${settled === 1 ? '' : 's'} that have now been and gone, <b>${esc(attended)}</b> ${attended === 1 ? 'was' : 'were'} attended.</div>`
      : '<div class="note">None have happened yet, so there is no attendance rate to report.</div>'}
    <div class="faint">${esc(s.note || 'Bookings come only from a confirmed scheduler event or an owner-entered record.')}</div>
  </div>`;
}

/**
 * The list. Past meetings with no outcome recorded are shown FIRST, because
 * they are the only thing on this screen that needs the owner to do something,
 * and because an unrecorded past booking is what silently becomes a success.
 */
export function renderMeetingList(data, { now = Date.now() } = {}) {
  if (!data || data.ok === false) return '';
  const list = data.bookings || [];
  if (!list.length) return '';

  const needsOutcome = list.filter((b) => b.status === 'scheduled' && b.startAt && b.startAt < now);
  const upcoming = list.filter((b) => b.status === 'scheduled' && (!b.startAt || b.startAt >= now))
    .sort((a, b) => (a.startAt || 0) - (b.startAt || 0));
  const settled = list.filter((b) => b.status !== 'scheduled')
    .sort((a, b) => (b.startAt || 0) - (a.startAt || 0));

  const row = (b, extra = '') => `<div class="mt-row mt-${esc(b.status || 'unknown')}" data-booking="${esc(b.id || '')}">
    <div class="mt-who">${esc(b.name || b.contactName || b.email || 'Someone')}
      ${b.verified ? '' : '<span class="tag" title="Entered by hand rather than confirmed by the scheduler">not confirmed by the scheduler</span>'}</div>
    <div class="mt-when">${esc(when(b.startAt))}</div>
    <div class="mt-state">${esc(stateWord(b.status))}</div>
    ${extra}
  </div>`;

  const ask = `<div class="mt-ask">
      <button class="btn sm" data-outcome="attended">They came</button>
      <button class="btn sm ghost" data-outcome="no-show">They did not</button>
    </div>`;

  return `
    ${needsOutcome.length ? `<div class="section-h"><h3>Did these happen?</h3>
      <p class="note">These times have passed and nobody has said what happened. Until one is answered it counts as neither attended nor missed.</p></div>
      <div class="mt-list">${needsOutcome.map((b) => row(b, ask)).join('')}</div>` : ''}
    ${upcoming.length ? `<div class="section-h"><h3>Coming up</h3></div>
      <div class="mt-list">${upcoming.map((b) => row(b)).join('')}</div>` : ''}
    ${settled.length ? `<div class="section-h"><h3>Past</h3></div>
      <div class="mt-list">${settled.slice(0, 40).map((b) => row(b)).join('')}</div>` : ''}`;
}

export function stateWord(status) {
  return ({
    scheduled: 'Booked',
    attended: 'Attended',
    'no-show': 'Did not come',
    cancelled: 'Cancelled',
    rescheduled: 'Moved',
  })[status] || 'Unknown';
}

/** One delegated listener. */
export function wireMeetings(root, handlers = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-outcome]');
    if (btn) {
      const row = btn.closest('[data-booking]');
      if (row) handlers.outcome?.(row.getAttribute('data-booking'), btn.getAttribute('data-outcome'));
      return;
    }
    const row = e.target?.closest?.('[data-booking]');
    if (row) handlers.open?.(row.getAttribute('data-booking'));
  });
  return true;
}
