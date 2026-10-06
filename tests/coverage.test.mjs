// The gate that catches what extraction missed.
//
// Completion is judged against the extracted item list. That is better than
// "the agent shipped something", but it moves the failure rather than removing
// it: if extraction drops an item, the list is complete by its own measure and
// every downstream check agrees with it. The client is told everything is done.
//
// The central test here is the one the review asked for: a multi-part request
// where extraction DELIBERATELY misses one item. The gate has to catch the
// omission and refuse the "all done" message.
//
// What this is NOT: a guarantee. It finds asks that look like asks. A second
// reviewer that misses something is not evidence there was nothing to miss,
// and that limit is asserted explicitly in C7 rather than left implied.
import { check, section, done } from './world.mjs';
import { extractAsks, checkExtraction, checkCompletion, reviewBeforeClosing, overlap, keywords, DISPOSITION } from '../lib/coverage.js';
import { buildRequirements, markDone, markOutstanding, mayAnnounceComplete } from '../lib/requirements.js';

// The real shape of a multi-part client email.
const EMAIL = `Hi Mondo,

Hope you're well. A few changes for the site when you get a chance:

- Please update the opening hours on the contact page to 9-5 weekdays
- Can you add the new team photo to the about page? I've attached it
- The phone number in the footer is wrong, it should be (910) 555-1234

Also, while you're at it, could you remove the old "Summer Sale" banner from the homepage?

Thanks so much!
Angie`;

// ---------------------------------------------------------------------------
section('C1  the asks are read out of a real email');
let asks = extractAsks(EMAIL);
check('four asks are found', asks.length === 4, `${asks.length}: ` + asks.map((a) => a.text.slice(0, 28)).join(' | '));
check('the hours ask', asks.some((a) => /opening hours/i.test(a.text)));
check('the photo ask', asks.some((a) => /team photo/i.test(a.text)));
check('the phone ask', asks.some((a) => /phone number/i.test(a.text)));
check('the banner ask, which is prose not a bullet', asks.some((a) => /summer sale/i.test(a.text)));
check('the greeting is not an ask', !asks.some((a) => /hope you/i.test(a.text)));
check('the sign-off is not an ask', !asks.some((a) => /^thanks/i.test(a.text)));

section('C1b  quoted and forwarded text is not re-read as new asks');
const reply = `Thanks, that looks great!

On Mon, Oct 5, 2026 at 9:14 AM Mondo wrote:
> Please update the opening hours on the contact page
> Can you add the new team photo to the about page?`;
check('a thank-you reply quoting the original produces no asks', extractAsks(reply).length === 0,
  JSON.stringify(extractAsks(reply).map((a) => a.text)));

// ---------------------------------------------------------------------------
section('C2  THE TEST: extraction drops an item, the gate catches it');
// What a model returned — three of the four. The banner is missing.
const EXTRACTED_MISSING_ONE = [
  'update the opening hours on the contact page to 9-5 weekdays',
  'add the new team photo to the about page',
  'fix the phone number in the footer to (910) 555-1234',
];
const pre = checkExtraction(EMAIL, EXTRACTED_MISSING_ONE);
check('the pre-execution check fails', pre.ok === false);
check('it names exactly one missing ask', pre.missing.length === 1, JSON.stringify(pre.missing.map((m) => m.text)));
check('and it is the banner', /summer sale/i.test(pre.missing[0].text), pre.missing[0].text);
check('it says what the consequence would have been', /never have been worked on/.test(pre.note), pre.note);

// now the ticket is built from the INCOMPLETE list, as it would have been
const ticket = { id: 't1', requirements: buildRequirements(EXTRACTED_MISSING_ONE) };
for (const r of ticket.requirements) markDone(ticket.requirements, r.id, { note: 'confirmed on the live site' });

check('the item gate alone says FINISHED — this is the hole', mayAnnounceComplete(ticket).ok === true,
  'every extracted item is done, so nothing downstream objects');

const closing = reviewBeforeClosing(EMAIL, ticket);
check('but the closing gate refuses to close', closing.mayClose === false);
check('because one ask was never captured', closing.coverage.unaccounted.length === 1);
check('and it names it', /summer sale/i.test(closing.coverage.unaccounted[0].ask));
check('"never captured" is distinguished from "not done"',
  closing.coverage.unaccounted[0].disposition === DISPOSITION.UNACCOUNTED);
check('the headline leads with it', /Never captured/.test(closing.headline), closing.headline);
check('the three that WERE done are still counted as verified', closing.coverage.verified === 3,
  String(closing.coverage.verified));

// ---------------------------------------------------------------------------
section('C3  a complete extraction closes cleanly');
const FULL = [...EXTRACTED_MISSING_ONE, 'remove the old Summer Sale banner from the homepage'];
check('the pre-execution check passes', checkExtraction(EMAIL, FULL).ok === true,
  JSON.stringify(checkExtraction(EMAIL, FULL).missing.map((m) => m.text)));
const good = { id: 't2', requirements: buildRequirements(FULL) };
for (const r of good.requirements) markDone(good.requirements, r.id, { note: 'confirmed' });
check('and the closing gate agrees', reviewBeforeClosing(EMAIL, good).mayClose === true);
check('every ask is verified', reviewBeforeClosing(EMAIL, good).coverage.dispositions
  .every((d) => d.disposition === DISPOSITION.VERIFIED));

// ---------------------------------------------------------------------------
section('C4  every ask gets exactly one explicit disposition');
const mixed = { id: 't3', requirements: buildRequirements(FULL) };
markDone(mixed.requirements, mixed.requirements[0].id, { note: 'confirmed' });
markOutstanding(mixed.requirements, mixed.requirements[1].id, 'we need the photo file from you');
// [2] left pending, [3] left pending
const cov = checkCompletion(EMAIL, mixed);
const kinds = cov.dispositions.map((d) => d.disposition);
check('one per ask, none missing', cov.dispositions.length === 4, String(cov.dispositions.length));
check('the done one is verified', kinds.filter((k) => k === DISPOSITION.VERIFIED).length === 1, JSON.stringify(kinds));
check('the blocked one is outstanding', kinds.filter((k) => k === DISPOSITION.OUTSTANDING).length === 1);
check('the unconfirmed ones need clarification', kinds.filter((k) => k === DISPOSITION.NEEDS_CLARIFICATION).length === 2);
check('nothing is unaccounted for', kinds.filter((k) => k === DISPOSITION.UNACCOUNTED).length === 0);
check('so it is not complete', cov.complete === false);
check('the outstanding reason travels with it',
  /photo file from you/.test(cov.dispositions.find((d) => d.disposition === DISPOSITION.OUTSTANDING).note || ''));

// ---------------------------------------------------------------------------
section('C5  attachments are read too');
const SHORT = 'Hi, see attached for what we need. Thanks!';
const ATTACH = `Requested changes:
1. Change the headline to "Trusted since 1998"
2. Add a careers link to the main menu`;
asks = extractAsks(SHORT, { attachmentText: ATTACH });
check('both asks come from the attachment', asks.filter((a) => a.source === 'attachment').length === 2,
  JSON.stringify(asks.map((a) => [a.source, a.text.slice(0, 24)])));
// The body's own "see attached for what we need" reads as a request too, which
// is right rather than noise — it is the sentence that points at the real list.
const attachMiss = checkExtraction(SHORT, [], { attachmentText: ATTACH });
check('an empty item list against an attachment fails', attachMiss.ok === false);
check('and both attachment asks are among what is missing',
  attachMiss.missing.some((m) => /Trusted since 1998/i.test(m.text)) &&
  attachMiss.missing.some((m) => /careers link/i.test(m.text)),
  JSON.stringify(attachMiss.missing.map((m) => m.text)));
check('the same ask in body AND attachment is not counted twice',
  extractAsks('Please add a careers link to the main menu', { attachmentText: 'Please add a careers link to the main menu' }).length === 1);

// ---------------------------------------------------------------------------
section('C6  matching is by meaning, not by string');
check('a paraphrase still matches', overlap('update the opening hours on the contact page', 'change contact page opening hours') >= 0.5,
  String(overlap('update the opening hours on the contact page', 'change contact page opening hours')));
check('two different asks about the same page do NOT collapse',
  overlap('add the team photo to the about page', 'remove the careers link from the about page') < 0.5,
  String(overlap('add the team photo to the about page', 'remove the careers link from the about page')));
check('filler words are ignored', !keywords('please can you the and').size);
check('empty against empty is zero, not one', overlap('', '') === 0);

// ---------------------------------------------------------------------------
section('C7  the limits are enforced, not merely acknowledged');
// A request phrased with no recognisable instruction produces no asks. That
// must behave like "I could not tell", never like "nothing to do".
const VAGUE = 'Hey! Had a thought about the site. Give me a ring when you have a sec.';
const silent = checkCompletion(VAGUE, { requirements: buildRequirements(['something']) });
check('no asks found is flagged as silent', silent.silent === true);
check('and silent is NOT complete', silent.complete === false,
  'a check with nothing to say must not be read as agreement');
check('it says so plainly', /establishes nothing/.test(silent.reason), silent.reason);
check('so the gate refuses to close', reviewBeforeClosing(VAGUE, { requirements: [] }).mayClose === false);

check('a ticket with no requirements at all cannot close',
  reviewBeforeClosing(EMAIL, { requirements: [] }).mayClose === false);
check('and every ask reads as never-captured',
  reviewBeforeClosing(EMAIL, { requirements: [] }).coverage.unaccounted.length === 4);

// ---------------------------------------------------------------------------
section('C8  it survives malformed input rather than throwing');
check('no text', checkExtraction('', ['x']).ok === true);
check('null items', checkExtraction(EMAIL, null).missing.length === 4);
check('undefined ticket', checkCompletion(EMAIL, undefined).complete === false);
check('a huge line is ignored rather than stored', extractAsks('please ' + 'x'.repeat(5000)).length === 0);
check('a one-word line is ignored', extractAsks('fix').length === 0);

done();
