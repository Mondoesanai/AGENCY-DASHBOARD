// R7.3 / R7.4 — answering a reply from an APPROVED knowledge base.
//
// The dangerous version of this feature is a model that answers freely from the
// conversation. It will eventually promise a discount, invent availability, or
// agree to contract terms nobody offered — and a prospect is entitled to hold
// us to whatever we wrote.
//
// So the rule here is closed-world: an answer may only be assembled from
// entries the owner has approved. A question with no matching entry is NOT
// answered. It is escalated, which is a normal outcome and not a failure.
//
// "Send me information first" is treated as a real instruction, not an
// objection to be handled. Pushing a booking link at someone who just asked for
// information is the single most common way this kind of automation annoys
// people, and it is explicitly prevented.

import { getSettings, priceLine, pricingBlocker } from './settings.js';
import { REPLY_KINDS } from './replies.js';
import { store } from './store.js';

const KB_KEY = 'knowledge:entries';

/**
 * The starting set. Every entry is phrased as something the owner can stand
 * behind, and anything that depends on a configured value says so rather than
 * inventing one.
 */
export function defaultKnowledge() {
  return [
    {
      id: 'what-you-do',
      approved: true,
      matches: [/what do you (do|offer)/i, /who are you/i, /what is this (about|regarding)/i],
      answer: 'I build and look after websites for local businesses — the build itself, then hosting, changes whenever you want them, and ongoing work on getting you found.',
    },
    {
      id: 'price',
      approved: true,
      matches: [/how much/i, /\bprice|pricing|cost\b/i, /what do you charge/i],
      // the answer is ASSEMBLED from settings, never hard-coded
      needs: 'pricing',
      answer: (s) => `It's ${priceLine(s)}. The monthly covers ${(s.pricing.includes || []).join(', ').toLowerCase()}.`,
    },
    {
      id: 'how-long',
      approved: true,
      matches: [/how long (does it|will it|would it) take/i, /turnaround/i, /\btimeline\b/i],
      answer: 'Usually a couple of weeks from the point I have your content, though it depends on how much there is.',
    },
    {
      id: 'contract',
      approved: true,
      matches: [/\bcontract\b/i, /tied in/i, /lock(ed)? in/i, /cancel any ?time/i],
      answer: 'The monthly is month to month. If you want to stop, you stop — I would rather you stayed because it is working.',
    },
    {
      id: 'who-owns-it',
      approved: true,
      matches: [/who owns/i, /\bown the (site|website|domain)\b/i],
      answer: 'You do. The domain stays in your name and the site is yours.',
    },
    {
      id: 'see-examples',
      approved: true,
      matches: [/\bexamples?\b/i, /\bportfolio\b/i, /other (work|clients|sites)/i],
      answer: 'Happy to send a few examples of recent work.',
    },
  ];
}

/** Plain phrases the owner typed, compiled to safe, escaped matchers. */
function compilePhrases(phrases) {
  return (phrases || [])
    .map((p) => String(p).trim())
    .filter(Boolean)
    .map((p) => new RegExp('\\b' + p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'));
}

export async function getKnowledge() {
  const defaults = defaultKnowledge();
  const raw = await store.get(KB_KEY).catch(() => null);
  if (!raw) return defaults;
  try {
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(saved) || !saved.length) return defaults;
    const byId = Object.fromEntries(defaults.map((e) => [e.id, e]));
    return saved.map((e) => {
      const base = byId[e.id];
      if (base) {
        // A built-in entry: the owner may edit the TEXT and the approval, but
        // the matchers and any computed answer come from the code. A saved copy
        // used to drop `matches` entirely, which silently made the whole
        // knowledge base unmatchable the moment it was edited once.
        return {
          ...base,
          approved: e.approved === true,
          answer: typeof base.answer === 'function' ? base.answer : (typeof e.answer === 'string' && e.answer ? e.answer : base.answer),
        };
      }
      // A custom entry: phrases are plain strings, escaped on compile, so a
      // typo cannot become a catch-all regex.
      return {
        id: e.id,
        approved: e.approved === true,
        answer: typeof e.answer === 'string' ? e.answer : '',
        matchPhrases: e.matchPhrases || [],
        matches: compilePhrases(e.matchPhrases),
        custom: true,
      };
    });
  } catch {
    return defaults;
  }
}

export async function saveKnowledge(entries) {
  const safe = (entries || []).map((e) => ({
    id: String(e.id || '').slice(0, 60),
    approved: e.approved === true,
    answer: typeof e.answer === 'string' ? e.answer.slice(0, 1200) : undefined,
    needs: e.needs || undefined,
    // preserved so a custom entry is still matchable after a round-trip
    matchPhrases: Array.isArray(e.matchPhrases) ? e.matchPhrases.map((p) => String(p).slice(0, 80)).slice(0, 12) : undefined,
  }));
  await store.set(KB_KEY, JSON.stringify(safe));
  return safe;
}

/** Did they ask us to send information rather than talk? */
export function wantsInformationFirst(text = '') {
  return [
    /send (me )?(some )?(more )?info/i,
    /\binformation first\b/i,
    /email me (the )?details/i,
    /put (it|something) in (an )?email/i,
    /not ready (to|for) (a )?call/i,
    /rather not (get on|do) a call/i,
    /\bno calls?\b/i,
  ].some((re) => re.test(String(text)));
}

/** Reply kinds where offering a booking link is reasonable at all. */
const BOOKING_APPROPRIATE = new Set([REPLY_KINDS.WANTS_CALL, REPLY_KINDS.INTERESTED]);

/**
 * Build a reply from approved material only.
 *
 * Returns `{ ok: false, escalate: true }` whenever it cannot answer honestly —
 * which is the correct outcome far more often than people expect.
 */
export async function draftAnswer({ kind, text = '', settings = null, bookingUrl = null, knowledge = null } = {}) {
  const s = settings || (await getSettings());
  const kb = (knowledge || (await getKnowledge())).filter((e) => e.approved);

  // Never hold a conversation with a machine or a bounce (R7.5).
  if (kind === REPLY_KINDS.AUTO_REPLY || kind === REPLY_KINDS.BOUNCE) {
    return { ok: false, escalate: false, reason: 'automated mail is never replied to conversationally' };
  }
  // An opt-out is obeyed, not answered.
  if (kind === REPLY_KINDS.OPT_OUT) {
    return { ok: false, escalate: false, reason: 'an opt-out is actioned, never argued with' };
  }

  const matched = kb.filter((e) => (e.matches || []).some((re) => re.test(text)));

  // A question we have no approved answer for is escalated, not improvised.
  if (!matched.length) {
    return {
      ok: false,
      escalate: true,
      reason: 'nothing in the approved knowledge base answers this, so it goes to a person rather than being improvised',
    };
  }

  const paragraphs = [];
  const used = [];
  const blocked = [];
  for (const e of matched) {
    if (e.needs === 'pricing' && !s.pricing.configured) {
      blocked.push({ id: e.id, why: pricingBlocker(s) });
      continue;
    }
    const line = typeof e.answer === 'function' ? e.answer(s) : e.answer;
    if (line) { paragraphs.push(line); used.push(e.id); }
  }

  if (!paragraphs.length) {
    return {
      ok: false,
      escalate: true,
      reason: blocked.length
        ? `the only matching answer needs something that is not configured: ${blocked.map((b) => b.why).join(' ')}`
        : 'no approved answer could be assembled',
      blocked,
    };
  }

  // "Information first" is an instruction. Honour it.
  const infoFirst = wantsInformationFirst(text);
  const mayOfferBooking = !!bookingUrl && BOOKING_APPROPRIATE.has(kind) && !infoFirst;
  if (mayOfferBooking) {
    paragraphs.push(`If it is easier to talk it through, here is my calendar: ${bookingUrl}`);
  }

  return {
    ok: true,
    escalate: false,
    body: paragraphs.join('\n\n'),
    usedEntries: used,
    blockedEntries: blocked,
    offeredBooking: mayOfferBooking,
    respectedInformationFirst: infoFirst,
    // everything in the body came from an approved entry or the settings
    sourcedOnly: true,
  };
}

// ---------------------------------------------------------------------------
// R7.6 — loop prevention.
//
// Two machines can talk to each other forever, and an auto-responder on the
// other end will happily do it at full speed. Four independent brakes, because
// any one of them can be defeated by a sufficiently odd correspondent:
//
//   MAX TURNS  — a conversation gets a small number of automatic replies, then
//                a person takes over. Not "then it stops" — stopping silently
//                would lose a live prospect.
//   COOLDOWN   — no two automatic replies to the same contact inside a window,
//                whatever arrives in between.
//   DEDUP      — the same outbound text is never sent twice to one contact.
//   ESCALATION — hitting any brake hands the thread to a person with the reason.
// ---------------------------------------------------------------------------

export const LOOP_LIMITS = Object.freeze({
  maxAutoTurns: 3,
  cooldownMinutes: 30,
});

const TURNS = (contactId) => `convo:turns:${contactId}`;
const LAST_AUTO = (contactId) => `convo:lastauto:${contactId}`;
const SENT_HASH = (contactId) => `convo:sent:${contactId}`;

function hashText(s) {
  let h = 0;
  const t = String(s).replace(/\s+/g, ' ').trim().toLowerCase();
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return String(h);
}

/**
 * May we send ANOTHER automatic reply to this contact right now?
 * Every refusal escalates rather than simply stopping.
 */
export async function mayAutoReply(contactId, body, { now = Date.now(), limits = LOOP_LIMITS } = {}) {
  const turns = Number(await store.get(TURNS(contactId)).catch(() => 0)) || 0;
  if (turns >= limits.maxAutoTurns) {
    return {
      ok: false,
      escalate: true,
      reason: `this conversation has had ${turns} automatic replies (limit ${limits.maxAutoTurns}) — a person should take it from here`,
      brake: 'max-turns',
    };
  }

  const last = Number(await store.get(LAST_AUTO(contactId)).catch(() => 0)) || 0;
  const waitMs = limits.cooldownMinutes * 60000;
  if (last && now - last < waitMs) {
    return {
      ok: false,
      escalate: true,
      reason: `an automatic reply went out ${Math.round((now - last) / 60000)} minutes ago; the cooldown is ${limits.cooldownMinutes} minutes`,
      brake: 'cooldown',
      retryAt: last + waitMs,
    };
  }

  if (body) {
    const seen = await store.smembers(SENT_HASH(contactId)).catch(() => []);
    if (seen.includes(hashText(body))) {
      return {
        ok: false,
        escalate: true,
        reason: 'this exact reply has already been sent to this contact once — repeating it is how a loop looks from the outside',
        brake: 'duplicate',
      };
    }
  }

  return { ok: true, turnsSoFar: turns };
}

/** Record that an automatic reply went out, so the brakes have something to count. */
export async function recordAutoReply(contactId, body, { now = Date.now() } = {}) {
  const turns = (Number(await store.get(TURNS(contactId)).catch(() => 0)) || 0) + 1;
  await store.set(TURNS(contactId), String(turns));
  await store.set(LAST_AUTO(contactId), String(now));
  if (body) await store.sadd(SENT_HASH(contactId), hashText(body));
  return { turns };
}

/** A human taking over resets the automatic budget — they own the thread now. */
export async function handOver(contactId, to = 'owner') {
  await store.set(TURNS(contactId), String(LOOP_LIMITS.maxAutoTurns)); // no more automatic replies
  await store.set(`convo:owner:${contactId}`, to);
  return { contactId, ownedBy: to, automaticRepliesRemaining: 0 };
}

export async function conversationState(contactId) {
  const turns = Number(await store.get(TURNS(contactId)).catch(() => 0)) || 0;
  const owner = await store.get(`convo:owner:${contactId}`).catch(() => null);
  return {
    autoTurns: turns,
    automaticRepliesRemaining: Math.max(0, LOOP_LIMITS.maxAutoTurns - turns),
    takenOverBy: owner || null,
  };
}

/**
 * A belt-and-braces check on any outbound draft, whatever produced it.
 * These are the specific inventions R7.4 forbids.
 */
export function containsUnapprovedClaim(body = '') {
  const text = String(body);
  const findings = [];
  const rules = [
    [/\b\d+% off\b|\bdiscount\b|\bspecial price\b|\bdeal for you\b/i, 'offers a discount'],
    [/\bguarantee(d)?\b|\bI promise\b/i, 'makes a guarantee'],
    [/\bfree\b(?!.{0,20}\bpreview\b)/i, 'claims something is free'],
    [/\bI have (a slot|availability) (on|at)\b|\bI'?m free (on|at)\b/i, 'invents availability'],
    [/\bno obligation contract\b|\bsign (here|this)\b|\bterms? (are|is)\b/i, 'states contract terms'],
    [/\brank (you )?(#?1|first|top)\b|\bguaranteed? (traffic|leads|sales)\b/i, 'promises a ranking or result'],
  ];
  for (const [re, label] of rules) if (re.test(text)) findings.push(label);
  return { clean: findings.length === 0, findings };
}
