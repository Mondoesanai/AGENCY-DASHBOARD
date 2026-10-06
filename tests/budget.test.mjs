import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  setBudgetSettings, getBudgetSettings, budgetStatus, getPeriodState,
  reserveCost, reconcileCost, releaseCost,
  periodKey, periodEnd, toCents, toUsd, spendByCategory, uncappableNote,
} from '../lib/budget.js';
import { withSpend } from '../lib/spend-guard.js';

section('B1  money is counted in whole cents, never drifting floats');
check('$0.07 is 7 cents', toCents(0.07) === 7);
check('a third of a cent rounds, it does not vanish', toCents(0.004) === 0 && toCents(0.006) === 1);
let drift = 0;
for (let i = 0; i < 1000; i++) drift += toCents(0.07);
check('1000 x $0.07 is exactly $70.00, not $69.99…', toUsd(drift) === 70, String(toUsd(drift)));

section('B2  period boundaries are stable and in UTC');
check('a month key is YYYY-MM', /^\d{4}-\d{2}$/.test(periodKey('month', new Date('2026-03-15T12:00:00Z'))));
check('weeks start Monday', periodKey('week', new Date('2026-03-18T12:00:00Z')) === periodKey('week', new Date('2026-03-16T00:00:00Z')));
check('Sunday belongs to the week that began Monday', periodKey('week', new Date('2026-03-22T23:00:00Z')) === periodKey('week', new Date('2026-03-16T00:00:00Z')));
check('the next Monday starts a new week', periodKey('week', new Date('2026-03-23T00:30:00Z')) !== periodKey('week', new Date('2026-03-22T23:00:00Z')));
check('a month rolls into the next key', periodKey('month', new Date('2026-04-01T00:00:00Z')) === '2026-04');
check('reset time is reported', periodEnd('month', new Date('2026-03-15T00:00:00Z')).toISOString().startsWith('2026-04-01'));

section('B3  a $50/week budget actually stops spending at $50');
await setBudgetSettings({ weeklyLimitCents: 5000, monthlyLimitCents: null, conversationReservePct: 0 });
let okCount = 0;
let refusal = null;
for (let i = 0; i < 12; i++) {
  const r = await reserveCost({ category: 'discovery', estimateUsd: 5 });
  if (r.ok) { okCount++; await reconcileCost(r.reservationId, 5); }
  else refusal = refusal || r;
}
check('exactly ten $5 jobs are allowed, the rest refused', okCount === 10, `${okCount} allowed`);
check('the refusal explains itself in plain words', /budget is used up/.test(refusal?.reason || ''), refusal?.reason);
const st = await getPeriodState('week');
check('spend lands exactly on the limit', st.spentCents === 5000, String(st.spentCents));
check('nothing is left reserved after reconciling', st.reservedCents === 0, String(st.reservedCents));
check('remaining is zero, not negative', st.remainingCents === 0);

section('B4  concurrent workers cannot overspend the same allowance');
await store.set(`budget:week:${periodKey('week')}:spent`, '0');
await store.set(`budget:week:${periodKey('week')}:reserved`, '0');
await setBudgetSettings({ weeklyLimitCents: 1000, monthlyLimitCents: null, conversationReservePct: 0 });
const race = await Promise.all(Array.from({ length: 25 }, () => reserveCost({ category: 'ai', estimateUsd: 1 })));
const grants = race.filter((r) => r.ok);
check('25 workers race, exactly 10 get the $10', grants.length === 10, `${grants.length} grants`);
const raced = await getPeriodState('week');
check('held money never exceeds the cap', raced.committedCents <= 1000, String(raced.committedCents));
for (const g of grants) await releaseCost(g.reservationId);
check('releasing hands it all back', (await getPeriodState('week')).committedCents === 0);

section('B5  reserved vs actual — the estimate is held, the real cost is booked');
await store.set(`budget:week:${periodKey('week')}:spent`, '0');
await store.set(`budget:week:${periodKey('week')}:reserved`, '0');
await setBudgetSettings({ weeklyLimitCents: 10000, monthlyLimitCents: null, conversationReservePct: 0 });
const big = await reserveCost({ category: 'enrichment', estimateUsd: 20 });
const mid = await getPeriodState('week');
check('the estimate is held while the job runs', mid.reservedCents === 2000 && mid.spentCents === 0, JSON.stringify(mid));
check('the cap counts held money, not just spent', mid.committedCents === 2000 && mid.remainingCents === 8000);
await reconcileCost(big.reservationId, 3.5); // it actually cost far less
const end = await getPeriodState('week');
check('the hold is released and the real cost booked', end.reservedCents === 0 && end.spentCents === 350, JSON.stringify(end));
check('the unused estimate goes back to the budget', end.remainingCents === 9650, String(end.remainingCents));

section('B6  a retried worker cannot double-charge');
const once = await reserveCost({ category: 'messaging', estimateUsd: 1 });
await reconcileCost(once.reservationId, 1);
const spentAfterFirst = (await getPeriodState('week')).spentCents;
const second = await reconcileCost(once.reservationId, 1);
check('reconciling the same reservation twice is ignored', second.alreadyDone === true);
check('the ledger is not charged twice', (await getPeriodState('week')).spentCents === spentAfterFirst, String(spentAfterFirst));

section('B7  a crashing job never leaves money HELD');
// `withBudget` lived here until R16.1 and released the reservation on any
// throw. `withSpend` replaced it and deliberately does not: an unknown error
// may well mean the provider did the work and charged for it, and handing that
// money back lets a retry spend it a second time. What survives from the old
// test is the invariant that actually mattered — nothing is left *held*.
const heldBefore = (await getPeriodState('week')).reservedCents;

let threw = false;
const crashed = await withSpend({ category: 'ai', estimateUsd: 4 }, async () => { throw new Error('provider exploded'); });
check('an unknown failure is reported as uncertain', crashed.uncertain === true, JSON.stringify(crashed));
check('the original cause is not swallowed', /provider exploded/.test(crashed.reason), crashed.reason);
check('nothing is left held', (await getPeriodState('week')).reservedCents === heldBefore,
  String((await getPeriodState('week')).reservedCents));

const committedBefore = (await getPeriodState('week')).committedCents;
try {
  await withSpend({ category: 'ai', estimateUsd: 4 }, async () => {
    const e = new Error('getaddrinfo ENOTFOUND');
    e.code = 'ENOTFOUND';
    throw e;
  });
} catch { threw = true; }
check('an error raised before the request still surfaces to the caller', threw);
check('…and that one IS handed back in full', (await getPeriodState('week')).committedCents === committedBefore,
  String(committedBefore));

section('B8  part of the budget is held back for live conversations');
await store.set(`budget:week:${periodKey('week')}:spent`, '0');
await store.set(`budget:week:${periodKey('week')}:reserved`, '0');
await setBudgetSettings({ weeklyLimitCents: 10000, monthlyLimitCents: null, conversationReservePct: 20 });
let discoveryGrants = 0;
for (let i = 0; i < 12; i++) {
  const r = await reserveCost({ category: 'discovery', estimateUsd: 10 });
  if (r.ok) { discoveryGrants++; await reconcileCost(r.reservationId, 10); } else break;
}
check('cold discovery can only use 80% of the allowance', discoveryGrants === 8, `${discoveryGrants} x $10 of $100`);
const blocked = await reserveCost({ category: 'discovery', estimateUsd: 10 });
check('…then it is refused, and says why the rest is held', blocked.ok === false && /held for replies/.test(blocked.reason), blocked.reason);
const convo = await reserveCost({ category: 'ai', estimateUsd: 10, conversational: true });
check('answering someone who replied CAN use the reserve', convo.ok === true);

section('B9  essentials are never blocked, but are still recorded');
await setBudgetSettings({ weeklyLimitCents: 1, monthlyLimitCents: 1 });
const optOutJob = await reserveCost({ category: 'messaging', estimateUsd: 0.5, essential: true });
check('processing an opt-out runs even with no budget left', optOutJob.ok === true && optOutJob.essential === true);
await reconcileCost(optOutJob.reservationId, 0.5);
check('and it still appears in the ledger', (await spendByCategory('month')).messaging > 0);
const normalJob = await reserveCost({ category: 'discovery', estimateUsd: 0.5 });
check('…while discretionary work is still refused', normalJob.ok === false);

section('B10  pause stops discretionary spend immediately');
await setBudgetSettings({ weeklyLimitCents: 100000, monthlyLimitCents: 100000, pausedAt: new Date().toISOString() });
const paused = await reserveCost({ category: 'discovery', estimateUsd: 1 });
check('paused refuses new paid work', paused.ok === false && /paused/.test(paused.reason), paused.reason);
const stillEssential = await reserveCost({ category: 'messaging', estimateUsd: 1, essential: true });
check('…but opt-outs and replies keep working while paused', stillEssential.ok === true);
await setBudgetSettings({ pausedAt: null });

section('B11  weekly and monthly do not double-count the same money');
await store.set(`budget:week:${periodKey('week')}:spent`, '0');
await store.set(`budget:month:${periodKey('month')}:spent`, '0');
await store.set(`budget:week:${periodKey('week')}:reserved`, '0');
await store.set(`budget:month:${periodKey('month')}:reserved`, '0');
await setBudgetSettings({ weeklyLimitCents: 5000, monthlyLimitCents: 20000, conversationReservePct: 0 });
const one = await reserveCost({ category: 'ai', estimateUsd: 10 });
await reconcileCost(one.reservationId, 10);
const w = await getPeriodState('week');
const mo = await getPeriodState('month');
check('one $10 charge shows as $10 this week', w.spentCents === 1000, String(w.spentCents));
check('…and the same $10 this month (same money, two windows)', mo.spentCents === 1000, String(mo.spentCents));
const status = await budgetStatus();
check('the tighter window is named as the binding one', status.bindingPeriod === 'week', status.bindingPeriod);
check('both windows report their own reset time', !!status.week.resetsAt && !!status.month.resetsAt);

section('B12  an unset limit means "not enforced", not "zero"');
await setBudgetSettings({ weeklyLimitCents: null, monthlyLimitCents: null });
const free = await reserveCost({ category: 'discovery', estimateUsd: 999 });
check('with no limit set, work is not blocked', free.ok === true);
const s2 = await getPeriodState('week');
check('…and the UI is told it is unenforced, not that $0 remains', s2.enforced === false && s2.remainingCents === null);
await releaseCost(free.reservationId);

section('B13  the uncappable-charges caveat is stated, not hidden');
check('it warns about provider-side billing the app cannot control', /cannot cap/.test(uncappableNote()) && /subscription/.test(uncappableNote()));
check('it is surfaced in the status payload', /cannot cap/.test((await budgetStatus()).uncappableNote));
check('rollover defaults to off (unused budget does not accumulate)', (await getBudgetSettings()).rollover === false);

done();
