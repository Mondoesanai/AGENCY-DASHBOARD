// R11.7 — safe logging.
//
// Secrets reach logs by accident, not by design. Nobody writes
// `console.log(apiKey)`. What happens is someone logs a whole object for
// debugging — a request, a config, an error from a provider whose message
// helpfully includes the Authorization header — and it ends up in a log that is
// kept for months and read by whoever can see the deployment.
//
// So redaction operates on SHAPE as well as on known names: anything that looks
// like a key, a token, a bearer header or a password is masked wherever it
// appears, however deeply nested, and the masking is lossy on purpose. A
// redacted value keeps only enough to recognise WHICH secret it was — never
// enough to use it.

const SECRET_KEYS = [
  /^authorization$/i,
  /^cookie$/i,
  /^set-cookie$/i,
  /secret$/i,
  /^secret/i,
  /api[-_]?key/i,
  /^token$/i,
  /[-_]token$/i,
  /^password$/i,
  /^passwd$/i,
  /^pwd$/i,
  /signing[-_]?key/i,
  /webhook[-_]?key/i,
  /^cron[-_]?secret$/i,
  /refresh[-_]?token/i,
  /client[-_]?secret/i,
  /private[-_]?key/i,
];

// Values that are obviously credentials whatever the key is called.
const SECRET_VALUE_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi,
  /\bsk-[A-Za-z0-9_-]{12,}/g, // OpenAI/Anthropic-style
  /\bre_[A-Za-z0-9_-]{12,}/g, // Resend
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bAC[a-f0-9]{30,}/g, // Twilio SID
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/** Mask a value, keeping only enough to tell WHICH secret it was. */
export function mask(value) {
  const s = String(value ?? '');
  if (!s) return '[redacted]';
  if (s.length <= 8) return '[redacted]';
  return `[redacted:${s.slice(0, 3)}…${s.length}chars]`;
}

function isSecretKey(key) {
  return SECRET_KEYS.some((re) => re.test(String(key)));
}

/** Redact secret-looking substrings inside a free-text string. */
export function redactText(text) {
  let out = String(text ?? '');
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, (m) => mask(m));
  // query-string secrets: ?secret=abc, &api_key=abc, &token=abc
  out = out.replace(/([?&](?:secret|token|api[-_]?key|password|key)=)([^&\s"']+)/gi, (_, p, v) => p + mask(v));
  return out;
}

/**
 * Deep-redact any value before it is logged.
 * Handles cycles, because an Error with a `request` property that points back
 * at itself is exactly the kind of object people log while debugging.
 */
export function redact(value, { depth = 0, seen = new WeakSet() } = {}) {
  if (depth > 8) return '[too deep]';
  if (value == null) return value;

  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'function') return '[function]';

  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: redactText(value.stack || '').split('\n').slice(0, 3).join('\n') };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, { depth: depth + 1, seen }));

    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? mask(v) : redact(v, { depth: depth + 1, seen });
    }
    return out;
  }
  return String(value);
}

/**
 * The logger everything should use.
 * Deliberately thin: its only job is to make the unsafe thing hard to do.
 */
export function safeLog(...args) {
  console.log(...args.map((a) => (typeof a === 'string' ? redactText(a) : redact(a))));
}

export function safeError(...args) {
  console.error(...args.map((a) => (typeof a === 'string' ? redactText(a) : redact(a))));
}

/**
 * Does this text contain anything that looks like a live credential?
 * Used by the audit test, so "no secrets in logs" is checked rather than hoped.
 */
export function containsSecret(text) {
  const s = String(text ?? '');
  const hits = [];
  for (const re of SECRET_VALUE_PATTERNS) {
    const m = s.match(re);
    if (m) hits.push(...m.map((x) => x.slice(0, 12) + '…'));
  }
  // `?secret=${encodeURIComponent(key)}` is a URL being BUILT from a variable,
  // not a credential sitting in the source. Flagging it would train people to
  // ignore this check, which is worse than not having it.
  const q = s.match(/[?&](?:secret|token|api[-_]?key|password)=([^&\s"'`]+)/gi) || [];
  for (const hit of q) {
    const value = hit.split('=').slice(1).join('=');
    if (/^\$\{/.test(value) || /^\+/.test(value) || value === '') continue; // interpolated or concatenated
    hits.push(hit);
  }
  return { clean: hits.length === 0, hits };
}
