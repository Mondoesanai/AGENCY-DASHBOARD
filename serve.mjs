// Local preview: serves public/ and fakes just enough API to see the UI with
// sample data. The real APIs run on Vercel (`npx vercel dev` for the full thing).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCardSVG } from './lib/card.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = process.env.PORT || 3200;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function demoSite(slug, name, url, client, v, dV, c, dC, seo, perf, letter, price, bday) {
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
  const history = months.map((m, i) => ({
    month: m, visitors: Math.round(v * (0.45 + i * 0.16)), conversions: Math.max(0, c - (4 - i)),
    seo: Math.min(100, seo - (4 - i) * 3), grade: { letter, score: seo - 5 },
  }));
  return {
    slug, name, url, client, email: '', phone: '', priceMonthly: price, leadValue: 120,
    billingDay: bday, autoSend: false, reviewUrl: '', source: 'ui', billingSoon: bday === new Date().getUTCDate(),
    stats: {
      hasData: true, visitors: v, pageviews: Math.round(v * 2.2), conversions: c,
      deltas: { visitors: dV, pageviews: dV, conversions: dC },
      device: { mobile: Math.round(v * 0.66), desktop: Math.round(v * 0.34) },
      trend: history.map(h => h.visitors),
      topPages: [{ member: '/', score: Math.round(v * 1.3) }, { member: '/services', score: Math.round(v * 0.5) }, { member: '/contact', score: Math.round(v * 0.3) }],
      sources: [{ member: 'google', score: Math.round(v * 0.5) }, { member: 'direct', score: Math.round(v * 0.35) }, { member: 'social', score: Math.round(v * 0.15) }],
      events: c ? [{ member: 'call', score: Math.round(c * 0.6) }, { member: 'lead-form', score: Math.round(c * 0.4) }] : [],
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
    clientSuggestions: [
      { title: 'Make pages load faster on phones', why: 'Most visitors are on mobile — quicker load, fewer drop-offs.' },
      { title: 'Sharpen how you show up on Google', why: 'Tighter titles and descriptions to lift click-through.' },
      { title: 'Grow your search traffic', why: 'Add service + location pages so new customers find you.' },
    ],
    openCount: 5, history, notes: '', changelog: [{ date: '2026-09-01', text: 'Compressed images, added FAQ section' }],
    report: {
      month: 'September 2026', angle: 'momentum', aiGenerated: false,
      headline: `${name} — momentum is building`,
      summary: `${name} had its best month yet: visitors up ${dV}% and ${c} enquiries came through the site.`,
      wins: [`Visitors: ${history.at(-2).visitors} → ${v} last month (+${dV}%)`, `Your SEO score moved from ${seo - 3} to ${seo}.`, `${c} enquiries this month — roughly $${c * 120} in new business.`],
      clientSuggestions: [{ title: 'Make pages load faster on phones', why: 'Fewer visitors leave before seeing your offer.' }],
      builderExtra: ['Preload the hero font', 'Add width/height to all <img>'],
      email: { subject: `${name} — this month's website progress`, body_text: `Hi ${client},\n\nGood news — ${name}'s website is building momentum.\n\nThis month:\n• Visitors: ${history.at(-2).visitors} → ${v} (+${dV}%)\n• Your SEO score moved from ${seo - 3} to ${seo}.\n• ${c} enquiries — roughly $${c * 120} in new business.\n\nWhat we're working on next:\n• Make pages load faster on phones\n• Sharpen how you show up on Google\n\nYour website is turning into a real source of business.\n\n— Inspiring Websites` },
      reportUrl: `/r/${slug}`,
    },
  };
}

const DEMO = {
  portfolio: { sites: 3, visitors30: 1284, conversions30: 47, mrr: 450, avgSeo: 88, improving: 2, openFindings: 15, attention: [], auditQuota: false, backend: 'demo' },
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

  if (path === '/api/sites') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(DEMO));
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
      name: s.name, url: s.url, month: 'September 2026', headline: s.report.headline, summary: s.report.summary,
      wins: s.report.wins, suggestions: s.clientSuggestions, grade: s.grade, scores: s.audit.scores, vitals: s.audit.vitals,
      history: s.history, current: { visitors: s.stats.visitors, conversions: s.stats.conversions, deltas: s.stats.deltas },
      uptime: { up: true, ms: 180 }, cardUrl: `/api/card?slug=${s.slug}`,
    }));
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
