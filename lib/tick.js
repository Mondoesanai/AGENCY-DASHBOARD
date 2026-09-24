// One bounded unit of the SEO automation. Shared by the authed GitHub-Actions
// tick, the rate-limited public poke, and the "YES, run it now" text reply.
import { store } from './store.js';
import { listSites } from './registry.js';
import { runAgentCycle, agentStatus, refreshRanksIfStale, initKeywordTracking } from './agent.js';
import { checkRevisionInbox } from './revisions.js';
import { notifyOwner } from './sms.js';
import { buildForSite } from '../api/report.js';
import { monthKey } from './history.js';

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
    // Now: only the single stalest site per tick (15 keywords at 8 at a time is
    // ~20s; the live run with two sites hit the 46s deadline and lost the work),
    // raced against a hard deadline.
    // Pick the ONE site that most needs rank work. The first version sorted every
    // site by "last checked" and took the first — but a site with no keywords
    // sorts first forever (nothing to check), so every other site was starved;
    // and a site without a repo (which the cycle skips) never got keywords at
    // all even though rank tracking doesn't need a repo.
    const info = await Promise.all(
      sites.map(async (x) => {
        let kw = [];
        let at = 0;
        let hasIndexed = false;
        try {
          const k = await store.get(`agent:keywords:${x.slug}`);
          kw = k ? (typeof k === 'string' ? JSON.parse(k) : k) : [];
        } catch {
          kw = [];
        }
        try {
          const raw = await store.get(`agent:ranks:${x.slug}`);
          const rr = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : {};
          at = rr.at || 0;
          hasIndexed = rr.indexed !== undefined;
        } catch {
          at = 0;
        }
        return { x, kw: Array.isArray(kw) ? kw.length : 0, at, hasIndexed };
      })
    );
    const stale = info.filter((i) => i.kw > 0 && (Date.now() - i.at > 3 * 24 * 3600000 || (!i.hasIndexed && i.at > 0 && Date.now() - i.at > 6 * 3600000))).sort((p, q) => p.at - q.at);
    // auto-registered sites (source 'auto': an unknown hostname that sent a beacon,
    // e.g. a client's spare .vercel.app address) aren't managed clients — no spend on them
    const needsKeywords = info.filter((i) => i.kw === 0 && i.x.seoAgent !== false && i.x.source !== 'auto');
    let work;
    if (stale.length) {
      work = refreshRanksIfStale(stale[0].x).then((r) => (r && r.ok && !r.skipped ? [{ slug: stale[0].x.slug, inTop10: r.ranks?.inTop10 }] : []));
    } else if (needsKeywords.length && Date.now() - t0 < 20000) {
      const x = needsKeywords[0].x;
      work = initKeywordTracking(x).then((r) => (r && r.ok && r.keywords?.length ? [{ slug: x.slug, startedTracking: r.keywords.length, inTop10: r.ranks?.inTop10 }] : []));
    } else {
      work = Promise.resolve([]);
    }
    work = work.catch(() => []);
    const left = Math.max(3000, 46000 - (Date.now() - t0));
    const done = await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve('slow'), left))]);
    out.ranks = Array.isArray(done) ? done.filter(Boolean) : [];
    await mark('ranks ' + (Array.isArray(done) ? 'done' : 'SLOW'));
  }
  // Refresh client report pages that are still in the old generic format
  // (no ranking narrative / work list / targeted plan), one site per tick and
  // without emailing anyone — so the shareable report a client opens is the
  // detailed one now, not only after their next send day. Marked as attempted
  // for the month up front so a failing site can't loop.
  if (Date.now() - t0 < 18000) {
    try {
      const MK = monthKey();
      for (const s of sites) {
        if (s.source === 'auto') continue;
        const raw = await store.get(`report:${s.slug}:latest`).catch(() => null);
        let rep = null;
        try {
          rep = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
        } catch {
          rep = null;
        }
        // current version AND actually AI-written; a report that fell back to the
        // generic rules text (model timeout) gets redone
        if (rep && rep.reportVersion === 2 && rep.aiGenerated !== false) continue;
        // up to 5 attempts a month: a timeout must not count as "done" (the first live
        // attempt timed out and would otherwise have blocked the site for the month)
        const tries = Number(await store.get(`report:regen:${s.slug}:${MK}`).catch(() => 0)) || 0;
        if (tries >= 5) continue;
        await store.set(`report:regen:${s.slug}:${MK}`, String(tries + 1), { ex: 60 * 60 * 24 * 40 }).catch(() => {});
        const left = Math.max(5000, 50000 - (Date.now() - t0));
        const work = buildForSite(s, { doSend: false, isBatch: true, fast: true, req: { headers: { host: 'agency-dashboard-omega-red.vercel.app', 'x-forwarded-proto': 'https' } } })
          .then((r) => ({ slug: s.slug, ai: !!r.aiUsed }))
          .catch((e) => ({ slug: s.slug, error: String(e.message || e).slice(0, 80) }));
        out.report = await Promise.race([work, new Promise((resolve) => setTimeout(() => resolve({ slug: s.slug, slow: true }), left))]);
        await mark('report refreshed ' + s.slug);
        break;
      }
    } catch (e) {
      out.report = { error: String(e.message || e).slice(0, 80) };
    }
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
