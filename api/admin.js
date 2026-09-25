// One admin function that routes to the smaller admin handlers, so we stay
// under Vercel Hobby's 12-function-per-deployment limit.
//   /api/admin?do=coach     (POST)  -> Compass chat
//   /api/admin?do=receipts          -> ledger / receipts / tax (?one=, ?format=csv)
//   /api/admin?do=repos             -> GitHub repo list + match (?match=<url>)
import { coachHandler } from '../lib/coach.js';
import { receiptsHandler } from '../lib/receipts.js';
import { reposHandler } from '../lib/repos.js';
import { listSites } from '../lib/registry.js';
import { runAgentCycle, agentStatus, refreshRanksIfStale } from '../lib/agent.js';
import { upsellState, draftUpsell, sendUpsell } from '../lib/upsell.js';
import { todosState, refreshTodos } from '../lib/todos.js';
import { revisionsStatus, checkRevisionInbox, markTicketDone, cancelTicket, assignTicketToSite, retryTicket } from '../lib/revisions.js';
import { systemHealth } from '../lib/health.js';
import { autoTagConversions } from '../lib/conversions-setup.js';
import { markAiMonth } from '../lib/aicost.js';
import { store } from '../lib/store.js';
import { runAutoTick } from '../lib/tick.js';
import { handleInbound } from '../lib/sms-actions.js';

function authed(req) {
  const s = process.env.CRON_SECRET;
  if (!s) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${s}` || req.query.secret === s;
}

async function siteBySlug(slug) {
  return (await listSites()).find((s) => s.slug === slug) || null;
}


export default async function handler(req, res) {
  // ticket status is client-request/scheduling info, not financial — same
  // trust level as the public /api/sites feed, so it's never password-gated.
  // Same for system-health — it's config/uptime flags (same trust level
  // /api/sites already exposes via emailEnabled/aiEnabled/backend), not
  // client revenue, and it needs to load without a click for the "tell me
  // proactively when something's wrong" goal to actually work.
  if (req.query.do === 'revisions-status') {
    return res.status(200).json({ ok: true, status: await revisionsStatus() });
  }
  if (req.query.do === 'system-health') {
    const h = await systemHealth();
    try {
      const t = await store.get('auto:trace');
      h.autoTrace = t ? (typeof t === 'string' ? JSON.parse(t) : t) : null;
    } catch { /* optional */ }
    return res.status(200).json(h);
  }
  // GitHub throttles scheduled workflows hard (a "every 10 min" job actually
  // ran every 4-6 hours), so the automation can't depend on one scheduler.
  // This lets anything that's alive — the dashboard open in a browser, an
  // external uptime pinger — nudge it. No secret needed: it can only run the
  // same per-site-paced, budget-capped tick, and a KV lock caps it at one run
  // per 8 minutes no matter who calls or how often.
  if (req.query.do === 'auto-poke') {
    const last = Number(await store.get('auto:pokeAt').catch(() => 0)) || 0;
    if (Date.now() - last < 8 * 60000) return res.status(200).json({ ok: true, skipped: 'ran recently' });
    await store.set('auto:pokeAt', String(Date.now()), { ex: 3600 }).catch(() => {});
    return res.status(200).json(await runAutoTick());
  }
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad password' });
  switch (req.query.do) {
    case 'coach':
      return coachHandler(req, res);
    case 'receipts':
      return receiptsHandler(req, res);
    case 'repos':
      return reposHandler(req, res);
    case 'agent-status': {
      const site = await siteBySlug(req.query.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      return res.status(200).json({ ok: true, status: await agentStatus(site) });
    }
    case 'agent-run': {
      const site = await siteBySlug(req.query.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      const out = await runAgentCycle(site, { manual: true, blogNow: req.query.blog === '1' });
      return res.status(200).json(out);
    }
    case 'todos-refresh': {
      const site = await siteBySlug(req.query.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      const out = await refreshTodos(site);
      return res.status(200).json(out);
    }
    case 'upsell': {
      const site = await siteBySlug(req.query.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      const state = await upsellState(site);
      if (req.query.send === '1') {
        const r = await sendUpsell(site);
        return res.status(200).json({ ok: true, ...r, state });
      }
      return res.status(200).json({ ok: true, state, draft: draftUpsell(site, state) });
    }
    case 'revisions-rescan': {
      // put wrongly-dropped mail back in the queue (default: anything with an attachment or "revision" in the subject, last 14 days) and re-read it
      const q = req.query.q || 'has:attachment OR subject:(revision OR revisions OR update OR change)';
      const out = await checkRevisionInbox({ rescan: { q, days: Number(req.query.days) || 14 } });
      return res.status(200).json(out);
    }
    case 'revisions-check': {
      const out = await checkRevisionInbox();
      return res.status(200).json(out);
    }
    case 'revisions-done': {
      const out = await markTicketDone(req.query.id);
      return res.status(200).json(out);
    }
    case 'revisions-cancel': {
      const out = await cancelTicket(req.query.id);
      return res.status(200).json(out);
    }
    case 'revisions-retry': {
      const out = await retryTicket(req.query.id);
      return res.status(200).json(out);
    }
    case 'revisions-assign': {
      const out = await assignTicketToSite(req.query.id, req.query.slug);
      return res.status(200).json(out);
    }
    case 'conversions-setup-all': {
      // Forces conversion auto-tagging right now for every site that hasn't
      // had it yet, instead of waiting on each one's turn in the daily
      // rotation — for retrofitting sites that existed before this feature.
      // With ?slug=<slug>, scans just that one site (from a site's own
      // settings) and always re-scans even if it already ran once, since a
      // site's homepage can change after the first pass.
      const onlySlug = req.query.slug || null;
      const forceIt = onlySlug ? req.query.force !== '0' : req.query.force === '1';
      const sites = onlySlug ? (await listSites()).filter((s) => s.slug === onlySlug) : await listSites();
      if (onlySlug && !sites.length) return res.status(404).json({ ok: false, error: 'unknown site' });
      const t0 = Date.now();
      const results = [];
      for (const site of sites) {
        if (Date.now() - t0 > 45000) {
          results.push({ slug: site.slug, skipped: true, reason: 'out of time this run — re-run to pick up the rest' });
          continue;
        }
        const already = await store.get(`conv:tagged:${site.slug}`).catch(() => null);
        if (already && !forceIt) {
          results.push({ slug: site.slug, skipped: true, reason: 'already tagged' });
          continue;
        }
        const m = new Date().toISOString().slice(0, 7);
        const spend = async (usd) => {
          const cur = Number(await store.get(`agent:spend:${site.slug}:${m}`).catch(() => 0)) || 0;
          await store.set(`agent:spend:${site.slug}:${m}`, String(+(cur + usd).toFixed(5)), { ex: 60 * 60 * 24 * 45 }).catch(() => {});
          const curAll = Number(await store.get(`agent:spend:${m}`).catch(() => 0)) || 0;
          await store.set(`agent:spend:${m}`, String(+(curAll + usd).toFixed(5)), { ex: 60 * 60 * 24 * 45 }).catch(() => {});
          await markAiMonth(m);
        };
        const r = await autoTagConversions(site, { spend }).catch((e) => ({ ok: false, error: String(e.message || e) }));
        await store.set(`conv:tagged:${site.slug}`, String(Date.now()), { ex: 60 * 60 * 24 * 365 }).catch(() => {});
        results.push({ slug: site.slug, ...r });
      }
      return res.status(200).json({ ok: true, results });
    }
    case 'sms-inbound': {
      // Twilio webhook (set the number's "A message comes in" URL to
      // /api/admin?do=sms-inbound&secret=<CRON_SECRET>). Form-encoded body.
      let b = req.body;
      if (typeof b === 'string') b = Object.fromEntries(new URLSearchParams(b));
      const reply = await handleInbound({ from: b?.From, body: b?.Body }).catch(() => '');
      const xml = String(reply || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml ? `<Message>${xml}</Message>` : ''}</Response>`);
    }
    case 'auto-tick':
      return res.status(200).json(await runAutoTick());
    case 'ranks-refresh-all': {
      // Manual "don't wait for the cron" trigger — the whole reason this
      // exists is the daily cron's own reliability is currently in
      // question, so ranking freshness can't fully depend on it working.
      // ?force=1 ignores the ~3-day staleness check and rechecks everyone.
      // ?slug=<slug> limits it to one site (always forces, like the
      // per-site button — waiting 3 days to prove the button worked would
      // defeat the point of a manual "check it now" action).
      const onlySlug = req.query.slug || null;
      const force = onlySlug ? true : req.query.force === '1';
      const sites = onlySlug ? (await listSites()).filter((s) => s.slug === onlySlug) : await listSites();
      if (onlySlug && !sites.length) return res.status(404).json({ ok: false, error: 'unknown site' });
      const t0 = Date.now();
      const results = [];
      for (const site of sites) {
        if (Date.now() - t0 > 45000) {
          results.push({ slug: site.slug, skipped: true, reason: 'out of time this run — re-run to pick up the rest' });
          continue;
        }
        const r = await refreshRanksIfStale(site, { force }).catch((e) => ({ ok: false, error: String(e.message || e) }));
        results.push({ slug: site.slug, ...r });
      }
      return res.status(200).json({ ok: true, results });
    }
    default:
      return res.status(400).json({ ok: false, error: 'unknown admin action' });
  }
}
