// Free SEO + performance audit via Google PageSpeed Insights.
// No API key required at low volume; set PAGESPEED_API_KEY to raise limits
// (free key from https://developers.google.com/speed/docs/insights/v5/get-started).
import { store } from './store.js';

const API = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';

export async function runAudit(url, { fresh = false } = {}) {
  const cacheKey = `audit:${url}`;
  if (!fresh) {
    const cached = await store.get(cacheKey);
    if (cached) return typeof cached === 'string' ? JSON.parse(cached) : cached;
  }

  const params = new URLSearchParams({ url, strategy: 'mobile' });
  ['performance', 'seo', 'accessibility', 'best-practices'].forEach((c) =>
    params.append('category', c)
  );
  if (process.env.PAGESPEED_API_KEY) params.append('key', process.env.PAGESPEED_API_KEY);

  // one retry — Lighthouse runs occasionally take >50s, especially the first
  // scan of a site
  async function attempt(ms) {
    const r = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(ms) });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j;
  }

  let json;
  try {
    try {
      json = await attempt(35000);
    } catch (e1) {
      if (/quota|rate/i.test(String(e1.message))) throw e1; // don't retry a quota error
      json = await attempt(20000);
    }
  } catch (e) {
    // cache failures too, so repeated dashboard loads don't keep hammering
    // the API — but only briefly, so a fix (new key, warm site) shows up soon
    const errResult = { url, ok: false, error: String(e.message || e), fetchedAt: Date.now() };
    await store.set(cacheKey, JSON.stringify(errResult), { ex: 60 * 20 }); // 20 min
    return errResult;
  }

  const lh = json.lighthouseResult || {};
  const cats = lh.categories || {};
  const a = lh.audits || {};
  const num = (id) => (a[id] && typeof a[id].numericValue === 'number' ? a[id].numericValue : null);
  const failed = (id) => a[id] && a[id].score !== null && a[id].score < 0.9;

  const result = {
    url,
    ok: true,
    fetchedAt: Date.now(),
    scores: {
      performance: Math.round((cats.performance?.score ?? 0) * 100),
      seo: Math.round((cats.seo?.score ?? 0) * 100),
      accessibility: Math.round((cats.accessibility?.score ?? 0) * 100),
      bestPractices: Math.round((cats['best-practices']?.score ?? 0) * 100),
    },
    vitals: {
      lcp: num('largest-contentful-paint'),
      cls: num('cumulative-layout-shift'),
      tbt: num('total-blocking-time'),
      fcp: num('first-contentful-paint'),
      si: num('speed-index'),
    },
    checks: {
      metaDescription: !failed('meta-description'),
      title: !failed('document-title'),
      httpStatusOk: !failed('http-status-code'),
      crawlable: !failed('is-crawlable'),
      viewport: !failed('viewport'),
      imageAlt: !failed('image-alt'),
      linkText: !failed('link-text'),
      hreflang: !failed('hreflang'),
      structuredData: !failed('structured-data'),
      contrast: !failed('color-contrast'),
      tapTargets: !failed('tap-targets'),
      modernImages: !failed('uses-webp-images') && !failed('modern-image-formats'),
      imageSizing: !failed('uses-responsive-images'),
      textCompression: !failed('uses-text-compression'),
      https: !failed('is-on-https'),
    },
  };

  await store.set(cacheKey, JSON.stringify(result), { ex: 60 * 60 * 20 }); // 20h cache
  return result;
}
