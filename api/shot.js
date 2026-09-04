// A real screenshot of the client's live site (not the stats card).
// Redirects to WordPress mShots — free, no key, and it re-captures roughly
// weekly on their side. We bucket the URL by week so it refreshes on its own
// without us ever running a browser or spending API calls.
import { listSites } from '../lib/registry.js';

export default async function handler(req, res) {
  const slug = req.query.slug;
  let url = req.query.url;
  if (slug && !url) {
    const site = (await listSites()).find((s) => s.slug === slug);
    url = site && site.url;
  }
  if (!url) return res.status(400).json({ error: 'missing slug or url' });

  const week = Math.floor(Date.now() / 604800000);
  const target =
    'https://s.wordpress.com/mshots/v1/' +
    encodeURIComponent(url) +
    `?w=1280&h=800&vpw=1440&vph=900&r=${week}`;

  // cache the redirect at the edge for a week; mShots caches the image itself
  res.setHeader('Cache-Control', 'public, s-maxage=604800, stale-while-revalidate=1209600');
  res.setHeader('Location', target);
  res.status(302).end();
}
