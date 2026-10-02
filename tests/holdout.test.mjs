// R9.6 — a holdout is always retained, never reassigned mid-experiment, and
// reported alongside every variant.
//
// Comparing variants to each other answers "which of these is better?" It
// cannot answer "is any of these better than what we were already sending?" —
// and those come apart in the case that matters. If every new wording is worse
// than the current message, an A/B test still names a winner: the least-bad of
// a bad set, promoted with a straight face.
//
// The rule that actually bites is not the one at design time. It is three
// weeks later, when someone wants more traffic on the variant that looks
// promising and the baseline is in the way — which is exactly when it is worth
// most. So removal is refused, and the refusal says why.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  HOLDOUT_ID, HOLDOUT_RULES, holdoutArm, isHoldout,
  withHoldout, checkVariantChange, mayReassign, withBaselineFirst, againstBaseline,
} from '../lib/holdout.js';
import { createExperiment, updateVariants, setExperimentState, assign, getAssignment, tally } from '../lib/experiments.js';
import { primaryBreakdown } from '../lib/outcomes.js';
import { sampleSizeStatement, compareArms } from '../lib/significance.js';

const EID = 'exp-holdout';
const reset = async () => { await store.set(`experiment:${EID}`, '').catch(() => {}); };

// ---------------------------------------------------------------------------
section('H1  the rules are stated, and the arm has a fixed shape');
check('the rules are recorded', HOLDOUT_RULES.length >= 5, String(HOLDOUT_RULES.length));
check('including that it is never removed', HOLDOUT_RULES.some((r) => /[Nn]ever removed/.test(r)));
check('and never reassigned out of', HOLDOUT_RULES.some((r) => /reassigned/.test(r)));
const h = holdoutArm();
check('the holdout carries no content', h.content === null);
check('and says in its label what it is', /current message, unchanged/.test(h.label));
check('it is recognisable by id', isHoldout({ id: HOLDOUT_ID }) === true);
check('and by the flag on a tallied arm', isHoldout({ variantId: HOLDOUT_ID }) === true);
check('an ordinary variant is not one', isHoldout({ id: 'town' }) === false);

// ---------------------------------------------------------------------------
section('H2  an experiment cannot exist without one');
let w = withHoldout([{ id: 'town', content: 'A website question about Plano' }]);
check('a missing holdout is added rather than refused', w.ok === true && w.added === true, JSON.stringify(w));
check('and it comes first', w.variants[0].id === HOLDOUT_ID);
check('a supplied holdout is kept', withHoldout([holdoutArm(), { id: 'a' }]).added === false);
// the one that would quietly destroy the baseline
w = withHoldout([{ id: HOLDOUT_ID, content: 'a third message' }, { id: 'a' }]);
check('a holdout with content is refused', w.ok === false, JSON.stringify(w));
check('and says it would leave no baseline', /leaves the experiment with no baseline/.test(w.error), w.error);
check('a zero-weight holdout is refused', withHoldout([{ id: HOLDOUT_ID, weight: 0 }, { id: 'a' }]).ok === false);
check('two holdouts are refused', withHoldout([holdoutArm(), holdoutArm(), { id: 'a' }]).ok === false);

// ---------------------------------------------------------------------------
section('H3  the removal that happens three weeks in');
let c = checkVariantChange([holdoutArm(), { id: 'a' }], [{ id: 'a' }, { id: 'b' }]);
check('dropping the holdout is refused', c.ok === false, JSON.stringify(c));
check('and the reason says what it is for', /better than the message you were already sending/.test(c.error));
check('naming when it matters most', /most valuable exactly when a variant looks promising/.test(c.error));
c = checkVariantChange([holdoutArm(), { id: 'a' }], [{ id: HOLDOUT_ID, weight: 0 }, { id: 'a' }]);
check('zero-weighting it is refused as removal by another name', c.ok === false && /by another name/.test(c.error), c.error);
c = checkVariantChange([holdoutArm(), { id: 'a' }], [{ id: HOLDOUT_ID, content: 'x' }, { id: 'a' }]);
check('giving it content is refused', c.ok === false);
check('a legal change passes', checkVariantChange([holdoutArm(), { id: 'a' }], [holdoutArm(), { id: 'a' }, { id: 'b' }]).ok === true);
check('an experiment that somehow has no holdout refuses to carry the fault forward',
  checkVariantChange([{ id: 'a' }], [{ id: 'a' }]).ok === false);

// ---------------------------------------------------------------------------
section('H4  nobody is moved out of the holdout');
let m = mayReassign({ currentVariantId: HOLDOUT_ID, toVariantId: 'town' });
check('moving a holdout member into a variant is refused', m.ok === false, JSON.stringify(m));
check('and says the comparison would break twice', /wrong twice in the same direction/.test(m.reason), m.reason);
check('staying in the holdout is fine', mayReassign({ currentVariantId: HOLDOUT_ID, toVariantId: HOLDOUT_ID }).ok === true);
check('moving between ordinary variants is not this rule\'s business', mayReassign({ currentVariantId: 'a', toVariantId: 'b' }).ok === true);

// ---------------------------------------------------------------------------
section('H5  the whole lifecycle, through the real experiment module');
await reset();
let r = await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'town', content: 'A website question about Plano' }] });
check('one variant is enough, because the holdout is the other arm', r.ok === true, JSON.stringify(r));
check('the stored experiment has a holdout', r.experiment.variants.some((v) => v.id === HOLDOUT_ID), JSON.stringify(r.experiment.variants.map((v) => v.id)));
check('flagged as such', r.experiment.variants.find((v) => v.id === HOLDOUT_ID)?.holdout === true);
check('and carrying no content', r.experiment.variants.find((v) => v.id === HOLDOUT_ID)?.content === null);
check('an experiment with no variants at all is still refused', (await createExperiment({ id: 'exp-empty', variable: 'subject', variants: [] })).ok === false);

await setExperimentState(EID, 'running');
// assign enough people that both arms are populated
for (let i = 0; i < 40; i++) await assign({ experimentId: EID, contactId: `hold-${i}` });
const inHoldout = [];
for (let i = 0; i < 40; i++) {
  const a = await getAssignment(EID, `hold-${i}`);
  if (a?.variantId === HOLDOUT_ID) inHoldout.push(`hold-${i}`);
}
check('people land in the holdout', inHoldout.length > 0, `${inHoldout.length}/40`);

// the edit that would drop it
let u = await updateVariants(EID, [{ id: 'town', content: 'x' }]);
check('the real update refuses to drop the holdout', u.ok === false, JSON.stringify(u));
// and crucially it is REPORTED as refused, not silently repaired
check('and does not silently re-add it while reporting success', u.ok !== true);
check('the stored experiment is unchanged', (await tally(EID)).arms.some((a) => a.variantId === HOLDOUT_ID));
u = await updateVariants(EID, [{ id: HOLDOUT_ID }, { id: 'town', content: 'x' }, { id: 'third', content: 'y' }]);
check('a legal edit still works', u.ok === true, JSON.stringify(u).slice(0, 120));

// nobody moved
for (const cid of inHoldout) {
  const a = await getAssignment(EID, cid);
  if (a?.variantId !== HOLDOUT_ID) { check('a holdout member was moved by the edit', false, cid); break; }
}
check('everyone in the holdout is still in the holdout after the edit',
  (await Promise.all(inHoldout.map((cid) => getAssignment(EID, cid)))).every((a) => a.variantId === HOLDOUT_ID));

// ---------------------------------------------------------------------------
section('H6  reported alongside every variant, and first');
const t = await tally(EID);
check('the tally knows it has a baseline', t.hasBaseline === true, JSON.stringify(t.hasBaseline));
check('with no warning', t.baselineWarning === null);
check('and the holdout arm is flagged', t.arms.find((a) => a.variantId === HOLDOUT_ID)?.baseline === true);

const b = primaryBreakdown(t);
check('the breakdown reports a baseline', b.hasBaseline === true);
check('and puts it first', b.arms[0].variantId === HOLDOUT_ID, b.arms.map((a) => a.variantId).join(','));

// The reordering only proves anything when the baseline is NOT already first.
// A control that deleted the sort passed, because the stored experiment
// happens to list the holdout first — so the test was watching the input, not
// the behaviour.
{
  const outOfOrder = primaryBreakdown({
    ok: true,
    experimentId: 'x',
    arms: [
      { variantId: 'town', label: 'Town', assigned: 10, outcomes: {} },
      { variantId: 'third', label: 'Third', assigned: 10, outcomes: {} },
      { variantId: HOLDOUT_ID, label: 'Holdout', assigned: 10, outcomes: {} },
    ],
  });
  check('a baseline listed LAST is moved to the front', outOfOrder.arms[0].variantId === HOLDOUT_ID,
    outOfOrder.arms.map((a) => a.variantId).join(','));
  check('and the other arms keep their order', outOfOrder.arms.slice(1).map((a) => a.variantId).join(',') === 'town,third',
    outOfOrder.arms.map((a) => a.variantId).join(','));
}
check('with the baseline arm available directly', b.baseline?.variantId === HOLDOUT_ID);
check('every variant is still listed', b.arms.length >= 2);

// the comparison is against the baseline, not against arm[0] by accident
const s = sampleSizeStatement({
  arms: [
    { variantId: 'town', assigned: 500, successes: 40 },
    { variantId: HOLDOUT_ID, assigned: 500, successes: 10 },
    { variantId: 'third', assigned: 500, successes: 38 },
  ],
});
check('the statement names the baseline', s.baseline === HOLDOUT_ID, String(s.baseline));
check('and compares against it, not against the first arm listed',
  s.comparison?.a?.variantId === HOLDOUT_ID, JSON.stringify(s.comparison?.a?.variantId));

// an experiment with no holdout must say so rather than compare quietly
const noBase = sampleSizeStatement({ arms: [{ variantId: 'a', assigned: 100, successes: 5 }, { variantId: 'b', assigned: 100, successes: 9 }] });
check('with no holdout the statement warns', !!noBase.baselineWarning, String(noBase.baselineWarning));
check('saying what cannot be known', /never whether any of them beats the message that was already being sent/.test(noBase.baselineWarning));

// ---------------------------------------------------------------------------
section('H7  the comparison that matters: better than the others, worse than the baseline');
// the exact failure a holdout exists to catch
const arms = [
  { variantId: HOLDOUT_ID, assigned: 500, successes: 60, holdout: true },
  { variantId: 'a', assigned: 500, successes: 20 },
  { variantId: 'b', assigned: 500, successes: 25 },
];
const ab = againstBaseline(arms, compareArms);
check('every variant is compared with the baseline', ab.ok === true && ab.comparisons.length === 2, JSON.stringify(ab).slice(0, 160));
check('the baseline is reported', ab.baseline.variantId === HOLDOUT_ID);
const bVsBase = ab.comparisons.find((x) => x.variantId === 'b');
check('the best-looking variant is measurably worse than the baseline',
  bVsBase.vsBaseline.verdict === 'difference' && bVsBase.vsBaseline.better === HOLDOUT_ID,
  JSON.stringify(bVsBase.vsBaseline.verdict) + ' ' + bVsBase.vsBaseline.better);
check('and the note spells out what that means', /least-bad of a set that is worse than where you started/.test(ab.note));
check('with no baseline there is nothing to compare against', againstBaseline([{ variantId: 'a' }], compareArms).ok === false);

const ordered = withBaselineFirst(arms);
check('ordering puts the baseline first', ordered.arms[0].variantId === HOLDOUT_ID);
check('and explains what the first row is', /message that was already being sent, unchanged/.test(ordered.note));
check('a missing baseline is called out in the note', /nothing here can tell you whether any variant beats/.test(withBaselineFirst([{ variantId: 'a' }]).note));

await reset();
await store.set('experiment:exp-empty', '').catch(() => {});
done();
