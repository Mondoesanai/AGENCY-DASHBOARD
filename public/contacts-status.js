// Who can we contact, on which channel, and why.
//
// The requirement this exists for is one sentence: a contact marked emailable
// must not look SMS-eligible. That sounds obvious and is easy to get wrong —
// the moment the two are summarised into one "contactable" badge, or share a
// colour, or sit in one column, somebody will text a person who only agreed to
// email. So the two channels are rendered as two separate blocks, each with its
// own label, its own reason and its own next action, and they never merge.
//
// Five states, in the owner's words rather than the system's:
//
//   Email OK            we may write to them
//   Text OK             they said yes, or asked us for something
//   Permission needed   we have a number and no permission — the usual case
//   No mobile number    nothing to text; not the same as "no permission"
//   Opted out           they asked us to stop, and that wins over everything
//
// "Permission needed" is deliberately not an error tone. It is the normal
// state of a discovered business and the screen's job is to show the way out
// of it, which is why every blocked row carries a next action rather than only
// a reason.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Tone per label. Opted out is the only one that reads as a stop. */
export function toneFor(label) {
  if (/opted out/i.test(label)) return 'stop';
  if (/^email ok|^text ok/i.test(label)) return 'ok';
  if (/permission needed/i.test(label)) return 'todo';
  return 'none'; // no mobile number, unknown
}

/** The counts, as a sentence rather than a row of numbers. */
export function renderSummary(data) {
  if (!data) return '<div class="loading">Reading who we can contact…</div>';
  if (data.ok === false) {
    return `<div class="note neg">Could not read contact permissions — ${esc(data.error || 'unknown reason')}.
      <div class="faint">This is not an all-clear. Nobody should be contacted on the strength of a screen that failed to load.</div></div>`;
  }
  const t = data.total || 0;
  if (!t) return '<div class="note">No contacts yet. Add some, or run discovery.</div>';
  return `<div class="cs-summary">
    <b>${esc(t)} contact${t === 1 ? '' : 's'}.</b>
    ${esc(data.emailEligible || 0)} can be emailed ·
    ${esc(data.smsEligible || 0)} can be texted ·
    ${esc(data.permissionNeeded || 0)} need permission ·
    ${esc(data.suppressed || 0)} opted out
    ${data.ownerAsserted ? `<div class="note warn" style="margin-top:6px">${esc(data.ownerAsserted)} marked textable by your own assertion, with nothing on file for them individually. Sending the email invitation turns that into real records.</div>` : ''}
  </div>`;
}

/** One channel block. Never combined with the other. */
function channel(kind, c) {
  if (!c) return '';
  const tone = toneFor(c.label || '');
  return `<div class="cs-ch cs-${tone}">
    <div class="cs-ch-k">${kind}</div>
    <div class="cs-ch-v">${esc(c.label || 'Unknown')}</div>
    <div class="cs-ch-why">${esc(c.reason || '')}</div>
    ${c.next ? `<div class="cs-ch-next">→ ${esc(c.next)}</div>` : ''}
  </div>`;
}

/** The list. */
export function renderStatusList(data) {
  if (!data) return '<div class="loading">Reading who we can contact…</div>';
  if (data.ok === false) return '';
  const rows = data.rows || [];
  if (!rows.length) return '';
  return `<div class="cs-list">${rows.map((r) => `
    <div class="cs-row${r.suppressed ? ' cs-row-stop' : ''}" data-contact="${esc(r.id || '')}">
      <div class="cs-name">${esc(r.name || '(no name)')}</div>
      <div class="cs-channels">
        ${channel('Email', r.email)}
        ${channel('Text', r.sms)}
      </div>
    </div>`).join('')}</div>`;
}

/**
 * Refusals, grouped by reason.
 *
 * One blocker usually stops everybody — no postal address in Settings stops
 * all four — and listing the same sentence once per contact buries the single
 * thing the owner has to go and do under a wall of repetition. Grouped, it
 * reads as one task with a count, which is what it actually is.
 */
export function renderRefusals(refused) {
  const by = new Map();
  for (const r of refused) {
    const k = r.why || 'unknown reason';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r.name || r.id);
  }
  const groups = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  return `<div class="note warn"><b>${esc(refused.length)}</b> cannot be invited yet:
    <ul>${groups.map(([why, who]) => `<li>${esc(why)}
      <span class="faint">— ${who.length === 1 ? esc(who[0]) : `${esc(who.length)} contacts`}</span></li>`).join('')}</ul></div>`;
}

/**
 * The invitation review, which is how "permission needed" stops being the
 * answer. Shows what WOULD be sent and to whom; sends nothing itself.
 */
export function renderInviteReview(review) {
  if (!review) return '';
  if (review.ok === false) {
    // Named as a failure, not just echoed as an error string: "nope" on its
    // own reads like a system message rather than like the list being unknown.
    return `<div class="note neg">Could not work out who to invite — ${esc(review.error || 'unknown reason')}.
      <div class="faint">Nobody should be invited on the strength of a list that failed to load.</div></div>`;
  }
  const c = review.candidates || {};
  const prepared = (review.preview && review.preview.prepared) || [];
  const refused = (review.preview && review.preview.refused) || [];
  return `<div class="cs-invite">
    <h3>Invite them to see their preview</h3>
    <p class="note">An email asking whether they want to see it. A <b>yes</b> is what lets us text them later — it is recorded with their own words. Nothing is sent from this screen.</p>
    <div class="note"><b>${esc((c.eligible || []).length)}</b> would be invited.
      ${(c.skipped || []).length ? `<b>${esc(c.skipped.length)}</b> skipped.` : ''}</div>
    ${refused.length ? renderRefusals(refused) : ''}
    ${(c.skipped || []).length ? `<details><summary>Why ${esc(c.skipped.length)} were skipped</summary>
      <ul>${c.skipped.slice(0, 20).map((s) => `<li>${esc(s.name || s.id)} — ${esc(s.why)}</li>`).join('')}</ul></details>` : ''}
    ${prepared.length ? `<details><summary>See the exact message</summary>
      <pre class="cs-msg">${esc(prepared[0].body)}</pre></details>` : ''}
    <button class="btn" id="csInviteSend" ${prepared.length ? '' : 'disabled'}>Send ${esc(prepared.length)} invitation${prepared.length === 1 ? '' : 's'}</button>
    <div class="faint">Outreach must be switched on in Settings before anything sends.</div>
  </div>`;
}

/** One delegated listener for the panel. */
export function wireContactStatus(root, handlers = {}) {
  if (!root || typeof root.addEventListener !== 'function') return false;
  root.addEventListener('click', (e) => {
    const t = e.target;
    if (t?.closest?.('#csInviteSend')) return void handlers.send?.();
    if (t?.closest?.('#csInviteReview')) return void handlers.review?.();
    const row = t?.closest?.('[data-contact]');
    if (row) handlers.open?.(row.getAttribute('data-contact'));
  });
  return true;
}
