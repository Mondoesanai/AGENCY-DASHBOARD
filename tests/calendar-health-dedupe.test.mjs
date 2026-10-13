// The Calendar health check runs every ten minutes. Prove it cannot flood.
//
// R22.2. A finding that is true until an owner acts is true on every sweep, and
// the sweep runs six times an hour. That is exactly the shape that produced ~40
// emails from one held revision ticket, so a NEW always-true finding —
// "the Google grant is missing a scope" — has to be proven quiet before it
// ships, not reasoned about.
//
// The askOwner flood also looked fine in its own comment ("so it won't loop").
// This file counts actual notifications instead.

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { recover, RE_ESCALATE_AFTER_MS } from '../lib/recovery.js';

// A grant that is valid but narrow — exactly the live situation.
const NARROW = 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.modify';

const ENV = {
  GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'x', GOOGLE_REFRESH_TOKEN: 'x',
  VERCEL_ENV: 'production',
};

const realFetch = globalThis.fetch;
function stubGoogle(scope) {
  globalThis.fetch = async (url) => {
    if (String(url).includes('oauth2.googleapis.com/token')) {
      const body = { access_token: 'fake', expires_in: 3600, scope };
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
    }
    // Anything else the sweep reaches for (the lead-form probe) is refused
    // cleanly so this test measures the Calendar finding alone.
    return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
  };
}

// Count every owner notification the sweep sends.
let notes = [];
const notify = async (t) => { notes.push(String(t)); };

// ---------------------------------------------------------------------------
section('H1  six sweeps in an hour send ONE notification');
await store.del('recovery:escalated:google-scopes-missing').catch(() => {});
stubGoogle(NARROW);
notes = [];
const t0 = Date.now();
for (let i = 0; i < 6; i++) await recover({ now: t0 + i * 10 * 60 * 1000, notify, env: ENV });
const scopeNotes = notes.filter((n) => /scope/i.test(n));
check('the sweep raises it exactly once', scopeNotes.length === 1,
  `${scopeNotes.length} notifications from 6 sweeps`);
check('and the one it sent names the fix',
  /calendar\.freebusy/.test(scopeNotes[0] || ''), (scopeNotes[0] || '').slice(0, 150));
check('it says what is broken in plain words',
  /booking form|free\/busy/i.test(scopeNotes[0] || ''), (scopeNotes[0] || '').slice(0, 120));

section('H1b  a whole day of sweeps is still one notification');
notes = [];
for (let i = 0; i < 24 * 6; i++) await recover({ now: t0 + i * 10 * 60 * 1000, notify, env: ENV });
check('144 sweeps, no repeat', notes.filter((n) => /scope/i.test(n)).length === 0,
  'the first hour already raised it; a day of sweeps inside the window adds nothing');

section('H2  after a day with no action, it speaks once more');
notes = [];
await recover({ now: t0 + RE_ESCALATE_AFTER_MS + 60000, notify, env: ENV });
check('it is raised again after the window', notes.filter((n) => /scope/i.test(n)).length === 1,
  'a problem nobody has touched in 24 hours is worth one more mention — but only one');
notes = [];
for (let i = 1; i <= 6; i++) await recover({ now: t0 + RE_ESCALATE_AFTER_MS + 60000 + i * 10 * 60 * 1000, notify, env: ENV });
check('and then goes quiet again', notes.filter((n) => /scope/i.test(n)).length === 0);

// ---------------------------------------------------------------------------
section('H3  once the scope is granted, it stops entirely');
await store.del('recovery:escalated:google-scopes-missing').catch(() => {});
stubGoogle(`${NARROW} https://www.googleapis.com/auth/calendar.freebusy`);
notes = [];
for (let i = 0; i < 6; i++) await recover({ now: t0 + i * 10 * 60 * 1000, notify, env: ENV });
check('a complete grant raises nothing at all', notes.filter((n) => /scope/i.test(n)).length === 0,
  'the finding must disappear on its own once the owner acts, with nothing to clear by hand');

section('H3b  NEGATIVE CONTROL: it does fire for a genuinely narrow grant');
// Without this, H3 would pass against a check that never fires for anyone.
await store.del('recovery:escalated:google-scopes-missing').catch(() => {});
stubGoogle(NARROW);
notes = [];
await recover({ now: t0, notify, env: ENV });
check('a narrow grant is still reported', notes.filter((n) => /scope/i.test(n)).length === 1,
  'so H3 means "fixed", not "never checks"');

// ---------------------------------------------------------------------------
section('H4  a REVOKED credential is a different alert, not the same one');
await store.del('recovery:escalated:google-token-rejected').catch(() => {});
globalThis.fetch = async (url) => {
  if (String(url).includes('oauth2.googleapis.com/token')) {
    const b = { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' };
    return { ok: false, status: 400, json: async () => b, text: async () => JSON.stringify(b) };
  }
  return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
};
notes = [];
for (let i = 0; i < 6; i++) await recover({ now: t0 + i * 10 * 60 * 1000, notify, env: ENV });
const revoked = notes.filter((n) => /refus|revok|credential/i.test(n));
check('a revoked grant is raised once, not six times', revoked.length === 1, `${revoked.length}`);
check('and it is not confused with the scope problem',
  !/calendar\.freebusy/.test(revoked[0] || ''),
  'a revoked credential and a narrow one have different fixes');

section('H5  no Google credentials at all is not an incident');
notes = [];
await recover({ now: t0, notify, env: { VERCEL_ENV: 'production' } });
check('a deployment not using Google says nothing',
  notes.filter((n) => /scope|credential/i.test(n)).length === 0,
  'not configured is not broken');

globalThis.fetch = realFetch;
done();
