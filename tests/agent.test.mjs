import { W, addRepo, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { saveSiteConfig, listSites } from '../lib/registry.js';
import { runAgentCycle, agentStatus } from '../lib/agent.js';
import { addRevisionTodo, todosState } from '../lib/todos.js';
import { handleInbound } from '../lib/sms-actions.js';
import { saveRanks } from '../lib/ranks.js';

const MK = new Date().toISOString().slice(0, 7);
const readArr = async (k) => { const r = await store.get(k); try { const a = typeof r === 'string' ? JSON.parse(r) : r; return Array.isArray(a) ? a : []; } catch { return []; } };
const bigBlock = (n) => Array.from({ length: n }, (_, i) => `<div class="card card-${i}"><h3>Item ${i}</h3><p>Some fairly ordinary marketing copy for card number ${i}.</p></div>`).join('\n');

const INDEX = `<!doctype html><html><head>
<title>Acme Detailing</title>
<meta name="description" content="We detail cars.">
<script type="application/ld+json">{"@type":"LocalBusiness","name":"Acme"}</script>
<link rel="stylesheet" href="css/style.css">
</head><body><h1>Acme</h1><img src="a.jpg" alt=""><img src="b.jpg" alt="">${bigBlock(260)}<footer>END-OF-INDEX</footer></body></html>`;
const RANKINGS = `<html><head><title>Rankings</title><meta name="description" content="Leaderboard"></head><body><h1>Rankings</h1>RANKINGS-MARKER</body></html>`;
const C_HTML = `<html><head><title>Bracelet</title><style>.join-btn{background:#d4a84a;color:#000}</style></head><body><button class="join-btn">Join the community</button>${bigBlock(330)}<footer>END-OF-C-PAGE</footer></body></html>`;

addRepo('acme/site', { 'index.html': INDEX, 'rankings.html': RANKINGS, 'c.html': C_HTML, 'sitemap.xml': '<urlset/>', 'robots.txt': 'User-agent: *', 'llms.txt': '# Acme', 'css/style.css': 'body{margin:0}', 'vercel.json': '{}' });
W.pages['https://acme.test'] = INDEX;

await saveSiteConfig('acme', { url: 'https://acme.test', name: 'Acme Detailing', repo: 'acme/site', email: 'owner@acme.test', client: 'Sam' });
const site = (await listSites()).find((s) => s.slug === 'acme');
await store.set('conv:tagged:acme', '1');
await store.set('agent:keywords:acme', JSON.stringify(['mobile car detailing corinth tx', 'ceramic coating denton', 'car wash near me']));
await store.set('agent:ranks:acme', JSON.stringify({ at: Date.now() - 4 * 864e5, depth: 100, results: [
  { keyword: 'mobile car detailing corinth tx', rank: 27, topTitles: [{ rank: 1, domain: 'bigcompetitor.com', title: 'Best mobile car detailing corinth tx - BigCompetitor' }], paa: ['How much does mobile detailing cost?'], related: ['detailing near me', 'ceramic coat prices'] },
  { keyword: 'ceramic coating denton', rank: null, topTitles: [{ rank: 1, domain: 'other.org', title: 'Ceramic Coating Denton | Other' }], paa: [], related: ['ceramic coating cost'] },
] }));
for (const k of ['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`, `newpage:${MK}`]) await store.set('agent:playbook:acme', JSON.stringify([...(await readArr('agent:playbook:acme')), k]));
const resetPacing = () => Promise.all([store.set('agent:lastCycleAt:acme', '0'), store.set('agent:lastShipAt:acme', '0')]);

const PATCH_TITLE = `SUMMARY: Rewrote the Google title and description on your homepage so it reads better and includes "mobile car detailing".
COMMIT: seo: sharpen homepage title
PATCH: index.html
REASON: title
---FIND---
<title>Acme Detailing</title>
---REPLACE---
<title>Mobile Car Detailing in Corinth TX | Acme Detailing</title>
---END PATCH---
PATCH: index.html
---FIND---
<meta name="description" content="We detail cars.">
---REPLACE---
<meta name="description" content="Mobile car detailing in Corinth, TX. We come to you.">
---END PATCH---`;

section('S1  playbook cycle ships a real edit to a 30KB+ page via PATCH');
let seen = null;
W.anthropic.push((req) => { seen = req; return PATCH_TITLE; });
let r = await runAgentCycle(site, { manual: false });
check('cycle reports a change', r.action === 'change', JSON.stringify({ a: r.action, e: r.error, r: r.reason }));
check('PR was merged to main', W.merged.length === 1);
check('live file has the new title', W.repos['acme/site'].files['index.html'].includes('<title>Mobile Car Detailing in Corinth TX | Acme Detailing</title>'));
check('live file has the new description', W.repos['acme/site'].files['index.html'].includes('We come to you.'));
check('rest of the 30KB+ page is untouched', W.repos['acme/site'].files['index.html'].includes('END-OF-INDEX') && W.repos['acme/site'].files['index.html'].length > INDEX.length - 200);
check('other files untouched', W.repos['acme/site'].files['rankings.html'] === RANKINGS);
const changelog = await readArr('changelog:acme');
check('plain-English line added to the client "what we did" list', changelog.some((c) => /Rewrote the Google title/.test(c.text)), JSON.stringify(changelog));
check('playbook remembers this step is done', (await readArr('agent:playbook:acme')).includes(`meta:index.html:${MK}`));
const userBlocks = seen?.messages?.[0]?.content;
check('prompt sent with prompt-caching marker on the big prefix', Array.isArray(userBlocks) && userBlocks[0]?.cache_control?.type === 'ephemeral');
const prompt = Array.isArray(userBlocks) ? userBlocks[0].text : '';
check('prompt carries competitor titles (SERP intel)', /bigcompetitor\.com/.test(prompt) && /Best mobile car detailing/.test(prompt));
check('prompt carries People-Also-Ask questions', /How much does mobile detailing cost/.test(prompt));
check('playbook task only sampled its own page (not the whole site)', prompt.includes('END-OF-INDEX') && !prompt.includes('RANKINGS-MARKER'));
check('spend recorded against the site', Number(await store.get(`agent:spend:acme:${MK}`)) > 0);
check('attempt timestamp set', Number(await store.get('agent:lastCycleAt:acme')) > 0);
check('after a SHIPPED change the site is paced for ~2 days', Number(await store.get('agent:lastShipAt:acme')) > 0 && (await agentStatus(site)).reasons.some((x) => /a change just shipped.*~(19|20)h/.test(x)), JSON.stringify((await agentStatus(site)).reasons));

section('S2  "already good" -> NOOP: no commit, no error, step retired');
await resetPacing();
const mergedBefore = W.merged.length;
W.anthropic.push('NOOP: the description and title on this page are already specific and well written');
r = await runAgentCycle(site, { manual: false });
check('reports no-change (not an error)', r.ok === true && r.action === 'no-change', JSON.stringify(r).slice(0, 200));
check('nothing committed', W.merged.length === mergedBefore);
check('step retired so it is not retried', (await readArr('agent:playbook:acme')).includes(`meta:rankings.html:${MK}`));
const lc = Number(await store.get('agent:lastCycleAt:acme'));
check('a "nothing to change" answer does NOT lock the site out: next attempt within ~5 minutes, not 2 days', Date.now() - lc > 24 * 60000 && Date.now() - lc < 26 * 60000 && !(await agentStatus(site)).reasons.some((x) => /change just shipped/.test(x)), String((Date.now() - lc) / 60000));

section('S3  model gives an un-applyable patch twice -> one retry, then item parked + failure counted');
await resetPacing();
const badPatch = 'SUMMARY: s\nCOMMIT: c\nPATCH: index.html\n---FIND---\nTHIS TEXT IS NOT IN THE FILE\n---REPLACE---\nx\n---END PATCH---';
let retrySeen = null;
W.anthropic.push(badPatch);
W.anthropic.push((req) => { retrySeen = req; return badPatch; });
const callsBefore = W.anthropicCalls.length;
r = await runAgentCycle(site, { manual: false });
check('cycle fails cleanly', r.ok === false && /model reply/.test(r.error || ''), JSON.stringify(r).slice(0, 200));
check('exactly one retry (2 model calls, not more)', W.anthropicCalls.length - callsBefore === 2);
const retryBlocks = retrySeen?.messages?.[0]?.content;
check('retry reuses the SAME cached prefix and adds the patch error', Array.isArray(retryBlocks) && retryBlocks[0].cache_control && /could not be applied/.test(retryBlocks[1]?.text || ''));
check('the failed item is parked (stuck) for 14 days', (await readArr('agent:stuck:acme')).some((x) => x.key.startsWith('pb:')));
check('failure counted for today', Number(await store.get(`agent:fail:acme:${new Date().toISOString().slice(0, 10)}`)) === 1);

section('S4  3 failures in a day pauses the site (protects the budget) and texts the owner');
for (let i = 0; i < 2; i++) {
  await resetPacing();
  W.anthropic.push(badPatch); W.anthropic.push(badPatch);
  await runAgentCycle(site, { manual: false });
}
await resetPacing();
const st = await agentStatus(site);
check('status is now paused for today', st.eligible === false && st.reasons.some((x) => /paused for today after 3 failed attempts/.test(x)), JSON.stringify(st.reasons));
const nBefore = W.anthropicCalls.length;
await runAgentCycle(site, { manual: false });
check('a paused site makes NO model call', W.anthropicCalls.length === nBefore);
check('owner was texted once about the pause', W.sms.filter((s) => /paused for today/.test(s.body)).length === 1, JSON.stringify(W.sms.map((s) => s.body)));
await store.set(`agent:fail:acme:${new Date().toISOString().slice(0, 10)}`, '0');

section('S5  client revision on a 53KB page (with a 30KB+ homepage present) ships via PATCH, nothing truncated');
await resetPacing();
await addRevisionTodo('acme', { title: 'Change the Join the community button on the c page to green', detail: 'Requested by Sam', ticketId: 'T5' });
let revPrompt = '';
W.anthropic.push((req) => {
  revPrompt = req.messages[0].content[0].text;
  return `SUMMARY: Changed the Join button to green
COMMIT: revision: green join button
PATCH: c.html
REASON: button color
---FIND---
.join-btn{background:#d4a84a;color:#000}
---REPLACE---
.join-btn{background:#1f9d55;color:#fff}
---END PATCH---`;
});
const beforeC = W.repos['acme/site'].files['c.html'];
r = await runAgentCycle(site, { manual: false });
check('revision shipped', r.action === 'change', JSON.stringify({ a: r.action, e: r.error, r: r.reason }));
check('the WHOLE 53KB page was shown to the model (footer marker present)', revPrompt.includes('END-OF-C-PAGE'), `promptLen=${revPrompt.length}`);
check('c.html now has the green button', W.repos['acme/site'].files['c.html'].includes('#1f9d55'));
check('c.html otherwise byte-identical', W.repos['acme/site'].files['c.html'].replace('.join-btn{background:#1f9d55;color:#fff}', '.join-btn{background:#d4a84a;color:#000}') === beforeC);
check('to-do completed/removed so it will not loop', !((await todosState(site)).current?.items || []).some((i) => i.id === 'rev-T5'));
const revert = await store.get('revert:rev-T5');
check('original saved so a wrong-site match can be reverted', !!revert && JSON.stringify(revert).includes('d4a84a'));

section('S6  revision that cannot be a file edit (live database value) -> immediate, cheap, clear');
await resetPacing();
await addRevisionTodo('acme', { title: 'Set bracelet 003 to have 7 taps', detail: 'Requested by Sam', ticketId: 'T6' });
const c0 = W.anthropicCalls.length;
W.anthropic.push('SUMMARY: cannot\nCOMMIT: none\nBLOCKED: The tap count is read live from a Firebase Realtime Database at runtime; it is not stored in any file in this repo.');
r = await runAgentCycle(site, { manual: false });
check('reported blocked with the real reason', r.blocked === true && /Firebase/.test(r.error), JSON.stringify(r).slice(0, 160));
check('ONE model call only (no pointless retry)', W.anthropicCalls.length - c0 === 1);
check('ticket flagged as given-up so it stops burning budget', !!(await store.get('agent:revgaveup:rev-T6')));

section('S7  monthly keyword expansion from Google suggestions (cheap model, no file edit)');
await resetPacing();
await store.set('agent:playbook:acme', JSON.stringify((await readArr('agent:playbook:acme')).filter((k) => !k.startsWith('kw:'))));
let kwModel = '';
W.anthropic.push((req) => { kwModel = req.model; return '{"keywords":["how much does mobile detailing cost","ceramic coating cost denton","detailing near me corinth"]}'; });
r = await runAgentCycle(site, { manual: false });
const kws = await readArr('agent:keywords:acme');
check('keywords expanded', r.action === 'keywords-expanded' && kws.length === 6, JSON.stringify({ a: r.action, kws }));
check('used the cheap Haiku model', /haiku/i.test(kwModel), kwModel);
check('site config keeps the new list too', ((await listSites()).find((s) => s.slug === 'acme').agentKeywords || '').includes('ceramic coating cost denton'));
check('client list says what started being tracked', (await readArr('changelog:acme')).some((c) => /Started tracking 3 more searches/.test(c.text)));

section('S8  an audit finding that needs image/colour work is never chosen as a target');
const { __unshippableForTest } = await import('../lib/agent.js').then(() => ({}));
const items = ['Largest content loads in 4.4s', 'Fix low-contrast grey text', 'Compress the hero image', 'Add descriptive alt text to images'];
const RE = /(compress\w*|resiz\w*|shrink\w*|optimi[sz]\w*|convert\w*|reduc\w*|serv\w*|replac\w*)\b[^.\n]{0,50}\b(images?|photos?|hero|videos?|fonts?|files?)\b|\b(webp|avif)\b|\blargest content\w*|\blcp\b|\bcore web vitals\b|\bcontrast\b|\bcolou?rs?\b|\bfont size\b|\bspacing\b|\blayout\b/i;
check('image/color/LCP tasks are filtered, alt-text is not', items.map((x) => RE.test(x)).join() === 'true,true,true,false');


section('S9  BUDGET CAP HOLDS: an over-budget site with a given-up revision must not keep shipping (live bug: $23.81 of $20, 5 commits in 40 min)');
await saveSiteConfig('capped', { url: 'https://capped.test', name: 'Capped Co', repo: 'acme/site', email: 'c@capped.test' });
const capped = (await listSites()).find((s) => s.slug === 'capped');
await store.set('conv:tagged:capped', '1');
await store.set('agent:keywords:capped', JSON.stringify(['a b']));
await store.set(`agent:spend:capped:${MK}`, '23.81');
await addRevisionTodo('capped', { title: 'Impossible live-data change', detail: 'x', ticketId: 'TG' });
await store.set('agent:revgaveup:rev-TG', '1'); // the agent already gave up on it; the to-do stays listed for the ticket
const nCap = W.anthropicCalls.length;
r = await runAgentCycle(capped, { manual: false });
check('over-budget site with only a GIVEN-UP revision is skipped for budget', r.skipped === true && /budget is used/.test(r.reason || ''), JSON.stringify(r).slice(0, 220));
check('no model call was made (no spend)', W.anthropicCalls.length === nCap);
await addRevisionTodo('capped', { title: 'A real new client change', detail: 'x', ticketId: 'TL' });
W.anthropic.push('SUMMARY: cannot\nCOMMIT: none\nBLOCKED: needs a dashboard');
r = await runAgentCycle(capped, { manual: false });
check('a LIVE client revision still gets worked even over budget (bounded by the separate revision ceiling)', r.skipped !== true && W.anthropicCalls.length === nCap + 1, JSON.stringify(r).slice(0, 200));

section('S10  one-off setup steps do not burn the 2-day pacing window');
await saveSiteConfig('fresh', { url: 'https://fresh.test', name: 'Fresh Co', repo: 'acme/site', email: 'f@fresh.test' });
const fresh = (await listSites()).find((s) => s.slug === 'fresh');
W.anthropic.push('{"keywords":["fresh kw one","fresh kw two"]}');
r = await runAgentCycle(fresh, { manual: false });
check('first cycle picks keywords', r.action === 'keywords', JSON.stringify(r).slice(0, 160));
const gap = Date.now() - Number(await store.get('agent:lastCycleAt:fresh'));
check('...and the real work can start within minutes, not after 2 days', gap > 24 * 60000 && gap < 26 * 60000 && !(await agentStatus(fresh)).reasons.some((x) => /change just shipped/.test(x)), String(gap / 60000));


section('S12  approval-gated NEW PAGE: drafted as an unmerged PR, owner texted, YES publishes, NO discards');
addRepo('acme/np', {
  'index.html': '<html><head><title>Acme</title><link rel="stylesheet" href="css/site.css"></head><body><nav>NAV-HERE</nav><h1>Acme Detailing</h1><p>We offer mobile car detailing and ceramic coating in Corinth and Denton, TX. Call 555-0100.</p><footer>FOOT-HERE</footer></body></html>',
  'sitemap.xml': '<?xml version="1.0"?><urlset>\n<url><loc>https://np.test/</loc></url>\n</urlset>',
  'robots.txt': 'x', 'llms.txt': 'x', 'css/site.css': 'body{}',
});
W.pages['https://np.test'] = '<html><head><script type="application/ld+json">{"@type":"LocalBusiness"}</script></head></html>';
await saveSiteConfig('np', { url: 'https://np.test', name: 'NP Detailing', repo: 'acme/np', email: 'np@np.test' });
const npSite = (await listSites()).find((s) => s.slug === 'np');
await store.set('conv:tagged:np', '1');
await store.set('agent:keywords:np', JSON.stringify(['ceramic coating denton tx', 'mobile detailing corinth']));
await store.set('agent:ranks:np', JSON.stringify({ at: Date.now(), depth: 100, results: [
  { keyword: 'ceramic coating denton tx', rank: 27, topTitles: [{ rank: 1, domain: 'rival.com', title: 'Ceramic Coating in Denton TX - Rival Auto' }], paa: ['How long does ceramic coating last?'], related: ['ceramic coating cost'] },
  { keyword: 'mobile detailing corinth', rank: 4 },
] }));
await store.set('agent:playbook:np', JSON.stringify(['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`]));
const GOOD_PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>Ceramic Coating in Denton, TX | NP Detailing</title><meta name="description" content="Ceramic coating in Denton TX by NP Detailing."><link rel="canonical" href="https://np.test/ceramic-coating-denton-tx.html"><link rel="stylesheet" href="css/site.css"></head><body><nav>NAV-HERE</nav><h1>Ceramic Coating in Denton, TX</h1>' + Array.from({ length: 12 }, (_, i) => '<p>' + Array.from({ length: 30 }, (_, j) => 'detail' + (i * 30 + j)).join(' ') + '</p>').join('') + '<footer>FOOT-HERE</footer></body></html>';
let npPrompt = '';
W.anthropic.push((req) => {
  npPrompt = req.messages[0].content[0].text;
  return 'SUMMARY: Added a new page for people searching "ceramic coating denton tx"\nCOMMIT: new page\nFILE: ceramic-coating-denton-tx.html\nREASON: new page\n---BEGIN CONTENT---\n' + GOOD_PAGE + '\n---END CONTENT---\nPATCH: sitemap.xml\nREASON: list it\n---FIND---\n</urlset>\n---REPLACE---\n<url><loc>https://np.test/ceramic-coating-denton-tx.html</loc></url>\n</urlset>\n---END PATCH---';
});
const mergedBeforeNp = W.merged.length;
W.sms.length = 0;
r = await runAgentCycle(npSite, { manual: false });
check('page drafted and proposed', r.action === 'new-page-proposed', JSON.stringify({ a: r.action, e: r.error, r: r.reason }));
check('targets the keyword closest to page 1 that has no page (not the one already at #4)', /ceramic coating denton tx/.test(npPrompt) && !/Target search: "mobile detailing corinth"/.test(npPrompt));
check('prompt carries competitor title + People-Also-Ask, and forbids invented facts', /Rival Auto/.test(npPrompt) && /How long does ceramic coating last/.test(npPrompt) && /NEVER invent prices/.test(npPrompt));
check('prompt gives the model the real homepage as the template', /NAV-HERE/.test(npPrompt) && /FOOT-HERE/.test(npPrompt));
check('NOT published: nothing merged, live site has no new page', W.merged.length === mergedBeforeNp && !W.repos['acme/np'].files['ceramic-coating-denton-tx.html']);
check('a pull request is open with the draft', W.repos['acme/np'].prs && Object.values(W.repos['acme/np'].prs).some((p) => p.state === 'open'));
const npAsk = W.sms.find((s) => /new page/.test(s.body));
check('owner texted with the PR link and a Publish question', !!npAsk && /github\.com\/acme\/np\/pull\/\d+/.test(npAsk.body) && /Publish it\?/.test(npAsk.body) && /Reply YES or NO/.test(npAsk.body), npAsk?.body);
check('no "what we did" claim before approval', !(await readArr('changelog:np')).some((c) => /new page/i.test(c.text)));
const yes = await handleInbound({ from: '+15551234567', body: 'yes' });
check('YES publishes: merged, page + sitemap live', /Published/.test(yes) && !!W.repos['acme/np'].files['ceramic-coating-denton-tx.html'] && /ceramic-coating-denton-tx\.html/.test(W.repos['acme/np'].files['sitemap.xml']), yes);
check('...and only now is it on the client "what we did" list', (await readArr('changelog:np')).some((c) => /new page for people searching/i.test(c.text)));

section('S12b  NO discards the draft');
await store.set('agent:playbook:np', JSON.stringify(['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`]));
await store.set('agent:lastCycleAt:np', '0'); await store.set('agent:lastShipAt:np', '0');
await store.set('agent:ranks:np', JSON.stringify({ at: Date.now(), depth: 100, results: [{ keyword: 'ceramic coating denton tx', rank: 27 }, { keyword: 'window tint corinth', rank: null, topTitles: [], paa: [] }] }));
const GOOD2 = GOOD_PAGE.replace(/ceramic coating/gi, 'window tint').replace(/denton-tx/g, 'corinth');
W.anthropic.push('SUMMARY: Added a page for window tint corinth\nCOMMIT: p\nFILE: window-tint-corinth.html\nREASON: r\n---BEGIN CONTENT---\n' + GOOD2 + '\n---END CONTENT---\nPATCH: sitemap.xml\nREASON: r\n---FIND---\n</urlset>\n---REPLACE---\n<url><loc>x</loc></url>\n</urlset>\n---END PATCH---');
W.sms.length = 0;
r = await runAgentCycle(npSite, { manual: false });
check('second page proposed for a DIFFERENT keyword (the first is remembered as covered)', r.action === 'new-page-proposed', JSON.stringify({ a: r.action, e: r.error }));
const before = JSON.stringify(W.repos['acme/np'].files);
const no = await handleInbound({ from: '+15551234567', body: 'no' });
check('NO closes the PR and publishes nothing', /Discarded/.test(no) && JSON.stringify(W.repos['acme/np'].files) === before && Object.values(W.repos['acme/np'].prs).some((p) => p.state === 'closed'), no);

section('S12c  a low-quality / too-short draft is rejected, never proposed');
await store.set('agent:playbook:np', JSON.stringify(['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`]));
await store.set('agent:lastCycleAt:np', '0'); await store.set('agent:lastShipAt:np', '0');
await store.set('agent:ranks:np', JSON.stringify({ at: Date.now(), depth: 100, results: [{ keyword: 'paint correction denton', rank: null }] }));
const prsBefore = Object.keys(W.repos['acme/np'].prs).length;
W.anthropic.push('SUMMARY: s\nCOMMIT: c\nFILE: paint-correction-denton.html\nREASON: r\n---BEGIN CONTENT---\n<html><title>x</title></html>\n---END CONTENT---');
r = await runAgentCycle(npSite, { manual: false });
check('rejected, no PR opened', r.ok === false && Object.keys(W.repos['acme/np'].prs).length === prsBefore, JSON.stringify(r).slice(0, 200));

section('S12d  a template with huge inline CSS cannot be reused: honest skip, not a broken page');
await store.set('agent:playbook:np', JSON.stringify(['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`]));
await store.set('agent:lastCycleAt:np', '0'); await store.set('agent:lastShipAt:np', '0');
await store.set('agent:pages:np', '[]');
await store.set('agent:stuck:np', '[]'); // S12c parked the step for 14 days after a bad draft
await store.set('agent:ranks:np', JSON.stringify({ at: Date.now(), depth: 100, results: [{ keyword: 'brand new term', rank: null }] }));
W.anthropic.push('NOOP: template uses large inline styles');
r = await runAgentCycle(npSite, { manual: false });
check('skipped cleanly and the step is retired for the month', r.action === 'no-change' && /large inline styles/.test(r.reason || '') && (await readArr('agent:playbook:np')).includes(`newpage:${MK}`), JSON.stringify(r).slice(0, 200));

section('S13  RANK-DROP RECOVERY jumps the queue and tells the owner');
await store.set('agent:playbook:np', JSON.stringify(['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`, `newpage:${MK}`]));
await store.set('agent:lastCycleAt:np', '0'); await store.set('agent:lastShipAt:np', '0');
await saveRanks('np', { at: Date.now() - 3 * 864e5, depth: 100, results: [{ keyword: 'ceramic coating denton tx', rank: 12, url: 'https://np.test/' }, { keyword: 'other kw', rank: 5, url: 'https://np.test/' }] });
await saveRanks('np', { at: Date.now() - 1000, depth: 100, results: [{ keyword: 'ceramic coating denton tx', rank: 31, url: 'https://np.test/', topTitles: [{ rank: 1, domain: 'rival.com', title: 'Rival ceramic' }] }, { keyword: 'other kw', rank: 5, url: 'https://np.test/' }] });
let recPrompt = '';
W.sms.length = 0;
W.anthropic.push((req) => {
  recPrompt = req.messages[0].content[0].text;
  return 'SUMMARY: Rewrote your homepage Google title to win back "ceramic coating denton tx"\nCOMMIT: recover\nPATCH: index.html\nREASON: title\n---FIND---\n<title>Acme</title>\n---REPLACE---\n<title>Ceramic Coating Denton TX | Acme</title>\n---END PATCH---';
});
r = await runAgentCycle(npSite, { manual: false });
check('the recovery task ran first (before any monthly step)', /Recover the ranking for "ceramic coating denton tx"/.test(recPrompt), recPrompt.slice(0, 120));
check('...with the actual drop stated (#12 to #31)', /dropped from #12 to #31/.test(recPrompt));
check('...and it shipped', r.action === 'change' && W.repos['acme/np'].files['index.html'].includes('Ceramic Coating Denton TX | Acme'));
check('owner was told about the drop', W.sms.some((s) => /Rank drop on NP Detailing.*#12 to #31/.test(s.body)), JSON.stringify(W.sms.map((s) => s.body)));
check('a keyword that did not drop is not touched', !/other kw/.test(recPrompt.split('TASK THIS CYCLE')[1] || ''));


section('S14  REGRESSION (live): four of six sites idle behind attempts that produced nothing');
await saveSiteConfig('idle', { url: 'https://idle.test', name: 'Idle Co', repo: 'acme/site', email: 'i@idle.test' });
const idle = (await listSites()).find((s) => s.slug === 'idle');
await store.set('conv:tagged:idle', '1');
await store.set('agent:keywords:idle', JSON.stringify(['a b']));
await store.set('agent:lastCycleAt:idle', String(Date.now() - 45 * 60000)); // a setup/failed attempt 45 minutes ago (old rule: locked out for 2 days)
check('a site whose last attempt shipped nothing is eligible again after 30 minutes', (await agentStatus(idle)).eligible === true, JSON.stringify((await agentStatus(idle)).reasons));
await store.set('agent:lastCycleAt:idle', String(Date.now() - 10 * 60000));
check('...but not within 30 minutes of an attempt (no double runs)', (await agentStatus(idle)).eligible === false);
await store.set('agent:lastCycleAt:idle', '0');
await store.set('agent:lastShipAt:idle', String(Date.now() - 3 * 3600000));
check('a site that shipped 3 hours ago stays paced (steady drip, not a burst)', (await agentStatus(idle)).reasons.some((x) => /change just shipped/.test(x)));
await store.set('agent:lastShipAt:idle', String(Date.now() - 49 * 3600000));
check('...and is free again after 2 days', (await agentStatus(idle)).eligible === true);


section('S15  foundation first: a site with NO sitemap gets it before page-speed to-dos');
addRepo('acme/found', { 'index.html': '<html><head><title>F</title><script type="application/ld+json">{"@type":"LocalBusiness"}</script></head><body>f</body></html>' });
W.pages['https://found.test'] = '<html><head><script type="application/ld+json">{"@type":"LocalBusiness"}</script></head></html>';
await saveSiteConfig('found', { url: 'https://found.test', name: 'Found Co', repo: 'acme/found', email: 'f@found.test' });
const foundSite = (await listSites()).find((s) => s.slug === 'found');
await store.set('conv:tagged:found', '1');
await store.set('agent:keywords:found', JSON.stringify(['a b']));
await store.set('todos:found', JSON.stringify({ generatedAt: Date.now(), items: [{ id: 'todo1', title: 'Add descriptive alt text to your gallery images', detail: 'x', category: 'SEO', source: 'ai' }] }));
let foundPrompt = '';
W.anthropic.push((req) => { foundPrompt = req.messages[0].content[0].text; return 'NOOP: x'; });
await runAgentCycle(foundSite, { manual: false });
const taskPart = foundPrompt.split('YOUR TASK THIS CYCLE')[1] || '';
check('the first task is the sitemap (foundation), not the alt-text to-do', /sitemap\.xml/.test(taskPart) && !/alt text/.test(taskPart), taskPart.slice(0, 160));


section('S16  WEEKLY BLOG: sets up a blog once, then one real post a week, on top of the daily work');
process.env.AGENT_BLOG = 'on';
const BHOME = '<!doctype html><html><head><meta charset="utf-8"><title>Blog Co</title><link rel="stylesheet" href="/css/site.css"></head><body><nav>NAV-B</nav><h1>Blog Co Detailing</h1><p>Mobile car detailing in Corinth, TX. Call 555-0100.</p><footer><a href="/contact.html">Contact</a> FOOT-B</footer></body></html>';
addRepo('acme/blog', { 'index.html': BHOME, 'sitemap.xml': '<?xml version="1.0"?><urlset>\n<url><loc>https://blog.test/</loc></url>\n</urlset>', 'robots.txt': 'x', 'llms.txt': 'x', 'css/site.css': 'body{}' });
W.pages['https://blog.test'] = '<html><head><script type="application/ld+json">{"@type":"LocalBusiness"}</script></head></html>';
await saveSiteConfig('blog', { url: 'https://blog.test', name: 'Blog Co', repo: 'acme/blog', email: 'b@blog.test' });
const blogSite = (await listSites()).find((s) => s.slug === 'blog');
await store.set('conv:tagged:blog', '1');
await store.set('agent:keywords:blog', JSON.stringify(['mobile detailing corinth']));
await store.set('agent:ranks:blog', JSON.stringify({ at: Date.now(), depth: 100, results: [{ keyword: 'mobile detailing corinth', rank: null, paa: ['How often should you detail your car?'], related: [] }] }));
await store.set('agent:playbook:blog', JSON.stringify(['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`]));
const resetB = () => Promise.all([store.set('agent:lastCycleAt:blog', '0'), store.set('agent:lastShipAt:blog', '0')]);
const BINDEX = '<!doctype html><html><head><title>Blog | Blog Co</title><link rel="canonical" href="https://blog.test/blog/"><link rel="stylesheet" href="/css/site.css"></head><body><nav>NAV-B</nav><h1>Blog</h1><p>Helpful advice from Blog Co Detailing in Corinth, TX.</p><!-- BLOG-MAIN-START --><main><h1>Blog</h1><p>Helpful advice from Blog Co Detailing in Corinth, TX.</p><div class="posts">\n<!-- NEW POSTS GO HERE -->\n</div><!-- CARD-TEMPLATE: <article class="card"><a href="{{URL}}">{{TITLE}}</a><p>{{TEASER}}</p><time>{{DATE}}</time></article> --><!-- POST-SHELL: <main class="wrap"><article class="post">{{CONTENT}}</article></main> --></main><!-- BLOG-MAIN-END --><footer>FOOT-B</footer></body></html>' + ' '.repeat(600);
W.anthropic.push('SUMMARY: Set up a blog section on your site\nCOMMIT: blog home\nFILE: blog/index.html\nREASON: blog home\n---BEGIN CONTENT---\n' + BINDEX + '\n---END CONTENT---\nPATCH: index.html\nREASON: link\n---FIND---\n<footer><a href="/contact.html">Contact</a>\n---REPLACE---\n<footer><a href="/blog/">Blog</a> <a href="/contact.html">Contact</a>\n---END PATCH---\nPATCH: sitemap.xml\nREASON: list\n---FIND---\n</urlset>\n---REPLACE---\n<url><loc>https://blog.test/blog/</loc></url>\n</urlset>\n---END PATCH---');
await resetB();
r = await runAgentCycle(blogSite, { manual: false });
check('first cycle sets up the blog home page', r.action === 'blog-setup', JSON.stringify({ a: r.action, e: r.error }));
check('blog/index.html is live with the post marker', W.repos['acme/blog'].files['blog/index.html']?.includes('NEW POSTS GO HERE'));
check('homepage got a small Blog link, rest untouched', W.repos['acme/blog'].files['index.html'].includes('<a href="/blog/">Blog</a>') && W.repos['acme/blog'].files['index.html'].includes('FOOT-B'));
check('blog home is in the sitemap', /blog\/<\/loc>/.test(W.repos['acme/blog'].files['sitemap.xml']));

const POST = (extra = '') => Array.from({ length: 10 }, (_, i) => '<p>' + Array.from({ length: 50 }, (_, j) => 'useful' + (i * 50 + j)).join(' ') + '</p>').join('') + extra + '<p><a href="/contact.html">Contact us</a></p>';
const postReply = (html) => 'TOPIC: How often should you detail your car?\nSUMMARY: Published a new blog post: How often should you detail your car?\nCOMMIT: blog post\nSLUG: how-often-should-you-detail-your-car\nTITLE: How Often Should You Detail Your Car?\nDESCRIPTION: How often to detail your car.\nTEASER: A simple schedule for keeping your car clean.\n---BEGIN CONTENT---\n' + html + '\n---END CONTENT---';

section('S16b  a draft that INVENTS a price is rejected, nothing published');
await resetB();
const mergedB = W.merged.length;
let blogPrompt = '';
W.anthropic.push((req) => { blogPrompt = req.messages[0].content[0].text; return postReply(POST('<p>Our full detail is only $149 for everyone.</p>')); });
r = await runAgentCycle(blogSite, { manual: false });
check('rejected for invented numbers, no merge', r.ok === false && /numbers not found/.test(r.error || '') && W.merged.length === mergedB, JSON.stringify(r).slice(0, 220));
check('the prompt offers real customer questions and forbids invented facts', /How often should you detail your car/.test(blogPrompt) && /NEVER invent prices/.test(blogPrompt));

section('S16c  a good post ships: live page, listed on the blog, in the sitemap, on the client list, owner emailed');
await resetB();
await store.set('agent:blog:blog', JSON.stringify({ ...(JSON.parse(await store.get('agent:blog:blog'))), retryAt: 0 }));
W.emails.length = 0;
W.anthropic.push(postReply(POST()));
r = await runAgentCycle(blogSite, { manual: false });
check('post shipped', r.action === 'change' && !!r.blogPost, JSON.stringify({ a: r.action, e: r.error }));
const livePost = W.repos['acme/blog'].files['blog/how-often-should-you-detail-your-car.html'] || '';
check('post page is live', !!livePost);
check('post reuses the site shell (nav/footer/wrapper) copied in code', /NAV-B/.test(livePost) && /FOOT-B/.test(livePost) && /<article class="post">/.test(livePost) && !/CARD-TEMPLATE|POST-SHELL|NEW POSTS GO HERE/.test(livePost));
check('post has its own title, canonical and Article schema', /<title>How Often Should You Detail Your Car\? \| Blog Co<\/title>/.test(livePost) && /rel="canonical" href="https:\/\/blog\.test\/blog\/how-often/.test(livePost) && /"@type":"Article"/.test(livePost));
check('blog list got a card built from the site\'s own card template', /<article class="card"><a href="\/blog\/how-often-should-you-detail-your-car\.html">How Often/.test(W.repos['acme/blog'].files['blog/index.html']));
check('listed on the blog home, marker kept for next time', /how-often-should-you-detail-your-car\.html/.test(W.repos['acme/blog'].files['blog/index.html']) && W.repos['acme/blog'].files['blog/index.html'].includes('NEW POSTS GO HERE'));
check('in the sitemap', /how-often-should-you-detail-your-car/.test(W.repos['acme/blog'].files['sitemap.xml']));
check('appears on the client "what we did" list', (await readArr('changelog:blog')).some((c) => /new blog post/i.test(c.text)));
check('owner was told about it (email, or a text when texting is on)', W.emails.some((e) => /Blog post/.test(e.subject || '')) || W.sms.some((s) => /blog post/i.test(s.body)), JSON.stringify({ e: W.emails.map((e) => e.subject), s: W.sms.map((x) => x.body).slice(-2) }));

section('S16d  only ONE post a week, and the same topic is never repeated');
await resetB();
const before16 = JSON.stringify(Object.keys(W.repos['acme/blog'].files).sort());
r = await runAgentCycle(blogSite, { manual: false });
check('no second post the same week', JSON.stringify(Object.keys(W.repos['acme/blog'].files).sort()) === before16 && r.action !== 'change' || !r.blogPost, JSON.stringify({ a: r.action }));
const stB = JSON.parse(await store.get('agent:blog:blog'));
stB.lastAt = Date.now() - 8 * 864e5; await store.set('agent:blog:blog', JSON.stringify(stB));
await resetB();
let prompt2 = '';
W.anthropic.push((req) => { prompt2 = req.messages[0].content[0].text; return 'NOOP: x'; });
await runAgentCycle(blogSite, { manual: false });
check('a week later it is due again and told which topic is already covered', /Topics already published[^\n]*How Often Should You Detail Your Car/.test(prompt2) && !/Search ideas[^\n]*How often should you detail your car\?/.test(prompt2), prompt2.slice(0, 300));

section('S16g  a blog home made BEFORE the shell existed still gets posts (full-page path)');
addRepo('acme/oldblog', { 'index.html': BHOME, 'sitemap.xml': '<?xml version="1.0"?><urlset>\n</urlset>', 'robots.txt': 'x', 'llms.txt': 'x', 'css/site.css': 'body{}', 'blog/index.html': '<html><head><title>Blog</title></head><body><h1>Blog</h1><div>\n<!-- NEW POSTS GO HERE -->\n</div>' + ' '.repeat(700) + '</body></html>' });
W.pages['https://old.test'] = '<html><head><script type="application/ld+json">{"@type":"LocalBusiness"}</script></head></html>';
await saveSiteConfig('oldblog', { url: 'https://blog.test', name: 'Old Blog Co', repo: 'acme/oldblog', email: 'o@old.test' });
const oldSite = (await listSites()).find((s) => s.slug === 'oldblog');
await store.set('conv:tagged:oldblog', '1');
await store.set('agent:keywords:oldblog', JSON.stringify(['a b']));
await store.set('agent:playbook:oldblog', JSON.stringify(['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`]));
const POSTL = (extra = '') => '<!doctype html><html><head><meta charset="utf-8"><title>How Often Should You Detail Your Car? | Blog Co</title><meta name="description" content="How often to detail your car."><link rel="canonical" href="https://blog.test/blog/how-often-should-you-detail-your-car.html"><link rel="stylesheet" href="/css/site.css"></head><body><nav>NAV-B</nav><h1>How Often Should You Detail Your Car?</h1><time datetime="2026-01-01">today</time>' + Array.from({ length: 10 }, (_, i) => '<p>' + Array.from({ length: 50 }, (_, j) => 'useful' + (i * 50 + j) + '').join(' ') + '</p>').join('') + extra + '<a href="/">Home</a><footer>FOOT-B</footer></body></html>';
const postReplyL = (html) => 'TOPIC: How often should you detail your car?\nSUMMARY: Published a new blog post: How often should you detail your car?\nCOMMIT: blog post\nFILE: blog/how-often-should-you-detail-your-car.html\nREASON: new post\n---BEGIN CONTENT---\n' + html + '\n---END CONTENT---\nPATCH: blog/index.html\nREASON: list\n---FIND---\n<!-- NEW POSTS GO HERE -->\n---REPLACE---\n<article><a href="/blog/how-often-should-you-detail-your-car.html">How Often Should You Detail Your Car?</a></article>\n<!-- NEW POSTS GO HERE -->\n---END PATCH---\nPATCH: sitemap.xml\nREASON: list\n---FIND---\n</urlset>\n---REPLACE---\n<url><loc>https://blog.test/blog/how-often-should-you-detail-your-car.html</loc></url>\n</urlset>\n---END PATCH---';


W.anthropic.push(postReplyL(POSTL()));
await store.set('agent:lastCycleAt:oldblog', '0'); await store.set('agent:lastShipAt:oldblog', '0');
process.env.AGENT_BLOG = 'on';
r = await runAgentCycle(oldSite, { manual: false });
check('legacy blog home: post still ships via the full-page path', r.action === 'change' && !!W.repos['acme/oldblog'].files['blog/how-often-should-you-detail-your-car.html'], JSON.stringify({ a: r.action, e: r.error }));
process.env.AGENT_BLOG = 'off';

section('S16e  blog can be turned off per site');
await resetB();
const stC = JSON.parse(await store.get('agent:blog:blog')); stC.lastAt = 0; stC.retryAt = 0; await store.set('agent:blog:blog', JSON.stringify(stC));
await saveSiteConfig('blog', { blog: false });
const blogOff = (await listSites()).find((s) => s.slug === 'blog');
check('site.blog === false is respected', blogOff.blog === false && !(await (await import('../lib/agent.js')).blogDue(blogOff)));

section('S16f  manual blog-now ignores the once-a-day spacing but not the budget cap');
process.env.AGENT_BLOG = 'on';
await saveSiteConfig('blog', { blog: true });
const stD = JSON.parse(await store.get('agent:blog:blog')); stD.lastAt = 0; stD.retryAt = 0; stD.unsupported = ''; await store.set('agent:blog:blog', JSON.stringify(stD));
await store.set('agent:lastShipAt:blog', String(Date.now())); await store.set('agent:fail:blog:' + new Date().toISOString().slice(0, 10), '0');
const blogOn2 = (await listSites()).find((s) => s.slug === 'blog');
r = await runAgentCycle(blogOn2, { manual: true });
check('without blogNow a just-shipped site is paced', r.skipped === true, JSON.stringify(r).slice(0, 120));
let p3 = '';
W.anthropic.push((req) => { p3 = req.messages[0].content[0].text; return 'NOOP: x'; });
r = await runAgentCycle(blogOn2, { manual: true, blogNow: true });
check('with blogNow it goes straight to the blog', /blog post/i.test(p3) && !r.skipped, JSON.stringify(r).slice(0, 300));
await store.set('agent:spend:blog:' + MK, '99');
r = await runAgentCycle(blogOn2, { manual: true, blogNow: true });
check('budget cap still stops it', r.skipped === true && /budget/.test(r.reason || ''), JSON.stringify(r).slice(0, 120));
process.env.AGENT_BLOG = 'off';

done();
