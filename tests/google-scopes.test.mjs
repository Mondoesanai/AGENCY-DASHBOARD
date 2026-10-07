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
import { REQUIRED_SCOPES, missingScopes } from '../lib/google.js';

const CAL_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const CAL_READ = 'https://www.googleapis.com/auth/calendar.readonly';
const CAL_FULL = 'https://www.googleapis.com/auth/calendar';
const GMAIL_MOD = 'https://www.googleapis.com/auth/gmail.modify';
const MAIL_ALL = 'https://mail.google.com/';

// ---------------------------------------------------------------------------
section('G1  the scopes are written down, derived from the calls');
check('three are required', REQUIRED_SCOPES.length === 3, REQUIRED_SCOPES.join(' '));
check('calendar.events, for creating the appointment', REQUIRED_SCOPES.includes(CAL_EVENTS));
check('calendar.readonly, for reading free/busy', REQUIRED_SCOPES.includes(CAL_READ),
  'this is the one the live grant lacked');
check('gmail.modify, for the revision inbox and sending', REQUIRED_SCOPES.includes(GMAIL_MOD));
check('and no scope wider than needed is asked for',
  !REQUIRED_SCOPES.includes(CAL_FULL) && !REQUIRED_SCOPES.includes(MAIL_ALL),
  'full calendar also grants deleting and sharing calendars, which this app never does');

section('G2  the live grant, as it actually was');
const LIVE = `${CAL_EVENTS} ${GMAIL_MOD}`;
const missing = missingScopes(LIVE);
check('exactly one scope is missing', missing.length === 1, missing.join(','));
check('and it is calendar.readonly', missing[0] === CAL_READ, missing[0]);
check('so events could still be created', !missing.includes(CAL_EVENTS),
  'which is why the revision inbox and calendar invites kept working while booking did not');
check('and Gmail was never affected', !missing.includes(GMAIL_MOD));

section('G2b  adding that one scope is enough');
check('nothing missing once calendar.readonly is granted',
  missingScopes(`${LIVE} ${CAL_READ}`).length === 0);

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
check('the sweep checks the grant', /missingScopes\(j\.scope\)/.test(rec), 'lib/recovery.js');
check('and names the exact scopes to add',
  /Re-authorise with these added and replace GOOGLE_REFRESH_TOKEN: \$\{missing\.join/.test(rec));
check('it explains the consequence in plain words',
  /every visitor is told online booking is unavailable/.test(rec),
  'a scope string alone does not tell the owner what is broken');
check('a rejected grant is reported separately from a narrow one',
  /google-token-rejected/.test(rec) && /google-scopes-missing/.test(rec),
  'a revoked credential and an under-scoped one have different fixes');
check('a missing scope is CONFIG, not an outage to retry',
  /google-scopes-missing', SEVERITY\.CONFIG/.test(rec),
  'no amount of retrying grants a scope');
check('and the check cannot break the sweep',
  /try \{[\s\S]{0,2600}missingScopes[\s\S]{0,900}\} catch/.test(rec));
check('it only runs when credentials exist',
  /env\.GOOGLE_CLIENT_ID && env\.GOOGLE_CLIENT_SECRET && env\.GOOGLE_REFRESH_TOKEN/.test(rec),
  'a deployment with no Google set up is not misconfigured, it is just not using it');

done();
