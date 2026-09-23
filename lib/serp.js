// DataForSEO wrapper — live Google rank checks + local competitors.
// Auth: DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD (or DATAFORSEO_AUTH = base64 "login:password").
// No client Google Business Profile access needed — this reads the public SERP.

function auth() {
  if (process.env.DATAFORSEO_AUTH) return 'Basic ' + process.env.DATAFORSEO_AUTH.trim();
  const l = process.env.DATAFORSEO_LOGIN;
  const p = process.env.DATAFORSEO_PASSWORD;
  if (!l || !p) return null;
  return 'Basic ' + Buffer.from(`${l}:${p}`).toString('base64');
}

export function serpConfigured() {
  return !!auth();
}

async function call(path, body) {
  const a = auth();
  if (!a) return { ok: false, error: 'DataForSEO credentials not set (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD)' };
  let r;
  try {
    r = await fetch('https://api.dataforseo.com/v3' + path, {
      method: 'POST',
      headers: { Authorization: a, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: 'network: ' + (e.message || e) };
  }
  const j = await r.json().catch(() => null);
  if (!j || j.status_code >= 40000) return { ok: false, error: j?.status_message || `http ${r.status}` };
  const task = j.tasks && j.tasks[0];
  if (!task || task.status_code >= 40000) return { ok: false, error: task?.status_message || 'no task result' };
  return { ok: true, cost: j.cost || 0, result: (task.result && task.result[0]) || null };
}

const clean = (u) =>
  String(u || '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .toLowerCase();

/**
 * One live Google rank check.
 * @returns {ok, rank|null, url, cost, top:[{rank,domain,url,title}], found:bool}
 */
export async function serpRank({ keyword, domain, locationName = 'United States', locationCode, device = 'mobile', depth = 100 }) {
  const loc = locationCode ? { location_code: locationCode } : { location_name: locationName };
  const res = await call('/serp/google/organic/live/advanced', [
    { keyword, ...loc, language_code: 'en', device, depth },
  ]);
  if (!res.ok) return res;
  const items = (res.result?.items || []).filter((i) => i.type === 'organic');
  const target = clean(domain);
  // what Google is actually showing for this search — the titles that already
  // win, the questions people ask, and related searches. This is the raw
  // material for writing a title/description that can compete and for finding
  // the next long-tail keyword, instead of guessing in the dark.
  const rawItems = res.result?.items || [];
  const paa = rawItems
    .filter((i) => i.type === 'people_also_ask')
    .flatMap((i) => (i.items || []).map((x) => x && x.title))
    .filter(Boolean)
    .slice(0, 6);
  const related = rawItems
    .filter((i) => i.type === 'related_searches')
    .flatMap((i) => i.items || [])
    .map((x) => (typeof x === 'string' ? x : x && x.title))
    .filter(Boolean)
    .slice(0, 8);
  const topTitles = items.slice(0, 5).map((i) => ({ rank: i.rank_absolute, domain: i.domain, title: String(i.title || '').slice(0, 90) }));
  const mine = target ? items.find((i) => clean(i.domain) === target || clean(i.url).includes(target)) : null;
  return {
    ok: true,
    cost: res.cost,
    keyword,
    rank: mine ? mine.rank_absolute : null,
    url: mine ? mine.url : null,
    found: !!mine,
    // how deep this specific check actually searched — NOT se_results_count
    // below. "not in top X" needs to mean the search depth, or it's nonsense.
    depth,
    // Google's own "about N results" estimate for the query — NOT a rank
    // position (nobody's "ranked at" 1.2 million), but when a site isn't
    // found in the search depth at all, this is the only number DataForSEO
    // gives back at all. Kept as an honest, clearly-separate "how big is
    // the field you're competing against" figure — a rough progress proxy
    // that should trend down over months, not a real position.
    resultsCount: res.result?.se_results_count || null,
    topTitles,
    paa,
    related,
    top: items.slice(0, 10).map((i) => ({ rank: i.rank_absolute, domain: i.domain, url: i.url, title: i.title })),
  };
}

/**
 * Rank a batch of keywords for one domain. Serial (live endpoint), so keep lists short.
 * @returns {ok, cost, checkedAt, results:[{keyword, rank, url, found}], competitors:[{domain, hits, bestRank}]}
 */
// Runs the checks CONCURRENTLY (small batches) instead of one-at-a-time — a
// cron-triggered cycle has a hard ~60s ceiling on Vercel, and 12 keywords done
// serially (~1-3s each) alone could blow past that. Batches of 4 keeps us well
// under DataForSEO's rate limits while cutting wall time ~4x.
/**
 * How many of a site's pages Google has indexed — the first thing to know when
 * a site ranks for nothing (a page Google hasn't indexed cannot rank at all).
 * Uses a site: search; returns null if the lookup fails so a hiccup never
 * looks like "0 pages indexed".
 */
export async function indexedPages(domain) {
  const d = clean(domain);
  if (!d) return null;
  const res = await call('/serp/google/organic/live/advanced', [
    { keyword: 'site:' + d, location_name: 'United States', language_code: 'en', device: 'desktop', depth: 100 },
  ]).catch(() => null);
  if (!res || !res.ok) return null;
  const items = (res.result?.items || []).filter((i) => i.type === 'organic' && (clean(i.domain) === d || clean(i.url).includes(d)));
  return { count: items.length, estimate: res.result?.se_results_count || null, checkedAt: Date.now() };
}

export async function rankBatch({ domain, keywords, locationName, locationCode, device = 'mobile', concurrency = 4, depth = 100 }) {
  const list = keywords.slice(0, 40);
  const out = new Array(list.length);
  const comp = {};
  let cost = 0;
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      const kw = list[idx];
      const r = await serpRank({ keyword: kw, domain, locationName, locationCode, device, depth }).catch((e) => ({ ok: false, error: String(e.message || e) }));
      if (!r.ok) {
        out[idx] = { keyword: kw, error: r.error };
        continue;
      }
      cost += r.cost || 0;
      out[idx] = { keyword: kw, rank: r.rank, url: r.url, found: r.found, resultsCount: r.resultsCount, topTitles: r.topTitles, paa: r.paa, related: r.related };
      for (const t of r.top || []) {
        if (clean(t.domain) === clean(domain)) continue;
        const c = (comp[clean(t.domain)] = comp[clean(t.domain)] || { domain: clean(t.domain), hits: 0, bestRank: 999 });
        c.hits++;
        c.bestRank = Math.min(c.bestRank, t.rank);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  const competitors = Object.values(comp)
    .sort((a, b) => b.hits - a.hits || a.bestRank - b.bestRank)
    .slice(0, 5);
  return { ok: true, cost, checkedAt: Date.now(), domain: clean(domain), depth, results: out, competitors };
}
