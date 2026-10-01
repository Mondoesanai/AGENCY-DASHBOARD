// R4 discovery + qualification, and the G1/G4 settings they depend on.
// Behaviour only: every check drives the real functions against fixtures.
import { check, section, done } from './world.mjs';
import { getSettings, saveSettings, defaultSettings, priceLine, pricingBlocker, withinTargeting, osmFiltersFor } from '../lib/settings.js';
import {
  buildQuery, elementToProspect, createOverpassAdapter, safeUrl, matchesBusiness,
  verifyWebsite, qualify, identityKey, saveProspects, listProspects, getProspect, runDiscovery,
  WEB_STATUS, ATTRIBUTION,
} from '../lib/discovery.js';

const okRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

// ---------------------------------------------------------------------------
section('S1  G1 pricing — unset is a fact, not zero');
let s = defaultSettings();
check('pricing starts unconfigured', s.pricing.configured === false);
check('the build price is null, not 0', s.pricing.buildPrice === null);
check('the monthly fee is null, not 0', s.pricing.monthlyFee === null);
check('no price line can be produced', priceLine(s) === null);
check('and the blocker says what is missing', /build price and monthly fee/.test(pricingBlocker(s)), pricingBlocker(s));
check('the blocker states development is NOT blocked', /Development is not blocked/.test(pricingBlocker(s)));

s = await saveSettings({ pricing: { buildPrice: '2500' } });
check('a half-set price is still unconfigured', s.pricing.configured === false);
check('and still produces no price line', priceLine(s) === null);
check('the blocker now names only the missing half', /monthly fee/.test(pricingBlocker(s)) && !/build price and/.test(pricingBlocker(s)), pricingBlocker(s));

s = await saveSettings({ pricing: { monthlyFee: '197' } });
check('both set makes it configured', s.pricing.configured === true);
check('and a price line appears', priceLine(s) === '$2,500 to build, then $197/month', String(priceLine(s)));
check('with no blocker', pricingBlocker(s) === null);

// configured must be DERIVED — a caller cannot assert it
s = await saveSettings({ pricing: { buildPrice: '', monthlyFee: '', configured: true } });
check('a caller cannot mark empty prices as configured', s.pricing.configured === false);
check('and no price line is produced from them', priceLine(s) === null);
s = await saveSettings({ pricing: { buildPrice: '-99', monthlyFee: 'abc' } });
check('a negative price is rejected', s.pricing.buildPrice === null, String(s.pricing.buildPrice));
check('a non-numeric fee is rejected', s.pricing.monthlyFee === null, String(s.pricing.monthlyFee));
s = await saveSettings({ pricing: { buildPrice: '$2,500', monthlyFee: ' 197 ' } });
check('a price typed with a dollar sign and comma is accepted', s.pricing.buildPrice === 2500, String(s.pricing.buildPrice));
check('whitespace around a fee is accepted', s.pricing.monthlyFee === 197, String(s.pricing.monthlyFee));
s = await saveSettings({ pricing: { buildPrice: '2500abc' } });
check('a half-typo is rejected rather than silently truncated', s.pricing.buildPrice === null, String(s.pricing.buildPrice));

// ---------------------------------------------------------------------------
section('S2  G4 targeting — a draft assumption, not authorisation');
s = await getSettings();
check('targeting is marked draft', s.targeting.status === 'draft', s.targeting.status);
check('and says it is a development assumption', /assumption/.test(s.targeting.source), s.targeting.source);
check('geography is DFW', /Dallas/.test(s.targeting.geography.label));
const keys = s.targeting.industries.map((i) => i.key);
check('flooring is included', keys.includes('flooring'), keys.join(','));
check('home services are included', ['roofing', 'hvac', 'plumbing', 'electrical', 'landscaping'].every((k) => keys.includes(k)), keys.join(','));
check('established-only is encoded as an exclusion', s.targeting.exclusions.minYearsInBusiness >= 2);
check('OUTREACH IS OFF', s.outreach.active === false);
check('and it says why', /never been activated/.test(s.outreach.reason));

// nothing in settings can switch outreach on
s = await saveSettings({ outreach: { active: true } });
check('saveSettings cannot activate outreach', (await getSettings()).outreach.active === false);

// a prospect outside DFW is out of target
const dfw = { lat: 32.78, lon: -96.8, industry: 'flooring' };
check('a Dallas flooring business is in target', withinTargeting(await getSettings(), dfw).ok === true);
check('a Chicago business is not', withinTargeting(await getSettings(), { lat: 41.88, lon: -87.63, industry: 'flooring' }).ok === false);
check('an untargeted industry is not', withinTargeting(await getSettings(), { ...dfw, industry: 'tattoo' }).ok === false);

// ---------------------------------------------------------------------------
section('S3  the Overpass query is real Overpass QL');
const filters = osmFiltersFor(await getSettings(), ['flooring']);
check('flooring maps to OSM tags', filters.length > 0, JSON.stringify(filters));
const q = buildQuery(filters, { south: 32.3, west: -97.5, north: 33.2, east: -96.5 });
check('the query sets a JSON output', /\[out:json\]/.test(q), q);
check('it declares a timeout', /timeout:\d+/.test(q));
check('it queries both nodes and ways', /node\[/.test(q) && /way\[/.test(q));
check('the bbox is in south,west,north,east order', /\(32\.3,-97\.5,33\.2,-96\.5\)/.test(q), q);
check('it asks for centres so ways have coordinates', /out center/.test(q));
check('no filters means no query rather than a query for everything', buildQuery([], { south: 0, west: 0, north: 1, east: 1 }) === null);

// ---------------------------------------------------------------------------
section('S4  mapping an OSM element invents nothing');
const el = { type: 'node', id: 42, lat: 32.8, lon: -96.8, tags: { name: 'Lone Star Flooring', shop: 'flooring', phone: '+1 214-555-0147', 'addr:city': 'Dallas', 'addr:postcode': '75201' } };
let p = elementToProspect(el, { 'shop=flooring': 'flooring' });
check('the name is taken as-is', p.name === 'Lone Star Flooring');
check('the industry is resolved from the tag', p.industry === 'flooring');
check('a missing website stays null', p.website === null);
check('a missing email stays null', p.email === null);
check('the source id is traceable', p.sourceId === 'osm:node/42');
check('the evidence records where it came from', /openstreetmap\.org\/node\/42/.test(p.evidence.sourceUrl));
check('and carries the licence attribution', p.evidence.attribution === ATTRIBUTION);
check('raw tags are kept as evidence', p.evidence.rawTags.phone === '+1 214-555-0147');
check('an unnamed element is not a prospect', elementToProspect({ type: 'node', id: 1, tags: { shop: 'flooring' } }) === null);

// ---------------------------------------------------------------------------
section('S5  SSRF protection on prospect-supplied URLs (R11.9)');
for (const bad of ['http://localhost/admin', 'http://127.0.0.1:8080', 'http://10.0.0.5', 'http://192.168.1.1', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd', 'http://172.16.0.1']) {
  check(`blocked: ${bad}`, safeUrl(bad).ok === false, JSON.stringify(safeUrl(bad)));
}
check('a normal site is allowed', safeUrl('lonestarflooring.com').ok === true);
check('and is normalised to https', /^https:\/\//.test(safeUrl('lonestarflooring.com').url));
check('a non-standard port is blocked', safeUrl('http://example.com:9000').ok === false);
check('a hostname with no dot is blocked', safeUrl('http://intranet').ok === false);

// ---------------------------------------------------------------------------
section('S6  "no website LINKED" is never reported as "no website"');
p = { name: 'Lone Star Flooring', phone: '214-555-0147', postcode: '75201', website: null };
let web = await verifyWebsite(p);
check('status is not-linked', web.status === WEB_STATUS.NOT_LINKED);
check('the wording is about the listing, not their existence', /couldn't find a website linked from your/.test(web.observation), web.observation);
check('and it explicitly says this is not evidence they have none', /NOT evidence/.test(web.note), web.note);

// a listed site that loads and matches
const fetchOk = async () => okRes('<html><title>Lone Star Flooring</title><body>Call 214-555-0147</body></html>');
web = await verifyWebsite({ ...p, website: 'lonestarflooring.com' }, { fetchImpl: fetchOk });
check('a matching site is verified present', web.status === WEB_STATUS.PRESENT, JSON.stringify(web).slice(0, 160));
check('and names the evidence that tied it to the business', web.signals.length > 0, web.signals.join(','));

// a listed site that 404s
web = await verifyWebsite({ ...p, website: 'lonestarflooring.com' }, { fetchImpl: async () => okRes('nope', 404) });
check('a dead listed site is inaccessible, not absent', web.status === WEB_STATUS.INACCESSIBLE);
check('and the observation states the HTTP status', /HTTP 404/.test(web.observation), web.observation);

// a listed site that loads but is someone else's
web = await verifyWebsite({ ...p, website: 'parked-domain.com' }, { fetchImpl: async () => okRes('<html>Buy this domain</html>') });
check('an unrelated page is uncertain, not present', web.status === WEB_STATUS.UNCERTAIN);
check('and it admits nothing tied it to the business', /nothing on the page ties it/.test(web.observation));

// a site that times out
web = await verifyWebsite({ ...p, website: 'slow.com' }, { fetchImpl: async () => { throw new Error('timeout'); } });
check('a timeout is inaccessible', web.status === WEB_STATUS.INACCESSIBLE);

// ---------------------------------------------------------------------------
section('S7  qualification separates weak sites from not-found');
const S = await getSettings();
const base = { name: 'Lone Star Flooring', phone: '214-555-0147', lat: 32.78, lon: -96.8, industry: 'flooring' };
let qa = qualify(base, { status: WEB_STATUS.NOT_LINKED, observation: "I couldn't find a website linked from your listing." }, S);
check('no-site-found is its own segment', qa.segment === 'no-site-found');
check('it is eligible when contactable and in target', qa.eligible === true, qa.ineligibleReason);
check('the reasoning spells out the distinction', /never as "does not have"/.test(qa.reasons.join(' ')));

qa = qualify(base, { status: WEB_STATUS.INACCESSIBLE, observation: 'did not load' }, S);
check('a dead site is a DIFFERENT segment from not-found', qa.segment === 'weak-site');
qa = qualify(base, { status: WEB_STATUS.PRESENT, observation: 'loads' }, S);
check('a working site is has-site', qa.segment === 'has-site');
check('and the approach is framed as improving what exists', /improving what exists/.test(qa.reasons.join(' ')));
qa = qualify(base, { status: WEB_STATUS.UNCERTAIN, observation: 'unclear' }, S);
check('uncertain is never eligible for outreach', qa.eligible === false && qa.ineligibleReason === 'web presence uncertain');

qa = qualify({ ...base, phone: null, email: null }, { status: WEB_STATUS.NOT_LINKED, observation: 'x' }, S);
check('no contact details means not eligible', qa.eligible === false && qa.ineligibleReason === 'no contact details');
qa = qualify({ ...base, lat: 41.88, lon: -87.63 }, { status: WEB_STATUS.NOT_LINKED, observation: 'x' }, S);
check('out of area means not eligible', qa.eligible === false);

// R4.10 — no invented performance claims anywhere in the output
const all = JSON.stringify(qualify(base, { status: WEB_STATUS.INACCESSIBLE, observation: 'did not load' }, S));
check('no claim about lost revenue', !/lost revenue|losing \$|revenue loss/i.test(all));
check('no claim about conversion rate', !/conversion rate|converting poorly/i.test(all));
check('no claim about broken forms', !/broken form/i.test(all));

// ---------------------------------------------------------------------------
section('S8  the adapter, driven end to end against a fixture');
const overpassBody = {
  elements: [
    { type: 'node', id: 1, lat: 32.78, lon: -96.8, tags: { name: 'Lone Star Flooring', shop: 'flooring', phone: '2145550147', 'addr:city': 'Dallas' } },
    { type: 'way', id: 2, center: { lat: 32.9, lon: -96.9 }, tags: { name: 'Metroplex Floors', shop: 'flooring', website: 'metroplexfloors.com', 'addr:city': 'Plano' } },
    { type: 'node', id: 3, lat: 32.7, lon: -96.7, tags: { shop: 'flooring' } }, // unnamed
  ],
};
let calls = [];
const fakeFetch = async (url, opts) => {
  calls.push({ url, opts });
  if (String(url).includes('overpass')) return okRes(overpassBody);
  return okRes('<html><title>Metroplex Floors</title></html>');
};
const adapter = createOverpassAdapter({ fetchImpl: fakeFetch });
check('the adapter reports itself configured (no credential needed)', adapter.configured() === true);
let r = await adapter.search({ filters, bbox: S.targeting.geography.bbox });
check('the search succeeds', r.ok === true, r.error);
check('named businesses become prospects', r.prospects.length === 2, String(r.prospects.length));
check('the unnamed element is dropped', !r.prospects.some((x) => !x.name));
check('a way gets coordinates from its centre', r.prospects.find((x) => x.sourceId === 'osm:way/2').lat === 32.9);
check('the request identifies itself per Overpass fair use', /InspiringWebsites/.test(calls[0].opts.headers['User-Agent']));
check('the result carries attribution', r.attribution === ATTRIBUTION);

// rate limiting: a 429 backs off once, then reports transient rather than looping
let n = 0;
const rateLimited = createOverpassAdapter({ fetchImpl: async () => { n++; return okRes('slow down', 429); }, sleep: async () => {} });
r = await rateLimited.search({ filters, bbox: S.targeting.geography.bbox });
check('a 429 is retried exactly once', n === 2, String(n));
check('then reported as transient, not as "no businesses exist"', r.ok === false && r.transient === true, JSON.stringify(r).slice(0, 120));
check('and no prospects are invented', r.prospects.length === 0);

// ---------------------------------------------------------------------------
section('S9  the same business is never discovered twice (R4.11)');
check('identity prefers the website host', identityKey({ website: 'https://www.lonestarflooring.com/about', phone: '2145550147' }) === 'web:lonestarflooring.com');
check('then the phone number', identityKey({ phone: '(214) 555-0147' }) === 'tel:2145550147');
check('then name + city', identityKey({ name: 'Lone Star Flooring', city: 'Dallas' }) === 'name:lonestarflooring|dallas');
check('the same business from two sources collides on purpose', identityKey({ sourceId: 'osm:node/1', website: 'http://lonestarflooring.com' }) === identityKey({ sourceId: 'yelp:99', website: 'https://www.lonestarflooring.com/' }));

const first = await saveProspects(r.prospects.length ? r.prospects : [{ sourceId: 'osm:node/9', name: 'Dedup Test Co', phone: '2145550199', city: 'Dallas', evidence: {} }]);
const second = await saveProspects([{ sourceId: 'osm:node/9', name: 'Dedup Test Co', phone: '2145550199', city: 'Dallas', evidence: {} }]);
check('the first save stores it', first.saved.length >= 1 || second.skipped.length === 1);
check('the second save skips it as already discovered', second.skipped.length === 1, JSON.stringify(second));
check('and says why', /already discovered/.test(second.skipped[0].reason));

// ---------------------------------------------------------------------------
section('S10  a whole discovery run, and what it refuses to do');
calls = [];
const run = await runDiscovery({ adapter: createOverpassAdapter({ fetchImpl: fakeFetch }), industries: ['flooring'], max: 5, fetchImpl: fakeFetch });
check('the run succeeds', run.ok === true, run.error);
check('it names its source', run.source === 'openstreetmap-overpass');
check('it carries the ODbL attribution', /OpenStreetMap/.test(run.attribution));
check('it reports which segments it found', typeof run.segments['no-site-found'] === 'number', JSON.stringify(run.segments));
check('it reports that targeting is still a draft', run.targetingStatus === 'draft');
check('it reports outreach is OFF', run.outreachActive === false);
check('and states plainly that it sends nothing', /sends anything|sends nothing/.test(run.note), run.note);
const stored = await listProspects();
check('prospects are persisted', stored.length > 0, String(stored.length));
check('each stored prospect keeps its web verification', stored.every((x) => !x.web || x.web.status), JSON.stringify(stored[0]?.web || {}).slice(0, 100));

// no industries configured = an honest refusal, not an empty success
await saveSettings({ targeting: { industries: [] } });
const none = await runDiscovery({ adapter: createOverpassAdapter({ fetchImpl: fakeFetch }), fetchImpl: fakeFetch });
check('no configured industries refuses rather than searching for everything', none.ok === false && /no industries configured/.test(none.error), JSON.stringify(none));

done();
