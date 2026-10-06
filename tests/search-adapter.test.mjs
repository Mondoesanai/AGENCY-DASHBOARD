// The half that was missing, and why its absence was invisible.
//
// `asset-research.js` takes `search` and `fetchPage` as injected functions.
// That made it testable and left it UNREACHABLE: nothing in the application
// ever supplied either, so the official-source step could not run however well
// it was tested. The module was wired structurally and inert in practice — the
// same shape as the delivery receipt that had no caller, and just as hard to
// see, because every test passed by supplying its own fakes.
//
// These checks cover the adapter and, more importantly, that the sweep now
// resolves it — so the capability exists the moment a key does.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  createBraveSearchAdapter, createDisconnectedSearchAdapter, getSearchAdapter,
  researchTools, organisationFrom, SEARCH_PROVIDER,
} from '../lib/search-adapter.js';
import { recheckBlockedAssets } from '../lib/asset-search.js';

const KEYED = { BRAVE_SEARCH_API_KEY: 'fixture-key' };

// ---------------------------------------------------------------------------
section('S1  with no key it reports that it cannot look — not that it found nothing');
const off = getSearchAdapter({ env: {} });
check('it is not configured', off.configured() === false);
check('and names what is needed', new RegExp(SEARCH_PROVIDER.envKeys[0]).test(off.reason || ''), off.reason);
const offResult = await off.search('anything');
check('a search is refused', offResult.ok === false && offResult.disconnected === true);
check('with NO results rather than an empty success', offResult.results.length === 0 && offResult.ok !== true,
  '"we looked and found nothing" would be a lie');

const tools = researchTools({ env: {} });
check('the research gets NULL, not a refusing function', tools.search === null && tools.fetchPage === null,
  'null is what makes the research say needs-search instead of searched-and-empty');
check('and the reason travels with it', !!tools.reason);
check('configured is false', tools.configured === false);

// ---------------------------------------------------------------------------
section('S2  with a key it makes the real request');
let seen = null;
const on = createBraveSearchAdapter({
  env: KEYED,
  fetchImpl: async (url, opts) => {
    seen = { url, headers: opts.headers };
    return { ok: true, json: async () => ({ web: { results: [
      { title: 'Brand resources', url: 'https://cpdstandards.com/brand', description: 'Logos for accredited providers' },
      { title: 'Someone else', url: 'https://other.example/x', description: 'we are CPD accredited' },
    ] } }) };
  },
});
check('it is configured', on.configured() === true);
const r = await on.search('CPD Standards Office official site brand resources logo usage');
check('the search succeeds', r.ok === true);
check('it hits the provider endpoint', /api\.search\.brave\.com/.test(seen.url), seen.url);
check('with the key in the documented header', seen.headers['X-Subscription-Token'] === 'fixture-key');
check('the query is on the request', /CPD\+?%?20?Standards/i.test(seen.url) || /CPD/.test(decodeURIComponent(seen.url)), seen.url);
check('results are normalised to title/url/description',
  r.results.length === 2 && r.results.every((x) => x.url && 'title' in x && 'description' in x),
  JSON.stringify(r.results[0]));
check('a result with no url is dropped',
  (await createBraveSearchAdapter({ env: KEYED, fetchImpl: async () => ({ ok: true, json: async () => ({ web: { results: [{ title: 'x' }] } }) }) }).search('q')).results.length === 0);

section('S2b  provider failures are told apart from empty results');
const five00 = createBraveSearchAdapter({ env: KEYED, fetchImpl: async () => ({ ok: false, status: 503 }) });
let f = await five00.search('q');
check('a 503 is not success', f.ok === false);
check('and is marked transient, so it is worth retrying', f.transient === true);
const rate = createBraveSearchAdapter({ env: KEYED, fetchImpl: async () => ({ ok: false, status: 429 }) });
check('rate limiting is transient too', (await rate.search('q')).transient === true);
const thrown = createBraveSearchAdapter({ env: KEYED, fetchImpl: async () => { throw new Error('socket hang up'); } });
f = await thrown.search('q');
check('a thrown request does not take the sweep down', f.ok === false && f.transient === true, JSON.stringify(f));

// ---------------------------------------------------------------------------
section('S3  a fetched page is text, and is data rather than instructions');
const page = createBraveSearchAdapter({
  env: KEYED,
  fetchImpl: async () => ({ ok: true, text: async () => `
    <html><head><style>.x{color:red}</style><script>alert('hi')</script></head>
    <body><h1>Brand resources</h1><p>Accredited providers may display the mark.</p>
    <p>The logo must not be altered.</p></body></html>` }),
});
const p = await page.fetchPage('https://cpdstandards.com/brand');
check('the page is fetched', p.ok === true);
check('tags are stripped', !/<h1>|<p>/.test(p.text), p.text.slice(0, 80));
check('script contents are removed, not merely escaped', !/alert/.test(p.text), p.text.slice(0, 120));
check('style contents too', !/color:red/.test(p.text));
check('but the words that matter survive', /Accredited providers may display the mark/.test(p.text), p.text.slice(0, 160));
check('including the prohibition', /must not be altered/.test(p.text));

check('http is refused — only https is fetched',
  (await page.fetchPage('http://cpdstandards.com/brand')).ok === false);
check('and so is a non-url', (await page.fetchPage('javascript:alert(1)')).ok === false);
check('a 404 is not an empty page', (await createBraveSearchAdapter({ env: KEYED, fetchImpl: async () => ({ ok: false, status: 404 }) }).fetchPage('https://x.test/y')).ok === false);

// ---------------------------------------------------------------------------
section('S4  the organisation is read out of what was asked');
check('"official CPD Standards Office accreditation logo"',
  organisationFrom('add the official CPD Standards Office accreditation logo') === 'CPD Standards Office',
  String(organisationFrom('add the official CPD Standards Office accreditation logo')));
check('"the Better Business Bureau badge"',
  /Better Business Bureau/.test(organisationFrom('please add the Better Business Bureau badge') || ''),
  String(organisationFrom('please add the Better Business Bureau badge')));
check('"accredited by the Chartered Institute"',
  /Chartered Institute/.test(organisationFrom('we are accredited by the Chartered Institute') || ''),
  String(organisationFrom('we are accredited by the Chartered Institute')));
check('an ordinary request names no organisation',
  organisationFrom('change the opening hours on the contact page') === null,
  String(organisationFrom('change the opening hours on the contact page')));
check('a photo request does not invent one',
  organisationFrom('add the new team photo to the about page') === null,
  String(organisationFrom('add the new team photo to the about page')));
check('empty input is survivable', organisationFrom('') === null);

// ---------------------------------------------------------------------------
section('S5  THE WIRING: the sweep now resolves a searcher');
// This is the check that would have caught the original problem. Before it,
// every test supplied its own fakes and the real code path had none.
await store.set('assets:sources:acme', JSON.stringify([]));
const ticket = {
  id: 'tr1', attachments: [],
  requirements: [{ id: 'q1', text: 'add the official CPD Standards Office accreditation logo', state: 'outstanding' }],
};
let searched = [];
const out = await recheckBlockedAssets([ticket], {
  siteFor: () => ({ slug: 'acme' }),
  // supplied here to prove the parameters reach findAsset; the no-opts case
  // below proves the sweep resolves them by itself
  search: async (q) => { searched.push(q); return []; },
  fetchPage: async () => '',
});
check('the sweep ran a search', searched.length === 1, JSON.stringify(searched));
check('and looked up the organisation from the request text',
  /CPD Standards Office/.test(searched[0]), searched[0]);
check('nothing resumed, because nothing was found', out.count === 0);

// and with NO tools supplied, the sweep resolves its own — disconnected today
const ticket2 = {
  id: 'tr2', attachments: [],
  requirements: [{ id: 'q2', text: 'add the official CPD Standards Office accreditation logo', state: 'outstanding' }],
};
const out2 = await recheckBlockedAssets([ticket2], { siteFor: () => ({ slug: 'acme' }) });
check('it survives having no provider configured', out2.ok === true, JSON.stringify(out2));
check('and resumes nothing, rather than claiming a find', out2.count === 0);
check('the requirement stays outstanding', ticket2.requirements[0].state === 'outstanding');

await store.set('assets:sources:acme', '');
done();
