// R6.9 — an unsubscribe that actually works.
//
// The messages already carried a real name, a real business and a real postal
// address, and a line saying "reply with STOP". A reply-based mechanism is
// permitted under CAN-SPAM and the STOP path is genuinely wired. It is not
// enough on its own, for two reasons:
//
//   * It asks the recipient to compose an email to stop hearing from someone
//     they did not ask to hear from. The easier the mechanism, the fewer spam
//     complaints, and complaints are what kill a sending domain.
//   * Since February 2024, Gmail and Yahoo require bulk senders to provide
//     `List-Unsubscribe` **and** `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
//     (RFC 8058). Without them, cold mail to Gmail addresses is filtered
//     regardless of what the body says.
//
// Three rules the implementation has to keep:
//
//  1. A link must not let one person unsubscribe another. The token is an HMAC
//     over the address, so it cannot be guessed or edited into someone else's.
//  2. GET must not unsubscribe. Mail clients and security scanners fetch links
//     in messages; if GET performed the action, scanners would silently opt
//     people out and the owner would never know why their list went quiet.
//     GET shows a page with a button; POST performs — which is also exactly
//     what RFC 8058 one-click sends.
//  3. It has to keep working. The suppression is keyed on the ADDRESS, not on
//     the campaign or the contact record, so it survives the campaign being
//     deleted, the contact being erased, and the thirty-day window CAN-SPAM
//     requires the mechanism to remain live for.

import crypto from 'node:crypto';
import { store } from './store.js';

/** Addresses are compared lowercased and trimmed, like everywhere else. */
export function normAddress(a) {
  return String(a || '').trim().toLowerCase();
}

function secret(env = process.env) {
  // Falls back to the admin secret so the mechanism works on a deployment that
  // has not set a dedicated key. It never falls back to a constant: a
  // predictable token would let anyone unsubscribe anyone.
  return env.UNSUBSCRIBE_SECRET || env.CRON_SECRET || '';
}

/**
 * A token tied to one address. Not a secret the recipient must keep — it is in
 * their inbox — but one they cannot alter to affect a different person.
 */
export function makeToken(address, env = process.env) {
  const key = secret(env);
  const addr = normAddress(address);
  if (!key || !addr) return null;
  return crypto.createHmac('sha256', key).update(addr).digest('base64url').slice(0, 32);
}

export function verifyToken(address, token, env = process.env) {
  const expected = makeToken(address, env);
  if (!expected || !token) return false;
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(token));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** The link that goes in the message and in the headers. */
export function unsubscribeUrl(address, { env = process.env, baseUrl = null } = {}) {
  const base = (baseUrl || env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const token = makeToken(address, env);
  if (!base || !token) return null;
  return `${base}/api/collect?unsub=1&e=${encodeURIComponent(normAddress(address))}&t=${token}`;
}

/**
 * The headers Gmail and Yahoo require of bulk senders.
 *
 * `List-Unsubscribe-Post` is what makes the mail client's own unsubscribe
 * button do the work without the recipient visiting anything — and it is the
 * reason GET must not perform the action, since the same URL is also fetched
 * by scanners.
 */
export function unsubscribeHeaders(address, opts = {}) {
  const url = unsubscribeUrl(address, opts);
  const replyTo = opts.replyTo || null;
  if (!url && !replyTo) return {};
  const parts = [];
  if (url) parts.push(`<${url}>`);
  if (replyTo) parts.push(`<mailto:${replyTo}?subject=unsubscribe>`);
  const headers = { 'List-Unsubscribe': parts.join(', ') };
  // one-click only means anything when there is a URL to post to
  if (url) headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  return headers;
}

/** The line in the body. A link where one is possible, words where it is not. */
export function unsubscribeLine(address, { env = process.env, baseUrl = null, fallback = '' } = {}) {
  const url = unsubscribeUrl(address, { env, baseUrl });
  if (!url) return fallback || "Reply with STOP and I won't contact you again.";
  return `Don't want to hear from me again? ${url} — or just reply with STOP.`;
}

export const RESULT = Object.freeze({
  DONE: 'unsubscribed',
  ALREADY: 'already-unsubscribed',
  BAD_TOKEN: 'bad-token',
  NO_ADDRESS: 'no-address',
  NOT_CONFIGURED: 'not-configured',
});

/**
 * Perform the unsubscribe. Called from the POST path only.
 *
 * Suppression is recorded against the ADDRESS first and the contact second, in
 * that order and deliberately: if the contact write fails, the address is still
 * suppressed and nothing will be sent to it. The reverse order could mark a
 * contact as opted out while leaving the address sendable.
 */
export async function handleUnsubscribe({ address, token, env = process.env, source = 'one-click' }) {
  const addr = normAddress(address);
  if (!addr) return { ok: false, result: RESULT.NO_ADDRESS, message: 'No address was given.' };
  if (!secret(env)) {
    return { ok: false, result: RESULT.NOT_CONFIGURED, message: 'Unsubscribe is not configured on this deployment.' };
  }
  if (!verifyToken(addr, token, env)) {
    return { ok: false, result: RESULT.BAD_TOKEN, message: 'That link is not valid for this address.' };
  }

  const already = await isSuppressed(addr);

  // 1. the address — this is what the send gate checks
  await store.set(`suppress:email:${addr}`, JSON.stringify({ at: new Date().toISOString(), reason: `unsubscribed (${source})` })).catch(() => {});

  // 2. the contact record, if there is one. Best effort: the suppression above
  //    is what actually stops mail, so a failure here must not fail the request.
  let contacts = 0;
  try {
    const { optOut } = await import('./contacts.js');
    const out = await optOut({ email: addr, reason: `unsubscribed (${source})`, channel: 'email' });
    contacts = (out?.touched || []).length || 0;
  } catch { /* the address is already suppressed */ }

  // 3. drop anything queued for them, so nothing in flight still goes
  let cancelled = 0;
  try {
    const { findDuplicates } = await import('./contacts.js');
    const matches = await findDuplicates({ email: addr });
    const exact = (matches || []).find((m) => m.certainty === 'exact')?.contact;
    if (exact) {
      const { stopContact } = await import('./campaigns.js');
      const stopped = await stopContact(exact.id, 'unsubscribed');
      cancelled = stopped?.totalCancelled || 0;
    }
  } catch { /* suppression already prevents the send */ }

  return {
    ok: true,
    result: already ? RESULT.ALREADY : RESULT.DONE,
    address: addr,
    contactsUpdated: contacts,
    cancelledSends: cancelled,
    message: already
      ? 'You were already unsubscribed. Nothing further will be sent.'
      : 'Done — you will not be emailed again.',
  };
}

export async function isSuppressed(address) {
  const addr = normAddress(address);
  if (!addr) return false;
  try {
    return !!(await store.get(`suppress:email:${addr}`));
  } catch {
    // An unreadable suppression list must not read as "not suppressed": that
    // would send mail to someone who asked us to stop. Callers treat `true`
    // as "do not send", so failing closed is the safe direction.
    return true;
  }
}

/** The page a human sees when they click the link. GET never unsubscribes. */
export function confirmPage({ address, token, done = false, message = '', ok = true }) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const body = done
    ? `<h1>${ok ? 'Unsubscribed' : 'Could not unsubscribe'}</h1><p>${esc(message)}</p>`
    : `<h1>Unsubscribe</h1>
       <p>Confirm that <strong>${esc(address)}</strong> should not be emailed again.</p>
       <form method="POST" action="/api/collect?unsub=1">
         <input type="hidden" name="e" value="${esc(address)}" />
         <input type="hidden" name="t" value="${esc(token)}" />
         <button type="submit">Unsubscribe me</button>
       </form>
       <p class="small">This page does not unsubscribe you on its own — nothing happens until you press the button.
       That is deliberate: mail scanners open links in messages, and if opening one were enough,
       people would be unsubscribed without ever asking.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Unsubscribe</title>
    <style>
      body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1311;color:#f6f9f6;
        margin:0;display:grid;place-items:center;min-height:100vh;padding:24px;}
      main{max-width:34rem;background:#1a221e;border:1px solid #3a463f;border-radius:14px;padding:28px 30px;}
      h1{font-size:22px;margin:0 0 10px;}
      p{color:#c2ccc5;margin:0 0 12px;}
      .small{font-size:13px;color:#93a099;}
      button{font:inherit;background:#46a878;color:#0f1311;border:0;border-radius:9px;padding:11px 18px;
        cursor:pointer;min-height:44px;}
      button:hover{background:#77dbaa;}
      button:focus-visible{outline:2px solid #77dbaa;outline-offset:2px;}
    </style></head><body><main>${body}</main></body></html>`;
}
