// Admin-only. Lifetime sales, expenses, net profit, former clients.
// Kept out of /api/sites so the financial data is never in a public response.
import { listSites } from '../lib/registry.js';
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
  for (const s of sites) {
    const expenses = await readArr(`expenses:${s.slug}`);
    // paid months start when a free trial ends (if there is/was one)
    const paidSince = s.trialEnds && s.trialEnds > (s.startedAt || 0) ? s.trialEnds : s.startedAt;
    const onTrial = !!(s.trialEnds && s.trialEnds > Date.now());
    const monthsActive = onTrial ? 0 : monthsBetween(paidSince);
    const lifetimeRevenue = (s.setupFee || 0) + (s.priceMonthly || 0) * monthsActive;
    const expensesTotal = expenses.reduce((t, e) => t + (Number(e.amount) || 0), 0);
    perSite.push({
      slug: s.slug, name: s.name, setupFee: s.setupFee || 0, priceMonthly: s.priceMonthly || 0,
      monthsActive, lifetimeRevenue, expensesTotal, netProfit: lifetimeRevenue - expensesTotal,
      onTrial,
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

  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(200).json({
    ok: true,
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
