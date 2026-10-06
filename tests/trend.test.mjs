// Picking a reading without having to hit a 10px band.
//
// Making the chart tappable was not enough. Thirty readings across a
// phone-width card leaves about ten pixels each, and missing selects the wrong
// day silently — you get a number, it is just not the one you aimed at, which
// is worse than getting none.
//
// So stepping is the precise route and tapping is the rough one. These checks
// cover the stepping logic and the readout; the browser suite covers that the
// controls are real 44px targets and that the chart is no longer nested inside
// the client card's <button>.
import { check, section, done } from './world.mjs';
import { readingText, stepIndex, seriesOf, STEP_KEYS } from '../public/trend.js';

const VALUES = [10, 0, null, 42, 7];
const LABELS = ['Sep 1', 'Sep 2', 'Sep 3', 'Sep 4', 'Sep 5'];

// ---------------------------------------------------------------------------
section('T1  a reading reads as a sentence, with its date');
check('value and date', readingText(VALUES, LABELS, 0) === 'Sep 1: 10 visitors', readingText(VALUES, LABELS, 0));
check('the last one', readingText(VALUES, LABELS, 4) === 'Sep 5: 7 visitors');
check('the unit can change', readingText([3], ['Sep 1'], 0, { unit: 'conversions' }) === 'Sep 1: 3 conversions');

section('T2  zero and "no reading" are different sentences');
check('zero is zero', readingText(VALUES, LABELS, 1) === 'Sep 2: 0 visitors', readingText(VALUES, LABELS, 1));
check('missing is missing', readingText(VALUES, LABELS, 2) === 'Sep 3: no reading recorded', readingText(VALUES, LABELS, 2));
check('they are not the same string', readingText(VALUES, LABELS, 1) !== readingText(VALUES, LABELS, 2),
  'a chart that draws both at the baseline has already blurred them once');

section('T3  without dates it still says where you are, honestly');
check('position instead of a date', readingText(VALUES, null, 3) === 'Reading 4 of 5: 42 visitors', readingText(VALUES, null, 3));
check('a weaker claim is phrased as one', !/Sep/.test(readingText(VALUES, null, 3)));
check('no readings says so', readingText([], null, 0) === 'No readings yet');
check('a non-array is survivable', readingText(null, null, 0) === 'No readings yet');

section('T4  stepping stops at the ends rather than wrapping');
check('forward from 0', stepIndex(0, 1, 5) === 1);
check('back from 1', stepIndex(1, -1, 5) === 0);
check('back from 0 stays at 0', stepIndex(0, -1, 5) === 0, 'wrapping to the end would look like a bug');
check('forward from the last stays there', stepIndex(4, 1, 5) === 4);
check('first forward press lands on the first reading', stepIndex(-1, 1, 5) === 0);
check('first back press lands on the last', stepIndex(5, -1, 5) === 4);
check('an out-of-range index is clamped', stepIndex(99, 1, 5) === 4 && stepIndex(-99, -1, 5) === 0);
check('an empty series cannot be stepped', stepIndex(0, 1, 0) === 0);
check('a non-integer current is treated as unset', stepIndex(undefined, 1, 5) === 0);

section('T5  the series is read off the element, and bad data is no data');
const el = (v, l) => ({ getAttribute: (a) => (a === 'data-values' ? v : l) });
let s = seriesOf(el('[1,2,3]', '["a","b","c"]'));
check('values parse', s.values.length === 3 && s.values[1] === 2);
check('labels parse', s.labels[2] === 'c');
check('malformed JSON is empty, not a throw', seriesOf(el('{not json', 'nope')).values.length === 0);
check('a non-array payload is empty', seriesOf(el('"hello"', '42')).values.length === 0);
check('a missing element is survivable', seriesOf(null).values.length === 0);

section('T6  the keys that step are the ones people try');
for (const k of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) check(`${k} steps`, STEP_KEYS.includes(k));
check('a plain letter does not', !STEP_KEYS.includes('a'));
check('Tab is left alone so focus still moves', !STEP_KEYS.includes('Tab'));

done();
