// Does the cap actually stop anything?
//
// R16.1. The previous answer was no: `lib/budget.js` had a complete reserve →
// run → reconcile design and zero callers, so the limits on screen were
// preferences. Every check here is about the production path now doing the
// thing the panel claims.
//
// The demonstration the owner asked for is E2 and E3 together: a low allowance,
// concurrent jobs trying to exceed it, eligible work stopping, and essential
// inbound work carrying on regardless.
import { check, section, done } from './world.mjs';
import {
  setBudgetSettings, getPeriodState, budgetStatus, CAP_WIRED, spendByCategory, periodKey,
} from '../lib/budget.js';
import { store } from '../lib/store.js';

/**
 * Zero the period counters between sections.
 *
 * Without this, E1's $0.75 is still on the clock when E2 sets a $1.00 weekly
 * allowance, so "ten jobs against a budget that fits five" silently becomes
 * "against a budget that fits one" — and the test would have been measuring
 * leftover state rather than the cap.
 */
async function resetSpend() {
  for (const period of ['week', 'month']) {
    const k = periodKey(period);
    await store.set(`budget:${period}:${k}:spent`, 0);
    await store.set(`budget:${period}:${k}:reserved`, 0);
  }
}
import { withSpend, JOB, certainlyUnspent, PAID_PATHS } from '../lib/spend-guard.js';
import {
  aiClient, __setSdkLoader, costOf, estimateFor, ratesFor, BudgetRefusedError,
} from '../lib/ai-client.js';
import { listRepairTasks } from '../lib/recovery.js';

const cents = (n) => n;

// ---------------------------------------------------------------------------
section('E1  a discretionary job reserves before it spends, and settles after');
await resetSpend();
await setBudgetSettings({ weeklyLimitCents: 10000, monthlyLimitCents: 10000, conversationReservePct: 0 });

let ran = false;
let out = await withSpend({ category: 'ai', estimateUsd: 1.0, jobId: 'e1' }, async (ctx) => {
  ran = true;
  const held = await getPeriodState('week');
  check('the money is held WHILE the job runs', held.reservedCents === cents(100), String(held.reservedCents));
  check('and is not yet counted as spent', held.spentCents === 0, String(held.spentCents));
  ctx.reportCost(0.25); // the provider's real figure
  return 'done';
});
check('the job ran', ran && out.ok, JSON.stringify(out));
let st = await getPeriodState('week');
check('the hold is released afterwards', st.reservedCents === 0, String(st.reservedCents));
check('and the ACTUAL cost is booked, not the estimate', st.spentCents === cents(25), `${st.spentCents} (estimate was 100)`);
check('settling at the real figure is reported', out.estimated === false);

section('E1b  with no reported cost the estimate stands');
await withSpend({ category: 'ai', estimateUsd: 0.5, jobId: 'e1b' }, async () => 'no cost reported');
st = await getPeriodState('week');
check('the estimate is booked rather than nothing', st.spentCents === cents(25 + 50), String(st.spentCents));

// ---------------------------------------------------------------------------
section('E2  THE DEMONSTRATION: concurrent jobs cannot exceed a low allowance');
// $1.00 for the week. Ten jobs each estimating $0.20 start at once; only five
// fit. Reading "spent < limit" and then spending is the classic way to blow a
// budget, so this runs them concurrently rather than in sequence.
await resetSpend();
await setBudgetSettings({ weeklyLimitCents: 100, monthlyLimitCents: null, conversationReservePct: 0 });

let started = 0;
const attempts = await Promise.all(
  Array.from({ length: 10 }, (_, i) => withSpend(
    { category: 'discovery', estimateUsd: 0.20, jobId: `e2_${i}` },
    async () => { started += 1; return i; },
  )),
);
const allowed = attempts.filter((a) => a.ok);
const refused = attempts.filter((a) => a.refused);
check('exactly five were allowed', allowed.length === 5, `${allowed.length} allowed`);
check('the other five were refused', refused.length === 5, `${refused.length} refused`);
check('and the refused ones NEVER RAN', started === 5,
  `${started} job bodies ran — a refusal that still runs the job is not a cap`);
check('a refusal says why in words', /budget is used up/.test(refused[0].reason), refused[0].reason);
check('nothing overshot the allowance',
  (await getPeriodState('week')).spentCents <= 100,
  String((await getPeriodState('week')).spentCents));
check('a refusal is not an exception', attempts.every((a) => typeof a.ok === 'boolean'),
  'callers must be able to ignore nothing; refusal is a normal return');

section('E2b  a refusal is not a life sentence');
// Found by this test: refusals were being recorded as a terminal outcome, so a
// job refused once would replay that refusal for ever — even after the next
// period reset the allowance. Nothing ran and nothing was charged, so the only
// correct behaviour is to let it try again when there is room.
const refusedId = attempts.findIndex((a) => a.refused);
const stillRefused = await withSpend({ category: 'discovery', estimateUsd: 0.20, jobId: `e2_${refusedId}` }, async () => 'no');
check('it is still refused while the budget is still gone', stillRefused.refused === true, JSON.stringify(stillRefused));
check('and it is refused FRESH, not replayed from a record', !stillRefused.replayed,
  'a replayed refusal would survive the budget being topped up');

await setBudgetSettings({ weeklyLimitCents: 100000, monthlyLimitCents: null, conversationReservePct: 0 });
let laterRan = false;
const later = await withSpend({ category: 'discovery', estimateUsd: 0.20, jobId: `e2_${refusedId}` }, async () => { laterRan = true; return 'yes'; });
check('with allowance restored the same job runs', later.ok === true && laterRan, JSON.stringify(later));

// Put the allowance back where E3 expects it: exhausted.
await setBudgetSettings({ weeklyLimitCents: 100, monthlyLimitCents: null, conversationReservePct: 0 });

// ---------------------------------------------------------------------------
section('E3  essential inbound work continues with the allowance exhausted');
// The allowance is now gone. An opt-out or an inbound reply that stopped being
// processed because a report generator used up the month would be unlawful,
// not merely rude.
const after = await getPeriodState('week');
check('the allowance really is exhausted', after.spentCents >= 100, String(after.spentCents));

let essentialRan = false;
const ess = await withSpend(
  { category: 'ai', estimateUsd: 0.50, jobId: 'e3_inbound', essential: true },
  async () => { essentialRan = true; return 'classified'; },
);
check('essential work is NOT refused', ess.ok === true, JSON.stringify(ess));
check('and it actually ran', essentialRan);

const disc = await withSpend({ category: 'ai', estimateUsd: 0.01, jobId: 'e3_disc' }, async () => 'should not run');
check('while discretionary work in the same moment is still refused', disc.refused === true, JSON.stringify(disc));

check('essential spend is still RECORDED, not hidden',
  (await getPeriodState('week')).spentCents >= 150,
  `${(await getPeriodState('week')).spentCents} — the ledger stays truthful even when the cap is bypassed`);

// ---------------------------------------------------------------------------
section('E4  a retried job does not pay twice, and does not run twice');
await resetSpend();
await setBudgetSettings({ weeklyLimitCents: 100000, monthlyLimitCents: null, conversationReservePct: 0 });
const before4 = (await getPeriodState('week')).spentCents;
let runs = 0;
const first = await withSpend({ category: 'ai', estimateUsd: 2.0, jobId: 'e4_same' }, async () => { runs += 1; return 'first'; });
const second = await withSpend({ category: 'ai', estimateUsd: 2.0, jobId: 'e4_same' }, async () => { runs += 1; return 'second'; });
check('the first attempt ran', first.ok && runs === 1, String(runs));
check('THE RETRY DID NOT RUN THE JOB AGAIN', runs === 1,
  're-running is what creates the second charge; refusing to re-run is the actual protection');
check('the retry is reported as a replay', second.replayed === true, JSON.stringify(second));
const after4 = (await getPeriodState('week')).spentCents;
check('and it was charged exactly once', after4 - before4 === cents(200), `${after4 - before4}`);

// ---------------------------------------------------------------------------
section('E5  an uncertain outcome is booked, parked, and never retried');
// A timeout is not a refund. If the request may have reached the provider, the
// safe assumption is that it was charged.
const before5 = (await getPeriodState('week')).spentCents;
const unc = await withSpend({ category: 'ai', estimateUsd: 1.5, jobId: 'e5_timeout' }, async () => {
  const e = new Error('socket hang up');
  throw e;
});
check('it is reported as uncertain, not as a failure', unc.uncertain === true, JSON.stringify(unc));
check('the money is booked at the estimate', (await getPeriodState('week')).spentCents - before5 === cents(150),
  String((await getPeriodState('week')).spentCents - before5));
check('and it is NOT handed back', (await getPeriodState('week')).spentCents > before5,
  'releasing money that may have been spent lets a retry spend it again');

let retriedRuns = 0;
const retry5 = await withSpend({ category: 'ai', estimateUsd: 1.5, jobId: 'e5_timeout' }, async () => { retriedRuns += 1; return 'x'; });
check('a retry of an unknown outcome does not re-run it', retriedRuns === 0, String(retriedRuns));
check('and says so', /already finished as "uncertain"/.test(retry5.reason || ''), retry5.reason);

const tasks = await listRepairTasks({ limit: 20 });
const parked = (tasks.tasks || tasks || []).find((t) => /Uncertain ai spend/i.test(t.title || ''));
check('a person is given something to check', !!parked, JSON.stringify((tasks.tasks || tasks || []).map((t) => t.title)));
check('the parked task says it was not retried', /has NOT been retried/.test(parked.diagnostics || ''), parked.diagnostics?.slice(0, 120));
check('and names the provider as the place to look', /provider/i.test(parked.diagnostics || ''));

// ---------------------------------------------------------------------------
section('E6  an error raised before anything was sent hands the money straight back');
check('a refused connection is classified as certainly unspent', certainlyUnspent({ code: 'ECONNREFUSED' }));
check('so is a missing credential', certainlyUnspent(new Error('not connected: no SMS credentials')));
check('but a timeout is NOT', !certainlyUnspent(new Error('socket hang up')),
  'the default has to be "we may have been charged"');
check('and neither is an unknown error', !certainlyUnspent(new Error('something odd')));

const before6 = (await getPeriodState('week')).spentCents;
let threw = null;
try {
  await withSpend({ category: 'ai', estimateUsd: 3.0, jobId: 'e6_dns' }, async () => {
    const e = new Error('getaddrinfo ENOTFOUND api.anthropic.com');
    e.code = 'ENOTFOUND';
    throw e;
  });
} catch (e) { threw = e; }
check('the error reaches the caller', !!threw && threw.code === 'ENOTFOUND');
check('nothing was charged', (await getPeriodState('week')).spentCents === before6,
  String((await getPeriodState('week')).spentCents - before6));
check('no money is left held', (await getPeriodState('week')).reservedCents === 0,
  String((await getPeriodState('week')).reservedCents));

let reran = 0;
await withSpend({ category: 'ai', estimateUsd: 0.1, jobId: 'e6_dns' }, async () => { reran += 1; return 'ok'; });
check('and the job CAN be retried, because it provably did not run', reran === 1, String(reran));

// ---------------------------------------------------------------------------
section('E7  the model chokepoint refuses when the budget is gone');
await setBudgetSettings({ weeklyLimitCents: 1, monthlyLimitCents: null, conversationReservePct: 0 });
let sdkCalls = 0;
__setSdkLoader(async () => ({
  default: class {
    constructor() { this.messages = { create: async () => { sdkCalls += 1; return { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 1000, output_tokens: 100 } }; } }; }
  },
}));

const client = await aiClient({ apiKey: 'test', category: 'ai' });
let refusedErr = null;
try {
  await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 500, messages: [{ role: 'user', content: 'hello' }] });
} catch (e) { refusedErr = e; }
check('the call throws rather than silently succeeding', !!refusedErr);
check('with a budget-specific error', refusedErr instanceof BudgetRefusedError, refusedErr?.name);
check('AND THE PROVIDER WAS NEVER CALLED', sdkCalls === 0,
  `${sdkCalls} — a cap that refuses after the request has gone out is not a cap`);
check('the error says the limit refused it', /refused by the spending limit/.test(refusedErr.message), refusedErr.message);

section('E7b  with budget, the same call goes through and settles on real tokens');
await setBudgetSettings({ weeklyLimitCents: 100000, monthlyLimitCents: null, conversationReservePct: 0 });
const before7 = (await getPeriodState('week')).spentCents;
const ok7 = await client.messages.create({ model: 'claude-sonnet-5', max_tokens: 500, messages: [{ role: 'user', content: 'hello' }] });
check('the provider was called', sdkCalls === 1, String(sdkCalls));
check('and the caller gets the real response', ok7.content[0].text === 'hi');
const spent7 = (await getPeriodState('week')).spentCents - before7;
// 1000 in @ $3/M + 100 out @ $15/M = 0.003 + 0.0015 = 0.0045 → rounds to 0 cents
check('cost is computed from the provider\'s own usage', costOf({ input_tokens: 1000, output_tokens: 100 }, 'claude-sonnet-5') === 0.0045,
  String(costOf({ input_tokens: 1000, output_tokens: 100 }, 'claude-sonnet-5')));
check('a sub-cent call books as such rather than as the estimate', spent7 <= 1, String(spent7));

section('E7c  pricing errs towards over-booking, never under');
check('haiku is cheaper than sonnet', ratesFor('claude-haiku-4-5')[0] < ratesFor('claude-sonnet-5')[0]);
check('an UNKNOWN model is priced at the highest known rate', ratesFor('some-future-model')[0] === 15,
  'under-pricing an unknown model would silently raise the real cap');
check('cache writes and reads are both counted',
  costOf({ cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 }, 'claude-sonnet-5') > 0,
  'a long cached prompt is most of the bill on the agent path');
check('the pre-call estimate assumes the full output', estimateFor({ model: 'claude-sonnet-5', max_tokens: 1e6, messages: [] }) >= 15,
  String(estimateFor({ model: 'claude-sonnet-5', max_tokens: 1e6, messages: [] })));

// ---------------------------------------------------------------------------
section('E8  spend is attributable, and the claim of enforcement is earned');
const byCat = await spendByCategory('week');
check('spend is grouped by what caused it', !!byCat && typeof byCat === 'object', JSON.stringify(byCat).slice(0, 160));

check('CAP_WIRED is true only because a path now applies it', CAP_WIRED === true, String(CAP_WIRED));
const bs = await budgetStatus();
check('the status reports the cap as wired', bs.capWired === true);
check('and no longer carries the "not being applied" note', !bs.capUnwiredNote, String(bs.capUnwiredNote));
check('observed spend is still reported separately', !!bs.observed);
check('the uncappable caveat SURVIVES being wired', /cannot cap charges a provider/.test(bs.uncappableNote),
  'enforcing our own spend does not cap a provider\'s direct billing, and the screen must keep saying so');

section('E8b  every paid path is accounted for');
check('the paid paths are listed', PAID_PATHS.length >= 8, String(PAID_PATHS.length));
check('each says how it is guarded', PAID_PATHS.every((p) => ['withSpend', 'own-cap', 'unreachable'].includes(p.guard)),
  PAID_PATHS.map((p) => p.guard).join(','));
check('each names the module it lives in', PAID_PATHS.every((p) => /^lib\//.test(p.where)));
check('no path is listed without a category', PAID_PATHS.every((p) => !!p.category));

done();
