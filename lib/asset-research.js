// Finding an organisation's official mark, and deciding whether we may use it.
//
// WHY THIS IS NOT JUST A SEARCH. Isha Lo's site carried a hand-drawn copy of
// the CPD Standards Office's certification mark for weeks, and the reason it
// was drawn rather than fetched is that nobody had the file. The obvious fix —
// search the web, take the first logo that looks right — is worse than the
// drawing, because a mark taken from an unrelated page looks authentic and
// nobody checks it again.
//
// So this separates two questions that are easy to run together:
//
//   1. IDENTITY — is this really that organisation's own site? A page that
//      displays a logo is not the owner of it. Half the images of any
//      accreditation mark on the web sit on the sites of people claiming it.
//
//   2. PERMISSION — are WE allowed to display it? This is the one that cannot
//      be inferred. A mark published on a brand page is published so that
//      ENTITLED parties can use it correctly; it is not published as a grant
//      to everyone who can right-click. Whether this client is entitled is a
//      fact about the client's accreditation, not a fact about the webpage.
//
// The honest answer is therefore very often "ask the client", and that is a
// successful outcome of this module rather than a failure of it. The thing it
// must never do is resolve an ambiguity by guessing in our favour.
//
// `search` and `fetchPage` are injected. Nothing here reaches the network on
// its own: with no searcher configured it returns NEEDS_SEARCH rather than
// pretending to have looked, which is also the state production is in until a
// search provider is configured.

export const DECISION = Object.freeze({
  USE: 'use',                   // identified, and terms permit this use
  ASK_CLIENT: 'ask-client',     // we cannot settle entitlement from the web
  REFUSE: 'refuse',             // terms forbid it, or identity failed
  NEEDS_SEARCH: 'needs-search', // no search capability is configured
});

/** Terms that permit an accredited party to display a mark. */
const PERMISSIVE = [
  /\bmay (?:be )?(?:use|display|download)\b/i,
  /\bapproved (?:providers?|members?|partners?) (?:may|can)\b/i,
  /\bentitled to (?:use|display)\b/i,
  /\bfor use by (?:accredited|approved|certified|current) \w+/i,
  /\blicen[cs]ed? to (?:use|display)\b/i,
];

/** Terms that forbid, condition, or restrict it. These outrank permissive ones. */
const RESTRICTIVE = [
  // "must not be altered" as well as "do not alter" — brand pages are written
  // in the passive far more often than the imperative, and an earlier version
  // of this pattern required the verb immediately after the modal, so it read
  // "The logo must not be altered or recoloured" as saying nothing at all.
  /\b(?:must not|may not|cannot|can not|should not|do not|don't|never)\s+(?:be\s+)?(?:use|used|alter|altered|modify|modified|recolou?r|recolou?red|redraw|redrawn|distort|distorted|crop|cropped|stretch|stretched|recreate|recreated|reproduce|reproduced)\b/i,
  /\bwritten (?:permission|consent|approval) (?:is )?required\b/i,
  /\bprior (?:permission|approval)\b/i,
  /\bonly (?:current|active|paid|registered) (?:members?|providers?|licensees?)\b/i,
  /\bunauthoris?zed use\b/i,
  /\bregistered trademark\b/i,
  /\ball rights reserved\b/i,
];

/** Instructions about HOW the mark must be rendered. Carried through verbatim. */
const NEG = /(?:must not|may not|cannot|can not|should not|do not|don't|never)\s+(?:be\s+)?/gi;

// Verbs that, when they appear inside a prohibited clause, name a rule.
//
// They are matched against the CLAUSE rather than against the negation,
// because brand pages list several prohibitions under one "must not": in
// "the logo must not be altered or recoloured", only "altered" follows the
// negation directly, and an earlier version therefore recorded "do not alter"
// and silently lost the colour rule — which is exactly the rule most likely to
// be broken by someone matching a mark to a palette.
const RULE_VERBS = [
  [/\balter(?:ed)?|modif(?:y|ied)|chang(?:e|ed)\b/i, 'do not alter'],
  [/\brecolou?r(?:ed)?|colou?r(?:ed)?\b/i, 'do not recolour'],
  [/\bstretch(?:ed)?|distort(?:ed)?|skew(?:ed)?\b/i, 'do not distort'],
  [/\bcrop(?:ped)?|cut\b/i, 'do not crop'],
];
const STANDALONE_RULES = [
  [/\bclear space\b[^.]{0,80}/i, 'respect clear space'],
  [/\bminimum (?:size|width|height)\b[^.]{0,80}/i, 'respect minimum size'],
];

/** Every prohibited clause: from each negation to the end of its sentence. */
function prohibitedClauses(text) {
  const out = [];
  NEG.lastIndex = 0;
  let m;
  while ((m = NEG.exec(text)) !== null) {
    const rest = text.slice(m.index, m.index + 160);
    out.push(rest.split(/(?<=[.;])\s/)[0]);
    if (NEG.lastIndex === m.index) NEG.lastIndex++;
  }
  return out;
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

/** Tokens from an organisation name, for matching against a domain. */
export function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(the|of|and|for|ltd|limited|inc|llc|plc|office|group|association|institute|council|standards)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Is this result plausibly the organisation's OWN site?
 *
 * Deliberately strict and deliberately not clever. A domain built from the
 * organisation's own words, or its initials, counts. A page that merely
 * mentions the name does not — that is every site displaying the mark.
 */
export function identityScore(result, orgName) {
  const h = host(result?.url || '');
  if (!h) return { score: 0, why: 'no URL' };
  const toks = nameTokens(orgName);
  if (!toks.length) return { score: 0, why: 'no organisation name given' };
  const bare = h.replace(/\.[a-z.]+$/, '').replace(/[^a-z0-9]/g, '');
  let hits = 0;
  for (const t of toks) if (bare.includes(t)) hits++;
  const initials = toks.map((t) => t[0]).join('');
  const byInitials = initials.length >= 3 && bare.includes(initials);
  const score = hits / toks.length;
  if (byInitials && score < 1) {
    return { score: Math.max(score, 0.75), why: `domain ${h} matches the initials "${initials}"` };
  }
  return {
    score,
    why: score >= 0.5 ? `domain ${h} is built from the organisation's own name` : `domain ${h} does not look like the organisation's own`,
  };
}

/**
 * Read the usage terms off a brand page.
 *
 * Returns `permits: null` when the page says nothing either way — which is the
 * common case and must NOT be read as permission.
 */
export function readTerms(text) {
  const t = String(text || '');
  if (!t.trim()) return { permits: null, restrictions: [], rules: [], why: 'no page text to read' };
  const restrictions = RESTRICTIVE.filter((re) => re.test(t)).map((re) => (t.match(re) || [''])[0].trim().slice(0, 140));
  const permissive = PERMISSIVE.filter((re) => re.test(t)).map((re) => (t.match(re) || [''])[0].trim().slice(0, 140));
  const rules = [];
  const seen = new Set();
  for (const clause of prohibitedClauses(t)) {
    for (const [re, label] of RULE_VERBS) {
      if (re.test(clause) && !seen.has(label)) { seen.add(label); rules.push({ rule: label, text: clause.trim().slice(0, 140) }); }
    }
  }
  for (const [re, label] of STANDALONE_RULES) {
    if (re.test(t) && !seen.has(label)) { seen.add(label); rules.push({ rule: label, text: (t.match(re) || [''])[0].trim().slice(0, 140) }); }
  }
  if (restrictions.length) {
    return { permits: false, restrictions, permissive, rules, why: 'the page states conditions or restrictions on use' };
  }
  if (permissive.length) {
    return { permits: true, restrictions: [], permissive, rules, why: 'the page states who may use it' };
  }
  return { permits: null, restrictions: [], permissive: [], rules, why: 'the page does not say who may use it' };
}

/**
 * Research an asset end to end.
 *
 * Returns a DECISION and, always, the reasoning — because the output of this
 * is a message to a client or an image on their site, and both need a reason
 * attached that a person can check.
 */
export async function research(need, { org, search = null, fetchPage = null, entitlementOnFile = null } = {}) {
  const trail = [];
  if (!org) return { decision: DECISION.ASK_CLIENT, reason: 'no organisation was named, so there is nothing to look up', trail };
  if (typeof search !== 'function') {
    return {
      decision: DECISION.NEEDS_SEARCH,
      reason: 'no search provider is configured, so the official source has not been looked for',
      trail,
      ownerAction: 'Configure a web-search provider, or paste the organisation\'s brand-resources URL on the client\'s card.',
    };
  }

  let results = [];
  try { results = (await search(`${org} official site brand resources logo usage`)) || []; }
  catch (e) { return { decision: DECISION.ASK_CLIENT, reason: `the search failed (${String(e.message || e).slice(0, 80)})`, trail }; }
  trail.push({ step: 'search', results: results.length });
  if (!results.length) return { decision: DECISION.ASK_CLIENT, reason: `nothing was found for "${org}"`, trail };

  // 1. identity
  const scored = results.map((r) => ({ ...r, identity: identityScore(r, org) })).sort((a, b) => b.identity.score - a.identity.score);
  const best = scored[0];
  trail.push({ step: 'identity', url: best.url, score: best.identity.score, why: best.identity.why });
  if (best.identity.score < 0.5) {
    return {
      decision: DECISION.ASK_CLIENT,
      reason: `could not confirm which site actually belongs to ${org} — ${best.identity.why}. A page showing a mark is not the owner of it.`,
      trail,
      ownerAction: `Ask the client for the link ${org} gave them for the logo.`,
    };
  }

  // 2. terms
  if (typeof fetchPage !== 'function') {
    return { decision: DECISION.ASK_CLIENT, reason: 'the official site was identified but its usage terms could not be read', trail, source: best.url };
  }
  let page = '';
  try { page = (await fetchPage(best.url)) || ''; }
  catch (e) { return { decision: DECISION.ASK_CLIENT, reason: `the official page could not be read (${String(e.message || e).slice(0, 60)})`, trail, source: best.url }; }
  const terms = readTerms(page);
  trail.push({ step: 'terms', permits: terms.permits, why: terms.why, rules: terms.rules.map((r) => r.rule) });

  // 3. permission — the question the web cannot settle
  if (terms.permits === false) {
    return {
      decision: DECISION.ASK_CLIENT,
      reason: `${org}'s own terms put conditions on using the mark: ${terms.restrictions[0]}. Whether this client meets them is a fact about their accreditation, not about the page.`,
      trail, source: best.url, rules: terms.rules,
      ownerAction: `Ask the client to confirm their current standing with ${org} and to send the file ${org} issued them.`,
    };
  }
  if (terms.permits === null) {
    return {
      decision: DECISION.ASK_CLIENT,
      reason: `the official page does not say who may display the mark. Being able to download it is not permission to publish it.`,
      trail, source: best.url, rules: terms.rules,
      ownerAction: `Ask the client to send the logo file ${org} gave them when they were accredited.`,
    };
  }

  // Terms permit an entitled party. We still have to know this client IS one.
  if (!entitlementOnFile) {
    return {
      decision: DECISION.ASK_CLIENT,
      reason: `${org} permits accredited parties to display the mark, but we have nothing on file establishing that this client currently is one.`,
      trail, source: best.url, rules: terms.rules,
      ownerAction: `Confirm the client's provider/membership number and status with ${org}, then record it on their card.`,
    };
  }

  return {
    decision: DECISION.USE,
    reason: `${org}'s terms permit accredited parties to display the mark, and this client's entitlement is on file (${entitlementOnFile}).`,
    trail, source: best.url,
    rules: terms.rules,
    // carried so the renderer cannot quietly violate them
    constraints: terms.rules.map((r) => r.rule),
  };
}

/**
 * The prohibitions, as a check rather than a comment.
 *
 * Any treatment applied to somebody else's mark goes through this. It refuses
 * by name, so a future "just tint it to match the palette" change fails here
 * instead of shipping.
 */
export function mayTransform(transform, { constraints = [] } = {}) {
  const t = String(transform || '').toLowerCase();
  const banned = [
    [/recolou?r|tint|invert|greyscale|grayscale|hue/, 'recolouring a certification mark misrepresents it'],
    [/stretch|squash|distort|skew/, 'distorting a mark misrepresents it'],
    [/crop|cut out|trim the/, 'cropping a mark can remove the part that identifies it'],
    [/redraw|recreate|trace|approximate/, 'a redrawn mark is a counterfeit of the real one'],
    [/remove .*(watermark|background)|strip/, 'removing a watermark or an issued background alters what was issued'],
  ];
  for (const [re, why] of banned) {
    if (re.test(t)) return { ok: false, reason: why };
  }
  // and anything the organisation itself prohibited
  for (const c of constraints) {
    const key = String(c).replace(/^do not /, '');
    if (key && t.includes(key.split(' ')[0])) return { ok: false, reason: `the organisation's own terms say "${c}"` };
  }
  return { ok: true };
}
