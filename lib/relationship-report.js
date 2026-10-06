// The two numbers R13.8 asked for and nothing computed.
//
// `sms-send.stats()` counts messages and `previews.stats()` counts promises.
// Both are useful and neither answers the question the owner actually has
// after a networking event: *was that worth doing, and am I keeping up with
// the people who answered?*
//
// So two metrics, and both are built to refuse rather than to flatter:
//
//   COST PER QUALIFIED CONVERSATION — every cost figure here is an estimate
//   until the provider's billing is reconciled, and that word travels with the
//   number instead of being a footnote somewhere else. Below a floor it
//   reports no figure at all: "$0.79 per conversation" from one conversation
//   is arithmetic, not a finding, and it is exactly the sort of number that
//   gets quoted back months later.
//
//   OWNER RESPONSE TIME — how long people wait for an answer after they reply.
//   Measured only across conversations where somebody actually answered;
//   unanswered ones are counted SEPARATELY and never averaged in, because
//   folding a four-day silence into a mean as "pending" is how a slow response
//   time hides inside a good-looking average.
//
// Everything here reports relationship work separately from cold discovery.
// They are different activities with different economics, and a scanned card
// is not a qualified lead.

import { store } from './store.js';

/** Below this, no per-conversation cost is reported. */
export const MIN_CONVERSATIONS_FOR_COST = 5;

/**
 * A conversation counts as QUALIFIED when the person showed interest in words.
 * Delivery is not interest; a card in a pocket is not a lead.
 */
export const QUALIFYING_KINDS = Object.freeze(['interested', 'wants-details', 'wants-preview', 'wants-call']);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

const hours = (ms) => +(ms / 3600e3).toFixed(1);

/**
 * How long people wait for the owner to answer.
 *
 * Returns `median` and `worst` in hours over ANSWERED conversations, plus a
 * separate count of people still waiting and how long the oldest has waited.
 * The two are never combined.
 */
export async function responseTime({ now = Date.now() } = {}) {
  // `conv:all` is the index conversations.js actually keeps. It is not
  // exported, so it is written out here rather than guessed at — an invented
  // key reads as "no conversations", which is the failure this whole module
  // exists to avoid reporting.
  let ids = [];
  try {
    ids = await store.smembers('conv:all');
  } catch {
    return { ok: false, error: 'the conversation list could not be read' };
  }
  const { conversationFor } = await import('./conversations.js');
  const waits = [];
  let stillWaiting = 0;
  let longestWaitMs = 0;

  for (const id of ids) {
    let c;
    try { c = await conversationFor(id); } catch { continue; }
    if (!c || c.ok === false || !c.lastInbound) continue;
    const answeredAt = c.lastOutbound && c.lastOutbound.at > c.lastInbound.at ? c.lastOutbound.at : null;
    if (answeredAt) {
      waits.push(answeredAt - c.lastInbound.at);
    } else {
      stillWaiting++;
      longestWaitMs = Math.max(longestWaitMs, now - c.lastInbound.at);
    }
  }

  return {
    ok: true,
    answered: waits.length,
    medianHours: waits.length ? hours(median(waits)) : null,
    worstHours: waits.length ? hours(Math.max(...waits)) : null,
    // deliberately separate: a four-day silence folded into a mean as
    // "pending" is how a slow response time hides inside a good average
    stillWaiting,
    longestWaitHours: stillWaiting ? hours(longestWaitMs) : null,
    note: waits.length
      ? null
      : 'nobody has been answered yet, so there is no response time to report',
  };
}

/**
 * What a qualified conversation cost.
 *
 * `qualified` counts people who said something that shows interest — not
 * people messaged, not messages delivered. Returns `costPerQualified: null`
 * below the floor, with the reason, rather than a number computed from three
 * events.
 */
export async function costPerQualifiedConversation({ minConversations = MIN_CONVERSATIONS_FOR_COST } = {}) {
  const { stats: smsStats } = await import('./sms-send.js');
  const s = await smsStats();
  if (!s.ok) return { ok: false, error: s.error || 'SMS figures could not be read' };

  // qualified = distinct people whose recorded reply showed interest
  let qualified = 0;
  let replies = [];
  try {
    const { listReplies } = await import('./replies.js');
    replies = (await listReplies({ limit: 1000 })) || []; // returns the array itself
    const people = new Set();
    for (const rep of replies) {
      if (!rep || !QUALIFYING_KINDS.includes(rep.kind)) continue;
      people.add(rep.contactId || `anon:${rep.id}`);
    }
    qualified = people.size;
  } catch {
    return { ok: false, error: 'replies could not be read, so qualification is unknown' };
  }

  const estimatedCents = Number(s.estimatedCents || 0);
  const enough = qualified >= minConversations;

  return {
    ok: true,
    qualified,
    estimatedCents: +estimatedCents.toFixed(2),
    // the floor is the point: a cost-per from one or two events reads as a
    // finding and is arithmetic
    costPerQualifiedCents: enough ? +(estimatedCents / qualified).toFixed(2) : null,
    isEstimate: true,
    reason: enough
      ? null
      : `${qualified} qualified conversation(s) is too few to divide by — at least ${minConversations} before a per-conversation cost means anything`,
    // the word travels with the number rather than living in a footnote
    costNote: 'Every figure here is an estimate until the provider\'s billing is reconciled. Message cost is modelled per segment, not billed.',
  };
}

/**
 * Relationship results, reported apart from cold discovery.
 *
 * The separation is the requirement. They are different activities with
 * different economics, and reporting them together makes a good month of
 * networking look like a good month of prospecting or vice versa.
 */
export async function relationshipReport({ now = Date.now() } = {}) {
  const out = { ok: true, generatedAt: now };

  try {
    const { getRoute, PATH, PATH_LABEL } = await import('./relationship.js');
    const ids = await store.smembers('relationships:all').catch(() => []);
    const byPath = {};
    let total = 0;
    for (const id of ids) {
      const rel = await getRoute(id);
      if (rel === undefined) continue;      // unreadable is not "no relationship"
      if (!rel) continue;
      total++;
      byPath[rel.path] = (byPath[rel.path] || 0) + 1;
    }
    out.relationships = {
      total,
      byPath,
      labels: PATH_LABEL,
      // a scanned card is not a qualified lead, and the count of cards must
      // never be presented as a count of interested people
      note: 'These are people met, routed by what was actually said. A card is not a lead.',
    };
  } catch (e) {
    out.relationships = { error: 'relationship routes could not be read', detail: String(e.message || e).slice(0, 80) };
  }

  try {
    const { stats: previewStats } = await import('./previews.js');
    out.previews = await previewStats();
  } catch { out.previews = { error: 'preview tasks could not be read' }; }

  try {
    const { stats: smsStats } = await import('./sms-send.js');
    out.sms = await smsStats();
  } catch { out.sms = { error: 'SMS figures could not be read' }; }

  out.responseTime = await responseTime({ now });
  out.cost = await costPerQualifiedConversation({});

  // The separation, stated in the payload itself so a renderer cannot merge
  // them by accident.
  out.scope = 'relationship';
  out.excludes = 'cold discovery and cold outreach are reported separately and are not included in any figure here';
  return out;
}
