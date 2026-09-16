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
import { upsellState, sendUpsell } from '../lib/upsell.js';
import { todosState, refreshTodos } from '../lib/todos.js';

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

  const t0 = Date.now();
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

  // SEO agent — rotates through eligible sites by day-of-month, one at a time,
  // and only starts a site's cycle if there's a safe amount of wall-clock left.
  // Vercel hard-caps this whole function at 60s; health checks + billing sends
  // above already spend part of that, and a single agent cycle (rank check +
  // a technical fix + a GitHub commit) can itself take 20-40s. The previous
  // version tried 2 sites per run unconditionally, regularly blew past 60s,
  // and got hard-killed by the platform — silently, with nothing logged —
  // which is why nothing was happening day to day despite being "scheduled."
  const HARD_LIMIT_MS = 58000;
  const PER_SITE_BUDGET_MS = 40000;
  try {
    const eligible = [];
    for (const s of sites) {
      const es = await agentStatus(s).catch(() => ({ eligible: false }));
      if (es.eligible) eligible.push(s);
    }
    if (!eligible.length) {
      log.push({ action: 'seo agent', skipped: true, reason: 'no eligible sites' });
    } else {
      let ran = 0;
      for (let i = 0; i < eligible.length; i++) {
        if (Date.now() - t0 > HARD_LIMIT_MS - PER_SITE_BUDGET_MS) {
          log.push({ action: 'seo agent', skipped: true, reason: `stopped after ${ran} site(s) — out of safe time budget this run, continues next run` });
          break;
        }
        const s = eligible[(today + i) % eligible.length];
        try {
          const r = await runAgentCycle(s, { manual: false });
          log.push({ slug: s.slug, action: 'seo agent', result: r.action || (r.skipped ? 'skipped' : r.error ? 'error' : 'ok'), pr: r.pr?.prUrl, reason: r.reason });
        } catch (e) {
          log.push({ slug: s.slug, action: 'seo agent', error: String(e.message || e) });
        }
        ran++;
        if (ran >= 3) break; // even with room to spare, don't run more than 3 in one invocation
      }
    }
  } catch (e) {
    log.push({ action: 'seo agent', error: String(e.message || e) });
  }

  // AI-curated to-dos — every site (doesn't need GitHub, just the Anthropic
  // key), refreshed every 14 days. One stale site per run, same time-budget
  // guard as the SEO agent above so this can never be what pushes a run past
  // the 60s ceiling.
  try {
    if (Date.now() - t0 < HARD_LIMIT_MS - 15000) {
      const due = [];
      for (const s of sites) {
        const ts = await todosState(s).catch(() => ({ stale: false }));
        if (ts.stale) due.push(s);
      }
      const s = due[today % Math.max(1, due.length)];
      if (s) {
        const r = await refreshTodos(s);
        log.push({ slug: s.slug, action: 'todos', result: r.ok ? `${r.items.length} to-dos, ${r.addressed?.length || 0} addressed` : r.error });
      }
    } else {
      log.push({ action: 'todos', skipped: true, reason: 'out of time budget this run' });
    }
  } catch (e) {
    log.push({ action: 'todos', error: String(e.message || e) });
  }

  // 6-month upsell: flag every eligible client; auto-send only if UPSELL_AUTO=1
  try {
    for (const site of sites) {
      const us = await upsellState(site).catch(() => ({ eligible: false }));
      if (!us.eligible) continue;
      if (process.env.UPSELL_AUTO === '1' && process.env.RESEND_API_KEY && site.email) {
        const r = await sendUpsell(site);
        log.push({ slug: site.slug, action: 'upsell', sent: r.sent, reason: r.reason });
      } else {
        await store.set(`upsell:ready:${site.slug}`, String(Date.now()));
        log.push({ slug: site.slug, action: 'upsell', ready: true });
      }
    }
  } catch (e) {
    log.push({ action: 'upsell', error: String(e.message || e) });
  }

  res.status(200).json({ ok: true, day: today, isFirst, processed: sites.length, log });
}
