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
import { refreshRanksIfStale } from '../lib/agent.js';
import { upsellState, sendUpsell } from '../lib/upsell.js';
import { sendWinsRecap } from '../lib/winsrecap.js';
import { todosState, refreshTodos } from '../lib/todos.js';
import { checkRevisionInbox } from '../lib/revisions.js';
import { sendHealthAlert } from '../lib/alerts.js';

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

async function checkHealth(url, { skipSsl } = {}) {
  const out = { url, up: false, status: 0, ms: null, sslDaysLeft: null, checkedAt: Date.now() };
  const t0 = Date.now();
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(6000) });
    out.status = r.status;
    out.up = r.status < 500;
    out.ms = Date.now() - t0;
  } catch (e) {
    out.error = String(e.message || e);
  }
  if (skipSsl) return out;
  try {
    const host = new URL(url).hostname;
    out.sslDaysLeft = await new Promise((resolve) => {
      const sock = tls.connect({ host, port: 443, servername: host, timeout: 5000 }, () => {
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

  // Health + billing/snapshot used to run one site at a time — with fetch
  // (up to 12s) and a raw TLS connect for the SSL check (up to 8s) EACH,
  // sequentially, this alone could burn 15-20+ seconds per slow/unresponsive
  // site. With the SEO-agent section below only getting a shot at starting
  // work in the first 18s of the whole 58s budget, a single slow site here
  // was enough to eat that window before any SEO/revision work ever got a
  // turn — silently, day after day, which is exactly "hasn't run in days."
  // Now runs every site in parallel (bounded by the slowest one, not the
  // sum of all of them), with tighter timeouts, and skips the slow TLS/SSL
  // check on any site checked within the last 5 days — certs don't expire
  // that fast, no need to re-verify on every single run.
  await Promise.all(
    sites.map(async (site) => {
      try {
        const cachedRaw = await store.get(`health:${site.slug}`).catch(() => null);
        let cached = null;
        try {
          cached = cachedRaw ? (typeof cachedRaw === 'string' ? JSON.parse(cachedRaw) : cachedRaw) : null;
        } catch {
          /* treat as no cache */
        }
        const sslFresh = cached?.sslDaysLeft != null && cached.checkedAt && Date.now() - cached.checkedAt < 5 * 86400000;
        const h = await checkHealth(site.url, { skipSsl: sslFresh });
        if (sslFresh) h.sslDaysLeft = cached.sslDaysLeft;
        await store.set(`health:${site.slug}`, JSON.stringify(h), { ex: 60 * 60 * 30 });
        if (!h.up || (h.sslDaysLeft != null && h.sslDaysLeft < 14)) {
          log.push({ slug: site.slug, alert: !h.up ? `down (${h.status || h.error})` : `SSL expires in ${h.sslDaysLeft}d` });
        }
      } catch (e) {
        log.push({ slug: site.slug, healthError: String(e.message || e) });
      }

      // Report sends. Monthly clients get one on their billing day; biweekly
      // clients (site.reportEvery === 'biweekly') get a second one ~14 days
      // later. "Due" means: it's the send day or up to 5 days after it and it
      // hasn't gone out yet this month — so a missed run (the exact-day match
      // used to silently skip a client's whole month) catches up on the next.
      const inWindow = (day) => day && today >= day && today - day <= 5;
      const biweekly = site.reportEvery === 'biweekly';
      const day1 = site.billingDay || null;
      const day2 = biweekly && day1 ? ((day1 + 13) % 28) + 1 : null;
      const sent1 = (await store.get(`lastSent:${site.slug}`).catch(() => null)) === MK;
      const sent2 = biweekly ? (await store.get(`lastSent2:${site.slug}`).catch(() => null)) === MK : true;
      const canSend = site.autoSend && site.email && process.env.RESEND_API_KEY;
      const due1 = inWindow(day1) && !sent1;
      const due2 = biweekly && inWindow(day2) && !sent2;

      if (canSend && (due1 || due2)) {
        // if both windows overlap (billing day near the 28th wrap), send once
        const which = due1 ? 1 : 2;
        try {
          const r = await buildForSite(site, { doSend: true, req, period: biweekly ? 'biweekly' : 'monthly', sentKey: which === 2 ? `lastSent2:${site.slug}` : null });
          log.push({ slug: site.slug, action: which === 2 ? 'biweekly send' : 'billing-day send', sent: r.emailResult?.sent, reason: r.emailResult?.reason });
        } catch (e) {
          log.push({ slug: site.slug, action: 'report send', error: String(e.message || e) });
        }
      } else if (isFirst) {
        try {
          await buildForSite(site, { doSend: false, req });
          log.push({ slug: site.slug, action: 'month snapshot' });
        } catch (e) {
          log.push({ slug: site.slug, action: 'month snapshot', error: String(e.message || e) });
        }
      }

      // two short "wins recap" emails a month, in addition to the formal
      // monthly report — spread away from the billing day so clients hear
      // from us more than once a month without it becoming a second report.
      // Same autoSend opt-in as the report; skips quietly if there's
      // nothing new to recap that window (see lib/winsrecap.js).
      if (site.autoSend && site.email && process.env.RESEND_API_KEY && !biweekly) {
        const base = site.billingDay || 1;
        const recapDays = [
          [1, ((base + 10 - 1) % 28) + 1],
          [2, ((base + 20 - 1) % 28) + 1],
        ];
        for (const [n, day] of recapDays) {
          if (today !== day) continue;
          const recapKey = `winsRecapSent:${site.slug}:${MK}:${n}`;
          const already = await store.get(recapKey).catch(() => null);
          if (already) continue;
          try {
            const r = await sendWinsRecap(site);
            if (r.sent) await store.set(recapKey, '1', { ex: 60 * 60 * 24 * 45 });
            log.push({ slug: site.slug, action: `wins recap ${n}`, sent: r.sent, reason: r.reason });
          } catch (e) {
            log.push({ slug: site.slug, action: `wins recap ${n}`, error: String(e.message || e) });
          }
        }
      }

      // Real Google ranking, refreshed on its own reliable cadence — decoupled
      // from the technical-fix rotation below, which can lose its turn for
      // weeks to budget caps, pacing, or a pending revision jumping the
      // queue. Ranking freshness shouldn't have to wait on any of that.
      try {
        const r = await refreshRanksIfStale(site);
        if (r.ok && !r.skipped) log.push({ slug: site.slug, action: 'rank refresh', inTop10: r.ranks?.inTop10 });
        else if (!r.ok) log.push({ slug: site.slug, action: 'rank refresh', error: r.error });
      } catch (e) {
        log.push({ slug: site.slug, action: 'rank refresh', error: String(e.message || e) });
      }
    })
  );

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

  // SEO agent cycles are NOT run here any more. The automation tick
  // (lib/tick.js, every few minutes-to-hours from three triggers) does that with a
  // hard deadline; a cycle started inside this 60s pass could overrun it and
  // take the rest of the daily work (billing emails, health alert, heartbeat)
  // down with it, silently.

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

  // revisions inbox — the real-time path is GitHub Actions polling every
  // ~10 min (see .github/workflows/check-revisions.yml), but that depends on
  // an external scheduler. This is the guaranteed floor: worst case, a
  // client-requested revision is never more than a day from being picked up,
  // even if GitHub's cron never fires at all. Hands over only the time
  // actually left in this invocation (checkRevisionInbox has its own 50s
  // default budget, which would blow past Vercel's 60s ceiling stacked on
  // top of everything already done above).
  try {
    const remaining = HARD_LIMIT_MS - (Date.now() - t0) - 4000; // 4s safety margin for the final res.json
    if (remaining > 15000) {
      const r = await checkRevisionInbox({ maxMs: remaining });
      log.push({ action: 'revisions', result: r.ok ? `checked ${r.checked}, ${r.tickets} new` : r.error });
    } else {
      log.push({ action: 'revisions', skipped: true, reason: 'out of time budget this run — GitHub Actions/Refresh still cover it' });
    }
  } catch (e) {
    log.push({ action: 'revisions', error: String(e.message || e) });
  }

  // real signal for "is the daily automation actually running" — nothing
  // else recorded this anywhere, so a multi-day silent outage (like the
  // health-check-eats-the-budget bug) had no way to be noticed except by
  // seeing SEO stop happening days later.
  await store.set('cron:daily:lastRun', String(Date.now()), { ex: 60 * 60 * 24 * 45 }).catch(() => {});

  // one email a day, only when there's actually something worth seeing —
  // this is the approved alert feature, deduped per calendar day so an
  // overlapping/retried cron run can't send it twice.
  try {
    const alertKey = `alert:sent:${MK}:${today}`;
    const already = await store.get(alertKey).catch(() => null);
    if (!already) {
      const r = await sendHealthAlert();
      if (r.sent) await store.set(alertKey, '1', { ex: 60 * 60 * 24 * 3 });
      log.push({ action: 'health alert', sent: r.sent, reason: r.reason, count: r.count });
    }
  } catch (e) {
    log.push({ action: 'health alert', error: String(e.message || e) });
  }

  res.status(200).json({ ok: true, day: today, isFirst, processed: sites.length, log });
}
