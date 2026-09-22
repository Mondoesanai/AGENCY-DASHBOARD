// Turns raw per-keyword DataForSEO rank checks into the numbers actually
// shown to Mondo: a real average Google position (not the technical
// "SEO-ready" score, which is a completely different thing — on-page setup,
// not where you rank), a per-keyword breakdown, and a trend/timeline
// projection built from a running history of past checks.
import { store } from './store.js';

export function summarizeRanks(ranksObj) {
  if (!ranksObj || !Array.isArray(ranksObj.results) || !ranksObj.results.length) return null;
  const rows = ranksObj.results;
  const found = rows.filter((r) => r.rank);
  const avgRank = found.length ? +(found.reduce((t, r) => t + r.rank, 0) / found.length).toFixed(1) : null;
  const bestRank = found.length ? Math.min(...found.map((r) => r.rank)) : null;
  const inTop3 = found.filter((r) => r.rank <= 3).length;
  const inTop10 = found.filter((r) => r.rank <= 10).length;
  return {
    checkedAt: ranksObj.at || ranksObj.checkedAt || null,
    depth: ranksObj.depth || 100,
    tracked: rows.length,
    found: found.length,
    avgRank,
    bestRank,
    inTop3,
    inTop10,
    competitors: ranksObj.competitors || [],
  };
}

async function readArr(key) {
  const raw = await store.get(key).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

// One compact point per rank check, kept separately from the latest-snapshot
// key (agent:ranks:<slug>, which just gets overwritten) so a trend can
// actually be computed later — without this, there was no way to tell
// "improving" from "stuck" other than remembering what it said last time.
export async function appendRankHistory(slug, point) {
  const hist = await readArr(`agent:rankHistory:${slug}`);
  hist.push(point);
  await store.set(`agent:rankHistory:${slug}`, JSON.stringify(hist.slice(-60)), { ex: 60 * 60 * 24 * 400 }).catch(() => {});
}
export async function readRankHistory(slug) {
  return readArr(`agent:rankHistory:${slug}`);
}

// Simple linear regression of avgRank over time -> weeks-to-target estimate.
// Deliberately conservative: refuses to project from thin or flat data
// rather than inventing a confident-looking date. "Rank going down" = improving.
export function projectTimeline(history, target = 3) {
  const pts = (history || []).filter((h) => h && h.avgRank != null && h.at);
  if (pts.length < 3) return { ok: false, reason: 'not enough history yet — needs a few more rank checks over time' };
  const spanDays = (pts[pts.length - 1].at - pts[0].at) / 864e5;
  if (spanDays < 3) return { ok: false, reason: 'not enough time between checks yet' };
  const n = pts.length;
  const xs = pts.map((p) => (p.at - pts[0].at) / 864e5);
  const ys = pts.map((p) => p.avgRank);
  const xMean = xs.reduce((a, b) => a + b, 0) / n;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (ys[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  const slope = den ? num / den : 0; // change in avg position per day — negative means improving
  const current = ys[ys.length - 1];
  if (current <= target) return { ok: true, improving: true, current, slope, reason: 'already at or beyond target' };
  if (slope >= -0.01) {
    return { ok: true, improving: false, current, slope, reason: "position isn't trending down yet — needs more consistent work, not just time" };
  }
  const weeksToTarget = Math.max(1, Math.round((current - target) / -slope / 7));
  return { ok: true, improving: true, current, slope, weeksToTarget };
}
