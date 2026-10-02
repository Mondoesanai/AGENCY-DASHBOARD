// R9.1 — variants, assignments and outcomes, stored so they can be reported
// honestly later.
//
// Splitting traffic is easy. What is hard, and what these checks are about, is
// that at a target of roughly 25 prospects a week an experiment takes months
// to say anything — and the storage must not quietly make a false comparison
// possible in the meantime. Three ways that happens, each tested:
//
//   * reweighting the arms silently moves people who were already sent one;
//   * an outcome with no assignment is dropped, shrinking the denominator;
//   * a rate is computed from six sends and reported as a finding.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  EXPERIMENT_STATE, VARIABLES, FORBIDDEN_VARIABLES,
  createExperiment, getExperiment, listExperiments, setExperimentState,
  hashToBucket, pickVariant, assign, getAssignment, listAssignments,
  recordOutcome, listOutcomes, tally,
} from '../lib/experiments.js';

const EID = 'exp-subject-1';
const reset = async () => {
  for (const id of await store.smembers('experiments:all').catch(() => [])) {
    await store.set(`experiment:${id}`, '').catch(() => {});
    await store.srem?.('experiments:all', id);
  }
};

// ---------------------------------------------------------------------------
section('X1  an experiment that could not be acted on is refused');
await reset();
let r = await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'a' }] });
check('one arm is refused', r.ok === false, JSON.stringify(r));
check('and says why', /nothing to compare/.test(r.error));
r = await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'a' }, { id: 'a' }] });
check('duplicate arm ids are refused', r.ok === false && /could not be told apart/.test(r.error));
r = await createExperiment({ id: EID, variable: 'everything', variants: [{ id: 'a' }, { id: 'b' }] });
check('an untestable variable is refused', r.ok === false && /not a testable variable/.test(r.error));
r = await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'a', weight: 0 }, { id: 'b' }] });
check('a zero weight is refused', r.ok === false && /positive weight/.test(r.error));

// the ones that are prohibitions, not validation
for (const f of FORBIDDEN_VARIABLES) {
  const out = await createExperiment({ id: `x-${f.id}`, variable: f.id, variants: [{ id: 'a' }, { id: 'b' }] });
  check(`"${f.id}" may never be varied`, out.ok === false, JSON.stringify(out));
  // Assert the PROHIBITION is what refused it, not the allow-list. A control
  // that deleted the forbidden check still passed, because these ids are also
  // absent from VARIABLES — the test was passing for the wrong reason, and
  // would have gone on passing if someone added "price" to the allow-list.
  check(`and it is refused AS a prohibition`, /may not be varied/.test(out.error || ''), out.error);
  check(`with the reason it is prohibited`, (out.error || '').includes(f.why), out.error);
}
check('consent is one of them', FORBIDDEN_VARIABLES.some((f) => f.id === 'consent'));
check('price is one of them', FORBIDDEN_VARIABLES.some((f) => f.id === 'price'));
check('the unsubscribe mechanism is one of them', FORBIDDEN_VARIABLES.some((f) => f.id === 'unsubscribe'));

r = await createExperiment({
  id: EID, variable: 'subject', hypothesis: 'naming the town gets more replies',
  variants: [{ id: 'control', label: 'Current subject', weight: 1, content: null }, { id: 'town', label: 'Town in subject', weight: 1, content: 'A website question about Plano' }],
});
check('a well-formed experiment is created', r.ok === true, JSON.stringify(r));
check('it starts as a draft, not running', r.experiment.state === EXPERIMENT_STATE.DRAFT);
check('creating the same id twice is refused', (await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'a' }, { id: 'b' }] })).ok === false);

// ---------------------------------------------------------------------------
section('X2  assignment is deterministic and sticky');
check('the same key always lands in the same bucket', hashToBucket('abc') === hashToBucket('abc'));
check('different keys generally differ', hashToBucket('abc') !== hashToBucket('abd'));
const variants = [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }];
// Determinism has to be asserted over many draws, not two. A control that
// replaced the hash with Math.random() passed a two-call comparison — it
// agrees with itself half the time by luck. Fifty draws makes that ~1 in 10^15.
{
  const draws = new Set();
  for (let i = 0; i < 50; i++) draws.add(pickVariant(variants, 'c1').id);
  check('the same key gives the same arm every time, across 50 draws', draws.size === 1, [...draws].join(','));
  const other = new Set();
  for (let i = 0; i < 50; i++) other.add(pickVariant(variants, 'c2').id);
  check('and another key is equally stable', other.size === 1, [...other].join(','));
}
check('the bucket itself is stable', new Set(Array.from({ length: 50 }, () => hashToBucket('c1'))).size === 1);
// a 50/50 split should be roughly even over many contacts — not exact, just not broken
{
  let a = 0;
  for (let i = 0; i < 1000; i++) if (pickVariant(variants, `contact-${i}`).id === 'a') a++;
  check('a 50/50 split is roughly even over 1000 contacts', a > 400 && a < 600, `${a}/1000 in arm a`);
}
{
  const weighted = [{ id: 'small', weight: 1 }, { id: 'big', weight: 9 }];
  let big = 0;
  for (let i = 0; i < 1000; i++) if (pickVariant(weighted, `c-${i}`).id === 'big') big++;
  check('a 1:9 weighting is respected', big > 850 && big < 950, `${big}/1000 in the big arm`);
}
check('no arms yields null rather than throwing', pickVariant([], 'x') === null);

// nobody is assigned while it is a draft
let a1 = await assign({ experimentId: EID, contactId: 'c1' });
check('a draft assigns nobody', a1.ok === false && /is draft/.test(a1.error), JSON.stringify(a1));
await setExperimentState(EID, EXPERIMENT_STATE.RUNNING);
a1 = await assign({ experimentId: EID, contactId: 'c1' });
check('a running experiment assigns', a1.ok === true && !!a1.assignment.variantId, JSON.stringify(a1));
check('and records how the arm was chosen', /hash of experiment and contact/.test(a1.assignment.basis));
const again = await assign({ experimentId: EID, contactId: 'c1' });
check('asking twice reuses the assignment', again.reused === true && again.assignment.variantId === a1.assignment.variantId);
check('an assignment needs both an experiment and a contact', (await assign({ experimentId: EID })).ok === false);

// ---------------------------------------------------------------------------
section('X3  reweighting must not move people who were already sent one');
// This is the quiet one. If assignment were recomputed, changing the weights
// would move past contacts between arms and take their outcomes with them.
{
  const before = [];
  for (let i = 0; i < 20; i++) {
    const out = await assign({ experimentId: EID, contactId: `moved-${i}` });
    before.push([`moved-${i}`, out.assignment.variantId]);
  }
  // reweight hard towards one arm, and remove nothing
  const exp = await getExperiment(EID);
  await store.set(`experiment:${EID}`, JSON.stringify({
    ...exp,
    variants: [{ ...exp.variants[0], weight: 99 }, { ...exp.variants[1], weight: 1 }],
  }));
  let moved = 0;
  for (const [cid, armBefore] of before) {
    const now = await getAssignment(EID, cid);
    if (now.variantId !== armBefore) moved++;
  }
  check('nobody already assigned moves when the weights change', moved === 0, `${moved} of ${before.length} moved`);

  // and an arm being REMOVED does not rewrite their history either
  await store.set(`experiment:${EID}`, JSON.stringify({ ...exp, variants: [exp.variants[0]] }));
  const stillThere = (await listAssignments(EID)).filter((x) => x.variantId === exp.variants[1].id).length;
  check('people in a removed arm keep their arm', stillThere > 0, `${stillThere} still recorded in the removed arm`);
  const t = await tally(EID);
  check('and the tally still shows that arm', t.arms.some((x) => x.variantId === exp.variants[1].id), JSON.stringify(t.arms.map((x) => x.variantId)));
  check('marked as no longer configured rather than hidden', t.arms.find((x) => x.variantId === exp.variants[1].id)?.retired === true);
  // put it back
  await store.set(`experiment:${EID}`, JSON.stringify(exp));
}

// ---------------------------------------------------------------------------
section('X4  an outcome with no assignment is counted, not dropped');
await recordOutcome({ experimentId: EID, contactId: 'c1', kind: 'reply:interested' });
let outs = await listOutcomes(EID);
check('an outcome is recorded', outs.length >= 1);
check('and carries the arm the contact was in', outs[0].variantId === a1.assignment.variantId, JSON.stringify(outs[0]));
check('and is marked attributed', outs[0].unattributed === false);

const orphan = await recordOutcome({ experimentId: EID, contactId: 'never-assigned', kind: 'reply:interested' });
check('an outcome for an unassigned contact is still recorded', orphan.ok === true, JSON.stringify(orphan));
check('with no arm invented for it', orphan.outcome.variantId === null);
check('and marked unattributed', orphan.outcome.unattributed === true);
const t2 = await tally(EID);
check('the tally reports unattributed outcomes separately', t2.unattributedOutcomes >= 1, JSON.stringify(t2));
check('rather than dropping them from the total', t2.totalOutcomes >= 2);

// two outcomes in the same millisecond must not overwrite each other — this
// build has hit that bug three times in other modules
{
  const at = 1770000000000;
  await recordOutcome({ experimentId: EID, contactId: 'c1', kind: 'reply:interested', at });
  await recordOutcome({ experimentId: EID, contactId: 'c1', kind: 'reply:interested', at });
  const sameMs = (await listOutcomes(EID)).filter((o) => o.at === at);
  check('two outcomes in the same millisecond are both kept', sameMs.length === 2, `${sameMs.length} kept`);
}
check('an outcome needs a kind', (await recordOutcome({ experimentId: EID, contactId: 'c1' })).ok === false);

// ---------------------------------------------------------------------------
section('X5  counts only — no rate, no winner');
const t = await tally(EID);
check('every arm reports how many were assigned', t.arms.every((x) => typeof x.assigned === 'number'));
check('and its outcomes by kind', t.arms.every((x) => typeof x.outcomes === 'object'));
check('the total assigned is reported', typeof t.totalAssigned === 'number' && t.totalAssigned > 0);
// the point
const asText = JSON.stringify(t);
check('no rate is computed anywhere in the tally', !/"rate"|"percent"|"conversionRate"/.test(asText), asText.slice(0, 200));
check('no winner is named', !/"winner"|"leading"|"best"/i.test(asText));
check('no significance is claimed', !/"significan|"pValue"|"confidence"/i.test(asText));
check('and it says so in words, so no caller has to remember', /No rate, no winner, and no significance is implied/.test(t.note));
check('a tally for an experiment that does not exist is refused', (await tally('nope')).ok === false);

// ---------------------------------------------------------------------------
section('X6  the real paths use it');
{
  // composeCold assigns, and the arm decides the part that varies
  const { composeCold } = await import('../lib/campaigns.js');
  const { saveSettings } = await import('../lib/settings.js');
  await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' }, targeting: { status: 'confirmed' } });
  const owner = { name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '2201 Preston Rd Suite 405, Plano TX 75093' };
  const prospect = { id: 'p-exp-1', name: 'Lone Star Flooring', email: 'pat@lonestar.test', web: { status: 'not-linked-in-listing' } };
  const msg = await composeCold(prospect, { owner });
  check('a composed message carries its experiment arm', !!msg.experiment, JSON.stringify(msg.experiment));
  check('naming the experiment', msg.experiment.experimentId === EID);
  check('and the arm the contact is in', !!msg.experiment.variantId);
  check('the assignment is recorded, not just returned', !!(await getAssignment(EID, 'p-exp-1')));
  // sticky: composing again gives the same arm
  const msg2 = await composeCold(prospect, { owner });
  check('composing again gives the same arm', msg2.experiment.variantId === msg.experiment.variantId);
  // and when the arm carries a subject, it is the subject that is used
  const arm = (await getExperiment(EID)).variants.find((v) => v.id === msg.experiment.variantId);
  if (arm?.content) check('the arm\'s subject line is the one sent', msg.subject === arm.content, msg.subject);
  else check('the control arm keeps the default subject', /Couldn't find a website/.test(msg.subject), msg.subject);
}

// a stopped experiment assigns nobody new, but keeps everyone it had
await setExperimentState(EID, EXPERIMENT_STATE.STOPPED);
const after = await assign({ experimentId: EID, contactId: 'brand-new' });
check('a stopped experiment assigns nobody new', after.ok === false, JSON.stringify(after));
check('but existing assignments survive', !!(await getAssignment(EID, 'c1')));
check('and are still tallied', (await tally(EID)).totalAssigned > 0);

await reset();
done();
