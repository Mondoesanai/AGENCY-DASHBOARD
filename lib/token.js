// Tiny unguessable token for the public report page, derived from the slug +
// CRON_SECRET. Not high security — just stops the /r/<slug> pages being
// trivially enumerable. If CRON_SECRET is unset (dev), tokens aren't enforced.
import crypto from 'node:crypto';
import { isDeployed } from './auth.js';

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
  // Same fail-open shape the admin gates had: with no CRON_SECRET this returned
  // true for every request. Harmless locally, but on a deployment missing the
  // variable it would have made every client's report page readable by slug
  // alone. Unenforced only when we are genuinely not deployed.
  if (!expected) return !isDeployed();
  return typeof t === 'string' && t === expected;
}
