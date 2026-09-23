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

function authed(req) {
  const s = process.env.CRON_SECRET;
  if (!s) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${s}` || req.query.secret === s;
}

async function siteBySlug(slug) {
  return (await listSites()).find((s) => s.slug === slug) || null;
}


// One bounded unit of the SEO automation — see the long note inside. Shared by
// the authed GitHub-Actions tick and the rate-limited public poke below.
async function runAutoTick() {
  // The heartbeat of the whole SEO automation, called every ~30 min by
  // GitHub Actions (.github/workflows/seo-automation.yml) — NOT Vercel's
  // cron, which never recorded a single run for this project. Each call is
  // one bounded unit of work: the single most-overdue eligible site gets
  // one improvement cycle, then any site whose rankings are >3 days stale
  // gets refreshed with whatever time is left. Per-site pacing, the
  // monthly budget cap and the concurrency lock all still apply, so calling
  // it often is safe — most calls find nothing due and return in ~1s.
  const t0 = Date.now();
  await store.set('auto:lastTick', String(t0), { ex: 60 * 60 * 24 * 30 }).catch(() => {});
  const sites = await listSites();
  const out = { agent: null, ranks: [] };
  const cands = [];
  for (const s of sites) {
    const st = await agentStatus(s).catch(() => ({ eligible: false }));
    if (!st.eligible || st.running) continue;
    const last = Number(await store.get(`agent:lastCycleAt:${s.slug}`).catch(() => 0)) || 0;
    cands.push({ s, last });
  }
  cands.sort((a, b) => a.last - b.last);
  if (cands.length) {
    const s = cands[0].s;
    try {
      const r = await runAgentCycle(s, { manual: false });
      out.agent = { slug: s.slug, action: r.action || (r.skipped ? 'skipped' : r.error ? 'error' : 'ok'), reason: r.reason || r.error || null, pr: r.pr?.prUrl || null };
    } catch (e) {
      out.agent = { slug: s.slug, action: 'error', reason: String(e.message || e) };
    }
  }
  if (Date.now() - t0 < 32000) {
    const stale = sites.slice(0, 40);
    const results = await Promise.all(
      stale.map((s) =>
        Date.now() - t0 > 50000
          ? null
          : refreshRanksIfStale(s)
              .then((r) => (r && r.ok && !r.skipped ? { slug: s.slug, inTop10: r.ranks?.inTop10 } : null))
              .catch(() => null)
      )
    );
    out.ranks = results.filter(Boolean);
  }
  // the revisions inbox poller is on the same throttled scheduler, so give it a
  // turn here too when there's time left (a no-new-mail check takes ~2s)
  if (Date.now() - t0 < 28000) {
    try {
      const r = await checkRevisionInbox({ maxMs: 24000 });
      out.revisions = r.ok ? { checked: r.checked, tickets: r.tickets } : { error: r.error };
    } catch (e) {
      out.revisions = { error: String(e.message || e) };
    }
  }
  out.ms = Date.now() - t0;
  return { ok: true, ...out };
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
  // GitHub throttles scheduled workflows hard (a "every 10 min" job actually
  // ran every 4-6 hours), so the automation can't depend on one scheduler.
  // This lets anything that's alive — the dashboard open in a browser, an
  // external uptime pinger — nudge it. No secret needed: it can only run the
  // same per-site-paced, budget-capped tick, and a KV lock caps it at one run
  // per 20 minutes no matter who calls or how often.
  if (req.query.do === 'auto-poke') {
    const last = Number(await store.get('auto:pokeAt').catch(() => 0)) || 0;
    if (Date.now() - last < 20 * 60000) return res.status(200).json({ ok: true, skipped: 'ran recently' });
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
