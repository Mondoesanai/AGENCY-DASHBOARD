// Client-safe slice of a site's data for the shareable /r/<slug> page.
// Deliberately omits builder notes, client contact details, pricing and the
// blunt technical findings.
import { listSites } from '../lib/registry.js';
import { getHistory } from '../lib/history.js';
import { runAudit } from '../lib/audit.js';
import { siteStats } from '../lib/stats.js';
import { clientActions, improvementsForClient, overallGrade } from '../lib/suggestions.js';
import { tokenOk } from '../lib/token.js';
import { store } from '../lib/store.js';
import { summarizeRanks, readPrevRanks, keywordTable, readRankHistory, projectTimeline } from '../lib/ranks.js';

async function readArr(k) {
  const raw = await store.get(k).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// The link Mondo sends clients used to show whatever was true when the
// monthly report was generated — the numbers had some live fallback, but
// "what we did" never did, so it looked identical from the day it was sent
// until the next one went out. This re-reads it fresh on every visit
// (subject to the 10-min cache below), so it actually reflects the latest
// shipped work — both AI-picked SEO fixes and things the client themselves
// asked for.
async function recentWork(slug) {
  const [manual, autoShipped] = await Promise.all([readArr(`changelog:${slug}`), readArr(`todos:completed:${slug}`)]);
  const merged = [
    ...manual.map((c) => ({ date: c.date, text: c.text, at: Date.parse(c.date) || 0 })),
    ...autoShipped.map((x) => ({ date: new Date(x.addressedAt).toISOString().slice(0, 10), text: x.title, at: x.addressedAt || 0, fromClientRequest: x.source === 'revision' })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 10);
  return merged.map(({ at, ...rest }) => rest);
}

export default async function handler(req, res) {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ error: 'missing slug' });
  if (!tokenOk(slug, req.query.t)) return res.status(403).json({ error: 'this report link is not valid' });

  const site = (await listSites()).find((s) => s.slug === slug);
  if (!site) return res.status(404).json({ error: 'not found' });

  const [history, reportRaw, stats, audit, healthRaw, changelog, ranksRaw, prevRanks, rankHist] = await Promise.all([
    getHistory(slug).catch(() => []),
    store.get(`report:${slug}:latest`).catch(() => null),
    siteStats(slug, site.conversionEvents || []).catch(() => null),
    runAudit(site.url).catch(() => ({ ok: false })),
    store.get(`health:${slug}`).catch(() => null),
    recentWork(slug).catch(() => []),
    store.get(`agent:ranks:${slug}`).catch(() => null),
    readPrevRanks(slug).catch(() => null),
    readRankHistory(slug).catch(() => []),
  ]);
  let curRanks = null;
  try {
    curRanks = ranksRaw ? (typeof ranksRaw === 'string' ? JSON.parse(ranksRaw) : ranksRaw) : null;
  } catch {
    curRanks = null;
  }
  const rankSummary = summarizeRanks(curRanks);
  const report = reportRaw ? (typeof reportRaw === 'string' ? JSON.parse(reportRaw) : reportRaw) : null;
  const health = healthRaw ? (typeof healthRaw === 'string' ? JSON.parse(healthRaw) : healthRaw) : null;

  // one fresh attempt if the cached audit is a stale failure
  let liveAudit = audit;
  if (!liveAudit || !liveAudit.ok) {
    liveAudit = await runAudit(site.url, { fresh: true }).catch(() => liveAudit || { ok: false });
  }
  const lastRow = history && history.length ? history[history.length - 1] : null;

  // scores: fresh audit -> last history snapshot -> last saved report metrics
  let scores = null;
  if (liveAudit?.ok) {
    scores = liveAudit.scores;
  } else {
    const seo = lastRow?.seo ?? report?.metrics?.seo ?? null;
    const perf = lastRow?.perf ?? report?.metrics?.perf ?? null;
    if (seo != null || perf != null) scores = { seo, performance: perf, accessibility: null, bestPractices: null };
  }
  const grade = overallGrade(liveAudit, stats) || report?.grade || lastRow?.grade || null;
  const ready = !!(report || (scores && scores.seo != null) || (stats && stats.hasData));

  res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=3600');
  res.status(200).json({
    name: site.name,
    url: site.url,
    ready,
    month: report?.month || new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' }),
    headline: report?.headline || `${site.name} — website performance`,
    summary: report?.summary || '',
    wins: report?.wins || [],
    improvements: report?.improvements || improvementsForClient(liveAudit, stats),
    clientActions: report?.clientActions || clientActions(liveAudit, stats, site),
    grade,
    scores,
    vitals: liveAudit?.ok ? liveAudit.vitals : null,
    history: (history || []).map((h) => ({
      month: h.month,
      visitors: h.visitors,
      conversions: h.conversions,
      seo: h.seo,
      health: h.grade?.score ?? null,
    })),
    current: {
      visitors: stats?.visitors ?? (history.at(-1)?.visitors || 0),
      conversions: stats?.conversions ?? (history.at(-1)?.conversions || 0),
      deltas: stats?.deltas || null,
    },
    uptime: health ? { up: health.up, ms: health.ms } : null,
    cardUrl: `/api/card?slug=${encodeURIComponent(slug)}`,
    recentWork: changelog,
    period: report?.period || 'monthly',
    progress: report?.progress || '',
    workDone: report?.workDone || [],
    // the real Google position data, live — not frozen at report time
    rankings: rankSummary
      ? {
          checkedAt: rankSummary.checkedAt,
          tracked: rankSummary.tracked,
          found: rankSummary.found,
          avgRank: rankSummary.avgRank,
          bestRank: rankSummary.bestRank,
          inTop3: rankSummary.inTop3,
          inTop10: rankSummary.inTop10,
          depth: rankSummary.depth,
          roughField: rankSummary.roughField,
          indexed: rankSummary.indexed,
          keywords: keywordTable(curRanks, prevRanks).slice(0, 12),
          competitors: (rankSummary.competitors || []).slice(0, 4).map((c) => ({ domain: c.domain, bestRank: c.bestRank })),
          history: (rankHist || []).slice(-24).map((h) => ({ at: h.at, avgRank: h.avgRank, inTop10: h.inTop10 })),
          timeline: projectTimeline(rankHist, 3),
        }
      : null,
    traffic: stats
      ? {
          topPages: (stats.topPages || []).slice(0, 6),
          sources: (stats.sources || []).slice(0, 6),
          events: (stats.events || []).slice(0, 8),
          leadSources: (stats.leadSources || []).slice(0, 6),
          device: stats.device || null,
          avgDwell: stats.avgDwell ?? null,
        }
      : null,
  });
}
