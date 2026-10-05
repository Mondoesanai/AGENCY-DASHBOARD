// Business cards start a RELATIONSHIP, not a lead list.
//
// The failure this exists to prevent is the one that makes people hate this
// whole category of software: you meet someone at a chamber breakfast, they
// hand you a card, and three days later they get a templated "I noticed your
// business could be losing customers" cold email. The information that they
// were met, what they actually asked for, and what was promised to them all
// existed at intake — and was thrown away, because the system only had one
// pipeline and everything went down it.
//
// So routing is explicit, the reason is recorded in words, and the next action
// and its date are visible and editable. A contact whose route says "met at
// Plano Chamber, asked for a preview, follow up Tuesday" must not be
// reachable by the cold sequence at all.
//
// WHAT THIS MODULE WILL NOT DO
//
//   · It will not infer that a meeting happened. "I was handed a card" and "we
//     had a conversation" are different facts and are recorded separately,
//     because the first message says "great meeting you" only in one of them.
//   · It will not grant channel permission. Holding a card is not consent to
//     text someone (lib/phone.js `mayText` is the gate, and it stays the gate).
//   · It will not promise a preview exists. That is `lib/previews.js`, and the
//     "your preview is ready" message is gated on a real, reachable URL.

import { store } from './store.js';

const KEY = (contactId) => `relationship:${contactId}`;
const INDEX = 'relationships:all';

/** How the contact was actually obtained. These are not interchangeable. */
export const ENCOUNTER = Object.freeze({
  CONVERSATION: 'conversation',     // we spoke; "great meeting you" is true
  CARD_ONLY: 'card-only',           // their card reached us without a conversation
  SHARED_GROUP: 'shared-group',     // same directory/group, never met
});

/** What the person actually expressed. Recorded, never guessed. */
export const INTEREST = Object.freeze({
  PREVIEW: 'wants-preview',
  CONVERSATION: 'wants-conversation',
  LATER: 'follow-up-later',
  NONE: 'no-specific-interest',
  NOT_INTERESTED: 'not-interested',
});

/**
 * The routes. `why` is written from the record, so the dashboard can always
 * answer "why is this person in this path?" without anyone reconstructing it.
 */
export const PATH = Object.freeze({
  PREVIEW_REQUESTED: 'preview-requested',
  CONVERSATION: 'conversation',
  FOLLOW_UP_LATER: 'follow-up-later',
  GENTLE_INTRO: 'gentle-intro',
  GROUP_CONTEXT: 'group-context',
  LOW_PRIORITY_GOOD_SITE: 'low-priority-good-site',
  ENDED: 'ended',
});

export const PATH_LABEL = Object.freeze({
  [PATH.PREVIEW_REQUESTED]: 'Asked for a preview',
  [PATH.CONVERSATION]: 'Wants a conversation',
  [PATH.FOLLOW_UP_LATER]: 'Follow up later',
  [PATH.GENTLE_INTRO]: 'Met, no specific interest',
  [PATH.GROUP_CONTEXT]: 'Same group, never met',
  [PATH.LOW_PRIORITY_GOOD_SITE]: 'Already has a good site',
  [PATH.ENDED]: 'Ended',
});

/** Cold sequences may never touch these. The whole point of routing. */
export const NEVER_COLD = Object.freeze([
  PATH.PREVIEW_REQUESTED,
  PATH.CONVERSATION,
  PATH.FOLLOW_UP_LATER,
  PATH.GENTLE_INTRO,
  PATH.GROUP_CONTEXT,
  PATH.LOW_PRIORITY_GOOD_SITE,
  PATH.ENDED,
]);

const DAY = 24 * 3600e3;

/**
 * Decide the path from what was actually recorded.
 *
 * Order matters and is not arbitrary: an opt-out or a stated lack of interest
 * ends things regardless of anything else, a date the person named is honoured
 * before any judgement of ours, and only then do we consider what they wanted.
 */
export function route(interaction = {}, { now = Date.now() } = {}) {
  const {
    encounter = ENCOUNTER.CARD_ONLY,
    interest = INTEREST.NONE,
    promisedFollowUpAt = null,
    requestedNextStep = '',
    event = '',
    networkingGroup = '',
    hasGoodWebsite = false,
    notes = '',
  } = interaction;

  const met = encounter === ENCOUNTER.CONVERSATION;
  const where = event || networkingGroup || '';

  // 1. They said no. Nothing else is considered.
  if (interest === INTEREST.NOT_INTERESTED) {
    return {
      path: PATH.ENDED,
      why: 'They said they are not interested. Nothing further is scheduled, and the sequence is over rather than paused.',
      nextAction: 'Nothing. Do not contact about this again.',
      dueAt: null,
      mayRunColdSequence: false,
    };
  }

  // 2. A date THEY named outranks anything we would have chosen.
  //
  // It governs WHEN WE CONTACT THEM, not what they asked for. Someone who said
  // "send me a preview — follow up Tuesday" still needs the preview built, and
  // an earlier version of this dropped the request on the floor because the
  // date matched first. The work starts now; the message waits for their date.
  if (promisedFollowUpAt) {
    const at = Number(promisedFollowUpAt);
    const alsoWantsPreview = interest === INTEREST.PREVIEW;
    return {
      path: PATH.FOLLOW_UP_LATER,
      why: `They asked to be contacted ${new Date(at).toDateString()}${where ? ` when you met at ${where}` : ''}. That date is theirs, so nothing goes out before it.`
        + (alsoWantsPreview ? ' They also asked for a preview, so it gets built in the meantime and sent on their date.' : ''),
      nextAction: requestedNextStep || (alsoWantsPreview ? 'Build the preview; send it on their date.' : 'Follow up as promised.'),
      dueAt: at,
      mayRunColdSequence: false,
      // the rule that makes this path mean anything
      suppressUntil: at,
      createsPreviewTask: alsoWantsPreview,
    };
  }

  if (interest === INTEREST.LATER) {
    const at = now + 14 * DAY;
    return {
      path: PATH.FOLLOW_UP_LATER,
      why: 'They asked to be contacted later but did not name a date, so this is scheduled two weeks out rather than guessed at sooner.',
      nextAction: requestedNextStep || 'Check back in.',
      dueAt: at,
      mayRunColdSequence: false,
      suppressUntil: at,
    };
  }

  // 3. What they actually asked for.
  if (interest === INTEREST.PREVIEW) {
    return {
      path: PATH.PREVIEW_REQUESTED,
      why: `They asked to see a preview${where ? ` when you met at ${where}` : ''}. Until one exists and is reachable, there is nothing truthful to send.`,
      nextAction: 'Build the preview. The follow-up unlocks when it is ready.',
      dueAt: now + 3 * DAY,
      mayRunColdSequence: false,
      createsPreviewTask: true,
    };
  }

  if (interest === INTEREST.CONVERSATION) {
    return {
      path: PATH.CONVERSATION,
      why: `They wanted to talk${where ? ` — you met at ${where}` : ''}. Answer what they asked before offering anything.`,
      nextAction: requestedNextStep || 'Answer their question, and offer a call if it fits.',
      dueAt: now + 2 * DAY,
      mayRunColdSequence: false,
    };
  }

  // 4. No stated interest — the wording depends entirely on whether you met.
  if (hasGoodWebsite) {
    return {
      path: PATH.LOW_PRIORITY_GOOD_SITE,
      why: 'Their site already works. There is no honest problem to lead with, so this sits at low priority rather than inventing one.',
      nextAction: 'Nothing scheduled. A recheck may raise an internal opportunity if something real changes.',
      dueAt: null,
      mayRunColdSequence: false,
      lowPriority: true,
    };
  }

  if (met) {
    return {
      path: PATH.GENTLE_INTRO,
      why: `You met${where ? ` at ${where}` : ''} but they did not ask for anything. A short introduction referring to the actual conversation is the honest opening.`,
      nextAction: 'Send a short note referring to what you actually talked about.',
      dueAt: now + 3 * DAY,
      mayRunColdSequence: false,
    };
  }

  if (encounter === ENCOUNTER.SHARED_GROUP) {
    return {
      path: PATH.GROUP_CONTEXT,
      why: `You have never met — you are both in ${networkingGroup || 'the same group'}. The opening may say that and nothing more.`,
      nextAction: 'Introduce yourself using the group as the only context.',
      dueAt: now + 5 * DAY,
      mayRunColdSequence: false,
      mustNotClaimMeeting: true,
    };
  }

  // card reached us with no conversation
  return {
    path: PATH.GENTLE_INTRO,
    why: 'Their card reached you without a conversation, so the opening cannot claim one.',
    nextAction: 'Introduce yourself. Do not refer to a meeting.',
    dueAt: now + 5 * DAY,
    mayRunColdSequence: false,
    mustNotClaimMeeting: true,
  };
}

/** Store the decision against the contact, with the interaction it came from. */
export async function assignRoute(contactId, interaction = {}, { now = Date.now(), by = 'owner' } = {}) {
  if (!contactId) return { ok: false, error: 'no contact' };
  const decision = route(interaction, { now });
  const rec = {
    contactId,
    ...decision,
    interaction: {
      encounter: interaction.encounter || ENCOUNTER.CARD_ONLY,
      interest: interaction.interest || INTEREST.NONE,
      requestedNextStep: String(interaction.requestedNextStep || '').slice(0, 300),
      promisedFollowUpAt: interaction.promisedFollowUpAt || null,
      event: String(interaction.event || '').slice(0, 160),
      networkingGroup: String(interaction.networkingGroup || '').slice(0, 160),
      notes: String(interaction.notes || '').slice(0, 1000),
      hasGoodWebsite: !!interaction.hasGoodWebsite,
    },
    assignedAt: now,
    assignedBy: by,
    editedAt: null,
  };
  await store.set(KEY(contactId), JSON.stringify(rec));
  await store.sadd(INDEX, contactId).catch(() => {});
  return { ok: true, relationship: rec };
}

/**
 * `null` means there is no relationship on record. `undefined` means we could
 * not find out. Collapsing those two into `null` is what made `mayRunCold`
 * fail OPEN — a store blip read as "this person never gave us a card", which
 * is the one wrong answer that puts a cold message in front of someone you
 * met at a chamber breakfast.
 */
export async function getRoute(contactId) {
  let raw;
  try {
    raw = await store.get(KEY(contactId));
  } catch {
    return undefined;
  }
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return undefined; // a record exists but is unreadable — also not "none"
  }
}

/**
 * The owner can override the path, the next action and the date.
 *
 * An override keeps the original `why` and records that a person changed it,
 * because "why is this person here?" has a different answer once someone has
 * intervened, and silently rewriting the reason would lose that.
 */
export async function editRoute(contactId, patch = {}, { now = Date.now(), by = 'owner' } = {}) {
  const cur = await getRoute(contactId);
  if (!cur) return { ok: false, error: 'no relationship on record for this contact' };
  const next = { ...cur };
  if (patch.path) {
    if (!Object.values(PATH).includes(patch.path)) return { ok: false, error: `unknown path "${patch.path}"` };
    next.path = patch.path;
    next.why = `${cur.why} — changed to "${PATH_LABEL[patch.path]}" by ${by}${patch.reason ? `: ${patch.reason}` : ''}.`;
  }
  if (patch.nextAction !== undefined) next.nextAction = String(patch.nextAction).slice(0, 300);
  if (patch.dueAt !== undefined) next.dueAt = patch.dueAt === null ? null : Number(patch.dueAt);
  next.editedAt = now;
  next.editedBy = by;
  // an override never unlocks the cold sequence: these are all people the
  // owner has some relationship with, and that does not change by retyping it
  next.mayRunColdSequence = false;
  await store.set(KEY(contactId), JSON.stringify(next));
  return { ok: true, relationship: next };
}

/**
 * May a COLD sequence contact this person?
 *
 * Fails closed: an unreadable record means we do not know how we got them, and
 * "we could not tell" must not become "treat as a cold lead".
 */
export async function mayRunCold(contactId) {
  const rel = await getRoute(contactId);
  if (rel === undefined) {
    return { ok: false, reason: 'the relationship record could not be read, so this contact is not treated as cold' };
  }
  if (rel === null) return { ok: true, reason: 'no relationship on record — this contact did not come from a card or a group' };
  return {
    ok: false,
    reason: `this contact came from a relationship (${PATH_LABEL[rel.path] || rel.path}), so the cold sequence does not apply. ${rel.why}`,
    path: rel.path,
  };
}

/**
 * Everyone you have a relationship with, due soonest first.
 *
 * Returns ALL of them, not only the overdue ones. The route, the reason and
 * the date are the things the owner needs to be able to see and correct, and a
 * list that only appears on the day it fires gives them no chance to notice
 * that someone was filed under the wrong path a week earlier. `due` is the
 * subset that has actually come round.
 */
export async function dueFollowUps({ now = Date.now(), limit = 50 } = {}) {
  let ids = [];
  try {
    ids = await store.smembers(INDEX);
  } catch {
    return { ok: false, error: 'the follow-up list could not be read', due: [], all: [] };
  }
  const all = [];
  for (const id of ids) {
    const rel = await getRoute(id);
    if (!rel || rel === undefined) continue;
    if (rel.path === PATH.ENDED) continue;
    all.push(rel);
  }
  // soonest first; anything with no date sits at the end rather than the top
  all.sort((a, b) => (a.dueAt || Infinity) - (b.dueAt || Infinity));
  const due = all.filter((r) => r.dueAt && r.dueAt <= now);
  return { ok: true, due, all: all.slice(0, limit), total: all.length, dueCount: due.length };
}

/** Plain words for the panel: path, why, what next, and when. */
export function describe(rel) {
  if (!rel) return null;
  return {
    path: rel.path,
    label: PATH_LABEL[rel.path] || rel.path,
    why: rel.why,
    nextAction: rel.nextAction,
    when: rel.dueAt ? new Date(rel.dueAt).toDateString() : 'nothing scheduled',
    edited: !!rel.editedAt,
    mayClaimMeeting: rel.interaction?.encounter === ENCOUNTER.CONVERSATION,
  };
}
