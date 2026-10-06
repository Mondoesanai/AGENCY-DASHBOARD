// Which deployment is this, and is it safe to touch the store?
//
// R18.2. `vercel env ls` shows KV_URL, REDIS_URL and the three KV_REST_API_*
// variables scoped to **Production AND Preview**. So a preview deployment does
// not get a sandbox — it gets the live database, with real clients, real
// contacts, real consent records, real spend counters and the real job queue.
//
// The inventory that prompted this (api/ as Vercel mounts it):
//
//   api/admin.js          gate              WRITE   provider side effects
//   api/audit.js          PUBLIC            WRITE   provider side effects
//   api/card.js           PUBLIC            WRITE   provider side effects
//   api/collect.js        PUBLIC hooks      WRITE   provider side effects
//   api/cron-daily.js     gate              WRITE   provider side effects
//   api/finances.js       gate              WRITE   provider side effects
//   api/public-report.js  PUBLIC            WRITE   provider side effects
//   api/report.js         gate              WRITE   provider side effects
//   api/shot.js           PUBLIC            WRITE   no
//   api/site.js           gate              WRITE   provider side effects
//   api/sites.js          gate              WRITE   provider side effects
//   api/t.js              PUBLIC            none    yes (serves a script)
//
// The gated ones are already refused on Preview, because CRON_SECRET is
// Production-only and `authMode()` is therefore `locked` there. The problem is
// the five PUBLIC ones: audit, card, collect, public-report and shot have no
// authentication at all — correctly, for what they do — and every one of them
// writes. On a preview deployment they write to production.
//
// WHY THE GUARD IS AT THE ENTRY POINT AND NOT IN lib/store.js.
// The store would be the tidier place, and it was the first instinct. But this
// codebase reads the store with `.catch(() => null)` in dozens of places, by
// design, so that one unreadable key cannot take a page down. A refusal thrown
// from inside the store would be swallowed by exactly those handlers and turn
// into a silent empty result — the "looks healthy while nothing works" failure
// this project keeps finding. At the entry point the refusal is a response
// nobody can swallow, and `tests/preview-guard.test.mjs` asserts that every
// file in api/ calls it, so a new endpoint cannot be added without one.

/** 'production' | 'preview' | 'development' | 'local' */
export function deploymentEnv(env = process.env) {
  if (!env.VERCEL && !env.VERCEL_ENV) return 'local';
  return env.VERCEL_ENV || 'preview';
}

/**
 * Environments that may touch the live store: production because it IS live,
 * local because it uses an in-memory store or the developer's own.
 *
 * Exported because `api/admin.js` needs the same classification for `auto-poke`
 * and two copies of "is this production" is how the two answers drift apart.
 */
export const MAY_TOUCH_LIVE = Object.freeze(['production', 'local']);

/**
 * Has the owner given this non-production deployment its own store?
 *
 * Opt-IN, and deliberately not inferred. It would be possible to compare the
 * KV URL against a known production one and guess — but a guess that says
 * "this looks like a different database" is exactly the kind of reasoning that
 * is right until the day it is not, and the cost of being wrong is writing to
 * live client data. The owner sets the flag when they have actually done it.
 */
export const previewIsolated = (env = process.env) => env.PREVIEW_KV_ISOLATED === '1';

/**
 * May this process touch the shared store?
 *
 * Returns `{ ok }` or `{ ok: false, reason, ownerAction }`. Production and
 * local always pass: production IS the live environment, and local uses an
 * in-memory store or the developer's own.
 */
export function storeAccess(env = process.env) {
  const where = deploymentEnv(env);
  if (MAY_TOUCH_LIVE.includes(where)) return { ok: true, env: where };
  if (previewIsolated(env)) return { ok: true, env: where, isolated: true };
  return {
    ok: false,
    env: where,
    reason: `This is a ${where} deployment and it shares the production database. `
      + 'It is refusing rather than reading or writing live client data.',
    ownerAction: 'Give Preview its own KV store in the Vercel dashboard, then set PREVIEW_KV_ISOLATED=1 '
      + 'for the Preview environment only.',
  };
}

/**
 * The one line every `api/` handler calls first.
 *
 * Returns true when it has already answered the request, so the handler can
 * `if (guardSharedStore(req, res)) return;` and stop.
 *
 * 503, not 403: the deployment is temporarily unfit, not the caller forbidden.
 */
export function guardSharedStore(req, res, { env = process.env } = {}) {
  const access = storeAccess(env);
  if (access.ok) return false;
  try {
    res.status(503).json({
      ok: false,
      error: access.reason,
      ownerAction: access.ownerAction,
      environment: access.env,
      // Said explicitly: this is not a fault in the code being previewed.
      note: 'Nothing is wrong with this build. It is refusing to run against the live database.',
    });
  } catch { /* a response that cannot be sent is still a refusal */ }
  return true;
}
