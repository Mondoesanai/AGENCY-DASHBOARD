// R9.7 — changes are bounded by owner-approved settings, logged, and reversible.
//
// The failure this prevents is undramatic: opening the dashboard in six weeks,
// finding the message has drifted into something nobody would have approved,
// and having no way to answer "when did this change, who changed it, what was
// it before?" — let alone put it back.
//
// This cycle also closes a gap the reviewer was right about. `mayReassign` was
// written, unit-tested and had NO CALLER: the holdout rule was being kept by
// the absence of any reassignment path rather than by enforcement. Those are
// not the same thing, and the difference disappears the moment someone adds
// one. R9.7's reassignment path is that caller, and section L5 drives it.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  CHANGE_KINDS, ACTORS, DEFAULT_BOUNDS,
  getBounds, setBounds, mayChange, recordChange, listChanges, isReversible, revertChange,
} from '../lib/optimisation-log.js';
import {
  createExperiment, setExperimentState, updateVariants, assign, getAssignment,
  reassign, revertExperimentChange, getExperiment,
} from '../lib/experiments.js';
import { HOLDOUT_ID } from '../lib/holdout.js';

const EID = 'exp-log';
const reset = async () => {
  await store.set(`experiment:${EID}`, '').catch(() => {});
  await store.set('optimisation:log', '').catch(() => {});
  await store.set('optimisation:bounds', '').catch(() => {});
};

// ---------------------------------------------------------------------------
section('L1  nothing changes a live experiment by itself');
await reset();
let b = await getBounds();
check('automatic changes are off by default', b.allowAutomaticChanges === false);
check('starting and stopping stays a person\'s decision', b.requireOwnerForStateChange === true);
check('and so does moving someone between arms', b.requireOwnerForReassignment === true);
check('there is a cap on how much one change may shift', b.maxWeightShiftPerChange > 0 && b.maxWeightShiftPerChange <= 1);
check('and on how often changes may happen', b.maxChangesPerWeek > 0);

let m = await mayChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'automatic' });
check('an automatic change is refused', m.ok === false, JSON.stringify(m));
check('and says nothing alters a live experiment by itself', /by itself unless the owner turns that on/.test(m.reason), m.reason);
check('the owner may act', (await mayChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'owner' })).ok === true);
check('an unrecognised actor is refused', (await mayChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'the system' })).ok === false);
check('because a change must be attributable', /attributable to the owner or to automation/.test((await mayChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'x' })).reason));

// with automation enabled, the bounds start doing work
await setBounds({ allowAutomaticChanges: true, requireOwnerForStateChange: true, maxWeightShiftPerChange: 0.2, maxChangesPerWeek: 2 });
check('a small shift is allowed', (await mayChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'automatic', weightShift: 0.1 })).ok === true);
m = await mayChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'automatic', weightShift: 0.5 });
check('a large shift is refused', m.ok === false, JSON.stringify(m));
check('naming both the amount and the limit', /50% of traffic in one change; the limit is 20%/.test(m.reason), m.reason);
check('state changes still need the owner even then', (await mayChange({ kind: CHANGE_KINDS.STATE_CHANGED, actor: 'automatic' })).ok === false);
check('and so do reassignments', (await mayChange({ kind: CHANGE_KINDS.CONTACT_REASSIGNED, actor: 'automatic' })).ok === false);

// the weekly cap
for (let i = 0; i < 2; i++) await recordChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'automatic', target: 'x', before: { w: 1 }, after: { w: 2 } });
m = await mayChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'automatic', weightShift: 0.05 });
check('the weekly cap refuses the third change', m.ok === false, JSON.stringify(m));
check('and says why repeated changes are the problem', /makes its results unreadable/.test(m.reason), m.reason);
check('the owner is not capped', (await mayChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'owner' })).ok === true);
await setBounds({ allowAutomaticChanges: false });

// unreadable bounds mean the strictest reading
{
  const realGet = store.get;
  store.get = async (k) => { if (k === 'optimisation:bounds') throw new Error('store down'); return realGet.call(store, k); };
  const strict = await getBounds();
  check('unreadable bounds fall back to the strictest', strict.allowAutomaticChanges === false && strict.unreadable === true, JSON.stringify(strict));
  store.get = realGet;
}

// ---------------------------------------------------------------------------
section('L2  the log records what it replaced, not just that it changed');
await store.set('optimisation:log', '').catch(() => {});
let r = await recordChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'owner', target: 't1', before: { w: 1 }, after: { w: 3 }, reason: 'rebalanced' });
check('a change is recorded', r.ok === true, JSON.stringify(r));
check('with the previous value', JSON.stringify(r.entry.before) === '{"w":1}');
check('and the new one', JSON.stringify(r.entry.after) === '{"w":3}');
check('and who did it', r.entry.actor === 'owner');
check('and why', r.entry.reason === 'rebalanced');
check('it is reversible because it kept the before', isReversible(r.entry) === true);
// the distinction that makes the log worth keeping
const noBefore = await recordChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'owner', target: 't2', after: { w: 9 } });
check('a change with no previous value is NOT reversible', isReversible(noBefore.entry) === false, JSON.stringify(noBefore.entry));
check('an unknown kind is refused', (await recordChange({ kind: 'vibes', actor: 'owner' })).ok === false);
check('an unknown actor is refused', (await recordChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'ghost' })).ok === false);

// same-millisecond entries must not collapse
{
  const at = 1770000000000;
  await recordChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'owner', target: 'same', before: { a: 1 }, after: { a: 2 }, at });
  await recordChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'owner', target: 'same', before: { a: 2 }, after: { a: 3 }, at });
  const both = (await listChanges({ limit: 200, target: 'same' }));
  check('two changes in the same millisecond are both kept', both.length === 2, String(both.length));
  // The consequence that actually bites is not a missing array entry — both
  // are pushed either way. It is that revertChange() finds the FIRST match by
  // id, so with colliding ids the second change can never be undone on its
  // own. An earlier version of this check counted entries and missed that.
  check('and they have distinct ids', both[0].id !== both[1].id, `${both[0].id} vs ${both[1].id}`);
  const undoA = await revertChange(both[0].id, async () => ({ ok: true }));
  const undoB = await revertChange(both[1].id, async () => ({ ok: true }));
  check('each can be reverted independently', undoA.ok === true && undoB.ok === true,
    JSON.stringify({ a: undoA.ok, aErr: undoA.error, b: undoB.ok, bErr: undoB.error }));
}
check('the log can be filtered by kind', (await listChanges({ kind: CHANGE_KINDS.WEIGHTS_CHANGED })).every((c) => c.kind === CHANGE_KINDS.WEIGHTS_CHANGED));
check('and is newest first', (await listChanges({ limit: 5 })).every((c, i, a) => i === 0 || a[i - 1].at >= c.at));

// ---------------------------------------------------------------------------
section('L3  every mutation on an experiment is logged with its before');
await reset();
await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'town', content: 'A website question about Plano' }] });
await setExperimentState(EID, 'running');
let log = await listChanges({ limit: 10 });
check('the state change is logged', log.some((c) => c.kind === CHANGE_KINDS.STATE_CHANGED), log.map((c) => c.kind).join(','));
const stateEntry = log.find((c) => c.kind === CHANGE_KINDS.STATE_CHANGED);
check('with the state it was in before', stateEntry?.before?.state === 'draft', JSON.stringify(stateEntry?.before));
check('and the one it moved to', stateEntry?.after?.state === 'running');

await updateVariants(EID, [{ id: HOLDOUT_ID }, { id: 'town', content: 'changed' }, { id: 'third', content: 'new' }]);
log = await listChanges({ limit: 10 });
const varEntry = log.find((c) => c.kind === CHANGE_KINDS.VARIANTS_CHANGED);
check('a variant edit is logged', !!varEntry);
check('with the complete previous arm list', Array.isArray(varEntry?.before?.variants) && varEntry.before.variants.length === 2, JSON.stringify(varEntry?.before));
check('so it can be put back exactly', (varEntry?.before?.variants || []).map((v) => v.id).join(',') === 'holdout,town');

// ---------------------------------------------------------------------------
section('L4  reverting puts the previous value back');
let rev = await revertExperimentChange(varEntry?.id);
check('the variant edit is reverted', rev.ok === true, JSON.stringify(rev).slice(0, 140));
const after = await getExperiment(EID);
check('the arms are as they were', after.variants.map((v) => v.id).join(',') === 'holdout,town', after.variants.map((v) => v.id).join(','));
check('reverting twice is refused', (await revertExperimentChange(varEntry?.id)).ok === false);
check('and says it has already been undone', /already been reverted/.test((await revertExperimentChange(varEntry?.id)).error || ''));
check('reverting an unknown change is refused', (await revertExperimentChange('nope')).ok === false);
// a change with no before cannot be undone
const noB = await recordChange({ kind: CHANGE_KINDS.WEIGHTS_CHANGED, actor: 'owner', target: EID, after: { x: 1 } });
check('a change with no previous value cannot be reverted', (await revertChange(noB.entry.id, async () => ({ ok: true }))).ok === false);
check('saying there is nothing to put back', /nothing to put back/.test((await revertChange(noB.entry.id, async () => ({ ok: true }))).error));
// the undo is itself in the ledger
check('the revert appears in the log too', (await listChanges({ limit: 5 })).some((c) => /reverted change/.test(c.reason || '')));

// ---------------------------------------------------------------------------
section('L5  the gap the reviewer found: mayReassign now has a caller');
// Before this cycle the holdout rule was kept by there being NO reassignment
// path. That is not enforcement, and it stops being true the moment someone
// adds one. So the path exists, and it refuses.
await reset();
await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'town', content: 'x' }] });
await setExperimentState(EID, 'running');

let inHoldout = null;
let inVariant = null;
for (let i = 0; i < 60 && (!inHoldout || !inVariant); i++) {
  await assign({ experimentId: EID, contactId: `ra-${i}` });
  const a = await getAssignment(EID, `ra-${i}`);
  if (a.variantId === HOLDOUT_ID && !inHoldout) inHoldout = `ra-${i}`;
  if (a.variantId === 'town' && !inVariant) inVariant = `ra-${i}`;
}
check('both arms have someone in them', !!inHoldout && !!inVariant, `${inHoldout} / ${inVariant}`);

// THE check this section exists for
let out = await reassign({ experimentId: EID, contactId: inHoldout, toVariantId: 'town', by: 'owner' });
check('moving someone OUT of the holdout is refused', out.ok === false, JSON.stringify(out));
check('with the holdout reason', out.code === 'holdout-locked', out.code);
check('explaining the comparison would break twice', /wrong twice in the same direction/.test(out.error), out.error);
check('and the contact is still in the holdout', (await getAssignment(EID, inHoldout)).variantId === HOLDOUT_ID);

// moving INTO the holdout is allowed, and logged
out = await reassign({ experimentId: EID, contactId: inVariant, toVariantId: HOLDOUT_ID, by: 'owner', reason: 'owner asked' });
check('moving INTO the holdout is allowed', out.ok === true, JSON.stringify(out));
check('and records where they came from', out.from === 'town');
check('the assignment really changed', (await getAssignment(EID, inVariant)).variantId === HOLDOUT_ID);
const reEntry = (await listChanges({ kind: CHANGE_KINDS.CONTACT_REASSIGNED, limit: 5 }))[0];
check('it is in the ledger', !!reEntry);
check('with the arm they were in', reEntry?.before?.variantId === 'town', JSON.stringify(reEntry?.before));

// and an undo may not become a way around the holdout rule
const undo = await revertExperimentChange(reEntry?.id);
check('undoing a move INTO the holdout is refused', undo.ok === false, JSON.stringify(undo));
check('because an undo is not an exemption', /holdout/i.test(undo.error || ''), undo.error);

check('reassigning to an arm that does not exist is refused', (await reassign({ experimentId: EID, contactId: inVariant, toVariantId: 'nope' })).ok === false);
check('reassigning someone with no assignment is refused', (await reassign({ experimentId: EID, contactId: 'never-seen', toVariantId: 'town' })).ok === false);
// automation may not do it even when automation is allowed generally
await setBounds({ allowAutomaticChanges: true, requireOwnerForReassignment: true });
out = await reassign({ experimentId: EID, contactId: inHoldout, toVariantId: HOLDOUT_ID, by: 'automatic' });
check('automation may not reassign anyone', out.ok === false, JSON.stringify(out));
await setBounds({ allowAutomaticChanges: false });

await reset();
done();
