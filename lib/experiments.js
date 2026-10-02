// R9.1 — variants, assignments and outcomes, stored so they can be reported
// honestly later.
//
// The thing this has to get right is not the splitting. Splitting is easy. It
// is that at this volume — a target of roughly 25 prospects a week — an
// experiment will take months to say anything, and every A/B tool in existence
// is built to show you a winner before then. So the storage is shaped around
// three facts that make honest reporting possible:
//
//  1. ASSIGNMENT IS RECORDED, NOT RECOMPUTED.
//     If variants are added, removed or reweighted, everyone already assigned
//     keeps what they were sent. A recomputed assignment would silently move
//     past outcomes between arms — the same class of error as attributing a
//     reply to whichever campaign a key scan found first (R6.7), and just as
//     invisible once it has happened.
//
//  2. ASSIGNMENT IS STICKY AND DETERMINISTIC.
//     The same contact gets the same arm every time, so a follow-up never
//     contradicts the intro. The bucket comes from a hash of the contact and
//     the experiment, never from a random number: two processes, or one
//     process restarted, must agree.
//
//  3. AN OUTCOME WITHOUT AN ASSIGNMENT IS UNATTRIBUTABLE, NOT ZERO.
//     It is recorded and counted separately. Dropping it would quietly shrink
//     the denominator; guessing an arm for it would corrupt the comparison.
//
// What this file deliberately does NOT do: pick a winner, compute a
// significance figure, or change anything. Reporting with stated uncertainty
// is R9.5, a holdout is R9.6, and nothing here may alter consent, suppression,
// prices, sender identity or budgets (R9.8).

import { store } from './store.js';

export const EXPERIMENT_STATE = Object.freeze({
  DRAFT: 'draft',
  RUNNING: 'running',
  STOPPED: 'stopped',
});

/** The one thing an experiment is allowed to vary. More than one and nothing
 *  can be attributed to anything. */
export const VARIABLES = Object.freeze([
  { id: 'subject', label: 'Subject line' },
  { id: 'opening', label: 'Opening sentence' },
  { id: 'call-to-action', label: 'What we ask them to do' },
  { id: 'send-day', label: 'Which day it goes' },
]);

/**
 * Things an experiment may never vary. These are not settings someone forgot
 * to expose — varying any of them turns an experiment into an experiment on
 * whether rules apply to some people, which is R9.8's prohibition and is
 * enforced here at the point an experiment is created.
 */
export const FORBIDDEN_VARIABLES = Object.freeze([
  { id: 'consent', why: 'Consent rules are not a variable. Testing a weaker one tests whether the law applies to half your list.' },
  { id: 'suppression', why: 'Suppression is a standing instruction from a person, not a parameter.' },
  { id: 'price', why: 'Quoting different prices to comparable prospects is a commercial decision, not a message test.' },
  { id: 'sender-identity', why: 'CAN-SPAM requires an accurate identity. Varying it is varying whether the message is lawful.' },
  { id: 'budget', why: 'A budget limit is a control the owner set, not a thing to optimise around.' },
  { id: 'unsubscribe', why: 'The opt-out mechanism must work identically for everyone.' },
]);

const EXP = (id) => `experiment:${id}`;
const INDEX = 'experiments:all';
const ASSIGN = (expId, contactId) => `experiment:assign:${expId}:${contactId}`;
const ASSIGN_INDEX = (expId) => `experiment:assigned:${expId}`;
const OUTCOME = (expId, id) => `experiment:outcome:${expId}:${id}`;
const OUTCOME_INDEX = (expId) => `experiment:outcomes:${expId}`;

// ---------------------------------------------------------------------------
// Definition
// ---------------------------------------------------------------------------

/**
 * Create an experiment.
 *
 * Refuses more than one variable, a forbidden variable, fewer than two arms,
 * or arms that do not add up — each of which produces a result nobody could
 * act on, which is worse than no result because it looks like one.
 */
export async function createExperiment({ id, variable, hypothesis = '', variants = [], createdAt = Date.now() }) {
  if (!id) return { ok: false, error: 'an experiment needs an id' };

  const forbidden = FORBIDDEN_VARIABLES.find((f) => f.id === variable);
  if (forbidden) return { ok: false, error: `"${variable}" may not be varied. ${forbidden.why}` };
  if (!VARIABLES.some((v) => v.id === variable)) {
    return { ok: false, error: `"${variable}" is not a testable variable; choose one of ${VARIABLES.map((v) => v.id).join(', ')}` };
  }
  // R9.6 — the baseline is added BEFORE the arity check, because one variant
  // against the holdout is a perfectly good experiment: "is this new wording
  // better than what we send now?" is the question most worth asking. An
  // earlier ordering rejected it, which would have pushed anyone wanting that
  // comparison into inventing a second variant they did not want.
  const { withHoldout } = await import('./holdout.js');
  const h = withHoldout(Array.isArray(variants) ? variants : []);
  if (!h.ok) return { ok: false, error: h.error };
  variants = h.variants;

  const realVariants = variants.filter((v) => v.id !== 'holdout');
  if (realVariants.length < 1) {
    return { ok: false, error: 'an experiment needs at least one variant to compare against the holdout' };
  }
  if (new Set(variants.map((v) => v.id)).size !== variants.length) {
    return { ok: false, error: 'two arms share an id, so their results could not be told apart' };
  }
  const weights = variants.map((v) => (v.weight == null ? 1 : Number(v.weight)));
  if (weights.some((w) => !Number.isFinite(w) || w <= 0)) {
    return { ok: false, error: 'every arm needs a positive weight' };
  }

  const existing = await getExperiment(id);
  if (existing) return { ok: false, error: `an experiment called "${id}" already exists` };

  const rec = {
    id,
    variable,
    hypothesis: String(hypothesis).slice(0, 300),
    variants: variants.map((v) => ({
      id: v.id,
      label: v.label || v.id,
      weight: v.weight == null ? 1 : Number(v.weight),
      content: v.content ?? null,
      holdout: v.id === 'holdout' || undefined,
    })),
    state: EXPERIMENT_STATE.DRAFT,
    createdAt,
    startedAt: null,
    stoppedAt: null,
  };
  await store.set(EXP(id), JSON.stringify(rec));
  await store.sadd(INDEX, id);
  return { ok: true, experiment: rec };
}

export async function getExperiment(id) {
  if (!id) return null;
  let raw;
  try {
    raw = await store.get(EXP(id));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function listExperiments() {
  const ids = await store.smembers(INDEX).catch(() => []);
  const out = [];
  for (const id of ids) {
    const e = await getExperiment(id);
    if (e) out.push(e);
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

/**
 * R9.6 — the only permitted way to change an experiment's arms.
 *
 * Direct edits to the stored record bypass this, which is why the holdout is
 * also re-checked at report time: the rule has to survive a route nobody
 * remembered to guard.
 */
export async function updateVariants(id, proposed, { by = 'owner' } = {}) {
  const e = await getExperiment(id);
  if (!e) return { ok: false, error: `no experiment "${id}"` };
  const { checkVariantChange, withHoldout } = await import('./holdout.js');
  // Checked against the PROPOSAL, before normalising. `withHoldout` adds a
  // missing holdout, which is right at creation and wrong here: it would mean
  // an edit that drops the baseline is silently repaired and reported as
  // applied, so the caller believes their change took effect when it did not.
  const guard = checkVariantChange(e.variants, Array.isArray(proposed) ? proposed : []);
  if (!guard.ok) return { ok: false, error: guard.error };
  const normalised = withHoldout(proposed);
  if (!normalised.ok) return { ok: false, error: normalised.error };
  const { mayChange, recordChange, CHANGE_KINDS } = await import('./optimisation-log.js');
  const permitted = await mayChange({ kind: CHANGE_KINDS.VARIANTS_CHANGED, actor: by });
  if (!permitted.ok) return { ok: false, error: permitted.reason, code: 'not-permitted' };

  const next = { ...e, variants: normalised.variants };
  await store.set(EXP(id), JSON.stringify(next));
  await recordChange({
    kind: CHANGE_KINDS.VARIANTS_CHANGED,
    actor: by,
    target: id,
    before: { variants: e.variants },
    after: { variants: next.variants },
    reason: 'the arms of this experiment were edited',
  });
  return { ok: true, experiment: next };
}

export async function setExperimentState(id, state, { at = Date.now(), by = 'owner' } = {}) {
  const e = await getExperiment(id);
  if (!e) return { ok: false, error: `no experiment "${id}"` };
  if (!Object.values(EXPERIMENT_STATE).includes(state)) return { ok: false, error: `unknown state "${state}"` };
  const { mayChange, recordChange, CHANGE_KINDS } = await import('./optimisation-log.js');
  const permitted = await mayChange({ kind: CHANGE_KINDS.STATE_CHANGED, actor: by });
  if (!permitted.ok) return { ok: false, error: permitted.reason, code: 'not-permitted' };

  const next = { ...e, state };
  if (state === EXPERIMENT_STATE.RUNNING && !e.startedAt) next.startedAt = at;
  if (state === EXPERIMENT_STATE.STOPPED) next.stoppedAt = at;
  await store.set(EXP(id), JSON.stringify(next));
  await recordChange({
    kind: CHANGE_KINDS.STATE_CHANGED,
    actor: by,
    target: id,
    before: { state: e.state },
    after: { state },
    reason: `experiment moved to ${state}`,
  });
  return { ok: true, experiment: next };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/** A stable 32-bit hash. Not for security — for agreeing with itself. */
export function hashToBucket(key, buckets = 1000) {
  const s = String(key);
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % buckets;
}

/**
 * Which arm this contact falls in, by weight. Pure: no store, no clock, no
 * randomness, so the same inputs always give the same arm in any process.
 */
export function pickVariant(variants, key) {
  if (!Array.isArray(variants) || !variants.length) return null;
  const total = variants.reduce((t, v) => t + (v.weight || 1), 0);
  const bucket = hashToBucket(key, 1000);
  const point = (bucket / 1000) * total;
  let acc = 0;
  for (const v of variants) {
    acc += v.weight || 1;
    if (point < acc) return v;
  }
  return variants[variants.length - 1];
}

/**
 * Assign a contact, or return the assignment they already have.
 *
 * The existing assignment wins ALWAYS — including when the arm it names has
 * since been removed from the experiment. That is deliberate: they were sent
 * that message, so their outcome belongs to that arm, and moving them would
 * rewrite history to match the current configuration.
 */
export async function assign({ experimentId, contactId, at = Date.now() }) {
  if (!experimentId || !contactId) return { ok: false, error: 'an assignment needs an experiment and a contact' };

  const existing = await getAssignment(experimentId, contactId);
  if (existing) return { ok: true, assignment: existing, reused: true };

  const exp = await getExperiment(experimentId);
  if (!exp) return { ok: false, error: `no experiment "${experimentId}"` };
  if (exp.state !== EXPERIMENT_STATE.RUNNING) {
    return { ok: false, error: `experiment "${experimentId}" is ${exp.state}, so nobody new is being assigned` };
  }

  const variant = pickVariant(exp.variants, `${experimentId}:${contactId}`);
  if (!variant) return { ok: false, error: 'the experiment has no arms to assign to' };

  const rec = {
    experimentId,
    contactId,
    variantId: variant.id,
    at,
    // recorded so a later reader can tell a real assignment from a repair
    basis: 'hash of experiment and contact',
  };
  await store.set(ASSIGN(experimentId, contactId), JSON.stringify(rec));
  await store.sadd(ASSIGN_INDEX(experimentId), contactId);
  return { ok: true, assignment: rec, reused: false };
}

/**
 * R9.6 / R9.7 — move one contact to another arm.
 *
 * This exists because `mayReassign` had no caller: the holdout rule was being
 * kept by the ABSENCE of a reassignment path rather than by enforcement, which
 * is not the same thing and stops being true the moment anyone adds one. So
 * the path exists, it is owner-only, it is logged with the previous arm, and
 * it refuses to move anybody out of the holdout.
 */
export async function reassign({ experimentId, contactId, toVariantId, by = 'owner', reason = '' }) {
  const current = await getAssignment(experimentId, contactId);
  if (!current) return { ok: false, error: 'this contact has no assignment to change' };

  const exp = await getExperiment(experimentId);
  if (!exp) return { ok: false, error: `no experiment "${experimentId}"` };
  if (!exp.variants.some((v) => v.id === toVariantId)) {
    return { ok: false, error: `"${toVariantId}" is not an arm of this experiment` };
  }

  // R9.6 — nobody is moved out of the holdout, by anyone, for any reason
  const { mayReassign } = await import('./holdout.js');
  const allowed = mayReassign({ currentVariantId: current.variantId, toVariantId });
  if (!allowed.ok) return { ok: false, error: allowed.reason, code: 'holdout-locked' };

  // R9.7 — bounded, and attributable
  const { mayChange, recordChange, CHANGE_KINDS } = await import('./optimisation-log.js');
  const permitted = await mayChange({ kind: CHANGE_KINDS.CONTACT_REASSIGNED, actor: by });
  if (!permitted.ok) return { ok: false, error: permitted.reason, code: 'not-permitted' };

  const next = { ...current, variantId: toVariantId, reassignedAt: Date.now(), reassignedBy: by, basis: 'reassigned by a person' };
  await store.set(ASSIGN(experimentId, contactId), JSON.stringify(next));

  // R9.7 — the BEFORE value is what makes this reversible
  await recordChange({
    kind: CHANGE_KINDS.CONTACT_REASSIGNED,
    actor: by,
    target: `${experimentId}:${contactId}`,
    before: { variantId: current.variantId },
    after: { variantId: toVariantId },
    reason,
  });
  return { ok: true, assignment: next, from: current.variantId };
}

/**
 * R9.7 — put a logged change back.
 *
 * The log module holds the previous value and this holds the knowledge of how
 * to apply it. Keeping them apart means the ledger cannot become a second way
 * to write to experiments without passing their own guards.
 */
export async function revertExperimentChange(changeId) {
  const { revertChange } = await import('./optimisation-log.js');
  return revertChange(changeId, async (entry) => {
    if (entry.kind === 'contact-reassigned') {
      const [expId, contactId] = String(entry.target || '').split(':');
      const current = await getAssignment(expId, contactId);
      if (!current) return { ok: false, error: 'the assignment no longer exists' };
      // Restoring INTO the holdout is always allowed; restoring OUT of it is
      // the one thing R9.6 forbids, and an undo is not an exemption.
      const { mayReassign } = await import('./holdout.js');
      const allowed = mayReassign({ currentVariantId: current.variantId, toVariantId: entry.before.variantId });
      if (!allowed.ok) return { ok: false, error: allowed.reason };
      await store.set(ASSIGN(expId, contactId), JSON.stringify({ ...current, variantId: entry.before.variantId, revertedAt: Date.now() }));
      return { ok: true };
    }
    if (entry.kind === 'variants-changed' || entry.kind === 'experiment-state-changed') {
      const e = await getExperiment(entry.target);
      if (!e) return { ok: false, error: 'the experiment no longer exists' };
      const restored = { ...e, ...entry.before };
      // a revert may not reintroduce an experiment without a baseline
      if (entry.before.variants) {
        const { checkVariantChange } = await import('./holdout.js');
        const guard = checkVariantChange(e.variants, entry.before.variants);
        if (!guard.ok) return { ok: false, error: guard.error };
      }
      await store.set(EXP(entry.target), JSON.stringify(restored));
      return { ok: true };
    }
    return { ok: false, error: `nothing here knows how to put back a "${entry.kind}"` };
  });
}

export async function getAssignment(experimentId, contactId) {
  let raw;
  try {
    raw = await store.get(ASSIGN(experimentId, contactId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function listAssignments(experimentId) {
  const ids = await store.smembers(ASSIGN_INDEX(experimentId)).catch(() => []);
  const out = [];
  for (const cid of ids) {
    const a = await getAssignment(experimentId, cid);
    if (a) out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * Record something that happened to a contact in an experiment.
 *
 * An outcome for a contact with no assignment is kept and marked
 * `unattributed`. Dropping it would shrink the denominator silently; guessing
 * an arm would corrupt the comparison. Neither is acceptable, so it is counted
 * in its own column and reported.
 */
export async function recordOutcome({ experimentId, contactId, kind, at = Date.now(), evidence = null }) {
  if (!experimentId || !kind) return { ok: false, error: 'an outcome needs an experiment and a kind' };

  const assignment = contactId ? await getAssignment(experimentId, contactId) : null;
  // a timestamp is not unique; two outcomes in the same millisecond must not
  // overwrite each other (the same bug this build has hit three times)
  const id = `${contactId || 'unknown'}-${at}-${Math.random().toString(36).slice(2, 8)}`;
  const rec = {
    id,
    experimentId,
    contactId: contactId || null,
    variantId: assignment?.variantId || null,
    unattributed: !assignment,
    kind,
    at,
    evidence: evidence || null,
  };
  await store.set(OUTCOME(experimentId, id), JSON.stringify(rec));
  await store.sadd(OUTCOME_INDEX(experimentId), id);
  return { ok: true, outcome: rec };
}

export async function listOutcomes(experimentId) {
  const ids = await store.smembers(OUTCOME_INDEX(experimentId)).catch(() => []);
  const out = [];
  for (const id of ids) {
    let raw;
    try {
      raw = await store.get(OUTCOME(experimentId, id));
    } catch {
      continue;
    }
    if (!raw) continue;
    try {
      out.push(typeof raw === 'string' ? JSON.parse(raw) : raw);
    } catch { /* skip */ }
  }
  return out.sort((a, b) => (a.at || 0) - (b.at || 0));
}

/**
 * Counts per arm. Counts only — no rate is computed and no winner is named.
 *
 * This is where most tools start lying: with 6 sends and 1 reply they will
 * cheerfully report "16.7% — variant B is winning". The denominators here are
 * reported next to the numerators so that anyone reading can see there is not
 * enough to say anything, and R9.5 will add the explicit statement.
 */
export async function tally(experimentId) {
  const exp = await getExperiment(experimentId);
  if (!exp) return { ok: false, error: `no experiment "${experimentId}"` };

  const assignments = await listAssignments(experimentId);
  const outcomes = await listOutcomes(experimentId);

  const arms = {};
  for (const v of exp.variants) arms[v.id] = { variantId: v.id, label: v.label, assigned: 0, outcomes: {} };
  // an arm that has been removed from the experiment still has people in it
  for (const a of assignments) {
    if (!arms[a.variantId]) arms[a.variantId] = { variantId: a.variantId, label: `${a.variantId} (no longer configured)`, assigned: 0, outcomes: {}, retired: true };
    arms[a.variantId].assigned++;
  }
  let unattributed = 0;
  for (const o of outcomes) {
    if (o.unattributed || !arms[o.variantId]) { unattributed++; continue; }
    arms[o.variantId].outcomes[o.kind] = (arms[o.variantId].outcomes[o.kind] || 0) + 1;
  }

  // R9.6 — re-checked here rather than trusted, because a direct write to the
  // stored record would bypass updateVariants entirely.
  const { isHoldout } = await import('./holdout.js');
  const armList = Object.values(arms).map((a) => (isHoldout(a) ? { ...a, holdout: true, baseline: true } : a));
  const hasBaseline = armList.some((a) => a.holdout);

  return {
    ok: true,
    experimentId,
    variable: exp.variable,
    state: exp.state,
    hasBaseline,
    baselineWarning: hasBaseline
      ? null
      : 'This experiment has no holdout, so nothing here can say whether any variant beats the message that was already being sent.',
    arms: armList,
    totalAssigned: assignments.length,
    totalOutcomes: outcomes.length,
    // reported, never hidden: these are outcomes we could not place
    unattributedOutcomes: unattributed,
    // stated here so no caller has to remember it
    note: 'Counts only. No rate, no winner, and no significance is implied by this object.',
  };
}
