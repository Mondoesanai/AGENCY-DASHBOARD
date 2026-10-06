// One pattern library, used by the history audit and the pre-commit hook.
//
// R18.3. The repository is public. Two different questions follow from that,
// and they want the same patterns:
//
//   WHAT IS ALREADY OUT THERE?   `tools/audit-history.mjs` walks every blob in
//                                reachable history. Local cleanup does not undo
//                                publication, so this is about knowing, not fixing.
//   WHAT IS ABOUT TO GO OUT?     `.githooks/pre-commit` scans staged content and
//                                refuses. This is the half that can still help.
//
// THE OUTPUT NEVER CONTAINS A MATCH. Categories, counts, severities and — only
// where it is safe — paths. A scanner that prints the secret it found into a
// terminal, a log or a report has copied it somewhere new.

/** Reserved by RFC 2606 / 6761 so fixtures cannot collide with a real address. */
const RESERVED_TLD = /\.(test|example|invalid|localhost)$/i;
const RESERVED_DOMAIN = /^(.+\.)?(example\.(com|org|net)|localhost)$/i;

/** Free-mail hosts: the normaliser has rules keyed to these, so they are legitimate. */
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com']);

/** Real services the code names as endpoints, not as stand-ins for a person. */
const SERVICE_HOSTS = new Set([
  'api.twilio.com', 'lookups.twilio.com', 'www.twilio.com', 'api.anthropic.com',
  'api.github.com', 'github.com', 'www.googleapis.com', 'oauth2.googleapis.com',
  'gmail.googleapis.com', 'developers.google.com', 'calendly.com', 'api.calendly.com',
  'overpass-api.de', 'www.openstreetmap.org', 'api.search.brave.com',
  'api-dashboard.search.brave.com', 'api.dataforseo.com', 'api.instantly.ai',
  'developer.instantly.ai', 'schema.org', 's.wordpress.com', 'fonts.googleapis.com',
  'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'vercel.com',
  'openapi.vercel.sh', 'inspiringwebsites.org', 'claude.com', 'anthropic.com',
  'resend.com', 'api.resend.com', 'w3.org', 'www.w3.org', 'e.read.ai',
]);

/**
 * Severity is about what an exposure COSTS, not how exotic it is.
 *
 *   critical  a working credential. Someone can act as us until it is rotated.
 *   high      a credential-shaped string that may be live, or a key file.
 *   medium    a real person or business can be identified or contacted.
 *   low       untidy and worth fixing, but nobody is reachable through it.
 */
export const SEVERITY = Object.freeze({ CRITICAL: 'critical', HIGH: 'high', MEDIUM: 'medium', LOW: 'low' });

export const RULES = Object.freeze([
  // --- credentials ---------------------------------------------------------
  { id: 'anthropic-key', severity: SEVERITY.CRITICAL, re: /\bsk-ant-[A-Za-z0-9_-]{24,}/g, what: 'Anthropic API key' },
  { id: 'github-token', severity: SEVERITY.CRITICAL, re: /\bgh[pousr]_[A-Za-z0-9]{36,}/g, what: 'GitHub token' },
  { id: 'resend-key', severity: SEVERITY.CRITICAL, re: /\bre_[A-Za-z0-9]{24,}/g, what: 'Resend API key' },
  { id: 'twilio-sid', severity: SEVERITY.HIGH, re: /\bAC[0-9a-f]{32}\b/g, what: 'Twilio account SID' },
  { id: 'aws-key', severity: SEVERITY.CRITICAL, re: /\bAKIA[0-9A-Z]{16}\b/g, what: 'AWS access key id' },
  { id: 'slack-token', severity: SEVERITY.CRITICAL, re: /\bxox[baprs]-[0-9A-Za-z-]{20,}/g, what: 'Slack token' },
  { id: 'private-key', severity: SEVERITY.CRITICAL, re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, what: 'private key block' },
  { id: 'upstash-token', severity: SEVERITY.CRITICAL, re: /\bA[A-Za-z0-9_-]{6,}=\s*$/gm, what: 'possible Upstash REST token', noisy: true },
  { id: 'bearer', severity: SEVERITY.HIGH, re: /\bBearer\s+[A-Za-z0-9._-]{30,}/g, what: 'bearer token' },
  { id: 'env-assignment', severity: SEVERITY.HIGH, re: /^(?:export\s+)?[A-Z][A-Z0-9_]{6,}\s*=\s*["']?[A-Za-z0-9/+_-]{24,}["']?\s*$/gm, what: 'an environment variable with a long literal value' },

  // --- people and businesses ----------------------------------------------
  { id: 'contactable-email', severity: SEVERITY.MEDIUM, what: 'an email address on a domain somebody could own', custom: 'email' },
  { id: 'real-phone', severity: SEVERITY.MEDIUM, what: 'a phone number outside the 555 range', custom: 'phone' },
]);

/** An address on a domain that is not reserved, not free-mail, not a service. */
function emailHits(text) {
  let n = 0;
  for (const m of text.matchAll(/[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) {
    const d = m[1].toLowerCase().replace(/[.,)'"\];]+$/, '');
    if (RESERVED_TLD.test(d) || RESERVED_DOMAIN.test(d) || FREE_MAIL.has(d) || SERVICE_HOSTS.has(d)) continue;
    n += 1;
  }
  return n;
}

/**
 * A NANP-shaped number outside 555.
 *
 * Deliberately narrow: version strings, byte counts and timestamps are full of
 * ten-digit runs, and a scanner that cries wolf trains people to use --no-verify.
 * Only something punctuated like a phone number counts.
 */
function phoneHits(text) {
  let n = 0;
  for (const m of text.matchAll(/(?:\+1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]([2-9]\d{2})[\s.-](\d{4})\b/g)) {
    if (m[2] === '555') continue;
    n += 1;
  }
  return n;
}

/**
 * Count findings by rule. Returns `[{ id, severity, what, count }]`.
 * NEVER returns the matched text.
 */
export function scanText(text, { skipNoisy = true } = {}) {
  const src = String(text || '');
  const out = [];
  for (const rule of RULES) {
    let count = 0;
    if (rule.custom === 'email') count = emailHits(src);
    else if (rule.custom === 'phone') count = phoneHits(src);
    else if (rule.noisy && skipNoisy) continue;
    else count = (src.match(rule.re) || []).length;
    if (count) out.push({ id: rule.id, severity: rule.severity, what: rule.what, count });
  }
  return out;
}

export const worstOf = (findings) => {
  for (const s of [SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW]) {
    if (findings.some((f) => f.severity === s)) return s;
  }
  return null;
};

/** Paths a scan should not read: binaries, lockfiles, and its own fixtures. */
export const SKIP_PATH = (p) => (
  /\.(png|jpe?g|gif|webp|ico|pdf|zip|woff2?|ttf|mp4|mov)$/i.test(p)
  || /(^|\/)(node_modules|\.git|temporary screenshots)\//.test(p)
  || /package-lock\.json$/.test(p)
  // The scanner and its tests name the shapes they catch on purpose.
  || /(^|\/)tools\/secret-scan\.mjs$/.test(p)
  || /(^|\/)tests\/(public-repo|secret-scan)\.test\.mjs$/.test(p)
);
