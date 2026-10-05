// What was actually asked for, and what of it is actually done.
//
// WHY THIS EXISTS. Completion used to be inferred: if the agent shipped
// anything at all, the ticket was finished and the client was emailed that it
// was live. On Isha Lo's CPD request that meant she was told her request was
// complete while one of the things she asked for — the official accreditation
// logo — had not been done at all. The agent knew; it wrote so in the commit
// message. The pipeline had no place to put "done except for this".
//
// So completion is tracked per REQUESTED ITEM. A request is finished when
// every item is verified. An item that cannot be done is not quietly dropped:
// it is recorded as outstanding, with the reason, and the request stays open.
//
// Reading the agent's prose for admissions ("I don't have that logo file") is
// still useful, but it is a SAFETY NET, not the mechanism. A model that says
// nothing about what it skipped must not therefore count as having done
// everything. Silence is not evidence.

export const ITEM = Object.freeze({
  PENDING: 'pending',          // not started, or in progress
  DONE: 'done',                // done AND confirmed
  OUTSTANDING: 'outstanding',  // cannot be done yet, reason recorded
});

let seq = 0;
const nextId = () => `r${Date.now().toString(36)}${(seq = (seq + 1) % 1000).toString(36)}`;

/**
 * Turn the classifier's list of asks into trackable requirements.
 *
 * Deliberately tolerant about input shape — this runs on live email and a
 * malformed list must not throw away the request.
 */
export function buildRequirements(items, { summary = '' } = {}) {
  const list = (Array.isArray(items) ? items : [])
    .filter((x) => typeof x === 'string')
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, 20);
  // Never zero for a real request: zero requirements would compute as
  // "complete", which is the exact bug this module exists to stop.
  const safe = list.length ? list : (summary ? [String(summary).trim()] : []);
  return safe.map((text) => ({ id: nextId(), text: text.slice(0, 200), state: ITEM.PENDING, note: null, at: null }));
}

/** Mark one requirement done, with whatever evidence we have. */
export function markDone(reqs, id, { note = null, now = Date.now() } = {}) {
  const r = (reqs || []).find((x) => x.id === id);
    if (!r) return false;
  r.state = ITEM.DONE;
  r.note = note;
  r.at = now;
  return true;
}

/** Record that an item cannot be finished, and why. Never silently drops it. */
export function markOutstanding(reqs, id, reason, { now = Date.now() } = {}) {
  const r = (reqs || []).find((x) => x.id === id);
  if (!r) return false;
  r.state = ITEM.OUTSTANDING;
  r.note = String(reason || 'not done').slice(0, 300);
  r.at = now;
  return true;
}

/**
 * Is this request finished?
 *
 * `complete` is true ONLY when there is at least one requirement and every one
 * of them is DONE. Unknown never counts as done — a ticket with no
 * requirements recorded is `complete: false, unverifiable: true`, so an older
 * ticket from before this existed cannot silently pass as finished.
 */
export function completionState(ticket) {
  const reqs = Array.isArray(ticket?.requirements) ? ticket.requirements : [];
  if (!reqs.length) {
    return {
      complete: false,
      unverifiable: true,
      total: 0, done: 0,
      outstanding: [], pending: [],
      reason: 'no itemised requirements were recorded for this request, so completion cannot be established',
    };
  }
  const done = reqs.filter((r) => r.state === ITEM.DONE);
  const outstanding = reqs.filter((r) => r.state === ITEM.OUTSTANDING);
  const pending = reqs.filter((r) => r.state === ITEM.PENDING);
  return {
    complete: done.length === reqs.length,
    unverifiable: false,
    total: reqs.length,
    done: done.length,
    outstanding,
    pending,
    reason: done.length === reqs.length
      ? null
      : outstanding.length
        ? `${outstanding.length} of ${reqs.length} item(s) could not be completed`
        : `${pending.length} of ${reqs.length} item(s) are not confirmed done`,
  };
}

/**
 * May we tell the client "it's live"?
 *
 * The one gate. Anything short of every item verified gets a truthful partial
 * message instead, naming what is and is not done.
 */
export function mayAnnounceComplete(ticket) {
  const c = completionState(ticket);
  if (c.complete) return { ok: true, state: c };
  return { ok: false, state: c, reason: c.reason };
}

/**
 * What to say when it is NOT all done.
 *
 * Says what shipped, says plainly what has not, and — when the hold-up is
 * something only they can supply — asks for it. No "everything is live".
 */
export function partialUpdateText(ticket, { siteName = 'your site', siteUrl = '' } = {}) {
  const c = completionState(ticket);
  const done = (ticket.requirements || []).filter((r) => r.state === ITEM.DONE);
  const out = c.outstanding || [];
  const pend = c.pending || [];
  const lines = [];
  lines.push(`Hi,\n`);
  if (done.length) {
    lines.push(`An update on what you asked for on ${siteName}. These are done and live:\n`);
    for (const r of done) lines.push(`  • ${r.text}`);
    lines.push('');
  } else {
    lines.push(`An update on what you asked for on ${siteName}.\n`);
  }
  if (out.length) {
    lines.push(out.length === 1 ? `One thing is not done yet:\n` : `These are not done yet:\n`);
    for (const r of out) lines.push(`  • ${r.text}${r.note ? ` — ${r.note}` : ''}`);
    lines.push('');
  }
  if (pend.length) {
    lines.push(pend.length === 1 ? `Still in progress:\n` : `Still in progress:\n`);
    for (const r of pend) lines.push(`  • ${r.text}`);
    lines.push('');
  }
  if (siteUrl) lines.push(`${siteUrl}\n`);
  lines.push(`I'll follow up as soon as the rest is done.`);
  return lines.join('\n');
}

/**
 * Best-effort reconciliation of what the agent reported against the items.
 *
 * SECONDARY only. It can mark an item outstanding when the agent admits it
 * could not do it, because an admission is positive evidence of a gap. It must
 * never mark an item DONE from prose — "the model did not mention skipping it"
 * is not evidence that it happened. Items only become DONE through an explicit
 * markDone call backed by a real check.
 */
export function reconcileFromShipText(ticket, shipText, classify) {
  const reqs = Array.isArray(ticket?.requirements) ? ticket.requirements : [];
  if (!reqs.length || !shipText) return { changed: 0 };
  const verdict = typeof classify === 'function' ? classify(shipText) : null;
  if (!verdict || verdict.kind !== 'needs-client-asset') return { changed: 0 };
  // The admission names a missing asset. Attribute it to the item that most
  // plausibly needs one, else to every item not yet confirmed — better to hold
  // a true statement back than to send a false one.
  const words = String(shipText).toLowerCase();
  const assetish = /logo|image|photo|picture|file|document|pdf|headshot|asset|graphic/;
  let changed = 0;
  const candidates = reqs.filter((r) => r.state === ITEM.PENDING);
  const targeted = candidates.filter((r) => assetish.test(r.text.toLowerCase()) && words.includes(r.text.toLowerCase().split(/\s+/).find((w) => assetish.test(w)) || '\u0000'));
  for (const r of (targeted.length ? targeted : candidates)) {
    r.state = ITEM.OUTSTANDING;
    r.note = verdict.recovery?.label || 'needs a file from the client';
    changed++;
  }
  return { changed, kind: verdict.kind };
}
