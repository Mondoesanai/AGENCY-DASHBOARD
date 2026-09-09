// Admin-only. Lifetime sales, expenses, net profit, former clients.
// Kept out of /api/sites so the financial data is never in a public response.
import { listSites } from '../lib/registry.js';
import { siteStats } from '../lib/stats.js';
import { store } from '../lib/store.js';

function authed(req) {
  const s = process.env.CRON_SECRET;
  if (!s) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${s}` || req.query.secret === s;
}

const monthsBetween = (from) => (from ? Math.max(1, Math.round((Date.now() - from) / (30 * 864e5))) : 1);

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
  for (const s of sites) {
    const [expenses, st] = await Promise.all([
      readArr(`expenses:${s.slug}`),
      siteStats(s.slug, s.conversionEvents || []).catch(() => null),
    ]);
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
  const company = {
    activeClients: activeCount,
    trialClients: trialCount,
    formerClients: formerCount,
    totalEver: activeCount + trialCount + formerCount,
    mrr,
    arr: mrr * 12,
    arpu: mrr / payingCount, // avg revenue per paying client / month
    ltv: (mrr / payingCount) * (avgClientLifetimeMonths || 1) + setupTotal / Math.max(1, clients.length + formerCount),
    avgSetupFee: setupTotal / payingCount,
    avgClientLifetimeMonths,
    churnRatePct,
    retentionPct: 100 - churnRatePct,
    avgMonthsBeforeChurn,
    mrrLost: formerClients.reduce((t, c) => t + (c.priceMonthly || 0), 0),
    lifetimeRevenue,
    expensesTotal,
    netProfit: lifetimeRevenue - expensesTotal,
    profitMarginPct: lifetimeRevenue ? ((lifetimeRevenue - expensesTotal) / lifetimeRevenue) * 100 : 0,
    // value delivered to clients (portfolio performance)
    visitorsDriven30: clients.reduce((t, c) => t + c.visitors30, 0),
    leadsDriven30: clients.reduce((t, c) => t + c.leads30, 0),
    avgTimeOnSite: dwells.length ? Math.round(dwells.reduce((a, b) => a + b, 0) / dwells.length) : null,
    sitesImproving: withData.filter((c) => (c.deltaVisitors || 0) >= 10).length,
    sitesDeclining: withData.filter((c) => (c.deltaVisitors || 0) <= -10).length,
    sitesTracked: withData.length,
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
    mrrLost: formerClients.reduce((t, c) => t + (c.priceMonthly || 0), 0),
  });
}
