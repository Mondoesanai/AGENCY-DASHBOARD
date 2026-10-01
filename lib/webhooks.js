// R11.5 — one discipline for every webhook.
//
// Booking webhooks already verify their signature. The problem with leaving it
// there is that the NEXT webhook — delivery receipts, bounces, complaints — is
// written by someone in a hurry who copies the handler and not the checks. So
// the rules live here, once, and every inbound webhook goes through them.
//
// Four properties, and all four matter independently:
//
//   SIGNED        an unsigned request is an HTTP request from a stranger.
//   FRESH         a valid signature replayed next week is still a valid
//                 signature. Timestamp tolerance is what stops that.
//   UNIQUE        providers retry. The same event arriving twice must not be
//                 applied twice, even when both copies are perfectly valid.
//   ORDERED       providers do not guarantee order. A cancellation that lands
//                 before its creation must not be undone by the late creation.
//
// Fail closed everywhere: no key configured means nothing is trusted, because
// an unverifiable webhook that is allowed through is strictly worse than one
// that is rejected.

import crypto from 'node:crypto';
import { store } from './store.js';

const SEEN = (scope, id) => `webhook:seen:${scope}:${id}`;
const WATERMARK = (scope, subject) => `webhook:watermark:${scope}:${subject}`;

export const DEFAULT_TOLERANCE_SEC = 300;

/**
 * Verify an HMAC signature over `<timestamp>.<rawBody>`.
 * The shape most providers use; the header parser is pluggable for the rest.
 */
export function verifySignature({
  header,
  rawBody,
  signingKey,
  now = Date.now(),
  toleranceSec = DEFAULT_TOLERANCE_SEC,
  algorithm = 'sha256',
  parse = parseTimestampedHeader,
}) {
  if (!signingKey) {
    return { ok: false, reason: 'no signing key is configured, so no webhook from this provider can be trusted', failClosed: true };
  }
  if (!header) return { ok: false, reason: 'request carried no signature header' };

  const parsed = parse(header);
  if (!parsed || !parsed.timestamp || !parsed.signature) {
    return { ok: false, reason: 'signature header is malformed' };
  }

  const ageSec = Math.abs(now / 1000 - Number(parsed.timestamp));
  if (!Number.isFinite(ageSec) || ageSec > toleranceSec) {
    return {
      ok: false,
      replay: true,
      reason: `signature timestamp is ${Math.round(ageSec)}s from now, outside the ${toleranceSec}s window — a valid signature replayed later is still a valid signature, which is what this check is for`,
    };
  }

  const expected = crypto.createHmac(algorithm, signingKey).update(`${parsed.timestamp}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(parsed.signature), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature does not match the body' };
  }
  return { ok: true };
}

/** `t=1699999999,v1=abc...` — Calendly, Stripe and several others. */
export function parseTimestampedHeader(header) {
  const parts = Object.fromEntries(
    String(header)
      .split(',')
      .map((p) => p.trim().split('='))
      .filter((kv) => kv.length === 2)
  );
  return { timestamp: parts.t, signature: parts.v1 };
}

/** A bare hex HMAC with no timestamp — still verified, but cannot be fresh-checked. */
export function parseBareHeader(header) {
  const sig = String(header).replace(/^sha256=/i, '').trim();
  return { timestamp: null, signature: sig };
}

/**
 * Has this exact event been applied before?
 * Returns `{ fresh: false }` for a replay, so the caller returns 200 — a
 * provider that gets an error will keep retrying the duplicate forever.
 */
export async function claimEventOnce(scope, eventId, { ttlDays = 90, now = Date.now() } = {}) {
  if (!eventId) return { fresh: false, reason: 'the event carried no id, so it cannot be de-duplicated — refusing rather than risking a double apply' };
  const key = SEEN(scope, eventId);
  const already = await store.get(key).catch(() => null);
  if (already) return { fresh: false, reason: 'this event was already processed', firstSeenAt: Number(already) || null };
  await store.set(key, String(now), { ex: 60 * 60 * 24 * ttlDays });
  return { fresh: true };
}

/**
 * Out-of-order protection, per subject (per booking, per message, per contact).
 *
 * A watermark, not a lock: an event older than what we have already applied is
 * ignored. This is the difference between "the cancellation arrived late" and
 * "the cancellation was undone by a late creation".
 */
export async function isNewer(scope, subject, stamp, { now = Date.now() } = {}) {
  const key = WATERMARK(scope, subject);
  const prev = Number(await store.get(key).catch(() => 0)) || 0;
  const s = Number(stamp) || now;
  if (s < prev) {
    return { newer: false, reason: `a newer update for this record is already applied (${new Date(prev).toISOString()} > ${new Date(s).toISOString()})`, appliedAt: prev };
  }
  await store.set(key, String(s));
  return { newer: true };
}

/**
 * The whole discipline in one call, so a new webhook handler cannot
 * accidentally implement three of the four checks.
 */
export async function acceptWebhook({
  scope,
  header,
  rawBody,
  signingKey,
  eventId,
  subject = null,
  stamp = null,
  now = Date.now(),
  toleranceSec = DEFAULT_TOLERANCE_SEC,
  parse = parseTimestampedHeader,
}) {
  const sig = verifySignature({ header, rawBody, signingKey, now, toleranceSec, parse });
  if (!sig.ok) return { accept: false, status: 401, ...sig };

  const once = await claimEventOnce(scope, eventId, { now });
  if (!once.fresh) {
    // 200, not an error: a provider that sees a failure retries the duplicate.
    return { accept: false, status: 200, duplicate: true, reason: once.reason };
  }

  if (subject) {
    const order = await isNewer(scope, subject, stamp, { now });
    if (!order.newer) return { accept: false, status: 200, outOfOrder: true, reason: order.reason };
  }

  return { accept: true, status: 200 };
}
