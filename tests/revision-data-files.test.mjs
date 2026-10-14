// The page's prices live in a .js file. The agent was never shown it.
//
// R24.1. A real revision died three times on Apostello. The model's own reason:
//
//   "The live price estimator on the Book Now page pulls its names/prices from
//    js/site-data.js at runtime, and that file's contents were not provided to
//    me, so I could not update the actual booking calculator's package
//    names/prices — only the static Services & Pricing page content."
//
// It was right, and it was right to refuse. Only HTML-ish files, a short config
// list, and (for revisions) linked stylesheets could reach the model. A site
// that keeps its packages, prices, services or FAQs in a .js or .json data file
// was simply unrevisable — and the quieter failure is worse than the refusal:
// editing markup that the page overwrites on load, and reporting success.
//
// These checks drive a REAL cycle through `runAgentCycle` and read the prompt
// the model actually received, rather than asserting on the selection logic.

import { W, addRepo, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { saveSiteConfig, listSites } from '../lib/registry.js';
import { runAgentCycle } from '../lib/agent.js';
import { addRevisionTodo } from '../lib/todos.js';

// A site shaped like the one that failed: the visible page is a shell, and the
// packages and prices it renders come from a data file at runtime.
const BOOK = `<!doctype html><html><head><title>Book</title>
<link rel="stylesheet" href="css/style.css"></head><body>
<h1>Book Now</h1><div id="pkgCards"></div><div id="addonList"></div>
<script src="js/site-data.js"></script><script src="js/book.js"></script>
</body></html>`;

const SITE_DATA = `export const PACKAGES = [
  { id: 'good', name: 'Good', price: 150 },
  { id: 'better', name: 'Better', price: 200 },
  { id: 'best', name: 'Best', price: 250 },
];
export const ADDONS = [{ id: 'interior', name: 'Interior', price: 40 }];`;

const INDEX = `<!doctype html><html><head><title>Home</title></head><body><h1>Home</h1>
<p>We detail cars and boats across the county, and we come to you.</p></body></html>`;

addRepo('dataco/site', {
  'index.html': INDEX,
  'book.html': BOOK,
  'js/site-data.js': SITE_DATA,
  'js/book.js': 'import { PACKAGES } from "./site-data.js"; // renders the cards',
  'js/vendor.min.js': 'var x=1;'.repeat(200),
  'css/style.css': 'body{margin:0}',
  'package.json': '{"name":"site"}',
  'package-lock.json': '{"lockfileVersion":3}',
  'node_modules/dep/index.js': 'module.exports = 1;',
  'sitemap.xml': '<urlset/>',
  'robots.txt': 'User-agent: *',
});
W.pages['https://dataco.test'] = INDEX;

await saveSiteConfig('dataco', {
  url: 'https://dataco.test', name: 'Data Co', repo: 'dataco/site',
  email: 'owner@dataco.test', client: 'Dana',
});
const site = (await listSites()).find((s) => s.slug === 'dataco');
await store.set('conv:tagged:dataco', '1');
await store.set('tracker:installed:dataco', '1');
// Keywords already set, or the FIRST model call is the keyword step, not the plan.
await store.set('agent:keywords:dataco', JSON.stringify(['mobile detailing prices', 'boat detailing near me']));

const REQUEST = 'Please restructure the service packages from the Good/Better/Best system to three '
  + 'simplified options with optional wax add-ons, and add a pricing disclaimer.';

const TICKET = `tkt_data_${Date.now()}`;
await store.set(`revisions:attach:${TICKET}`, REQUEST, { ex: 3600 }).catch(() => {});
await addRevisionTodo('dataco', { title: REQUEST, detail: 'Requested by the client', ticketId: TICKET });

// Capture the prompt without letting the cycle ship anything.
let prompt = '';
W.anthropic.push((req) => {
  prompt = req.messages[0].content.map((c) => c.text || '').join('\n');
  return 'NOOP: capturing the prompt only';
});
await runAgentCycle(site, { manual: false }).catch(() => {});

// ---------------------------------------------------------------------------
section('D1  the data file the page actually reads from is included');
check('a prompt was captured', prompt.length > 200, `${prompt.length} chars`);
check('the booking page is shown', /book\.html/.test(prompt), 'the page named in the request');
check('AND js/site-data.js is shown', /site-data\.js/.test(prompt),
  'this is the file whose absence blocked the real ticket three times');
check('its actual contents are there, not just the filename',
  /Good/.test(prompt) && /PACKAGES/.test(prompt),
  'a filename without contents is what the model already had, and refused on');

section('D1b  because the page references it');
check('the page tag that points at it is visible',
  /<script[^>]+src=["']js\/site-data\.js/.test(BOOK),
  'the selection rule is "referenced by a page we are showing", same as stylesheets');

// ---------------------------------------------------------------------------
section('D2  and the things that are NOT content stay out');
check('no lockfile', !/lockfileVersion/.test(prompt), 'a lockfile is not content');
check('no node_modules', !/node_modules/.test(prompt), 'a dependency tree would swallow the budget whole');
check('no minified bundle', !/vendor\.min\.js/.test(prompt),
  'a minified vendor bundle is not something a client asked to change');

section('D2b  the stylesheet rule still works');
check('the linked stylesheet is still included', /style\.css/.test(prompt),
  'the earlier fix for colour/style revisions must survive this one');

// ---------------------------------------------------------------------------
section('D3  NEGATIVE CONTROL: discretionary SEO work does NOT pull data files');
// Without this, the fix is "send everything, always" — which is what the
// sampling budget exists to prevent, and the SEO agent runs far more often than
// revisions do. A SECOND site is used rather than a second cycle on the first:
// attempts on one site are 30 minutes apart (ATTEMPT_GAP_MS), so a second cycle
// here would make no model call at all and "prove" nothing.
addRepo('seoco/site', {
  'index.html': INDEX,
  'book.html': BOOK,
  'js/site-data.js': SITE_DATA,
  'css/style.css': 'body{margin:0}',
});
W.pages['https://seoco.test'] = INDEX;
await saveSiteConfig('seoco', {
  url: 'https://seoco.test', name: 'Seo Co', repo: 'seoco/site',
  email: 'owner@seoco.test', client: 'Sam',
});
const seoSite = (await listSites()).find((s) => s.slug === 'seoco');
await store.set('conv:tagged:seoco', '1');
await store.set('tracker:installed:seoco', '1');
await store.set('agent:keywords:seoco', JSON.stringify(['mobile detailing prices', 'boat detailing near me']));

let seoPrompt = '';
W.anthropic.push((req) => {
  seoPrompt = req.messages[0].content.map((c) => c.text || '').join('\n');
  return 'NOOP: seo capture';
});
await runAgentCycle(seoSite, { manual: false }).catch(() => {});
check('a cycle with no client revision still ran', seoPrompt.length > 200, `${seoPrompt.length} chars`);
check('it saw the same pages', /book.html/.test(seoPrompt), 'so the only difference is the data file');
check('and it did NOT pull the data file',
  !/PACKAGES/.test(seoPrompt),
  'only a client revision gets the wider sample; discretionary work keeps the tight budget');

done();
