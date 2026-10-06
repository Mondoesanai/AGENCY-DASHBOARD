// Every model call in this codebase, through one door.
//
// R16.1. There were twelve places that did `new Anthropic({ apiKey })` and then
// `client.messages.create(...)`, each computing its own cost with its own copy
// of the rate table. Twelve places to remember a budget check is twelve places
// to forget one, and the forgetting is not hypothetical: the entire central cap
// had no caller at all.
//
// So this is the chokepoint. `aiClient()` returns something shaped like the SDK
// client — it has `.messages.create()` — and callers are otherwise unchanged.
// What they get for free:
//
//   * the call is wrapped in `withSpend`, so it reserves before it runs and
//     reconciles after;
//   * the ACTUAL cost is computed from `usage` and reported, so the ledger
//     settles on the provider's own token counts rather than on a guess;
//   * a refusal throws `BudgetRefusedError`, which the existing try/catch at
//     every call site already handles — the work stops, loudly, in the place
//     that was already written to cope with the model being unavailable.
//
// `tests/spend-exempt.test.mjs` fails if any file other than this one imports
// the Anthropic SDK, so a thirteenth call site cannot quietly appear outside
// the budget.
//
// ON THE RATES. They live here once instead of in six files. An unknown model
// is priced at the HIGHEST known rate rather than a default or a zero, because
// the direction of a pricing mistake matters: over-booking is corrected by the
// next reconcile, while under-booking silently raises the real cap.

import { withSpend } from './spend-guard.js';

/** USD per million tokens, [input, output]. Longest matching prefix wins. */
export const RATES = Object.freeze({
  haiku: [1, 5],
  sonnet: [3, 15],
  opus: [15, 75],
});
const HIGHEST = [15, 75];

export function ratesFor(model = '') {
  const m = String(model).toLowerCase();
  for (const [name, r] of Object.entries(RATES)) if (m.includes(name)) return r;
  return HIGHEST;
}

/**
 * What a response actually cost, from the provider's own token counts.
 *
 * Cache writes bill at 1.25x input and cache reads at 0.1x; both are counted
 * because a long cached prompt is most of the bill on the agent path.
 */
export function costOf(usage = {}, model = '') {
  const [inRate, outRate] = ratesFor(model);
  const u = usage || {};
  return +(
    ((u.input_tokens || 0) / 1e6) * inRate
    + ((u.cache_creation_input_tokens || 0) / 1e6) * inRate * 1.25
    + ((u.cache_read_input_tokens || 0) / 1e6) * inRate * 0.1
    + ((u.output_tokens || 0) / 1e6) * outRate
  ).toFixed(5);
}

/**
 * A rough cost before the call, for the reservation.
 *
 * Reserving needs a number before any tokens exist, so this is deliberately
 * pessimistic: it assumes `max_tokens` output in full and prices the prompt by
 * length. A reservation that is too large refuses slightly too early; one that
 * is too small lets work past the cap, which is the failure that matters.
 */
export function estimateFor({ model = '', max_tokens = 1024, system = '', messages = [] } = {}) {
  const [inRate, outRate] = ratesFor(model);
  const text = [system, ...(messages || []).map((m) => (typeof m.content === 'string'
    ? m.content
    : (m.content || []).map((c) => c.text || '').join(' ')))].join(' ');
  const inTok = Math.ceil(text.length / 3.5); // conservative: ~3.5 chars/token
  return +((inTok / 1e6) * inRate + (max_tokens / 1e6) * outRate).toFixed(5);
}

export class BudgetRefusedError extends Error {
  constructor(reason) {
    super(`refused by the spending limit: ${reason}`);
    this.name = 'BudgetRefusedError';
    this.budgetRefused = true;
    // Nothing was sent, so a retry is safe and the guard must not book it.
    this.preflight = true;
  }
}

export class SpendUncertainError extends Error {
  constructor(reason) {
    super(`the model call's outcome is unknown: ${reason}`);
    this.name = 'SpendUncertainError';
    this.spendUncertain = true;
  }
}

let sdkLoader = () => import('@anthropic-ai/sdk');
/** Tests swap the SDK here rather than reaching the network. */
export function __setSdkLoader(fn) { sdkLoader = fn; }

/**
 * A budget-guarded Anthropic client.
 *
 * `category` must be one of lib/budget.js's CATEGORIES. `essential: true` is for
 * work that must continue when discretionary spend is exhausted — classifying
 * an inbound reply, handling an opt-out, monitoring. It is still recorded.
 */
export async function aiClient({
  apiKey,
  category = 'ai',
  jobId = null,
  essential = false,
  conversational = false,
  meta = {},
  // Forwarded straight to the SDK constructor. The report path sets
  // `maxRetries: 0` and a hard timeout because a model call still running when
  // the serverless function is killed means the client's email never sends.
  clientOptions = {},
} = {}) {
  const { default: Anthropic } = await sdkLoader();
  const real = new Anthropic({ ...(apiKey ? { apiKey } : {}), ...clientOptions });

  return {
    _real: real,
    messages: {
      async create(params) {
        const estimateUsd = estimateFor(params);
        const out = await withSpend(
          { category, estimateUsd, jobId, essential, conversational, meta: { ...meta, model: params.model } },
          async (ctx) => {
            const r = await real.messages.create(params);
            ctx.reportCost(costOf(r.usage, params.model));
            return r;
          },
        );

        if (out.refused) throw new BudgetRefusedError(out.reason);
        if (out.uncertain) throw new SpendUncertainError(out.reason);
        // A replayed job id is never called again, and responses are not
        // retained — so there is no answer to hand back. Say that plainly
        // rather than returning null, which would read as an empty reply from
        // the model. Pass a `jobId` only where not getting the result back is
        // acceptable: retry protection on background work, not a live answer.
        if (out.replayed) {
          throw new SpendUncertainError(
            `${out.reason}. The response was not retained, so there is nothing to return. `
            + 'Use a fresh job id for a call whose result you need.',
          );
        }
        return out.result;
      },
    },
  };
}
