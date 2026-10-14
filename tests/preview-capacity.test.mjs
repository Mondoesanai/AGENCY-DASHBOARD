// Never promise more previews than the owner can build.
//
// R23.3. Every confirmed booking is a promise of a CUSTOM PREVIEW, and a preview
// takes the owner hours. The rules capped bookings per DAY — 4 a day across 5
// workdays, so up to twenty a week — against an owner who can build about five.
// That is not an overbooked calendar. It is fifteen people a week who were
// promised something nobody has time to make, and they only find out on the call.
//
// The arithmetic is in lib/funnel-math.js: 20h of preview time a week at ~4h a
// preview is five. The honest failure is an empty slot list and a page that says
// booking is full — never a confirmed booking that cannot be honoured.

import { check, section, done } from './world.mjs';
import { candidateSlots, DEFAULT_RULES } from '../lib/scheduling.js';
import { DEFAULT_ECONOMICS, requiredVolume, targetVsCapacity, previewCapacity, ASSUMED_RATES } from '../lib/funnel-math.js';

const TZ = 'America/Chicago';
const MON = Date.UTC(2026, 9, 19, 13, 0); // Monday

const weekOf = (t) => {
  const d = new Date(new Date(t).toLocaleString('en-US', { timeZone: TZ }));
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
};
const byWeek = (slots) => slots.reduce((a, s) => { const k = weekOf(s.startAt); a[k] = (a[k] || 0) + 1; return a; }, {});

// ---------------------------------------------------------------------------
section('C1  the cap exists, and it comes from real capacity');
check('there is a weekly cap at all', DEFAULT_RULES.maxPerWeek != null,
  'a per-day cap alone allows 4 x 5 = 20 bookings a week');
const buildable = Math.floor(DEFAULT_ECONOMICS.ownerPreviewHoursPerWeek / DEFAULT_ECONOMICS.previewHoursPerBuild);
check(`it matches what the owner can build (${buildable}/week)`,
  DEFAULT_RULES.maxPerWeek === buildable,
  `${DEFAULT_RULES.maxPerWeek} vs ${DEFAULT_ECONOMICS.ownerPreviewHoursPerWeek}h / ${DEFAULT_ECONOMICS.previewHoursPerBuild}h`);
check('and it is far below what the day cap alone would allow',
  DEFAULT_RULES.maxPerWeek < DEFAULT_RULES.maxPerDay * DEFAULT_RULES.workdays.length,
  `${DEFAULT_RULES.maxPerWeek} vs ${DEFAULT_RULES.maxPerDay * DEFAULT_RULES.workdays.length}`);

section('C2  no week is ever offered more than the cap');
const weeks = byWeek(candidateSlots({ ...DEFAULT_RULES }, { now: MON }));
check('every week is within the cap',
  Object.values(weeks).every((n) => n <= DEFAULT_RULES.maxPerWeek), JSON.stringify(weeks));
check('and slots are still offered', Object.values(weeks).some((n) => n > 0), JSON.stringify(weeks),
  'a cap that offers nothing is not capacity management, it is an outage');

// ---------------------------------------------------------------------------
section('C3  previews already PROMISED reduce what is offered');
// The calendar knows about busy time; it does not know the owner already owes
// three people a preview. The booking ledger is what counts.
const thisWeek = weekOf(MON + 2 * 86400e3);
const partly = byWeek(candidateSlots({ ...DEFAULT_RULES }, {
  now: MON, promisedByWeek: { [thisWeek]: DEFAULT_RULES.maxPerWeek - 2 },
}));
check('a week with 3 promises offers only 2 more',
  (partly[thisWeek] || 0) === 2, JSON.stringify(partly));

const full = byWeek(candidateSlots({ ...DEFAULT_RULES }, {
  now: MON, promisedByWeek: { [thisWeek]: DEFAULT_RULES.maxPerWeek },
}));
check('a week already at capacity offers NOTHING that week',
  (full[thisWeek] || 0) === 0, JSON.stringify(full));
check('but the NEXT week is still open',
  Object.entries(full).some(([k, n]) => k !== thisWeek && n > 0), JSON.stringify(full),
  'being full this week must not close the business');

const over = byWeek(candidateSlots({ ...DEFAULT_RULES }, {
  now: MON, promisedByWeek: { [thisWeek]: DEFAULT_RULES.maxPerWeek + 4 },
}));
check('a week somehow OVER capacity offers nothing rather than going negative',
  (over[thisWeek] || 0) === 0, JSON.stringify(over));

// ---------------------------------------------------------------------------
section('C4  NEGATIVE CONTROL: with no cap, the old behaviour returns');
// Without this, every check above would pass against a function that returns
// nothing at all.
const uncapped = byWeek(candidateSlots({ ...DEFAULT_RULES, maxPerWeek: null }, { now: MON }));
check('removing the cap offers many more slots',
  Math.max(...Object.values(uncapped)) > DEFAULT_RULES.maxPerWeek, JSON.stringify(uncapped));
check('up to the day cap across the workdays',
  Math.max(...Object.values(uncapped)) <= DEFAULT_RULES.maxPerDay * DEFAULT_RULES.workdays.length,
  JSON.stringify(uncapped),
  'which is exactly the over-promising this cap exists to stop');

// ---------------------------------------------------------------------------
section('C5  the planning target is checked against capacity, not assumed');
const oneSale = requiredVolume({ salesPerWeek: 1 });
check('one sale a week needs bookings within capacity',
  oneSale.perWeek.confirmedBookings <= DEFAULT_RULES.maxPerWeek,
  `${oneSale.perWeek.confirmedBookings} bookings vs cap ${DEFAULT_RULES.maxPerWeek}`);
const twoSales = requiredVolume({ salesPerWeek: 2 });
check('two sales a week does NOT fit, and says so',
  twoSales.ownerCapacity.overCapacity === true, JSON.stringify(twoSales.ownerCapacity).slice(0, 170));
check('and names owner preview capacity as the bottleneck',
  twoSales.bottleneck === 'owner preview capacity', twoSales.bottleneck,
  'the constraint is the owner building previews, not the top of the funnel');

section('C5b  the six-call planning target is surfaced as a conflict');
// 6 attended calls needs ~9 bookings at a 70% show rate. That is 36h of preview
// building against 20h. Worth stating plainly rather than discovering it with
// nine prospects waiting.
const sixCalls = Math.ceil(6 / 0.7);
check('six attended calls implies more bookings than the cap allows',
  sixCalls > DEFAULT_RULES.maxPerWeek,
  `${sixCalls} bookings needed vs cap ${DEFAULT_RULES.maxPerWeek}`);
check('so the target and the capacity genuinely disagree',
  sixCalls * DEFAULT_ECONOMICS.previewHoursPerBuild > DEFAULT_ECONOMICS.ownerPreviewHoursPerWeek,
  `${sixCalls * DEFAULT_ECONOMICS.previewHoursPerBuild}h needed vs ${DEFAULT_ECONOMICS.ownerPreviewHoursPerWeek}h available`,
  'either previews get shorter, the week gets longer, or the target is four calls');

// ---------------------------------------------------------------------------
section('C6  the adapter counts the ledger, not just the calendar');
import { readFile } from 'node:fs/promises';
const src = await readFile(new URL('../lib/scheduling-google.js', import.meta.url), 'utf8');
check('availability reads the booking ledger', /listBookings\(\{ limit: 500 \}\)/.test(src), 'lib/scheduling-google.js');
check('and passes the promises into slot generation',
  /candidateSlots\(rules, \{ now: from, promisedByWeek \}\)/.test(src));
check('a cancelled booking does not consume capacity',
  /BOOKING_STATUS\.CANCELLED\) continue/.test(src),
  'a call that was cancelled owes nobody a preview');
check('and an unreadable ledger does not silently raise capacity',
  /catch \{ \/\* an unreadable ledger must not silently raise capacity/.test(src));



// ---------------------------------------------------------------------------
section('C7  R24.2 — the owner\'s STATED target, in his own units');
// Everything above planned from sales. The owner's words were "four to six
// CALLS a week", and planning from sales quietly answers a different question.
// At a 4h preview and 20h a week the floor does not fit either, and that is the
// finding — not a rounding detail to be smoothed over.
const tc = targetVsCapacity();
check('four attended calls needs six confirmed bookings',
  tc.floor.confirmedBookings === 6,
  `${tc.floor.confirmedBookings} at a ${Math.round(tc.showRate * 100)}% show rate`);
check('which is 24h of preview building', tc.floor.previewHours === 24, `${tc.floor.previewHours}h`);
check('six attended calls needs nine confirmed bookings',
  tc.target.confirmedBookings === 9, `${tc.target.confirmedBookings}`);
check('which is 36h', tc.target.previewHours === 36, `${tc.target.previewHours}h`);
check('and only 20h exist', tc.capacity.hoursPerWeek === 20, `${tc.capacity.hoursPerWeek}h`);
check('so the stated FLOOR does not fit', tc.floor.fits === false, tc.verdict);
check('nor does the target', tc.target.fits === false);
check('the verdict says the floor is over capacity, not just the target',
  /FLOOR is already over capacity/.test(tc.verdict), tc.verdict,
  'the earlier version only flagged two sales a week and let four calls through');

section('C7b  and it offers the three real options rather than one');
check('three options are given', tc.options.length === 3, JSON.stringify(tc.options.map((o) => o.option)));
check('shorten the preview is one', tc.options.some((o) => /shorten/.test(o.option)));
check('add build capacity is one', tc.options.some((o) => /add build capacity/.test(o.option)));
check('lower the call target is one', tc.options.some((o) => /lower the call target/.test(o.option)));
check('each names what it requires and what it risks',
  tc.options.every((o) => o.requires && o.unlocks && o.risk), JSON.stringify(tc.options[0]));
check('shortening names the hours it would have to hit',
  /[0-9.]+h instead of 4h/.test(tc.options[0].requires), tc.options[0].requires,
  'an option with no number is not a choice, it is a suggestion');

section('C8  the servable ceiling is stated, not left to be discovered');
const one = requiredVolume({ salesPerWeek: 1 });
check('the ceiling is about three attended calls a week',
  one.ownerCapacity.servableAttendedCalls === 3,
  `${one.ownerCapacity.servableAttendedCalls} calls from ${previewCapacity().previewsPerWeek} previews at a ${Math.round(ASSUMED_RATES.show.value * 100)}% show rate`);
check('which is about one sale a week',
  one.ownerCapacity.servableSalesPerWeek >= 0.9 && one.ownerCapacity.servableSalesPerWeek <= 1.1,
  `${one.ownerCapacity.servableSalesPerWeek}`,
  'the REVENUE goal of one build a week fits; the CALL target of four to six does not');
check('max previews a week is five', previewCapacity().previewsPerWeek === 5);

section('C9  every rate behind the invitation count is labelled an estimate');
// "413 invitations" is 1 ÷ 0.33 ÷ 0.7 ÷ 0.35 ÷ 0.03. Three of those four were
// bare literals in a function signature with no provenance anywhere.
check('all four rates are present', Object.keys(ASSUMED_RATES).length === 4,
  Object.keys(ASSUMED_RATES).join(','));
for (const [k, a] of Object.entries(ASSUMED_RATES)) {
  check(`${k} is labelled ESTIMATE`, a.label === 'ESTIMATE', a.label);
  check(`${k} says where it came from`, !!a.source && a.source.length > 10, a.source);
  check(`${k} defines its own denominator`, /÷/.test(a.definition), a.definition);
  check(`${k} says what would replace it`, !!a.replacedBy, a.replacedBy);
}
check('the show rate does NOT claim to be owner-provided',
  !/owner/i.test(ASSUMED_RATES.show.source), ASSUMED_RATES.show.source,
  'only the close rate came from the owner; the other three were picked here');
check('the reply rate admits it is the most sensitive one',
  /three times the sending/.test(ASSUMED_RATES.reply.basis), ASSUMED_RATES.reply.basis);

section('C9b  the arithmetic is shown in full, so it can be checked by hand');
check('the chain is spelled out', /÷ 0.03 reply/.test(one.arithmetic), one.arithmetic);
check('it ends at the number that gets quoted', /413 to send/.test(one.arithmetic), one.arithmetic);
check('and the unrounded expectation is kept beside the integer plan',
  one.expected.invitationsSent === 412.3 && one.perWeek.invitationsSent === 413,
  JSON.stringify({ expected: one.expected.invitationsSent, plan: one.perWeek.invitationsSent }));
check('every rate carries its provenance in the output too',
  Object.values(one.rateProvenance).every((r) => r.label && r.source && r.percent),
  JSON.stringify(one.rateProvenance.reply));

section('C10  planning from calls and from sales are different questions');
const fromCalls = requiredVolume({ attendedCallsPerWeek: 4 });
check('it says which drove it', fromCalls.drivenBy === 'attendedCalls', fromCalls.drivenBy);
check('four calls needs more sending than one sale does',
  fromCalls.perWeek.invitationsSent > one.perWeek.invitationsSent,
  `${fromCalls.perWeek.invitationsSent} vs ${one.perWeek.invitationsSent}`);
check('and four calls is flagged over capacity',
  fromCalls.ownerCapacity.overCapacity === true, fromCalls.ownerCapacity.note);
check('the bottleneck is named as preview capacity',
  fromCalls.bottleneck === 'owner preview capacity', fromCalls.bottleneck);

section('C10b  NEGATIVE CONTROL: with enough hours, the same target fits');
const roomy = targetVsCapacity({ economics: { ...DEFAULT_ECONOMICS, ownerPreviewHoursPerWeek: 40 } });
check('40h a week fits the six-call target', roomy.target.fits === true, roomy.verdict);
check('and it says so rather than warning anyway',
  /Both the floor and the target fit/.test(roomy.verdict), roomy.verdict);
check('with no options to choose between', roomy.options.length === 0);

done();
