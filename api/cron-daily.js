// Runs once a day (see vercel.json cron).
//   - uptime + SSL-expiry check for every site       -> health:<slug>
//   - on the 1st: snapshot every site's numbers into history (no email)
//   - any site whose billing day is today AND auto-send is on AND has an
//     email + Resend configured: generate + SEND this month's report
//     (deduped via lastSent:<slug>)
import tls from 'node:tls';
import { listSites } from '../lib/registry.js';
import { store } from '../lib/store.js';
import { monthKey } from '../lib/history.js';
import { buildForSite } from './report.js';
import { runAgentCycle, agentStatus } from '../lib/agent.js';

const MK = monthKey();
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

// month-over-month company snapshot so /api/finances can show growth trends
async function snapshotCompany(sites) {
  let mrr = 0, lifetimeRevenue = 0, setupTotal = 0, active = 0, trial = 0, siteExpenses = 0;
  for (const s of sites) {
    const onTrial = !!(s.trialEnds && s.trialEnds > Date.now());
    onTrial ? trial++ : active++;
    const paidSince = s.trialEnds && s.trialEnds > (s.startedAt || 0) ? s.trialEnds : s.startedAt;
    const months = onTrial ? 0 : monthsBetween(paidSince);
    mrr += onTrial ? 0 : s.priceMonthly || 0;
    setupTotal += s.setupFee || 0;
    lifetimeRevenue += (s.setupFee || 0) + (s.priceMonthly || 0) * months;
    const ex = await readArr(`expenses:${s.slug}`);
    siteExpenses += ex.reduce((t, e) => t + (Number(e.amount) || 0), 0);
  }
  const overhead = await readArr('expenses:_business');
  const overheadTotal = overhead.reduce((t, e) => t + (Number(e.amount) || 0), 0);
  let churnRevenue = 0, former = 0;
  try {
    const cs = await store.smembers('churn:index');
    former = cs.length;
    const recs = await store.mget(cs.map((x) => `churn:${x}`));
    churnRevenue = recs
      .map((r) => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; } })
      .filter(Boolean)
      .reduce((t, c) => t + (c.lifetimeRevenue || 0), 0);
  } catch { /* churn optional */ }
  const expensesTotal = siteExpenses + overheadTotal;
  const totalRev = lifetimeRevenue + churnRevenue;
  const snap = {
    month: MK, at: Date.now(),
    mrr, arr: mrr * 12, activeClients: active, trialClients: trial, formerClients: former,
    lifetimeRevenue: totalRev, expensesTotal, netProfit: totalRev - expensesTotal, setupTotal,
  };
  await store.set(`company:snap:${MK}`, JSON.stringify(snap));
  await store.sadd('company:snap:index', MK);
  return snap;
}

function authed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}` || req.query.secret === secret;
}

async function checkHealth(url) {
  const out = { url, up: false, status: 0, ms: null, sslDaysLeft: null, checkedAt: Date.now() };
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(12000) });
    out.status = r.status;
    out.up = r.status < 500;
    out.ms = Date.now() - t0;
  } catch (e) {
    out.error = String(e.message || e);
  }
  try {
    const host = new URL(url).hostname;
    out.sslDaysLeft = await new Promise((resolve) => {
      const sock = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        if (cert && cert.valid_to) {
          resolve(Math.round((new Date(cert.valid_to).getTime() - Date.now()) / 86400000));
        } else resolve(null);
      });
      sock.on('error', () => resolve(null));
      sock.on('timeout', () => {
        sock.destroy();
        resolve(null);
      });
    });
  } catch {
    /* leave null */
  }
  return out;
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ ok: false });

  const sites = await listSites();
  const today = new Date().getUTCDate();
  const isFirst = today === 1;
  const log = [];

  for (const site of sites) {
    // health
    try {
      const h = await checkHealth(site.url);
      await store.set(`health:${site.slug}`, JSON.stringify(h), { ex: 60 * 60 * 30 });
      if (!h.up || (h.sslDaysLeft != null && h.sslDaysLeft < 14)) {
        log.push({ slug: site.slug, alert: !h.up ? `down (${h.status || h.error})` : `SSL expires in ${h.sslDaysLeft}d` });
      }
    } catch (e) {
      log.push({ slug: site.slug, healthError: String(e.message || e) });
    }

    const billingToday = site.billingDay && site.billingDay === today;
    const alreadySent = (await store.get(`lastSent:${site.slug}`).catch(() => null)) === MK;

    if (billingToday && site.autoSend && site.email && process.env.RESEND_API_KEY && !alreadySent) {
      try {
        const r = await buildForSite(site, { doSend: true, req });
        log.push({ slug: site.slug, action: 'billing-day send', sent: r.emailResult?.sent, reason: r.emailResult?.reason });
      } catch (e) {
        log.push({ slug: site.slug, action: 'billing-day send', error: String(e.message || e) });
      }
    } else if (isFirst) {
      try {
        await buildForSite(site, { doSend: false, req });
        log.push({ slug: site.slug, action: 'month snapshot' });
      } catch (e) {
        log.push({ slug: site.slug, action: 'month snapshot', error: String(e.message || e) });
      }
    }
  }

  // company snapshot: on the 1st, or any day it's missing this month
  try {
    const have = await store.get(`company:snap:${MK}`).catch(() => null);
    if (isFirst || !have) {
      const snap = await snapshotCompany(sites);
      log.push({ action: 'company snapshot', mrr: snap.mrr, clients: snap.activeClients });
    }
  } catch (e) {
    log.push({ action: 'company snapshot', error: String(e.message || e) });
  }

  // SEO agent — run a couple of eligible sites per day, rotating by day-of-month
  // so every site gets worked through the week without one cron run timing out.
  try {
    const eligible = [];
    for (const s of sites) {
      const es = await agentStatus(s).catch(() => ({ eligible: false }));
      if (es.eligible) eligible.push(s);
    }
    if (eligible.length) {
      const perDay = 2;
      const start = (today * perDay) % eligible.length;
      const todays = [];
      for (let i = 0; i < Math.min(perDay, eligible.length); i++) todays.push(eligible[(start + i) % eligible.length]);
      for (const s of todays) {
        try {
          const r = await runAgentCycle(s, { manual: false });
          log.push({ slug: s.slug, action: 'seo agent', result: r.action || (r.skipped ? 'skipped' : r.error ? 'error' : 'ok'), pr: r.pr?.prUrl });
        } catch (e) {
          log.push({ slug: s.slug, action: 'seo agent', error: String(e.message || e) });
        }
      }
    }
  } catch (e) {
    log.push({ action: 'seo agent', error: String(e.message || e) });
  }

  res.status(200).json({ ok: true, day: today, isFirst, processed: sites.length, log });
}
