// R2.5 — one vocabulary for the six states every panel can be in.
//
// The defect this exists to kill: a panel that fetches a list, gets nothing
// back because the request FAILED, and renders "No contacts yet." Empty and
// broken look identical, and the owner is told something false in a calm voice.
// Every list on this dashboard did that.
//
// The six states R2.5 asks for, and what each one must never do:
//
//   loading       — must not render as empty. "Nothing here" before the answer
//                   arrives is a lie with a short lifespan.
//   empty         — must say WHY it is empty and what fills it. Only reachable
//                   when the fetch genuinely succeeded.
//   error         — must say what failed and must never read as an all-clear.
//   disconnected  — a thing that was never connected is not a thing with no
//                   data. "No replies" and "no inbox is connected" are
//                   different sentences and different fixes.
//   success       — must say what actually happened, not "Done ✓".
//   recovery      — must name the action in words the owner can act on (R1.5),
//                   and must say whether anything was lost.
//
// Pure: state in, HTML out, so every one of them is drivable in a test.

export const PANEL = Object.freeze({
  LOADING: 'loading',
  READY: 'ready',
  EMPTY: 'empty',
  ERROR: 'error',
  DISCONNECTED: 'disconnected',
  LOCKED: 'locked',
});

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Turn a fetch result into an explicit state.
 *
 * The important case is the one in the middle: a response that came back but
 * said `ok: false`. Before this existed, callers wrote `j.contacts || []` and
 * a refusal became an empty list.
 *
 * @param {object|null} j      the parsed response, or null if the fetch threw
 * @param {object} [opts]
 * @param {string} [opts.key]  which field on the response holds the list
 */
export function classify(j, opts = {}) {
  const { key } = opts;

  if (j === undefined) return { status: PANEL.LOADING, items: [], error: '' };
  if (j === null) return { status: PANEL.ERROR, items: [], error: 'The server did not answer.' };

  if (j.ok === false) {
    const why = String(j.error || '');
    if (/locked|unauthori[sz]ed|401|password/i.test(why)) {
      return { status: PANEL.LOCKED, items: [], error: why };
    }
    return { status: PANEL.ERROR, items: [], error: why || 'The request was refused and gave no reason.' };
  }

  // an integration that was never set up is not an integration with no data
  if (j.configured === false) return { status: PANEL.DISCONNECTED, items: [], error: '' };

  const items = key ? j[key] : undefined;
  if (key && !Array.isArray(items)) {
    // the call succeeded but the field we need is missing — that is a broken
    // response, not an empty list, and saying "none yet" would invent a fact
    return { status: PANEL.ERROR, items: [], error: `The server's answer had no ${key}.` };
  }
  if (key && items.length === 0) return { status: PANEL.EMPTY, items: [], error: '' };
  return { status: PANEL.READY, items: items || [], error: '' };
}

/**
 * Render whatever is NOT the ready state. Returns null when the panel should
 * draw its real contents, so a caller reads:
 *
 *   const shell = renderPanel(st, {...});
 *   if (shell) return shell;
 *   ...draw the rows...
 *
 * @param {object} st           from classify()
 * @param {object} opts
 * @param {string} opts.thing   plural noun: "contacts", "replies"
 * @param {string} [opts.empty] why it is empty and what fills it
 * @param {string} [opts.disconnected] what is not connected and what that means
 * @param {string} [opts.loading]
 *
 * `empty` and `disconnected` are developer-written copy and may contain markup.
 * Anything from a server or a person — `st.error`, `thing` — is escaped. Never
 * pass user data as `empty` or `disconnected`.
 */
export function renderPanel(st, opts = {}) {
  const thing = opts.thing || 'items';

  switch (st?.status) {
    case PANEL.LOADING:
      return `<div class="loading">${esc(opts.loading || `Loading ${thing}…`)}</div>`;

    case PANEL.LOCKED:
      return `<div class="note warn"><b>Locked.</b> Enter your password above to see ${esc(thing)}.
        Nothing is missing — this panel simply has not been allowed to load.</div>`;

    case PANEL.ERROR:
      // the sentence that does the work: this is not an all-clear
      return `<div class="note neg"><b>Could not load ${esc(thing)}.</b> ${esc(st.error || '')}
        <br />This is not an empty list — nothing could be read, so anything here is unknown.
        <button class="btn sm ghost" data-retry="${esc(opts.retryKey || thing)}">Try again</button></div>`;

    case PANEL.DISCONNECTED:
      return `<div class="note warn">${
        opts.disconnected ||
        `<b>Not connected.</b> Nothing is watching for ${esc(thing)} yet, so none have been missed — there is simply nothing collecting them.`
      }</div>`;

    case PANEL.EMPTY:
      return `<div class="note">${
        opts.empty ? opts.empty : `<b>No ${esc(thing)} yet.</b> An empty list means none have arrived — not that any were lost.`
      }</div>`;

    default:
      return null;
  }
}

/**
 * What actually happened, in the past tense, with the numbers in it.
 * "Saved ✓" tells the owner nothing they can check.
 */
export function renderSuccess(what, detail = '') {
  return `<div class="note good" role="status"><b>${esc(what)}</b>${detail ? ` ${esc(detail)}` : ''}</div>`;
}

/**
 * R1.5 rendered: a blocked thing, the action that unblocks it in plain words,
 * and whether anything was lost. One implementation, used by every surface
 * that shows a blocked item, so the wording cannot drift between them.
 */
export function renderRecovery({ label, hint, action, slug, actionLabel } = {}) {
  if (!label && !action) return '';
  return `<div class="note warn" style="margin-top:6px">
    <b>${esc(label || 'Needs attention')}</b>
    ${hint ? `<br />${esc(hint)}` : ''}
    ${
      action
        ? `<br /><button class="btn sm" data-fix="${esc(action)}" data-slug="${esc(slug || '')}">${esc(actionLabel || 'Fix this')}</button>`
        : ''
    }
  </div>`;
}
