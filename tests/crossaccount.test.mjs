// R12.3 — cross-account authorization, over real HTTP.
//
// The shareable report link is the one URL this business hands to people who
// are not the owner. Every client gets one. So the question that matters is
// not "does the link work" but "does Acme's link open Beta's report" — and
// that is a question no unit test asks, because it only exists once two
// clients and a real request are in the same place at the same time.
//
// Three ways this goes wrong, all of which have shipped in real products:
//
//  1. The token is checked against the request rather than against the slug,
//     so any valid token opens any report.
//  2. The token check fails OPEN when the secret is missing — the same shape
//     as the admin gate bug, on a URL that is deliberately public.
//  3. The slug is used to read storage before it is authorised, so a crafted
//     slug reaches data by path traversal or by naming a key directly.
process.env.CRON_SECRET = 'crossaccount-test-secret';

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { startLocalApi } from './harness/local-api.mjs';
import { reportToken } from '../lib/token.js';

// Same guard as the full-path test: this writes site records through the real
// registry, and must never do that to a configured remote store.
const configuredRemote =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (configuredRemote) {
  console.log('\nREFUSED: this test writes site records and must run against the in-memory store only.\n');
  console.log('0 passed, 1 failed');
  console.log('FAILED:');
  console.log(' - cross-account test refused to run against a configured remote store');
  process.exit(1);
}

const A = 'xa-acme';
const B = 'xa-beta';
const SECRET_FACT = 'beta-private-changelog-entry';

// two real clients, written through the real registry
const { saveSiteConfig } = await import('../lib/registry.js');
await saveSiteConfig(A, { name: 'Acme Roofing', url: 'https://acme.example.invalid' });
await saveSiteConfig(B, { name: 'Beta Plumbing', url: 'https://beta.example.invalid' });
// something of Beta's that must never appear under Acme's link
await store.set(`changelog:${B}`, JSON.stringify([{ date: '2026-09-01', text: SECRET_FACT }]));
await store.set(`report:${B}:latest`, JSON.stringify({ month: '2026-09', note: SECRET_FACT }));

const api = await startLocalApi();
const get = (path) => fetch(api.origin + path);
const tokA = reportToken(A);
const tokB = reportToken(B);

// ---------------------------------------------------------------------------
section('X1  the fixture is real: both clients exist and each link works');
check('the two tokens are different', tokA !== tokB && !!tokA && !!tokB, `${tokA} / ${tokB}`);
let rA = await get(`/api/public-report?slug=${A}&t=${tokA}`);
let rB = await get(`/api/public-report?slug=${B}&t=${tokB}`);
check('Acme\'s own link opens Acme\'s report', rA.status === 200, String(rA.status));
check('Beta\'s own link opens Beta\'s report', rB.status === 200, String(rB.status));
const bodyB = await rB.text();
check('and Beta\'s report really does contain Beta\'s private line', bodyB.includes(SECRET_FACT),
  'without this, every check below would pass vacuously');

// ---------------------------------------------------------------------------
section('X2  one client\'s token must not open another client\'s report');
let r = await get(`/api/public-report?slug=${B}&t=${tokA}`);
check('Acme\'s token on Beta\'s slug is refused', r.status === 403, String(r.status));
let body = await r.text();
check('and nothing of Beta\'s comes back with the refusal', !body.includes(SECRET_FACT), body.slice(0, 160));

r = await get(`/api/public-report?slug=${A}&t=${tokB}`);
check('and the same the other way round', r.status === 403, String(r.status));

r = await get(`/api/public-report?slug=${B}`);
check('no token at all is refused', r.status === 403, String(r.status));
body = await r.text();
check('with nothing leaked', !body.includes(SECRET_FACT));

r = await get(`/api/public-report?slug=${B}&t=`);
check('an empty token is refused', r.status === 403, String(r.status));
r = await get(`/api/public-report?slug=${B}&t=${tokB.slice(0, -1)}`);
check('a token one character short is refused', r.status === 403, String(r.status));
r = await get(`/api/public-report?slug=${B}&t=${tokB}x`);
check('a token with one character added is refused', r.status === 403, String(r.status));

// ---------------------------------------------------------------------------
section('X3  the slug cannot be used to reach anything but a site');
for (const bad of ['../admin', '%2e%2e%2fadmin', 'report:xa-beta:latest', 'suppress:email:someone@example.com', '*']) {
  r = await get(`/api/public-report?slug=${encodeURIComponent(bad)}&t=${reportToken(bad)}`);
  body = await r.text();
  check(`"${bad}" does not return a report`, r.status !== 200, `${r.status} ${body.slice(0, 80)}`);
  check(`"${bad}" leaks nothing`, !body.includes(SECRET_FACT));
}
// a correctly signed token for a slug that does not exist is still not a report
r = await get(`/api/public-report?slug=xa-does-not-exist&t=${reportToken('xa-does-not-exist')}`);
check('a valid token for a non-existent client is a 404, not somebody else\'s data', r.status === 404, String(r.status));

// ---------------------------------------------------------------------------
section('X4  the admin surface is not a way round the report link');
// the owner's routes carry client data; a report token must not open them
r = await get(`/api/admin?do=contacts-list&secret=${tokB}`);
let j = await r.json();
check('a report token is not an admin secret', j.ok === false, JSON.stringify(j).slice(0, 100));
r = await get(`/api/finances?secret=${tokB}`);
const fin = await r.text();
check('and it does not open the finances endpoint', r.status !== 200 || !/revenue|profit/i.test(fin), `${r.status} ${fin.slice(0, 80)}`);

// the site feed turns out to be password-gated too, which is stronger than
// the "public list" it is described as elsewhere — so that is what gets
// asserted, rather than the weaker thing I assumed before running it
r = await get('/api/sites');
let sites = await r.text();
check('the site list is itself gated', r.status === 401, `${r.status} ${sites.slice(0, 80)}`);
check('and leaks nothing while refusing', !sites.includes(SECRET_FACT), sites.slice(0, 120));
r = await get(`/api/sites?secret=${tokB}`);
sites = await r.text();
check('a report token does not open it either', r.status !== 200, `${r.status} ${sites.slice(0, 80)}`);
r = await get(`/api/sites?secret=${process.env.CRON_SECRET}`);
sites = await r.text();
check('the owner\'s secret does open it', r.status === 200, String(r.status));
// and it genuinely carries every client's changelog — which is correct for the
// owner's own feed, and is exactly why the gate above has to hold. Asserting
// the opposite (that it carries nothing sensitive) would have been asserting
// the weaker property and calling it security.
check('the owner\'s feed does carry client changelogs', sites.includes(SECRET_FACT),
  'if this ever stops being true, the gate on it is protecting nothing and these tests mean less than they look');

// ---------------------------------------------------------------------------
section('X5  with no secret on a deployment, the link does NOT fall open');
// the same fail-open shape the admin gate had, on a URL meant to be shared:
// with no CRON_SECRET the token is empty, and "empty expected" must not mean
// "everything matches"
{
  const saved = process.env.CRON_SECRET;
  const savedVercel = process.env.VERCEL;
  delete process.env.CRON_SECRET;
  process.env.VERCEL = '1';
  const deployed = await startLocalApi();
  const noTok = await fetch(`${deployed.origin}/api/public-report?slug=${B}`);
  const anyTok = await fetch(`${deployed.origin}/api/public-report?slug=${B}&t=anything`);
  const noTokBody = await noTok.text();
  await deployed.stop();
  process.env.CRON_SECRET = saved;
  if (savedVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = savedVercel;

  check('deployed with no secret, a report link with no token is refused', noTok.status === 403, String(noTok.status));
  check('and a made-up token is refused too', anyTok.status === 403, String(anyTok.status));
  check('nothing of the client\'s came back', !noTokBody.includes(SECRET_FACT), noTokBody.slice(0, 120));
  check('and the normal link works again afterwards',
    (await get(`/api/public-report?slug=${B}&t=${tokB}`)).status === 200);
}

// ---------------------------------------------------------------------------
section('X6  a token is derived from the slug, not from anything the caller sends');
// the property that makes all of the above hold: same slug, same token, and a
// different slug can never produce the same one
check('the token is stable for a slug', reportToken(A) === reportToken(A));
check('and differs for every other slug', new Set(['a', 'b', 'c', 'd', A, B].map(reportToken)).size === 6);
check('it is not the secret itself', !reportToken(A).includes(process.env.CRON_SECRET));
check('and it is short enough to share but not trivially guessable', reportToken(A).length === 16);

// ---------------------------------------------------------------------------
// tidy up the fixtures
await store.set(`changelog:${B}`, '').catch(() => {});
await store.set(`report:${B}:latest`, '').catch(() => {});
await api.stop();
done();
