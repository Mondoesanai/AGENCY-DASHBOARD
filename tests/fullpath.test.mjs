// R12.2 — one request travelling the whole way:
//   browser → API → storage → worker → provider fixture → webhook → dashboard
//
// Every other test in this suite calls a library function directly. That
// proves the library works and proves nothing about the path the browser
// actually takes, which is where this build has repeatedly been wrong:
//
//   · buttons rendered with no click handler
//   · a route reporting a refusal as `{ok: true}`
//   · a module imported, tested, and never called
//   · `sendReadiness` reporting "connected" from an environment variable
//
// Not one of those is visible to a unit test, and all of them are obvious the
// first time a request goes end to end. So this runs the REAL `api/admin.js`
// and `api/collect.js` behind a real socket, with the real store and the real
// `public/` page in a real browser. The only things replaced are the ones that
// would otherwise leave this machine: the outbound provider call, which is a
// fixture, and nothing else.
//
// AUTH IS ENFORCED HERE, not open. Locally `CRON_SECRET` is usually unset and
// the gate runs in 'open' mode, which is the one posture production never has
// — so a test running that way proves the least useful thing it could.
process.env.CRON_SECRET = 'fullpath-test-secret';
process.env.OUTREACH_WEBHOOK_KEY = 'fullpath-webhook-key';

import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { startLocalApi, providerFixture } from './harness/local-api.mjs';

const SECRET = process.env.CRON_SECRET;

// This test CREATES CONTACTS and APPLIES SUPPRESSIONS through the real code
// paths. Against the in-memory dev store that is harmless and disappears with
// the process. Against a configured Upstash instance it would write a fake
// prospect and a fake spam complaint into whatever that instance is — which,
// for this project, could be the live one. So it refuses to run anywhere but
// memory, and says so rather than skipping quietly.
//
// The check reads the ENVIRONMENT rather than `store.backend`, because the
// store connects lazily: before the first call `backend` reports "memory" even
// when a real instance is configured, so asking it would pass the guard and
// then write to Upstash anyway. The condition is the same one store.js uses.
const configuredRemote =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (configuredRemote) {
  console.log('\nREFUSED: the full-path test writes contacts and applies suppressions through the real code paths,');
  console.log('and a remote store is configured in this environment. It runs against the in-memory store only.');
  console.log('Unset KV_REST_API_URL / KV_REST_API_TOKEN / UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN to run it.\n');
  console.log('0 passed, 1 failed');
  console.log('FAILED:');
  console.log(' - full-path test refused to run against a configured remote store');
  process.exit(1);
}
const chrome = [
  'C:/Users/mondo/.cache/puppeteer/chrome/win64-154.0.8037.57/chrome-win64/chrome.exe',
  'C:/Users/mondo/.cache/puppeteer/chrome/win64-146.0.7680.153/chrome-win64/chrome.exe',
].find((p) => fs.existsSync(p));

const PROSPECT = 'fullpath-prospect@example.invalid';
const api = await startLocalApi();
const sign = (rawBody) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${crypto.createHmac('sha256', process.env.OUTREACH_WEBHOOK_KEY).update(`${t}.${rawBody}`).digest('hex')}`;
};
// over node:http, not fetch — fetch keeps a connection pool that outlives the
// response and trips a libuv assertion when the process exits, and world.mjs
// replaces globalThis.fetch for the whole suite, so a test using it would be
// going through that stub to reach its own server
const post = (path, body, headers = {}) => api.post(path, body, headers);

// ---------------------------------------------------------------------------
section('F1  the gate is enforced over HTTP, not just in the function');
let r = await api.get(`/api/admin?do=contacts-list`);
let j = r.json || {};
check('an admin call with no secret is refused', r.status !== 200 || j.ok === false, `${r.status} ${JSON.stringify(j).slice(0, 80)}`);
check('and the refusal does not leak data', !JSON.stringify(j).includes('@'), JSON.stringify(j).slice(0, 100));

r = await api.get(`/api/admin?do=contacts-list&secret=wrong`);
j = r.json || {};
check('a wrong secret is refused too', j.ok === false, JSON.stringify(j).slice(0, 80));

r = await api.get(`/api/admin?do=contacts-list&secret=${SECRET}`);
j = r.json || {};
check('the right secret is accepted', j.ok === true, JSON.stringify(j).slice(0, 120));

// the two routes that are deliberately public must still work without it
j = (await api.get(`/api/admin?do=automation-status`)).json || {};
check('automation status stays readable without the password', j.ok === true);
check('because the Overview tile has to be honest before anyone unlocks', !!j.automation);

// THE POSTURE THAT IS NEVER TESTED LOCALLY: no secret at all.
// The auth module exists because five endpoints each used to fail OPEN when
// CRON_SECRET was missing — a typo or a fresh Vercel environment would have
// served client financials to anyone. Locally, missing means 'open' so that
// development works, so the dangerous case only appears when the process also
// looks deployed. That combination is what this runs.
{
  const savedSecret = process.env.CRON_SECRET;
  const savedVercel = process.env.VERCEL;
  delete process.env.CRON_SECRET;
  process.env.VERCEL = '1';
  const locked = await startLocalApi();
  const a = (await locked.get(`/api/admin?do=contacts-list`)).json || {};
  const b = (await locked.get(`/api/admin?do=contacts-list&secret=anything`)).json || {};
  const open = (await locked.get(`/api/admin?do=automation-status`)).json || {};
  await locked.stop();
  process.env.CRON_SECRET = savedSecret;
  if (savedVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = savedVercel;

  check('deployed with NO secret, an admin call is refused — not served', a.ok === false, JSON.stringify(a).slice(0, 120));
  check('and no guessed secret opens it either', b.ok === false, JSON.stringify(b).slice(0, 120));
  check('neither response leaks a contact', !JSON.stringify([a, b]).includes('@'));
  check('while the deliberately public route still answers', open.ok === true, JSON.stringify(open).slice(0, 80));
  check('and the admin gate is back to enforced afterwards',
    ((await api.get(`/api/admin?do=contacts-list&secret=${SECRET}`)).json || {}).ok === true);
}

// ---------------------------------------------------------------------------
section('F2  browser → API → storage');
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) pageErrors.push(m.text().slice(0, 160)); });

await page.goto(api.origin + '/', { waitUntil: 'networkidle2', timeout: 45000 });
await new Promise((res) => setTimeout(res, 1500));
check('the dashboard loaded from the same origin as the API', page.url().startsWith(api.origin));
check('and raised no page errors', pageErrors.length === 0, pageErrors.join(' | '));

// unlock exactly as a person does: type the password and press Unlock
const unlocked = await page.evaluate(async (secret) => {
  const input = document.querySelector('#unlock input[type="password"], #unlock input');
  const btn = [...document.querySelectorAll('#unlock button')].find((b) => /unlock/i.test(b.textContent));
  if (!input || !btn) return { typed: false };
  input.value = secret;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  btn.click();
  await new Promise((r) => setTimeout(r, 900));
  let stored = null;
  try { stored = localStorage.getItem('iw_secret'); } catch { /* blocked */ }
  return { typed: true, stored };
}, SECRET);
check('the password field and Unlock button exist on the page', unlocked.typed === true);
check('and unlocking stores the key the API will be called with', unlocked.stored === SECRET, String(unlocked.stored));

// now write through the page's own fetch, to the real route, into the real store
const created = await page.evaluate(async (email) => {
  const res = await fetch(`/api/admin?do=contacts-save&secret=${encodeURIComponent(localStorage.getItem('iw_secret'))}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contact: { name: 'Full Path Roofing', email, company: 'Full Path Roofing', source: 'r12.2 full-path test' },
    }),
  });
  return { status: res.status, body: await res.json() };
}, PROSPECT);
check('the browser created a contact through the real route', created.body && created.body.ok === true, JSON.stringify(created).slice(0, 200));

const emailOf = (c) => String((c && c.email && c.email.value) || (c && c.email) || '').toLowerCase();
const viaApi = (await api.get(`/api/admin?do=contacts-list&secret=${SECRET}`)).json || {};
const found = (viaApi.contacts || []).find((c) => emailOf(c) === PROSPECT);
check('and it is readable back through the API', !!found, `${(viaApi.contacts || []).length} contacts`);
check('the harness saw the browser make that call, not the test', api.called('contacts-save').length === 1,
  JSON.stringify(api.calls.map((c) => c.query && c.query.do).slice(-6)));

// ---------------------------------------------------------------------------
section('F3  → worker: the send gate refuses, and NOTHING reaches a provider');
// Outreach is deliberately inactive in this build, so the honest end-to-end
// statement is not "a message was sent" — it is "the gate refused and no
// outbound call happened". That second half is the one worth proving: a gate
// that refuses while something else still calls the provider is the failure
// mode, and it is invisible unless the transport is watched.
const fixture = providerFixture();
const { sendProspectEmail, sendReadiness } = await import('../lib/outreach-email.js');

const readiness = await sendReadiness({ env: {} });
const codes = readiness.blockers.map((b) => b.code);
check('with nothing configured, sending is not ready', readiness.ready === false);
// named individually, so removing any one of them is detected — asserting only
// `ready === false` passes while five of six guards are deleted
for (const code of ['no-credentials', 'no-sending-domain', 'no-pricing', 'outreach-off', 'no-public-url']) {
  check(`it names "${code}" as a blocker`, codes.includes(code), JSON.stringify(codes));
}
check('and every blocker is written in words, not a code alone', readiness.blockers.every((b) => b.text && b.text.length > 10));

const sent = await sendProspectEmail({
  contact: { id: found ? found.id : 'fullpath', email: { value: PROSPECT }, name: 'Full Path Roofing' },
  campaignId: 'fullpath',
  message: { subject: 'A quick question about your website', text: 'I built you a preview.', html: '<p>I built you a preview.</p>' },
  env: { RESEND_API_KEY: 'fixture-key', OUTREACH_FROM_DOMAIN: 'outreach.example.invalid', PUBLIC_BASE_URL: api.origin },
  fetchImpl: fixture.fetchImpl,
});
check('the send is refused', sent && sent.ok === false, JSON.stringify(sent).slice(0, 160));
check('as not-ready rather than an error', sent && sent.code === 'not-ready', String(sent && sent.code));
check('and it reports that nothing was sent', sent && sent.sent === false);
check('NO outbound call was made at all', fixture.sent.length === 0, JSON.stringify(fixture.sent.map((s) => s.url)));

// and the fixture itself has to work, or "nothing was sent" proves nothing —
// an always-empty recorder would pass the check above for ever
const proof = providerFixture();
await proof.fetchImpl('https://api.example.invalid/send', { body: JSON.stringify({ subject: 'proof' }) });
check('the fixture records a call when one is made', proof.sent.length === 1, JSON.stringify(proof.sent));
check('with the payload it was given', proof.sent[0] && proof.sent[0].payload.subject === 'proof', JSON.stringify(proof.sent[0]));
const failing = providerFixture({ failWith: { status: 502, message: 'provider down' } });
const bad = await failing.fetchImpl('https://api.example.invalid/send', { body: '{}' });
check('and it can be told to fail, for the paths that handle that', bad.ok === false && bad.status === 502);

// ---------------------------------------------------------------------------
section('F3b → worker → provider: the send leg, with the gate satisfied');
//
// NOTHING IS SENT TO ANYONE HERE, and that is worth being precise about rather
// than asserting as a slogan. Four things make it true, and each is checked:
//
//   1. The transport is the fixture. The real provider is never contacted,
//      because `fetchImpl` never reaches the network.
//   2. The recipient is a `.invalid` address. That TLD is reserved by RFC 2606
//      precisely so it can never resolve — even a bug that bypassed the
//      fixture would have nowhere to deliver.
//   3. The store is in-memory, enforced by the guard at the top of this file.
//   4. `outreach.active` is switched on INSIDE this section and switched back
//      off at the end, and the gate is asserted to refuse again afterwards.
//
// Why do it at all: until now the send leg was only ever exercised in the
// refusal direction, so "the gate refuses" was proven and "the path works when
// permitted" was not. Those are different claims, and a gate is only
// interesting if there is a path behind it that would otherwise run.
const { getSettings, saveSettings } = await import('../lib/settings.js');
const settingsBefore = await getSettings();
check('outreach starts OFF, as it has been for this whole build',
  settingsBefore.outreach.active === false, JSON.stringify(settingsBefore.outreach));

await saveSettings({
  pricing: { buildPrice: 2500, monthlyFee: 250 },
  targeting: { status: 'confirmed', source: 'confirmed for this test only' },
});
// the sender identity has its own writer — `saveSettings` deliberately does
// not merge it, which is why passing it there silently did nothing
const { saveSender } = await import('../lib/settings.js');
await saveSender({
  name: 'Test Owner',
  business: 'Inspiring Websites LLC',
  postalAddress: '1 Test Street, Plano TX 75001',
  replyTo: 'owner@outreach.example.invalid',
});
// `active` is deliberately not settable through saveSettings' merge, so it is
// written directly — which is itself the point: switching sending on is not
// something a patch can do by accident.
const liveSettings = JSON.parse(JSON.stringify(await getSettings()));
liveSettings.outreach = { active: true, reason: 'switched on inside one test section, against a fixture transport' };
await store.set('settings:business', JSON.stringify(liveSettings));

const liveEnv = {
  INSTANTLY_API_KEY: 'fixture-key-not-a-real-one',
  OUTREACH_FROM_DOMAIN: 'outreach.example.invalid',
  PUBLIC_BASE_URL: api.origin,
  UNSUBSCRIBE_SECRET: 'fullpath-unsub-secret',
};

const liveReadiness = await sendReadiness({ env: liveEnv });
check('with everything configured, sending is READY', liveReadiness.ready === true,
  JSON.stringify(liveReadiness.blockers.map((b) => b.code)));

// the message is built by the real composer, not hand-written
const { composeCold } = await import('../lib/campaigns.js');
const composed = await composeCold(
  {
    name: 'Full Path Roofing',
    contactName: 'Pat',
    email: PROSPECT,
    // the real constant, not a guess at its value — a wrong status makes the
    // composer refuse for a reason that has nothing to do with the send path
    web: { status: (await import('../lib/discovery.js')).WEB_STATUS.NOT_LINKED },
  },
  { owner: { name: 'Test Owner', business: 'Inspiring Websites LLC', postalAddress: '1 Test Street, Plano TX 75001' } }
);
check('the real composer produced a message', composed.ok !== false, JSON.stringify(composed).slice(0, 200));
check('it carries a subject', !!composed.subject, String(composed.subject));
check('and a body', !!composed.body, String(composed.body || '').slice(0, 80));

// CAN-SPAM, at the point the message is built: without a real name, business
// and postal address there is no lawful message to send, so the composer must
// refuse rather than leave the gate to catch it later
const noIdentity = await composeCold(
  { name: 'Full Path Roofing', contactName: 'Pat', email: PROSPECT,
    web: { status: (await import('../lib/discovery.js')).WEB_STATUS.NOT_LINKED } },
  { owner: { name: 'Test Owner', business: 'Inspiring Websites LLC' } } // no postal address
);
check('a message with no postal address is refused at composition', noIdentity.ok === false,
  JSON.stringify(noIdentity).slice(0, 160));
check('and the refusal says why', /postal address|CAN-SPAM/i.test(noIdentity.reason || ''), noIdentity.reason);
const noName = await composeCold(
  { name: 'Full Path Roofing', contactName: 'Pat', email: PROSPECT,
    web: { status: (await import('../lib/discovery.js')).WEB_STATUS.NOT_LINKED } },
  { owner: { business: 'Inspiring Websites LLC', postalAddress: '1 Test Street, Plano TX 75001' } }
);
check('and one with no sender name is refused too', noName.ok === false, JSON.stringify(noName).slice(0, 160));

const liveFixture = providerFixture();
const liveContact = { id: found ? found.id : 'fullpath-live', email: { value: PROSPECT }, business: 'Full Path Roofing' };
const sentLive = await sendProspectEmail({
  contact: liveContact,
  campaignId: 'fullpath-live',
  message: { subject: composed.subject, body: composed.body, html: composed.html || '' },
  env: liveEnv,
  fetchImpl: liveFixture.fetchImpl,
});

check('the send is PERMITTED and goes through', sentLive && sentLive.sent === true, JSON.stringify(sentLive).slice(0, 220));
check('exactly one outbound call was made', liveFixture.sent.length === 1, String(liveFixture.sent.length));
// every read of the recorded call is guarded: when the send is refused there is
// no call at all, and an unguarded `.payload` turns a clean failure into a
// crash that stops the rest of this file running
const call = liveFixture.sent[0] || null;
const payload = JSON.stringify((call && call.payload) || {});
check('it went to the provider adapter, not anywhere else', !!call && /instantly|example\.invalid/i.test(call.url),
  (call && call.url) || 'no call recorded');
check('addressed to the prospect', payload.includes(PROSPECT), payload.slice(0, 200));
check('the recipient is a .invalid address, which can never resolve', /\.invalid$/.test(PROSPECT), PROSPECT);
check('it carries a one-click unsubscribe header', /List-Unsubscribe/i.test(payload), payload.slice(0, 300));
check('with the one-click POST header Gmail and Yahoo require',
  /List-Unsubscribe-Post/i.test(payload), payload.slice(0, 300));
// the TEMPLATE VARIABLE as well as the header: the headers build their own URL,
// so checking only that the payload mentions this origin somewhere passes even
// when the link merged into the message body is empty
check('and the message body gets a usable unsubscribe link',
  new RegExp(`"unsubscribe_url":"${api.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]+"`).test(payload),
  payload.slice(0, 400));

// the attempt is on record, so a crash mid-send leaves evidence
const { getSendAttempt } = await import('../lib/outreach-email.js');
const attempt = await getSendAttempt(`fullpath-live:${liveContact.id}`);
check('the attempt was recorded', !!attempt, JSON.stringify(attempt));
check('and settled as confirmed rather than left in flight', !!attempt && attempt.state === 'confirmed', attempt && attempt.state);
// The record has to have been opened BEFORE the request, so a process killed
// mid-send leaves evidence that something may have gone out. The outcome write
// merges over whatever was there, so it alone would produce a record with no
// `contactId` — those fields exist only because the pre-write ran.
check('the record was opened before the request, not only after it',
  !!attempt && attempt.contactId === liveContact.id && attempt.campaignId === 'fullpath-live',
  JSON.stringify(attempt));

// sending the same campaign step again must not produce a second message
const secondTry = await sendProspectEmail({
  contact: liveContact,
  campaignId: 'fullpath-live',
  message: { subject: composed.subject, body: composed.body, html: composed.html || '' },
  env: liveEnv,
  fetchImpl: liveFixture.fetchImpl,
});
check('a repeat send is refused', secondTry && secondTry.sent !== true, JSON.stringify(secondTry).slice(0, 180));
check('and NO second outbound call was made', liveFixture.sent.length === 1, String(liveFixture.sent.length));

// --- switch it back off, and prove it ---------------------------------------
await store.set('settings:business', JSON.stringify(settingsBefore));
const settingsAfter = await getSettings();
check('outreach is switched back OFF', settingsAfter.outreach.active === false, JSON.stringify(settingsAfter.outreach));
const refusedAgain = await sendReadiness({ env: liveEnv });
check('and the gate refuses again', refusedAgain.ready === false,
  JSON.stringify(refusedAgain.blockers.map((b) => b.code)));
check('naming the outreach switch as the reason',
  refusedAgain.blockers.some((b) => b.code === 'outreach-off'),
  JSON.stringify(refusedAgain.blockers.map((b) => b.code)));

// ---------------------------------------------------------------------------
section('F4  → webhook: a complaint arrives and is applied');
// the signature is the only thing between a stranger and a record the owner
// acts on, so the unsigned case is tested first
const complaint = { id: 'fp-evt-1', type: 'complained', email: PROSPECT, at: Date.now() };
const raw = JSON.stringify(complaint);

let hook = await post('/api/collect?hook=delivery', raw);
check('an unsigned delivery webhook is refused', hook.status === 401, String(hook.status));

hook = await post('/api/collect?hook=delivery', raw, { 'x-webhook-signature': 't=1,v1=deadbeef' });
check('a stale or wrong signature is refused', hook.status === 401, String(hook.status));

hook = await post('/api/collect?hook=delivery', raw, { 'x-webhook-signature': sign(raw) });
let hookBody = hook.json || {};
check('a correctly signed complaint is accepted', hook.status === 200 && hookBody.ok === true, `${hook.status} ${JSON.stringify(hookBody)}`);

// storage: a complaint suppresses globally, because they did not complain
// about a campaign, they complained about us
const suppressed = await store.get(`suppress:email:${PROSPECT}`);
check('the address is now suppressed in the store', !!suppressed, String(suppressed));

// R9.9: and it landed in the day bucket the safety trip reads
const { windowTotals } = await import('../lib/deliverability.js');
const totals = await windowTotals({});
check('the complaint reached the deliverability window', totals.complained >= 1, JSON.stringify(totals));

// the same event again must not be applied twice
const before = Number(await store.get('delivery:count:complained').catch(() => 0)) || 0;
hook = await post('/api/collect?hook=delivery', raw, { 'x-webhook-signature': sign(raw) });
hookBody = hook.json || {};
const after = Number(await store.get('delivery:count:complained').catch(() => 0)) || 0;
check('a replayed webhook returns 200 so the provider stops retrying', hook.status === 200, String(hook.status));
check('but is NOT counted twice', after === before, `${before} -> ${after}`);

// WITH NO SIGNING KEY CONFIGURED, nothing from this provider can be trusted —
// the posture a fresh environment actually starts in, and the one where
// "verify the signature" silently becomes "accept everything" if it fails open.
{
  const savedKey = process.env.OUTREACH_WEBHOOK_KEY;
  delete process.env.OUTREACH_WEBHOOK_KEY;
  const unkeyed = await startLocalApi();
  const evt = JSON.stringify({ id: 'fp-evt-unkeyed', type: 'complained', email: 'unkeyed@example.invalid', at: Date.now() });
  const noKey = await unkeyed.post('/api/collect?hook=delivery', evt, {
    'x-webhook-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}`,
  });
  await unkeyed.stop();
  process.env.OUTREACH_WEBHOOK_KEY = savedKey;
  check('with no signing key configured, a webhook is refused', noKey.status === 401, String(noKey.status));
  check('and the address it named was NOT suppressed',
    !(await store.get('suppress:email:unkeyed@example.invalid')), 'an unverified payload must change nothing');
}

// SUPPRESS FIRST, RECORD SECOND. The code says the suppression is the part
// that must not be lost if the rest fails; that promise is only real if the
// address is still stopped when the contact lookup blows up.
{
  const victim = 'fullpath-partial@example.invalid';
  const contacts = await import('../lib/contacts.js');
  const realFind = contacts.findDuplicates;
  const { applyDeliveryEvent } = await import('../lib/outreach-email.js');
  // make everything after the suppression fail
  const realSmembers = store.smembers;
  store.smembers = async () => { throw new Error('store down'); };
  let out = null;
  try {
    out = await applyDeliveryEvent({ type: 'complained', email: victim, hard: true, at: Date.now() });
  } catch (e) {
    out = { threw: String(e.message) };
  }
  store.smembers = realSmembers;
  check('a complaint still suppresses the address when the record update fails',
    !!(await store.get(`suppress:email:${victim}`)), JSON.stringify(out).slice(0, 160));
  check('and the call did not throw out of the webhook', !out.threw, String(out.threw));
  await store.set(`suppress:email:${victim}`, '').catch(() => {});
  void realFind;
}

// ---------------------------------------------------------------------------
section('F5  → dashboard: the browser sees the consequence');
// the consequence that matters: this address can no longer be contacted
const { canContact } = await import('../lib/contacts.js');
const may = await canContact({ id: 'fullpath', email: { value: PROSPECT } }, { channel: 'email', purpose: 'promotional' });
check('the suppressed address is refused by the send gate', may.ok === false, JSON.stringify(may));
check('and the refusal says it was their choice', /opted out/i.test(may.reason || ''), may.reason);

// the real contact record, not a hand-built one, must be refused too — the
// suppression key is keyed on the ADDRESS so that a send check cannot miss it
// even when the contact record itself was never updated
const mayReal = found ? await canContact(found, { channel: 'email', purpose: 'promotional' }) : null;
check('the stored contact is refused as well', !!mayReal && mayReal.ok === false, JSON.stringify(mayReal));

// and the browser, through the real route, reads back the same address
const shown = await page.evaluate(async (email) => {
  const res = await fetch(`/api/admin?do=contacts-list&secret=${encodeURIComponent(localStorage.getItem('iw_secret'))}`);
  const body = await res.json();
  const c = (body.contacts || []).find((x) => String((x.email && x.email.value) || x.email || '').toLowerCase() === email);
  return {
    found: !!c,
    optedOutAt: c ? c.optedOutAt || null : null,
    reason: c ? c.suppressedReason || '' : '',
    withdrawn: !!(c && (c.consentLog || []).some((l) => l.withdrawn)),
  };
}, PROSPECT);
check('the browser can still read the contact', shown.found === true, JSON.stringify(shown).slice(0, 200));
check('and the record is marked opted out', !!shown.optedOutAt, JSON.stringify(shown));
check('with the provider event as the stated reason', /complained/.test(shown.reason), shown.reason);
check('and the withdrawal written into the consent log', shown.withdrawn === true, JSON.stringify(shown));

check('no page errors across the whole journey', pageErrors.length === 0, pageErrors.join(' | '));

// ---------------------------------------------------------------------------
section('F6  a handler that throws looks like a failure, not a refusal');
// the harness must not flatten a crash into a tidy {ok:false}: if it does,
// every future full-path test reads a 500 as a polite "no"
r = await api.get(`/api/admin?do=definitely-not-a-route&secret=${SECRET}`);
j = r.json || {};
check('an unknown action is refused, not silently ok', j.ok !== true, `${r.status} ${JSON.stringify(j).slice(0, 120)}`);
const threw = api.calls.filter((c) => c.threw);
check('nothing in this journey threw', threw.length === 0, JSON.stringify(threw.map((c) => `${c.query && c.query.do}: ${c.threw}`)));

// and the harness's own crash reporting, exercised on purpose. Without this,
// the catch block above never runs in any test, and a harness that turned a
// 500 into a tidy `{ok: false}` would let every future full-path test agree
// with a broken product while reporting green.
{
  const crashy = await startLocalApi({
    extraRoutes: { '/api/boom': async () => { throw new Error('deliberate crash'); } },
  });
  const boom = await crashy.post('/api/boom', {});
  const body = boom.json || {};
  const logged = crashy.calls.find((c) => c.path === '/api/boom');
  await crashy.stop();
  check('a handler that throws answers 500, not 200', boom.status === 500, String(boom.status));
  check('and does not look like a polite refusal', body.error === 'handler threw', JSON.stringify(body).slice(0, 120));
  check('the harness records that it threw', !!logged && !!logged.threw, JSON.stringify(logged));
  check('with the real message, not a summary', !!logged && /deliberate crash/.test(logged.threw), logged && logged.threw);
}

// ---------------------------------------------------------------------------
// clean up the fixtures this test created, so a later run starts where it meant to
await store.set(`suppress:email:${PROSPECT}`, '').catch(() => {});
await browser.close();
await api.stop();
done();
