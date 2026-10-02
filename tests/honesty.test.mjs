// R2.9 — no fake metrics, no invented integrations, unknown shown as unknown.
//
// Three concrete lies this build was capable of telling, each fixed and each
// guarded here:
//
//   1. The header badge rendered "✓ All system checks are fine" whenever the
//      health call FAILED. The most glanceable element on the page said the
//      opposite of the truth.
//   2. `sendReadiness()` reported `connected: !!env.INSTANTLY_API_KEY`. A key
//      that is revoked, mistyped or out of credit still read as connected.
//   3. Counts rendered from absent data as "0", which reads as a measurement
//      of nothing rather than an absence of measurement.
import fs from 'node:fs';
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  STATE, STATE_LABEL, INTEGRATIONS, isConfigured, statusOf, allStatuses,
  recordSuccess, recordFailure, withEvidence,
} from '../lib/integrations.js';
import { renderIntegrations, INTEGRATION_TONE } from '../public/acquisition.js';
import { sendReadiness } from '../lib/outreach-email.js';

const ENV = { INSTANTLY_API_KEY: 'k', GITHUB_TOKEN: 'g' };
const clear = async (n) => { await store.set(`integration:${n}`, '').catch(() => {}); };

// ---------------------------------------------------------------------------
section('H1  a credential is not a connection');
await clear('instantly');
let s = await statusOf('instantly', ENV);
check('a key with no history is "configured", not "working"', s.state === STATE.CONFIGURED, s.state);
check('and says plainly that this is not a claim it works', /not a claim that it works/.test(s.evidence), s.evidence);
check('no credential at all is its own state', (await statusOf('instantly', {})).state === STATE.NOT_CONFIGURED);
check('and names what is missing', /INSTANTLY_API_KEY/.test((await statusOf('instantly', {})).evidence));

await recordSuccess('instantly');
s = await statusOf('instantly', ENV);
check('a real successful call makes it "working"', s.state === STATE.WORKING, s.state);
check('and the evidence is a time, not an assertion', /a real call succeeded/.test(s.evidence));

await recordFailure('instantly', 'http 401 unauthorized');
s = await statusOf('instantly', ENV);
check('a rejected key is "failing", even though the key is still set', s.state === STATE.FAILING, s.state);
check('the provider error is kept, because it is usually the fix', /401/.test(s.lastError), s.lastError);
check('and the credential is still reported as present', s.configured === true);

// the ordering bug this module had: a success and a failure in the same ms
await clear('github');
const T = 1770000000000;
await recordSuccess('github', { at: T });
await recordFailure('github', 'boom', { at: T });
check('a failure in the SAME millisecond as a success still wins', (await statusOf('github', ENV)).state === STATE.FAILING,
  JSON.stringify(await statusOf('github', ENV)));
await recordSuccess('github', { at: T });
check('and a later success flips it back', (await statusOf('github', ENV)).state === STATE.WORKING);

check('every state has words a person can read', Object.values(STATE).every((v) => !!STATE_LABEL[v]));
check('and none of those words is just "connected"', !Object.values(STATE_LABEL).includes('connected'));

// ---------------------------------------------------------------------------
section('H2  nothing upgrades itself by assertion');
await clear('resend');
check('isConfigured only reads the environment', isConfigured('resend', { RESEND_API_KEY: 'x', REPORT_FROM: 'y' }) === true);
check('a partial credential is not configured', isConfigured('resend', { RESEND_API_KEY: 'x' }) === false);
check('an unknown integration is refused, not invented', (await recordSuccess('not-a-thing')).ok === false);
check('and has no status', (await statusOf('not-a-thing', ENV)).state === STATE.NOT_CONFIGURED);

// withEvidence records what actually happened
await clear('instantly');
await withEvidence('instantly', async () => ({ ok: true }));
check('a successful wrapped call records success', (await statusOf('instantly', ENV)).state === STATE.WORKING);
await withEvidence('instantly', async () => ({ ok: false, error: 'no credit' }));
check('a call that returns ok:false counts as a failure, not a success', (await statusOf('instantly', ENV)).state === STATE.FAILING);
check('and the reason is kept', /no credit/.test((await statusOf('instantly', ENV)).lastError));
let threw = false;
try { await withEvidence('instantly', async () => { throw new Error('socket hang up'); }); } catch { threw = true; }
check('a throwing call is recorded and rethrown', threw && /socket hang up/.test((await statusOf('instantly', ENV)).lastError));

// an unreadable record must not read as healthy
const realGet = store.get;
store.get = async (k) => { if (String(k).startsWith('integration:')) throw new Error('store down'); return realGet.call(store, k); };
s = await statusOf('instantly', ENV);
check('an unreadable history does not report "working"', s.state !== STATE.WORKING, s.state);
check('it falls back to "configured" and says the history is unknown', s.state === STATE.CONFIGURED && /could not be read/.test(s.evidence), s.evidence);
store.get = realGet;

// ---------------------------------------------------------------------------
section('H3  the sending screen stops claiming a connection it has not proven');
await clear('instantly');
let rd = await sendReadiness({ env: { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'o.test' } });
check('a key alone does not read as connected', rd.connected === false, JSON.stringify({ c: rd.connected, d: rd.displayStatus }));
check('the credential is still reported separately', rd.credentialPresent === true);
check('and the screen says "key set, never confirmed"', rd.displayStatus === 'key set, never confirmed', rd.displayStatus);
await recordSuccess('instantly');
rd = await sendReadiness({ env: { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'o.test' } });
check('only a proven call turns it into "confirmed working"', rd.connected === true && /confirmed working/.test(rd.displayStatus), rd.displayStatus);

// ---------------------------------------------------------------------------
section('H4  the integrations panel shows evidence, not configuration');
const list = [
  { name: 'github', label: 'GitHub', what: 'Ships code.', state: 'working', evidence: 'a real call succeeded 2 minutes ago' },
  { name: 'instantly', label: 'Cold email', what: 'Sends outreach.', state: 'configured', evidence: 'the credential is set, but nothing has used it yet' },
  { name: 'twilio', label: 'Text messages', what: 'Alerts you.', state: 'not-configured', evidence: 'missing TWILIO_ACCOUNT_SID' },
  { name: 'resend', label: 'Email', what: 'Client reports.', state: 'failing', evidence: 'last call failed: http 403' },
];
let html = renderIntegrations(list);
check('each state is said in words', /confirmed working/.test(html) && /set up, never confirmed/.test(html) && /not set up/.test(html) && /failing/.test(html));
check('the unproven one is counted at the top', /1 integration has a credential but no proof/.test(html), html.slice(0, 200));
check('and the warning explains why that matters', /A key can be set and still be wrong/.test(html));
check('the evidence line is shown, not the config', /a real call succeeded 2 minutes ago/.test(html));
check('with everything proven the header says what the lines mean', /what the last real call to that service proved/.test(renderIntegrations([list[0]])));
check('not-loaded is a spinner, not an empty list', /Checking what is actually connected/.test(renderIntegrations(null)));
html = renderIntegrations(null, 'the admin call failed');
check('a failed read says so', /Could not read the integration status/.test(html));
check('and tells the owner to treat them as unknown', /Treat every one of them as unknown/.test(html));
check('explicitly not as working', /not a report that they are working/.test(html));
check('every state has a tone', Object.values(STATE).every((v) => !!INTEGRATION_TONE[v]));

// ---------------------------------------------------------------------------
section('H5  the header badge cannot say "fine" when it does not know');
// This was the sharpest one: renderSysHealth set the badge to ✓ whenever the
// health call failed. Asserted on the page source because the badge lives in
// the inline script; the browser check in VERIFICATION_REPORT.md is the
// behavioural half.
const page = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const fn = page.slice(page.indexOf('function renderSysHealth'), page.indexOf('function renderSysHealth') + 1400);
check('the badge distinguishes "answered" from "no issues"', /const answered = !!\(h && h\.ok\)/.test(fn), fn.slice(0, 200));
check('an unanswered check renders a question, not a tick', /badge\.textContent='\?'/.test(fn));
check('and the tooltip says it is not an all-clear', /this is not an all-clear/i.test(fn));
const panelFn = page.slice(page.indexOf('function renderSysPanel'), page.indexOf('function renderSysPanel') + 1200);
check('the panel says the checks could not run', /These checks could not run/.test(panelFn));
check('and that nothing was verified', /Nothing here has been verified/.test(panelFn));

// ---------------------------------------------------------------------------
section('H6  every integration the app has is described');
check('the table is not empty', Object.keys(INTEGRATIONS).length >= 7, String(Object.keys(INTEGRATIONS).length));
for (const [name, spec] of Object.entries(INTEGRATIONS)) {
  check(`${name} says what it is for`, !!spec.what && spec.what.length > 15, spec.what);
  check(`${name} names the credentials it needs`, Array.isArray(spec.env) && spec.env.length > 0);
}
const all = await allStatuses({}, Date.now());
check('with no environment at all, nothing claims to work', all.every((i) => i.state === STATE.NOT_CONFIGURED),
  all.filter((i) => i.state !== STATE.NOT_CONFIGURED).map((i) => `${i.name}:${i.state}`).join(','));

await clear('instantly'); await clear('github');
done();
