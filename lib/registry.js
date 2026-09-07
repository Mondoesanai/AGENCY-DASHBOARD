// The site registry = seed list (lib/sites.js)  +  sites added from the
// dashboard UI (KV: site:config:<slug>)  +  sites auto-detected from tracker
// beacons (KV set: registry:slugs). A UI/db entry always wins.
import { store } from './store.js';
import { SITES as SEED } from './sites.js';

const CFG = (slug) => `site:config:${slug}`;

export function slugify(input) {
  let s = String(input || '').trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).hostname;
  } catch {
    /* not a url */
  }
  s = s.replace(/^www\./, '').replace(/\/.*$/, '');

  // *.vercel.app / *.netlify.app — collapse every preview URL for a project
  // down to the project name so previews don't each become their own site:
  //   my-app-git-main-user.vercel.app       -> my-app
  //   my-app-a1b2c3d4.vercel.app            -> my-app
  const host = s.replace(/:\d+$/, '');
  const pv = host.match(/^([a-z0-9-]+?)\.(vercel|netlify)\.app$/);
  if (pv) {
    let name = pv[1]
      .replace(/-git-[a-z0-9-]+$/, '') // -git-<branch>-<account>
      .replace(/-[a-z0-9]{8,}$/, ''); // -<deployment hash>
    return name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'site';
  }

  return (
    host
      .replace(/\.(vercel\.app|netlify\.app|com|net|org|co|io|us|biz|app|dev)$/i, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'site'
  );
}

function normalizeUrl(u) {
  if (!u) return '';
  let s = String(u).trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const url = new URL(s);
    return url.origin + (url.pathname === '/' ? '' : url.pathname);
  } catch {
    return s;
  }
}

export async function getSiteConfig(slug) {
  const raw = await store.get(CFG(slug)).catch(() => null);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

export async function saveSiteConfig(slug, patch) {
  const existing = (await getSiteConfig(slug)) || {};
  const merged = {
    slug,
    source: existing.source || 'ui',
    addedAt: existing.addedAt || Date.now(),
    ...existing,
    ...patch,
    updatedAt: Date.now(),
  };
  if (patch.url !== undefined) merged.url = normalizeUrl(patch.url);
  if (patch.billingDay !== undefined) {
    const d = parseInt(patch.billingDay, 10);
    merged.billingDay = d >= 1 && d <= 28 ? d : null;
  }
  if (patch.priceMonthly !== undefined)
    merged.priceMonthly = Math.max(0, Number(String(patch.priceMonthly).replace(/[^0-9.]/g, '')) || 0);
  if (patch.setupFee !== undefined)
    merged.setupFee = Math.max(0, Number(String(patch.setupFee).replace(/[^0-9.]/g, '')) || 0);
  if (patch.startedAt !== undefined) {
    const t = Date.parse(patch.startedAt);
    merged.startedAt = Number.isFinite(t) ? t : merged.startedAt || null;
  }
  if (patch.leadValue !== undefined)
    merged.leadValue = Math.max(0, Number(String(patch.leadValue).replace(/[^0-9.]/g, '')) || 0);
  if (patch.conversionEvents !== undefined) {
    merged.conversionEvents = String(patch.conversionEvents || '')
      .split(/[,\n]/)
      .map((s) => s.toLowerCase().replace(/[^a-z0-9.\- ]/g, '').trim().replace(/\s+/g, '-'))
      .filter(Boolean)
      .slice(0, 12);
  }
  merged.autoSend = !!merged.autoSend;

  await store.set(CFG(slug), JSON.stringify(merged));
  await store.sadd('registry:configs', slug);
  await store.set(`site:deleted:${slug}`, '', { ex: 1 }); // un-delete if it was tombstoned
  return merged;
}

export async function deleteSiteConfig(slug) {
  await store.set(CFG(slug), '', { ex: 1 });
  await store.set(`site:deleted:${slug}`, '1');
  // make sure listSites() still visits this slug so the tombstone is applied
  await store.sadd('registry:configs', slug);
}

// The merged list every other module consumes.
export async function listSites() {
  const bySlug = new Map();

  for (const s of SEED) {
    bySlug.set(s.slug, { ...s, source: 'seed', autoSend: false });
  }

  let cfgSlugs = [];
  try {
    cfgSlugs = await store.smembers('registry:configs');
  } catch {
    /* none */
  }
  let autoSlugs = [];
  try {
    autoSlugs = await store.smembers('registry:slugs');
  } catch {
    /* none */
  }

  const extra = [...new Set([...cfgSlugs, ...autoSlugs])].filter((x) => x);
  const metas = extra.length ? await store.mget(extra.map((s) => `meta:${s}`)) : [];
  const cfgs = extra.length ? await store.mget(extra.map((s) => CFG(s))) : [];
  const dels = extra.length ? await store.mget(extra.map((s) => `site:deleted:${s}`)) : [];

  extra.forEach((slug, i) => {
    if (dels[i]) {
      bySlug.delete(slug);
      return;
    }
    let cfg = null;
    try {
      cfg = cfgs[i] ? (typeof cfgs[i] === 'string' ? JSON.parse(cfgs[i]) : cfgs[i]) : null;
    } catch {
      cfg = null;
    }
    let meta = {};
    try {
      meta = metas[i] ? (typeof metas[i] === 'string' ? JSON.parse(metas[i]) : metas[i]) : {};
    } catch {
      meta = {};
    }
    if (cfg && cfg.url === undefined && !cfg.name) cfg = null; // empty/cleared

    if (cfg) {
      bySlug.set(slug, {
        slug,
        name: cfg.name || meta.url || slug,
        url: cfg.url || meta.url || `https://${slug}`,
        client: cfg.client || '',
        email: cfg.email || '',
        phone: cfg.phone || '',
        priceMonthly: cfg.priceMonthly || 0,
        setupFee: cfg.setupFee || 0,
        startedAt: cfg.startedAt || cfg.addedAt || 0,
        leadValue: cfg.leadValue || 0,
        billingDay: cfg.billingDay || null,
        autoSend: !!cfg.autoSend,
        reviewUrl: cfg.reviewUrl || '',
        conversionEvents: cfg.conversionEvents || [],
        source: 'ui',
      });
    } else if (!bySlug.has(slug)) {
      bySlug.set(slug, {
        slug,
        name: meta.name || slug,
        url: meta.url || `https://${slug}`,
        client: '',
        email: '',
        billingDay: null,
        autoSend: false,
        source: 'auto',
      });
    }
  });

  // attach lastSeen (last tracker beacon) to every site so callers can tell
  // "tracker installed" from "no data yet"
  const all = [...bySlug.values()];
  const seenRaw = all.length ? await store.mget(all.map((s) => `meta:${s.slug}`)) : [];
  all.forEach((s, i) => {
    try {
      const m = seenRaw[i] ? (typeof seenRaw[i] === 'string' ? JSON.parse(seenRaw[i]) : seenRaw[i]) : null;
      s.lastSeen = m && m.lastSeen ? m.lastSeen : 0;
    } catch {
      s.lastSeen = 0;
    }
  });
  return all;
}
