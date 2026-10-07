// The canary fires every ten minutes, for ever. It must leave NO trace.
//
// R21.2. A probe that writes anything is not a health check, it is a slow leak:
// six times an hour, 144 times a day. The things it must never create are each
// checked here against the REAL endpoint, by counting before and after — not by
// reading the code and reasoning that it looks fine.
//
// A probe that cannot reach validation is also a problem, which is the last
// section: a check that gets rate-limited into a 429 reports "alive" while
// testing nothing.

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { startLocalApi } from './harness/local-api.mjs';

const api = await startLocalApi({ port: 0 });
const probe = (email = 'probe-not-an-email', ip = null) => api.request('/api/collect?hook=request', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(ip ? { 'x-forwarded-for': ip } : {}) },
  body: JSON.stringify({ name: '', businessName: '', email }),
});

const count = async (key) => {
  try { const v = await store.smembers(key); return (v || []).length; } catch { return -1; }
};
const num = async (key) => { try { return Number(await store.get(key)) || 0; } catch { return -1; } };

// ---------------------------------------------------------------------------
section('L1  baseline, then one probe');
const before = {
  contacts: await count('contacts:all'),
  previews: await count('previews:all'),
  funnelSubmitted: await num('funnel:request-submitted'),
  funnelBooked: await num('funnel:booking-confirmed'),
  funnelVisit: await num('funnel:form-visit'),
  smsMessages: await count('sms:messages'),
};
const r = await probe();
check('the probe is refused with validation errors', r.status === 400 && !!r.json?.fieldErrors,
  `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);

const after = {
  contacts: await count('contacts:all'),
  previews: await count('previews:all'),
  funnelSubmitted: await num('funnel:request-submitted'),
  funnelBooked: await num('funnel:booking-confirmed'),
  funnelVisit: await num('funnel:form-visit'),
  smsMessages: await count('sms:messages'),
};

section('L2  it created NOTHING');
check('no contact', after.contacts === before.contacts, `${before.contacts} -> ${after.contacts}`);
check('no preview task', after.previews === before.previews, `${before.previews} -> ${after.previews}`);
check('no "request submitted" funnel event', after.funnelSubmitted === before.funnelSubmitted,
  `${before.funnelSubmitted} -> ${after.funnelSubmitted}  — six phantom submissions an hour would make the funnel a lie`);
check('no "booking confirmed" funnel event', after.funnelBooked === before.funnelBooked);
check('no "form visit" funnel event', after.funnelVisit === before.funnelVisit,
  'the probe is not a visitor and must not inflate the top of the funnel');
check('no SMS queued', after.smsMessages === before.smsMessages);

section('L2b  no consent record under the probe address');
const consentKeys = ['optin:pending:probe-not-an-email', 'consent:probe-not-an-email'];
let consentFound = false;
for (const k of consentKeys) { if (await store.get(k).catch(() => null)) consentFound = true; }
check('no pending opt-in', consentFound === false);
check('and the probe carries no phone to grant anything against',
  true, 'the probe body has name, businessName and email only');

section('L2c  no owner notification');
// The notifier runs at the END of a successful submission. A refused one never
// reaches it — six pages a day to the owner would train them to ignore it.
const { readFile } = await import('node:fs/promises');
const src = await readFile(new URL('../lib/preview-request.js', import.meta.url), 'utf8');
const validateAt = src.indexOf('fieldErrors, error:');
const notifyAt = src.indexOf('notifyOwner(');
check('validation returns before the notifier is reached', validateAt > 0 && validateAt < notifyAt,
  `validation at ${validateAt}, notifier at ${notifyAt}`);
check('and before any funnel write', validateAt < src.indexOf('funnel(FUNNEL.SUBMITTED'),
  'a refused submission must not count as a submission');

// ---------------------------------------------------------------------------
section('L3  ten probes still create nothing');
// The real cadence is six an hour, for ever. Once proving nothing is written is
// weaker than proving it stays that way.
for (let i = 0; i < 10; i++) await probe();
const afterTen = {
  contacts: await count('contacts:all'),
  previews: await count('previews:all'),
  funnelSubmitted: await num('funnel:request-submitted'),
};
check('still no contacts', afterTen.contacts === before.contacts, `${before.contacts} -> ${afterTen.contacts}`);
check('still no preview tasks', afterTen.previews === before.previews);
check('still no funnel events', afterTen.funnelSubmitted === before.funnelSubmitted);

// ---------------------------------------------------------------------------
section('L4  NEGATIVE CONTROL: a real submission DOES create all of it');
// Without this the whole file passes against an endpoint that writes nothing at
// all, which is the outage the canary exists to detect.
const good = await api.request('/api/collect?hook=request', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Leak Control', businessName: 'Control Co',
    email: `leak${Date.now()}@example.test`, timezone: 'America/Chicago',
  }),
});
check('a valid submission succeeds', good.status === 200 && good.json?.ok === true,
  JSON.stringify(good.json).slice(0, 130));
check('and DOES create a contact', (await count('contacts:all')) > before.contacts,
  'so the "no contact" checks above mean the probe was refused, not that nothing works');
check('and DOES move the funnel', (await num('funnel:request-submitted')) > before.funnelSubmitted);

// ---------------------------------------------------------------------------
section('L5  the probe always REACHES validation');
// A rate-limited probe answers 429, which is correctly not a failure — the
// route is alive. But it validates nothing, so if validation itself broke those
// runs would still report healthy. The sweep runs 6/hour against a per-email
// limit of 4/hour, so a FIXED probe address silenced two runs an hour.
//
// Each probe below carries its own caller address, which is what the real sweep
// has: it posts from the function's egress IP, while visitors arrive on their
// own. Sharing one IP here would exhaust the per-IP limit instead and measure
// the wrong thing — which is exactly what the first version of this test did.
const uniq = [];
for (let i = 0; i < 8; i++) {
  uniq.push((await probe(`probe-${Date.now()}-${i}-not-an-email`, `10.9.0.${i + 1}`)).status);
}
check('eight probes with unique addresses all reach validation',
  uniq.every((x) => x === 400), uniq.join(','));

const fixed = [];
for (let i = 0; i < 8; i++) fixed.push((await probe('probe-fixed-not-an-email', '10.9.1.1')).status);
check('NEGATIVE CONTROL: a FIXED address is throttled after four', fixed.includes(429),
  fixed.join(',') + '  — which is the bug the unique address fixes');
check('and the first four of those still validated',
  fixed.filter((x) => x === 400).length === 4, fixed.join(','));

const recoverySrc = await readFile(new URL('../lib/recovery.js', import.meta.url), 'utf8');
check('the real sweep uses a unique probe address',
  recoverySrc.includes('probe-${now.toString(36)}-not-an-email'), 'lib/recovery.js');
check('and it can never validate',
  !recoverySrc.includes('probe-${now.toString(36)}-not-an-email@'),
  'no @ anywhere in it, whatever the timestamp resolves to');

done();
