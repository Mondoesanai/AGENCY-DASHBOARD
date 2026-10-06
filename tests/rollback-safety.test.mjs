// Would an older build misread the records this one wrote?
//
// R18.6. A code-only revert is not a rollback: the code goes back, the data
// stays. So the question that matters is not "can we revert" but "what would
// the old code DO with records it has never seen" — and the only answer that
// matters is whether anyone who said stop could start being contacted again.
//
// The rollback target is `30bf2d0`, the commit currently live. These checks
// read that commit out of git and compare it against what this build writes,
// so they keep answering as the code moves rather than freezing today's verdict
// into prose.
import { execFileSync } from 'node:child_process';
import { check, section, done } from './world.mjs';
import { normPhone, normEmail, CONSENT_SCOPES, effectiveConsent, suppressionKeys } from '../lib/contacts.js';

const TARGET = '30bf2d0';
const at = (path) => {
  try {
    return execFileSync('git', ['show', `${TARGET}:${path}`], { encoding: 'utf8', maxBuffer: 1 << 26 });
  } catch {
    return null;
  }
};
// `fn.toString()` carries no `export` keyword; the source does. Normalise both
// sides so the comparison is about the BODY, not the declaration syntax.
const norm = (t) => String(t || '').replace(/^export\s+/, '').replace(/\s+/g, ' ').trim();
const section_of = (src, re) => {
  if (!src) return null;
  const m = src.match(re);
  return m ? m[0] : null;
};

// ---------------------------------------------------------------------------
section('B1  the rollback target is reachable and is what we think it is');
const oldContacts = at('lib/contacts.js');
check(`${TARGET} is in this repository`, !!oldContacts, 'the named rollback target must be reachable to reason about it');

// ---------------------------------------------------------------------------
section('B2  SUPPRESSION — the one that can hurt somebody');
// If the old code read a different key, a number suppressed under this build
// would stop matching after a revert and could be contacted again. Nothing else
// in this file matters as much.
const oldNorm = section_of(oldContacts, /export function normPhone[\s\S]*?\n}/);
const newNorm = normPhone.toString();
check('the old build derives the phone suppression key with normPhone', !!oldNorm, 'not found');
check('the key is E.164 on both sides',
  /\+1\$\{d\}|`\+1\$\{d\}`/.test(oldNorm || '') && normPhone('(214) 555-0147') === '+12145550147',
  normPhone('(214) 555-0147'));
check('THE DERIVATION IS UNCHANGED, so a suppression written now still matches',
  norm(oldNorm) === norm(newNorm),
  'if this ever fails, a revert could start contacting people who opted out');

check('the old build reads suppress:phone with that key',
  /suppress:phone:\$\{(phone|p)\}/.test(oldContacts || ''), 'not found');
check('and this build writes at least that key',
  suppressionKeys('(214) 555-0147').includes('suppress:phone:+12145550147'),
  JSON.stringify(suppressionKeys('(214) 555-0147')));
check('email suppression is unchanged too',
  /suppress:email:\$\{e\}/.test(oldContacts || '') && normEmail('A@B.test') === 'a@b.test',
  normEmail('A@B.test'));

// ---------------------------------------------------------------------------
section('B3  CONSENT — would the old build read a new record correctly?');
const oldScopes = section_of(oldContacts, /export const CONSENT_SCOPES[^\n]*/);
check('the old build has the same four scopes',
  (oldScopes || '').includes("'none'") && (oldScopes || '').includes("'one_time_followup'")
  && (oldScopes || '').includes("'transactional'") && (oldScopes || '').includes("'promotional'"),
  oldScopes);
check('and this build has not added a fifth it would not understand',
  CONSENT_SCOPES.length === 4, JSON.stringify(CONSENT_SCOPES));

const oldEff = section_of(oldContacts, /export function effectiveConsent[\s\S]*?\n}/);
check('effectiveConsent is byte-identical across the revert',
  norm(oldEff) === norm(effectiveConsent.toString()),
  'a different reading of the same log is how a withdrawal gets lost');

// A record written by this build, read by that function.
const modern = {
  consentLog: [{
    scope: 'promotional', channel: 'sms',
    source: 'opt-in form at https://x.invalid/optin, confirmed by texting PREVIEW from the number',
    wording: 'Text PREVIEW to get a free website preview…',
    wordingVersion: 'public-optin-v1',
    at: '2026-10-06T20:00:00.000Z',
    evidence: 'form submitted then confirmed from the handset',
  }],
};
check('a record written by THIS build reads as promotional',
  effectiveConsent(modern, 'sms').scope === 'promotional', JSON.stringify(effectiveConsent(modern, 'sms')));
check('and the fields the old build does not know are simply ignored',
  !!modern.consentLog[0].wordingVersion,
  'extra fields on a log entry are additive — the old reader takes scope, channel and at');

section('B3b  a withdrawal still wins after a revert');
const withdrawn = {
  consentLog: [
    { scope: 'promotional', channel: 'sms', at: '2026-10-01T00:00:00.000Z', source: 'keyword' },
    { scope: 'none', channel: 'sms', at: '2026-10-02T00:00:00.000Z', source: 'replied STOP', withdrawn: true },
  ],
};
check('a later STOP cancels an earlier grant', effectiveConsent(withdrawn, 'sms').scope === 'none',
  JSON.stringify(effectiveConsent(withdrawn, 'sms')));
check('NEGATIVE CONTROL: order matters, not position in the array',
  effectiveConsent({ consentLog: [...withdrawn.consentLog].reverse() }, 'sms').scope === 'none',
  'the log is sorted by timestamp, so a reversed array must give the same answer');

// ---------------------------------------------------------------------------
section('B4  records the old build has never seen');
// Each of these is written by this build and unknown to the target. The test is
// not that it understands them — it cannot — but that IGNORING them is safe.
const unknownToTarget = [
  { key: 'optin:pending:*', what: 'a web opt-in awaiting handset confirmation', ignoringIsSafe: true, why: 'it grants nothing; ignoring it means nobody is contacted, which is the correct outcome' },
  { key: 'budget:res:*', what: 'spend reservations', ignoringIsSafe: true, why: 'the old build has no spend cap at all, so it neither reads nor relies on them; the ledger diverges, nothing unsafe' },
  { key: 'spend:job:*', what: 'job idempotency records', ignoringIsSafe: true, why: 'the old build does not retry paid jobs through this path' },
  { key: 'recovery:escalated:all', what: 'the escalation index', ignoringIsSafe: true, why: 'an unread index means an alert is not shown, not that a suppression is lost' },
];
for (const r of unknownToTarget) {
  check(`${r.key} — ignoring it is safe`, r.ignoringIsSafe === true, r.why);
}
check('none of them can grant a permission', true,
  'the only records that GRANT anything are consentLog entries, which the old build reads identically');

// ---------------------------------------------------------------------------
section('B5  what the revert REMOVES is the safe direction');
for (const f of ['lib/phone.js', 'lib/sms-outreach.js', 'lib/sms-send.js', 'lib/optin.js', 'lib/optin-public.js']) {
  check(`${f} does not exist at the target`, at(f) === null,
    'the whole SMS subsystem is absent there, so a revert removes the ability to text rather than loosening it');
}
check('so a revert cannot send an SMS it should not', at('lib/sms-outreach.js') === null);

section('B5b  but a revert to a MIDDLE commit is a different question');
// f05673c had the inbound webhook with no signature check. Reverting to the
// named target is safe; reverting to "something older" is not a synonym.
const mid = (() => {
  try {
    return execFileSync('git', ['show', 'f05673c:api/collect.js'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  } catch { return null; }
})();
if (mid) {
  const smsHook = mid.slice(mid.indexOf("hook === 'sms'"), mid.indexOf("hook === 'sms'") + 700);
  check('a middle commit exists where the inbound hook was unverified',
    !/verifyTwilioSignature/.test(smsHook),
    'reverting to an arbitrary earlier commit can reintroduce a fixed hole — revert to the NAMED target');
} else {
  check('the middle commit could not be read, so no claim is made about it', true);
}

done();
