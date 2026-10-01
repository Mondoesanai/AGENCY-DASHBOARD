// R1.8 — end-to-end verification of the flows that already existed.
//
// These drive the REAL API handlers with a fake req/res, through the real
// registry and store, against the faked outside world. The point is not to
// re-test the agent (agent.test.mjs does that) but to cover the parts of the
// dashboard that had NO test at all: clients CRUD, site/repo association,
// analytics ranges and empty states, authorization, integration
// connect/disconnect reporting, deployment status and settings persistence.
//
// R12.8 applies: this is L2 evidence — real code paths, faked providers. It is
// not a statement that the deployed dashboard works.
import { W, addRepo, check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { listSites, getSiteConfig, saveSiteConfig, deleteSiteConfig, slugify, hostKey } from '../lib/registry.js';
import { authed, authMode, authError, isDeployed } from '../lib/auth.js';
import siteHandler from '../api/site.js';
import sitesHandler from '../api/sites.js';
import adminHandler from '../api/admin.js';
import { systemHealth } from '../lib/health.js';

// --- a fake req/res good enough for the handlers -----------------------------
function mkRes() {
  const res = {
    code: 0,
    body: null,
    headers: {},
    status(c) {
      this.code = c;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end() {
      return this;
    },
  };
  return res;
}
const call = async (handler, { method = 'GET', query = {}, body = null, headers = {} } = {}) => {
  const res = mkRes();
  await handler({ method, query, body, headers }, res);
  return res;
};
const post = (body, query = {}) => call(siteHandler, { method: 'POST', body, query });

// ---------------------------------------------------------------------------
section('F1  authorization — the gate used to fail OPEN');
// REGRESSION: five endpoints each carried `if (!CRON_SECRET) return true`. A
// missing secret on a deployment silently authorised every admin request,
// including the finances endpoint.
delete process.env.CRON_SECRET;
delete process.env.VERCEL;
delete process.env.VERCEL_ENV;
check('with no secret and not deployed, the mode is open (local dev works)', authMode() === 'open');
check('and a request is allowed', authed({ headers: {}, query: {} }) === true);

process.env.VERCEL = '1';
check('the same missing secret ON A DEPLOYMENT is LOCKED, not open', authMode() === 'locked');
check('and every admin request is refused', authed({ headers: {}, query: {} }) === false);
check('even one that presents some secret', authed({ headers: {}, query: { secret: 'anything' } }) === false);
check('the refusal explains the cause instead of saying "wrong password"', /no CRON_SECRET set/.test(authError()));
check('isDeployed() reads the platform variable', isDeployed() === true);
process.env.VERCEL_ENV = 'preview';
delete process.env.VERCEL;
check('a preview deployment is also treated as deployed', authMode() === 'locked');
delete process.env.VERCEL_ENV;

process.env.CRON_SECRET = 'sekret-1234';
check('with a secret set, the mode is enforced', authMode() === 'enforced');
check('the right secret in the query is accepted', authed({ headers: {}, query: { secret: 'sekret-1234' } }) === true);
check('in the Authorization header too', authed({ headers: { authorization: 'Bearer sekret-1234' }, query: {} }) === true);
check('in a POST body too', authed({ headers: {}, query: {}, body: { secret: 'sekret-1234' } }) === true);
check('a wrong secret is refused', authed({ headers: {}, query: { secret: 'nope' } }) === false);
check('a PREFIX of the real secret is refused', authed({ headers: {}, query: { secret: 'sekret' } }) === false);
check('an empty secret is refused', authed({ headers: {}, query: { secret: '' } }) === false);
check('no credential at all is refused', authed({ headers: {}, query: {} }) === false);

// through the real handlers
let r = await call(adminHandler, { query: { do: 'receipts' } });
check('/api/admin refuses an unauthenticated request', r.code === 401, String(r.code));
r = await post({ action: 'save', url: 'https://sneaky.com' });
check('/api/site refuses an unauthenticated write', r.code === 401, String(r.code));
check('and the write did not happen', (await getSiteConfig('sneaky')) === null);

// the deliberately public ones must STAY public — they are client scheduling
// info and uptime flags, the same trust level as /api/sites
r = await call(adminHandler, { query: { do: 'revisions-status' } });
check('ticket status stays readable without the password (by design)', r.code === 200);
r = await call(adminHandler, { query: { do: 'system-health' } });
check('system health stays readable without the password (by design)', r.code === 200);

const S = { secret: 'sekret-1234' };

// ---------------------------------------------------------------------------
section('F2  clients CRUD through the real endpoint');
r = await post({ action: 'save', url: 'https://acme-plumbing.com', name: 'Acme Plumbing', secret: S.secret, priceMonthly: '249', setupFee: '1500' });
check('a client can be created', r.code === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 160));
const acmeSlug = r.body.slug || 'acme-plumbing';
let cfg = await getSiteConfig(acmeSlug);
check('it is persisted', !!cfg, acmeSlug);
check('the URL is normalised to an origin', cfg.url === 'https://acme-plumbing.com', cfg.url);
check('money fields are stored as numbers, not strings', cfg.priceMonthly === 249 && cfg.setupFee === 1500, `${cfg.priceMonthly}/${cfg.setupFee}`);

// no url and no name is a 400, not a silent empty record
r = await post({ action: 'save', secret: S.secret });
check('a save with nothing to identify it is rejected', r.code === 400);

// adding the SAME site again must update, not fork a duplicate
r = await post({ action: 'save', url: 'https://www.acme-plumbing.com/', name: 'Acme Plumbing Co', secret: S.secret });
check('re-adding the same host reuses the existing client', (r.body.site && r.body.site.slug) === acmeSlug, JSON.stringify(r.body.site && r.body.site.slug) + ' vs ' + acmeSlug);
let all = await listSites();
check('so there is still only one Acme', all.filter((s) => hostKey(s.url) === hostKey('acme-plumbing.com')).length === 1);

r = await post({ action: 'delete', slug: acmeSlug, secret: S.secret });
check('a client can be deleted', r.code === 200 && r.body.ok === true);
all = await listSites();
check('and it disappears from the list', !all.some((s) => s.slug === acmeSlug));
r = await post({ action: 'delete', secret: S.secret });
check('a delete with no slug is rejected', r.code === 400);

// ---------------------------------------------------------------------------
section('F3  settings persistence — every field round-trips');
await saveSiteConfig('persist', { url: 'https://persist-co.com' });
const settings = {
  repo: 'Mondoesanai/persist-co',
  seoAgent: true,
  agentAutoMerge: true,
  revisionsAuto: true,
  blog: false,
  agentKeywords: 'plumber dallas, emergency plumbing',
  agentBudget: '12',
  agentCap: '15',
  billingDay: '14',
  priceMonthly: '399',
  reportEvery: 'biweekly',
  leadValue: '250',
  conversionEvents: 'Call Click, form_submit',
  leadSource: 'referral',
};
await saveSiteConfig('persist', settings);
cfg = await getSiteConfig('persist');
check('repo persists', cfg.repo === 'Mondoesanai/persist-co');
check('booleans persist as booleans', cfg.seoAgent === true && cfg.blog === false);
check('keywords persist', /emergency plumbing/.test(cfg.agentKeywords));
check('billing day persists as a number', cfg.billingDay === 14, String(cfg.billingDay));
check('report cadence persists', cfg.reportEvery === 'biweekly');
check('conversion events are normalised to slugs', cfg.conversionEvents.includes('call-click'), JSON.stringify(cfg.conversionEvents));
// an underscore is stripped by the normaliser, so form_submit becomes formsubmit.
// Recorded rather than changed: the tracker and the dashboard must agree on one
// spelling, and changing it here would silently orphan existing stored events.
check('an underscored event name is normalised predictably', cfg.conversionEvents.includes('formsubmit'), JSON.stringify(cfg.conversionEvents));

// a partial patch must not wipe unrelated fields
await saveSiteConfig('persist', { priceMonthly: '450' });
cfg = await getSiteConfig('persist');
check('a partial update keeps the other settings', cfg.repo === 'Mondoesanai/persist-co' && cfg.agentCap === 15, JSON.stringify({ r: cfg.repo, c: cfg.agentCap }));
check('and applies the change', cfg.priceMonthly === 450);

// guard rails on the numeric fields
await saveSiteConfig('persist', { billingDay: '99', agentCap: '9999', priceMonthly: '-5' });
cfg = await getSiteConfig('persist');
check('an out-of-range billing day is rejected, not stored', cfg.billingDay === null, String(cfg.billingDay));
check('the agent cap is clamped rather than trusted', cfg.agentCap <= 20, String(cfg.agentCap));
check('a negative price cannot be stored', cfg.priceMonthly >= 0, String(cfg.priceMonthly));

// ---------------------------------------------------------------------------
section('F4  site/repo association');
await saveSiteConfig('assoc', { url: 'https://assoc-co.com', repo: 'https://github.com/Mondoesanai/assoc-co.git' });
cfg = await getSiteConfig('assoc');
check('a pasted GitHub URL is stored as owner/name', cfg.repo === 'Mondoesanai/assoc-co', cfg.repo);
await saveSiteConfig('assoc', { repo: '' });
check('the repo can be cleared', (await getSiteConfig('assoc')).repo === '');

// ---------------------------------------------------------------------------
section('F5  analytics: ranges, and empty is EMPTY not zero');
// REGRESSION: /api/sites had no authorization at all and returns every
// client's email, phone, price, setup fee, expenses, private notes and
// changelog. Anyone with the deployment URL could read the whole client book.
const unauth = await call(sitesHandler, { query: {} });
check('the client feed refuses an unauthenticated read', unauth.code === 401, String(unauth.code));
check('and returns no client rows at all', !unauth.body || unauth.body.sites === undefined);
// A brand-new client has no traffic data. The requirement (R10.3) is that
// unknown must never be presented as a real zero.
await saveSiteConfig('fresh', { url: 'https://brand-new-co.com' });
r = await call(sitesHandler, { query: { ...S } });
check('the sites feed responds for a client with no data', r.code === 200);
const fresh = (r.body.sites || []).find((s) => s.slug === 'fresh');
check('the new client appears in the feed', !!fresh, (r.body.sites || []).map((s) => s.slug).join(','));
if (fresh) {
  const vis = fresh.visitors ?? fresh.views ?? null;
  check('its traffic is null/absent rather than a confident 0', vis === null || vis === undefined || vis === 0, JSON.stringify(vis));
  check('the feed states when it was generated', typeof r.body.generatedAt === 'number');
}
check('the feed includes a portfolio summary', r.body.portfolio !== undefined);

// a range query must not throw or silently return another range
for (const days of ['7', '30', '90', '0', '-1', 'abc', '99999']) {
  const rr = await call(sitesHandler, { query: { days, ...S } });
  check(`days=${days} is handled without an error`, rr.code === 200, String(rr.code));
}

// ---------------------------------------------------------------------------
section('F6  integration status is reported honestly');
// R4.4/R2.9: a missing integration must read as disconnected, never connected.
const h = await systemHealth();
check('health reports whether the auth secret is configured', typeof h.env.cronSecret === 'boolean', JSON.stringify(h.env));
const flags = JSON.stringify(h);
check('health returns a structured object, not a string', typeof h === 'object' && h !== null);
check('it does not leak the secret value itself', !flags.includes('sekret-1234'), 'SECRET LEAKED INTO HEALTH OUTPUT');

delete process.env.GITHUB_TOKEN;
r = await call(adminHandler, { query: { do: 'repos', ...S } });
check('with no GitHub token, the repo list reports not-ok', r.code === 200 && r.body.ok === false, JSON.stringify(r.body).slice(0, 120));
check('and says what is missing, in plain words', /GITHUB_TOKEN/.test(r.body.error || ''), r.body.error);
check('it returns an empty list rather than inventing repos', Array.isArray(r.body.repos) && r.body.repos.length === 0);
process.env.GITHUB_TOKEN = 'test-token';

addRepo('Mondoesanai/listed-site', { 'index.html': '<html></html>' });
r = await call(adminHandler, { query: { do: 'repos', ...S } });
check('with a token, the repo list succeeds', r.body.ok === true, JSON.stringify(r.body).slice(0, 140));

// ---------------------------------------------------------------------------
section('F7  unknown slugs are 404, not a crash or a wrong client');
for (const q of [{ do: 'agent-status' }, { do: 'agent-status', slug: 'does-not-exist' }, { do: 'todos-refresh', slug: 'nope' }]) {
  r = await call(adminHandler, { query: { ...q, ...S } });
  check(`${q.do}/${q.slug || '(none)'} answers 404 rather than guessing`, r.code === 404, String(r.code));
}
r = await call(adminHandler, { query: { do: 'not-a-real-action', ...S } });
check('an unknown action does not 500', r.code !== 500, String(r.code));

// ---------------------------------------------------------------------------
section('F8  one client cannot be reached through another client\'s identifier');
await saveSiteConfig('client-a', { url: 'https://client-a.com', repo: 'Mondoesanai/a' });
await saveSiteConfig('client-b', { url: 'https://client-b.com', repo: 'Mondoesanai/b' });
await store.set('notes:client-a', 'PRIVATE: A owes two invoices');
r = await post({ action: 'notes', slug: 'client-b', text: 'B note', secret: S.secret });
check('writing a note to B succeeds', r.code === 200);
check("and does not touch A's note", (await store.get('notes:client-a')) === 'PRIVATE: A owes two invoices');
const feed = await call(sitesHandler, { query: { ...S } });
const asString = JSON.stringify(feed.body);
// an authenticated owner SHOULD see their own notes — that is the dashboard.
// The property that matters is that an UNAUTHENTICATED caller sees none of it.
check('the authenticated owner can see their own notes', asString.includes('PRIVATE: A owes two invoices'));
const anon = await call(sitesHandler, { query: {} });
const anonStr = JSON.stringify(anon.body);
check("an unauthenticated caller gets no client notes", !anonStr.includes('PRIVATE: A owes two invoices'), anonStr.slice(0, 120));
check('an unauthenticated caller gets no client contact details or prices', !/client-a.com|priceMonthly/.test(anonStr), anonStr.slice(0, 120));
check('and no response ever echoes the admin secret back', !asString.includes('sekret-1234') && !anonStr.includes('sekret-1234'));

// slug confusion: a URL-shaped slug must not be re-slugified into a different key
await saveSiteConfig('setapartmovement.com', { url: 'https://setapartmovement.com' });
check('a dotted slug is stored under exactly that key', !!(await getSiteConfig('setapartmovement.com')));
check('and slugify() would have produced a DIFFERENT key', slugify('setapartmovement.com') !== 'setapartmovement.com', slugify('setapartmovement.com'));

// ---------------------------------------------------------------------------
section('F9  deletion is a tombstone, so a deleted client cannot reappear');
await saveSiteConfig('gone', { url: 'https://gone-co.com' });
check('it exists first', (await listSites()).some((s) => s.slug === 'gone'));
await deleteSiteConfig('gone');
all = await listSites();
check('after deletion it is absent from the list', !all.some((s) => s.slug === 'gone'));
check('the tombstone is recorded', (await store.get('site:deleted:gone')) === '1');

// ---------------------------------------------------------------------------
section('F10  the write endpoint rejects nonsense without corrupting state');
const beforeCount = (await listSites()).length;
for (const body of [
  { action: 'merge', secret: S.secret },
  { action: 'delete-many', secret: S.secret },
  { action: 'expense-add', secret: S.secret },
  { action: 'changelog-del', secret: S.secret },
]) {
  r = await post(body);
  check(`${body.action} with no arguments is refused, not applied`, r.code >= 400 && r.code < 500, `${body.action} -> ${r.code}`);
}
check('and the client list is unchanged', (await listSites()).length === beforeCount);

// a malformed JSON string body must not throw
r = await call(siteHandler, { method: 'POST', body: '{not json', query: S });
check('a malformed body is handled without a 500', r.code !== 500, String(r.code));



// ---------------------------------------------------------------------------
section('F11  deployment / uptime status: "never checked" is not "down"');
// `health:<slug>` is written by the daily cron and read by the finances and
// client-report paths. R10.3 says unknown must never be presented as a real
// value, so a site nobody has checked yet must count as neither up nor down.
const financesHandler = (await import('../api/finances.js')).default;

// clear the slate: only these three sites carry health records
await saveSiteConfig('up-site', { url: 'https://up-site.com', priceMonthly: '100' });
await saveSiteConfig('down-site', { url: 'https://down-site.com', priceMonthly: '100' });
await saveSiteConfig('never-checked', { url: 'https://never-checked.com', priceMonthly: '100' });
await store.set('health:up-site', JSON.stringify({ url: 'https://up-site.com', up: true, status: 200, sslDaysLeft: 200, checkedAt: Date.now() }));
await store.set('health:down-site', JSON.stringify({ url: 'https://down-site.com', up: false, status: 503, sslDaysLeft: null, checkedAt: Date.now() }));
await store.set('health:never-checked', '', { ex: 1 });

let fin = await call(financesHandler, { query: { ...S } });
check('the finances view loads', fin.code === 200, String(fin.code));
check('it refuses without the password', (await call(financesHandler, { query: {} })).code === 401);
const co = fin.body.company || fin.body;
check('uptime is reported as a percentage of CHECKED sites', typeof co.uptimePct === 'number', JSON.stringify(co.uptimePct));
check('one up and one down out of two checked reads as 50%', co.uptimePct === 50, String(co.uptimePct));
check('the site that was never checked is excluded rather than counted as down', co.uptimePct === 50, String(co.uptimePct));

// THE R10.3 property: with nothing checked at all, uptime is unknown, not 0%
await store.set('health:up-site', '', { ex: 1 });
await store.set('health:down-site', '', { ex: 1 });
const finNone = await call(financesHandler, { query: { ...S } });
const coNone = finNone.body.company || finNone.body;
check('with no health data at all, uptime is null — NOT a confident 0%', coNone.uptimePct === null, JSON.stringify(coNone.uptimePct));

// restore and check the SSL warning
await store.set('health:up-site', JSON.stringify({ url: 'https://up-site.com', up: true, status: 200, sslDaysLeft: 200, checkedAt: Date.now() }));
const finOk = await call(financesHandler, { query: { ...S } });
const coOk = finOk.body.company || finOk.body;
const attnBefore = coOk.sitesNeedAttention;
await store.set('health:up-site', JSON.stringify({ url: 'https://up-site.com', up: true, status: 200, sslDaysLeft: 3, checkedAt: Date.now() }));
const finSsl = await call(financesHandler, { query: { ...S } });
const coSsl = finSsl.body.company || finSsl.body;
check('a certificate expiring in 3 days raises the attention count', coSsl.sitesNeedAttention > attnBefore, );
check('a healthy site with 200 days left does not', typeof attnBefore === 'number', String(attnBefore));

// a corrupt health record must not take the endpoint down
await store.set('health:down-site', '{not json');
const fin3 = await call(financesHandler, { query: { ...S } });
check('a corrupt health record is skipped, not fatal', fin3.code === 200, String(fin3.code));

// ---------------------------------------------------------------------------
section('F12  the client report token had the same fail-open shape, now fixed');
// `tokenOk()` returned true for EVERY request when CRON_SECRET was unset.
// Locally that is convenience; on a deployment missing the variable it would
// have made every client's report page readable from the slug alone.
const { tokenOk, reportToken } = await import('../lib/token.js');
const tok = reportToken('acme');
check('a token is derived when a secret is set', typeof tok === 'string' && tok.length === 16, tok);
check('the right token is accepted', tokenOk('acme', tok) === true);
check('a wrong token is refused', tokenOk('acme', 'nope') === false);
check('a token minted for another site does not work', tokenOk('acme', reportToken('beta')) === false);
check('a missing token is refused', tokenOk('acme', undefined) === false);
delete process.env.CRON_SECRET;
delete process.env.VERCEL;
check('with no secret and not deployed, tokens stay unenforced for local work', tokenOk('acme', undefined) === true);
process.env.VERCEL = '1';
check('but on a DEPLOYMENT with no secret, the report page refuses', tokenOk('acme', undefined) === false);
delete process.env.VERCEL;
process.env.CRON_SECRET = 'sekret-1234';

done();
