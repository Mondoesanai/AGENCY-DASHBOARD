import { W, addRepo, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { saveSiteConfig, listSites } from '../lib/registry.js';
import { runAutoTick } from '../lib/tick.js';
import { systemHealth } from '../lib/health.js';
import { summarizeRanks, readRankHistory, readPrevRanks, keywordTable, projectTimeline, saveRanks } from '../lib/ranks.js';
import sitesHandler from '../api/sites.js';
import adminHandler from '../api/admin.js';
import collect from '../api/collect.js';
import publicReport from '../api/public-report.js';
import siteApi from '../api/site.js';
import { reportToken } from '../lib/token.js';

const res = () => ({ code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; }, end() { return this; } });
const call = async (h, req) => { const r = res(); await h({ method: 'GET', query: {}, headers: {}, ...req }, r); return r; };
const readArr = async (k) => { const r = await store.get(k); try { const a = typeof r === 'string' ? JSON.parse(r) : r; return Array.isArray(a) ? a : []; } catch { return []; } };

// two sites, both with a repo + keywords; one has never been rank-checked
addRepo('acme/one', { 'index.html': '<html><head><title>One</title><script type="application/ld+json">{"@type":"LocalBusiness"}</script></head><body>one</body></html>', 'sitemap.xml': 'x', 'robots.txt': 'x', 'llms.txt': 'x' });
addRepo('acme/two', { 'index.html': '<html><head><title>Two</title></head><body>two</body></html>', 'sitemap.xml': 'x', 'robots.txt': 'x', 'llms.txt': 'x' });
W.pages['https://one.test'] = '<html><head><script type="application/ld+json">{"@type":"LocalBusiness"}</script></head></html>';
await saveSiteConfig('one', { url: 'https://one.test', name: 'One Co', repo: 'acme/one', email: 'one@one.test' });
await saveSiteConfig('two', { url: 'https://two.test', name: 'Two Co', repo: 'acme/two', email: 'two@two.test' });
for (const s of ['one', 'two']) {
  await store.set(`conv:tagged:${s}`, '1');
  await store.set(`agent:keywords:${s}`, JSON.stringify(Array.from({ length: 15 }, (_, i) => `keyword ${s} ${i}`)));
}
const MK = new Date().toISOString().slice(0, 7);
await store.set('agent:playbook:one', JSON.stringify(['sitemap', 'robots', 'llms', 'schema:home', `kw:${MK}`]));
W.dfs.ranks['keyword one 0'] = 12; W.dfs.ranks['keyword one 1'] = 30;

W.router = (req) => {
  const sys = String(req.system || '');
  if (/senior technical-SEO/.test(sys)) return 'NOOP: already good';
  return '{}';
};

section('P1  health reports the automation as dead until the first tick, then alive');
let h = await systemHealth();
check('before any tick: "never checked in" is flagged critical', h.issues.some((i) => i.level === 'critical' && /never checked in/.test(i.text)));

section('P2  one automation tick: a cycle + rank refresh, finishing well inside 60s');
const t0 = Date.now();
const tick = await runAutoTick();
check('tick ok, returned quickly', tick.ok && tick.ms < 15000, JSON.stringify(tick).slice(0, 300));
check('worked exactly one site this tick', !!tick.agent && ['one', 'two'].includes(tick.agent.slug), JSON.stringify(tick.agent));
check('refreshed rankings for exactly one (the stalest) site: 15 keywords + 1 indexed-pages check, in one go', tick.ranks.length === 1 && W.dfs.calls === 16, `ranks=${JSON.stringify(tick.ranks)} dfsCalls=${W.dfs.calls}`);
const refreshedSlug = tick.ranks[0]?.slug;
const stored = JSON.parse(await store.get(`agent:ranks:${refreshedSlug}`));
check('stored ranks include competitor titles, People-Also-Ask and related searches per keyword', stored.results.every((x) => x.topTitles?.length && x.paa?.length && x.related?.length));
check('stored ranks record the real search depth (100), not a results count', stored.depth === 100);
check('stored ranks record how many pages Google has indexed (site: check)', stored.indexed?.count === 3, JSON.stringify(stored.indexed));
check('rank history point appended', (await readRankHistory(refreshedSlug)).length === 1);
h = await systemHealth();
check('after a tick health no longer says never checked in', !h.issues.some((i) => /never checked in/.test(i.text)) && h.tickLast > 0);

section('P3  second tick refreshes the OTHER site; a third does nothing new (freshness window respected)');
await store.set('agent:lastCycleAt:one', '0'); await store.set('agent:lastCycleAt:two', '0');
W.dfs.calls = 0;
const tick2 = await runAutoTick();
check('second tick refreshed the other site', tick2.ranks.length === 1 && tick2.ranks[0].slug !== refreshedSlug, JSON.stringify(tick2.ranks));
W.dfs.calls = 0;
const tick3 = await runAutoTick();
check('third tick makes no rank lookups (both fresh <3 days) so it is cheap', tick3.ranks.length === 0 && W.dfs.calls === 0, JSON.stringify(tick3.ranks) + ' calls ' + W.dfs.calls);

section('P3b  a keyword-less site must not starve the others, and gets tracking started when nothing is stale');
await saveSiteConfig('nokw', { url: 'https://nokw.test', name: 'No Keywords Co' }); // no repo, no keywords
W.dfs.calls = 0;
await store.set('agent:ranks:one', JSON.stringify({ at: Date.now() - 5 * 864e5, depth: 100, results: [{ keyword: 'x', rank: 9 }] }));
await store.set('agent:lastCycleAt:one', String(Date.now())); await store.set('agent:lastCycleAt:two', String(Date.now()));
let tk = await runAutoTick();
check('stale site with keywords is refreshed (not blocked by the keyword-less site sorting first)', tk.ranks.length === 1 && tk.ranks[0].slug === 'one', JSON.stringify(tk.ranks));
W.router = (req) => (/local SEO strategist/.test(String(req.system)) ? '{"keywords":["nokw a","nokw b"]}' : '{}');
tk = await runAutoTick();
check('when everything is fresh, the keyword-less site (no repo needed) gets keyword + rank tracking started', tk.ranks.length === 1 && tk.ranks[0].slug === 'nokw' && tk.ranks[0].startedTracking === 2, JSON.stringify(tk.ranks));
check('...and its first rank check ran', !!(await store.get('agent:ranks:nokw')));
W.router = (req) => (/senior technical-SEO/.test(String(req.system)) ? 'NOOP: already good' : '{}');

section('P4  the tick tells the owner if the automation had been offline for hours');
await store.set('auto:lastTick', String(Date.now() - 11 * 3600000));
W.sms.length = 0;
await runAutoTick();
check('offline notice texted', W.sms.some((s) => /automation was offline for 11h/.test(s.body)), JSON.stringify(W.sms.map((s) => s.body)));
await store.set('auto:lastTick', String(Date.now() - 30 * 3600000));
h = await systemHealth();
check('30h of silence is flagged critical', h.issues.some((i) => i.level === 'critical' && /hasn't checked in/.test(i.text)));
await store.set('auto:lastTick', String(Date.now() - 10 * 3600000));
h = await systemHealth();
check('10h of silence is a warning (GitHub scheduler is bursty), not critical', h.issues.some((i) => i.level === 'warn' && /last checked in/.test(i.text)) && !h.issues.some((i) => i.level === 'critical' && /checked in/.test(i.text)));

section('P5  public poke endpoint: works with no secret, but is rate limited');
await store.set('auto:pokeAt', '0');
let r = await call(adminHandler, { query: { do: 'auto-poke' } });
check('poke runs a tick', r.body?.ok === true && r.body.ms !== undefined, JSON.stringify(r.body).slice(0, 120));
r = await call(adminHandler, { query: { do: 'auto-poke' } });
check('second poke inside the window is skipped', r.body?.skipped === 'ran recently');
process.env.CRON_SECRET = 'sekret';
r = await call(adminHandler, { query: { do: 'auto-tick' } });
check('the authed tick endpoint refuses callers without the secret', r.code === 401);
r = await call(adminHandler, { query: { do: 'auto-tick', secret: 'sekret' } });
check('...and accepts the secret', r.code === 200 && r.body.ok === true);
r = await call(adminHandler, { query: { do: 'sms-inbound' } });
check('the text-reply webhook refuses callers without the secret', r.code === 401);
r = await call(adminHandler, { method: 'POST', query: { do: 'sms-inbound', secret: 'sekret' }, body: 'From=%2B15559990000&Body=yes' });
check('webhook returns valid (empty) TwiML for a stranger number', typeof r.body === 'string' && r.body.includes('<Response></Response>'), String(r.body));
r = await call(adminHandler, { method: 'POST', query: { do: 'sms-inbound', secret: 'sekret' }, body: { From: '+15551234567', Body: 'status' } });
check('webhook answers the owner (STATUS) inside TwiML', /<Message>.*Open revisions/.test(String(r.body)), String(r.body));
delete process.env.CRON_SECRET;

section('P6  ranking maths + display data');
const cur = { at: Date.now(), depth: 100, results: [
  { keyword: 'a', rank: 5, resultsCount: 1e6 }, { keyword: 'b', rank: 40, resultsCount: 2e6 }, { keyword: 'c', rank: null, resultsCount: 3e6 }, { keyword: 'd', rank: null, error: 'x' } ] };
const sm = summarizeRanks(cur);
check('average position only counts keywords actually found', sm.avgRank === 22.5 && sm.found === 2 && sm.inTop10 === 1, JSON.stringify(sm));
check('a lone flaky sample never becomes a fake "field size"', sm.roughField === null);
const thin = summarizeRanks({ depth: 100, results: [1, 2, 3, 4].map((i) => ({ keyword: 'k' + i, rank: null, resultsCount: 1000000 * i })) });
check('with >=4 real samples and nothing ranking, a rough field size is shown', thin.avgRank === null && thin.roughField === 2500000, JSON.stringify(thin));
const prev = { results: [{ keyword: 'a', rank: 9 }, { keyword: 'b', rank: null }, { keyword: 'c', rank: 50 }] };
const kt = keywordTable(cur, prev);
check('per-keyword movement: improved / newly ranking / dropped out', kt.find((k) => k.keyword === 'a').change === 4 && kt.find((k) => k.keyword === 'b').change === 999 && kt.find((k) => k.keyword === 'c').change === -999, JSON.stringify(kt));
const day = 864e5; const B = 1.7e12;
check('timeline projects only from real improving history', projectTimeline([{ at: B, avgRank: 50 }, { at: B + 5 * day, avgRank: 40 }, { at: B + 10 * day, avgRank: 30 }], 3).weeksToTarget === 2);
check('no timeline from thin history', projectTimeline([{ at: 1, avgRank: 5 }], 3).ok === false);
check('a flat trend is reported honestly, not as progress', projectTimeline([{ at: B, avgRank: 30 }, { at: B + 5 * day, avgRank: 30 }, { at: B + 10 * day, avgRank: 31 }], 3).improving === false);
await saveRanks('one', { at: Date.now() - 2 * day, depth: 100, results: [{ keyword: 'z', rank: 44 }] });
await saveRanks('one', { at: Date.now(), depth: 100, results: [{ keyword: 'z', rank: 30 }] });
check('previous snapshot is kept when saving a new one', (await readPrevRanks('one'))?.results?.[0]?.rank === 44);

section('P7  dashboard API: tiles + per-site cards');
await store.set('revisions:all', JSON.stringify([{ id: 'a', status: 'scheduled' }, { id: 'b', status: 'cancelled' }, { id: 'c', status: 'done' }, { id: 'd', status: 'needs attention' }]));
r = await call(sitesHandler, {});
check('pending revisions counts open + needs-attention, NOT cancelled/done', r.body.portfolio.pendingRevisions === 2, String(r.body.portfolio.pendingRevisions));
const row = r.body.sites.find((s) => s.slug === 'one');
check('site rows expose the real rank summary + timeline', !!row.rankSummary && row.rankSummary.avgRank === 30 && row.rankTimeline && 'ok' in row.rankTimeline, JSON.stringify(row.rankSummary));
check('each site row shows what the automation is doing (eligibility, reasons, recent actions)', !!row.agent && Array.isArray(row.agent.reasons) && Array.isArray(row.agent.recent) && typeof row.agent.cap === 'number', JSON.stringify(row.agent));
check('overview tile average ranking is computed', r.body.portfolio.avgRank === 30 && r.body.portfolio.rankedSites >= 1, JSON.stringify({ a: r.body.portfolio.avgRank, n: r.body.portfolio.rankedSites }));

section('P8  lead-source (UTM) tagging end to end through the tracker endpoint');
const beacon = (body) => call(collect, { method: 'POST', headers: { 'user-agent': 'x', 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify({ s: 'one.test', u: 'https://one.test', p: '/', w: 400, ...body }) });
await beacon({ e: 'pv', src: 'facebook-paid', r: '' });
await beacon({ e: 'ev', n: 'booking', src: 'facebook-paid' });
await beacon({ e: 'ev', n: 'call', src: '' , r: 'https://www.google.com/' });
r = await call(sitesHandler, {});
const one = r.body.sites.find((s) => s.slug === 'one');
const ls = one.stats.leadSources.map((x) => x.member).sort().join(',');
check('conversions are attributed to UTM source, falling back to the referrer', ls === 'facebook-paid,google', ls);
check('pageview sources use the UTM too', one.stats.sources.some((x) => x.member === 'facebook-paid'));

section('P9  public client report exposes live rankings, the plan with targets, and traffic');
process.env.CRON_SECRET = 'tokensecret';
const tok = reportToken('one');
r = await call(publicReport, { query: { slug: 'one', t: tok } });
check('valid token accepted', r.code === 200, JSON.stringify(r.body).slice(0, 100));
check('rankings block present with per-keyword movement', r.body.rankings?.keywords?.length >= 1 && 'change' in r.body.rankings.keywords[0], JSON.stringify(r.body.rankings)?.slice(0, 200));
check('traffic breakdown present', Array.isArray(r.body.traffic?.sources) && Array.isArray(r.body.traffic?.leadSources));
r = await call(publicReport, { query: { slug: 'one', t: 'wrong' } });
check('wrong token rejected', r.code === 403);
delete process.env.CRON_SECRET;

section('P10  adding a site starts conversion tracking + keyword/rank tracking immediately');
addRepo('acme/new', { 'index.html': '<html><body><a href="/x" class="btn">Get a free quote</a><button>Book now</button></body></html>' });
W.pages['https://new.test'] = '<html><body><a href="/x" class="btn">Get a free quote</a><button>Book now</button></body></html>';
W.dfs.ranks['mobile detailing corinth'] = 15; W.dfs.domain = 'new.test';
W.router = (req) => {
  const sys = String(req.system || '');
  if (/local SEO strategist/.test(sys)) return '{"keywords":["mobile detailing corinth","ceramic coating denton","car wash corinth"]}';
  if (/conversion|configure/i.test(sys) || /which of these/i.test(JSON.stringify(req.messages))) return '{"conversions":[{"index":0,"event_name":"quote-request"},{"index":1,"event_name":"book-now"}]}';
  return '{}';
};
process.env.CRON_SECRET = 's';
r = await call(siteApi, { method: 'POST', query: { secret: 's' }, body: { action: 'save', url: 'https://new.test', name: 'New Co', repo: 'acme/new', email: 'n@new.test' } });
check('site saved', r.body?.ok === true, JSON.stringify(r.body).slice(0, 200));
check('keywords chosen immediately (no waiting for a daily rotation)', r.body.rankSetup?.ok && r.body.rankSetup.keywords?.length === 3, JSON.stringify(r.body.rankSetup));
check('first rank check ran immediately and found the ranking keyword', r.body.rankSetup?.ranks?.found === 1, JSON.stringify(r.body.rankSetup?.ranks));
check('conversion tracking ran immediately', !!r.body.convSetup, JSON.stringify(r.body.convSetup));
check('conversion tags were committed to the live site', r.body.convSetup?.tagged === 2 && /data-track="quote-request"/.test(W.repos['acme/new'].files['index.html']) && /data-track="book-now"/.test(W.repos['acme/new'].files['index.html']), JSON.stringify(r.body.convSetup) + ' :: ' + W.repos['acme/new'].files['index.html']);
check('it will not re-tag on every later save', !!(await store.get('conv:tagged:' + r.body.site.slug)));
delete process.env.CRON_SECRET;


section('P11  the automation upgrades old-format client reports on its own (no email), once per site per month');
W.router = (req) => {
  const sys = String(req.system || '');
  if (/account manager at a small web studio/.test(sys)) return JSON.stringify({ headline: 'h', summary: 's', progress: 'PROGRESS NARRATIVE', work_done: [{ title: 'did x', detail: 'd' }], improvements: [], client_actions: [{ title: 'a', why: 'w', target: '10 by Sunday' }], builder_notes: [], email: { subject: 'x', body_text: 'y' } });
  return '{}';
};
await store.set(`report:one:regen:x`, '1');
for (const s of ['one', 'two', 'nokw']) await store.set(`report:regen:${s}:${MK}`, '0');
await store.set('report:one:latest', JSON.stringify({ slug: 'one', headline: 'old', summary: 'old generic report', clientActions: [{ title: 'Ask 3 happy customers for a Google review' }] }));
for (const s of ['two', 'nokw']) await store.set(`report:${s}:latest`, JSON.stringify({ progress: 'already detailed' }));
const emailsBefore = W.emails.length;
let tk11 = await runAutoTick();
const rep1 = JSON.parse(await store.get('report:one:latest'));
check('legacy report was regenerated with the detailed fields', rep1.progress === 'PROGRESS NARRATIVE' && rep1.clientActions[0].target === '10 by Sunday', JSON.stringify(rep1).slice(0, 200));
check('no client email was sent by that refresh', W.emails.length === emailsBefore);
const calls11 = W.anthropicCalls.filter((c) => /account manager/.test(String(c.system))).length;
const tk11b = await runAutoTick();
check('it does not redo the same site again this month (it moves on to a different one)', tk11b.report?.slug !== 'one' && !!(await store.get(`report:regen:one:${MK}`)), JSON.stringify(tk11b.report));

done();
