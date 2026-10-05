// "Done" means every thing they asked for, not "we shipped something".
//
// Isha Lo was emailed that her CPD request was live while one of the items she
// asked for had not been done at all. The agent knew and said so — in a git
// commit message. Completion was inferred from "the agent shipped", so a
// partial result was indistinguishable from a complete one.
//
// Completion is now judged against the itemised requirements captured when the
// request arrived. Prose parsing survives only as a safety net that can flag a
// gap, never as evidence that work happened.
import { check, section, done } from './world.mjs';
import {
  buildRequirements, markDone, markOutstanding, completionState,
  mayAnnounceComplete, partialUpdateText, reconcileFromShipText, ITEM,
} from '../lib/requirements.js';
import { classifyReason } from '../lib/revision-state.js';

// ---------------------------------------------------------------------------
section('Q1  every distinct ask becomes its own requirement');
let reqs = buildRequirements([
  'change the opening hours on the contact page to 9-5 weekdays',
  'add the official CPD accreditation logo to the certification section',
  'fix the phone number in the footer',
]);
check('three asks make three requirements', reqs.length === 3, String(reqs.length));
check('each starts pending', reqs.every((r) => r.state === ITEM.PENDING));
check('each has its own id', new Set(reqs.map((r) => r.id)).size === 3);
check('the text is kept', /CPD accreditation logo/.test(reqs[1].text));

check('junk entries are dropped', buildRequirements(['real ask', '', '   ', null, 42]).length === 1);
check('a runaway list is capped', buildRequirements(Array.from({ length: 50 }, (_, i) => `ask ${i}`)).length === 20);
check('a non-array does not throw', buildRequirements('not an array', { summary: 'fallback' }).length === 1);
check('no items falls back to the summary', buildRequirements([], { summary: 'change the hours' })[0].text === 'change the hours');
check('nothing at all yields nothing', buildRequirements([], {}).length === 0);

// ---------------------------------------------------------------------------
section('Q2  partial work is never "complete"');
let t = { requirements: buildRequirements(['change the hours', 'add the CPD logo']) };
check('nothing done is not complete', completionState(t).complete === false);
markDone(t.requirements, t.requirements[0].id, { note: 'confirmed on the live site' });
let c = completionState(t);
check('one of two done is still not complete', c.complete === false);
check('it counts honestly', c.done === 1 && c.total === 2, `${c.done}/${c.total}`);
check('and says what is missing', /1 of 2 item\(s\) are not confirmed done/.test(c.reason), c.reason);
check('"it is live" is refused', mayAnnounceComplete(t).ok === false);

markDone(t.requirements, t.requirements[1].id);
check('both done IS complete', completionState(t).complete === true);
check('and only then may we say it is live', mayAnnounceComplete(t).ok === true);

// ---------------------------------------------------------------------------
section('Q3  an item that cannot be done is recorded, not dropped');
t = { requirements: buildRequirements(['change the hours', 'add the official CPD logo']) };
markDone(t.requirements, t.requirements[0].id);
markOutstanding(t.requirements, t.requirements[1].id, 'needs the official logo file from the client');
c = completionState(t);
check('it is not complete', c.complete === false);
check('the outstanding item is listed', c.outstanding.length === 1);
check('with the reason', /official logo file/.test(c.outstanding[0].note), c.outstanding[0].note);
check('the item is NOT silently removed', t.requirements.length === 2);
check('"it is live" is still refused', mayAnnounceComplete(t).ok === false);

// ---------------------------------------------------------------------------
section('Q4  unknown is never counted as done');
check('a ticket with no requirements is NOT complete', completionState({ requirements: [] }).complete === false);
check('and is explicitly unverifiable', completionState({ requirements: [] }).unverifiable === true);
check('and says why', /cannot be established/.test(completionState({}).reason));
check('a missing requirements field does not throw', completionState(undefined).complete === false);
check('an announcement on an empty ticket is refused', mayAnnounceComplete({ requirements: [] }).ok === false);

// ---------------------------------------------------------------------------
section('Q5  the partial message tells the truth');
t = {
  requirements: buildRequirements(['change the opening hours', 'add the official CPD logo', 'fix the footer phone number']),
};
markDone(t.requirements, t.requirements[0].id);
markOutstanding(t.requirements, t.requirements[1].id, 'we need the logo file from you');
const text = partialUpdateText(t, { siteName: 'The Lo Down', siteUrl: 'https://example.com' });
check('it does NOT claim everything is live', !/everything is live|all live|all done/i.test(text), text.slice(0, 120));
check('it lists what IS done', /change the opening hours/.test(text));
check('it names what is NOT', /add the official CPD logo/.test(text));
check('with the reason', /we need the logo file from you/.test(text));
check('it mentions work still in progress', /Still in progress/.test(text) && /footer phone number/.test(text));
check('it names the site', /The Lo Down/.test(text));
check('and promises a follow-up', /follow up/i.test(text));

// ---------------------------------------------------------------------------
section('Q6  prose can flag a gap but never manufacture progress');
const ishaCommit = "I reused the existing hand-drawn seal since I don't have that logo file; swap it in if she sends it.";
t = { requirements: buildRequirements(['change the hours to 12 CPD', 'add the official CPD logo image']) };
let r = reconcileFromShipText(t, ishaCommit, classifyReason);
check('the admission is acted on', r.changed > 0, JSON.stringify(r));
check('it marks an item OUTSTANDING', t.requirements.some((x) => x.state === ITEM.OUTSTANDING));
check('it marks NOTHING done', t.requirements.every((x) => x.state !== ITEM.DONE),
  'prose must never be evidence that work happened');
check('so the ticket is still not complete', completionState(t).complete === false);

t = { requirements: buildRequirements(['change the hours']) };
check('an ordinary ship summary changes nothing',
  reconcileFromShipText(t, 'Updated the opening hours on the contact page.', classifyReason).changed === 0);
check('and certainly marks nothing done', t.requirements[0].state === ITEM.PENDING,
  'silence about an item is not confirmation of it');

check('no ship text is a no-op', reconcileFromShipText(t, '', classifyReason).changed === 0);
check('no requirements is a no-op', reconcileFromShipText({ requirements: [] }, ishaCommit, classifyReason).changed === 0);

// ---------------------------------------------------------------------------
section('Q7  the exact shape of the live failure, end to end');
// what the pipeline now does with Isha's request
const isha = {
  summary: 'apply the CPD accreditation handoff doc',
  requirements: buildRequirements([
    'change 25 hours to 12 CPD hours everywhere',
    'add the CPD accreditation section with the credentialing table',
    'add the official CPDSO Accredited Provider logo image',
  ]),
};
markDone(isha.requirements, isha.requirements[0].id, { note: 'confirmed on the live site' });
markDone(isha.requirements, isha.requirements[1].id, { note: 'confirmed on the live site' });
reconcileFromShipText(isha, ishaCommit, classifyReason);
const verdict = mayAnnounceComplete(isha);
check('she is NOT told it is live', verdict.ok === false);
check('the ticket knows it is 2 of 3', verdict.state.done === 2 && verdict.state.total === 3,
  `${verdict.state.done}/${verdict.state.total}`);
check('the logo is the outstanding item', /logo/i.test(verdict.state.outstanding[0]?.text || ''),
  JSON.stringify(verdict.state.outstanding.map((x) => x.text)));
check('and the draft to send her is truthful',
  !/everything/i.test(partialUpdateText(isha, { siteName: 'The Lo Down' })));

done();
