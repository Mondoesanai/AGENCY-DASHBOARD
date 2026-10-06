// Looking things up on the web, or honestly reporting that we cannot.
//
// `lib/asset-research.js` takes `search` and `fetchPage` as injected
// functions, which made it testable and left it unreachable: nothing in the
// application supplied either, so the research step could never actually run.
// The module was wired structurally and inert in practice — the same shape as
// the delivery receipt that had no caller.
//
// This is the missing half, built the way the Twilio adapter is built: a real
// provider behind a `configured()` check, and a disconnected stand-in that
// explains itself rather than failing obscurely. Nothing here signs anybody up
// for anything; with no key present it reports that it cannot look, which is
// the correct answer and the one production gives today.
//
// ON CHOOSING A PROVIDER. Brave's API is used because it returns plain JSON
// over a single GET with one header, which keeps the surface small. The shape
// is deliberately narrow — a query string in, `{title, url, description}` out
// — so swapping providers means writing one adapter, not touching the research
// logic that decides what the results mean.

const RESULT_LIMIT = 8;
const TIMEOUT_MS = 12000;

/** The env keys a working search provider needs. */
export const SEARCH_PROVIDER = Object.freeze({
  key: 'brave',
  label: 'Web search',
  envKeys: ['BRAVE_SEARCH_API_KEY'],
  docs: 'https://api-dashboard.search.brave.com/app/documentation',
  what: 'Finds an organisation\'s official site when no brand-resources URL is on file.',
});

/**
 * A searcher that refuses, and says why.
 *
 * Returned whenever no key is configured. It is a real object rather than
 * `null` so callers do not have to branch — and `configured()` is false, so
 * the research reports `needs-search` instead of an empty result set. Those
 * are different facts: "we looked and found nothing" would be a lie.
 */
export function createDisconnectedSearchAdapter(reason = 'no web-search provider is configured') {
  return {
    name: 'disconnected',
    label: SEARCH_PROVIDER.label,
    configured: () => false,
    reason,
    async search() { return { ok: false, error: reason, disconnected: true, results: [] }; },
    async fetchPage() { return { ok: false, error: reason, disconnected: true, text: '' }; },
  };
}

export function createBraveSearchAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const key = () => env.BRAVE_SEARCH_API_KEY;

  return {
    name: SEARCH_PROVIDER.key,
    label: SEARCH_PROVIDER.label,
    configured: () => !!key(),

    async search(query) {
      if (!key()) return { ok: false, error: 'not connected: no search credentials', disconnected: true, results: [] };
      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(String(query).slice(0, 380))}&count=${RESULT_LIMIT}`;
        const res = await fetchImpl(url, {
          headers: { Accept: 'application/json', 'X-Subscription-Token': key() },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, error: `search ${res.status}`, status: res.status, results: [], transient: res.status >= 500 || res.status === 429 };
        const j = await res.json().catch(() => ({}));
        const results = (j?.web?.results || []).slice(0, RESULT_LIMIT).map((r) => ({
          title: String(r.title || '').slice(0, 200),
          url: String(r.url || ''),
          description: String(r.description || '').slice(0, 400),
        })).filter((r) => r.url);
        return { ok: true, results };
      } catch (e) {
        return { ok: false, error: String(e.message || e), transient: true, results: [] };
      }
    },

    /**
     * Fetch a page as text.
     *
     * Deliberately plain: tags stripped, length capped. The research reads this
     * for usage terms, and what it must never do is execute or trust it — a
     * brand page is somebody else's HTML and is data, not instructions.
     */
    async fetchPage(pageUrl) {
      if (!/^https:\/\//i.test(String(pageUrl || ''))) return { ok: false, error: 'only https pages are fetched', text: '' };
      try {
        const res = await fetchImpl(pageUrl, {
          headers: { Accept: 'text/html,text/plain', 'User-Agent': 'InspiringWebsites/1.0 (+brand-asset-check)' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'follow',
        });
        if (!res.ok) return { ok: false, error: `page ${res.status}`, status: res.status, text: '' };
        const html = await res.text();
        const text = String(html)
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 20000);
        return { ok: true, text };
      } catch (e) {
        return { ok: false, error: String(e.message || e), transient: true, text: '' };
      }
    },
  };
}

/** The configured searcher, or one that explains why it cannot look. */
export function getSearchAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const a = createBraveSearchAdapter({ env, fetchImpl });
  return a.configured()
    ? a
    : createDisconnectedSearchAdapter(`no web-search provider is configured (needs ${SEARCH_PROVIDER.envKeys.join(', ')} in Vercel)`);
}

/**
 * The two functions `asset-research.js` expects, or nulls.
 *
 * Returning NULL rather than a refusing function is deliberate: the research
 * checks `typeof search === 'function'` and reports `needs-search`, which is a
 * different and more useful answer than "searched and found nothing".
 */
export function researchTools({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const a = getSearchAdapter({ env, fetchImpl });
  if (!a.configured()) return { search: null, fetchPage: null, adapter: a, configured: false, reason: a.reason };
  return {
    configured: true,
    adapter: a,
    search: async (q) => {
      const r = await a.search(q);
      return r.ok ? r.results : [];
    },
    fetchPage: async (u) => {
      const r = await a.fetchPage(u);
      return r.ok ? r.text : '';
    },
  };
}

/**
 * Guess the organisation a requirement is about.
 *
 * "add the official CPD Standards Office accreditation logo" → "CPD Standards
 * Office". Only used when nothing is on the client's card, and only as a
 * starting point for research whose own identity check can still reject it —
 * a wrong guess here costs a search, not a wrong logo.
 */
export function organisationFrom(text) {
  const s = String(text || '');
  // the shape brand asks almost always take: "<Org> logo/mark/badge/seal"
  const m = s.match(/\b(?:official\s+)?([A-Z][\w&.'-]*(?:\s+(?:of|the|for|and|[A-Z][\w&.'-]*)){0,4})\s+(?:accreditation\s+)?(?:logo|mark|badge|seal|emblem|crest)\b/);
  if (m && m[1]) {
    const org = m[1].replace(/\b(?:the|official|new|our)\b\s*/gi, '').trim();
    if (org.length > 2) return org;
  }
  // "accredited by X", "certified by X"
  // "accredited by THE Chartered Institute" — the article is lowercase and
  // sits between the preposition and the name, so it has to be skipped or the
  // whole clause fails to match
  const by = s.match(/\b(?:accredited|certified|approved|registered)\s+(?:by|with)\s+(?:the\s+)?([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4})/);
  if (by && by[1]) return by[1].trim();
  return null;
}
