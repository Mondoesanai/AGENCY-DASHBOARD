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
// ON STORE FAILURE IT REPORTS `degraded` AND LETS THE CALLER DECIDE.
//
// An earlier version of this file failed open and justified it as "a KV outage
// must not take the opt-out and opt-in paths down with it". That reasoning was
// wrong, and the mistake is worth leaving written down: opt-out ingestion does
// not pass through here at all. STOP arrives at `/api/collect?hook=sms`, which
// is not rate-limited by anything. The only caller is the public ENROLMENT
// endpoint. So failing open never protected anyone's ability to opt out — it
// only made it easier to enrol new numbers during an outage, which is the one
// moment when nothing can be checked properly.
//
// Policy now lives at the caller, because the right answer differs by path:
// enrolment fails CLOSED (see api/collect.js), while a hypothetical future
// caller on a safety path could choose otherwise and say why.

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
  } catch (e) {
    // `ok` is deliberately NOT true here. A caller that ignores `degraded` and
    // reads only `ok` would otherwise treat an outage as a clean pass, which is
    // exactly the bug this file used to have.
    return {
      ok: false, degraded: true, count: null, remaining: null, resetSec: windowSec,
      reason: `the rate-limit store could not be read (${String(e?.message || e).slice(0, 80)})`,
    };
  }
}
