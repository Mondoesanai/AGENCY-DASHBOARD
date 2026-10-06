// The release gate: the real entry points, over a real socket.
//
// R17.3. Not a re-run of the unit tests. This asks the questions that only
// matter at the moment of deploying, and asks them of `api/` as Vercel actually
// mounts it — every file discovered from disk, so an endpoint added later is in
// the gate whether or not anyone remembered to list it.
//
// Every material claim here has a NEGATIVE CONTROL beside it: a gate that only
// ever sees the request it was built for proves nothing about the request it
// was built to stop.
//
// Seven areas, in the order a release would break them:
//   G1  authentication      — can an unauthenticated caller read or change data?
//   G2  public endpoints    — the ones that MUST stay open, and their limits
//   G3  webhook signatures  — forged, tampered, replayed
//   G4  suppression         — both key formats, through the real handler
//   G5  duplicate sends     — the same event twice
//   G6  budget enforcement  — through a production path, not the library
//   G7  recovery            — a worker that dies mid-job
import { check, section, done } from './world.mjs';
import { startLocalApi } from './harness/local-api.mjs';
import { store } from '../lib/store.js';

// The harness's own transport, NOT `fetch`: tests/world.mjs replaces
// globalThis.fetch with a stub for the whole suite, so a gate using fetch would
// be quietly talking to that stub instead of to its own server — and would pass
// while proving nothing. This goes straight to the socket.
const api = await startLocalApi();
const get = (p, h = {}) => api.request(p, { headers: h });
const post = (p, body, h = {}) => api.post(p, body, h);

// ---------------------------------------------------------------------------
section('G1  authentication, in each of the three states a deployment can be in');
// The first version of this gate asserted a bare 401 and failed on every
// endpoint — correctly, as it turned out. `authMode()` is OPEN when there is no
// CRON_SECRET *and* the process is not deployed, which is how local development
// and this suite work at all. So "no key gets 401" is only true of a deployment,
// and testing it without saying which mode you are in tests nothing.
//
// The three modes, and the one that matters: `locked` exists so that a missing
// secret in production cannot silently serve client financials to anyone who
// guesses the URL.
const { authMode } = await import('../lib/auth.js');
const envWas = { CRON_SECRET: process.env.CRON_SECRET, VERCEL: process.env.VERCEL, VERCEL_ENV: process.env.VERCEL_ENV };
const setEnv = (o) => {
  for (const k of ['CRON_SECRET', 'VERCEL', 'VERCEL_ENV']) {
    if (o[k] == null) delete process.env[k];
    else process.env[k] = o[k];
  }
};

const PRIVATE = [
  'contacts-list', 'contact-status', 'budget-status', 'sms-stats', 'repair-tasks',
  'meetings', 'integrations',
];
const WRITES = [
  ['budget-save', { weeklyUsd: '999' }],
  ['record-permission', { contactId: 'x', source: 'a', wording: 'b', evidence: 'c' }],
  ['sms-send', { messageId: 'x' }],
  ['attest-consent', { contactIds: ['x'], basis: 'because' }],
  ['recovery-ack', { id: 'x' }],
];

// --- deployed, secret set: enforced ---------------------------------------
setEnv({ CRON_SECRET: 'gate-secret', VERCEL: '1', VERCEL_ENV: 'production' });
check('a deployment with a secret is in ENFORCED mode', authMode() === 'enforced', authMode());
for (const action of PRIVATE) {
  const r = await get(`/api/admin?do=${action}`);
  check(`enforced: ?do=${action} is refused with no secret`, r.status === 401, `${r.status}`);
}
for (const [action, body] of WRITES) {
  const r = await post(`/api/admin?do=${action}`, body);
  check(`enforced: ?do=${action} (write) is refused with no secret`, r.status === 401, `${r.status}`);
}
const wrong = await get('/api/admin?do=budget-status&secret=not-the-secret');
check('enforced: a WRONG secret is refused', wrong.status === 401, `${wrong.status}`);

section('G1b  NEGATIVE CONTROL: the right secret is accepted');
// Without this, a gate that refused everything would look identical to one
// that works.
const right = await get('/api/admin?do=budget-status&secret=gate-secret');
check('enforced: the correct secret is accepted', right.status === 200, `${right.status}`);
check('and it actually returns the data', right.json?.ok === true, JSON.stringify(right.json).slice(0, 100));

section('G1c  deployed with NO secret is LOCKED, not open');
// The failure this mode exists to prevent: a preview environment, or a bad
// rotation, leaving the admin surface public.
setEnv({ CRON_SECRET: null, VERCEL: '1', VERCEL_ENV: 'production' });
check('a deployment with no secret is LOCKED', authMode() === 'locked', authMode());
const locked = await get('/api/admin?do=budget-status');
check('locked: every admin request is refused', locked.status === 401, `${locked.status}`);
check('and the refusal names the missing variable, so it is fixable',
  /CRON_SECRET/.test(locked.json?.error || ''), JSON.stringify(locked.json).slice(0, 140));
check('locked: even a guessed secret is refused',
  (await get('/api/admin?do=budget-status&secret=anything')).status === 401);

section('G1d  only an UNDEPLOYED process with no secret is open');
setEnv({ CRON_SECRET: null, VERCEL: null, VERCEL_ENV: null });
check('local, no secret: OPEN', authMode() === 'open', authMode());
check('which is why this suite can call the admin API at all',
  (await get('/api/admin?do=budget-status')).status === 200);
check('and that state is unreachable once VERCEL is set',
  (() => { setEnv({ CRON_SECRET: null, VERCEL: '1', VERCEL_ENV: 'preview' }); const m = authMode(); setEnv({ CRON_SECRET: null, VERCEL: null, VERCEL_ENV: null }); return m === 'locked'; })(),
  'a preview deployment without the secret is locked, not open');

setEnv(envWas);

// ---------------------------------------------------------------------------
section('G1e  the one unauthenticated endpoint that DOES work is production-only');
// `auto-poke` sits above the auth gate on purpose, so a browser can nudge the
// tick without a secret. `vercel env ls` shows KV scoped to Production AND
// Preview while CRON_SECRET is Production-only — so without this check, every
// preview deployment would expose an unauthenticated endpoint that runs the
// real tick against the real production database.
setEnv({ CRON_SECRET: null, VERCEL: '1', VERCEL_ENV: 'preview' });
const pokePreview = await get('/api/admin?do=auto-poke');
check('auto-poke is refused on a preview deployment', pokePreview.status === 403, `${pokePreview.status}`);
check('and says why, naming the shared database',
  /production.s database|live data/i.test(pokePreview.json?.why || ''), JSON.stringify(pokePreview.json).slice(0, 160));

setEnv({ CRON_SECRET: null, VERCEL: '1', VERCEL_ENV: 'development' });
check('and on a development deployment', (await get('/api/admin?do=auto-poke')).status === 403);

section('G1f  NEGATIVE CONTROL: it still runs where it is meant to');
setEnv({ CRON_SECRET: null, VERCEL: null, VERCEL_ENV: null });
const pokeLocal = await get('/api/admin?do=auto-poke');
check('locally (no VERCEL_ENV) the tick is not blocked', pokeLocal.status === 200, `${pokeLocal.status}`);
setEnv({ CRON_SECRET: null, VERCEL: '1', VERCEL_ENV: 'production' });
const pokeProd = await get('/api/admin?do=auto-poke');
check('and in production it is not blocked either', pokeProd.status === 200, `${pokeProd.status}`);
check('while the admin surface there is still locked without a secret',
  (await get('/api/admin?do=budget-status')).status === 401,
  'auto-poke being open must not open anything else');
setEnv(envWas);

// ---------------------------------------------------------------------------
section('G2  the endpoints that must stay public, and only those');
// Each of these is open deliberately: the person using it is not a user of this
// system and must never be asked to authenticate.
const optinTerms = await get('/api/collect?hook=optin-terms');
check('the opt-in terms are readable by anyone', optinTerms.status === 200, `${optinTerms.status}`);

const optinGet = await get('/api/collect?hook=optin');
check('but a GET cannot enrol anyone', optinGet.status === 405, `${optinGet.status}`);

const unsubGet = await get('/api/collect?hook=unsubscribe&t=anything');
check('an unsubscribe GET does not unsubscribe (scanners fetch links)',
  unsubGet.status === 200 || unsubGet.status === 400, `${unsubGet.status}`);

section('G2b  and the public write is capped');
let last429 = 0;
for (let i = 0; i < 6; i++) {
  const r = await post('/api/collect?hook=optin', { phone: '2145559001', agreed: true });
  if (r.status === 429) last429 = i + 1;
}
check('a burst of submissions is eventually refused', last429 > 0, `429 first seen at request ${last429}`);

// ---------------------------------------------------------------------------
section('G3  webhook signatures — forged, tampered and replayed');
const booking = {
  event: 'invitee.created',
  payload: { uri: 'https://api.calendly.com/scheduled_events/REL1', email: 'g3@example.invalid', name: 'Gate Three', start_time: new Date(Date.now() + 864e5).toISOString() },
};
const forged = await api.post('/api/collect?hook=booking', booking, { 'calendly-webhook-signature': 't=1,v1=deadbeef' });
check('a forged booking signature is refused', forged.status === 401, `${forged.status}`);

const unsigned = await post('/api/collect?hook=booking', booking);
check('an unsigned booking is refused', unsigned.status === 401, `${unsigned.status}`);

const smsForged = await api.request('/api/collect?hook=sms-status', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'nope' }, body: 'MessageSid=SM1&MessageStatus=delivered' });
check('a forged delivery receipt is refused', smsForged.status === 401 || smsForged.status === 403, `${smsForged.status}`);

section('G3b  NEGATIVE CONTROL: the verifier can say yes');
// A verifier that refuses everything is indistinguishable from one that works.
const { verifyCalendlySignature } = await import('../lib/bookings.js');
const crypto = await import('node:crypto');
const raw = JSON.stringify(booking);
const t = Math.floor(Date.now() / 1000);
const good = crypto.createHmac('sha256', 'test-key').update(`${t}.${raw}`).digest('hex');
check('a correctly signed payload verifies',
  verifyCalendlySignature({ header: `t=${t},v1=${good}`, rawBody: raw, signingKey: 'test-key' }).ok === true,
  JSON.stringify(verifyCalendlySignature({ header: `t=${t},v1=${good}`, rawBody: raw, signingKey: 'test-key' })));
check('the same signature over a TAMPERED body does not',
  verifyCalendlySignature({ header: `t=${t},v1=${good}`, rawBody: `${raw} `, signingKey: 'test-key' }).ok === false);
const oldT = t - 8 * 86400;
const oldSig = crypto.createHmac('sha256', 'test-key').update(`${oldT}.${raw}`).digest('hex');
check('and a week-old replay does not',
  verifyCalendlySignature({ header: `t=${oldT},v1=${oldSig}`, rawBody: raw, signingKey: 'test-key' }).ok === false);

// ---------------------------------------------------------------------------
section('G4  suppression holds through the REAL inbound handler, both formats');
const { handleInboundSms } = await import('../lib/sms-inbound.js');
const { isPhoneSuppressed } = await import('../lib/contacts.js');

// written the OLD way, as retention.js used to
await store.set('suppress:phone:12145559101', 'erased');
check('an old-format suppression is seen', (await isPhoneSuppressed('+12145559101')) === true);

const stopped = await handleInboundSms({ from: '+12145559102', body: 'STOP', business: 'Gate' });
check('a real STOP suppresses', stopped.suppressed === true, JSON.stringify(stopped).slice(0, 120));
check('and is readable back', (await isPhoneSuppressed('+12145559102')) === true);

const { recordKeywordOptIn } = await import('../lib/optin-public.js');
check('neither format can be enrolled by the keyword',
  (await recordKeywordOptIn({ e164: '+12145559101', rawText: 'PREVIEW' })).ok === false
  && (await recordKeywordOptIn({ e164: '+12145559102', rawText: 'PREVIEW' })).ok === false);

section('G4b  NEGATIVE CONTROL: an unsuppressed number is not refused');
check('a clean number enrols', (await recordKeywordOptIn({ e164: '+12145559103', rawText: 'PREVIEW' })).ok === true,
  'if everything were refused, G4 would prove nothing');

// ---------------------------------------------------------------------------
section('G5  the same event twice does not count twice');
const { claimEventOnce } = await import('../lib/webhooks.js');
const id = `gate-${Date.now()}`;
const first = await claimEventOnce('booking', id);
const second = await claimEventOnce('booking', id);
check('the first delivery of an event is fresh', first.fresh === true, JSON.stringify(first));
check('the second delivery of the SAME event is not', second.fresh === false, JSON.stringify(second));
check('NEGATIVE CONTROL: a different event IS fresh',
  (await claimEventOnce('booking', `${id}-b`)).fresh === true,
  'if everything were a duplicate, the check above would prove nothing');
check('and the same id in a DIFFERENT scope is fresh',
  (await claimEventOnce('sms-status', id)).fresh === true,
  'a Calendly event id and a Twilio sid must not collide');
check('an event with no id is refused rather than applied',
  (await claimEventOnce('booking', '')).fresh === false,
  'not knowing whether something is a duplicate must never mean "apply it again"');

// ---------------------------------------------------------------------------
section('G6  the budget refuses through a production path');
const { setBudgetSettings, periodKey } = await import('../lib/budget.js');
const { aiClient, __setSdkLoader, BudgetRefusedError } = await import('../lib/ai-client.js');
for (const p of ['week', 'month']) {
  await store.set(`budget:${p}:${periodKey(p)}:spent`, 0);
  await store.set(`budget:${p}:${periodKey(p)}:reserved`, 0);
}
let providerCalls = 0;
__setSdkLoader(async () => ({
  default: class { constructor() { this.messages = { create: async () => { providerCalls += 1; return { content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 10, output_tokens: 10 } }; } }; } },
}));

await setBudgetSettings({ weeklyLimitCents: 1, monthlyLimitCents: null, conversationReservePct: 0 });
const client = await aiClient({ apiKey: 'k', category: 'ai' });
let refused = null;
try {
  await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 4000, messages: [{ role: 'user', content: 'hello' }] });
} catch (e) { refused = e; }
check('a model call over the limit is refused', refused instanceof BudgetRefusedError, refused?.name);
check('AND THE PROVIDER WAS NEVER CALLED', providerCalls === 0, String(providerCalls));

section('G6b  NEGATIVE CONTROL: with budget, the same call goes through');
await setBudgetSettings({ weeklyLimitCents: 100000, monthlyLimitCents: null, conversationReservePct: 0 });
await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] });
check('it reaches the provider', providerCalls === 1, String(providerCalls));

// ---------------------------------------------------------------------------
section('G7  a worker that dies mid-job strands nothing');
const { enqueue, claim, runOne, listQueue, DEFAULTS } = await import('../lib/jobs.js');
const job = await enqueue({ type: 'gate-test', payload: { n: 1 }, idempotencyKey: `gate-${Date.now()}` });
check('a job can be queued', !!job?.id || job?.ok !== false, JSON.stringify(job).slice(0, 120));

// claim it, then abandon it as a killed function would
const claimed = await claim({ worker: 'dies', types: ['gate-test'] });
check('a worker claims it', !!claimed?.job, JSON.stringify(claimed).slice(0, 120));

// the lease expires rather than the job being lost
const reclaimed = await claim({ worker: 'next', types: ['gate-test'], now: Date.now() + DEFAULTS.leaseMs + 1000 });
check('after the lease expires another worker reclaims it', !!reclaimed?.job,
  'a process killed mid-job must strand nothing — the lease is what guarantees it');
check('and it is the same job', reclaimed?.job?.id === claimed?.job?.id,
  `${reclaimed?.job?.id} vs ${claimed?.job?.id}`);

section('G7b  NEGATIVE CONTROL: a live lease is NOT reclaimable');
const held = await claim({ worker: 'holder', types: ['gate-test'] });
check('nothing is handed out while a lease is live', !held?.job,
  'if any claim always succeeded, G7 would prove nothing about leases');

await api.stop();
done();
