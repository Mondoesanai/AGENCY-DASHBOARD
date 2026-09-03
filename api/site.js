// Create / update / delete a client site, plus builder notes and the
// "what we did this month" changelog. All writes require CRON_SECRET.
import { store } from '../lib/store.js';
import { saveSiteConfig, deleteSiteConfig, getSiteConfig, slugify } from '../lib/registry.js';

function authed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}` || req.query.secret === secret || (req.body && req.body.secret === secret);
}

async function readNotes(slug) {
  const n = await store.get(`notes:${slug}`).catch(() => null);
  return typeof n === 'string' ? n : '';
}
async function readLog(slug) {
  const raw = await store.get(`changelog:${slug}`).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false });
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad secret' });

  let body = {};
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
  } catch {
    body = {};
  }
  const action = body.action || 'save';

  try {
    if (action === 'save') {
      const slug = (body.slug || slugify(body.url || body.name || '')).trim();
      if (!slug) return res.status(400).json({ ok: false, error: 'need a url or name' });
      const cfg = await saveSiteConfig(slug, {
        url: body.url,
        name: body.name || slug,
        client: body.client || '',
        email: body.email || '',
        phone: body.phone || '',
        priceMonthly: body.priceMonthly,
        billingDay: body.billingDay,
        autoSend: body.autoSend,
        leadValue: body.leadValue,
        reviewUrl: body.reviewUrl || '',
      });
      return res.status(200).json({ ok: true, site: cfg });
    }

    if (action === 'delete') {
      if (!body.slug) return res.status(400).json({ ok: false, error: 'need slug' });
      await deleteSiteConfig(body.slug);
      return res.status(200).json({ ok: true });
    }

    if (action === 'notes') {
      if (!body.slug) return res.status(400).json({ ok: false, error: 'need slug' });
      await store.set(`notes:${body.slug}`, String(body.notes || '').slice(0, 8000));
      return res.status(200).json({ ok: true });
    }

    if (action === 'changelog-add') {
      if (!body.slug || !body.text) return res.status(400).json({ ok: false, error: 'need slug + text' });
      const log = await readLog(body.slug);
      log.push({ date: new Date().toISOString().slice(0, 10), text: String(body.text).slice(0, 300) });
      while (log.length > 60) log.shift();
      await store.set(`changelog:${body.slug}`, JSON.stringify(log));
      return res.status(200).json({ ok: true, changelog: log });
    }

    if (action === 'changelog-del') {
      const log = await readLog(body.slug);
      if (Number.isInteger(body.index) && body.index >= 0 && body.index < log.length) log.splice(body.index, 1);
      await store.set(`changelog:${body.slug}`, JSON.stringify(log));
      return res.status(200).json({ ok: true, changelog: log });
    }

    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}

export { readNotes, readLog };
