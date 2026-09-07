// Main dashboard feed.
import { listSites } from '../lib/registry.js';
import { runAudit } from '../lib/audit.js';
import { siteStats } from '../lib/stats.js';
import { buildFindings, clientActions, improvementsForClient, overallGrade } from '../lib/suggestions.js';
import { getHistory } from '../lib/history.js';
import { reportToken } from '../lib/token.js';
import { store } from '../lib/store.js';

async function readNotes(slug) {
  const n = await store.get(`notes:${slug}`).catch(() => null);
  return typeof n === 'string' ? n : '';
}
async function readArr(key) {
  const raw = await store.get(key).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
const readLog = (slug) => readArr(`changelog:${slug}`);

const monthsBetween = (from) => {
  if (!from) return 1;
  return Math.max(1, Math.round((Date.now() - from) / (30 * 864e5)));
};

export default async function handler(req, res) {
  const list = await listSites();
  const today = new Date().getUTCDate();

  const rows = await Promise.all(
    list.map(async (site) => {
      const [stats, audit, report, history, notes, changelog, expenses] = await Promise.all([
        siteStats(site.slug, site.conversionEvents || []).catch(() => null),
        runAudit(site.url).catch(() => ({ ok: false, error: 'audit failed' })),
        store.get(`report:${site.slug}:latest`).catch(() => null),
        getHistory(site.slug).catch(() => []),
        readNotes(site.slug),
        readLog(site.slug),
        readArr(`expenses:${site.slug}`),
      ]);
      const monthsActive = monthsBetween(site.startedAt);
      const lifetimeRevenue = (site.setupFee || 0) + (site.priceMonthly || 0) * monthsActive;
      const expensesTotal = expenses.reduce((t, e) => t + (Number(e.amount) || 0), 0);
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
        setupFee: site.setupFee || 0,
        startedAt: site.startedAt || 0,
        monthsActive,
        lifetimeRevenue,
        expenses,
        expensesTotal,
        netProfit: lifetimeRevenue - expensesTotal,
        leadValue: site.leadValue || 0,
        billingDay: site.billingDay || null,
        autoSend: !!site.autoSend,
        reviewUrl: site.reviewUrl || '',
        conversionEvents: site.conversionEvents || [],
        source: site.source,
        lastSeen: site.lastSeen || 0,
        // tracker is "installed" if any beacon has landed in the last 21 days
        // (or we already have visit data). New sites with no visits yet =>
        // "awaiting first visit", not "no tracker".
        hasTracker: !!(
          (site.lastSeen && Date.now() - site.lastSeen < 21 * 864e5) ||
          (stats && (stats.hasData || (stats.events && stats.events.length)))
        ),
        awaitingData: !!(
          !stats?.hasData &&
          !(stats?.events && stats.events.length) &&
          site.lastSeen &&
          Date.now() - site.lastSeen < 21 * 864e5
        ),
        reportUrl: `/r/${site.slug}?t=${reportToken(site.slug)}`,
        billingSoon: site.billingDay ? (site.billingDay - today + 31) % 31 <= 3 : false,
        stats,
        audit,
        grade,
        builderFindings: findings,
        clientActions: clientActions(audit, stats, site),
        improvements: improvementsForClient(audit, stats),
        openCount: findings.filter((f) => f.severity !== 'good').length,
        history,
        notes,
        changelog,
        report: rep,
      };
    })
  );

  // former clients (churn records survive site deletion)
  let formerClients = [];
  try {
    const churnSlugs = await store.smembers('churn:index');
    if (churnSlugs.length) {
      const recs = await store.mget(churnSlugs.map((s) => `churn:${s}`));
      formerClients = recs
        .map((r) => {
          try {
            return typeof r === 'string' ? JSON.parse(r) : r;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0));
    }
  } catch {
    /* churn optional */
  }

  const withData = rows.filter((r) => r.stats?.hasData);
  const mrr = rows.reduce((t, r) => t + (r.priceMonthly || 0), 0);
  const lifetimeRevenue = rows.reduce((t, r) => t + (r.lifetimeRevenue || 0), 0);
  const setupTotal = rows.reduce((t, r) => t + (r.setupFee || 0), 0);
  const expensesTotal = rows.reduce((t, r) => t + (r.expensesTotal || 0), 0);
  const churnRevenue = formerClients.reduce((t, c) => t + (c.lifetimeRevenue || 0), 0);
  const portfolio = {
    sites: rows.length,
    visitors30: withData.reduce((t, r) => t + (r.stats?.visitors || 0), 0),
    conversions30: withData.reduce((t, r) => t + (r.stats?.conversions || 0), 0),
    mrr,
    finances: {
      mrr,
      annualRunRate: mrr * 12,
      setupTotal,
      recurringToDate: lifetimeRevenue - setupTotal,
      lifetimeRevenue: lifetimeRevenue + churnRevenue,
      activeRevenue: lifetimeRevenue,
      churnRevenue,
      expensesTotal,
      netProfit: lifetimeRevenue + churnRevenue - expensesTotal,
      perSite: rows
        .map((r) => ({
          slug: r.slug, name: r.name, setupFee: r.setupFee, priceMonthly: r.priceMonthly,
          monthsActive: r.monthsActive, lifetimeRevenue: r.lifetimeRevenue,
          expensesTotal: r.expensesTotal, netProfit: r.netProfit,
        }))
        .sort((a, b) => b.lifetimeRevenue - a.lifetimeRevenue),
    },
    formerClients,
    churnedCount: formerClients.length,
    mrrLost: formerClients.reduce((t, c) => t + (c.priceMonthly || 0), 0),
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
    noTracker: rows.filter((r) => !r.hasTracker).map((r) => r.slug),
    emailEnabled: !!process.env.RESEND_API_KEY,
    aiEnabled: !!process.env.ANTHROPIC_API_KEY,
    backend: store.backend,
  };

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({ portfolio, sites: rows, generatedAt: Date.now() });
}
