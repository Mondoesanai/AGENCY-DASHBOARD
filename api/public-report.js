// Client-safe slice of a site's data for the shareable /r/<slug> page.
// Deliberately omits builder notes, client contact details, pricing and the
// blunt technical findings.
import { listSites } from '../lib/registry.js';
import { getHistory } from '../lib/history.js';
import { runAudit } from '../lib/audit.js';
import { siteStats } from '../lib/stats.js';
import { clientActions, improvementsForClient, overallGrade } from '../lib/suggestions.js';
import { tokenOk } from '../lib/token.js';
import { store } from '../lib/store.js';

export default async function handler(req, res) {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'missing slug' });
  if (!tokenOk(slug, req.query.t)) return res.status(403).json({ error: 'this report link is not valid' });

  const site = (await listSites()).find((s) => s.slug === slug);
  if (!site) return res.status(404).json({ error: 'not found' });

  const [history, reportRaw, stats, audit, healthRaw] = await Promise.all([
    getHistory(slug).catch(() => []),
    store.get(`report:${slug}:latest`).catch(() => null),
    siteStats(slug, site.conversionEvents || []).catch(() => null),
    runAudit(site.url).catch(() => ({ ok: false })),
    store.get(`health:${slug}`).catch(() => null),
  ]);
  const report = reportRaw ? (typeof reportRaw === 'string' ? JSON.parse(reportRaw) : reportRaw) : null;
  const health = healthRaw ? (typeof healthRaw === 'string' ? JSON.parse(healthRaw) : healthRaw) : null;

  // one fresh attempt if the cached audit is a stale failure
  let liveAudit = audit;
  if (!liveAudit || !liveAudit.ok) {
    liveAudit = await runAudit(site.url, { fresh: true }).catch(() => liveAudit || { ok: false });
  }
  const lastRow = history && history.length ? history[history.length - 1] : null;

  // scores: fresh audit -> last history snapshot -> last saved report metrics
  let scores = null;
  if (liveAudit?.ok) {
    scores = liveAudit.scores;
  } else {
    const seo = lastRow?.seo ?? report?.metrics?.seo ?? null;
    const perf = lastRow?.perf ?? report?.metrics?.perf ?? null;
    if (seo != null || perf != null) scores = { seo, performance: perf, accessibility: null, bestPractices: null };
  }
  const grade = overallGrade(liveAudit, stats) || report?.grade || lastRow?.grade || null;
  const ready = !!(report || (scores && scores.seo != null) || (stats && stats.hasData));

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  res.status(200).json({
    name: site.name,
    url: site.url,
    ready,
    month: report?.month || new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    headline: report?.headline || `${site.name} — website performance`,
    summary: report?.summary || '',
    wins: report?.wins || [],
    improvements: report?.improvements || improvementsForClient(liveAudit, stats),
    clientActions: report?.clientActions || clientActions(liveAudit, stats, site),
    grade,
    scores,
    vitals: liveAudit?.ok ? liveAudit.vitals : null,
    history: (history || []).map((h) => ({
      month: h.month,
      visitors: h.visitors,
      conversions: h.conversions,
      seo: h.seo,
    })),
    current: {
      visitors: stats?.visitors ?? (history.at(-1)?.visitors || 0),
      conversions: stats?.conversions ?? (history.at(-1)?.conversions || 0),
      deltas: stats?.deltas || null,
    },
    uptime: health ? { up: health.up, ms: health.ms } : null,
    cardUrl: `/api/card?slug=${encodeURIComponent(slug)}`,
  });
}
