// R9.7 — every change is bounded by owner-approved settings, logged, and
// reversible.
//
// The failure this prevents is not a dramatic one. It is opening the dashboard
// in six weeks, seeing that the message has drifted into something nobody
// would have approved, and having no way to answer "when did this change, who
// changed it, and what was it before?" — let alone put it back. A system that
// edits itself without a ledger is a system that cannot be audited or undone,
// and at that point the only safe action is to turn the whole thing off.
//
// Three properties, in order of how often they are skipped:
//
//  1. REVERSIBLE. Every entry stores the BEFORE value, not just the after.
//     A log that records "weights changed" is a diary; a log that records what
//     they were is an undo. The difference costs one field and is the entire
//     value of the exercise.
//
//  2. BOUNDED. The owner sets what may change without being asked, and by how
//     much. The bounds are settings, not constants — an unbounded automatic
//     change is indistinguishable from a bug until it is expensive.
//
//  3. LOGGED WITH AN ACTOR. "owner" and "automatic" are different facts, and
//     the first question after any surprise is which one it was.

import { store } from './store.js';

const LOG_KEY = 'optimisation:log';
const BOUNDS_KEY = 'optimisation:bounds';

export const CHANGE_KINDS = Object.freeze({
  EXPERIMENT_CREATED: 'experiment-created',
  STATE_CHANGED: 'experiment-state-changed',
  VARIANTS_CHANGED: 'variants-changed',
  CONTACT_REASSIGNED: 'contact-reassigned',
  WEIGHTS_CHANGED: 'weights-changed',
  BOUNDS_CHANGED: 'bounds-changed',
});

export const ACTORS = Object.freeze(['owner', 'automatic']);

/**
 * What may change without the owner being asked, and by how much.
 * Deliberately conservative: nothing automatic may do anything yet.
 */
export const DEFAULT_BOUNDS = Object.freeze({
  // nothing in this system changes a live experiment by itself today; these
  // exist so that when something does, the limits already apply to it
  allowAutomaticChanges: false,
  maxWeightShiftPerChange: 0.2,   // no single automatic change may move more than 20% of traffic
  maxChangesPerWeek: 3,            // and not more than three times a week
  requireOwnerForStateChange: true, // starting and stopping stays a person's decision
  requireOwnerForReassignment: true,
});

export async function getBounds() {
  let raw;
  try {
    raw = await store.get(BOUNDS_KEY);
  } catch {
    // unreadable bounds mean we do not know what is permitted, and the safe
    // reading of "unknown limits" is the strictest ones
    return { ...DEFAULT_BOUNDS, unreadable: true };
  }
  if (!raw) return { ...DEFAULT_BOUNDS };
  try {
    const b = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ...DEFAULT_BOUNDS, ...b };
  } catch {
    return { ...DEFAULT_BOUNDS };
  }
}

export async function setBounds(patch = {}, { by = 'owner' } = {}) {
  // and the check has to be here too, not only in mayChange: a caller that
  // writes first and logs afterwards would have already changed the bounds by
  // the time anything refused it.
  const permitted = await mayChange({ kind: CHANGE_KINDS.BOUNDS_CHANGED, actor: by });
  if (!permitted.ok) return { ok: false, error: permitted.reason, code: 'not-permitted' };

  const current = await getBounds();
  const next = { ...current };
  for (const k of Object.keys(DEFAULT_BOUNDS)) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  delete next.unreadable;
  await store.set(BOUNDS_KEY, JSON.stringify(next));
  await recordChange({
    kind: CHANGE_KINDS.BOUNDS_CHANGED,
    actor: by,
    target: 'bounds',
    before: current,
    after: next,
    reason: 'the owner changed what may happen automatically',
  });
  return next;
}

/**
 * Is this change permitted?
 *
 * Returns the refusal with its reason. The caller is expected to stop; this
 * does not perform anything itself, so that the check and the act are separate
 * and the check can be tested without side effects.
 */
export async function mayChange({ kind, actor, weightShift = 0, now = Date.now() }) {
  if (!ACTORS.includes(actor)) {
    return { ok: false, reason: `"${actor}" is not a recognised actor; a change must be attributable to the owner or to automation` };
  }
  const bounds = await getBounds();

  // the owner may do anything the product permits; these bounds exist to limit
  // what happens WITHOUT them
  if (actor === 'owner') return { ok: true, bounds };

  // R9.8 found this hole: the bounds are what limits automation, so automation
  // changing them is automation granting itself permission. Today
  // `allowAutomaticChanges` is false and nothing reaches this line — but the
  // whole point of the bounds being settings is that one day it is true, and on
  // that day this check is the only thing standing between "optimise the
  // message" and "optimise the limits on optimising the message".
  if (kind === CHANGE_KINDS.BOUNDS_CHANGED) {
    return {
      ok: false,
      reason: 'the limits on automatic changes may only be changed by the owner. Automation that can widen its own bounds has no bounds.',
      bounds,
    };
  }

  if (!bounds.allowAutomaticChanges) {
    return {
      ok: false,
      reason: 'automatic changes to a running experiment are switched off. Nothing in this system alters a live experiment by itself unless the owner turns that on.',
      bounds,
    };
  }
  if (bounds.requireOwnerForStateChange && kind === CHANGE_KINDS.STATE_CHANGED) {
    return { ok: false, reason: 'starting and stopping an experiment is the owner\'s decision', bounds };
  }
  if (bounds.requireOwnerForReassignment && kind === CHANGE_KINDS.CONTACT_REASSIGNED) {
    return { ok: false, reason: 'moving someone between arms is the owner\'s decision', bounds };
  }
  if (weightShift > bounds.maxWeightShiftPerChange) {
    return {
      ok: false,
      reason: `this would shift ${Math.round(weightShift * 100)}% of traffic in one change; the limit is ${Math.round(bounds.maxWeightShiftPerChange * 100)}%`,
      bounds,
    };
  }

  const recent = (await listChanges({ limit: 200 })).filter(
    (c) => c.actor === 'automatic' && now - c.at < 7 * 24 * 3600e3,
  );
  if (recent.length >= bounds.maxChangesPerWeek) {
    return {
      ok: false,
      reason: `${recent.length} automatic changes already this week; the limit is ${bounds.maxChangesPerWeek}. Changing a live experiment repeatedly makes its results unreadable.`,
      bounds,
    };
  }
  return { ok: true, bounds };
}

/**
 * Record a change. `before` is required for anything reversible — a log that
 * says what happened but not what it replaced cannot undo anything.
 */
export async function recordChange({ kind, actor, target, before = null, after = null, reason = '', at = Date.now() }) {
  if (!Object.values(CHANGE_KINDS).includes(kind)) return { ok: false, error: `unknown change kind "${kind}"` };
  if (!ACTORS.includes(actor)) return { ok: false, error: `unknown actor "${actor}"` };

  // a timestamp is not unique; two changes in the same millisecond must not
  // collapse into one (this build has hit that four times elsewhere)
  const id = `${at}-${Math.random().toString(36).slice(2, 8)}`;
  const entry = {
    id,
    kind,
    actor,
    target: target || null,
    before,
    after,
    reason: String(reason).slice(0, 300),
    at,
    reverted: false,
    revertedAt: null,
  };
  const log = await readLog();
  log.push(entry);
  // keep the log bounded without losing the ability to undo recent work
  await store.set(LOG_KEY, JSON.stringify(log.slice(-500)));
  return { ok: true, entry };
}

async function readLog() {
  let raw;
  try {
    raw = await store.get(LOG_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const l = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}

export async function listChanges({ limit = 50, kind = null, target = null } = {}) {
  const log = await readLog();
  return log
    .filter((c) => (!kind || c.kind === kind) && (!target || c.target === target))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export const isReversible = (entry) => !!entry && entry.before !== null && entry.before !== undefined && !entry.reverted;

/**
 * Undo one change.
 *
 * `apply` is injected: this module knows what the value WAS, and the caller
 * knows how to put it back. That separation is deliberate — a log module that
 * also wrote to experiments, settings and assignments would be a second place
 * where any of them could be changed without going through their own guards.
 */
export async function revertChange(changeId, apply) {
  const log = await readLog();
  const entry = log.find((c) => c.id === changeId);
  if (!entry) return { ok: false, error: `no change "${changeId}"` };
  if (entry.reverted) return { ok: false, error: 'that change has already been reverted' };
  if (!isReversible(entry)) {
    return { ok: false, error: 'this change recorded no previous value, so there is nothing to put back' };
  }
  if (typeof apply !== 'function') return { ok: false, error: 'reverting needs something that can apply the previous value' };

  // R9.8 — a revert is a write, so it gets the same check as any other. Without
  // this the ledger would be a second way into suppression records, pricing and
  // budgets, bypassing each of those namespaces' own guards: log a change
  // against one, then "undo" it.
  const { mayRevert } = await import('./prohibition.js');
  const permitted = mayRevert(entry);
  if (!permitted.ok) return { ok: false, error: permitted.reason, code: 'prohibited' };

  const applied = await apply(entry);
  if (!applied?.ok) return { ok: false, error: applied?.error || 'the previous value could not be applied' };

  entry.reverted = true;
  entry.revertedAt = Date.now();
  await store.set(LOG_KEY, JSON.stringify(log.slice(-500)));

  // the undo is itself a change, so it appears in the ledger too
  await recordChange({
    kind: entry.kind,
    actor: 'owner',
    target: entry.target,
    before: entry.after,
    after: entry.before,
    reason: `reverted change ${changeId}`,
  });
  return { ok: true, entry, restored: entry.before };
}
