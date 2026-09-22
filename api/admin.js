// One admin function that routes to the smaller admin handlers, so we stay
// under Vercel Hobby's 12-function-per-deployment limit.
//   /api/admin?do=coach     (POST)  -> Compass chat
//   /api/admin?do=receipts          -> ledger / receipts / tax (?one=, ?format=csv)
//   /api/admin?do=repos             -> GitHub repo list + match (?match=<url>)
import { coachHandler } from '../lib/coach.js';
import { receiptsHandler } from '../lib/receipts.js';
import { reposHandler } from '../lib/repos.js';
import { listSites } from '../lib/registry.js';
import { runAgentCycle, agentStatus } from '../lib/agent.js';
import { upsellState, draftUpsell, sendUpsell } from '../lib/upsell.js';
import { todosState, refreshTodos } from '../lib/todos.js';
import { revisionsStatus, checkRevisionInbox, markTicketDone, cancelTicket, assignTicketToSite } from '../lib/revisions.js';
import { systemHealth } from '../lib/health.js';
import { autoTagConversions } from '../lib/conversions-setup.js';
import { markAiMonth } from '../lib/aicost.js';
import { store } from '../lib/store.js';

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
    return res.status(200).json(await systemHealth());
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
      const out = await runAgentCycle(site, { manual: true });
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
    case 'revisions-assign': {
      const out = await assignTicketToSite(req.query.id, req.query.slug);
      return res.status(200).json(out);
    }
    case 'conversions-setup-all': {
      // Forces conversion auto-tagging right now for every site that hasn't
      // had it yet, instead of waiting on each one's turn in the daily
      // rotation — for retrofitting sites that existed before this feature.
      const sites = await listSites();
      const t0 = Date.now();
      const results = [];
      for (const site of sites) {
        if (Date.now() - t0 > 45000) {
          results.push({ slug: site.slug, skipped: true, reason: 'out of time this run — re-run to pick up the rest' });
          continue;
        }
        const already = await store.get(`conv:tagged:${site.slug}`).catch(() => null);
        if (already && req.query.force !== '1') {
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
    default:
      return res.status(400).json({ ok: false, error: 'unknown admin action' });
  }
}
