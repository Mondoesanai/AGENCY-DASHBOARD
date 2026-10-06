# Preview isolation — the exact configuration change

**Status: NOT applied.** This is the prepared change; nothing in Vercel has been
touched. Until it is applied, every non-production deployment refuses to run
(503) rather than reading or writing live client data.

## What is wrong today

`vercel env ls` on `mondoesanais-projects/agency-dashboard`:

| Variable | Scoped to |
|---|---|
| `KV_URL` | **Production, Preview** |
| `REDIS_URL` | **Production, Preview** |
| `KV_REST_API_URL` | **Production, Preview** |
| `KV_REST_API_TOKEN` | **Production, Preview** |
| `KV_REST_API_READ_ONLY_TOKEN` | **Production, Preview** |
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | **Production, Preview** |
| `CRON_SECRET` | Production only |
| everything else (Anthropic, Resend, GitHub, Google, PageSpeed) | Production only |

So a preview deployment gets the **live database**. `CRON_SECRET` being
Production-only means the gated admin surface is already `locked` there — but
five entry points are public and every one of them writes:

| Entry point | Auth | Store | Provider side effect |
|---|---|---|---|
| `api/admin.js` | gate | write | yes |
| `api/audit.js` | **none** | write | yes |
| `api/card.js` | **none** | write | yes |
| `api/collect.js` | **none** (6 public hooks) | write | yes |
| `api/cron-daily.js` | gate | write | yes |
| `api/finances.js` | gate | write | yes |
| `api/public-report.js` | **none** | write | yes |
| `api/report.js` | gate | write | yes |
| `api/shot.js` | **none** | write | no |
| `api/site.js` | gate | write | yes |
| `api/sites.js` | gate | write | yes |
| `api/t.js` | none | **none** | serves a script |

## What the code does about it now

`lib/environment.js` classifies the deployment from Vercel's own variables and
`guardSharedStore(req, res)` is the first line of all eleven store-touching
handlers (`api/t.js` is exempt and touches no store).

* **production** → allowed. It is the live environment.
* **local** (no `VERCEL`/`VERCEL_ENV`) → allowed. In-memory or the developer's own.
* **preview / development** → **503**, with the reason and the owner action.
* **preview with `PREVIEW_KV_ISOLATED=1`** → allowed.

Isolation is **opt-in and never inferred**. Comparing KV URLs to guess whether a
store looks different is the kind of reasoning that is right until the day it is
not, and being wrong means writing to live client data.

`tests/preview-guard.test.mjs` asserts every `api/` file calls the guard and
calls it first, so a new endpoint cannot be added without one.

## The change to make, in order

1. **Create a separate KV store for Preview.**
   Vercel dashboard → Storage → Create → KV. Name it something unmistakable,
   e.g. `agency-dashboard-preview`.

2. **Connect it to the Preview environment ONLY.**
   On the new store → Projects → connect `agency-dashboard` → tick **Preview**
   only. Vercel will offer to add `KV_URL`, `REDIS_URL`, `KV_REST_API_URL`,
   `KV_REST_API_TOKEN` and `KV_REST_API_READ_ONLY_TOKEN` for Preview.

3. **Remove the Preview scope from the production KV variables.**
   Settings → Environment Variables → for each of the five KV variables that
   currently reads "Production, Preview", edit it to **Production only**.
   *Do this after step 2*, or Preview will have no store at all between the two.

4. **Narrow the paid provider credentials.**
   `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` are Preview-scoped. A preview
   deployment can spend real rank-tracking credits. Either remove the Preview
   scope, or add separate sandbox credentials for Preview.

5. **Only then, turn the guard off for Preview.**
   Settings → Environment Variables → add `PREVIEW_KV_ISOLATED` = `1`, scoped to
   **Preview only**. Never add it to Production: there it means nothing, and a
   stray copy in Production is a variable that looks like it did something.

6. **Verify before trusting it.** On a preview deployment, open
   `/api/admin?do=automation-status`. It should answer rather than 503. Then
   check the production dashboard still shows the same client count it did
   before — a preview writing to production would show up there.

## What this does NOT fix

`CRON_SECRET` stays Production-only, so the admin surface remains `locked` on
Preview. That is correct and should not change: a preview deployment of a
dashboard holding client financials has no business being readable.

The tick (`auto-poke`) stays production-only **even with an isolated Preview**,
because it does real work on a schedule and a second scheduler running against a
second store is a confusion with no upside.
