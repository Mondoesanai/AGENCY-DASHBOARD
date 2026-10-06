// Finding an official mark, and deciding whether we may actually display it.
//
// The obvious implementation — search the web, take the first logo that looks
// right — is worse than the hand-drawn copy it replaces, because a mark lifted
// from an unrelated page looks authentic and nobody checks it twice.
//
// So two questions are kept apart. Whether this is the organisation's own site
// is answerable from the web. Whether THIS CLIENT may display the mark is not:
// that is a fact about their accreditation. "Ask the client" is therefore a
// correct outcome here, and most of these checks exist to stop an ambiguity
// being resolved in our own favour.
import { check, section, done } from './world.mjs';
import { research, readTerms, identityScore, nameTokens, mayTransform, DECISION } from '../lib/asset-research.js';

const ORG = 'CPD Standards Office';
const NEED = 'official CPD Standards Office Accredited Provider logo';

// ---------------------------------------------------------------------------
section('P1  whose site is it?');
check('the organisation\'s own domain scores',
  identityScore({ url: 'https://cpdstandards.com/brand' }, ORG).score >= 0.5,
  JSON.stringify(identityScore({ url: 'https://cpdstandards.com/brand' }, ORG)));
check('an initials domain counts',
  identityScore({ url: 'https://cpdso.org/logo' }, ORG).score >= 0.75,
  JSON.stringify(identityScore({ url: 'https://cpdso.org/logo' }, ORG)));
check('somebody ELSE displaying the mark does not',
  identityScore({ url: 'https://some-random-trainer.com/our-accreditations' }, ORG).score < 0.5,
  'a page showing a mark is not the owner of it');
check('an image host does not', identityScore({ url: 'https://i.imgur.com/abc.png' }, ORG).score < 0.5);
check('no URL scores nothing', identityScore({}, ORG).score === 0);
check('filler words are not matched on', !nameTokens(ORG).includes('office') && !nameTokens(ORG).includes('standards'));

// ---------------------------------------------------------------------------
section('P2  what do the terms actually say?');
let t = readTerms('Accredited providers may display the CPD Standards Office mark on their website.');
check('a clear grant is read as permitting', t.permits === true, JSON.stringify(t));

t = readTerms('The CPD mark is a registered trademark. Written permission is required before use.');
check('a restriction is read as NOT permitting', t.permits === false);
check('and the restriction is quoted', /written permission/i.test(t.restrictions.join(' ')), JSON.stringify(t.restrictions));

t = readTerms('Approved providers may use the logo. The logo must not be altered or recoloured.');
check('a restriction OUTRANKS a grant on the same page', t.permits === false,
  'a conditional grant is not an unconditional one');
check('the usage rules are captured', t.rules.some((r) => r.rule === 'do not alter'), JSON.stringify(t.rules.map((r) => r.rule)));
check('and recolouring specifically', t.rules.some((r) => r.rule === 'do not recolour'));

t = readTerms('Download our logo pack here. Brand assets for partners.');
check('silence is NOT permission', t.permits === null, JSON.stringify(t));
check('and it says so', /does not say who may use it/.test(t.why), t.why);
check('an empty page says nothing either way', readTerms('').permits === null);

// ---------------------------------------------------------------------------
section('P3  with no searcher it says so rather than pretending to have looked');
let r = await research(NEED, { org: ORG });
check('the decision is needs-search', r.decision === DECISION.NEEDS_SEARCH, r.decision);
check('it does not claim to have found anything', !r.source);
check('and it names the owner action', /search provider|brand-resources URL/i.test(r.ownerAction || ''), r.ownerAction);

check('no organisation named is a question, not a guess',
  (await research(NEED, {})).decision === DECISION.ASK_CLIENT);

// ---------------------------------------------------------------------------
section('P4  identity has to be established before anything is read');
const onlyThirdParty = async () => ([
  { url: 'https://some-random-trainer.com/accreditations', title: 'Our accreditations' },
  { url: 'https://pinterest.com/pin/123', title: 'CPD logo' },
]);
r = await research(NEED, { org: ORG, search: onlyThirdParty, fetchPage: async () => 'Download the logo here.' });
check('it refuses to pick a third-party page', r.decision === DECISION.ASK_CLIENT, r.decision);
check('and explains why that matters', /not the owner of it/i.test(r.reason), r.reason);
check('it did not fetch a page it could not identify', !r.source);

check('nothing found is a question',
  (await research(NEED, { org: ORG, search: async () => [] })).decision === DECISION.ASK_CLIENT);
check('a failing search is a question, not a refusal',
  (await research(NEED, { org: ORG, search: async () => { throw new Error('rate limited'); } })).decision === DECISION.ASK_CLIENT);

// ---------------------------------------------------------------------------
section('P5  the official site, and the question the web cannot settle');
const official = async () => ([{ url: 'https://cpdstandards.com/brand-resources', title: 'Brand resources' }]);

r = await research(NEED, { org: ORG, search: official, fetchPage: async () => 'Download our logo pack. Brand assets.' });
check('silent terms produce a question', r.decision === DECISION.ASK_CLIENT, r.decision);
check('with the point made plainly', /Being able to download it is not permission/i.test(r.reason), r.reason);
check('the identified source is reported', /cpdstandards\.com/.test(r.source || ''), r.source);

r = await research(NEED, { org: ORG, search: official, fetchPage: async () => 'The mark is a registered trademark; written permission is required.' });
check('restrictive terms produce a question', r.decision === DECISION.ASK_CLIENT);
check('that names the client\'s standing as the unresolved fact',
  /fact about their accreditation/i.test(r.reason), r.reason);
check('and the owner action asks for the issued file',
  /send the file/i.test(r.ownerAction || ''), r.ownerAction);

// permissive terms, but we do not know this client is entitled
r = await research(NEED, { org: ORG, search: official,
  fetchPage: async () => 'Accredited providers may display the mark on their website.' });
check('permission for SOMEONE is not permission for THIS client', r.decision === DECISION.ASK_CLIENT, r.decision);
check('and it says exactly what is missing', /nothing on file establishing/i.test(r.reason), r.reason);

// ---------------------------------------------------------------------------
section('P6  the one case where it may proceed');
r = await research(NEED, { org: ORG, search: official, entitlementOnFile: 'Provider 51045, 2026-2028',
  fetchPage: async () => 'Accredited providers may display the mark. The logo must not be stretched.' });
// the page carries a restriction, so this is still a question — restrictions outrank
check('a page with ANY restriction still asks', r.decision === DECISION.ASK_CLIENT, r.decision);

r = await research(NEED, { org: ORG, search: official, entitlementOnFile: 'Provider 51045, 2026-2028',
  fetchPage: async () => 'Accredited providers may display the CPD mark on their website and materials.' });
check('clear terms plus entitlement on file permits use', r.decision === DECISION.USE, `${r.decision}: ${r.reason}`);
check('the entitlement is cited', /51045/.test(r.reason), r.reason);
check('and the source is recorded', /cpdstandards\.com/.test(r.source || ''));

// ---------------------------------------------------------------------------
section('P7  the prohibitions refuse by name');
for (const [t2, why] of [
  ['recolour the logo to match the palette', 'recolour'],
  ['tint it green', 'tint'],
  ['stretch it to fill the column', 'stretch'],
  ['crop the badge', 'crop'],
  ['redraw it as an SVG', 'redraw'],
  ['trace the outline', 'trace'],
  ['remove the background', 'remove background'],
  ['strip the watermark', 'strip'],
]) {
  const v = mayTransform(t2);
  check(`refused: ${why}`, v.ok === false, `"${t2}" was allowed`);
  check(`  and says why: ${why}`, (v.reason || '').length > 15, v.reason);
}
check('a redrawn mark is called what it is', /counterfeit/.test(mayTransform('redraw it').reason));
check('resizing proportionally is fine', mayTransform('display it at 150px tall').ok === true);
check('placing it is fine', mayTransform('put it in the certification section').ok === true);
check('an organisation\'s own rule is enforced too',
  mayTransform('alter the spacing', { constraints: ['do not alter'] }).ok === false);

done();
