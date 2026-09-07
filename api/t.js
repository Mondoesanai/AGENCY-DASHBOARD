// Serves the tracker script with this dashboard's own /api/collect URL baked in,
// so the beacon target never depends on document.currentScript.
import { TRACKER_JS } from '../lib/tracker.js';

export default function handler(req, res) {
  const base =
    (process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.replace(/\/$/, '')) ||
    `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;

  res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).send(TRACKER_JS.replace('__ENDPOINT__', base + '/api/collect'));
}
