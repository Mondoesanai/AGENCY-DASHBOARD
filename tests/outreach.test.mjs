// R6 — the cold-email adapter and the gate in front of it.
// The point of these checks is that sending is OFF and stays off: the default
// is refusal, and every refusal says which owner action would change it.
import { check, section, done } from './world.mjs';
import {
  PROVIDERS, RECOMMENDED, sendReadiness, createInstantlyAdapter,
  createDisconnectedAdapter, getEmailAdapter, maySend, markSent, sendProspectEmail,
} from '../lib/outreach-email.js';
import { saveSettings, saveSender } from '../lib/settings.js';
import { upsertContact, optOut, field } from '../lib/contacts.js';
const E = (v) => field(v, { confidence: 1, source: 'manual' });
import { store } from '../lib/store.js';

const res = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), headers: { get: () => null } });

// ---------------------------------------------------------------------------
section('O1  the provider decision is recorded, including the rejected one');
check('a provider is recommended', RECOMMENDED === 'instantly');
check('it is documented as permitting cold outreach', PROVIDERS.instantly.permitsColdOutreach === true);
check('with a stated reason', PROVIDERS.instantly.why.length > 40);
check('its official docs are linked', /developer\.instantly\.ai/.test(PROVIDERS.instantly.docs));
check('the documented v2 base URL is used', PROVIDERS.instantly.baseUrl === 'https://api.instantly.ai/api/v2');
check('the documented bulk limit is recorded', PROVIDERS.instantly.rateLimits.bulkLeadsPerRequest === 1000);
// the important one: the transactional sender is recorded as UNSUITABLE so a
// later reader does not "simplify" by reusing it
check('Resend is explicitly marked as NOT for prospecting', PROVIDERS.resend.permitsColdOutreach === false);
check('and the risk is spelled out', /clients their reports/.test(PROVIDERS.resend.why), PROVIDERS.resend.why);

// ---------------------------------------------------------------------------
section('O2  with nothing configured, it is DISCONNECTED and says so');
const bare = {};
let rd = await sendReadiness({ env: bare });
check('not ready', rd.ready === false);
check('not connected', rd.connected === false);
check('the display status is "not connected", never "ready"', rd.displayStatus === 'not connected', rd.displayStatus);
const codes = rd.blockers.map((b) => b.code);
check('it names the missing credentials', codes.includes('no-credentials'), codes.join(','));
check('it names the missing separate sending domain', codes.includes('no-sending-domain'), codes.join(','));
check('it names unset pricing', codes.includes('no-pricing'), codes.join(','));
check('it names draft targeting', codes.includes('targeting-draft'), codes.join(','));
check('it names outreach being off', codes.includes('outreach-off'), codes.join(','));
check('every blocker is marked as an owner action', rd.blockers.every((b) => b.ownerAction === true));

const ad = getEmailAdapter({ env: bare });
check('the adapter resolves to the disconnected one', ad.configured() === false);
check('and it names what is missing', /INSTANTLY_API_KEY/.test(ad.label) || /not connected/i.test(ad.label), ad.label);
const attempt = await ad.createCampaign({ name: 'x' });
check('creating a campaign refuses', attempt.ok === false && attempt.disconnected === true, JSON.stringify(attempt));

// ---------------------------------------------------------------------------
section('O3  even fully configured, an opt-out still wins');
await saveSettings({ pricing: { buildPrice: '2500', monthlyFee: '197' }, targeting: { status: 'confirmed' } });
// R6.9 — a real deployment cannot send without a CAN-SPAM sender identity,
// so the tests that exercise "ready to send" configure one.
await saveSender({ name: 'Mondo Davis', business: 'Inspiring Websites LLC', postalAddress: '2201 Preston Rd Suite 405, Plano TX 75093' });
// R6.9 — a real deployment cannot send without a signable unsubscribe link
// and a public URL for it to point at, so the "everything is set" env says so.
const fullEnv = { INSTANTLY_API_KEY: 'test-key', OUTREACH_FROM_DOMAIN: 'outreach.example.com', PUBLIC_BASE_URL: 'https://dash.test', UNSUBSCRIBE_SECRET: 'unsub-test-secret' };

// settings cannot activate outreach, so readiness must still fail on that alone
rd = await sendReadiness({ env: fullEnv });
check('with everything else set, the only blocker left is activation', rd.blockers.length === 1 && rd.blockers[0].code === 'outreach-off', JSON.stringify(rd.blockers));
// R2.9 — a key existing is not a connection. Until a real call to the provider
// has succeeded, the screen says the credential is set and nothing more; it
// used to read "connected, not activated" on the strength of an env var, which
// would survive a revoked or mistyped key.
check('a key with no proven call does not read as connected', rd.connected === false, JSON.stringify({ c: rd.connected, s: rd.displayStatus }));
check('but the credential is reported as present', rd.credentialPresent === true);
check('and it says exactly that', rd.displayStatus === 'key set, never confirmed', rd.displayStatus);
check('the evidence state is named', rd.evidenceState === 'configured', rd.evidenceState);

// once a real exchange has succeeded, it may say so
{
  const { recordSuccess } = await import('../lib/integrations.js');
  await recordSuccess('instantly');
  const proven = await sendReadiness({ env: fullEnv });
  check('a proven integration reads as confirmed working', proven.connected === true && /confirmed working/.test(proven.displayStatus), proven.displayStatus);
  const { recordFailure } = await import('../lib/integrations.js');
  await recordFailure('instantly', 'http 401 unauthorized');
  const broken = await sendReadiness({ env: fullEnv });
  check('a key that the provider rejects stops reading as connected', broken.connected === false, JSON.stringify({ c: broken.connected, s: broken.displayStatus }));
  check('and the real error is carried', /401/.test(broken.lastError), broken.lastError);
}

// force the owner switch on directly in storage (nothing in code may do this)
const raw = JSON.parse(await store.get('settings:business'));
await store.set('settings:business', JSON.stringify({ ...raw, outreach: { ...raw.outreach, active: true } }));
rd = await sendReadiness({ env: fullEnv });
check('with the owner switch on, it is ready', rd.ready === true, JSON.stringify(rd.blockers));

const a = await upsertContact({ source: 'discovery', name: E('Pat Lee'), businessName: E('Lone Star Flooring'), email: E('pat@lonestarflooring.test') });
const contact = a.contact;
let gate = await maySend({ contact, campaignId: 'c1', env: fullEnv });
check('a fresh eligible contact may be sent to', gate.ok === true, JSON.stringify(gate));

await optOut({ email: 'pat@lonestarflooring.test', reason: 'unsubscribed' });
const after = (await upsertContact({ source: 'discovery', name: E('Pat Lee'), businessName: E('Lone Star Flooring'), email: E('pat@lonestarflooring.test') })).contact;
gate = await maySend({ contact: after, campaignId: 'c1', env: fullEnv });
check('after opting out, the gate refuses', gate.ok === false, JSON.stringify(gate));
check('and the reason is consent, not configuration', gate.code === 'not-contactable', gate.code);

// ---------------------------------------------------------------------------
section('O4  a retry cannot send the same message twice (R11.2)');
const b = await upsertContact({ source: 'discovery', name: E('Sam Ortiz'), businessName: E('Metroplex Floors'), email: E('sam@metroplexfloors.test') });
gate = await maySend({ contact: b.contact, campaignId: 'c2', env: fullEnv });
check('the first send is allowed', gate.ok === true, JSON.stringify(gate));
await markSent(b.contact.id, 'c2', { provider: 'instantly' });
gate = await maySend({ contact: b.contact, campaignId: 'c2', env: fullEnv });
check('the second is refused as already sent', gate.ok === false && gate.code === 'already-sent', JSON.stringify(gate));
gate = await maySend({ contact: b.contact, campaignId: 'c3', env: fullEnv });
check('but a different campaign is still allowed', gate.ok === true);

// ---------------------------------------------------------------------------
section('O5  the adapter speaks the documented API');
const calls = [];
const fakeFetch = async (url, opts) => {
  calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers.Authorization });
  if (String(url).endsWith('/campaigns')) return res(200, { id: 'camp_1' });
  if (String(url).includes('/activate')) return res(200, { status: 'active' });
  if (String(url).includes('/leads/bulk')) return res(200, { added: true });
  return res(200, {});
};
const inst = createInstantlyAdapter({ fetchImpl: fakeFetch, env: fullEnv });
check('it reports itself configured when a key exists', inst.configured() === true);

let out = await inst.createCampaign({ name: 'DFW flooring — no site found' });
check('creating a campaign posts to /campaigns', calls[0].url === 'https://api.instantly.ai/api/v2/campaigns' && calls[0].method === 'POST', calls[0].url);
check('and authenticates with a bearer token', calls[0].auth === 'Bearer test-key');
check('the campaign id comes back', out.data.id === 'camp_1');

out = await inst.activate('camp_1');
check('activation uses PATCH, as documented', calls[1].method === 'PATCH' && /\/campaigns\/camp_1\/activate$/.test(calls[1].url), `${calls[1].method} ${calls[1].url}`);

// the documented bulk limit must chunk, not truncate
calls.length = 0;
const many = Array.from({ length: 2300 }, (_, i) => ({ email: `p${i}@example.com`, business: 'B' }));
out = await inst.addLeads('camp_1', many);
check('2300 leads are split into 3 requests, not truncated to 1000', calls.length === 3, String(calls.length));
check('each request is within the documented 1000 limit', calls.every((c) => c.body.leads.length <= 1000), calls.map((c) => c.body.leads.length).join(','));
check('all 2300 are actually sent', calls.reduce((n, c) => n + c.body.leads.length, 0) === 2300);

// rate limiting is surfaced as transient, never as success
const limited = createInstantlyAdapter({ fetchImpl: async () => res(429, { message: 'slow down' }), env: fullEnv });
out = await limited.listEmails();
check('a 429 is not reported as success', out.ok === false);
check('and is marked transient so it is retried, not treated as a failure', out.transient === true);

// a provider error is not silently swallowed
const broken = createInstantlyAdapter({ fetchImpl: async () => res(500, { message: 'boom' }), env: fullEnv });
out = await broken.createCampaign({ name: 'x' });
check('a 500 surfaces as an error', out.ok === false && out.status === 500, JSON.stringify(out));

// ---------------------------------------------------------------------------
section('O6  the single send path refuses when anything is missing');
const c = await upsertContact({ source: 'discovery', name: E('Dana Kim'), businessName: E('Trinity Tile'), email: E('dana@trinitytile.test') });
let sent = await sendProspectEmail({ contact: c.contact, campaignId: 'c9', message: {}, env: {}, fetchImpl: fakeFetch });
check('with no provider key, nothing is sent', sent.sent === false, JSON.stringify(sent));
check('and the reason is actionable', /API key|not connected|not been switched/i.test(sent.reason || ''), sent.reason);

sent = await sendProspectEmail({ contact: c.contact, campaignId: 'c9', message: {}, env: fullEnv, fetchImpl: fakeFetch });
check('with everything configured and activated, it goes through the provider', sent.sent === true, JSON.stringify(sent));
check('and records which provider sent it', sent.provider === 'instantly');

sent = await sendProspectEmail({ contact: c.contact, campaignId: 'c9', message: {}, env: fullEnv, fetchImpl: fakeFetch });
check('sending the same thing again is refused', sent.sent === false && sent.code === 'already-sent');

// put outreach back to OFF so no later test or run inherits an active state
const raw2 = JSON.parse(await store.get('settings:business'));
await store.set('settings:business', JSON.stringify({ ...raw2, outreach: { active: false, reason: 'returned to off by the test suite' } }));
check('outreach is left OFF after the suite', (await sendReadiness({ env: fullEnv })).ready === false);

done();
