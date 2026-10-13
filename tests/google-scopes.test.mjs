// The booking form was down for a scope nobody had written down.
//
// R21.6. The live grant held exactly two scopes — `calendar.events` and
// `gmail.modify` — and `freeBusy.query` needs `calendar` or `calendar.readonly`.
// So every visitor to the booking form was told "online booking is not
// available", correctly, for ever: the adapter fails closed, which is right for
// a visitor and silent for the owner.
//
// Two things were missing, and both are here. The repository recorded NO scopes
// at all, so re-authorising meant guessing; and nothing checked the grant, so
// the outage reported itself nowhere.

import { check, section, done } from './world.mjs';
import { REQUIRED_SCOPES, missingScopes, missingCapabilities, GOOGLE_CAPABILITIES } from '../lib/google.js';

const CAL_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const CAL_READ = 'https://www.googleapis.com/auth/calendar.readonly';
const CAL_FREEBUSY = 'https://www.googleapis.com/auth/calendar.freebusy';
const CAL_EV_FREEBUSY = 'https://www.googleapis.com/auth/calendar.events.freebusy';
const CAL_FULL = 'https://www.googleapis.com/auth/calendar';
const GMAIL_MOD = 'https://www.googleapis.com/auth/gmail.modify';
const MAIL_ALL = 'https://mail.google.com/';

// ---------------------------------------------------------------------------
section('G1  the scopes are written down, derived from the calls');
check('three are required', REQUIRED_SCOPES.length === 3, REQUIRED_SCOPES.join(' '));
check('calendar.events, for creating the appointment', REQUIRED_SCOPES.includes(CAL_EVENTS));
check('calendar.freebusy, for reading free/busy', REQUIRED_SCOPES.includes(CAL_FREEBUSY),
  'the capability the live grant lacked');
check('and NOT calendar.readonly, which was the first answer and too broad',
  !REQUIRED_SCOPES.includes(CAL_READ),
  'checked against Google discovery: freebusy unlocks 1 method, readonly unlocks 15');
check('gmail.modify, for the revision inbox and sending', REQUIRED_SCOPES.includes(GMAIL_MOD));
check('and no scope wider than needed is asked for',
  !REQUIRED_SCOPES.includes(CAL_FULL) && !REQUIRED_SCOPES.includes(MAIL_ALL),
  'full calendar also grants deleting and sharing calendars, which this app never does');

section('G2  the live grant, as it actually was');
const LIVE = `${CAL_EVENTS} ${GMAIL_MOD}`;
const missing = missingScopes(LIVE);
check('exactly one scope is missing', missing.length === 1, missing.join(','));
check('and the fix is calendar.freebusy', missing[0] === CAL_FREEBUSY, missing[0]);
check('so events could still be created', !missing.includes(CAL_EVENTS),
  'which is why the revision inbox and calendar invites kept working while booking did not');
check('and Gmail was never affected', !missing.includes(GMAIL_MOD));

section('G2b  adding that one scope is enough');
check('nothing missing once calendar.readonly is granted',
  missingScopes(`${LIVE} ${CAL_READ}`).length === 0);

section('G2c  every scope Google accepts for free/busy satisfies us');
// freebusy.query accepts four scopes of very different reach. A grant holding
// any of them is complete, so nobody is told to re-authorise for nothing.
for (const [label, sc] of [['calendar.freebusy', CAL_FREEBUSY], ['calendar.events.freebusy', CAL_EV_FREEBUSY], ['calendar.readonly', CAL_READ], ['calendar (full)', CAL_FULL]]) {
  check(`a grant with ${label} is complete`, missingScopes(`${CAL_EVENTS} ${GMAIL_MOD} ${sc}`).length === 0);
}
check('but calendar.events alone is NOT enough',
  missingScopes(`${CAL_EVENTS} ${GMAIL_MOD}`).length === 1,
  'events does not grant free/busy — that is the whole outage');

section('G2d  the recommendation is the narrowest that works');
check('we ask for the 1-method scope, not the 15-method one',
  REQUIRED_SCOPES.includes(CAL_FREEBUSY) && !REQUIRED_SCOPES.includes(CAL_READ));
check('and the capability says what it is for, not just a URL',
  missingCapabilities(`${CAL_EVENTS} ${GMAIL_MOD}`)[0].what.includes('booking'),
  JSON.stringify(missingCapabilities(`${CAL_EVENTS} ${GMAIL_MOD}`)[0]));

section('G3  supersets are understood, not demanded');
check('full calendar covers both calendar scopes',
  missingScopes(`${CAL_FULL} ${GMAIL_MOD}`).length === 0,
  'a grant that already has it must not be told to re-authorise for nothing');
check('mail.google.com covers gmail.modify',
  missingScopes(`${CAL_FULL} ${MAIL_ALL}`).length === 0);

section('G3b  an empty or unknown grant reports everything');
check('no scopes means all three missing', missingScopes('').length === 3);
check('undefined is handled', missingScopes(undefined).length === 3);
check('an unrelated scope grants nothing',
  missingScopes('https://www.googleapis.com/auth/drive.readonly').length === 3);

// ---------------------------------------------------------------------------
section('G4  the system reports this itself');
import { readFile } from 'node:fs/promises';
const rec = await readFile(new URL('../lib/recovery.js', import.meta.url), 'utf8');
check('the sweep checks the grant', /missingCapabilities\(j\.scope\)/.test(rec), 'lib/recovery.js');
check('and names the exact scopes to add',
  /GOOGLE_REFRESH_TOKEN: \$\{missing\.join/.test(rec));
check('while telling the owner to KEEP what they already have',
  /Keep the scopes already granted/.test(rec),
  'dropping calendar.events or gmail.modify would break appointments or the revision inbox');
check('the headline names the broken CAPABILITY, not a scope URL',
  /The Google grant cannot: \$\{missingCaps\.map/.test(rec),
  'an earlier version hardcoded "without calendar.readonly" and then contradicted its own advice once the recommendation narrowed to calendar.freebusy');
check('it explains the consequence in plain words',
  /told online booking is unavailable/.test(rec),
  'a scope string alone does not tell the owner what is broken');
check('a rejected grant is reported separately from a narrow one',
  /google-token-rejected/.test(rec) && /google-scopes-missing/.test(rec),
  'a revoked credential and an under-scoped one have different fixes');
check('a missing scope is CONFIG, not an outage to retry',
  /google-scopes-missing', SEVERITY\.CONFIG/.test(rec),
  'no amount of retrying grants a scope');
check('and the check cannot break the sweep',
  /try \{[\s\S]{0,2600}missingCapabilities[\s\S]{0,1600}\} catch/.test(rec));
check('it only runs when credentials exist',
  /env\.GOOGLE_CLIENT_ID && env\.GOOGLE_CLIENT_SECRET && env\.GOOGLE_REFRESH_TOKEN/.test(rec),
  'a deployment with no Google set up is not misconfigured, it is just not using it');

section('G5  the owner can ask directly, without waiting for the sweep');
const admin = await readFile(new URL('../api/admin.js', import.meta.url), 'utf8');
check('there is an endpoint for it', /case 'google-scopes'/.test(admin), 'api/admin.js');
check('it reports capabilities in words', /capabilities: GOOGLE_CAPABILITIES\.map/.test(admin));
check('and the bare list to paste into the consent screen',
  /addScopes: error \? null : missingScopes\(granted\)/.test(admin));
check('it never returns the token itself',
  !/refresh_token:\s*j\./.test(admin) && !/GOOGLE_REFRESH_TOKEN[^)]*res\.status/.test(admin),
  'a scope list is a capability description; the credential is not');
check('and it is behind the password',
  admin.indexOf("case 'google-scopes'") > admin.indexOf('if (!authed(req)) return res.status(401)'),
  'it names what the account can do, which is not public information');

done();
