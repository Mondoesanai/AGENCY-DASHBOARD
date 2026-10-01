// Business settings (R4.1, G1 pricing, G4 targeting).
//
// Everything here is EDITABLE DATA, never a constant in the code. Two rules
// decide the shape of this file:
//
//  1. Pricing starts UNCONFIGURED, not zero and not a guess. An unset price and
//     a price of $0 are different facts, and outgoing copy must be able to tell
//     them apart so it can decline to quote rather than invent a number. That
//     is why `configured` is explicit and why `priceLine()` refuses.
//
//  2. Targeting starts as a DRAFT the owner can edit. The DFW service-business
//     seed below is a development assumption so discovery can be built and
//     tested — it is NOT authorisation to contact anyone. `outreachActive` is
//     false and nothing here can set it true.
import { store } from './store.js';

const KEY = 'settings:business';

export const UNSET = null;

/** The seed. Draft status is carried in the data, not in a comment. */
export function defaultSettings() {
  return {
    version: 1,
    pricing: {
      // G1 — the owner supplies these. Until then: unconfigured.
      configured: false,
      currency: 'USD',
      buildPrice: UNSET, // one-off initial build
      monthlyFee: UNSET, // hosting + unlimited revisions + ongoing conversion/SEO
      includes: [
        'Hosting',
        'Unlimited revisions',
        'Ongoing conversion and SEO improvement',
      ],
      note: 'Set the build price and monthly fee before any outgoing message may quote a price.',
    },
    targeting: {
      // G4 — a draft starting point, explicitly marked as an assumption.
      status: 'draft',
      source: 'development assumption, not owner-confirmed',
      geography: {
        label: 'Dallas–Fort Worth metroplex',
        // a generous DFW bounding box, south/west/north/east
        bbox: { south: 32.35, west: -97.55, north: 33.25, east: -96.45 },
        cities: ['Dallas', 'Fort Worth', 'Plano', 'Arlington', 'Irving', 'Frisco', 'McKinney', 'Denton', 'Garland', 'Richardson'],
      },
      industries: [
        // flooring and home services, as specified
        { key: 'flooring', label: 'Flooring', osm: ['shop=flooring', 'craft=floorer'] },
        { key: 'roofing', label: 'Roofing', osm: ['craft=roofer'] },
        { key: 'hvac', label: 'HVAC', osm: ['craft=hvac'] },
        { key: 'plumbing', label: 'Plumbing', osm: ['craft=plumber'] },
        { key: 'electrical', label: 'Electrical', osm: ['craft=electrician'] },
        { key: 'landscaping', label: 'Landscaping', osm: ['craft=gardener', 'shop=garden_centre'] },
        { key: 'painting', label: 'Painting', osm: ['craft=painter'] },
        { key: 'remodeling', label: 'Remodeling / general contracting', osm: ['craft=builder', 'office=construction_company'] },
      ],
      exclusions: {
        // "established businesses, not newly registered"
        minYearsInBusiness: 2,
        excludeChains: true,
        excludeSlugs: [],
        excludeDomains: [],
      },
      weeklyVolume: 25,
    },
    // R6.9 — CAN-SPAM requires a real identity and a physical postal address in
    // every commercial message. Stored as settings because they are the owner's
    // details, and left blank on purpose: a missing address must block the
    // message rather than ship a placeholder into real mail.
    sender: {
      name: '',
      business: 'Inspiring Websites LLC',
      postalAddress: '',
      replyTo: '',
      unsubscribeLine: "Reply with STOP and I won't contact you again.",
    },
    outreach: {
      // Nothing in this module can flip this. Activation is an owner action.
      active: false,
      reason: 'Outreach has never been activated. Sending stays off until a provider is connected and the owner switches it on.',
    },
    updatedAt: null,
  };
}

function coerceMoney(v) {
  if (v === null || v === undefined || v === '') return UNSET;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : UNSET;
  const raw = String(v).trim();
  // Strip only presentation characters — currency symbols, spaces, thousands
  // separators. NOT the minus sign: stripping it turned "-99" into 99, which
  // silently accepted a negative price as a positive one. And NOT letters:
  // stripping those turned "abc" into "" into Number("") === 0, so a typo
  // became a valid $0 price and marked pricing CONFIGURED.
  const cleaned = raw.replace(/[$£€,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return UNSET;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : UNSET;
}

export async function getSettings() {
  const raw = await store.get(KEY).catch(() => null);
  if (!raw) return defaultSettings();
  try {
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const base = defaultSettings();
    return {
      ...base,
      ...saved,
      pricing: { ...base.pricing, ...(saved.pricing || {}) },
      targeting: { ...base.targeting, ...(saved.targeting || {}) },
      sender: { ...base.sender, ...(saved.sender || {}) },
      // outreach.active is never restored as true by a merge accident
      outreach: { ...base.outreach, ...(saved.outreach || {}), active: saved?.outreach?.active === true },
    };
  } catch {
    return defaultSettings();
  }
}

export async function saveSettings(patch = {}) {
  const cur = await getSettings();
  const next = { ...cur, updatedAt: Date.now() };

  if (patch.pricing) {
    const p = { ...cur.pricing, ...patch.pricing };
    p.buildPrice = coerceMoney(p.buildPrice);
    p.monthlyFee = coerceMoney(p.monthlyFee);
    // configured is DERIVED, never taken from the caller — otherwise a client
    // could mark unset prices as configured and copy would quote nothing.
    p.configured = p.buildPrice !== UNSET && p.monthlyFee !== UNSET;
    if (Array.isArray(patch.pricing.includes)) p.includes = patch.pricing.includes.map((s) => String(s).slice(0, 80)).slice(0, 12);
    next.pricing = p;
  }

  if (patch.targeting) {
    const t = { ...cur.targeting, ...patch.targeting };
    if (patch.targeting.geography) t.geography = { ...cur.targeting.geography, ...patch.targeting.geography };
    if (patch.targeting.exclusions) t.exclusions = { ...cur.targeting.exclusions, ...patch.targeting.exclusions };
    if (patch.targeting.weeklyVolume !== undefined) {
      const n = parseInt(patch.targeting.weeklyVolume, 10);
      t.weeklyVolume = Number.isFinite(n) ? Math.max(0, Math.min(500, n)) : cur.targeting.weeklyVolume;
    }
    // any owner edit promotes the draft to confirmed
    if (patch.targeting.status === 'confirmed' || patch.targeting.industries || patch.targeting.geography) {
      t.status = patch.targeting.status === 'draft' ? 'draft' : 'confirmed';
      if (t.status === 'confirmed') t.source = 'owner-confirmed';
    }
    next.targeting = t;
  }

  await store.set(KEY, JSON.stringify(next));
  return next;
}

/**
 * The only sanctioned way to put a price into outgoing copy.
 * Returns null when pricing is unconfigured, so a caller that forgets to check
 * renders nothing rather than "$undefined" or an invented figure.
 */
export function priceLine(settings) {
  const p = settings?.pricing;
  if (!p || !p.configured || p.buildPrice === UNSET || p.monthlyFee === UNSET) return null;
  const fmt = (n) => `$${Number(n).toLocaleString('en-US')}`;
  return `${fmt(p.buildPrice)} to build, then ${fmt(p.monthlyFee)}/month`;
}

/** Why a message may not quote a price yet, in words the owner can act on. */
export function pricingBlocker(settings) {
  const p = settings?.pricing;
  if (p?.configured) return null;
  const missing = [];
  if (!p || p.buildPrice === UNSET) missing.push('build price');
  if (!p || p.monthlyFee === UNSET) missing.push('monthly fee');
  return `Pricing is not set (${missing.join(' and ')} missing), so no message may quote a price. Development is not blocked by this.`;
}

/** Is this prospect inside the configured targeting? */
export function withinTargeting(settings, prospect) {
  const t = settings?.targeting;
  if (!t) return { ok: false, reason: 'no targeting configured' };
  const b = t.geography?.bbox;
  if (b && prospect.lat != null && prospect.lon != null) {
    const inside = prospect.lat >= b.south && prospect.lat <= b.north && prospect.lon >= b.west && prospect.lon <= b.east;
    if (!inside) return { ok: false, reason: `outside ${t.geography.label}` };
  }
  if (t.exclusions?.excludeDomains?.length && prospect.website) {
    const host = String(prospect.website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].toLowerCase();
    if (t.exclusions.excludeDomains.some((d) => host.endsWith(String(d).toLowerCase()))) {
      return { ok: false, reason: 'domain is on the exclusion list' };
    }
  }
  if (t.industries?.length && prospect.industry && !t.industries.some((i) => i.key === prospect.industry)) {
    return { ok: false, reason: `industry "${prospect.industry}" is not in the target list` };
  }
  return { ok: true };
}

/**
 * The sender identity every outgoing message must carry.
 * Returns what is stored plus an explicit `complete` flag, so a caller cannot
 * accidentally build a message with a blank postal address.
 */
export async function ownerIdentity() {
  const s = await getSettings();
  const d = s.sender || {};
  return {
    ...d,
    complete: !!(d.name && d.business && d.postalAddress),
    missing: ['name', 'business', 'postalAddress'].filter((k) => !d[k]),
  };
}

export async function saveSender(patch = {}) {
  const cur = await getSettings();
  const sender = { ...cur.sender };
  for (const k of ['name', 'business', 'postalAddress', 'replyTo', 'unsubscribeLine']) {
    if (patch[k] !== undefined) sender[k] = String(patch[k]).slice(0, 200).trim();
  }
  const next = { ...cur, sender, updatedAt: Date.now() };
  await store.set(KEY, JSON.stringify(next));
  return next;
}

/** Overpass tag filters for the configured industries. */
export function osmFiltersFor(settings, keys = null) {
  const inds = (settings?.targeting?.industries || []).filter((i) => !keys || keys.includes(i.key));
  const out = [];
  for (const i of inds) for (const tag of i.osm || []) out.push({ key: i.key, tag });
  return out;
}
