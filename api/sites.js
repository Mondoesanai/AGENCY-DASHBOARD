// Main dashboard feed: every registered site with its 30-day stats,
// latest audit, computed grade and rule-based findings.
import { SITES } from '../lib/sites.js';
import { runAudit } from '../lib/audit.js';
import { siteStats } from '../lib/stats.js';
import { buildFindings, overallGrade } from '../lib/suggestions.js';
import { store } from '../lib/store.js';

export default async function handler(req, res) {
  const rows = await Promise.all(
    SITES.map(async (site) => {
      const [stats, audit, report] = await Promise.all([
        siteStats(site.slug).catch(() => null),
        runAudit(site.url).catch(() => ({ ok: false, error: 'audit failed' })),
        store.get(`report:${site.slug}:latest`).catch(() => null),
      ]);
      const findings = buildFindings(audit, stats);
      return {
        slug: site.slug,
        name: site.name,
        url: site.url,
        client: site.client,
        hasEmail: !!site.email,
        stats,
        audit,
        grade: overallGrade(audit, stats),
        findings,
        openCount: findings.filter((f) => f.severity !== 'good').length,
        report: report ? (typeof report === 'string' ? JSON.parse(report) : report) : null,
      };
    })
  );

  const withData = rows.filter((r) => r.stats?.hasData);
  const portfolio = {
    sites: rows.length,
    visitors30: withData.reduce((t, r) => t + (r.stats?.visitors || 0), 0),
    conversions30: withData.reduce((t, r) => t + (r.stats?.conversions || 0), 0),
    avgSeo: (() => {
      const v = rows.filter((r) => r.audit?.ok).map((r) => r.audit.scores.seo);
      return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    })(),
    improving: withData.filter((r) => (r.stats?.deltas.visitors || 0) >= 10).length,
    openFindings: rows.reduce((t, r) => t + r.openCount, 0),
    backend: store.backend,
  };

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  res.status(200).json({ portfolio, sites: rows, generatedAt: Date.now() });
}
