// Can a preview deployment touch the live database?
//
// R18.2. `vercel env ls` shows KV_URL, REDIS_URL and the three KV_REST_API_*
// variables scoped to **Production AND Preview**. A preview deployment does not
// get a sandbox; it gets the live store, with real clients, contacts, consent
// records, spend counters and the job queue.
//
// The gated endpoints were already safe there — CRON_SECRET is Production-only,
// so `authMode()` is `locked` on Preview. The problem was the five PUBLIC ones.
// `api/audit.js`, `api/card.js`, `api/public-report.js` and `api/shot.js` have
// NO authentication at all (correctly, for what they do) and every one of them
// writes; `api/collect.js` carries six public hooks and writes on most of them.
//
// Driven through the real handlers, in all three environments.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, section, done } from './world.mjs';
import { startLocalApi } from './harness/local-api.mjs';
import { deploymentEnv, storeAccess, previewIsolated, guardSharedStore } from '../lib/environment.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));

// api/t.js serves a static tracker script and touches no store at all, so a
// preview can still prove the script is served. Named here rather than silently
// skipped, so the exemption is a decision somebody can disagree with.
const EXEMPT = new Set(['t.js']);

const envWas = { VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV, PREVIEW_KV_ISOLATED: process.env.PREVIEW_KV_ISOLATED };
const setEnv = (o) => {
  for (const k of ['VERCEL', 'VERCEL_ENV', 'PREVIEW_KV_ISOLATED']) {
    if (o[k] == null) delete process.env[k];
    else process.env[k] = o[k];
  }
};

// ---------------------------------------------------------------------------
section('V1  the environment is classified from Vercel\'s own variables');
setEnv({});
check('no VERCEL variables at all is local', deploymentEnv() === 'local', deploymentEnv());
setEnv({ VERCEL: '1', VERCEL_ENV: 'production' });
check('production is production', deploymentEnv() === 'production', deploymentEnv());
setEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
check('preview is preview', deploymentEnv() === 'preview', deploymentEnv());
setEnv({ VERCEL: '1' });
check('deployed with no VERCEL_ENV is treated as preview, not production',
  deploymentEnv() === 'preview', deploymentEnv());

section('V2  who may touch the shared store');
setEnv({});
check('local may', storeAccess().ok === true);
setEnv({ VERCEL: '1', VERCEL_ENV: 'production' });
check('production may', storeAccess().ok === true);
setEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
const refused = storeAccess();
check('PREVIEW MAY NOT', refused.ok === false, JSON.stringify(refused).slice(0, 120));
check('and the reason names the shared database', /shares the production database/.test(refused.reason || ''), refused.reason);
check('with the exact owner action', /PREVIEW_KV_ISOLATED=1/.test(refused.ownerAction || ''), refused.ownerAction);
setEnv({ VERCEL: '1', VERCEL_ENV: 'development' });
check('a development deployment may not either', storeAccess().ok === false);

section('V2b  isolation is opt-IN, never inferred');
setEnv({ VERCEL: '1', VERCEL_ENV: 'preview', PREVIEW_KV_ISOLATED: '1' });
check('once the owner says Preview has its own store, it may', storeAccess().ok === true, JSON.stringify(storeAccess()));
check('and it is reported as isolated', storeAccess().isolated === true);
setEnv({ VERCEL: '1', VERCEL_ENV: 'preview', PREVIEW_KV_ISOLATED: 'true' });
check('only the exact value counts, so a typo fails CLOSED', previewIsolated() === false,
  'guessing that "true" means 1 is the kind of leniency that writes to live data');
check('and access is refused', storeAccess().ok === false);

// ---------------------------------------------------------------------------
section('V3  EVERY api/ handler calls the guard');
// The teeth: a new endpoint cannot be added without one. This is the same shape
// as the orphan guard, for the same reason — the failure is an endpoint nobody
// remembered to protect.
for (const f of apiFiles) {
  if (EXEMPT.has(f)) continue;
  const src = fs.readFileSync(path.join(ROOT, 'api', f), 'utf8');
  check(`api/${f} calls guardSharedStore`, /guardSharedStore\s*\(\s*req\s*,\s*res\s*\)/.test(src), f);
  // and calls it FIRST — a guard after the work has started is decoration
  const gi = src.indexOf('guardSharedStore(req, res)');
  const hi = src.indexOf('export default');
  const body = src.slice(hi, gi);
  check(`api/${f} calls it before doing anything`, (body.match(/\n/g) || []).length < 8,
    `${(body.match(/\n/g) || []).length} lines run before the guard`);
}
check('the exemption list is small and named', EXEMPT.size <= 1, [...EXEMPT].join(','));
check('and the exempt file really touches no store',
  !/\bstore\./.test(fs.readFileSync(path.join(ROOT, 'api', 't.js'), 'utf8')), 'api/t.js');

// ---------------------------------------------------------------------------
section('V4  through the real handlers, over a real socket');
const api = await startLocalApi();

setEnv({ VERCEL: '1', VERCEL_ENV: 'preview' });
const previewHits = [
  ['/api/collect?hook=optin-terms', 'the public opt-in terms'],
  ['/api/audit?slug=x', 'the audit endpoint'],
  ['/api/card?slug=x', 'the report card image'],
  ['/api/public-report?slug=x', 'the shareable client page'],
  ['/api/shot?slug=x', 'the screenshot endpoint'],
  ['/api/sites', 'the sites feed'],
  ['/api/admin?do=automation-status', 'the automation status'],
];
for (const [p, what] of previewHits) {
  const r = await api.request(p);
  check(`preview: ${what} is refused`, r.status === 503, `${p} -> ${r.status}`);
}
const sample = await api.request('/api/collect?hook=optin-terms');
check('the refusal explains itself', /shares the production database/.test(sample.json?.error || ''),
  JSON.stringify(sample.json).slice(0, 140));
check('and says it is not a fault in the build',
  /Nothing is wrong with this build/.test(sample.json?.note || ''), sample.json?.note);
check('and names the environment', sample.json?.environment === 'preview', sample.json?.environment);

section('V4b  a public WRITE is refused on preview');
const write = await api.post('/api/collect?hook=optin', { phone: '2145557790', agreed: true });
check('the public enrolment write is refused', write.status === 503, `${write.status}`);

section('V4c  NEGATIVE CONTROL: production and local are unaffected');
setEnv({ VERCEL: '1', VERCEL_ENV: 'production' });
for (const [p, what] of previewHits) {
  const r = await api.request(p);
  check(`production: ${what} is NOT refused by this guard`, r.status !== 503, `${p} -> ${r.status}`);
}
setEnv({});
const local = await api.request('/api/collect?hook=optin-terms');
check('local is not refused either', local.status === 200, `${local.status}`);
check('which is why the in-memory preview still works', local.json?.ok === true);

section('V4d  and with Preview given its own store, Preview works too');
setEnv({ VERCEL: '1', VERCEL_ENV: 'preview', PREVIEW_KV_ISOLATED: '1' });
const isolated = await api.request('/api/collect?hook=optin-terms');
check('an isolated preview is allowed', isolated.status === 200, `${isolated.status}`);

// ---------------------------------------------------------------------------
section('V5  authentication cannot become open on ANY deployed environment');
const { authMode } = await import('../lib/auth.js');
const secretWas = process.env.CRON_SECRET;
delete process.env.CRON_SECRET;
for (const e of ['production', 'preview', 'development']) {
  setEnv({ VERCEL: '1', VERCEL_ENV: e, PREVIEW_KV_ISOLATED: '1' });
  check(`${e} with no secret is LOCKED, never open`, authMode() === 'locked', `${e}: ${authMode()}`);
}
setEnv({ VERCEL: '1' }); // deployed, VERCEL_ENV absent entirely
check('deployed with no VERCEL_ENV at all is still locked', authMode() === 'locked', authMode());
setEnv({});
check('only a completely undeployed process is open', authMode() === 'open', authMode());
check('and that is what lets this suite run', true);
if (secretWas != null) process.env.CRON_SECRET = secretWas;

setEnv(envWas);
await api.stop();
done();
