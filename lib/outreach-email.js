// R6 — cold-email sending infrastructure.
//
// PROVIDER CHOICE (R6.1, R6.2), and why not the one already wired up
// ------------------------------------------------------------------
// Resend already sends client reports and revision mail from this app. It must
// NOT be used for prospecting: it is a transactional/opt-in service, and a
// single spam complaint against cold outreach would put the account that
// delivers paying clients' reports at risk. R6.2 exists precisely to stop that
// coupling, so prospecting gets its own provider AND its own sending domain.
//
// Recommended: Instantly (api.instantly.ai/api/v2). It is a purpose-built cold
// outreach platform rather than a transactional ESP, so unsolicited B2B mail is
// the use case it is designed and priced for, it owns mailbox warm-up and
// rotation, and it has a documented v2 REST API with scoped keys and webhooks
// for the events this system needs. Endpoints used below are the documented
// ones: POST /campaigns, POST /leads/bulk (max 1000 per request),
// PATCH /campaigns/:id/activate, GET /emails (documented 20 req/min).
//
// R6.3, stated honestly: a separate sending domain limits BLAST RADIUS. It does
// not make cold email safe, does not prevent spam complaints, and does not stop
// a provider from terminating the account. It protects the client-report domain
// from the consequences; it does not remove them.
//
// SHIPPED DISCONNECTED (R4.4, R6.15)
// ----------------------------------
// No account exists and no key is set. The adapter is complete and tested
// against fixtures, reports itself DISCONNECTED, and the send path refuses
// unless every one of these is true: a configured provider, a verified sending
// identity, an eligible contact, and the owner having explicitly switched
// outreach on. Default is off and nothing in this file can turn it on.

import { getSettings } from './settings.js';
import { canContact } from './contacts.js';
import { store } from './store.js';
import { checkOutgoing, checkSendingDomains } from './integrity.js';

export const PROVIDERS = Object.freeze({
  instantly: {
    key: 'instantly',
    label: 'Instantly',
    baseUrl: 'https://api.instantly.ai/api/v2',
    envKey: 'INSTANTLY_API_KEY',
    docs: 'https://developer.instantly.ai/',
    permitsColdOutreach: true,
    why: 'Purpose-built cold-outreach platform with a documented v2 API, scoped keys, owned mailbox warm-up and reply/bounce webhooks.',
    rateLimits: { listEmailsPerMin: 20, bulkLeadsPerRequest: 1000 },
  },
  // Deliberately recorded as NOT suitable, so a future reader does not "simplify"
  // the design by reusing the transactional sender that is already wired up.
  resend: {
    key: 'resend',
    label: 'Resend (client mail only)',
    envKey: 'RESEND_API_KEY',
    permitsColdOutreach: false,
    why: 'Transactional/opt-in only. Using it for prospecting risks the account that delivers paying clients their reports.',
  },
});

export const RECOMMENDED = 'instantly';

/** Everything that must be true before a single cold email may go out. */
export async function sendReadiness({ env = process.env } = {}) {
  const settings = await getSettings();
  const provider = PROVIDERS[RECOMMENDED];
  const blockers = [];

  if (!env[provider.envKey]) blockers.push({ code: 'no-credentials', text: `No ${provider.label} API key. Set ${provider.envKey} once the account exists.`, ownerAction: true });
  if (!env.OUTREACH_FROM_DOMAIN) blockers.push({ code: 'no-sending-domain', text: 'No separate sending domain configured (OUTREACH_FROM_DOMAIN). Prospecting must not share the domain that sends client reports.', ownerAction: true });
  // R6.10 — one prospecting domain. Several, or a numbered pool, is rotation,
  // which exists to outrun a reputation rather than correct it.
  for (const p of checkSendingDomains(env).problems) {
    blockers.push({ code: p.kind, text: p.text, ownerAction: true });
  }
  if (!settings.pricing.configured) blockers.push({ code: 'no-pricing', text: 'Pricing is not set, so a message cannot answer "how much".', ownerAction: true });
  if (settings.targeting.status !== 'confirmed') blockers.push({ code: 'targeting-draft', text: 'Targeting is still a draft assumption, not confirmed by the owner.', ownerAction: true });
  if (!settings.outreach.active) blockers.push({ code: 'outreach-off', text: 'Outreach has not been switched on by the owner.', ownerAction: true });

  // R9.9 — the deliverability trip. This is the blocker that exists to stop
  // sending that is actively doing harm, so an unreadable flag blocks too: a
  // send gate that lets messages through because it could not read its own
  // stop is not a gate.
  const { stopState } = await import('./deliverability.js');
  const stop = await stopState();
  if (stop.stopped) {
    blockers.push({ code: 'deliverability-stop', text: `Sending was stopped automatically. ${stop.reason || ''}`.trim(), ownerAction: true });
  } else if (stop.known === false) {
    blockers.push({ code: 'deliverability-unknown', text: 'Whether sending was stopped for deliverability could not be read, so sending is held until it can be.', ownerAction: false });
  }

  // R6.9 — CAN-SPAM identity. `composeCold` already refuses to build a message
  // without a name, business and postal address, but that failure surfaces one
  // prospect at a time, deep in a preview. The readiness list is where the
  // owner looks to find out why nothing can be sent, so it belongs here too.
  const { identityProblems } = await import('./settings.js');
  for (const p of identityProblems(settings.sender || {})) {
    blockers.push({ code: `identity-${p.field}`, text: p.text, ownerAction: true });
  }
  // and a one-click unsubscribe needs a public URL to point at
  if (!env.PUBLIC_BASE_URL) {
    blockers.push({ code: 'no-public-url', text: 'PUBLIC_BASE_URL is not set, so the unsubscribe link in each message would have nowhere to point. Gmail and Yahoo require a working one-click unsubscribe from bulk senders.', ownerAction: true });
  }
  if (!env.UNSUBSCRIBE_SECRET && !env.CRON_SECRET) {
    blockers.push({ code: 'no-unsub-secret', text: 'No UNSUBSCRIBE_SECRET (or CRON_SECRET) is set, so unsubscribe links cannot be signed and would be forgeable.', ownerAction: true });
  }

  // R2.9 — "connected" used to mean "the environment variable exists". A key
  // can be present and wrong (revoked, mistyped, wrong account, out of credit)
  // and this would still have said connected. Only a real exchange with the
  // provider proves anything, so the credential and the evidence are reported
  // as two different facts.
  let evidence = { state: 'configured', lastSuccessAt: null, lastError: '' };
  try {
    const m = await import('./integrations.js');
    evidence = await m.statusOf('instantly', env);
  } catch {
    /* no store in a unit test — fall back to credential-only, stated below */
  }
  const hasKey = !!env[provider.envKey];
  const proven = evidence.state === 'working';

  return {
    provider: provider.key,
    // kept for callers that only ask "is there a credential"
    credentialPresent: hasKey,
    // the honest one: a real call has succeeded
    connected: proven,
    evidenceState: hasKey ? evidence.state : 'not-configured',
    lastSuccessAt: evidence.lastSuccessAt || null,
    lastError: evidence.lastError || '',
    ready: blockers.length === 0,
    blockers,
    displayStatus: !hasKey
      ? 'not connected'
      : !proven
        ? 'key set, never confirmed'
        : blockers.length
          ? 'confirmed working, not activated'
          : 'ready',
  };
}

// ---------------------------------------------------------------------------
// The adapter. Provider-agnostic surface so a different provider is a new
// object, not a rewrite of the campaign code (R4.3-style separation for R6).
// ---------------------------------------------------------------------------

export function createInstantlyAdapter({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const p = PROVIDERS.instantly;
  const key = () => env[p.envKey];

  async function call(pathname, { method = 'GET', body = null } = {}) {
    if (!key()) return { ok: false, status: 0, error: 'not connected: no API key', disconnected: true };
    let res;
    try {
      res = await fetchImpl(p.baseUrl + pathname, {
        method,
        headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      return { ok: false, status: 0, error: String(e.message || e), transient: true };
    }
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (res.status === 429) return { ok: false, status: 429, error: 'rate limited', transient: true, retryAfter: Number(res.headers?.get?.('retry-after')) || 60 };
    if (!res.ok) {
      // R2.9 — the evidence is recorded where the call actually happened. A
      // key that exists but is rejected must stop the dashboard saying
      // "connected"; only a real exchange can prove the integration works.
      await noteIntegration('instantly', false, (json && json.message) || `http ${res.status}`);
      // R12.3 — a 5xx or a timeout is the PROVIDER being broken, not our
      // request being wrong, and the caller has to be able to tell the
      // difference: one deserves waiting, the other deserves giving up. Without
      // this flag an outage burned a job's attempt budget exactly when losing
      // the work hurts most.
      const transient = res.status >= 500 || res.status === 408;
      return { ok: false, status: res.status, error: (json && json.message) || `http ${res.status}`, ...(transient ? { transient: true } : {}) };
    }
    await noteIntegration('instantly', true);
    return { ok: true, status: res.status, data: json };
  }

  return {
    name: 'instantly',
    label: p.label,
    configured: () => !!key(),
    limits: p.rateLimits,

    createCampaign: (campaign) =>
      call('/campaigns', { method: 'POST', body: { name: campaign.name, campaign_schedule: campaign.schedule } }),

    /** Documented maximum is 1000 leads per request, so chunk rather than truncate. */
    async addLeads(campaignId, leads) {
      const chunks = [];
      for (let i = 0; i < leads.length; i += p.rateLimits.bulkLeadsPerRequest) {
        chunks.push(leads.slice(i, i + p.rateLimits.bulkLeadsPerRequest));
      }
      const results = [];
      for (const c of chunks) {
        results.push(await call('/leads/bulk', {
          method: 'POST',
          body: { campaign: campaignId, leads: c.map((l) => ({
            email: l.email,
            first_name: l.firstName || '',
            company_name: l.business || '',
            custom_variables: l.vars || {},
            // R6.9 — forwarded so the provider puts List-Unsubscribe and
            // List-Unsubscribe-Post on the wire, not just in our intent
            custom_headers: l.headers || {},
          })) },
        }));
      }
      const failed = results.find((r) => !r.ok);
      return failed || { ok: true, data: { added: leads.length, requests: results.length } };
    },

    activate: (campaignId) => call(`/campaigns/${campaignId}/activate`, { method: 'PATCH' }),
    listEmails: (params = '') => call(`/emails${params}`),
    webhookEventTypes: () => call('/webhooks/event-types'),
  };
}

// ---------------------------------------------------------------------------
// R6.6 / R6.8 — what the provider tells us after we send.
//
// A bounce or a complaint is not telemetry; it is an instruction. A hard bounce
// means that address will never work, and continuing to send to it damages the
// sending domain for every other message. A complaint means someone pressed the
// spam button, which is as strong a signal as an unsubscribe and is treated the
// same way: suppressed everywhere, immediately, not just in the campaign that
// caused it (R6.8).
// ---------------------------------------------------------------------------

export const DELIVERY_EVENTS = Object.freeze({
  DELIVERED: 'delivered',
  BOUNCED: 'bounced',
  COMPLAINED: 'complained',
  UNSUBSCRIBED: 'unsubscribed',
  OPENED: 'opened',
});

/** Which events change a contact's state rather than just being counted. */
const STATE_CHANGING = new Set([
  DELIVERY_EVENTS.BOUNCED,
  DELIVERY_EVENTS.COMPLAINED,
  DELIVERY_EVENTS.UNSUBSCRIBED,
]);

/**
 * Apply one delivery event.
 * Suppression is global by design: a complaint in one campaign stops every
 * campaign, because the person did not complain about a campaign, they
 * complained about us.
 */
export async function applyDeliveryEvent({ type, email, hard = true, campaignId = null, at = Date.now() }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return { ok: false, reason: 'delivery event carried no address' };
  if (!Object.values(DELIVERY_EVENTS).includes(type)) {
    return { ok: false, reason: `unknown delivery event "${type}"` };
  }

  await store.incr(`delivery:count:${type}`, 1).catch(() => {});
  // R9.9 — the same event into a per-day bucket. The lifetime counter cannot
  // drive a safety trip: a bad week last year would keep the system paused for
  // ever, and would dilute a bad week now into nothing.
  try {
    const { countDailyEvent } = await import('./deliverability.js');
    await countDailyEvent(type, at);
  } catch { /* the event itself matters more than the bucket */ }

  // R9.3 — the same event, recorded against whichever experiment arm this
  // contact is in. Done HERE because this is where the provider's event is
  // actually known; counting it later would mean reconstructing it.
  try {
    const { recordSecondaryEverywhere } = await import('./secondary.js');
    const { findDuplicates: findForSecondary } = await import('./contacts.js');
    const matches = await findForSecondary({ email: addr });
    const cid = (matches || []).find((m) => m.certainty === 'exact')?.contact?.id || null;
    const kind = type === DELIVERY_EVENTS.BOUNCED
      ? (hard ? 'bounced-hard' : 'bounced-soft')
      : type === DELIVERY_EVENTS.COMPLAINED ? 'complained'
        : type === DELIVERY_EVENTS.UNSUBSCRIBED ? 'opted-out'
          : type === DELIVERY_EVENTS.DELIVERED ? 'delivered'
            : null; // an open is NOT a secondary outcome (R9.4)
    if (kind) await recordSecondaryEverywhere({ contactId: cid, kind, at, evidence: { campaignId } });
  } catch { /* a delivery event must never fail because of an experiment */ }

  if (!STATE_CHANGING.has(type)) {
    // delivered/opened are counted, and deliberately change nothing — an open
    // is not consent and not interest (R9.4)
    return { ok: true, counted: true, changedState: false, note: type === DELIVERY_EVENTS.OPENED ? 'an open is counted but means nothing on its own' : null };
  }

  const { optOut, findDuplicates } = await import('./contacts.js');

  if (type === DELIVERY_EVENTS.BOUNCED && !hard) {
    // a soft bounce is a temporary condition, not a reason to suppress
    await store.incr(`delivery:count:soft-bounce`, 1).catch(() => {});
    return { ok: true, counted: true, changedState: false, note: 'soft bounce — temporary, so the address is not suppressed' };
  }

  // Suppress first, record second. The suppression is the part that must not be
  // lost if the rest fails.
  await store.set(`suppress:email:${addr}`, type);

  const matches = await findDuplicates({ email: addr }).catch(() => []);
  const contact = (matches || []).find((m) => m.certainty === 'exact')?.contact;
  if (contact) {
    await optOut({ contactId: contact.id, email: addr, reason: `provider reported ${type}`, channel: 'email' }).catch(() => {});
    // stop any pending sends for them, in every campaign
    const { stopContact } = await import('./campaigns.js');
    await stopContact(contact.id, `provider reported ${type}`).catch(() => {});
  }

  return {
    ok: true,
    counted: true,
    changedState: true,
    suppressed: addr,
    globallySuppressed: true,
    contactId: contact?.id || null,
    note: 'Suppression is global: this address is stopped in every campaign, not only the one that triggered it.',
  };
}

// ---------------------------------------------------------------------------
// R11.12 — the ambiguous timeout.
//
// A send times out. Did it go? You genuinely do not know: the request may have
// been received and processed with only the response lost. Both naive answers
// are wrong — retrying may send a stranger the same message twice, and giving
// up may lose a message the owner believes went.
//
// So an ambiguous outcome is recorded as AMBIGUOUS, and the next attempt must
// RECONCILE first: ask the provider whether it has the message. Only a definite
// "no" permits a resend. If the provider cannot tell us, the job is parked for
// a person rather than guessed either way — one duplicate to a cold prospect is
// a worse outcome than one delayed message.
// ---------------------------------------------------------------------------

export const SEND_OUTCOME = Object.freeze({
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  AMBIGUOUS: 'ambiguous',
});

const ATTEMPT = (key) => `send:attempt:${key}`;

/** Record that a send was attempted, BEFORE the request goes out. */
export async function recordSendAttempted(idempotencyKey, { at = Date.now(), meta = {} } = {}) {
  await store.set(ATTEMPT(idempotencyKey), JSON.stringify({ state: 'in-flight', at, ...meta }), { ex: 60 * 60 * 24 * 30 });
}

export async function recordSendOutcome(idempotencyKey, outcome, { at = Date.now(), providerId = null, error = null } = {}) {
  const prev = await getSendAttempt(idempotencyKey);
  await store.set(
    ATTEMPT(idempotencyKey),
    JSON.stringify({ ...(prev || {}), state: outcome, at, providerId, error: error ? String(error).slice(0, 200) : null }),
    { ex: 60 * 60 * 24 * 30 }
  );
}

export async function getSendAttempt(idempotencyKey) {
  const raw = await store.get(ATTEMPT(idempotencyKey)).catch(() => null);
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

/** Is a timeout/abort, rather than a definite refusal? */
export function isAmbiguousFailure(err) {
  const s = String(err?.message || err || '');
  return /timeout|timed out|aborted|ECONNRESET|socket hang up|ETIMEDOUT|network|fetch failed/i.test(s);
}

/**
 * Before retrying an ambiguous send, ask the provider what actually happened.
 *
 * `lookup` is injected: it is the provider call that answers "do you have a
 * message with this reference?". Without one, we cannot reconcile and must not
 * guess — the job is parked.
 */
export async function reconcileBeforeRetry(idempotencyKey, { lookup = null, now = Date.now() } = {}) {
  const attempt = await getSendAttempt(idempotencyKey);
  if (!attempt) return { action: 'send', reason: 'no previous attempt on record' };

  if (attempt.state === SEND_OUTCOME.CONFIRMED) {
    return { action: 'skip', reason: 'this message was already confirmed sent', providerId: attempt.providerId };
  }
  if (attempt.state === SEND_OUTCOME.FAILED) {
    return { action: 'send', reason: 'the previous attempt definitely failed, so nothing was delivered' };
  }

  // in-flight or ambiguous: we do not know. Ask.
  if (typeof lookup !== 'function') {
    return {
      action: 'park',
      reason: 'the previous attempt timed out and there is no way to ask the provider whether it went. Retrying could send a duplicate; a person should check.',
      needsHuman: true,
    };
  }

  let found;
  try {
    found = await lookup(idempotencyKey);
  } catch (e) {
    return {
      action: 'park',
      reason: `could not reach the provider to check whether the previous attempt was delivered (${String(e.message || e).slice(0, 80)})`,
      needsHuman: true,
      transient: true,
    };
  }

  if (found?.exists) {
    await recordSendOutcome(idempotencyKey, SEND_OUTCOME.CONFIRMED, { at: now, providerId: found.id || null });
    return { action: 'skip', reason: 'the provider has this message, so the timeout was only the response being lost', providerId: found.id || null };
  }
  if (found?.exists === false) {
    return { action: 'send', reason: 'the provider does not have this message, so it is safe to send' };
  }
  return {
    action: 'park',
    reason: 'the provider could not say whether this message exists, so resending might duplicate it',
    needsHuman: true,
  };
}

/** Is this address suppressed, whatever the reason? */
export async function isSuppressed(email) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return { suppressed: false };
  const why = await store.get(`suppress:email:${addr}`).catch(() => null);
  return why ? { suppressed: true, reason: why } : { suppressed: false };
}

/** A provider that refuses everything, so "no provider" is still a usable object. */

/**
 * R2.9 — record what a real provider exchange proved, without making this
 * module depend on the store at import time (the adapter is unit-tested with a
 * fake fetch and no KV).
 */
async function noteIntegration(name, ok, error) {
  try {
    const m = await import('./integrations.js');
    if (ok) await m.recordSuccess(name);
    else await m.recordFailure(name, error);
  } catch {
    /* evidence is best-effort; never fail a send because the note failed */
  }
}

export function createDisconnectedAdapter(reason = 'no provider configured') {
  return {
    name: 'none',
    label: 'Not connected',
    configured: () => false,
    createCampaign: async () => ({ ok: false, error: reason, disconnected: true }),
    addLeads: async () => ({ ok: false, error: reason, disconnected: true }),
    activate: async () => ({ ok: false, error: reason, disconnected: true }),
    listEmails: async () => ({ ok: false, error: reason, disconnected: true }),
    webhookEventTypes: async () => ({ ok: false, error: reason, disconnected: true }),
  };
}

export function getEmailAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (env[PROVIDERS.instantly.envKey]) return createInstantlyAdapter({ env, fetchImpl });
  return createDisconnectedAdapter(`${PROVIDERS.instantly.label} is not connected (${PROVIDERS.instantly.envKey} is not set)`);
}

// ---------------------------------------------------------------------------
// The gate. Every send goes through this, and it fails closed.
// ---------------------------------------------------------------------------

const SENT_KEY = (contactId, campaignId) => `outreach:sent:${campaignId}:${contactId}`;

/**
 * May we send this message to this contact right now?
 * Order matters: consent and suppression are checked before anything else, so
 * an opted-out person is refused even when everything else is misconfigured.
 */
export async function maySend({ contact, campaignId, purpose = 'promotional', env = process.env }) {
  const consent = await canContact(contact, { channel: 'email', purpose });
  if (!consent.ok) return { ok: false, code: 'not-contactable', reason: consent.reason };

  const already = await store.get(SENT_KEY(contact.id, campaignId)).catch(() => null);
  if (already) return { ok: false, code: 'already-sent', reason: 'this contact already received this campaign message' };

  const readiness = await sendReadiness({ env });
  if (!readiness.ready) {
    return { ok: false, code: 'not-ready', reason: readiness.blockers.map((b) => b.text).join(' '), blockers: readiness.blockers };
  }
  return { ok: true };
}

/** Record a send so a retry cannot duplicate it (R11.2). */
export async function markSent(contactId, campaignId, meta = {}) {
  await store.set(SENT_KEY(contactId, campaignId), JSON.stringify({ at: Date.now(), ...meta }));
}

/**
 * The single exit point for prospect email. There is no other.
 * It refuses by default and explains itself; it never silently no-ops.
 */
export async function sendProspectEmail({ contact, campaignId, message, env = process.env, fetchImpl = globalThis.fetch, lookup = null }) {
  const gate = await maySend({ contact, campaignId, env });
  if (!gate.ok) return { sent: false, ...gate };

  const adapter = getEmailAdapter({ env, fetchImpl });
  if (!adapter.configured()) return { sent: false, code: 'disconnected', reason: 'no email provider connected' };

  // R6.10 — the message itself is checked before it leaves. Our own composer
  // should never produce hidden text, homoglyphs or a disguised link, so a
  // finding here is a bug in this codebase, and this is where it stops being
  // posted to a provider rather than being discovered in a spam report.
  // Domain rotation is checked here too, because the only moment it matters is
  // the moment something is about to be sent.
  const integrity = checkOutgoing({
    text: [message?.subject, message?.body].filter(Boolean).join('\n'),
    html: message?.html || '',
    env,
  });
  if (!integrity.ok) {
    return {
      sent: false,
      code: 'integrity',
      reason: `refused before sending: ${integrity.findings.map((f) => f.text).join(' ')}`,
      findings: integrity.findings,
    };
  }

  // R11.12 — before anything goes out, settle what happened last time.
  // A previous attempt that timed out is not "nothing happened".
  const key = `${campaignId}:${contact.id}`;
  const prior = await reconcileBeforeRetry(key, { lookup });
  if (prior.action === 'skip') {
    await markSent(contact.id, campaignId, { provider: adapter.name, reconciled: true });
    return { sent: false, alreadySent: true, code: 'already-delivered', reason: prior.reason, providerId: prior.providerId };
  }
  if (prior.action === 'park') {
    return { sent: false, code: 'needs-reconciliation', reason: prior.reason, needsHuman: true, transient: !!prior.transient };
  }

  // Recorded BEFORE the request, so a process killed mid-send leaves evidence
  // that something may have gone out.
  await recordSendAttempted(key, { meta: { contactId: contact.id, campaignId } });

  // R6.9 — every outgoing message carries a one-click unsubscribe. Gmail and
  // Yahoo have required List-Unsubscribe + List-Unsubscribe-Post of bulk
  // senders since February 2024; without them cold mail is filtered whatever
  // the body says. The link is per-address and signed, so it cannot be edited
  // into someone else's address.
  const toAddress = contact.email?.value || contact.email;
  let unsubHeaders = {};
  let unsubLink = null;
  try {
    const u = await import('./unsubscribe.js');
    unsubHeaders = u.unsubscribeHeaders(toAddress, { env, replyTo: message?.replyTo || null });
    unsubLink = u.unsubscribeUrl(toAddress, { env });
  } catch { /* the STOP reply path still works */ }

  let res;
  try {
    res = await adapter.addLeads(campaignId, [{
      email: toAddress,
      business: contact.business,
      vars: { ...(message?.vars || {}), unsubscribe_url: unsubLink || '' },
      headers: unsubHeaders,
    }]);
  } catch (e) {
    const ambiguous = isAmbiguousFailure(e);
    await recordSendOutcome(key, ambiguous ? SEND_OUTCOME.AMBIGUOUS : SEND_OUTCOME.FAILED, { error: e?.message || String(e) });
    return {
      sent: false,
      code: ambiguous ? 'ambiguous' : 'provider-error',
      reason: ambiguous
        ? `the send timed out, so it is unknown whether it was delivered: ${e?.message || e}. It will be reconciled with the provider before any retry.`
        : String(e?.message || e),
      transient: true,
      ambiguous,
    };
  }

  if (!res.ok) {
    // The adapter catches network failures internally and returns them as a
    // result with status 0, so this branch — not the catch above — is where a
    // real timeout lands. No HTTP status means the request may still have been
    // received, which is exactly the ambiguous case.
    const ambiguous = (!!res.transient && !res.status) || isAmbiguousFailure(res.error);
    await recordSendOutcome(key, ambiguous ? SEND_OUTCOME.AMBIGUOUS : SEND_OUTCOME.FAILED, { error: res.error });
    return {
      sent: false,
      code: ambiguous ? 'ambiguous' : 'provider-error',
      reason: ambiguous
        ? `the send did not complete (${res.error}), so it is unknown whether it was delivered. It will be reconciled with the provider before any retry.`
        : res.error,
      transient: !!res.transient,
      ambiguous,
    };
  }

  await recordSendOutcome(key, SEND_OUTCOME.CONFIRMED, { providerId: res.data?.id || null });
  await markSent(contact.id, campaignId, { provider: adapter.name });

  // R6.7 — remember the Message-ID so the reply to THIS message can be matched
  // back to this contact and this campaign exactly. Without it, a contact in
  // two campaigns has their reply attributed to whichever one a key scan
  // happens to find first, and every number built on that is wrong.
  const messageId = res.data?.messageId || res.data?.message_id || res.data?.id || null;
  if (messageId) {
    try {
      const { recordSentMessage } = await import('./threading.js');
      await recordSentMessage({
        messageId,
        contactId: contact.id,
        campaignId,
        step: message?.step ?? null,
        threadId: res.data?.threadId || res.data?.thread_id || null,
      });
    } catch { /* threading is for attribution; never fail a send over it */ }
  }
  return { sent: true, provider: adapter.name, messageId };
}
