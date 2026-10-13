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
import { DEFAULT_ECONOMICS, requiredVolume } from '../lib/funnel-math.js';

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

done();
