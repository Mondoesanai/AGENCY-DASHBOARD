// Rolls the raw daily counters into a 30-day summary with month-over-month
// deltas, top pages, traffic sources and conversions.
import { store, lastDays } from './store.js';

const n = (v) => Number(v) || 0;

export async function siteStats(slug) {
  const days = lastDays(60); // [today, ..., 59 days ago]
  const cur = days.slice(0, 30);
  const prev = days.slice(30, 60);
  const p = `site:${slug}`;

  // pageviews + device split (cheap mget across all 60 days)
  const pvKeys = days.map((d) => `${p}:day:${d}:pv`);
  const mobKeys = days.map((d) => `${p}:day:${d}:mobile`);
  const deskKeys = days.map((d) => `${p}:day:${d}:desktop`);
  const [pvVals, mobVals, deskVals] = await Promise.all([
    store.mget(pvKeys),
    store.mget(mobKeys),
    store.mget(deskKeys),
  ]);

  const pvByDay = {};
  days.forEach((d, i) => (pvByDay[d] = n(pvVals[i])));

  const pvCur = cur.reduce((t, d) => t + n(pvVals[days.indexOf(d)]), 0);
  const pvPrev = prev.reduce((t, d) => t + n(pvVals[days.indexOf(d)]), 0);
  const mobile = cur.reduce((t, d) => t + n(mobVals[days.indexOf(d)]), 0);
  const desktop = cur.reduce((t, d) => t + n(deskVals[days.indexOf(d)]), 0);

  // unique visitors — pfcount per day, summed (approx; fine for reporting)
  const uvCur = (await Promise.all(cur.map((d) => store.pfcount(`${p}:day:${d}:uv`)))).reduce(
    (t, v) => t + n(v),
    0
  );
  const uvPrev = (await Promise.all(prev.map((d) => store.pfcount(`${p}:day:${d}:uv`)))).reduce(
    (t, v) => t + n(v),
    0
  );

  // top pages / sources / events — merge the per-day sorted sets for current window
  const merge = async (suffix) => {
    const perDay = await Promise.all(cur.map((d) => store.ztop(`${p}:day:${d}:${suffix}`, 25)));
    const acc = {};
    perDay.flat().forEach(({ member, score }) => {
      acc[member] = (acc[member] || 0) + n(score);
    });
    return Object.entries(acc)
      .sort((a, b) => b[1] - a[1])
      .map(([member, score]) => ({ member, score }));
  };
  const [paths, refs, events] = await Promise.all([merge('paths'), merge('refs'), merge('events')]);

  const conversions = events.reduce((t, e) => t + e.score, 0);
  const prevEventsPerDay = await Promise.all(
    prev.map((d) => store.ztop(`${p}:day:${d}:events`, 25))
  );
  const conversionsPrev = prevEventsPerDay.flat().reduce((t, e) => t + n(e.score), 0);

  const trend = cur
    .slice()
    .reverse()
    .map((d) => pvByDay[d] || 0); // oldest -> newest for sparkline

  const pct = (now, before) =>
    before === 0 ? (now > 0 ? 100 : 0) : Math.round(((now - before) / before) * 100);

  return {
    slug,
    hasData: pvCur + uvCur > 0,
    window: { start: cur[cur.length - 1], end: cur[0] },
    pageviews: pvCur,
    visitors: uvCur,
    conversions,
    deltas: {
      pageviews: pct(pvCur, pvPrev),
      visitors: pct(uvCur, uvPrev),
      conversions: pct(conversions, conversionsPrev),
    },
    device: { mobile, desktop },
    trend,
    topPages: paths.slice(0, 6),
    sources: refs.slice(0, 6),
    events: events.slice(0, 8),
  };
}
