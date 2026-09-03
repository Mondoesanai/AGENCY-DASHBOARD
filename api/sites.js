// Main dashboard feed.
import { listSites } from '../lib/registry.js';
import { runAudit } from '../lib/audit.js';
import { siteStats } from '../lib/stats.js';
import { buildFindings, clientSuggestions, overallGrade } from '../lib/suggestions.js';
import { getHistory } from '../lib/history.js';
import { store } from '../lib/store.js';

async function readNotes(slug) {
  const n = await store.get(`notes:${slug}`).catch(() => null);
  return typeof n === 'string' ? n : '';
}
async function readLog(slug) {
  const raw = await store.get(`changelog:${slug}`).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  const list = await listSites();
  const today = new Date().getUTCDate();

  const rows = await Promise.all(
    list.map(async (site) => {
      const [stats, audit, report, history, notes, changelog] = await Promise.all([
        siteStats(site.slug).catch(() => null),
        runAudit(site.url).catch(() => ({ ok: false, error: 'audit failed' })),
        store.get(`report:${site.slug}:latest`).catch(() => null),
        getHistory(site.slug).catch(() => []),
        readNotes(site.slug),
        readLog(site.slug),
      ]);
      const findings = buildFindings(audit, stats);
      const grade = overallGrade(audit, stats);
      const rep = report ? (typeof report === 'string' ? JSON.parse(report) : report) : null;
      return {
        slug: site.slug,
        name: site.name,
        url: site.url,
        client: site.client || '',
        email: site.email || '',
        phone: site.phone || '',
        priceMonthly: site.priceMonthly || 0,
        leadValue: site.leadValue || 0,
        billingDay: site.billingDay || null,
        autoSend: !!site.autoSend,
        reviewUrl: site.reviewUrl || '',
        source: site.source,
        billingSoon: site.billingDay ? (site.billingDay - today + 31) % 31 <= 3 : false,
        stats,
        audit,
        grade,
        builderFindings: findings,
        clientSuggestions: clientSuggestions(audit, stats),
        openCount: findings.filter((f) => f.severity !== 'good').length,
        history,
        notes,
        changelog,
        report: rep,
      };
    })
  );

  const withData = rows.filter((r) => r.stats?.hasData);
  const portfolio = {
    sites: rows.length,
    visitors30: withData.reduce((t, r) => t + (r.stats?.visitors || 0), 0),
    conversions30: withData.reduce((t, r) => t + (r.stats?.conversions || 0), 0),
    mrr: rows.reduce((t, r) => t + (r.priceMonthly || 0), 0),
    avgSeo: (() => {
      const v = rows.filter((r) => r.audit?.ok).map((r) => r.audit.scores.seo);
      return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null;
    })(),
    improving: withData.filter((r) => (r.stats?.deltas.visitors || 0) >= 10).length,
    openFindings: rows.reduce((t, r) => t + r.openCount, 0),
    attention: rows
      .filter(
        (r) =>
          (r.audit && !r.audit.ok) ||
          (r.grade && r.grade.score < 65) ||
          (r.stats?.hasData && r.stats.deltas.visitors <= -25)
      )
      .map((r) => r.slug),
    auditQuota: rows.some((r) => r.audit && !r.audit.ok && /quota/i.test(r.audit.error || '')),
    backend: store.backend,
  };

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
  res.status(200).json({ portfolio, sites: rows, generatedAt: Date.now() });
}
