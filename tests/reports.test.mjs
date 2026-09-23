import { setNow } from './fakedate.mjs';
import { W, addRepo, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { saveSiteConfig, listSites } from '../lib/registry.js';
import cronDaily from '../api/cron-daily.js';
import { buildForSite } from '../api/report.js';
import { saveRanks, appendRankHistory } from '../lib/ranks.js';

const MK = new Date().toISOString().slice(0, 7);
const day = 864e5;
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, end() { return this; } });
const runCron = async () => { const r = res(); await cronDaily({ method: 'GET', query: {}, headers: {} }, r); return r; };
const emailsTo = (a) => W.emails.filter((e) => e.to === a);
const reportModelCalls = [];

// The report-writing model builds its answer FROM the payload it receives, so
// asserting on the answer proves the real data actually reached the prompt.
W.router = (req) => {
  const sys = String(req.system || '');
  if (/account manager at a small web studio/.test(sys)) {
    const p = JSON.parse(req.messages[0].content);
    reportModelCalls.push({ system: sys, payload: p });
    const kws = (p.rankings?.keywords || []).map((k) => `${k.keyword}: ${k.rank ? '#' + k.rank : 'not yet'}`).join('; ');
    return JSON.stringify({
      headline: 'Steady progress',
      summary: 'Things are moving.',
      progress: `Average position #${p.rankings?.averagePosition} across ${p.rankings?.keywordsTracked} keywords. ${kws}`,
      work_done: (p.shippedWork || []).map((w) => ({ title: w.what, detail: 'done ' + w.date })),
      improvements: [{ title: 'Next: sharpen /services', why: 'it ranks #27 for a money keyword' }],
      client_actions: [{ title: `Text your booking link to 10 past customers (round ${reportModelCalls.length})`, why: 'your top channel sends most enquiries', target: '10 taps by Sunday' }],
      builder_notes: ['x'],
      email: { subject: 'Your update', body_text: `Hi Debbie,\n\nWhere you rank in Google: ${kws}\n\nWhat we did:\n${(p.shippedWork || []).map((w) => '• ' + w.what).join('\n')}\n\n— Inspiring Websites` },
    });
  }
  if (/senior technical-SEO/.test(sys)) return 'NOOP: fine';
  return '{}';
};

async function mk(slug, cfg) {
  addRepo(`acme/${slug}`, { 'index.html': '<html><head><title>x</title><script type="application/ld+json">{"@type":"LocalBusiness"}</script></head></html>', 'sitemap.xml': 'x', 'robots.txt': 'x', 'llms.txt': 'x' });
  await saveSiteConfig(slug, { url: `https://${slug}.test`, name: slug.toUpperCase(), repo: `acme/${slug}`, email: `${slug}@${slug}.test`, client: 'Debbie', autoSend: true, ...cfg });
  await store.set(`conv:tagged:${slug}`, '1');
  await store.set(`agent:keywords:${slug}`, JSON.stringify(['kw one', 'kw two']));
  await store.set(`agent:lastCycleAt:${slug}`, String(Date.now())); // keep the SEO agent out of these tests
}
await mk('monthly', { billingDay: 19, reportEvery: 'monthly' });
await mk('biweekly', { billingDay: 5, reportEvery: 'biweekly' });
await mk('manual', { billingDay: 19, autoSend: false });

await saveRanks('biweekly', { at: Date.now() - 6 * day, depth: 100, results: [{ keyword: 'kw one', rank: 41 }, { keyword: 'kw two', rank: null }] });
await saveRanks('biweekly', { at: Date.now() - day, depth: 100, results: [{ keyword: 'kw one', rank: 27 }, { keyword: 'kw two', rank: 88 }], competitors: [{ domain: 'big.com', bestRank: 1, hits: 2 }] });
await appendRankHistory('biweekly', { at: Date.now() - 6 * day, avgRank: 41, inTop10: 0 });
await appendRankHistory('biweekly', { at: Date.now() - day, avgRank: 57.5, inTop10: 0 });
const iso = (d) => new Date(Date.now() - d * day).toISOString().slice(0, 10);
await store.set('changelog:biweekly', JSON.stringify([
  { date: iso(3), text: 'Rewrote the Google title and description on your homepage' },
  { date: iso(9), text: 'Added structured data so Google understands your services' },
  { date: iso(24), text: 'OLD: something from last month' },
]));

section('R1  Sep 19: biweekly client gets the 2nd email of the month; monthly client gets theirs; auto-send-off client is left alone');
setNow('2026-09-19T14:00:00Z');
let r = await runCron();
check('daily pass ran', r.body?.ok === true, JSON.stringify(r.body).slice(0, 200));
check('monthly client emailed on billing day', emailsTo('monthly@monthly.test').length === 1, JSON.stringify(W.emails.map((e) => e.to)));
check('biweekly client emailed on their 2nd send day (billing day + 14)', emailsTo('biweekly@biweekly.test').length === 1);
check('auto-send OFF client is never emailed', emailsTo('manual@manual.test').length === 0);
check('biweekly send recorded under the 2nd-send key only', (await store.get('lastSent2:biweekly')) === MK && !(await store.get('lastSent:biweekly')));
check('monthly send recorded normally', (await store.get('lastSent:monthly')) === MK);
const repB = JSON.parse(await store.get('report:biweekly:latest'));
check('biweekly report is labelled as a two-week check-in', repB.period === 'biweekly');
const callB = reportModelCalls.find((c) => /two-week check-in/.test(c.system));
check('report model was told to write a two-week check-in', !!callB);
const kwOne = callB?.payload.rankings.keywords.find((k) => k.keyword === 'kw one');
check('prompt has real per-keyword rankings with movement (41 -> 27 = +14)', kwOne?.rank === 27 && kwOne?.change === 14, JSON.stringify(callB?.payload.rankings.keywords));
check("prompt only has work shipped in the last ~2 weeks (not last month's)", callB?.payload.shippedWork.length === 2 && !callB.payload.shippedWork.some((w) => /OLD/.test(w.what)), JSON.stringify(callB?.payload.shippedWork));
const emailB = emailsTo('biweekly@biweekly.test')[0];
check('email body contains the real ranking line', /kw one: #27/.test(emailB.text), emailB.text.slice(0, 200));
check('email body lists what was actually done', /Rewrote the Google title/.test(emailB.text));
check('stored report has the ranking narrative, work list and a targeted weekly plan', /Average position/.test(repB.progress) && repB.workDone.length === 2 && repB.clientActions[0].target === '10 taps by Sunday');
check('email links to the live report page', /dash\.test\/r\/biweekly/.test(emailB.html || ''));

section('R2  running the daily pass again the same day sends nothing twice');
await runCron();
check('still exactly one email each', emailsTo('monthly@monthly.test').length === 1 && emailsTo('biweekly@biweekly.test').length === 1);

section("R3  the next report is told what it already suggested, so it can't repeat it");
const prevTitle = repB.clientActions[0].title;
await buildForSite((await listSites()).find((s) => s.slug === 'biweekly'), { doSend: false, req: { headers: { host: 'dash.test' } }, period: 'biweekly' });
const call2 = reportModelCalls[reportModelCalls.length - 1];
check('previous actions are passed to the model', call2.payload.previousClientActions.includes(prevTitle), JSON.stringify(call2.payload.previousClientActions));

section('R4  a missed day catches up: billing day 19 missed, run on Sep 22, still sends');
await mk('late', { billingDay: 19 });
setNow('2026-09-22T14:00:00Z');
await runCron();
check('emailed 3 days late (inside the 5-day catch-up window)', emailsTo('late@late.test').length === 1);
await runCron();
check('...and only once', emailsTo('late@late.test').length === 1);

section('R5  too late is skipped: billing day 10 on Sep 25 (15 days late) sends nothing');
await mk('toolate', { billingDay: 10 });
setNow('2026-09-25T14:00:00Z');
await runCron();
check('no surprise report 15 days late', emailsTo('toolate@toolate.test').length === 0);

section('R6  biweekly client first send: billing day 5, caught up on the 6th');
await mk('bw2', { billingDay: 5, reportEvery: 'biweekly' });
setNow('2026-09-06T14:00:00Z');
await runCron();
check('first-of-month send goes out and is recorded under the normal key', emailsTo('bw2@bw2.test').length === 1 && (await store.get('lastSent:bw2')) === MK && !(await store.get('lastSent2:bw2')));

section('R7  wins-recap emails are skipped for biweekly clients');
await mk('recapM', { billingDay: 5, reportEvery: 'monthly' });
await mk('recapB', { billingDay: 5, reportEvery: 'biweekly' });
for (const s of ['recapM', 'recapB']) await store.set(`todos:completed:${s}`, JSON.stringify([{ title: 'Did a thing', source: 'seo', addressedAt: Date.now() - 2 * day }]));
setNow('2026-09-15T14:00:00Z');
W.emails.length = 0;
await runCron();
check('monthly client gets the quick wins recap on its recap day', emailsTo('recapM@recapM.test').some((e) => /quick update/.test(e.subject)), JSON.stringify(W.emails.map((e) => e.to + '|' + e.subject)));
check('biweekly client does not', !emailsTo('recapB@recapB.test').some((e) => /quick update/.test(e.subject)));


section('R8  a SLOW model never costs a client their email: it times out and the plain report still sends');
process.env.REPORT_MODEL_TIMEOUT_MS = '300';
W.delayMs = 1500;
await mk('slowmodel', { billingDay: 15, reportEvery: 'monthly' });
setNow('2026-09-15T15:00:00Z');
const t0 = Date.now();
await runCron();
const slowMail = emailsTo('slowmodel@slowmodel.test');
check('the client email STILL went out', slowMail.length === 1, JSON.stringify(W.emails.map((e) => e.to)));
check('...as the built-in fallback report (no AI text)', slowMail.length === 1 && !/Where you rank in Google: kw/.test(slowMail[0].text));
const slowRep = JSON.parse(await store.get('report:slowmodel:latest'));
check('the report records that the AI step failed instead of hiding it', !!slowRep.aiError && /timed out|timeout|Request/i.test(slowRep.aiError), slowRep.aiError);
W.delayMs = 0;
delete process.env.REPORT_MODEL_TIMEOUT_MS;

section('R9  the report is written by two parallel smaller calls');
const partCalls = W.anthropicCalls.filter((c) => /PART A of 2/.test(String(c.system)));
const partB = W.anthropicCalls.filter((c) => /PART B of 2/.test(String(c.system)));
check('every report used a part-A and a part-B call', partCalls.length > 0 && partCalls.length === partB.length, partCalls.length + '/' + partB.length);
check('each call is capped well below the old 8000 tokens', W.anthropicCalls.filter((c) => /account manager/.test(String(c.system))).every((c) => c.max_tokens <= 3500));


section('R10  the report never promises work the system will not do (image compression, colours, layout)');
const sysText = String(callB.system);
check('the writing prompt forbids promising image/colour/layout work', /NEVER promise image compression or resizing, colour \/ contrast \/ font \/ layout changes/.test(sysText));
check('...and lists what it may promise instead', /search titles and descriptions, structured data, sitemap/.test(sysText));

done();
