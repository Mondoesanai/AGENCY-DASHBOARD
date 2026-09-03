import { runAudit } from '../lib/audit.js';
import { getSite } from '../lib/sites.js';

export default async function handler(req, res) {
  const slug = req.query.slug;
  const site = slug ? getSite(slug) : null;
  const url = site ? site.url : req.query.url;
  if (!url) return res.status(400).json({ ok: false, error: 'missing url or slug' });

  const data = await runAudit(url, { fresh: req.query.fresh === '1' });
  res.setHeader('Cache-Control', 's-maxage=3600');
  res.status(200).json(data);
}
