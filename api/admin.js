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
    default:
      return res.status(400).json({ ok: false, error: 'unknown admin action' });
  }
}
