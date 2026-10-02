// R9.5 — adequate sample size and stated uncertainty.
// A winner is never declared from two replies.
//
// The headline check is the requirement's own wording, tested literally: two
// replies, split 2–0 in favour of one arm, must not produce a winner.
//
// The rest is about the arithmetic being right rather than reassuring. The
// textbook interval p̂ ± z·√(p̂(1-p̂)/n) is wrong exactly where this system
// lives — with 1 from 20 it returns a negative lower bound for a quantity that
// cannot be negative, and with 0 successes it claims [0, 0], certainty from no
// information. Wilson is used instead, and these checks pin it against values
// that can be verified by hand.
import { check, section, done } from './world.mjs';
import {
  VERDICT, wilson, requiredPerArm, timeToReach, compareArms, mayDeclareWinner, sampleSizeStatement,
} from '../lib/significance.js';

const near = (a, b, tol = 0.001) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
section('G1  the interval is right, including where the naive one is wrong');
let w = wilson(50, 100);
check('50/100 centres on a half', near(w.point, 0.5));
check('with the known Wilson bounds', near(w.lo, 0.4038) && near(w.hi, 0.5962), `${w.lo.toFixed(4)}–${w.hi.toFixed(4)}`);
w = wilson(1, 20);
check('1/20 matches the published interval', near(w.lo, 0.0089) && near(w.hi, 0.2361), `${w.lo.toFixed(4)}–${w.hi.toFixed(4)}`);
// where the textbook formula breaks
check('a small-sample lower bound is never negative', wilson(1, 20).lo >= 0 && wilson(1, 50).lo >= 0);
w = wilson(0, 20);
check('0/20 does NOT claim certainty', w.hi > 0.1, `${w.lo}–${w.hi}`);
check('and its upper bound is the known 16.1%', near(w.hi, 0.1611), String(w.hi));
check('with a lower bound of zero', w.lo === 0);
check('an empty arm is unknown, not 0%', wilson(0, 0).unknown === true);
check('and spans the whole range rather than implying anything', wilson(0, 0).lo === 0 && wilson(0, 0).hi === 1);
check('a wider confidence gives a wider interval', wilson(5, 50, 0.99).hi > wilson(5, 50, 0.95).hi);
check('bounds stay inside 0 and 1', wilson(50, 50).hi <= 1 && wilson(0, 50).lo >= 0);

// ---------------------------------------------------------------------------
section('G2  the required sample size, and the honest timeline');
let n = requiredPerArm({ baseline: 0.03, minDetectableEffect: 0.01 });
check('the standard formula is used', n.ok === true && n.perArm === 5299, JSON.stringify(n));
check('and both arms are counted in the total', n.total === 10598);
// a bigger difference is cheaper to find; a smaller one is dearer
check('detecting a larger effect needs fewer people', requiredPerArm({ baseline: 0.03, minDetectableEffect: 0.03 }).perArm < n.perArm);
check('detecting a smaller effect needs more', requiredPerArm({ baseline: 0.03, minDetectableEffect: 0.005 }).perArm > n.perArm);
check('higher confidence costs more', requiredPerArm({ baseline: 0.03, minDetectableEffect: 0.01, confidence: 0.99 }).perArm > n.perArm);
check('a nonsense baseline is refused', requiredPerArm({ baseline: 0, minDetectableEffect: 0.01 }).ok === false);
check('a zero effect is refused', requiredPerArm({ baseline: 0.03, minDetectableEffect: 0 }).ok === false);
check('an effect that would exceed 100% is refused', requiredPerArm({ baseline: 0.99, minDetectableEffect: 0.02 }).ok === false);

// the most useful true thing this can say
let t = timeToReach(5299, 2, 25);
check('the timeline is computed from the real sending rate', t.weeks === 424, String(t.weeks));
check('and expressed in years when it is years', t.years > 8, String(t.years));
check('saying plainly that more sending will not settle it', /cannot be settled by sending more/.test(t.note), t.note);
check('and what to do instead', /Change what is being tested/.test(t.note));
check('a reachable target is described in weeks', /about \d+ weeks/.test(timeToReach(100, 2, 25).note));

// ---------------------------------------------------------------------------
section('G3  the requirement, tested in its own words: two replies, no winner');
// 2 replies for A, 0 for B, out of 40 each. The raw counts look decisive.
let cmp = compareArms({ variantId: 'a', successes: 2, n: 40 }, { variantId: 'b', successes: 0, n: 40 });
check('two replies produce NO winner', cmp.verdict !== VERDICT.DIFFERENCE, JSON.stringify(cmp.verdict));
check('it is reported as too early', cmp.verdict === VERDICT.TOO_EARLY, cmp.verdict);
check('and says how few outcomes that is', /2 outcomes across both arms/.test(cmp.reason), cmp.reason);
check('explaining why a handful cannot decide', /a difference between a handful of people/.test(cmp.reason));
check('and how many more are needed', cmp.needed === 28, String(cmp.needed));
check('no winner may be declared from it', mayDeclareWinner(cmp).ok === false);

// even a stark split stays silent below the floor
cmp = compareArms({ variantId: 'a', successes: 5, n: 20 }, { variantId: 'b', successes: 0, n: 20 });
check('5 against 0 is still too early', cmp.verdict === VERDICT.TOO_EARLY, JSON.stringify(cmp));
check('an empty arm is too early whatever the other shows', compareArms({ variantId: 'a', successes: 9, n: 50 }, { variantId: 'b', successes: 0, n: 0 }).verdict === VERDICT.TOO_EARLY);

// ---------------------------------------------------------------------------
section('G4  with enough data, overlap still means no finding');
// 20/400 vs 28/400 — 48 outcomes, past the floor, but the intervals overlap
cmp = compareArms({ variantId: 'a', successes: 20, n: 400 }, { variantId: 'b', successes: 28, n: 400 });
check('past the floor it will speak', cmp.verdict !== VERDICT.TOO_EARLY, cmp.verdict);
check('and says no difference is detectable', cmp.verdict === VERDICT.NO_DIFFERENCE_DETECTABLE, JSON.stringify(cmp.verdict));
check('showing both ranges', /%–/.test(cmp.reason), cmp.reason);
check('it does not claim the arms are the same', /not evidence that the arms are the same/.test(cmp.reason));
check('only that this much data cannot separate them', /cannot tell them apart/.test(cmp.reason));
check('no winner from an overlap', mayDeclareWinner(cmp).ok === false);

// a genuinely separated pair
cmp = compareArms({ variantId: 'a', successes: 10, n: 500 }, { variantId: 'b', successes: 80, n: 500 });
check('a real separation is reported', cmp.verdict === VERDICT.DIFFERENCE, JSON.stringify(cmp.verdict));
check('naming which arm', cmp.better === 'b', cmp.better);
check('with both intervals in the reason', /against a at/.test(cmp.reason), cmp.reason);
check('and a caveat about repeated looking', /another chance for noise to cross the line/.test(cmp.caveat));
check('a winner may be declared from it', mayDeclareWinner(cmp).ok === true);
check('carrying the caveat forward', !!mayDeclareWinner(cmp).caveat);

// ---------------------------------------------------------------------------
section('G5  peeking is its own problem');
check('a few looks are fine', mayDeclareWinner(cmp, { looks: 3 }).ok === true);
let d = mayDeclareWinner(cmp, { looks: 12 });
check('many looks block the declaration', d.ok === false, JSON.stringify(d));
check('and say how many times it was examined', /examined 12 times/.test(d.reason), d.reason);
check('explaining what repeated checking does', /inflates the false-positive rate/.test(d.reason));
check('and admitting no correction is implemented', /not implemented here/.test(d.reason));

// ---------------------------------------------------------------------------
section('G6  the statement that goes on every report');
let s = sampleSizeStatement({
  arms: [{ variantId: 'a', assigned: 40, successes: 2 }, { variantId: 'b', assigned: 40, successes: 0 }],
  looks: 1,
});
check('each arm carries its interval', s.arms.every((a) => !!a.interval), JSON.stringify(s.arms[0]));
check('the total outcomes are stated', s.totalOutcomes === 2);
check('the required sample size is included', s.required.perArm === 5299, JSON.stringify(s.required));
check('described in the terms it was computed from', /percentage points on a 3.0% baseline/.test(s.required.toDetect));
check('with the timeline', s.timeline.weeks === 424);
// the headline answers "can I believe this yet?"
check('no winner can be declared', s.canDeclareWinner === false);
check('and the headline says why', /2 outcomes across both arms/.test(s.headline), s.headline);
check('the number of looks is carried', s.looks === 1);

s = sampleSizeStatement({ arms: [{ variantId: 'a', assigned: 500, successes: 10 }, { variantId: 'b', assigned: 500, successes: 80 }], looks: 1 });
check('a real difference reaches the headline', s.canDeclareWinner === true, s.headline);
check('with the caveats pointed at', /with the caveats below/.test(s.headline));
s = sampleSizeStatement({ arms: [{ variantId: 'a', assigned: 10, successes: 1 }] });
check('one arm cannot be compared', s.canDeclareWinner === false && /Not enough arms/.test(s.headline), s.headline);

// ---------------------------------------------------------------------------
section('G7  the real report carries it, and counts the looks');
{
  const handler = (await import('../api/admin.js')).default;
  const { createExperiment, setExperimentState, assign } = await import('../lib/experiments.js');
  const { store } = await import('../lib/store.js');
  const EID = 'exp-significance';
  await store.set(`experiment:${EID}`, '').catch(() => {});
  await store.set(`experiment:looks:${EID}`, '').catch(() => {});
  await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'a' }, { id: 'b' }] });
  await setExperimentState(EID, 'running');
  for (let i = 0; i < 6; i++) await assign({ experimentId: EID, contactId: `sig-${i}` });

  process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret';
  const mk = () => {
    const r = { statusCode: 0, body: null };
    r.setHeader = () => {}; r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; }; r.send = (b) => { r.body = b; return r; }; r.end = () => r;
    return r;
  };
  const read = async () => {
    const res = mk();
    await handler({ method: 'GET', query: { do: 'experiments-list', secret: process.env.CRON_SECRET }, headers: {} }, res);
    return (res.body?.experiments || []).find((x) => x.experiment.id === EID);
  };

  const first = await read();
  check('the report carries a certainty statement', !!first?.certainty, JSON.stringify(first || {}).slice(0, 140));
  check('saying no winner can be declared', first?.certainty?.canDeclareWinner === false);
  check('with the required sample size', (first?.certainty?.required?.perArm || 0) > 1000, JSON.stringify(first?.certainty?.required));
  check('and the timeline in years', !!first?.certainty?.timeline?.note);
  check('the first look is counted', first?.certainty?.looks === 1, String(first?.certainty?.looks));

  const second = await read();
  check('looking again increments the counter', second?.certainty?.looks === 2, String(second?.certainty?.looks));
  check('so repeated checking is visible rather than free', (second?.certainty?.looks || 0) > (first?.certainty?.looks || 0));

  await store.set(`experiment:${EID}`, '').catch(() => {});
  await store.set(`experiment:looks:${EID}`, '').catch(() => {});
}

done();
