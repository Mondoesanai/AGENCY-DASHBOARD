// A ceiling on public writes.
//
// R17.2. `/api/collect?hook=optin` accepts a phone number from anybody on the
// internet. Without a limit that is two things at once: a way to fill KV with
// pending records, and a way to repeatedly target the number of a person
// somebody dislikes. Neither needs skill or an account.
//
// A fixed window, not a sliding one. A sliding window needs a list of
// timestamps per key, which is more storage and more read-modify-write on a
// path that is already the one being abused. A fixed window lets a burst
// straddle a boundary — at most 2x the limit across two adjacent windows — and
// that is an acceptable trade here, where the limit exists to stop sustained
// abuse rather than to meter anything precisely.
//
// FAILS OPEN, deliberately and narrowly. If the store cannot be read the
// request is allowed, because a KV outage must not take the opt-out and opt-in
// paths down with it: somebody trying to stop hearing from us matters more than
// a rate limit. The one place this would be the wrong trade is a path that
// spends money or sends a message, and this is neither — a pending record
// grants nothing and sends nothing.

import { store } from './store.js';

/**
 * Count one request against `key`. Returns `{ ok, remaining, resetSec }`.
 *
 * The counter is an atomic INCR with a TTL set on first use, so two concurrent
 * requests cannot both read "0 so far" and both be allowed.
 */
export async function rateLimit(key, { max = 10, windowSec = 3600, now = Date.now() } = {}) {
  const bucket = Math.floor(now / 1000 / windowSec);
  const k = `rl:${key}:${bucket}`;
  try {
    const n = Number(await store.incr(k, 1)) || 0;
    // Set the expiry once, on the increment that created the key. A TTL re-set
    // on every hit would let a steady stream keep the window alive for ever.
    if (n === 1) await store.set(k, String(n), { ex: windowSec + 5 }).catch(() => {});
    const resetSec = (bucket + 1) * windowSec - Math.floor(now / 1000);
    return { ok: n <= max, count: n, remaining: Math.max(0, max - n), resetSec };
  } catch {
    // See the header: a store failure must not block somebody trying to opt in
    // or out. Reported so a caller can log it rather than assume a clean pass.
    return { ok: true, degraded: true, count: 0, remaining: max, resetSec: windowSec };
  }
}
