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

  let json;
  try {
    const r = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(55000) });
    json = await r.json();
    if (json.error) throw new Error(json.error.message);
  } catch (e) {
    // cache failures briefly too, so repeated dashboard loads don't keep
    // hammering a rate-limited API
    const errResult = { url, ok: false, error: String(e.message || e), fetchedAt: Date.now() };
    await store.set(cacheKey, JSON.stringify(errResult), { ex: 60 * 90 }); // 90 min
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
