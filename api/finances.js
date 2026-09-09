// Admin-only. Lifetime sales, expenses, net profit, former clients.
// Kept out of /api/sites so the financial data is never in a public response.
import { listSites } from '../lib/registry.js';
import { siteStats } from '../lib/stats.js';
import { runAudit } from '../lib/audit.js';
import { store } from '../lib/store.js';

const THIS_MONTH = new Date().toISOString().slice(0, 7);

function authed(req) {
  const s = process.env.CRON_SECRET;
  if (!s) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${s}` || req.query.secret === s;
}

const monthsBetween = (from) => (from ? Math.max(1, Math.round((Date.now() - from) / (30 * 864e5))) : 1);

// cached audit only — don't let a cold PageSpeed call stall the whole panel
const cachedAudit = (url) =>
  Promise.race([
    runAudit(url).catch(() => ({ ok: false })),
    new Promise((r) => setTimeout(() => r({ ok: false }), 7000)),
  ]);

async function readArr(key) {
  const raw = await store.get(key).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad secret' });

  const sites = await listSites();
  const perSite = [];
  const trials = [];
  const clients = [];
  let pageviews30 = 0, upCount = 0, healthChecked = 0, needAttention = 0;
  for (const s of sites) {
    const [expenses, st, auditC, healthRaw] = await Promise.all([
      readArr(`expenses:${s.slug}`),
      siteStats(s.slug, s.conversionEvents || []).catch(() => null),
      cachedAudit(s.url),
      store.get(`health:${s.slug}`).catch(() => null),
    ]);
    pageviews30 += st?.pageviews || 0;
    try {
      const h = typeof healthRaw === 'string' ? JSON.parse(healthRaw) : healthRaw;
      if (h) { healthChecked++; if (h.up) upCount++; if (h.sslDaysLeft != null && h.sslDaysLeft < 14) needAttention++; }
    } catch { /* skip */ }
    if (!auditC?.ok || (auditC.scores && auditC.scores.seo < 65)) needAttention++;
    // paid months start when a free trial ends (if there is/was one)
    const paidSince = s.trialEnds && s.trialEnds > (s.startedAt || 0) ? s.trialEnds : s.startedAt;
    const onTrial = !!(s.trialEnds && s.trialEnds > Date.now());
    const monthsActive = onTrial ? 0 : monthsBetween(paidSince);
    const monthsWith = monthsBetween(s.startedAt); // total relationship length incl. trial
    const lifetimeRevenue = (s.setupFee || 0) + (s.priceMonthly || 0) * monthsActive;
    const expensesTotal = expenses.reduce((t, e) => t + (Number(e.amount) || 0), 0);
    perSite.push({
      slug: s.slug, name: s.name, setupFee: s.setupFee || 0, priceMonthly: s.priceMonthly || 0,
      monthsActive, lifetimeRevenue, expensesTotal, netProfit: lifetimeRevenue - expensesTotal,
      onTrial,
    });
    clients.push({
      slug: s.slug, name: s.name, client: s.client || '',
      priceMonthly: s.priceMonthly || 0, setupFee: s.setupFee || 0,
      startedAt: s.startedAt || 0, monthsWith,
      status: onTrial ? 'trial' : 'active',
      lifetimeValue: lifetimeRevenue,
      visitors30: st?.visitors || 0,
      leads30: st?.conversions || 0,
      avgDwell: st?.avgDwell ?? null,
      deltaVisitors: st?.deltas?.visitors ?? null,
      seo: auditC?.ok ? auditC.scores.seo : null,
      speed: auditC?.ok ? auditC.scores.performance : null,
      startedThisMonth: !!(s.startedAt && new Date(s.startedAt).toISOString().slice(0, 7) === THIS_MONTH),
    });
    if (onTrial) {
      trials.push({
        slug: s.slug, name: s.name, priceMonthly: s.priceMonthly || 0,
        autoChargeDate: new Date(s.trialEnds).toISOString().slice(0, 10),
        daysLeft: Math.ceil((s.trialEnds - Date.now()) / 864e5),
      });
    }
  }
  trials.sort((a, b) => a.daysLeft - b.daysLeft);
  clients.sort((a, b) => b.lifetimeValue - a.lifetimeValue);

  const overhead = await readArr('expenses:_business');
  const overheadTotal = overhead.reduce((t, e) => t + (Number(e.amount) || 0), 0);

  let formerClients = [];
  try {
    const cs = await store.smembers('churn:index');
    if (cs.length) {
      const recs = await store.mget(cs.map((x) => `churn:${x}`));
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

  const mrr = perSite.reduce((t, r) => t + (r.onTrial ? 0 : r.priceMonthly), 0);
  const setupTotal = perSite.reduce((t, r) => t + r.setupFee, 0);
  const activeRevenue = perSite.reduce((t, r) => t + r.lifetimeRevenue, 0);
  const siteExpenses = perSite.reduce((t, r) => t + r.expensesTotal, 0);
  const expensesTotal = siteExpenses + overheadTotal;
  const churnRevenue = formerClients.reduce((t, c) => t + (c.lifetimeRevenue || 0), 0);
  const lifetimeRevenue = activeRevenue + churnRevenue;

  // ---- company / operating stats ----
  const activeCount = clients.filter((c) => c.status === 'active').length;
  const trialCount = clients.filter((c) => c.status === 'trial').length;
  const formerCount = formerClients.length;
  const payingCount = Math.max(1, activeCount);
  const allMonths =
    clients.reduce((t, c) => t + (c.monthsWith || 0), 0) +
    formerClients.reduce((t, c) => t + (c.monthsActive || 0), 0);
  const avgClientLifetimeMonths = (clients.length + formerCount) ? allMonths / (clients.length + formerCount) : 0;
  const churnRatePct = (activeCount + trialCount + formerCount) ? (formerCount / (activeCount + trialCount + formerCount)) * 100 : 0;
  const avgMonthsBeforeChurn = formerCount ? formerClients.reduce((t, c) => t + (c.monthsActive || 0), 0) / formerCount : 0;
  const dwells = clients.map((c) => c.avgDwell).filter((v) => v != null);
  const withData = clients.filter((c) => c.visitors30 > 0);
  const seos = clients.map((c) => c.seo).filter((v) => v != null);
  const speeds = clients.map((c) => c.speed).filter((v) => v != null);
  const mrrLost = formerClients.reduce((t, c) => t + (c.priceMonthly || 0), 0);
  const netProfit = lifetimeRevenue - expensesTotal;

  // month-over-month trend from the daily-cron company snapshots
  let trend = [];
  try {
    const months = (await store.smembers('company:snap:index')).sort();
    if (months.length) {
      const raws = await store.mget(months.map((m) => `company:snap:${m}`));
      trend = raws
        .map((r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; } })
        .filter(Boolean)
        .filter((s) => s.month !== THIS_MONTH) // exclude the in-progress month
        .slice(-6);
    }
  } catch { /* snapshots optional */ }
  const prev = trend.length ? trend[trend.length - 1] : null;
  const pct = (now, was) => (was ? ((now - was) / was) * 100 : now ? 100 : 0);

  // recurring monthly cost = recurring overhead + recurring per-client expenses
  const recurringOverhead = overhead.filter((e) => e.recurring).reduce((t, e) => t + (Number(e.amount) || 0), 0);
  const topClientMrr = Math.max(0, ...clients.filter((c) => c.status === 'active').map((c) => c.priceMonthly));

  const company = {
    // clients
    activeClients: activeCount,
    trialClients: trialCount,
    formerClients: formerCount,
    totalEver: activeCount + trialCount + formerCount,
    newThisMonth: clients.filter((c) => c.startedThisMonth).length,
    churnedThisMonth: formerClients.filter((c) => (c.leftDate || '').slice(0, 7) === THIS_MONTH).length,
    // revenue
    mrr,
    arr: mrr * 12,
    mrrDeltaPct: prev ? pct(mrr, prev.mrr) : null,
    clientsDeltaPct: prev ? pct(activeCount, prev.activeClients) : null,
    arpu: mrr / payingCount,
    ltv: (mrr / payingCount) * (avgClientLifetimeMonths || 1) + setupTotal / Math.max(1, clients.length + formerCount),
    avgSetupFee: setupTotal / payingCount,
    setupToMonthly: mrr ? setupTotal / clients.length / (mrr / payingCount || 1) : 0, // setup covers ~N months
    trialPipelineMrr: trials.reduce((t, x) => t + x.priceMonthly, 0),
    revenueConcentrationPct: mrr ? (topClientMrr / mrr) * 100 : 0,
    // retention
    avgClientLifetimeMonths,
    churnRatePct,
    retentionPct: 100 - churnRatePct,
    avgMonthsBeforeChurn,
    mrrLost,
    // profit
    lifetimeRevenue,
    expensesTotal,
    overheadTotal,
    netProfit,
    profitMarginPct: lifetimeRevenue ? (netProfit / lifetimeRevenue) * 100 : 0,
    recurringMonthlyCost: recurringOverhead,
    costPerClient: expensesTotal / Math.max(1, activeCount + formerCount),
    overheadRatioPct: lifetimeRevenue ? (overheadTotal / lifetimeRevenue) * 100 : 0,
    // value delivered to clients (portfolio performance)
    visitorsDriven30: clients.reduce((t, c) => t + c.visitors30, 0),
    leadsDriven30: clients.reduce((t, c) => t + c.leads30, 0),
    pageviews30,
    avgTimeOnSite: dwells.length ? Math.round(dwells.reduce((a, b) => a + b, 0) / dwells.length) : null,
    avgSeoReady: seos.length ? Math.round(seos.reduce((a, b) => a + b, 0) / seos.length) : null,
    avgSpeed: speeds.length ? Math.round(speeds.reduce((a, b) => a + b, 0) / speeds.length) : null,
    sitesImproving: withData.filter((c) => (c.deltaVisitors || 0) >= 10).length,
    sitesDeclining: withData.filter((c) => (c.deltaVisitors || 0) <= -10).length,
    sitesTracked: withData.length,
    sitesTotal: sites.length,
    uptimePct: healthChecked ? Math.round((upCount / healthChecked) * 100) : null,
    sitesNeedAttention: needAttention,
    trend, // last ~6 months: [{month, mrr, activeClients, netProfit, ...}]
  };

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    ok: true,
    company,
    clients,
    finances: {
      mrr,
      annualRunRate: mrr * 12,
      setupTotal,
      recurringToDate: activeRevenue - setupTotal,
      lifetimeRevenue,
      activeRevenue,
      churnRevenue,
      siteExpenses,
      overheadTotal,
      expensesTotal,
      netProfit: lifetimeRevenue - expensesTotal,
      perSite: perSite.sort((a, b) => b.lifetimeRevenue - a.lifetimeRevenue),
    },
    overhead,
    trials,
    trialMrr: trials.reduce((t, x) => t + x.priceMonthly, 0),
    formerClients,
    churnedCount: formerClients.length,
    mrrLost,
  });
}
