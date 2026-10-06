// If the lead form breaks, somebody has to find out who is not the lost lead.
//
// The agency site posts to `?hook=request` from another origin. When that
// endpoint stops answering — a bad deploy, a broken import, a renamed route,
// CORS changing — the form fails on a page nobody on our side ever loads, and
// leads simply stop arriving. Nothing errors anywhere we look. That is exactly
// the shape of the revisions that sat blocked for days: from the inside,
// everything looks fine.
//
// So the recovery sweep POSTs a deliberately invalid submission to our own
// public endpoint every run. A healthy system refuses it with field errors and
// writes nothing. A broken one answers 500, or does not answer at all.

import { check, section, done } from './world.mjs';
import { readFile } from 'node:fs/promises';
import { startLocalApi } from './harness/local-api.mjs';

const src = await readFile(new URL('../lib/recovery.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
section('C1  the probe is real, and it is safe to run every sweep');
check('the sweep actually posts to the endpoint', /method: 'POST'/.test(src) && /hook=request/.test(src));
check('with an invalid email on purpose', /probe-not-an-email/.test(src),
  'a VALID probe would create a real contact and a real preview task on every sweep');
check('it has a timeout', /AbortController|setTimeout\(\(\) => ctrl\.abort/.test(src),
  'a hung probe would hang the whole recovery sweep');
check('and the timeout is always cleared', /finally \{\s*clearTimeout/.test(src));

section('C2  what counts as healthy');
check('400 with field errors is healthy',
  /probe\.status === 400 && probe\.body && probe\.body\.fieldErrors/.test(src),
  'validation ran and refused without writing — exactly what we want to see');
check('429 is not treated as a failure', /probe\.status === 429/.test(src),
  'the rate limiter answering means the route is alive');
check('503 is not treated as a failure', /probe\.status === 503/.test(src),
  'the fail-closed store guard answering also means the route is alive');
check('anything else raises a STUCK finding', /lead-form-broken/.test(src));
check('and an unreachable endpoint raises its own', /lead-form-unreachable/.test(src));
check('both say what it costs in plain language',
  /leads are not being recorded/.test(src),
  'an owner reading an alert needs to know the consequence, not the status code');

// ---------------------------------------------------------------------------
section('C3  against the REAL endpoint: a probe is refused and writes nothing');
const api = await startLocalApi({ port: 0 });
const { store } = await import('../lib/store.js');

const before = await store.get('contacts:index').catch(() => null);
const res = await api.request('/api/collect?hook=request', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name: '', businessName: '', email: 'probe-not-an-email' }),
});
const after = await store.get('contacts:index').catch(() => null);

check('the probe is refused', res.status === 400, String(res.status));
check('with field errors, which is the healthy signal', !!res.json?.fieldErrors, JSON.stringify(res.json).slice(0, 150));
check('it names the fields rather than failing vaguely',
  !!res.json.fieldErrors.email && !!res.json.fieldErrors.name, JSON.stringify(res.json.fieldErrors));
check('and NOTHING was created', before === after,
  'the probe runs on every sweep — if it wrote a contact it would be a lead-shaped leak');

section('C3b  NEGATIVE CONTROL: a valid submission IS accepted');
// Without this, C3 would pass on an endpoint that refuses absolutely everything
// — which is the outage the canary exists to detect.
const good = await api.request('/api/collect?hook=request', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Canary Control', businessName: 'Control Co',
    email: `canary${Date.now()}@example.test`, timezone: 'America/Chicago',
  }),
});
check('a real submission goes through', good.status === 200 && good.json?.ok === true,
  JSON.stringify(good.json).slice(0, 150));
check('so the 400 above was validation, not a dead endpoint', res.status === 400 && good.status === 200);

section('C4  the canary cannot break the sweep that runs it');
check('the whole probe is inside a try/catch', /try \{[\s\S]{0,3200}lead-form-unreachable/.test(src));
check('and it only runs when a base URL is configured', /if \(base\)/.test(src),
  'locally there is no public URL, and inventing one would make every local sweep report a false alarm');

section('C5  it probes the origin CUSTOMERS use, not this deployment');
// Caught on the canary's first live run: it probed VERCEL_URL, the
// per-deployment hostname, which sits behind Vercel deployment protection and
// answers 401. It reported the lead form as broken while the real endpoint was
// answering perfectly. A false alarm is worse than no alarm — it teaches the
// owner that findings can be ignored.
check('VERCEL_URL is NOT used as the probe target', !/env\.VERCEL_URL/.test(src),
  'that is the per-deployment hostname, not the one the website posts to');
check('a stable public origin is used instead', /const PUBLIC_ORIGIN = 'https:\/\//.test(src));
check('and PUBLIC_BASE_URL still overrides it', /env\.PUBLIC_BASE_URL \|\| PUBLIC_ORIGIN/.test(src));
check('401 is reported as CONFIGURATION, not as an outage',
  /probe\.status === 401[\s\S]{0,400}finding\('lead-form-protected', SEVERITY\.CONFIG/.test(src),
  'an authenticated origin is a setting somebody changed, with a different fix');
check('the probe does not run outside a deployment',
  /const deployed = !!env\.VERCEL_ENV \|\| !!env\.PUBLIC_BASE_URL/.test(src),
  'a constant origin is always truthy — without this gate the suite makes real network calls');
check('and the finding names the actual fix',
  /Deployment Protection/.test(src) && /cannot authenticate/.test(src),
  'because a visitor\'s browser cannot log in, so protection blocks every real submission too');

done();
