// Receives tracking beacons from t.js and rolls them into daily counters.
// Cost: $0 — it's just your own function writing to your own KV store.
import { store, dayKey } from '../lib/store.js';
import { slugify, slugForHost, rememberHost, matchExistingSite } from '../lib/registry.js';

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

  // R7.8 — the scheduler webhook. It lives on this public function because
  // Calendly cannot authenticate with the dashboard password, so the SIGNATURE
  // is the only thing standing between a stranger's HTTP request and a record
  // the owner plans their week around. An unverified payload is refused, and
  // with no signing key configured nothing is trusted at all.
  if (req.query?.hook === 'booking') {
    const { verifyCalendlySignature, handleBookingWebhook } = await import('../lib/bookings.js');
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    const v = verifyCalendlySignature({
      header: req.headers['calendly-webhook-signature'],
      rawBody,
      signingKey: process.env.CALENDLY_WEBHOOK_KEY,
    });
    if (!v.ok) return res.status(401).json({ ok: false, error: v.reason });
    let event = {};
    try { event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {}; } catch { event = {}; }
    const out = await handleBookingWebhook({ event, verified: true });
    return res.status(out.ok ? 200 : 400).json(out);
  }

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

  // hostname the beacon came from — prefer the real origin, fall back to the id
  let host = '';
  try {
    host = new URL(d.u || '').hostname;
  } catch {
    host = String(d.s || '');
  }
  // one host = one slug: if this host is already known (e.g. it was "Added" in
  // the UI, or auto-registered earlier), route this beacon to that same slug.
  // If it's a host we've never seen, check whether it's really just an
  // alternate hostname (custom domain vs. raw .vercel.app) of a site we
  // already track before creating a brand new entry — this is what stops
  // the same project from ending up registered twice.
  const slug =
    (await slugForHost(host || d.s).catch(() => null)) ||
    (host && (await matchExistingSite(host).catch(() => null))) ||
    cleanSlug(d.s);
  if (slug === 'unknown') return res.status(400).json({ ok: false, error: 'missing site id' });

  const type = d.e === 'ev' ? 'ev' : d.e === 'dur' ? 'dur' : 'pv';
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
  if (host) tasks.push(rememberHost(host, slug)); // seed the host->slug index

  // UTM-derived source (from t.js, persisted for the session) wins when
  // present — it's more precise than referrer alone (distinguishes paid vs
  // organic on the same domain). Falls back to referrer classification.
  const utmSrc = String(d.src || '').slice(0, 40);
  const source = utmSrc || refHost(d.r);

  if (type === 'pv') {
    tasks.push(store.incr(`${p}:day:${day}:pv`));
    tasks.push(store.zincr(`${p}:day:${day}:paths`, path));
    tasks.push(store.zincr(`${p}:day:${day}:refs`, source));
    if (width) {
      tasks.push(store.incr(`${p}:day:${day}:${width < 768 ? 'mobile' : 'desktop'}`));
    }
  } else if (type === 'dur') {
    // engaged seconds on a page — for the "Time on site" metric
    const secs = Math.max(0, Math.min(1800, Math.round(Number(d.d) || 0)));
    if (secs > 0) {
      tasks.push(store.incr(`${p}:day:${day}:dursum`, secs));
      tasks.push(store.incr(`${p}:day:${day}:durcnt`));
    }
  } else {
    const name = cleanSlug(d.n || 'click') || 'click';
    tasks.push(store.incr(`${p}:day:${day}:ev:${name}`));
    tasks.push(store.zincr(`${p}:day:${day}:events`, name));
    // which channel this specific conversion-worthy click came from — "lead
    // source" isn't just where traffic comes from, it's where the actual
    // enquiries come from, which can be a very different ranking.
    tasks.push(store.zincr(`${p}:day:${day}:leadsrc`, source));
  }

  try {
    await Promise.all(tasks);
  } catch {
    /* never break the client site over analytics */
  }

  // A client's on-page star-rating widget can submit the actual rating/name/
  // text here (name === "submit-review") so it's kept somewhere real, not just
  // counted as a click. No client site did this before — the widget existed
  // but never sent its content anywhere.
  if (type === 'ev' && String(d.n || '') === 'submit-review' && d.rt) {
    const rating = Math.max(1, Math.min(5, Math.round(Number(d.rt)) || 0));
    if (rating) {
      const review = {
        rating,
        name: String(d.rn || '').replace(/[<>]/g, '').trim().slice(0, 60),
        text: String(d.rx || '').replace(/[<>]/g, '').trim().slice(0, 600),
        path,
        at: Date.now(),
      };
      try {
        const raw = await store.get(`reviews:${slug}`);
        const list = (() => {
          try {
            const a = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
            return Array.isArray(a) ? a : [];
          } catch {
            return [];
          }
        })();
        list.push(review);
        await store.set(`reviews:${slug}`, JSON.stringify(list.slice(-200)));
      } catch {
        /* never break the client site over review storage */
      }
    }
  }

  res.status(200).json({ ok: true });
}
