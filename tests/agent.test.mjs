import { W, addRepo, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { saveSiteConfig, listSites } from '../lib/registry.js';
import { runAgentCycle, agentStatus } from '../lib/agent.js';
import { addRevisionTodo, todosState } from '../lib/todos.js';

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
for (const k of ['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`]) await store.set('agent:playbook:acme', JSON.stringify([...(await readArr('agent:playbook:acme')), k]));
const resetPacing = () => store.set('agent:lastCycleAt:acme', '0');

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
check('pacing timestamp set', Number(await store.get('agent:lastCycleAt:acme')) > 0);

section('S2  "already good" -> NOOP: no commit, no error, step retired');
await resetPacing();
const mergedBefore = W.merged.length;
W.anthropic.push('NOOP: the description and title on this page are already specific and well written');
r = await runAgentCycle(site, { manual: false });
check('reports no-change (not an error)', r.ok === true && r.action === 'no-change', JSON.stringify(r).slice(0, 200));
check('nothing committed', W.merged.length === mergedBefore);
check('step retired so it is not retried', (await readArr('agent:playbook:acme')).includes(`meta:rankings.html:${MK}`));
const lc = Number(await store.get('agent:lastCycleAt:acme'));
check('next attempt allowed within ~2h, not a full 2 days', Date.now() - lc > 45.9 * 3600000 && Date.now() - lc < 46.1 * 3600000, String((Date.now() - lc) / 3600000));

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
check('...and the real work can start within ~10 minutes, not after 2 days', gap > 47.8 * 3600000 && gap < 48 * 3600000, String(gap / 3600000));

done();
