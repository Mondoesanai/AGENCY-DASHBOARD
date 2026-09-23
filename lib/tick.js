// One bounded unit of the SEO automation. Shared by the authed GitHub-Actions
// tick, the rate-limited public poke, and the "YES, run it now" text reply.
import { store } from './store.js';
import { listSites } from './registry.js';
import { runAgentCycle, agentStatus, refreshRanksIfStale } from './agent.js';
import { checkRevisionInbox } from './revisions.js';
import { notifyOwner } from './sms.js';

export async function runAutoTick() {
  // The heartbeat of the whole SEO automation, called every ~30 min by
  // GitHub Actions (.github/workflows/seo-automation.yml) — NOT Vercel's
  // cron, which never recorded a single run for this project. Each call is
  // one bounded unit of work: the single most-overdue eligible site gets
  // one improvement cycle, then any site whose rankings are >3 days stale
  // gets refreshed with whatever time is left. Per-site pacing, the
  // monthly budget cap and the concurrency lock all still apply, so calling
  // it often is safe — most calls find nothing due and return in ~1s.
  const t0 = Date.now();
  const trace = [];
  // checkpoints persisted as we go, so a run that gets killed still shows how far it got
  const mark = async (step) => {
    trace.push({ ms: Date.now() - t0, step });
    await store.set('auto:trace', JSON.stringify({ at: t0, trace }), { ex: 86400 }).catch(() => {});
  };
  const prevTick = Number(await store.get('auto:lastTick').catch(() => 0)) || 0;
  await store.set('auto:lastTick', String(t0), { ex: 60 * 60 * 24 * 30 }).catch(() => {});
  // if nothing ran for hours, say so once (a text, or email if texting is off)
  if (prevTick && t0 - prevTick > 10 * 3600000) {
    await notifyOwner(`SEO automation was offline for ${Math.round((t0 - prevTick) / 3600000)}h (the GitHub scheduler stalled). It is running again now.`, { subject: 'SEO automation was offline' }).catch(() => {});
  }
  await mark('start');
  const sites = await listSites();
  await mark('sites listed: ' + sites.length);
  const out = { agent: null, ranks: [] };
  const cands = [];
  for (const s of sites) {
    const st = await agentStatus(s).catch(() => ({ eligible: false }));
    if (!st.eligible || st.running) continue;
    const last = Number(await store.get(`agent:lastCycleAt:${s.slug}`).catch(() => 0)) || 0;
    cands.push({ s, last });
  }
  cands.sort((a, b) => a.last - b.last);
  await mark('eligible: ' + cands.map((c) => c.s.slug).join(','));
  if (cands.length) {
    const s = cands[0].s;
    await mark('cycle start ' + s.slug);
    try {
      // hard stop well inside Vercel's 60s limit — a function killed mid-cycle
      // leaves nothing recorded and looks like the automation silently died
      const cycle = runAgentCycle(s, { manual: false }).catch((e) => ({ ok: false, error: String(e.message || e) }));
      const r = await Promise.race([cycle, new Promise((resolve) => setTimeout(() => resolve({ __slow: true }), 45000))]);
      await mark('cycle end ' + (r.__slow ? 'SLOW' : r.action || r.error || 'ok'));
      out.agent = r.__slow
        ? { slug: s.slug, action: 'slow', reason: 'cycle is taking longer than one tick — it keeps going and the next tick picks up after it' }
        : { slug: s.slug, action: r.action || (r.skipped ? 'skipped' : r.error ? 'error' : 'ok'), reason: r.reason || r.error || null, pr: r.pr?.prUrl || null };
    } catch (e) {
      out.agent = { slug: s.slug, action: 'error', reason: String(e.message || e) };
    }
  }
  await mark('ranks phase');
  if (Date.now() - t0 < 30000) {
    // The live tick died here once: it fired 12-keyword rank checks for EVERY
    // stale site at the same time (60+ live lookups) and blew the 60s limit.
    // Now: only the two stalest sites per tick, raced against a hard deadline.
    const ages = await Promise.all(
      sites.map(async (x) => {
        const raw = await store.get(`agent:ranks:${x.slug}`).catch(() => null);
        let at = 0;
        try {
          at = (raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {}).at || 0;
        } catch {
          at = 0;
        }
        return { x, at };
      })
    );
    const batch = ages.sort((p, q) => p.at - q.at).slice(0, 2).map((e) => e.x);
    const work = Promise.all(
      batch.map((x) =>
        refreshRanksIfStale(x)
          .then((r) => (r && r.ok && !r.skipped ? { slug: x.slug, inTop10: r.ranks?.inTop10 } : null))
          .catch(() => null)
      )
    );
    const left = Math.max(3000, 46000 - (Date.now() - t0));
    const done = await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve('slow'), left))]);
    out.ranks = Array.isArray(done) ? done.filter(Boolean) : [];
    await mark('ranks ' + (Array.isArray(done) ? 'done' : 'SLOW'));
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
  await mark('done');
  out.ms = Date.now() - t0;
  return { ok: true, ...out };
}
