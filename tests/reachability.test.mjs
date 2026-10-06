// Can production actually reach this code, or does only the test suite run it?
//
// WHY THIS EXISTS. Three times in this build a module passed its own tests,
// read as finished, and never ran in production:
//
//   * the recovery buttons rendered with no click handler (R10)
//   * `applyDeliveryReceipt` had no webhook to call it (R13.4)
//   * `lib/asset-research.js` could not reach a search adapter, so every
//     lookup returned `needs-search` for ever (R15.3)
//
// `tests/wiring.test.mjs` was the answer to the first one, but it only looks at
// `public/`. All three of the orphans above were BACK-END, and 567 exports
// across 85 `lib/` modules had no equivalent guard at all. This is that guard.
//
// HOW IT WORKS. Production can only start in one of twelve places: the Vercel
// functions in `api/`. (The cron hits `api/cron-daily.js`; the browser hits
// `api/admin.js`; nothing else has an entry point.) So the import graph is
// walked from those twelve files, and every `lib/` export is asked a single
// question: is its name referenced anywhere in the code production can reach?
// If it is referenced only by `tests/`, it is tested but never run.
//
// THE ALLOWLIST IS THE POINT. Roughly fifty exports legitimately have no
// caller today — a send path deliberately switched off by the release hold is
// indistinguishable, statically, from a send path somebody forgot to wire. So
// each one is recorded here with a class and a reason, which does three jobs:
// a NEW orphan fails the suite, a deliberate one carries its justification
// next to it, and `R15.7` in HELD entries names what would wire it.
//
// The allowlist is also checked in the other direction (R4): an entry that is
// no longer an orphan fails too, so the list cannot quietly rot into a
// rubber stamp that forgives everything.
//
// TWO KNOWN LIMITS, stated rather than hidden:
//
//  1. A reference is not a call. `false && foo()` still mentions `foo`. This
//     catches a call site that was never written or was deleted, not one that
//     was disabled. Live negative controls remain the primary evidence.
//  2. A cluster of mutually-calling dead functions only shows up at its head.
//     `withBudget` calls `reserveCost`, so only `withBudget` is reported as an
//     orphan even though all four of the reserve/reconcile/release functions
//     are dead with it. The allowlist entry for a cluster head therefore names
//     the rest of the cluster, so the dead set is written down in full.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, section, done } from './world.mjs';

// fileURLToPath, not `url.pathname` — this repo lives under "Inspiring
// Websites website", so the pathname arrives percent-encoded and every
// readdir would miss by a directory name.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const list = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(ext));

// ---------------------------------------------------------------------------
// The allowlist: every export production cannot currently reach, and why.
//
// HELD   — complete, deliberately unreachable while the release hold is on.
//          `wiredBy` names what has to happen for it to run.
// GAP    — nothing calls it and something is worse as a result. The
//          consequence is stated, not softened.
// OWNER  — a real capability with no screen pointing at it yet. Reachable the
//          moment a caller is added; harmless until then.
// INTERNAL — a helper or constant kept for the module's own readers.
// ---------------------------------------------------------------------------
const ALLOWED = {
  // --- HELD: outreach is switched off, so the send path cannot run ---------
  'lib/outreach-email.js:sendProspectEmail': {
    cls: 'HELD',
    why: 'The prospect email sender. Outreach is disabled for this development window.',
    wiredBy: 'turning the outreach switch on; `?do=invite-send` already calls the invitation path and obeys the switch',
  },
  'lib/replies.js:guardedSend': {
    cls: 'HELD',
    why: 'claim → prepare → recheck → commit, the wrapper that stops an opt-out or an inbound reply racing a queued follow-up. Dead only because nothing sends yet.',
    wiredBy: 'the first real campaign send; `claimSend` and `claimStillValid` are reached through it, not separately',
  },
  'lib/campaigns.js:composeWarm': { cls: 'HELD', why: 'Writes the follow-up body for a sequence step.', wiredBy: 'enabling campaign sends' },
  'lib/campaigns.js:markStepSent': { cls: 'HELD', why: 'Records that a sequence step went out.', wiredBy: 'enabling campaign sends' },
  'lib/campaigns.js:mayEscalateToSms': {
    cls: 'HELD',
    why: 'Decides whether an email thread may move to text. Refusing is the default and the refusal is what matters, so it must not be wired before SMS is.',
    wiredBy: 'a verified outreach number plus per-contact SMS permission',
  },
  'lib/deliverability.js:summarise': { cls: 'HELD', why: 'Bounce/complaint rates in words.', wiredBy: 'having sent anything to measure' },
  'lib/reporting.js:recordSendAttempt': { cls: 'HELD', why: 'Logs an attempt so a "sent" count can never exceed attempts.', wiredBy: 'the first real send' },
  'lib/reporting.js:isOverstated': { cls: 'HELD', why: 'Catches a reported figure larger than the evidence supports.', wiredBy: 'the first real send' },
  'lib/holdout.js:HOLDOUT_RULES': { cls: 'HELD', why: 'The rules that stop a winner being declared from a handful of examples.', wiredBy: 'enough observed outcomes to compare at all' },
  'lib/holdout.js:againstBaseline': { cls: 'HELD', why: 'Compares a variant against a holdout.', wiredBy: 'enough observed outcomes to compare at all' },
  'lib/integrity.js:PROHIBITED': { cls: 'HELD', why: 'The list of claims the AI may never make.', wiredBy: 'the drafting path, once it drafts to a real recipient' },
  'lib/integrity.js:acceptEngagement': { cls: 'HELD', why: 'Records that a prospect engaged, for honest reporting later.', wiredBy: 'the first real send' },
  'lib/sms-outreach.js:sendProspectSms': {
    cls: 'HELD',
    why: 'The prospect SMS sender, and the reason the whole SMS area is safe right now: it refuses before the Twilio adapter is ever reached. '
      + 'Its own module header already described it as "complete, and it is unreachable" — which is accurate, and which is also what the first version of '
      + 'this guard mistook for a caller until comments were stripped.',
    wiredBy: 'a dedicated outreach number plus documented per-contact SMS permission; neither exists in this window',
  },
  'lib/sms-outreach.js:recordCarrierDecision': {
    cls: 'HELD',
    why: 'Records an A2P 10DLC approval or rejection. Approval comes from the carrier, from outside this system, and cannot be recorded without a carrier reference — so there is nothing for production to call until a real registration is decided.',
    wiredBy: 'submitting the 10DLC registration and receiving a decision',
  },
  'lib/sms-send.js:reconcileUsage': {
    cls: 'HELD',
    why: 'The only function permitted to turn an estimated SMS cost into an actual one. Unwired, which is why every cost figure in the dashboard is still labelled an estimate — correctly.',
    wiredBy: 'provider billing data; it refuses to invent a number without it',
  },
  'lib/experiments.js:updateVariants': {
    cls: 'HELD',
    why: 'The only permitted way to change an experiment\'s arms. Nothing calls it because nothing has been sent to experiment on; the holdout rule is re-checked at report time anyway, precisely so it survives a route nobody guarded.',
    wiredBy: 'a running experiment, which needs sends',
  },

  // --- HELD: needs a paid provider the owner has not authorised -----------
  'lib/phone.js:isValidNumber': {
    cls: 'HELD',
    why: 'Carrier-grade number validation. Deliberately NOT used as an SMS gate: a valid number is not permission, and treating validity as eligibility is the mistake this whole area exists to prevent.',
    wiredBy: 'a paid lookup provider; the owner authorised no purchases, so eligibility stays documented-consent-only',
  },
  'lib/phone.js:recordLineType': { cls: 'HELD', why: 'Stores mobile/landline/VoIP once a lookup can answer.', wiredBy: 'a paid lookup provider' },
  'lib/phone.js:LOOKUP_PROVIDER': { cls: 'HELD', why: 'Which provider would be used, named so the cost is visible before it is incurred.', wiredBy: 'a paid lookup provider' },
  'lib/phone.js:getLookupAdapter': { cls: 'HELD', why: 'Returns null while unconfigured, so callers report "unknown" instead of guessing.', wiredBy: 'a paid lookup provider' },

  // --- GAP: unwired, and something is worse for it ------------------------
  'lib/contrast.js': {
    cls: 'GAP',
    module: true,
    why: 'The WCAG contrast checker. No api/ entry imports it, so the colour tokens it was written to police are never actually checked. '
      + 'Consequence: a future token change can drop below 4.5:1 and nothing notices. It is still exercised by its own tests, which is why it reads as finished.',
    wiredBy: 'a build or test step that reads public/ tokens; it needs no runtime caller',
  },
  'lib/recovery.js:sweepHistory': { cls: 'GAP', why: 'The record of past sweeps. Unwired, so the Checks panel shows the latest sweep but not whether sweeps have been running.', wiredBy: 'a history row on the Checks panel' },
  'lib/recovery.js:clearEscalation': { cls: 'GAP', why: 'Clears a raised escalation. With no caller an escalation can be raised but never lowered from the UI.', wiredBy: 'an acknowledge button' },
  'lib/jobs.js:enqueue': { cls: 'GAP', why: 'The generic job queue. Everything schedules through the daily cron instead, so this is a second mechanism with no users.', wiredBy: 'nothing planned; a candidate for deletion' },
  'lib/suggestions.js:clientSuggestions': {
    cls: 'GAP',
    why: 'A back-compat alias for `clientActions` with no importers left — its last mention anywhere is inside a comment in lib/email.js. '
      + 'Consequence is small but real: two names for one function invite a future edit to the wrong one.',
    wiredBy: 'nothing. Delete the alias and the stale comment; `clientActions` is the live name',
  },

  // --- OWNER: a real capability with no screen pointing at it yet ---------
  'lib/contacts.js:deleteContact': { cls: 'OWNER', why: 'Erases a contact. Deliberately not on a screen that could be clicked by accident.' },
  'lib/retention.js:wasErased': { cls: 'OWNER', why: 'Confirms an erasure actually happened, for answering a deletion request.' },
  'lib/optin.js:clearAttestation': { cls: 'OWNER', why: 'Withdraws the owner\'s blanket attestation. Needed for a correction, not for normal use.' },
  'lib/bookings.js:rescheduleBooking': { cls: 'OWNER', why: 'Moves a booking. Calendly reschedules arrive as their own webhook, so this is for a hand-entered meeting.' },
  'lib/card-intake.js:storeCardImage': { cls: 'OWNER', why: 'Keeps the scanned card image; intake currently reads and discards.' },
  'lib/card-intake.js:getCardImage': { cls: 'OWNER', why: 'Reads a stored card image back.' },
  'lib/requirements.js:markOutstanding': { cls: 'OWNER', why: 'Flags a requested item as still outstanding by hand, when a ship text did not mention it.' },
  'lib/asset-search.js:addOfficialSource': { cls: 'OWNER', why: 'Adds a domain to the trusted-source list. An owner decision, not an automatic one.' },
  'lib/asset-research.js:mayTransform': { cls: 'OWNER', why: 'Refuses recolouring, stretching, cropping, redrawing, tracing and watermark removal by name. Consulted when an asset is about to be altered — which nothing does yet, because the refusal is the whole point.' },
  'lib/conversations.js:chooseChannel': { cls: 'OWNER', why: 'Picks email or SMS for a thread. The owner chooses explicitly today.' },
  'lib/revision-state.js:isOpen': { cls: 'OWNER', why: 'State predicate; callers compare the state directly.' },
  'lib/revision-state.js:isTerminal': { cls: 'OWNER', why: 'State predicate; callers compare the state directly.' },
  'lib/discovery.js:guessEmailFromName': { cls: 'OWNER', why: 'Guesses an address from a name. Unwired on purpose — a guessed address is not a discovered one and must never enter the contact list as fact.' },
  'lib/integrations.js:withEvidence': { cls: 'OWNER', why: 'Attaches the evidence for an integration claim.' },

  'lib/ai-client.js:__setSdkLoader': {
    cls: 'INTERNAL',
    why: 'The test seam that swaps the model SDK. Production always uses the real loader; a test that reached the network instead would be both slow and billable.',
  },

  // --- INTERNAL: helpers and constants kept for readers of the module -----
  'lib/boot.js:booted': { cls: 'INTERNAL', why: 'Start-up marker, read in development.' },
  'lib/redact.js:isSafeConsoleInstalled': { cls: 'INTERNAL', why: 'Asserts the redacting console is in place; proven by its own tests.' },
  'lib/redact.js:containsSecret': { cls: 'INTERNAL', why: 'The predicate behind the redactor, reached through it rather than directly.' },
  'lib/redact.js:safeError': { cls: 'INTERNAL', why: 'Error shape with secrets stripped; superseded by the console installer.' },
  'lib/redact.js:safeLog': {
    cls: 'INTERNAL',
    why: 'A direct-call redacting logger, superseded and correctly unused: every api/ entry imports lib/boot.js first, which calls installSafeConsole() '
      + 'and patches console itself. So logs ARE redacted in production — through the patch, not through this.',
  },
  'lib/replies.js:ALL_KINDS': { cls: 'INTERNAL', why: 'The eleven reply kinds, exported for tests and readers.' },
  'lib/webhooks.js:parseBareHeader': { cls: 'INTERNAL', why: 'Header parser used by the signature verifiers in the same module.' },
  'lib/discovery.js:WEB_STATUS_WORDING': { cls: 'INTERNAL', why: 'Wording table for "no website found" vs "not checked".' },
  'lib/relationship.js:NEVER_COLD': { cls: 'INTERNAL', why: 'The relationship states that may never be described as cold outreach.' },
};

// ---------------------------------------------------------------------------
// Walk the import graph from the only twelve places production can start.
// ---------------------------------------------------------------------------
const ENTRIES = list('api', '.js').map((f) => `api/${f}`);

function importsOf(rel) {
  const src = read(rel);
  const dir = path.posix.dirname(rel.split(path.sep).join('/'));
  const out = new Set();
  // static `from './x.js'` and dynamic `await import('./x.js')`, either quote
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+\.js)['"]/g)) {
    out.add(path.posix.normalize(path.posix.join(dir, m[1])));
  }
  return [...out];
}

const reachable = new Set();
const missing = [];
const queue = [...ENTRIES];
while (queue.length) {
  const cur = queue.shift();
  if (reachable.has(cur)) continue;
  if (!fs.existsSync(path.join(ROOT, cur))) { missing.push(cur); continue; }
  reachable.add(cur);
  queue.push(...importsOf(cur));
}

section('R1  the graph is real before anything is concluded from it');
check('all twelve Vercel functions are entry points', ENTRIES.length === 12, `${ENTRIES.length}: ${ENTRIES.join(' ')}`);
check('the walk reached a substantial graph, not just the entries',
  reachable.size > 60, `${reachable.size} files reachable from ${ENTRIES.length} entries`);
check('no entry imports a module that does not exist', missing.length === 0, missing.join(', '));
check('a known-wired module is reported as reachable', reachable.has('lib/store.js'), 'lib/store.js');
check('the walk follows DYNAMIC imports too, not only static ones',
  reachable.has('lib/budget.js'),
  'lib/budget.js is only ever reached via `await import()` in api/admin.js — if this fails the walk is blind to half the codebase');

// ---------------------------------------------------------------------------
const libFiles = list('lib', '.js').map((f) => `lib/${f}`);
const prodSrc = new Map([...reachable].map((r) => [r, read(r)]));
const testSrc = list('tests', '.mjs').map((f) => read(`tests/${f}`)).join('\n');

/**
 * Comments are not callers.
 *
 * This had to be added immediately: documenting `withBudget` as an orphan in
 * its own module header made the guard report it as reachable, so writing
 * prose about dead code was enough to launder it into live code. Exactly
 * backwards, and it would have hidden the next real orphan behind a sentence.
 *
 * Residual limit: a trailing comment after code on the same line is only
 * stripped when its `//` is not part of a `://` URL. Good enough for header
 * blocks and JSDoc, which is where names get discussed.
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Is `name` mentioned in real code in `src`, other than its own declaration? */
function mentions(src, name) {
  const decl = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`);
  const body = stripComments(src).split('\n').filter((l) => !decl.test(l)).join('\n');
  return new RegExp(`\\b${name}\\b`).test(body);
}

const orphans = [];
for (const f of libFiles) {
  const moduleReachable = reachable.has(f);
  const src = moduleReachable ? prodSrc.get(f) : read(f);
  if (!moduleReachable) { orphans.push({ key: f, module: true, inTests: true }); continue; }
  const names = [...src.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  for (const n of names) {
    let inProd = false;
    for (const osrc of prodSrc.values()) if (mentions(osrc, n)) { inProd = true; break; }
    if (!inProd) orphans.push({ key: `${f}:${n}`, module: false, inTests: new RegExp(`\\b${n}\\b`).test(testSrc) });
  }
}

// ---------------------------------------------------------------------------
section('R2  nothing is tested-but-never-run without a recorded reason');
// This is the guard. A new export with no caller fails here, and the only way
// to pass is to wire it or to write down why it cannot be wired yet.
for (const o of orphans) {
  const entry = ALLOWED[o.key];
  check(`${o.key} is wired, or recorded as unreachable on purpose`, !!entry,
    entry ? '' : `NOT WIRED AND NOT EXPLAINED. Production cannot reach ${o.key}`
      + `${o.inTests ? ', but the test suite calls it — so it passes its tests and never runs' : ''}. `
      + 'Either add a caller on a real path, or add an entry to ALLOWED in this file with a class and a reason.');
}

section('R3  every recorded reason says enough to act on');
for (const [key, e] of Object.entries(ALLOWED)) {
  check(`${key} has a class`, ['HELD', 'GAP', 'OWNER', 'INTERNAL'].includes(e.cls), e.cls);
  check(`${key} explains itself in a sentence, not a word`, (e.why || '').length > 30, e.why);
  // The two classes that describe something temporary must say what ends it.
  if (e.cls === 'HELD' || e.cls === 'GAP') {
    check(`${key} names what would wire it`, (e.wiredBy || '').length > 10, e.wiredBy || '(missing)');
  }
}

section('R4  the allowlist cannot rot into a rubber stamp');
// An entry that is no longer an orphan has to be removed, or the list slowly
// grows into a blanket forgiveness that hides the next real one.
const orphanKeys = new Set(orphans.map((o) => o.key));
for (const key of Object.keys(ALLOWED)) {
  check(`${key} is still actually unreachable`, orphanKeys.has(key),
    `This is now reachable from production, so its entry in ALLOWED is stale. Delete it — otherwise the list forgives a future orphan of the same name.`);
}

section('R5  the detector itself: prose about dead code is not a caller');
// This is not hypothetical. The first version of this guard reported
// `withBudget`, `spendByCategory` and `setBudgetSettings` as WIRED purely
// because a comment in their own module named them while documenting that they
// were dead. Stripping comments turned up six further orphans that prose had
// been hiding, `sendProspectSms` among them. Asserted here so the detector
// cannot regress into forgiving whatever it is told about.
check('a line comment naming a function does not count as a call',
  !mentions('// TODO: wire withBudget into the AI call sites\nconst x = 1;', 'withBudget'),
  'the exact shape that laundered three dead functions into live ones');
check('a block comment naming a function does not count either',
  !mentions('/**\n * Superseded by withBudget, which nothing calls.\n */\nconst y = 2;', 'withBudget'));
check('but a real call still counts', mentions('await withBudget({}, run);', 'withBudget'));
check('and a real import still counts', mentions("import { withBudget } from './budget.js';", 'withBudget'));
check('a URL is not mistaken for a comment',
  mentions("const u = 'https://x.test/withBudget';", 'withBudget'),
  'the `//` in a URL must not swallow the rest of the line');
check('a declaration is not its own caller',
  !mentions('export function soloExample() { return 1; }', 'soloExample'));

section('R6  every named journey has a production trigger, not just a test');
// `lib/journeys.js` recorded `evidence` — the test that demonstrates each
// journey — but not what STARTS it in production. That is the whole R15.7
// question, and a journey with a test and no trigger is the overnight failure
// pattern wearing a green tick. So each journey now names its entry point, and
// the entry point is checked against the same reachability walk above rather
// than taken on trust.
const { JOURNEYS } = await import('../lib/journeys.js');
check('all fourteen journeys are named', JOURNEYS.length === 14, String(JOURNEYS.length));
for (const j of JOURNEYS) {
  check(`journey ${j.n} names what triggers it in production`, !!j.trigger, j.name);
  check(`journey ${j.n}'s trigger is a real Vercel function`, ENTRIES.includes(j.trigger),
    `${j.trigger} is not one of: ${ENTRIES.join(', ')}`);
  check(`journey ${j.n}'s trigger is reachable, i.e. it is deployed`, reachable.has(j.trigger), j.trigger);
  // The evidence has to exist too — a citation to a deleted file is worse than
  // no citation, because it reads as proof.
  const file = (j.evidence || '').split(/[ ,]/)[0];
  check(`journey ${j.n}'s evidence file exists: ${file}`, fs.existsSync(path.join(ROOT, file)), file);
}
check('the three provider-boundary journeys still say what would clear them',
  JOURNEYS.filter((j) => j.boundary).every((j) => j.toClear && j.demonstratedTo),
  `${JOURNEYS.filter((j) => j.boundary).length} at a boundary`);

section('R7  what the audit found, in numbers');
const byClass = (c) => Object.values(ALLOWED).filter((e) => e.cls === c).length;
check('the audit covered every lib module', libFiles.length > 80, `${libFiles.length} modules`);
check('the orphan set is fully accounted for', orphans.every((o) => !!ALLOWED[o.key]),
  `${orphans.filter((o) => !ALLOWED[o.key]).length} unaccounted`);
check('the gaps are written down rather than rounded off', byClass('GAP') >= 1, `${byClass('GAP')} GAP entries`);
check('held-back work names its unblocking condition',
  Object.values(ALLOWED).filter((e) => e.cls === 'HELD').every((e) => e.wiredBy),
  `${byClass('HELD')} HELD entries`);
// A plain record in the output, so the numbers appear in the run rather than
// only in a document that can drift from the code.
check(`summary: ${orphans.length} unreachable exports — `
  + `${byClass('HELD')} held by the release hold, ${byClass('GAP')} real gaps, `
  + `${byClass('OWNER')} awaiting a screen, ${byClass('INTERNAL')} internal`,
true);

done();
