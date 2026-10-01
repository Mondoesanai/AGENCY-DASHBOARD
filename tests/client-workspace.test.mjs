// R2.2 — a client's own work lives on that client's card.
import { check, section, done } from './world.mjs';
import { ticketsForSlug, needsOwner, renderClientRevisions, revisionSummary, STATE_LABEL, applyFix, wireFixButtons, FIX_HANDLED } from '../public/client-workspace.js';
import { classifyReason } from '../lib/revision-state.js';

const T = (over = {}) => ({ slug: 'acme', state: 'queued', at: Date.now(), summary: 'change the phone number', ...over });

// ---------------------------------------------------------------------------
section('W1  a client sees only their own requests');
const all = [
  T({ slug: 'acme', summary: 'acme one' }),
  T({ slug: 'beta', summary: 'beta one' }),
  T({ slug: 'acme', summary: 'acme two', at: Date.now() - 86400000 }),
];
const mine = ticketsForSlug(all, 'acme');
check('only this client\'s tickets', mine.length === 2, String(mine.length));
check('another client\'s request is not shown', !mine.some((t) => t.summary === 'beta one'));
check('newest first', mine[0].summary === 'acme one');
check('an unknown slug returns nothing rather than everything', ticketsForSlug(all, 'nobody').length === 0);

// ---------------------------------------------------------------------------
section('W2  stuck requests are separated from ones the machine is handling');
const stuck = [
  T({ state: 'blocked', blockedBy: { action: 'link-repo', label: 'Link this site to a repository', hint: 'The request is saved and resumes automatically once a repo is linked.' } }),
  T({ state: 'running' }),
  T({ state: 'succeeded' }),
];
check('only the blocked one needs the owner', needsOwner(stuck).length === 1, String(needsOwner(stuck).length));
check('a running ticket does not', !needsOwner(stuck).some((t) => t.state === 'running'));

// ---------------------------------------------------------------------------
section('W3  the blocked reason is finally RENDERED (R1.5)');
// The state machine produced an actionable recovery message from the start.
// Until now nothing displayed it, so the person who could fix it never saw it.
let html = renderClientRevisions({ tickets: stuck, slug: 'acme' });
check('the owner is told how many are stuck', /1 request stuck and waiting on you/.test(html), html.slice(0, 200));
check('and that nothing is lost meanwhile', /work is saved and resumes by itself/.test(html));
check('the actionable label is shown', /Link this site to a repository/.test(html));
check('with the explanation', /resumes automatically once a repo is linked/.test(html));
check('and a button to act on it', /data-fix="link-repo"/.test(html));
check('the button says what it does in words', /Link a repository/.test(html));
check('the state is shown in plain language, not a code', /stuck — needs you/.test(html), html.match(/pill sm warn">[^<]*/)?.[0]);
check('every state has a human label', Object.values(STATE_LABEL).every((l) => l.length > 3 && !/_/.test(l)));

html = renderClientRevisions({ tickets: [T({ state: 'running' })], slug: 'acme' });
check('with nothing stuck it says so', /Nothing here is waiting on you/.test(html));
check('and shows the work in progress in plain language', /being worked on/.test(html));

// ---------------------------------------------------------------------------
section('W4  empty and disconnected are different, and neither reads as a failure');
html = renderClientRevisions({ tickets: [], slug: 'acme' });
check('no requests says so plainly', /No change requests from this client/.test(html));
check('and states that none were lost', /not that any were lost/.test(html), html);

html = renderClientRevisions({ tickets: [], slug: 'acme', revisionsConfigured: false });
check('a disconnected inbox is a different message', /revision inbox is not connected/.test(html));
check('and says nothing has been missed', /Nothing has been missed/.test(html));
check('it does not claim there are no requests', !/No change requests from this client/.test(html));

html = renderClientRevisions({ tickets: [], slug: 'acme', loading: true });
check('loading is its own state', /Loading this client/.test(html));

// ---------------------------------------------------------------------------
section('W5  the card header summarises without being alarming or misleading');
let s = revisionSummary(all, 'acme');
check('it counts only this client', s.count === 2, String(s.count));
check('open work is counted', s.open === 2, String(s.open));
s = revisionSummary(stuck, 'acme');
check('stuck takes priority in the summary text', s.text === '1 stuck', s.text);
s = revisionSummary([T({ state: 'succeeded' }), T({ state: 'cancelled' })], 'acme');
check('finished work reads as done, not as outstanding', s.text === 'all done', s.text);
check('a client with nothing says "no requests"', revisionSummary([], 'acme').text === 'no requests');

// ---------------------------------------------------------------------------
section('W6  client content is escaped');
html = renderClientRevisions({ tickets: [T({ summary: '<img src=x onerror=alert(1)>' })], slug: 'acme' });
check('a hostile summary is escaped', !/<img src=x/.test(html) && /&lt;img/.test(html), html.slice(0, 200));
html = renderClientRevisions({ tickets: [T({ state: 'blocked', blockedBy: { label: '<script>bad()</script>', action: 'check-repo' } })], slug: 'acme' });
check('a hostile blocked label is escaped', !/<script>bad/.test(html));

// ---------------------------------------------------------------------------
// W7 — the recovery button has to DO something.
//
// The first version of this file rendered the buttons and wired nothing to
// them. That is worse than no button: it promises the owner a fix is one click
// away and then swallows the click. These checks drive the real delegated
// handler, so they fail if the handler is removed, if it stops acting, or if a
// new recovery action is rendered without anything behind it.
// ---------------------------------------------------------------------------
section('W7  the recovery buttons are wired to real behaviour');

const spy = () => {
  const calls = [];
  const fn = (...a) => calls.push(a);
  fn.calls = calls;
  return fn;
};
/** A button and a root, small enough to be obviously honest. */
const fakeBtn = (fix, slug = 'acme') => ({ dataset: { fix, slug }, parentElement: {} });
function fakeRoot() {
  const listeners = [];
  return {
    listeners,
    addEventListener: (type, fn) => listeners.push([type, fn]),
    click(btn) {
      let prevented = false;
      const ev = {
        target: { closest: (sel) => (sel === '[data-fix]' ? btn : null) },
        preventDefault: () => { prevented = true; },
      };
      listeners.filter(([t]) => t === 'click').forEach(([, fn]) => fn(ev));
      return { prevented };
    },
  };
}

let root = fakeRoot();
let ui = { switchPane: spy(), focus: spy(), expand: spy(), note: spy() };
check('wiring reports success', wireFixButtons(root, ui) === true);
check('exactly one delegated listener, not one per button', root.listeners.length === 1, String(root.listeners.length));

const clicked = root.click(fakeBtn('link-repo'));
check('a click on the repo fix switches to the settings pane', ui.switchPane.calls[0]?.[0] === 'settings', JSON.stringify(ui.switchPane.calls));
check('and puts the cursor in the repo field', ui.focus.calls[0]?.[0] === '#cf_repo', JSON.stringify(ui.focus.calls));
check('the owner is told what to do next', /repository/i.test(ui.note.calls[0]?.[0] || ''), ui.note.calls[0]?.[0]);
check('and that the request is not lost', /resumes by itself/.test(ui.note.calls[0]?.[0] || ''));
check('the click is not left to navigate the page', clicked.prevented);

// a click somewhere else in the pane must not do anything
ui = { switchPane: spy(), focus: spy(), expand: spy(), note: spy() };
root = fakeRoot();
wireFixButtons(root, ui);
root.click(null);
check('a click that is not on a fix button does nothing', ui.switchPane.calls.length === 0 && ui.note.calls.length === 0);

// the slug travels with the click, so the fix acts on the right client
ui = { switchPane: spy(), focus: spy(), expand: spy(), note: spy() };
root = fakeRoot();
wireFixButtons(root, ui);
root.click(fakeBtn('link-repo', 'renewity'));
check('the result names the client that was clicked', ui.note.calls[0]?.[2]?.slug === 'renewity', JSON.stringify(ui.note.calls[0]?.[2]));

// ---------------------------------------------------------------------------
section('W8  each action does the thing that actually fixes it');

let r = applyFix('enable-agent', { slug: 'acme', switchPane: () => {}, focus: () => {}, expand: () => {} });
check('turning automation on opens the automation box', r.expanded === '#agentDetail', JSON.stringify(r));
check('on the settings pane', r.pane === 'settings');

r = applyFix('reconnect-github', {});
check('a missing token is not pretended to be a UI setting', r.pane === null, JSON.stringify(r));
check('it names the exact variable', r.env === 'GITHUB_TOKEN' && /GITHUB_TOKEN/.test(r.message));
check('and where it lives', /Vercel/.test(r.message));
check('and that nothing needs re-sending', /nothing needs re-sending/i.test(r.message));

r = applyFix('add-ai-key', {});
check('the AI key names its own variable', r.env === 'ANTHROPIC_API_KEY' && /ANTHROPIC_API_KEY/.test(r.message));

r = applyFix('owner-review', {});
check('work that is not a file change claims no shortcut', r.pane === null && r.env === null, JSON.stringify(r));
check('and says why it needs a person', /outside the code/.test(r.message));

r = applyFix('fix-permissions', { switchPane: () => {}, focus: () => {} });
check('a write-permission fault says read & write explicitly', /read & write/.test(r.message));

// A host that only half-implements the callbacks must degrade, not throw.
r = applyFix('link-repo', { slug: 'acme' });
check('a host with no callbacks still returns the message instead of throwing', r.handled && r.pane === null && !!r.message);

// ---------------------------------------------------------------------------
section('W9  no renderable action can exist without a handler');
// Driven through the real classifier, so adding a recovery action in
// revision-state.js with no handler here fails this test rather than shipping
// a dead button.
const REAL_REASONS = [
  'no GitHub repo set for this site',
  'GITHUB_TOKEN not set',
  'github 404 — not found',
  'repo renamed on github and now resolves to something else',
  'repo mapping conflict — two clients linked to the same repository',
  'github 403 permission denied',
  'the agent is turned off for this site',
  'no Anthropic key',
  "can't do that by editing files — it's in a third-party dashboard",
];
const produced = [...new Set(REAL_REASONS.map((t) => classifyReason(t)?.recovery?.action).filter(Boolean))];
check('the classifier really does produce recovery actions', produced.length >= 6, JSON.stringify(produced));
for (const a of produced) {
  check(`"${a}" has a handler`, applyFix(a, {}).handled === true, JSON.stringify(FIX_HANDLED));
}
check('every button label the UI can render is one of them', FIX_HANDLED.every((a) => applyFix(a, {}).handled));

// and an action nobody has written a handler for is admitted to, not faked
r = applyFix('invent-a-new-one', {});
check('an unknown action is reported as unhandled', r.handled === false);
check('it does not claim to have fixed anything', r.pane === null && r.focused === null);
check('it still tells the owner where to look', /Automations queue/.test(r.message));
check('and that nothing has been lost', /Nothing has been lost/.test(r.message));
r = applyFix(undefined, {});
check('no action at all does not throw', r.handled === false && r.action === null);

done();
