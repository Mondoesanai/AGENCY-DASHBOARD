// R9.7 + R9.8 on screen.
//
// Until this panel existed, R9.7 was satisfied in the store and nowhere the
// owner could reach — and the requirement's own stated value is being able to
// open the dashboard and ask what changed. A ledger nothing reads cannot
// answer that.
//
// Three failures this tests for, all of which this build has shipped before in
// other panels:
//   1. a failed read rendering as "nothing has changed"
//   2. an undo button offered for a change that cannot be undone
//   3. the limits stated from the defaults when the stored ones were unreadable
import { check, section, done } from './world.mjs';
import {
  KIND_WORD, undoability, headline, renderOptimisation, wireOptimisation,
} from '../public/optimisation.js';

const change = (o = {}) => ({
  id: 'c1', kind: 'variants-changed', actor: 'owner', target: 'exp-1',
  before: { variants: [] }, after: { variants: [] }, reason: 'the arms were edited',
  at: Date.UTC(2026, 8, 20, 14, 30), reverted: false, revertedAt: null, ...o,
});
const BOUNDS = {
  allowAutomaticChanges: false, maxWeightShiftPerChange: 0.2, maxChangesPerWeek: 3,
  requireOwnerForStateChange: true, requireOwnerForReassignment: true,
};

// ---------------------------------------------------------------------------
section('U1  a failed read never looks like a quiet week');
const failed = renderOptimisation(null, { error: 'the change history did not answer' });
check('an error renders the error', /did not answer/.test(failed), failed.slice(0, 200));
check('and never says nothing changed', !/no change/i.test(failed), failed.slice(0, 300));
check('and offers a retry', /data-retry="optimisation"/.test(failed));

const loading = renderOptimisation(null);
check('no data yet is a loading state, not an error', !/did not answer/.test(loading));
check('and not an empty history either', !/No change has been recorded/.test(loading));

const empty = renderOptimisation({ changes: [], bounds: BOUNDS, domains: [] });
check('a genuinely empty history says so', /No change has been recorded/.test(empty));
check('and distinguishes itself from being unavailable', /different from the history being unavailable/.test(empty));

let h = headline(null, { error: 'boom' });
check('the headline refuses to summarise a failed read', h.word === 'cannot tell');
check('and says an unreadable history is not no changes', /not the same as no changes/.test(h.detail), h.detail);
h = headline({ changes: [] });
check('an empty history is not reported as good', h.tone !== 'good', h.tone);

// ---------------------------------------------------------------------------
section('U2  an undo is offered only where there is something to put back');
check('a change with a before can be undone', undoability(change()).can === true);
let u = undoability(change({ before: null }));
check('a change with no before cannot', u.can === false);
check('and says why', /nothing to put back/.test(u.why), u.why);
u = undoability(change({ reverted: true, revertedAt: Date.UTC(2026, 8, 21) }));
check('an already-undone change cannot be undone again', u.can === false);
check('and says when it was', /already undone on /.test(u.why), u.why);
check('undefined before is treated like null', undoability(change({ before: undefined })).can === false);
check('no change at all is survivable', undoability(null).can === false && undoability(undefined).can === false);

let html = renderOptimisation({ changes: [change()], bounds: BOUNDS, domains: [] });
check('a reversible change gets a working button', /data-undo="c1"/.test(html));
check('labelled in plain words', /Put it back/.test(html));

html = renderOptimisation({ changes: [change({ before: null })], bounds: BOUNDS, domains: [] });
check('an irreversible change gets NO undo button', !/data-undo=/.test(html), html.slice(0, 400));
check('it gets a disabled one instead', /disabled/.test(html) && /Cannot be undone/.test(html));
check('with the reason on screen, not only in a tooltip', /nothing to put back/.test(html.replace(/title="[^"]*"/g, '')));

// the busy state applies to the one being undone, not to every row
html = renderOptimisation(
  { changes: [change({ id: 'a' }), change({ id: 'b' })], bounds: BOUNDS, domains: [] },
  { busy: true, busyId: 'a' }
);
check('the row being undone shows it is working', /data-undo="a"[^>]*disabled/.test(html), 'a');
check('and the other row is still usable', /data-undo="b"(?![^>]*disabled)/.test(html), 'b');

// ---------------------------------------------------------------------------
section('U3  the limits are stated from the stored settings, not the defaults');
html = renderOptimisation({ changes: [], bounds: BOUNDS, domains: [] });
check('automation off is stated plainly', /Nothing changes an experiment by itself/.test(html));
check('and says automation cannot widen its own limits', /can never turn it on or widen these limits itself/.test(html));

html = renderOptimisation({
  changes: [], domains: [],
  bounds: { ...BOUNDS, allowAutomaticChanges: true, maxWeightShiftPerChange: 0.15, maxChangesPerWeek: 2 },
});
check('automation on is stated plainly too', /Automatic changes are switched ON/.test(html));
check('with the real traffic cap, not the default', /15% of traffic/.test(html), 'expected 15%');
check('and the real weekly cap', /2 changes a week/.test(html), 'expected 2');
check('and it is marked as a warning, not neutral', /note warn/.test(html));

html = renderOptimisation({ changes: [], domains: [], bounds: { ...BOUNDS, unreadable: true } });
check('unreadable limits say so', /could not be read/.test(html));
check('and say these are the strictest defaults, not the saved ones', /strictest defaults, not your saved settings/.test(html));

html = renderOptimisation({ changes: [], domains: [], bounds: null });
check('no limits at all is not reported as "nothing changes by itself"', !/Nothing changes an experiment by itself/.test(html));
check('it says the limits could not be read', /limits could not be read/.test(html));

// ---------------------------------------------------------------------------
section('U4  an automatic change is findable');
html = renderOptimisation({
  changes: [change({ id: 'own', at: 3000 }), change({ id: 'auto', actor: 'automatic', at: 1000 })],
  bounds: BOUNDS, domains: [],
});
check('the automatic row is listed before the newer owner row', html.indexOf('data-undo="auto"') < html.indexOf('data-undo="own"'));
check('and is marked as automatic', /pill sm warn">automatic/.test(html));
check('an owner change is labelled "you", not a username', /pill sm ">you|pill sm">you/.test(html.replace(/\s+/g, ' ')), html.slice(0, 200));
h = headline({ changes: [change({ actor: 'automatic' })] });
check('the headline counts automatic changes', /1 automatic change/.test(h.word), h.word);
check('and flags them rather than reassuring', h.tone === 'warn');
h = headline({ changes: [change(), change({ id: 'c2' })] });
check('all-owner changes are reported as such', /all by you/.test(h.word), h.word);

check('every change kind has plain words', Object.keys(KIND_WORD).length >= 6);
check('and none of them is a raw identifier', Object.values(KIND_WORD).every((w) => !w.includes('-')));
html = renderOptimisation({ changes: [change({ kind: 'contact-reassigned' })], bounds: BOUNDS, domains: [] });
check('a kind is rendered in words', /someone moved between arms/.test(html));
html = renderOptimisation({ changes: [change({ kind: 'something-new' })], bounds: BOUNDS, domains: [] });
check('an unknown kind still renders rather than vanishing', /something-new/.test(html));

// ---------------------------------------------------------------------------
section('U5  the six prohibitions are on screen with their reasons');
const DOMAINS = [
  { id: 'price', label: 'Price', rule: 'No arm may name a price.', why: 'It is a commercial decision.' },
  { id: 'promise', label: 'What is promised', rule: 'No arm may guarantee an outcome.', why: 'The overpromise wins and loses the client.' },
];
html = renderOptimisation({ changes: [], bounds: BOUNDS, domains: DOMAINS });
check('the prohibitions are rendered', /Six things no experiment may touch/.test(html));
check('with each label', /Price/.test(html) && /What is promised/.test(html));
check('each rule', /No arm may name a price/.test(html));
check('and each reason', /commercial decision/.test(html));
check('and it explains that the wording is checked, not just the declared variable', /hidden in a subject-line test is still a price test/.test(html));
check('no domains supplied renders nothing rather than an empty box', !/Six things/.test(renderOptimisation({ changes: [], bounds: BOUNDS, domains: [] })));

// ---------------------------------------------------------------------------
section('U6  values from the store are escaped, not interpolated');
html = renderOptimisation({
  changes: [change({ target: '<img src=x onerror=alert(1)>', reason: '"><script>bad()</script>' })],
  bounds: BOUNDS, domains: [{ id: 'x', label: '<b>x</b>', rule: 'r'.repeat(25), why: 'w'.repeat(25) }],
});
check('a target with markup is escaped', !/<img src=x/.test(html));
check('a reason with a script tag is escaped', !/<script>bad\(\)/.test(html));
check('a prohibition label is escaped', !/<b>x<\/b>/.test(html));
check('but the text still appears', /&lt;img src=x/.test(html));

// ---------------------------------------------------------------------------
section('U7  the undo button is wired to a handler');
// the failure this catches: buttons rendered with no click handler, which this
// build shipped once already with data-fix
const listeners = [];
const fakeRoot = { addEventListener: (ev, fn) => listeners.push([ev, fn]) };
check('wiring a real root succeeds', wireOptimisation(fakeRoot, {}) === true);
check('and registers a click listener', listeners.length === 1 && listeners[0][0] === 'click');
check('wiring nothing is survivable', wireOptimisation(null, {}) === false && wireOptimisation({}, {}) === false);

const fire = (target) => listeners[0] && listeners[0][1]({ target });
let undone = [];
let retried = 0;
listeners.length = 0;
wireOptimisation(fakeRoot, { undo: (id) => undone.push(id), retry: () => retried++ });

const btn = { closest: (sel) => (sel === '[data-undo]' ? { getAttribute: () => 'c9' } : null) };
fire(btn);
check('clicking an undo button calls the handler with the id', undone.join(',') === 'c9', undone.join(','));

const retryEl = { closest: (sel) => (sel === '[data-retry="optimisation"]' ? {} : null) };
fire(retryEl);
check('clicking retry calls the retry handler', retried === 1, String(retried));

undone = [];
fire({ closest: () => null });
check('clicking elsewhere does nothing', undone.length === 0 && retried === 1);
fire(null);
check('a click with no target is survivable', true);
fire({});
check('a target without closest is survivable', true);

// a handler that was not supplied must not throw
listeners.length = 0;
wireOptimisation(fakeRoot, {});
fire(btn);
fire(retryEl);
check('missing handlers are survivable', true);

done();
