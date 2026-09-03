// Receives tracking beacons from t.js and rolls them into daily counters.
// Cost: $0 — it's just your own function writing to your own KV store.
import { store, dayKey } from '../lib/store.js';

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function cleanSlug(s) {
  return String(s || 'unknown')
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, '')
    .slice(0, 60);
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

  const slug = cleanSlug(d.s);
  if (slug === 'unknown') return res.status(400).json({ ok: false });

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
