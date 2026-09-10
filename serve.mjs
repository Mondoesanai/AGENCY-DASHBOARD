// Local preview: serves public/ and fakes just enough API to see the UI with
// sample data. The real APIs run on Vercel (`npx vercel dev` for the full thing).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCardSVG } from './lib/card.js';
import { TRACKER_JS } from './lib/tracker.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = process.env.PORT || 3200;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function demoSite(slug, name, url, client, v, dV, c, dC, seo, perf, letter, price, bday) {
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  const history = months.map((m, i) => {
    const last = i === months.length - 1;
    const prevV = Math.round(v * (0.45 + (i - 1) * 0.16));
    return {
      month: m,
      visitors: last && dV < 0 ? v : Math.round(v * (0.45 + i * 0.16)),
      conversions: Math.max(0, c - (4 - i)),
      seo: Math.min(100, seo - (4 - i) * 3), grade: { letter, score: seo - 5 },
    };
  });
  const setupFee = price * 8;
  const monthsActive = 6;
  const lifetimeRevenue = setupFee + price * monthsActive;
  const expenses = [{ date: '2026-09-01', label: 'Google Ads', amount: 120, recurring: true }];
  const expensesTotal = expenses.reduce((t, e) => t + e.amount, 0);
  const onTrial = slug === 'one-more-thing';
  return {
    slug, name, url, client, email: '', phone: '', priceMonthly: price, leadValue: 120,
    setupFee, startedAt: Date.now() - monthsActive * 30 * 864e5, monthsActive, lifetimeRevenue,
    trialEnds: onTrial ? Date.now() + 12 * 864e5 : 0, onTrial, trialDaysLeft: onTrial ? 12 : 0,
    expenses, expensesTotal, netProfit: lifetimeRevenue - expensesTotal,
    billingDay: bday, autoSend: false, reviewUrl: '', conversionEvents: [], source: 'ui',
    billingSoon: bday === new Date().getUTCDate(), hasTracker: true, awaitingData: false,
    lastSeen: Date.now() - 3600000, reportUrl: `/r/${slug}?t=demo`,
    stats: {
      hasData: true, visitors: v, pageviews: Math.round(v * 2.2), conversions: c,
      avgDwell: 18 + Math.round(seo / 8), avgDwellPrev: 15,
      deltas: { visitors: dV, pageviews: dV, conversions: dC },
      device: { mobile: Math.round(v * 0.66), desktop: Math.round(v * 0.34) },
      trend: history.map(h => h.visitors),
      topPages: [{ member: '/', score: Math.round(v * 1.3) }, { member: '/services', score: Math.round(v * 0.5) }, { member: '/contact', score: Math.round(v * 0.3) }],
      sources: [{ member: 'google', score: Math.round(v * 0.5) }, { member: 'direct', score: Math.round(v * 0.35) }, { member: 'social', score: Math.round(v * 0.15) }],
      events: [{ member: 'call', score: Math.round(c * 0.6) + 5 }, { member: 'quote-form', score: Math.round(c * 0.4) + 2 }, { member: 'booking', score: 3 }, { member: 'review-click', score: 4 }],
      conversionEvents: [],
    },
    audit: { ok: true, scores: { seo, performance: perf, accessibility: 92, bestPractices: 95 }, vitals: { lcp: 2600, cls: 0.06, tbt: 180 } },
    grade: { score: seo - 5, letter },
    builderFindings: [
      { severity: 'high', title: 'Missing meta description on /contact', detail: 'Add a 140–160 char description.' },
      { severity: 'med', title: 'Hero image 1.9 MB', detail: 'Compress to WebP, ~250 KB.' },
      { severity: 'low', title: 'No LocalBusiness JSON-LD', detail: 'Add structured data for rich results.' },
      { severity: 'low', title: 'Two H1s on the homepage', detail: 'Keep one H1 per page.' },
      { severity: 'low', title: 'Link text "click here" x3', detail: 'Use descriptive anchors.' },
    ],
    improvements: [
      { title: 'Make pages load faster on phones', why: 'Most visitors are on mobile — quicker load, fewer drop-offs.' },
      { title: 'Sharpen how you show up on Google', why: 'Tighter titles and descriptions to lift click-through.' },
    ],
    clientActions: [
      { title: 'Ask 3 recent happy customers for a Google review', why: 'Biggest single thing you can do for local ranking and trust.' },
      { title: 'Add the site link to your email signature and text replies', why: 'Every message becomes a way for people to find and share your site.' },
      { title: 'Post the link on Facebook / Instagram with a recent job photo', why: 'One post a month keeps new visitors coming.' },
    ],
    openCount: 5, history, notes: '', changelog: [{ date: '2026-09-01', text: 'Compressed images, added FAQ section' }],
    report: {
      month: 'September 2026', angle: 'momentum', aiGenerated: false,
      headline: `${name} — momentum is building`,
      summary: `${name} had its best month yet: visitors up ${dV}% and ${c} enquiries came through the site.`,
      wins: [`Visitors: ${history.at(-2).visitors} → ${v} last month (+${dV}%)`, `Your SEO score moved from ${seo - 3} to ${seo}.`, `${c} enquiries this month — roughly $${c * 120} in new business.`],
      improvements: [{ title: 'Make pages load faster on phones', why: 'Fewer visitors leave before seeing your offer.' }],
      clientActions: [{ title: 'Ask 3 recent customers for a Google review', why: 'Local ranking + trust.' }],
      builderExtra: ['Preload the hero font', 'Add width/height to all <img>'],
      email: { subject: `${name} — this month's website progress`, body_text: `Hi ${client},\n\nGood news — ${name}'s website is building momentum.\n\nThis month:\n• Visitors: ${history.at(-2).visitors} → ${v} (+${dV}%)\n• Your SEO score moved from ${seo - 3} to ${seo}.\n• ${c} enquiries — roughly $${c * 120} in new business.\n\nWhat we're working on next:\n• Make pages load faster on phones\n• Sharpen how you show up on Google\n\nYour website is turning into a real source of business.\n\n— Inspiring Websites` },
      reportUrl: `/r/${slug}`,
    },
  };
}

const _former = [{ slug: 'old-client', name: 'Corner Cafe', client: 'Dana', reason: 'cancelled', note: 'sold the business', leftDate: '2026-07-15', monthsActive: 9, priceMonthly: 90, setupFee: 600, lifetimeRevenue: 1410, recordedAt: Date.now() - 40 * 864e5 }];
const _overhead = [{ date: '2026-09-02', label: 'Chamber of Commerce membership', amount: 540, recurring: false }, { date: '2026-09-01', label: 'Figma + hosting', amount: 45, recurring: true }, { date: '2026-09-10', label: 'AI & automation — Compass + SEO agent', amount: 41.2, recurring: true, auto: true }];
const _trials = [{ slug: 'one-more-thing', name: 'One More Thing Services', priceMonthly: 100, autoChargeDate: new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10), daysLeft: 12 }];
const DEMO = {
  portfolio: { sites: 3, visitors30: 1284, conversions30: 47, mrr: 350, trials: 1, trialMrr: 100, avgSeo: 88, improving: 2, openFindings: 15, attention: ['apostello-detailing'], noTracker: [], auditQuota: false, emailEnabled: true, aiEnabled: true, backend: 'demo',
    _fin: { mrr: 350, annualRunRate: 4200, setupTotal: 3600, recurringToDate: 2700, lifetimeRevenue: 7710, activeRevenue: 6300, churnRevenue: 1410, siteExpenses: 360, overheadTotal: 585, expensesTotal: 945, netProfit: 6765,
      perSite: [{ slug: 'relax-tax', name: 'Relax Tax', setupFee: 1200, priceMonthly: 150, monthsActive: 6, lifetimeRevenue: 2100, expensesTotal: 120, netProfit: 1980, onTrial: false }] } },
  sites: [
    demoSite('relax-tax', 'Relax Tax', 'https://relaxtax.vercel.app', 'Kyle', 612, 18, 34, 9, 91, 96, 'B', 150, new Date().getUTCDate()),
    demoSite('apostello-detailing', 'Apostello Detailing', 'https://apostellodetailing.vercel.app', 'Shiloh', 431, 33, 9, 40, 84, 72, 'C', 200, 12),
    demoSite('one-more-thing', 'One More Thing Services', 'https://one-more-thing-gold.vercel.app', 'Angie', 241, -6, 4, -20, 94, 90, 'B', 100, 25),
  ],
  generatedAt: Date.now(),
};

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let path = decodeURIComponent(u.pathname);
  // mirror prod: /api/admin?do=X routes to the X handler
  if (path === '/api/admin' && u.searchParams.get('do')) path = '/api/' + u.searchParams.get('do');

  if (path === '/api/sites') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // strip the admin-only finance block from the public feed (matches prod)
    const { _fin, ...pub } = DEMO.portfolio;
    return res.end(JSON.stringify({ ...DEMO, portfolio: pub }));
  }
  if (path === '/api/card') {
    const s = DEMO.sites.find(x => x.slug === u.searchParams.get('slug')) || DEMO.sites[0];
    const svg = buildCardSVG({ biz: s.name, url: s.url, month: 'September 2026', row: s.history.at(-1), history: s.history, grade: s.grade });
    res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
    return res.end(svg);
  }
  if (path === '/api/public-report') {
    const s = DEMO.sites.find(x => x.slug === u.searchParams.get('slug')) || DEMO.sites[0];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      name: s.name, url: s.url, ready: true, month: 'September 2026', headline: s.report.headline, summary: s.report.summary,
      wins: s.report.wins, improvements: s.improvements, clientActions: s.clientActions, grade: s.grade, scores: s.audit.scores, vitals: s.audit.vitals,
      history: s.history, current: { visitors: s.stats.visitors, conversions: s.stats.conversions, deltas: s.stats.deltas },
      uptime: { up: true, ms: 180 }, cardUrl: `/api/card?slug=${s.slug}`,
    }));
  }
  if (path === '/t.js' || path === '/api/t') {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Access-Control-Allow-Origin': '*' });
    return res.end(TRACKER_JS.replace('__ENDPOINT__', `http://localhost:${PORT}/api/collect`));
  }
  if (path === '/api/site' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const action = body.action || 'save';
    if (action === 'save') {
      const slug = (body.slug || (body.url || body.name || 'site').replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()).slice(0, 48);
      return res.end(JSON.stringify({ ok: true, site: { slug, name: body.name || slug, url: body.url || '', repo: body.repo || '' }, repoMatch: /relax/i.test(body.url || '') ? 'Mondoesanai/relaxtax' : null }));
    }
    return res.end(JSON.stringify({ ok: true }));
  }
  if (path === '/api/collect') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    return res.end('{"ok":true,"message":"reachable (local preview stub)"}');
  }
  if (path === '/api/finances') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const company = {
      activeClients: 2, trialClients: 1, formerClients: 1, totalEver: 4, newThisMonth: 1, churnedThisMonth: 0,
      mrr: 350, arr: 4200, mrrDeltaPct: 16.7, clientsDeltaPct: 0, arpu: 175, ltv: 2400, avgSetupFee: 1200,
      setupToMonthly: 6.9, trialPipelineMrr: 100, revenueConcentrationPct: 57,
      avgClientLifetimeMonths: 6.75, churnRatePct: 25, retentionPct: 75, avgMonthsBeforeChurn: 9, mrrLost: 90,
      lifetimeRevenue: 7710, expensesTotal: 945, overheadTotal: 585, netProfit: 6765, profitMarginPct: 87.7,
      recurringMonthlyCost: 45, costPerClient: 315, overheadRatioPct: 7.6,
      visitorsDriven30: 1284, leadsDriven30: 47, pageviews30: 2800, avgTimeOnSite: 22, avgSeoReady: 90, avgSpeed: 86,
      sitesImproving: 2, sitesDeclining: 1, sitesTracked: 3, sitesTotal: 3, uptimePct: 100, sitesNeedAttention: 1,
      trend: [
        { month: '2026-06', mrr: 200, activeClients: 1, netProfit: 2100 },
        { month: '2026-07', mrr: 250, activeClients: 2, netProfit: 3400 },
        { month: '2026-08', mrr: 300, activeClients: 2, netProfit: 5100 },
      ],
      leadSources: [
        { source: 'Corinth Chamber mixer', clients: 2, active: 2, mrr: 350, lifetime: 4200 },
        { source: 'Referral', clients: 1, active: 1, mrr: 0, lifetime: 800 },
        { source: 'Google search', clients: 1, active: 0, mrr: 0, lifetime: 1410 },
      ],
      aiCost: { total: 41.2, thisMonth: 41.2, months: [{ month: '2026-08', coach: 6, agent: 9, total: 15 }, { month: '2026-09', coach: 8.2, agent: 18, total: 26.2 }] },
      retentionSeries: [
        ...DEMO.sites.map(s => ({
          slug: s.slug, name: s.name, startedAt: s.startedAt, paidFrom: s.startedAt, endedAt: null,
          priceMonthly: s.priceMonthly, setupFee: s.setupFee, status: s.onTrial ? 'trial' : 'active',
          monthsActive: s.monthsActive, lifetimeValue: s.lifetimeRevenue,
        })),
        ..._former.map(c => ({
          slug: c.slug, name: c.name, startedAt: Date.parse(c.leftDate) - c.monthsActive * 30 * 864e5,
          paidFrom: Date.parse(c.leftDate) - c.monthsActive * 30 * 864e5, endedAt: Date.parse(c.leftDate),
          priceMonthly: c.priceMonthly, setupFee: c.setupFee, status: 'former', reason: c.reason, note: c.note,
          monthsActive: c.monthsActive, lifetimeValue: c.lifetimeRevenue,
        })),
      ],
    };
    const clients = DEMO.sites.map(s => ({ slug: s.slug, name: s.name, client: s.client, priceMonthly: s.priceMonthly, setupFee: s.setupFee, startedAt: s.startedAt, monthsWith: 6, status: s.onTrial ? 'trial' : 'active', lifetimeValue: s.lifetimeRevenue, visitors30: s.stats.visitors, leads30: s.stats.conversions, avgDwell: s.stats.avgDwell, deltaVisitors: s.stats.deltas.visitors, seo: s.audit.scores.seo, speed: s.audit.scores.performance, startedThisMonth: false }));
    return res.end(JSON.stringify({ ok: true, company, clients, finances: DEMO.portfolio._fin, overhead: _overhead, trials: _trials, trialMrr: 100, formerClients: _former, churnedCount: 1, mrrLost: 90 }));
  }
  if (path === '/api/receipts') {
    const org = { name: 'Inspiring Websites LLC', addr: '2200 Driskell Drive, Corinth, TX 76210' };
    const income = [
      { id: 'INV-20260314-1', type: 'income', date: '2026-03-14', time: '09:00', counterparty: 'Relax Tax', client: 'Kyle', description: 'Website setup & onboarding — Relax Tax', category: 'Website services', amount: 1200 },
      { id: 'INV-202609-relax-tax', type: 'income', date: '2026-09-14', time: '09:00', counterparty: 'Relax Tax', client: 'Kyle', description: 'Monthly website & SEO management — September 2026', category: 'Recurring services', amount: 150 },
    ];
    const expenses = [
      { id: 'EXP-20260826-1', type: 'expense', date: '2026-08-26', time: '—', counterparty: 'Corinth Chamber of Commerce', description: 'Chamber of Commerce membership (business overhead)', category: 'Dues & memberships', amount: 540 },
      { id: 'EXP-20260909-2', type: 'expense', date: '2026-09-09', time: '—', counterparty: 'Anthropic', description: 'API credits (business overhead)', category: 'Software & subscriptions', amount: 150 },
    ];
    if (u.searchParams.get('one')) {
      const r = [...income, ...expenses].find(x => x.id === u.searchParams.get('one'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(r ? `<h1>${r.id}</h1><p>${r.description} — $${r.amount}</p>` : 'not found');
    }
    if (u.searchParams.get('format') === 'csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv' });
      return res.end('id,type,date,amount\r\n' + [...income, ...expenses].map(r => `${r.id},${r.type},${r.date},${r.amount}`).join('\r\n'));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true, org, income, expenses,
      summary: { year: 2026, grossIncome: 1350, byCategory: { 'Dues & memberships': 540, 'Software & subscriptions': 150 }, totalExpenses: 690, netProfit: 660, estTaxOnProfit: 178, reservedIfTwentyPctRevenue: 270, cushion: 92, quarterlyDue: ['2026-04-15', '2026-06-16', '2026-09-15', '2027-01-15'] },
    }));
  }
  if (path === '/api/agent-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      status: {
        eligible: false,
        reasons: ['GITHUB_TOKEN not set in Vercel (local preview)'],
        spentThisMonth: 3.2, budget: 18, cap: 20,
        keywords: ['mobile detailing corinth tx', 'ceramic coating denton', 'auto detailing near me'],
        lastLog: [{ at: Date.now() - 86400000, action: 'keywords', detail: 'Set 10 target keywords' }],
        ranks: { at: Date.now(), results: [{ keyword: 'ceramic coating denton', rank: 8 }, { keyword: 'mobile detailing corinth tx', rank: 14 }] },
      },
    }));
  }
  if (path === '/api/agent-run') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, skipped: true, reason: 'GITHUB_TOKEN not set in Vercel (local preview stub)' }));
  }
  if (path === '/api/coach' && req.method === 'POST') {
    let raw = '';
    for await (const c of req) raw += c;
    let b = {};
    try { b = JSON.parse(raw || '{}'); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      reply: `(local preview) You asked: "${(b.message || '').slice(0, 80)}". In production I'd answer from your live numbers — MRR, SEO scores, trials, expenses, all of it.`,
      usage: { in: 2200, out: 180, usd: 0.009 },
      today: { spent: 0.09, soft: 0.75 },
      month: { spent: 1.4, cap: 15 },
      warning: null,
    }));
  }
  if (path === '/api/audit') {
    const s = DEMO.sites.find(x => x.url === u.searchParams.get('url')) || DEMO.sites[0];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ url: s.url, ok: true, fetchedAt: Date.now(), scores: s.audit.scores, vitals: s.audit.vitals, checks: {} }));
  }
  if (path === '/api/repos') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      repos: [
        { full_name: 'Mondoesanai/relaxtax', private: false, pushed_at: '2026-09-01', description: 'Relax Tax site' },
        { full_name: 'Mondoesanai/apostellodetailing', private: false, pushed_at: '2026-08-20', description: '' },
        { full_name: 'Mondoesanai/Onemorething', private: false, pushed_at: '2026-08-11', description: '' },
        { full_name: 'Mondoesanai/mondo-davis-website', private: true, pushed_at: '2026-07-02', description: '' },
      ],
      match: (u.searchParams.get('match') || '').includes('relax') ? 'Mondoesanai/relaxtax' : null,
      candidates: [],
    }));
  }
  if (path === '/api/shot') {
    // local preview: 1x1 transparent gif so the layout shows without hitting mShots
    res.writeHead(200, { 'Content-Type': 'image/gif' });
    return res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
  }
  if (path.startsWith('/api/')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true,"demo":true}'); }

  if (path === '/') path = '/index.html';
  if (path.startsWith('/r/')) path = '/r.html';
  try {
    const buf = await readFile(join(PUBLIC, path));
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`Dashboard preview -> http://localhost:${PORT}`));
