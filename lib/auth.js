// One authorization gate for every admin endpoint (R11.7, R1.8).
//
// WHAT WAS WRONG
// --------------
// Five endpoints each carried their own copy of:
//
//     const s = process.env.CRON_SECRET;
//     if (!s) return true;              // <-- fail OPEN
//
// So if CRON_SECRET were ever missing — a typo, a new Vercel environment, a
// preview deployment that never got the variable, someone rotating it badly —
// the entire admin surface would quietly become public. Not an error, not a
// warning: every request authorised, including the finances endpoint. Five
// copies also meant five places to get a future fix wrong.
//
// THE RULE NOW
// ------------
//   secret set              -> enforced  (normal operation)
//   no secret, deployed     -> LOCKED, every admin request denied
//   no secret, not deployed -> open, so local development and tests work
//
// Deployed is detected from Vercel's own VERCEL / VERCEL_ENV variables, which
// the platform always sets. The point is that the unsafe state is now
// unreachable in production: with no secret the dashboard stops working, which
// is noisy and recoverable, instead of silently serving client financials to
// anyone who guesses the URL.
import crypto from 'node:crypto';

function eq(a, b) {
  const A = Buffer.from(String(a ?? ''), 'utf8');
  const B = Buffer.from(String(b ?? ''), 'utf8');
  // compare lengths first; timingSafeEqual throws on a length mismatch
  if (A.length !== B.length || A.length === 0) return false;
  return crypto.timingSafeEqual(A, B);
}

export function isDeployed() {
  return !!(process.env.VERCEL || process.env.VERCEL_ENV);
}

/** 'enforced' | 'locked' | 'open' — exposed so health checks can report it. */
export function authMode() {
  if (process.env.CRON_SECRET) return 'enforced';
  return isDeployed() ? 'locked' : 'open';
}

export function authed(req) {
  const mode = authMode();
  if (mode === 'locked') return false;
  if (mode === 'open') return true;

  const secret = process.env.CRON_SECRET;
  const header = req?.headers?.authorization || '';
  return (
    eq(header, `Bearer ${secret}`) ||
    eq(req?.query?.secret, secret) ||
    eq(req?.body?.secret, secret)
  );
}

/** Why a request was refused, in words the dashboard can show. */
export function authError() {
  return authMode() === 'locked'
    ? 'This deployment has no CRON_SECRET set, so every admin request is refused. Set it in the Vercel project settings.'
    : 'bad password';
}
