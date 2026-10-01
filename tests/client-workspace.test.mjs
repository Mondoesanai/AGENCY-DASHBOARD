// R2.2 — a client's own work lives on that client's card.
import { check, section, done } from './world.mjs';
import { ticketsForSlug, needsOwner, renderClientRevisions, revisionSummary, STATE_LABEL } from '../public/client-workspace.js';

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

done();
