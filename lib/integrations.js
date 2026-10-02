// R2.9 — an integration is not "connected" because a key exists.
//
// `sendReadiness()` reported `connected: !!env[provider.envKey]`, and the
// health check reports every service the same way: an environment variable is
// present, therefore the integration works. A key can be present and wrong —
// revoked, mistyped, pointed at the wrong account, out of credit — and the
// dashboard would still say connected. That is an invented integration, which
// is exactly what R2.9 forbids.
//
// Three states, and the middle one is the honest one that was missing:
//
//   not-configured  no credential. We know it cannot work.
//   configured      a credential exists and nothing has ever been proven with
//                   it. NOT a claim that it works.
//   working         a real call succeeded, at a time we can name.
//   failing         a real call failed, at a time we can name, and nothing has
//                   succeeded since.
//
// Nothing here upgrades a state by assertion: only `recordSuccess` /
// `recordFailure`, called from the code that actually talked to the provider,
// can move an integration past `configured`.

import { store } from './store.js';

export const STATE = Object.freeze({
  NOT_CONFIGURED: 'not-configured',
  CONFIGURED: 'configured',
  WORKING: 'working',
  FAILING: 'failing',
});

/** How a state should be said out loud. Never "connected" on its own. */
export const STATE_LABEL = Object.freeze({
  'not-configured': 'not set up',
  configured: 'set up, never confirmed',
  working: 'confirmed working',
  failing: 'failing',
});

export const INTEGRATIONS = Object.freeze({
  github: { label: 'GitHub', env: ['GITHUB_TOKEN'], what: 'Ships code changes to client sites.' },
  anthropic: { label: 'AI (Anthropic)', env: ['ANTHROPIC_API_KEY'], what: 'Plans site work, drafts reports and replies.' },
  resend: { label: 'Email (Resend)', env: ['RESEND_API_KEY', 'REPORT_FROM'], what: 'Sends client reports. Not used for outreach.' },
  google: { label: 'Google', env: ['GOOGLE_REFRESH_TOKEN'], what: 'Reads the revision inbox and holds calendar slots.' },
  dataforseo: { label: 'Rank tracking', env: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'], what: 'Checks where client sites rank.' },
  twilio: { label: 'Text messages', env: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'], what: 'Alerts the owner by text.' },
  instantly: { label: 'Cold email', env: ['INSTANTLY_API_KEY'], what: 'Sends outreach. Deliberately separate from client email.' },
  storage: { label: 'Storage', env: ['KV_REST_API_URL'], what: 'Keeps everything between requests.' },
});

const KEY = (name) => `integration:${name}`;

/** Is the credential present? This is the ONLY thing env can tell us. */
export function isConfigured(name, env = process.env) {
  const spec = INTEGRATIONS[name];
  if (!spec) return false;
  return spec.env.every((k) => !!env[k]);
}

/**
 * Record that a real call to this integration succeeded.
 * Called from the code that made the call — never inferred.
 */
export async function recordSuccess(name, { at = Date.now(), detail = '' } = {}) {
  if (!INTEGRATIONS[name]) return { ok: false, error: `unknown integration ${name}` };
  const prev = await readRecord(name);
  const rec = {
    lastEvent: 'success',
    lastSuccessAt: at,
    lastFailureAt: prev.lastFailureAt || null,
    lastError: '',
    consecutiveFailures: 0,
    detail: String(detail).slice(0, 160),
  };
  await store.set(KEY(name), JSON.stringify(rec), { ex: 60 * 60 * 24 * 120 }).catch(() => {});
  return { ok: true, ...rec };
}

/** Record that a real call failed. The error is kept — it is usually the fix. */
export async function recordFailure(name, error, { at = Date.now() } = {}) {
  if (!INTEGRATIONS[name]) return { ok: false, error: `unknown integration ${name}` };
  const prev = await readRecord(name);
  const rec = {
    lastEvent: 'failure',
    lastSuccessAt: prev.lastSuccessAt || null,
    lastFailureAt: at,
    lastError: String(error || 'no detail given').slice(0, 200),
    consecutiveFailures: (prev.consecutiveFailures || 0) + 1,
    detail: prev.detail || '',
  };
  await store.set(KEY(name), JSON.stringify(rec), { ex: 60 * 60 * 24 * 120 }).catch(() => {});
  return { ok: true, ...rec };
}

async function readRecord(name) {
  let raw;
  try {
    raw = await store.get(KEY(name));
  } catch {
    return { unreadable: true };
  }
  if (!raw) return {};
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

/**
 * The honest status of one integration.
 *
 * The rule that makes this worth having: a credential plus no evidence is
 * `configured`, and `configured` is reported as "set up, never confirmed" —
 * not as a tick.
 */
export async function statusOf(name, env = process.env, now = Date.now()) {
  const spec = INTEGRATIONS[name];
  if (!spec) return { name, state: STATE.NOT_CONFIGURED, label: 'unknown integration' };

  const configured = isConfigured(name, env);
  const rec = await readRecord(name);

  if (rec.unreadable) {
    return {
      name, label: spec.label, what: spec.what, configured,
      state: configured ? STATE.CONFIGURED : STATE.NOT_CONFIGURED,
      evidence: 'none — the record of past calls could not be read',
      lastSuccessAt: null, lastFailureAt: null, lastError: '',
    };
  }

  const base = {
    name, label: spec.label, what: spec.what, configured,
    lastSuccessAt: rec.lastSuccessAt || null,
    lastFailureAt: rec.lastFailureAt || null,
    lastError: rec.lastError || '',
    consecutiveFailures: rec.consecutiveFailures || 0,
    missing: spec.env.filter((k) => !env[k]),
  };

  if (!configured) {
    return { ...base, state: STATE.NOT_CONFIGURED, evidence: `missing ${base.missing.join(' and ')}` };
  }
  // Which happened LAST is read from the recorded event, not from comparing
  // two timestamps: a success and a failure in the same millisecond tie, and
  // the tie used to resolve as "working".
  const failedLast = rec.lastEvent
    ? rec.lastEvent === 'failure'
    : !!rec.lastFailureAt && (!rec.lastSuccessAt || rec.lastFailureAt > rec.lastSuccessAt);
  if (rec.lastFailureAt && failedLast) {
    return { ...base, state: STATE.FAILING, evidence: `last call failed: ${base.lastError}` };
  }
  if (rec.lastSuccessAt) {
    return { ...base, state: STATE.WORKING, evidence: `a real call succeeded ${Math.round((now - rec.lastSuccessAt) / 60000)} minutes ago` };
  }
  // configured and never proven — the state that did not exist before
  return {
    ...base,
    state: STATE.CONFIGURED,
    evidence: 'the credential is set, but nothing has used it yet — this is not a claim that it works',
  };
}

/** Every integration, for the settings screen. */
export async function allStatuses(env = process.env, now = Date.now()) {
  const out = [];
  for (const name of Object.keys(INTEGRATIONS)) out.push(await statusOf(name, env, now));
  return out;
}

/**
 * Wrap a provider call so the evidence records itself. A caller that forgets
 * to record is the reason "connected" drifted from reality in the first place.
 */
export async function withEvidence(name, fn) {
  try {
    const out = await fn();
    // an adapter that returns {ok:false} failed, even though it did not throw
    if (out && out.ok === false) {
      await recordFailure(name, out.error || 'the call reported failure');
    } else {
      await recordSuccess(name);
    }
    return out;
  } catch (e) {
    await recordFailure(name, e?.message || String(e));
    throw e;
  }
}
