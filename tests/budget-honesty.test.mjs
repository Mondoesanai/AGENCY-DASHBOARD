// A limit that nothing applies is not a cap, and the screen must not call it one.
//
// Found by the R15.7 reachability audit: `withBudget` — the head of the whole
// reserve → run → reconcile chain — had zero production callers, and with it
// `reserveCost`, `reconcileCost`, `releaseCost`, `spendByCategory` and
// `setBudgetSettings` were dead too. Nothing was wrong with the code. What was
// wrong was everything built on the assumption that it ran:
//
//   * `enforced` meant "a number was typed into settings", so with a limit set
//     the panel announced "the weekly limit is the one actually stopping work
//     right now" while nothing consulted it.
//   * `spent` and `reserved` were read from counters no job writes, so they
//     showed $0.00 — next to an SEO agent genuinely billing money under
//     `agent:spend:<slug>:<month>`. A zero meaning "nothing records this" is
//     indistinguishable from a zero meaning "nothing was spent", and the
//     second one is a lie the owner would act on.
//
// So these checks are mostly about what the screen is NOT allowed to say.
import { check, section, done } from './world.mjs';
import {
  budgetStatus, getPeriodState, activeCaps, CAP_WIRED, uncappableNote, setBudgetSettings,
} from '../lib/budget.js';
import { renderBudget, renderObservedSpend, renderActiveCaps } from '../public/acquisition.js';

// ---------------------------------------------------------------------------
section('B1  "a limit is set" and "a limit is applied" are different facts');
// A limit is configured ON PURPOSE here. With no limit set, `enforced` reads
// false whichever way it is derived, so the test would pass for the wrong
// reason and go on passing if the bug came back.
await setBudgetSettings({ weeklyLimitCents: 2500, monthlyLimitCents: 9000, conversationReservePct: 20 });
const st = await getPeriodState('week');
check('the limit really is configured for this check', st.limitCents === 2500, String(st.limitCents));
check('the state reports whether a limit was configured', st.limitConfigured === true, JSON.stringify(Object.keys(st)));
check('and separately whether anything applies it', 'enforced' in st);
check('A CONFIGURED LIMIT IS STILL NOT AN ENFORCED ONE', st.enforced === false,
  'this is the whole fix: `enforced` used to be `limit != null`, so typing a number in was enough to make the panel claim work was being stopped');
check('CAP_WIRED is the single switch that says so', CAP_WIRED === false, String(CAP_WIRED));
check('enforced can never be true while the cap is unwired',
  !(st.enforced && !CAP_WIRED),
  'enforced is derived from CAP_WIRED, so a configured limit alone cannot flip it');
check('the monthly window behaves the same way',
  (await getPeriodState('month')).enforced === false && (await getPeriodState('month')).limitConfigured === true);

// ---------------------------------------------------------------------------
section('B2  the status tells the owner what is really being spent');
const b = await budgetStatus();
check('it says the cap is not wired', b.capWired === false, String(b.capWired));
check('and explains what that means for the figures below', /recorded preferences/.test(b.capUnwiredNote || ''), b.capUnwiredNote);
check('it warns that the spent column stays at zero', /stay at zero/.test(b.capUnwiredNote || ''));
check('observed spend is reported separately', !!b.observed, JSON.stringify(b.observed));
check('from the counters the features actually write',
  b.observed.error ? true : /coach:spend/.test(b.observed.source || ''), b.observed.source);
check('a failed read is NOT reported as zero spending',
  b.observed.error ? /not a report of zero spending/.test(b.observed.note || '') : true, b.observed.note);
check('and it does not overclaim what it covers',
  b.observed.error ? true : /does not include/.test(b.observed.note || ''), b.observed.note);

section('B3  the caps that DO refuse work are named, with which only warns');
const caps = activeCaps({ COACH_MONTHLY_BUDGET: '15' });
check('there is more than one', caps.length >= 3, String(caps.length));
check('each says where it lives', caps.every((c) => /^lib\//.test(c.where)), caps.map((c) => c.where).join(','));
check('each says whether it refuses or only warns', caps.every((c) => typeof c.refuses === 'boolean'));
const coach = caps.find((c) => /Compass/.test(c.what));
check('Compass is marked as warn-only, because it is', coach.refuses === false, JSON.stringify(coach));
check('and says plainly that spend carries past it', /carries past the cap/.test(coach.note), coach.note);
const agent = caps.find((c) => /SEO agent/.test(c.what));
check('the SEO agent cap is marked as really stopping work', agent.refuses === true);
check('at least one cap genuinely refuses', caps.some((c) => c.refuses));
check('the env-driven number is read, not hardcoded',
  activeCaps({ COACH_MONTHLY_BUDGET: '40' }).find((c) => /Compass/.test(c.what)).limit.includes('$40'),
  activeCaps({ COACH_MONTHLY_BUDGET: '40' }).find((c) => /Compass/.test(c.what)).limit);

// ---------------------------------------------------------------------------
section('B4  THE CLAIM THE PANEL MAY NO LONGER MAKE');
// A limit IS configured here, which is exactly the case that used to produce
// the false statement.
const configured = {
  capWired: false,
  capUnwiredNote: 'The weekly and monthly limits below are recorded preferences — no code path applies them yet.',
  bindingPeriod: 'week',
  paused: false,
  observed: { month: '2026-10', totalUsd: 4.37, byFeature: [{ what: 'SEO agent', usd: 4.37 }], source: 'coach:spend / agent:spend', note: 'Model spend only.' },
  activeCaps: activeCaps(),
  uncappableNote: uncappableNote(),
  week: { period: 'week', key: '2026-W41', limitCents: 2000, spentCents: 0, reservedCents: 0, remainingCents: 2000, limitConfigured: true, enforced: false, conversationReserveCents: 400, resetsAt: new Date().toISOString() },
  month: { period: 'month', key: '2026-10', limitCents: 8000, spentCents: 0, reservedCents: 0, remainingCents: 8000, limitConfigured: true, enforced: false, conversationReserveCents: 0, resetsAt: new Date().toISOString() },
};
let html = renderBudget(configured);
check('the panel does NOT say a limit is stopping work',
  !/actually stopping work/.test(html),
  'this is the exact sentence the old panel printed whenever a limit was configured, with nothing applying it');
check('it says the limits are not being applied', /not being applied/.test(html), html.slice(0, 300));
check('it explains why the spent column is zero', /not because nothing has been spent/.test(html));
check('the real spend is shown', /\$4\.37/.test(html));
check('above the limits table, not below it',
  html.indexOf('actually been spent') < html.indexOf('Limits on record'),
  'the honest number has to be the one the eye lands on first');
check('the limits table is labelled as a record, not a control', /Limits on record/.test(html));
check('the limit itself is still shown', /\$20\.00/.test(html));
check('the reserve promise is dropped while nothing reserves',
  !/a reply never fails for want of budget/.test(html),
  'that sentence describes reserveCost, which has no caller');
check('and the uncappable caveat survives', /cannot cap charges a provider/.test(html));

section('B5  once it IS wired, the panel goes back to speaking plainly');
html = renderBudget({ ...configured, capWired: true, capUnwiredNote: null, week: { ...configured.week, enforced: true }, month: { ...configured.month, enforced: true } });
check('the binding limit is named again', /actually stopping work/.test(html), html.slice(0, 240));
check('and the unwired warning is gone', !/not being applied/.test(html));

// ---------------------------------------------------------------------------
section('B6  the pieces survive bad input');
check('no observed block when there is nothing to show', renderObservedSpend(null) === '');
check('no caps block when the list is empty', renderActiveCaps([]) === '' && renderActiveCaps(null) === '');
check('a read error renders as an error, not as zero',
  /Could not read what has been spent/.test(renderObservedSpend({ error: 'kv timeout', note: 'This is not a report of zero spending.' })));
check('and repeats that it is not zero', /not a report of zero spending/.test(renderObservedSpend({ error: 'x', note: 'This is not a report of zero spending.' })));
const warnHtml = renderActiveCaps(activeCaps());
check('warn-only caps are visually distinct from real ones', /cap-soft/.test(warnHtml) && /cap-hard/.test(warnHtml));
check('and labelled in words, not only by colour', /warns only/.test(warnHtml) && /stops work/.test(warnHtml));

done();
