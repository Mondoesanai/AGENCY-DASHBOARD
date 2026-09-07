// Receives tracking beacons from t.js and rolls them into daily counters.
// Cost: $0 — it's just your own function writing to your own KV store.
import { store, dayKey } from '../lib/store.js';
import { slugify } from '../lib/registry.js';

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// For the site id: if the tracker sent a hostname (has a dot), turn it into a
// clean slug ("one-more-thing-gold.vercel.app" -> "one-more-thing-gold").
// If the owner set an explicit data-site="my-slug", keep it as-is.
function cleanSlug(s) {
  const raw = String(s || 'unknown').toLowerCase().trim();
  if (raw.includes('.')) return slugify(raw) || 'unknown';
  return (
    raw
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'unknown'
  );
}

function refHost(ref) {
  if (!ref) return 'direct';
  try {
    const h = new URL(ref).hostname.replace(/^www\./, '');
    if (!h) return 'direct';
    if (/google\./.test(h)) return 'google';
    if (/bing\./.test(h)) return 'bing';
    if (/duckduckgo/.test(h)) return 'duckduckgo';
    if (/facebook|fb\.com|instagram|t\.co|twitter|x\.com|linkedin|youtube|tiktok/.test(h))
      return 'social';
    return h;
  } catch {
    return 'other';
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  let d = {};
  try {
    d = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    d = {};
  }
  // also accept querystring (pixel fallback)
  if (req.method === 'GET') d = { ...req.query };

  // bare GET with no site id => a human is checking the endpoint is reachable
  if (req.method === 'GET' && !d.s) {
    return res
      .status(200)
      .json({ ok: true, message: 'Tracker endpoint is reachable. Beacons POST here from t.js.' });
  }

  const slug = cleanSlug(d.s);
  if (slug === 'unknown') return res.status(400).json({ ok: false, error: 'missing site id' });

  const type = d.e === 'ev' ? 'ev' : 'pv';
  const path = String(d.p || '/').slice(0, 120);
  const width = Number(d.w) || 0;
  const day = dayKey();

  const ua = req.headers['user-agent'] || '';
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    '';
  // cookieless daily-rotating visitor id (privacy friendly)
  const visitor = hash(ip + '|' + ua + '|' + day + '|' + slug);

  const p = `site:${slug}`;
  const tasks = [store.pfadd(`${p}:day:${day}:uv`, visitor)];

  // auto-register the site on ANY beacon (pageview or event) so it shows up on
  // the dashboard within seconds of the snippet going live — no "Add site" needed.
  let origin = '';
  try {
    origin = new URL(d.u || '').origin;
  } catch {
    origin = '';
  }
  tasks.push(store.sadd('registry:slugs', slug));
  tasks.push(
    store.set(
      `meta:${slug}`,
      JSON.stringify({ slug, url: origin || `https://${slug}`, lastSeen: Date.now() })
    )
  );

  if (type === 'pv') {
    tasks.push(store.incr(`${p}:day:${day}:pv`));
    tasks.push(store.zincr(`${p}:day:${day}:paths`, path));
    tasks.push(store.zincr(`${p}:day:${day}:refs`, refHost(d.r)));
    if (width) {
      tasks.push(store.incr(`${p}:day:${day}:${width < 768 ? 'mobile' : 'desktop'}`));
    }
  } else {
    const name = cleanSlug(d.n || 'click') || 'click';
    tasks.push(store.incr(`${p}:day:${day}:ev:${name}`));
    tasks.push(store.zincr(`${p}:day:${day}:events`, name));
  }

  try {
    await Promise.all(tasks);
  } catch {
    /* never break the client site over analytics */
  }
  res.status(200).json({ ok: true });
}
