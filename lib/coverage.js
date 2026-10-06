// Did we actually capture everything they asked for?
//
// WHY. Completion is judged against the extracted item list. That is a real
// improvement over "the agent shipped something", but it moves the failure
// rather than removing it: if extraction misses an item, the list is complete
// by its own measure and the client is told everything is done. The gate is
// only ever as good as the list it checks against, and nothing was checking
// the list.
//
// So the request is compared against the list TWICE:
//
//   before execution — does the extracted list account for everything the
//   email and its attachments actually ask for? A missed ask found here is
//   cheap: the item is added before any work starts.
//
//   before closing — does the completion evidence account for every ask in
//   the original text? A missed ask found here is the last line of defence:
//   it stops the "all done" message going out.
//
// This is a SAFEGUARD, not a guarantee, and it is important to be exact about
// that. It finds asks that look like asks — imperative sentences, "and also",
// bulleted lists, "can you". It will not understand every way a person can
// phrase a request, and a second reviewer that misses something is not proof
// there was nothing to miss. What it does guarantee is narrower and still
// worth having: anything it DOES find gets an explicit disposition, and
// "unaccounted for" is never silently treated as "done".

/** Every requested outcome ends up as exactly one of these. */
export const DISPOSITION = Object.freeze({
  VERIFIED: 'verified',             // done, and confirmed
  OUTSTANDING: 'outstanding',       // not done, reason recorded
  NEEDS_CLARIFICATION: 'needs-clarification', // we cannot tell what was meant
  UNACCOUNTED: 'unaccounted',       // found in the request, missing from the list
});

// Phrases that start a request. Deliberately broad — a false positive costs a
// moment's review, a false negative costs a client being told something is
// done when it is not.
const ASK_PATTERNS = [
  /\b(can|could|would|will)\s+(you|we|someone)\b/i,
  /\b(please|pls)\b/i,
  /\bi(?:'d| would)?\s+(?:like|want|need)\b/i,
  /\bwe\s+(?:need|want)\b/i,
  /\b(?:also|additionally|and also|one more thing|while you'?re at it|lastly|finally)\b/i,
  /\b(?:add|remove|delete|change|update|fix|swap|replace|move|rename|upload|put|take)\b/i,
  /\bmake\s+(?:sure|it|the)\b/i,
  /\bshould\s+(?:be|say|read|show)\b/i,
  /\bneeds?\s+to\s+be\b/i,
  /\bis\s+(?:wrong|incorrect|outdated|missing)\b/i,
];

const LIST_MARKER = /^\s*(?:[-*•·–—]|\d+[.)]|\(?[a-z]\)|•)\s+/i;

const STOP = new Set([
  'the','a','an','and','or','but','to','of','in','on','at','for','with','from','by','is','are','was','were',
  'be','been','it','this','that','there','their','they','we','you','your','our','i','me','my','us','please',
  'can','could','would','will','should','need','needs','want','like','make','sure','also','one','more','thing',
  'hi','hello','hey','thanks','thank','regards','best','cheers','dear','just','get','got','put','let','know',
]);

/** Content words, for deciding whether two sentences are about the same thing. */
export function keywords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w))
  );
}

/** 0..1 — how much of the smaller phrase's meaning the larger one covers. */
export function overlap(a, b) {
  const A = a instanceof Set ? a : keywords(a);
  const B = b instanceof Set ? b : keywords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / Math.min(A.size, B.size);
}

/**
 * Pull the individual asks out of a request.
 *
 * Splits on sentence and list boundaries, then keeps the fragments that read
 * like instructions. Quoted and forwarded text is dropped: a reply that quotes
 * the whole thread would otherwise produce the original request's asks again
 * every time someone says "thanks".
 */
export function extractAsks(text, { attachmentText = '' } = {}) {
  const body = String(text || '');
  const attach = String(attachmentText || '');
  const asks = [];
  for (const [source, raw] of [['email', body], ['attachment', attach]]) {
    if (!raw.trim()) continue;
    const lines = raw.split(/\r?\n/);
    const usable = [];
    for (const line of lines) {
      // quoted reply, forwarded header, or a signature block ends the request
      if (/^\s*>/.test(line)) continue;
      if (/^\s*(?:on .+ wrote:|-{2,}\s*original message|from:\s|sent:\s|_{4,})/i.test(line)) break;
      usable.push(line);
    }
    for (const line of usable) {
      const isListItem = LIST_MARKER.test(line);
      const cleaned = line.replace(LIST_MARKER, '').trim();
      if (!cleaned) continue;
      // a list item is one ask even without an imperative verb
      const parts = isListItem ? [cleaned] : cleaned.split(/(?<=[.!?])\s+|\s+(?:and then|, and also|; also)\s+/i);
      for (const p of parts) {
        const s = p.trim();
        if (s.length < 6 || s.length > 300) continue;
        const looksLikeAsk = isListItem || ASK_PATTERNS.some((re) => re.test(s));
        if (!looksLikeAsk) continue;
        asks.push({ text: s, source, listItem: isListItem });
      }
    }
  }
  // collapse near-duplicates (the same ask in the body and in an attachment)
  const out = [];
  for (const a of asks) {
    if (out.some((b) => overlap(a.text, b.text) >= 0.8)) continue;
    out.push(a);
  }
  return out;
}

/**
 * BEFORE EXECUTION — is anything in the request missing from the item list?
 *
 * `threshold` is how much keyword overlap counts as "this item covers that
 * ask". Low enough that a paraphrase still matches, high enough that two
 * different asks about the same page do not collapse into one.
 */
export function checkExtraction(requestText, items, { attachmentText = '', threshold = 0.5 } = {}) {
  const asks = extractAsks(requestText, { attachmentText });
  const list = (Array.isArray(items) ? items : []).map((i) => (typeof i === 'string' ? i : i?.text || ''));
  const missing = [];
  for (const ask of asks) {
    const covered = list.some((it) => overlap(ask.text, it) >= threshold);
    if (!covered) missing.push(ask);
  }
  return {
    ok: missing.length === 0,
    asksFound: asks.length,
    itemsExtracted: list.length,
    missing,
    // what to DO about it: add them, rather than ask anyone
    note: missing.length
      ? `${missing.length} thing(s) in the request are not in the task list and would never have been worked on.`
      : null,
  };
}

/**
 * BEFORE CLOSING — does the evidence account for every ask in the original?
 *
 * Returns a disposition for every ask. `complete` is true only when every one
 * is VERIFIED. An ask that matches no requirement at all is UNACCOUNTED, which
 * is deliberately NOT the same as outstanding: outstanding means we know about
 * it and could not do it; unaccounted means we never even captured it, which
 * is a worse failure and reads differently to whoever has to fix it.
 */
export function checkCompletion(requestText, ticket, { attachmentText = '', threshold = 0.5 } = {}) {
  const asks = extractAsks(requestText, { attachmentText });
  const reqs = Array.isArray(ticket?.requirements) ? ticket.requirements : [];
  const dispositions = asks.map((ask) => {
    let best = null, bestScore = 0;
    for (const r of reqs) {
      const s = overlap(ask.text, r.text);
      if (s > bestScore) { bestScore = s; best = r; }
    }
    if (!best || bestScore < threshold) {
      return { ask: ask.text, disposition: DISPOSITION.UNACCOUNTED, match: null, score: +bestScore.toFixed(2) };
    }
    const d =
      best.state === 'done' ? DISPOSITION.VERIFIED
      : best.state === 'outstanding' ? DISPOSITION.OUTSTANDING
      : DISPOSITION.NEEDS_CLARIFICATION;
    return { ask: ask.text, disposition: d, match: best.text, requirementId: best.id, score: +bestScore.toFixed(2), note: best.note || null };
  });

  const unaccounted = dispositions.filter((d) => d.disposition === DISPOSITION.UNACCOUNTED);
  const outstanding = dispositions.filter((d) => d.disposition === DISPOSITION.OUTSTANDING);
  const unclear = dispositions.filter((d) => d.disposition === DISPOSITION.NEEDS_CLARIFICATION);
  const verified = dispositions.filter((d) => d.disposition === DISPOSITION.VERIFIED);

  // No asks detected at all is NOT a pass. It means this check had nothing to
  // say, and a check with nothing to say must not be read as agreement.
  const silent = asks.length === 0;

  return {
    complete: !silent && unaccounted.length === 0 && outstanding.length === 0 && unclear.length === 0,
    silent,
    dispositions,
    verified: verified.length,
    unaccounted,
    outstanding,
    unclear,
    total: asks.length,
    reason: silent
      ? 'no requests could be read out of the original text, so this check establishes nothing either way'
      : unaccounted.length
        ? `${unaccounted.length} thing(s) they asked for were never captured as a task`
        : outstanding.length
          ? `${outstanding.length} thing(s) are known to be unfinished`
          : unclear.length
            ? `${unclear.length} thing(s) have no confirmation either way`
            : null,
  };
}

/**
 * The two checks in one call, for the completion gate.
 *
 * `mayClose` is the answer the pipeline acts on. It is false whenever anything
 * is unaccounted for, unfinished, unconfirmed, OR when the check could not
 * read the request at all — because "I could not tell" has to behave like "no"
 * at a gate whose failure mode is lying to a client.
 */
export function reviewBeforeClosing(requestText, ticket, opts = {}) {
  const cov = checkCompletion(requestText, ticket, opts);
  return {
    mayClose: cov.complete,
    coverage: cov,
    // the sentence for the owner, naming the worst problem rather than all of them
    headline: cov.complete
      ? null
      : cov.unaccounted.length
        ? `Never captured: ${cov.unaccounted.map((d) => d.ask).join('; ').slice(0, 200)}`
        : cov.reason,
  };
}
