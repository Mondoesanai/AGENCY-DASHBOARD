// Who we approach, and who we only answer.
//
// R19.5. The outbound segment is "an established business that already has a
// verified website and might benefit from a better one". Two words there do
// real work:
//
//   ESTABLISHED — enough evidence that this is a going concern, not a listing
//     somebody created once. We do not have a trading-history source, so this
//     is honest about being a weak signal and says what it is based on.
//
//   VERIFIED — we loaded the site and it is the BUSINESS'S OWN. A Yelp page, a
//     Facebook page or a Linktree loads perfectly and mentions the business by
//     name, so `verifyWebsite` would call it present. It is not a website we
//     could redesign, and calling it one puts a false premise in the first
//     sentence of a cold email: "I had a look at your site".
//
// AND THE ASYMMETRY THAT MATTERS: somebody with no website who asks us for help
// is a real prospect and must be served. They are simply not in the OUTBOUND
// segment, because we did not go and find them — they came to us. Mixing the
// two is how an inbound enquiry ends up receiving cold outreach.

import { WEB_STATUS } from './discovery.js';

/**
 * Platforms whose pages are PROFILES, not the business's own site.
 *
 * Being on this list is not a judgement about the platform. It is a statement
 * that a page there is somebody else's property with somebody else's template,
 * so "you already have a website, I could build you a better one" is not a
 * sentence that applies to it.
 */
export const LISTING_HOSTS = Object.freeze([
  'facebook.com', 'm.facebook.com', 'fb.me', 'fb.com',
  'instagram.com', 'linkedin.com', 'x.com', 'twitter.com', 'tiktok.com',
  'yelp.com', 'yelp.ca', 'tripadvisor.com', 'nextdoor.com',
  'google.com', 'business.site', 'sites.google.com', 'g.page', 'maps.app.goo.gl',
  'linktr.ee', 'linktree.com', 'bio.link', 'beacons.ai', 'carrd.co',
  'yellowpages.com', 'bbb.org', 'angi.com', 'angieslist.com', 'thumbtack.com',
  'homeadvisor.com', 'houzz.com', 'porch.com', 'manta.com', 'chamberofcommerce.com',
  'doordash.com', 'ubereats.com', 'grubhub.com', 'opentable.com', 'vagaro.com',
  'booksy.com', 'square.site', 'squareup.com', 'wixsite.com', 'weebly.com',
  'blogspot.com', 'wordpress.com', 'medium.com', 'etsy.com', 'ebay.com', 'amazon.com',
]);

/** Is this URL a profile on somebody else's platform? */
export function isListingUrl(url) {
  let host;
  try {
    host = new URL(String(url || '')).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return { listing: false, known: false, reason: 'not a URL that could be read' };
  }
  const hit = LISTING_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
  if (hit) {
    return { listing: true, known: true, platform: hit, reason: `${hit} is a profile on somebody else's platform, not this business's own website` };
  }
  return { listing: false, known: true, host };
}

/** What a site's evidence actually supports. */
export const WEBSITE_EVIDENCE = Object.freeze({
  OWN_SITE: 'own-site',              // loaded, matched, on their own domain
  LISTING_PROFILE: 'listing-profile', // loaded and matched, but a profile page
  UNMATCHED: 'unmatched',            // loaded, nothing tied it to this business
  NOT_LOADED: 'not-loaded',          // listed but would not load
  NONE_FOUND: 'none-found',          // no website linked from the listing
  UNKNOWN: 'unknown',                // never checked
});

export const EVIDENCE_WORDING = Object.freeze({
  'own-site': 'has their own website, which loads and matches the business',
  'listing-profile': 'has a profile on another platform, not a website of their own',
  unmatched: 'has a site that loads, but nothing on it ties it to this business',
  'not-loaded': 'lists a website that would not load when checked',
  'none-found': 'had no website linked from the listing — which is NOT evidence they have none',
  unknown: 'has not been checked',
});

/**
 * Read a `verifyWebsite` result into evidence that can be acted on.
 *
 * The single thing this adds: PRESENT alone is not "they have a website". A
 * profile page is PRESENT, and the outbound premise does not apply to it.
 */
export function websiteEvidence(verification) {
  if (!verification || !verification.status) {
    return { kind: WEBSITE_EVIDENCE.UNKNOWN, verified: false, url: null, why: 'no check has been run' };
  }
  const url = verification.attempted || null;

  if (verification.status === WEB_STATUS.NOT_LINKED) {
    return {
      kind: WEBSITE_EVIDENCE.NONE_FOUND, verified: false, url: null,
      why: 'no website was linked from the listing. This is what the listing shows, NOT evidence the business has none.',
    };
  }
  if (verification.status === WEB_STATUS.INACCESSIBLE) {
    return { kind: WEBSITE_EVIDENCE.NOT_LOADED, verified: false, url, why: verification.observation || 'the listed website did not load' };
  }
  if (verification.status === WEB_STATUS.UNCERTAIN) {
    return { kind: WEBSITE_EVIDENCE.UNMATCHED, verified: false, url, why: verification.observation || 'nothing on the page tied it to this business' };
  }

  // PRESENT — loaded and matched. One question left, and it is the one that
  // decides whether the outbound premise is true.
  const listing = isListingUrl(url);
  if (listing.listing) {
    return {
      kind: WEBSITE_EVIDENCE.LISTING_PROFILE,
      // Explicitly NOT verified as a website. This is the mislabel the whole
      // module exists to prevent.
      verified: false,
      url,
      platform: listing.platform,
      why: listing.reason,
    };
  }
  return {
    kind: WEBSITE_EVIDENCE.OWN_SITE,
    verified: true,
    url,
    signals: verification.signals || [],
    why: verification.observation || 'the site loads and matches this business',
  };
}

export const SEGMENT = Object.freeze({
  // The only segment proactive outreach may draw from.
  OUTBOUND_ESTABLISHED: 'outbound-established-with-website',
  // Came to us. Served, never cold-contacted.
  INBOUND_REQUEST: 'inbound-request',
  // Found, but the premise does not hold. Kept, not approached.
  NOT_OUTBOUND: 'not-outbound',
});

/**
 * Signals that this is a going concern rather than a listing somebody made.
 *
 * Deliberately modest. We have no trading history, no revenue and no filing
 * data, so this does not pretend to establish age — it collects what the
 * listing and the site actually showed, and says how many of them there were.
 */
export function establishedSignals(prospect = {}) {
  // Deliberately NOT counting the website, or anything the website showed.
  //
  // A verified own site is already a separate requirement of this segment, so
  // counting it here lets it satisfy both: a bare name plus a website scored
  // two signals and qualified, which made "established" mean nothing beyond
  // "has a website". These are the signals of a going concern that the website
  // did not supply.
  const signals = [];
  if (prospect.phone) signals.push('a published phone number');
  if (prospect.address || prospect.street) signals.push('a street address');
  if (prospect.openingHours) signals.push('published opening hours');
  return signals;
}

/**
 * Which segment is this prospect in, and may we approach them?
 *
 * Returns a refusal with a reason rather than a boolean, because every caller
 * that drops somebody from outreach should be able to say why on a screen.
 */
export function segmentFor(prospect = {}, { verification = null, inbound = false, minSignals = 2 } = {}) {
  // Somebody who asked us is never in the outbound segment, whatever their
  // website situation — including when they have a perfectly good one. We did
  // not go looking for them, and treating an enquiry as a discovered lead is
  // how an inbound person receives cold outreach.
  if (inbound) {
    return {
      segment: SEGMENT.INBOUND_REQUEST,
      mayOutbound: false,
      mayServe: true,
      why: 'they came to us. They are served on the strength of their request, and are never added to proactive outreach.',
    };
  }

  const evidence = websiteEvidence(verification);
  if (!evidence.verified) {
    return {
      segment: SEGMENT.NOT_OUTBOUND,
      mayOutbound: false,
      mayServe: true,
      evidence,
      why: `proactive outreach is for businesses with a verified website of their own, and this one ${EVIDENCE_WORDING[evidence.kind]}.`,
    };
  }

  const signals = establishedSignals(prospect);
  if (signals.length < minSignals) {
    return {
      segment: SEGMENT.NOT_OUTBOUND,
      mayOutbound: false,
      mayServe: true,
      evidence,
      signals,
      why: `too little to say this is an established business: ${signals.length ? `only ${signals.join(' and ')}, beyond the website` : 'nothing beyond a name and a website'}.`,
    };
  }

  return {
    segment: SEGMENT.OUTBOUND_ESTABLISHED,
    mayOutbound: true,
    mayServe: true,
    evidence,
    signals,
    // The premise of the message, stated so it can be checked against what was
    // actually observed rather than assumed by whoever writes the copy.
    premise: `They have their own website at ${evidence.url}, which loads and matches the business. An approach must be about improving what exists.`,
    why: `verified own website, and ${signals.length} signals of an established business: ${signals.join(', ')}.`,
  };
}

/**
 * The gate a cold send asks.
 *
 * Fails closed: anything other than a positive, evidenced placement in the
 * outbound segment is a refusal.
 */
export function mayApproach(prospect, opts = {}) {
  const s = segmentFor(prospect, opts);
  if (s.segment !== SEGMENT.OUTBOUND_ESTABLISHED) {
    return { ok: false, reason: s.why, segment: s.segment };
  }
  return { ok: true, segment: s.segment, premise: s.premise, evidence: s.evidence };
}
