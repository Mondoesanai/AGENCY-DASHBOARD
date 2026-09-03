// Tiny unguessable token for the public report page, derived from the slug +
// CRON_SECRET. Not high security — just stops the /r/<slug> pages being
// trivially enumerable. If CRON_SECRET is unset (dev), tokens aren't enforced.
import crypto from 'node:crypto';

export function reportToken(slug) {
  const secret = process.env.CRON_SECRET || '';
  if (!secret) return '';
  return crypto
    .createHmac('sha256', secret)
    .update('report:' + slug)
    .digest('base64url')
    .slice(0, 16);
}

export function tokenOk(slug, t) {
  const expected = reportToken(slug);
  if (!expected) return true; // not enforced in dev
  return typeof t === 'string' && t === expected;
}
