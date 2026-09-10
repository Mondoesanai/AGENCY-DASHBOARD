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
  const mine = target ? items.find((i) => clean(i.domain) === target || clean(i.url).includes(target)) : null;
  return {
    ok: true,
    cost: res.cost,
    keyword,
    rank: mine ? mine.rank_absolute : null,
    url: mine ? mine.url : null,
    found: !!mine,
    total: res.result?.se_results_count || null,
    top: items.slice(0, 10).map((i) => ({ rank: i.rank_absolute, domain: i.domain, url: i.url, title: i.title })),
  };
}

/**
 * Rank a batch of keywords for one domain. Serial (live endpoint), so keep lists short.
 * @returns {ok, cost, checkedAt, results:[{keyword, rank, url, found}], competitors:[{domain, hits, bestRank}]}
 */
export async function rankBatch({ domain, keywords, locationName, locationCode, device = 'mobile' }) {
  const out = [];
  let cost = 0;
  const comp = {};
  for (const kw of keywords.slice(0, 40)) {
    const r = await serpRank({ keyword: kw, domain, locationName, locationCode, device });
    if (!r.ok) {
      out.push({ keyword: kw, error: r.error });
      continue;
    }
    cost += r.cost || 0;
    out.push({ keyword: kw, rank: r.rank, url: r.url, found: r.found });
    for (const t of r.top) {
      if (clean(t.domain) === clean(domain)) continue;
      const c = (comp[clean(t.domain)] = comp[clean(t.domain)] || { domain: clean(t.domain), hits: 0, bestRank: 999 });
      c.hits++;
      c.bestRank = Math.min(c.bestRank, t.rank);
    }
  }
  const competitors = Object.values(comp)
    .sort((a, b) => b.hits - a.hits || a.bestRank - b.bestRank)
    .slice(0, 5);
  return { ok: true, cost, checkedAt: Date.now(), domain: clean(domain), results: out, competitors };
}
