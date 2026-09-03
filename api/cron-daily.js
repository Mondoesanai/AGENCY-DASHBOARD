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

const MK = monthKey();

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

  res.status(200).json({ ok: true, day: today, isFirst, processed: sites.length, log });
}
