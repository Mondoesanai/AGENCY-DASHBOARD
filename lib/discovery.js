// R4 — discovery and qualification.
//
// SOURCE CHOICE (R4.2), and why the obvious one was rejected
// ---------------------------------------------------------
// Google Places has the best coverage of small US businesses, and its policy
// settles the matter: "You must not pre-fetch, cache, or store Places API
// content beyond the allowed exceptions", with the place ID as the single
// exception that may be stored indefinitely. R4.2 requires a source whose terms
// permit collection, STORAGE and outreach use. Places fails on storage, so it
// is not used — not as a default, not as a fallback.
//
// OpenStreetMap via the Overpass API is used instead. OSM data is ODbL 1.0:
// copying, storage, adaptation and commercial use are permitted with
// attribution, and there is no field-of-use restriction that would bar
// contacting a business found there. The honest trade-off is coverage: OSM's
// record of small US service businesses is patchy, so a quiet result means
// "OSM does not know about them", never "they do not exist". Nothing in this
// module may say otherwise.
//
// Overpass fair use, from its own documentation: under 10,000 queries and 1GB
// per day for ad-hoc use, "divide those numbers by 100" for anything running
// regularly, identify yourself with a User-Agent, cache results, and back off
// for 30 seconds on a 429 or 406. All of that is implemented below.
//
// WEBSITE VERIFICATION (R4.6, R4.7)
// ---------------------------------
// The product's whole pitch is for businesses whose web presence is weak or
// missing, so the difference between "no website" and "no website LINKED FROM
// THIS LISTING" decides whether the outreach is honest. A listing with no
// website tag is NOT evidence of no website. Every prospect therefore ends up
// in one of four states and the wording follows the state, not the hope.

import { store } from './store.js';
import { getSettings, osmFiltersFor, withinTargeting } from './settings.js';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const USER_AGENT = 'InspiringWebsites-dashboard/1.0 (+https://inspiringwebsites.org; contact via site)';

export const ATTRIBUTION = '© OpenStreetMap contributors, ODbL 1.0';

/** The four honest outcomes of looking for a business's website. */
export const WEB_STATUS = Object.freeze({
  PRESENT: 'verified-present', // we fetched it and it is a real site for this business
  NOT_LINKED: 'not-linked-in-listing', // the listing has no website; we did NOT conclude they have none
  INACCESSIBLE: 'inaccessible', // a site is listed but would not load
  UNCERTAIN: 'uncertain', // something is there, but we could not tie it to this business
});

/** Human wording for each state. Used verbatim in outreach, so it is reviewed here. */
export const WEB_STATUS_WORDING = Object.freeze({
  [WEB_STATUS.PRESENT]: 'has a website that loads',
  [WEB_STATUS.NOT_LINKED]: "I couldn't find a website linked from your listing",
  [WEB_STATUS.INACCESSIBLE]: 'lists a website that would not load when checked',
  [WEB_STATUS.UNCERTAIN]: 'may have a website — not confirmed',
});

// ---------------------------------------------------------------------------
// Overpass query building
// ---------------------------------------------------------------------------

/** Build an Overpass QL query for the given tag filters inside a bbox. */
export function buildQuery(filters, bbox, { limit = 200, timeout = 50 } = {}) {
  const bb = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const parts = [];
  for (const f of filters) {
    const [k, v] = String(f.tag).split('=');
    if (!k || !v) continue;
    for (const kind of ['node', 'way']) parts.push(`  ${kind}["${k}"="${v}"](${bb});`);
  }
  if (!parts.length) return null;
  return `[out:json][timeout:${timeout}];\n(\n${parts.join('\n')}\n);\nout center tags ${limit};`;
}

/** Map one Overpass element to our prospect shape. Nothing is invented. */
export function elementToProspect(el, industryByTag = {}) {
  const t = el.tags || {};
  const name = t.name || t['brand'] || null;
  if (!name) return null; // an unnamed node is not a prospect

  const industry =
    industryByTag[`${'shop'}=${t.shop}`] ||
    industryByTag[`${'craft'}=${t.craft}`] ||
    industryByTag[`${'office'}=${t.office}`] ||
    null;

  const addr = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  return {
    sourceId: `osm:${el.type}/${el.id}`,
    source: 'openstreetmap',
    name,
    industry,
    phone: t.phone || t['contact:phone'] || null,
    email: t.email || t['contact:email'] || null,
    website: t.website || t['contact:website'] || t.url || null,
    address: addr || null,
    city: t['addr:city'] || null,
    postcode: t['addr:postcode'] || null,
    lat: el.lat ?? el.center?.lat ?? null,
    lon: el.lon ?? el.center?.lon ?? null,
    // everything below is evidence, kept separate from conclusions (R4.9)
    evidence: {
      collectedAt: Date.now(),
      sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
      attribution: ATTRIBUTION,
      rawTags: t,
    },
  };
}

// ---------------------------------------------------------------------------
// The adapter. `fetchImpl` is injected so every test runs against fixtures.
// ---------------------------------------------------------------------------

export function createOverpassAdapter({ fetchImpl = globalThis.fetch, url = OVERPASS_URL, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  return {
    name: 'openstreetmap-overpass',
    /** No credential is required, so this adapter is genuinely connected. */
    configured: () => true,
    licence: ATTRIBUTION,

    async search({ filters, bbox, limit = 200 }) {
      const q = buildQuery(filters, bbox, { limit });
      if (!q) return { ok: false, error: 'no industry filters configured', prospects: [] };

      const industryByTag = {};
      for (const f of filters) industryByTag[f.tag] = f.key;

      for (let attempt = 0; attempt < 2; attempt++) {
        let res;
        try {
          res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain', 'User-Agent': USER_AGENT },
            body: q,
            signal: AbortSignal.timeout(60000),
          });
        } catch (e) {
          return { ok: false, error: `overpass unreachable: ${e.message || e}`, transient: true, prospects: [] };
        }
        // documented backoff: pause 30s on 429/406 rather than hammering
        if (res.status === 429 || res.status === 406) {
          if (attempt === 0) { await sleep(30000); continue; }
          return { ok: false, error: `overpass rate limit (${res.status})`, transient: true, prospects: [] };
        }
        if (!res.ok) return { ok: false, error: `overpass ${res.status}`, transient: res.status >= 500, prospects: [] };

        const body = await res.json().catch(() => null);
        const els = body?.elements || [];
        const prospects = els.map((e) => elementToProspect(e, industryByTag)).filter(Boolean);
        return { ok: true, prospects, query: q, attribution: ATTRIBUTION };
      }
      return { ok: false, error: 'overpass rate limit', transient: true, prospects: [] };
    },
  };
}

// ---------------------------------------------------------------------------
// Website verification (R4.6, R4.7, R4.8, R11.9)
// ---------------------------------------------------------------------------

const PRIVATE_HOST = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.0\.0\.0|\[?::1\]?$)/i;

/** R11.9 — a prospect-supplied URL must never be able to reach internal services. */
export function safeUrl(raw) {
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
  } catch {
    return { ok: false, reason: 'not a url' };
  }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: `blocked protocol ${u.protocol}` };
  if (PRIVATE_HOST.test(u.hostname)) return { ok: false, reason: 'private or loopback address' };
  if (!u.hostname.includes('.')) return { ok: false, reason: 'not a public hostname' };
  if (u.port && !['80', '443', ''].includes(u.port)) return { ok: false, reason: `blocked port ${u.port}` };
  return { ok: true, url: u.toString(), host: u.hostname.replace(/^www\./, '') };
}

/** Does this page actually belong to this business? Evidence, not vibes. */
export function matchesBusiness(html, prospect) {
  const text = String(html || '').toLowerCase();
  const found = [];
  const name = String(prospect.name || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  if (name && name.length > 3 && text.includes(name)) found.push('business name');
  if (prospect.phone) {
    const digits = String(prospect.phone).replace(/\D/g, '').slice(-7);
    if (digits.length === 7 && text.replace(/\D/g, '').includes(digits)) found.push('phone number');
  }
  if (prospect.postcode && text.includes(String(prospect.postcode).toLowerCase())) found.push('postcode');
  return { matched: found.length > 0, signals: found };
}

/**
 * Resolve one prospect's web presence.
 * Never submits a form, never follows beyond one page (R4.8).
 */
export async function verifyWebsite(prospect, { fetchImpl = globalThis.fetch, maxBytes = 300000 } = {}) {
  const base = { checkedAt: Date.now(), attempted: null, signals: [] };

  if (!prospect.website) {
    return {
      ...base,
      status: WEB_STATUS.NOT_LINKED,
      // the exact sentence R4.7 demands — an observation, not a conclusion
      observation: "I couldn't find a website linked from your OpenStreetMap listing.",
      note: 'This is only what the listing shows. It is NOT evidence that the business has no website.',
    };
  }

  const safe = safeUrl(prospect.website);
  if (!safe.ok) {
    return { ...base, status: WEB_STATUS.INACCESSIBLE, attempted: prospect.website, observation: `The listed website could not be used: ${safe.reason}.` };
  }

  let res;
  try {
    res = await fetchImpl(safe.url, { redirect: 'follow', headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(12000) });
  } catch (e) {
    return { ...base, status: WEB_STATUS.INACCESSIBLE, attempted: safe.url, observation: `The listed website did not load (${String(e.message || e).slice(0, 60)}).` };
  }
  if (!res.ok) {
    return { ...base, status: WEB_STATUS.INACCESSIBLE, attempted: safe.url, httpStatus: res.status, observation: `The listed website returned HTTP ${res.status}.` };
  }

  const html = (await res.text().catch(() => '')).slice(0, maxBytes);
  const m = matchesBusiness(html, prospect);
  if (!m.matched) {
    return {
      ...base,
      status: WEB_STATUS.UNCERTAIN,
      attempted: safe.url,
      httpStatus: res.status,
      observation: 'A website is listed and it loads, but nothing on the page ties it to this business.',
    };
  }
  return {
    ...base,
    status: WEB_STATUS.PRESENT,
    attempted: safe.url,
    httpStatus: res.status,
    signals: m.signals,
    observation: `The listed website loads and matches this business (${m.signals.join(', ')}).`,
  };
}

// ---------------------------------------------------------------------------
// R4.5 — who are we actually writing to?
//
// The temptation in prospecting tools is to dress a generic inbox up as the
// owner, because "Hi Pat" outperforms "Hi there". That is a lie told to a
// stranger in the first sentence, and it is also the thing most likely to get
// a reply like "who is Pat?". So:
//
//   * a role inbox stays a role inbox, whatever the business name suggests
//   * a person is named only when something we actually read names them
//   * an address is NEVER constructed from a name and a domain
//
// The output drives the greeting, so the message cannot address someone the
// evidence does not support.
// ---------------------------------------------------------------------------

/** Mailbox names that belong to a function, not a person. */
const ROLE_LOCALPARTS = new Set([
  'info', 'contact', 'hello', 'hi', 'sales', 'support', 'help', 'admin', 'office',
  'enquiries', 'inquiries', 'enquiry', 'inquiry', 'mail', 'email', 'team', 'service',
  'services', 'bookings', 'booking', 'reception', 'accounts', 'billing', 'invoices',
  'careers', 'jobs', 'hr', 'press', 'media', 'marketing', 'noreply', 'no-reply',
  'donotreply', 'webmaster', 'postmaster', 'abuse', 'general', 'estimates', 'quotes',
  'schedule', 'scheduling', 'dispatch', 'orders',
]);

export function classifyEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return { kind: 'none', isRole: false, canNamePerson: false };
  const local = email.split('@')[0].replace(/\+.*$/, '');
  const bare = local.replace(/[^a-z]/g, '');

  if (ROLE_LOCALPARTS.has(local) || ROLE_LOCALPARTS.has(bare)) {
    return {
      kind: 'role',
      isRole: true,
      canNamePerson: false,
      label: 'shared inbox',
      note: `"${local}@" is a shared mailbox. It is not evidence of who owns or runs the business.`,
    };
  }
  // first.last@ or first@ LOOKS personal, but a plausible shape is not proof
  const looksPersonal = /^[a-z]+([._-][a-z]+)?$/.test(local) && local.length <= 24;
  return {
    kind: looksPersonal ? 'possibly-personal' : 'unknown',
    isRole: false,
    // still false: the address shape does not tell us the person's name or role
    canNamePerson: false,
    label: looksPersonal ? 'possibly a person' : 'unclassified',
    note: looksPersonal
      ? 'The address looks like a person, but that is a guess from its shape, not evidence of who they are.'
      : 'Nothing about this address identifies a person.',
  };
}

/**
 * What, if anything, do we actually know about a named human here?
 * Only sources we READ count — an OSM `operator` or `contact:person` tag, or a
 * name the owner typed in. Never the email shape, never the business name.
 */
export function decisionMakerEvidence(prospect) {
  const tags = prospect?.evidence?.rawTags || {};
  const fromTag = tags['contact:person'] || tags.operator || null;
  const emailClass = classifyEmail(prospect?.email);

  if (prospect?.contactNameSource === 'owner-entered' && prospect?.contactName) {
    return {
      level: 'stated-by-owner',
      personName: prospect.contactName,
      canAddressByName: true,
      basis: 'you entered this name yourself',
    };
  }
  if (fromTag && String(fromTag).trim().length > 2) {
    return {
      level: 'named-in-listing',
      personName: String(fromTag).trim(),
      canAddressByName: true,
      basis: `the listing names them (OpenStreetMap "${tags['contact:person'] ? 'contact:person' : 'operator'}" tag)`,
    };
  }
  return {
    level: 'none',
    personName: null,
    canAddressByName: false,
    basis: emailClass.isRole
      ? 'the only address is a shared inbox, which names nobody'
      : 'nothing we read names a person at this business',
    emailNote: emailClass.note,
  };
}

/**
 * The greeting line, decided by evidence rather than by what reads best.
 * Returns the literal text, so there is one place where this can go wrong.
 */
export function greetingFor(prospect) {
  const ev = decisionMakerEvidence(prospect);
  if (ev.canAddressByName && ev.personName) {
    const first = String(ev.personName).trim().split(/\s+/)[0];
    return { text: `Hi ${first},`, named: true, basis: ev.basis };
  }
  return { text: 'Hi,', named: false, basis: ev.basis };
}

/**
 * Hard refusal: an address is never constructed from a person's name and a
 * domain. Exported so the prohibition is testable rather than merely absent.
 */
export function guessEmailFromName() {
  return {
    ok: false,
    reason: 'An email address is never constructed from a name and a domain. A guessed address reaches a stranger or bounces, and either way it was never evidence.',
  };
}

/** A title may only be claimed when something we read states it. */
export function titleClaim(prospect) {
  const tags = prospect?.evidence?.rawTags || {};
  const stated = tags['contact:position'] || tags['operator:type'] || null;
  if (stated) return { claim: String(stated).trim(), basis: 'stated in the listing' };
  return { claim: null, basis: 'no title is stated anywhere we read, so none is claimed' };
}

// ---------------------------------------------------------------------------
// Qualification — comparing weak sites against ones we could not find at all
// ---------------------------------------------------------------------------

/**
 * R4.10 — this function may never produce a claim about lost revenue,
 * conversion rate or a broken form. It reports only what was observed.
 */
export function qualify(prospect, web, settings) {
  const within = withinTargeting(settings, prospect);
  const reasons = [];
  let segment;

  if (web.status === WEB_STATUS.PRESENT) {
    segment = 'has-site';
    reasons.push('A website was verified, so any approach must be about improving what exists.');
  } else if (web.status === WEB_STATUS.NOT_LINKED) {
    segment = 'no-site-found';
    reasons.push('No website was linked from the listing. Treat as "could not find", never as "does not have".');
  } else if (web.status === WEB_STATUS.INACCESSIBLE) {
    segment = 'weak-site';
    reasons.push('A website is listed but did not load when checked.');
  } else {
    segment = 'uncertain';
    reasons.push('A site was reachable but could not be tied to this business.');
  }

  const contactable = !!(prospect.email || prospect.phone);
  if (!contactable) reasons.push('No email or phone in the listing, so there is no way to make contact yet.');

  return {
    segment,
    eligible: within.ok && contactable && segment !== 'uncertain',
    ineligibleReason: !within.ok ? within.reason : !contactable ? 'no contact details' : segment === 'uncertain' ? 'web presence uncertain' : null,
    reasons,
    // what may truthfully be said, derived from the status rather than written by hand
    observationForOutreach: web.observation,
  };
}

// ---------------------------------------------------------------------------
// Storage + dedup (R4.11)
// ---------------------------------------------------------------------------

const PKEY = (id) => `prospect:${id}`;
const INDEX = 'prospects:all';
const SEEN = 'prospects:seen';

/** A stable key for "the same business", independent of the source. */
export function identityKey(p) {
  const host = p.website ? String(p.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase() : '';
  if (host) return `web:${host}`;
  const phone = String(p.phone || '').replace(/\D/g, '').slice(-10);
  if (phone.length === 10) return `tel:${phone}`;
  const name = String(p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const city = String(p.city || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return `name:${name}|${city}`;
}

export async function saveProspects(list) {
  const saved = [];
  const skipped = [];
  for (const p of list) {
    const key = identityKey(p);
    const already = await store.get(`prospect:key:${key}`).catch(() => null);
    if (already) { skipped.push({ name: p.name, reason: 'already discovered', existing: already }); continue; }
    const id = p.sourceId.replace(/[^a-z0-9]/gi, '-');
    await store.set(PKEY(id), JSON.stringify({ ...p, id, identityKey: key, discoveredAt: Date.now() }));
    await store.set(`prospect:key:${key}`, id);
    await store.sadd(INDEX, id);
    await store.sadd(SEEN, key);
    saved.push(id);
  }
  return { saved, skipped };
}

export async function listProspects({ limit = 200 } = {}) {
  const ids = await store.smembers(INDEX).catch(() => []);
  const out = [];
  for (const id of ids.slice(0, limit)) {
    const raw = await store.get(PKEY(id)).catch(() => null);
    if (!raw) continue;
    try { out.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch { /* skip */ }
  }
  return out;
}

export async function getProspect(id) {
  const raw = await store.get(PKEY(id)).catch(() => null);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

export async function updateProspect(id, patch) {
  const cur = await getProspect(id);
  if (!cur) return null;
  const next = { ...cur, ...patch, id, updatedAt: Date.now() };
  await store.set(PKEY(id), JSON.stringify(next));
  return next;
}

/**
 * One bounded discovery run. Returns everything it did, including what it
 * refused to do and why.
 */
export async function runDiscovery({ adapter, industries = null, max = 25, verify = true, fetchImpl = globalThis.fetch } = {}) {
  const settings = await getSettings();
  const filters = osmFiltersFor(settings, industries);
  if (!filters.length) return { ok: false, error: 'no industries configured in targeting settings', found: 0 };

  const ad = adapter || createOverpassAdapter({ fetchImpl });
  const res = await ad.search({ filters, bbox: settings.targeting.geography.bbox, limit: Math.min(max * 4, 400) });
  if (!res.ok) return { ok: false, error: res.error, transient: !!res.transient, found: 0 };

  const { saved, skipped } = await saveProspects(res.prospects.slice(0, max));

  let verified = 0;
  const segments = { 'has-site': 0, 'weak-site': 0, 'no-site-found': 0, uncertain: 0 };
  if (verify) {
    for (const id of saved) {
      const p = await getProspect(id);
      if (!p) continue;
      const web = await verifyWebsite(p, { fetchImpl });
      const q = qualify(p, web, settings);
      await updateProspect(id, { web, qualification: q });
      segments[q.segment] = (segments[q.segment] || 0) + 1;
      verified++;
    }
  }

  return {
    ok: true,
    source: ad.name,
    attribution: ad.licence,
    found: res.prospects.length,
    saved: saved.length,
    skippedAsDuplicate: skipped.length,
    verified,
    segments,
    targetingStatus: settings.targeting.status,
    outreachActive: settings.outreach.active,
    note: 'Discovery stores prospects only. Nothing here sends anything.',
  };
}
