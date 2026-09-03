// Monthly report card image.  /api/card?slug=relax-tax  ->  PNG (falls back to
// SVG if sharp is unavailable). Non-sensitive — safe to link in an email.
import { listSites } from '../lib/registry.js';
import { getHistory } from '../lib/history.js';
import { siteStats } from '../lib/stats.js';
import { runAudit } from '../lib/audit.js';
import { overallGrade } from '../lib/suggestions.js';
import { buildCardSVG, renderPNG } from '../lib/card.js';

const MONTH_LABEL = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });

export default async function handler(req, res) {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'missing slug' });

  const site = (await listSites()).find((s) => s.slug === slug);
  if (!site) return res.status(404).json({ error: 'unknown slug' });

  const history = await getHistory(slug).catch(() => []);
  let row = history.length ? history[history.length - 1] : null;

  if (!row) {
    const [stats, audit] = await Promise.all([
      siteStats(slug).catch(() => null),
      runAudit(site.url).catch(() => ({ ok: false })),
    ]);
    const g = overallGrade(audit, stats);
    row = {
      seo: audit?.ok ? audit.scores.seo : null,
      perf: audit?.ok ? audit.scores.performance : null,
      visitors: stats?.visitors || 0,
      conversions: stats?.conversions || 0,
      grade: g,
    };
  }
  const grade = row.grade || (row.seo != null ? overallGrade({ ok: true, scores: { seo: row.seo, performance: row.perf ?? row.seo, accessibility: 90, bestPractices: 90 } }, null) : null);

  const svg = buildCardSVG({
    biz: site.name,
    url: site.url,
    month: MONTH_LABEL,
    row,
    history,
    grade,
  });

  const png = await renderPNG(svg);
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  if (png) {
    res.setHeader('Content-Type', 'image/png');
    return res.status(200).send(png);
  }
  res.setHeader('Content-Type', 'image/svg+xml');
  res.status(200).send(svg);
}
