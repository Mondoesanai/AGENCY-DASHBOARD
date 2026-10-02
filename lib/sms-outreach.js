// R6.11 — the prospect SMS adapter, and the registration that must exist
// before a single message may go out. Shipped DISCONNECTED on purpose.
//
// What already existed is `lib/sms.js`, which texts the OWNER — `To:` is
// hard-wired to `OWNER_PHONE`. That is an alert channel, not an outreach one,
// and it must not quietly become one: the moment a `to` parameter appears on
// that function, every protection in this file is bypassed.
//
// THE OWNER'S DECISION, recorded (BUILD_PLAN "Owner decisions already made"):
// Twilio is OFF. Build the adapter and the consent model fully, mark it
// disconnected, never touch a live account, and do no A2P registration this
// round. Nothing in this file can switch it on.
//
// WHY REGISTRATION IS MODELLED RATHER THAN SKIPPED
// ------------------------------------------------
// In the US, application-to-person messaging on a normal 10-digit number
// requires A2P 10DLC registration: a Brand (who is sending) and a Campaign
// (what they are sending, with sample messages and a description of how
// recipients opted in). Unregistered traffic is filtered or blocked by the
// carriers, not merely frowned upon, and the opt-in description is a sworn
// statement about consent you must actually hold.
//
// So "left disconnected" is not a stub. It is a complete model of what must be
// true, every item of which is unmet, and a gate that refuses while any of
// them is unmet. That way connecting it later is a matter of supplying facts,
// not of discovering the requirements.
//
// Costs, recorded so the owner is not surprised (these are the published
// figures at the time of writing and must be re-checked before registering —
// they are provider pricing, not something this code can verify):
//   · one-time brand registration fee, plus a per-campaign vetting fee
//   · a monthly campaign fee
//   · per-segment message pricing, charged per 160 GSM-7 characters
//   · carrier fees on top of provider pricing
// A unit test cannot confirm a price, and this file does not pretend to.

import { store } from './store.js';

export const SMS_STATE = Object.freeze({
  NOT_STARTED: 'not-started',
  DRAFTED: 'drafted',
  SUBMITTED: 'submitted',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

/**
 * What A2P 10DLC actually asks for. Each item names who can supply it, because
 * most of these are not things any amount of code can produce.
 */
export const REGISTRATION_REQUIREMENTS = Object.freeze([
  { id: 'legal-entity', label: 'Registered legal entity name', who: 'owner', what: 'Exactly as filed, not a trading name.' },
  { id: 'ein', label: 'EIN / tax ID', who: 'owner', what: 'The carriers verify this against public records.' },
  { id: 'business-address', label: 'Registered business address', who: 'owner', what: 'The address on the entity filing.' },
  { id: 'website', label: 'Public website', who: 'owner', what: 'It must describe the business that is sending.' },
  { id: 'contact', label: 'A named person with email and phone', who: 'owner', what: 'A real person the carrier can reach.' },
  { id: 'use-case', label: 'Declared use case', who: 'owner', what: 'What the messages are for. Mixed or marketing use cases are vetted harder.' },
  { id: 'sample-messages', label: 'Sample messages', who: 'builder', what: 'Real examples of what will be sent, including the opt-out wording.' },
  { id: 'opt-in-description', label: 'How recipients opted in', who: 'owner', what: 'A sworn description of consent you actually hold. This is the item that cannot be fudged.' },
  { id: 'opt-in-evidence', label: 'Evidence of the opt-in flow', who: 'owner', what: 'A screenshot or URL of the form or wording people agreed to.' },
]);

const KEY = 'sms:registration';

/** Sample messages the registration would carry. Generated, not invented copy. */
export function sampleMessages({ business = '{business}', ownerName = '{your name}' } = {}) {
  return [
    `Hi — it's ${ownerName} from ${business}. You asked me to send over the website preview: {link}. Reply STOP to stop.`,
    `${business}: your appointment is tomorrow at {time}. Reply STOP to stop, HELP for help.`,
  ];
}

export async function getRegistration() {
  let raw;
  try {
    raw = await store.get(KEY);
  } catch {
    return { state: SMS_STATE.NOT_STARTED, fields: {}, unreadable: true };
  }
  if (!raw) return { state: SMS_STATE.NOT_STARTED, fields: {} };
  try {
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      state: r.state || SMS_STATE.NOT_STARTED,
      fields: r.fields || {},
      updatedAt: r.updatedAt || null,
      note: r.note || '',
      // the carrier's reference is the evidence behind an approval; dropping it
      // here left `registrationStatus` reporting an approval with nothing to
      // point at, which is the exact thing recordCarrierDecision refuses
      reference: r.reference || null,
    };
  } catch {
    return { state: SMS_STATE.NOT_STARTED, fields: {} };
  }
}

/**
 * Record registration facts the owner supplies.
 *
 * `approved` is deliberately NOT settable here. Approval is a decision the
 * carriers make, and a flag this code can write would be a flag this code
 * could use to let itself send. It is set only by `recordCarrierDecision`,
 * which requires a carrier reference to point at.
 */
export async function saveRegistration(fields = {}, { note = '' } = {}) {
  const cur = await getRegistration();
  const known = new Set(REGISTRATION_REQUIREMENTS.map((r) => r.id));
  const next = { ...cur.fields };
  for (const [k, v] of Object.entries(fields)) {
    if (known.has(k)) next[k] = String(v).slice(0, 500).trim();
  }
  const state = cur.state === SMS_STATE.APPROVED ? SMS_STATE.APPROVED : SMS_STATE.DRAFTED;
  const rec = { state, fields: next, note: String(note).slice(0, 300), updatedAt: Date.now() };
  await store.set(KEY, JSON.stringify(rec)).catch(() => {});
  return rec;
}

/**
 * Approval comes from outside. It needs a carrier reference, so an approval
 * with nothing to point at cannot be recorded.
 */
export async function recordCarrierDecision({ approved, reference = '', note = '' }) {
  if (approved && !reference) {
    return { ok: false, error: 'an approval must carry the carrier reference it came from — otherwise it is just a flag we set ourselves' };
  }
  const cur = await getRegistration();
  const rec = {
    state: approved ? SMS_STATE.APPROVED : SMS_STATE.REJECTED,
    fields: cur.fields,
    reference: String(reference).slice(0, 120),
    note: String(note).slice(0, 300),
    updatedAt: Date.now(),
  };
  await store.set(KEY, JSON.stringify(rec)).catch(() => {});
  return { ok: true, ...rec };
}

/** What is still missing, as a list a person can work through. */
export async function registrationStatus() {
  const reg = await getRegistration();
  const missing = REGISTRATION_REQUIREMENTS.filter((r) => !reg.fields[r.id]);
  return {
    state: reg.state,
    approved: reg.state === SMS_STATE.APPROVED,
    supplied: REGISTRATION_REQUIREMENTS.length - missing.length,
    total: REGISTRATION_REQUIREMENTS.length,
    missing: missing.map((r) => ({ id: r.id, label: r.label, who: r.who, what: r.what })),
    reference: reg.reference || null,
    note: reg.note || '',
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const SMS_PROVIDER = Object.freeze({
  key: 'twilio',
  label: 'Twilio Programmable Messaging',
  docs: 'https://www.twilio.com/docs/messaging/api/message-resource',
  endpoint: 'https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json',
  envKeys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_SMS_FROM'],
  // deliberately a DIFFERENT number from the owner-alert sender, so prospect
  // traffic can never be sent from the number used to reach the owner
  why: 'Already the provider for owner alerts, so one account and one bill; the outreach number is separate from the alert number.',
});

export function createDisconnectedSmsAdapter(reason = 'SMS outreach is switched off') {
  return {
    name: 'none',
    label: 'Not connected',
    configured: () => false,
    send: async () => ({ ok: false, error: reason, disconnected: true }),
  };
}

/**
 * The real adapter. It is complete, and it is unreachable: `sendProspectSms`
 * refuses long before this is called, and `configured()` is false without a
 * dedicated outreach number.
 */
export function createTwilioSmsAdapter({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const sid = () => env.TWILIO_ACCOUNT_SID;
  const token = () => env.TWILIO_AUTH_TOKEN;
  const from = () => env.TWILIO_SMS_FROM;

  return {
    name: 'twilio',
    label: SMS_PROVIDER.label,
    configured: () => !!(sid() && token() && from()),
    async send({ to, body }) {
      if (!sid() || !token() || !from()) return { ok: false, error: 'not connected: no SMS credentials', disconnected: true };
      try {
        const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid()}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${sid()}:${token()}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({ To: to, From: from(), Body: body }).toString(),
          signal: AbortSignal.timeout(15000),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, status: res.status, error: j.message || `twilio ${res.status}` };
        return { ok: true, sid: j.sid, status: j.status };
      } catch (e) {
        return { ok: false, error: String(e.message || e), transient: true };
      }
    },
  };
}

export function getSmsAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const a = createTwilioSmsAdapter({ env, fetchImpl });
  return a.configured() ? a : createDisconnectedSmsAdapter('no SMS outreach number configured (TWILIO_SMS_FROM)');
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Everything that must be true before one prospect text may go out.
 * Every item is currently unmet, and that is the intended state.
 */
export async function smsReadiness({ env = process.env } = {}) {
  const blockers = [];
  const reg = await registrationStatus();

  for (const k of SMS_PROVIDER.envKeys) {
    if (!env[k]) blockers.push({ code: 'no-credentials', text: `${k} is not set.`, ownerAction: true });
  }
  if (env.TWILIO_SMS_FROM && env.TWILIO_SMS_FROM === env.TWILIO_FROM) {
    blockers.push({
      code: 'shared-number',
      text: 'The outreach number is the same as the number used for owner alerts. A complaint about outreach would take the alert channel down with it.',
      ownerAction: true,
    });
  }
  if (!reg.approved) {
    blockers.push({
      code: 'registration-not-approved',
      text: `A2P 10DLC registration is "${reg.state}" — ${reg.supplied}/${reg.total} facts supplied. Unregistered traffic is filtered by the carriers, not merely discouraged.`,
      ownerAction: true,
    });
  }

  // the owner switch, shared with email outreach
  let active = false;
  try {
    const { getSettings } = await import('./settings.js');
    const s = await getSettings();
    active = !!s.outreach?.active;
  } catch { active = false; }
  if (!active) blockers.push({ code: 'outreach-off', text: 'Outreach has not been switched on by the owner.', ownerAction: true });

  // the owner's recorded decision for this round
  blockers.push({
    code: 'owner-decision-sms-off',
    text: 'The owner has decided SMS stays off for this round: the adapter and consent model are built, no account is touched, and no A2P registration is filed. Nothing in code can lift this.',
    ownerAction: true,
    standing: true,
  });

  return {
    provider: SMS_PROVIDER.key,
    registration: reg,
    connected: false, // never claimed: nothing has ever sent through this
    ready: false, // and it cannot be, while the standing decision holds
    blockers,
    displayStatus: 'built, deliberately disconnected',
  };
}

export const SMS_REFUSAL = Object.freeze({
  NOT_READY: 'sms-not-ready',
  NO_CONSENT: 'sms-no-consent',
  SUPPRESSED: 'sms-suppressed',
  NO_NUMBER: 'sms-no-number',
});

/**
 * The single exit point for prospect SMS. There is no other, and today it
 * always refuses.
 *
 * It is written in full rather than stubbed so the refusal is the real one —
 * a stub that throws would have to be replaced to connect this, and replacing
 * it is exactly when the checks get forgotten.
 */
export async function sendProspectSms({ contact, campaignId, type, body, env = process.env, fetchImpl = globalThis.fetch }) {
  const readiness = await smsReadiness({ env });
  if (!readiness.ready) {
    return { sent: false, code: SMS_REFUSAL.NOT_READY, reason: readiness.blockers.map((b) => b.text).join(' '), blockers: readiness.blockers };
  }

  const number = contact?.phone?.value || contact?.phone || null;
  if (!number) return { sent: false, code: SMS_REFUSAL.NO_NUMBER, reason: 'no phone number on this contact' };

  // an opt-out is a standing instruction across channels
  try {
    const { digits } = await import('./sms.js');
    const suppressed = await store.get(`suppress:phone:${digits(number)}`).catch(() => null);
    if (suppressed) return { sent: false, code: SMS_REFUSAL.SUPPRESSED, reason: 'this number has opted out' };
  } catch { /* fall through to the consent check, which is stricter anyway */ }

  // consent, through the model that already exists for campaigns
  try {
    const { effectiveConsent } = await import('./contacts.js');
    const { sequenceAllowed } = await import('./campaigns.js');
    const scope = effectiveConsent(contact, 'sms');
    const allowed = sequenceAllowed(type, scope, 0);
    if (!allowed.ok) return { sent: false, code: SMS_REFUSAL.NO_CONSENT, reason: allowed.reason };
  } catch (e) {
    return { sent: false, code: SMS_REFUSAL.NO_CONSENT, reason: `consent could not be established: ${e.message || e}` };
  }

  const adapter = getSmsAdapter({ env, fetchImpl });
  if (!adapter.configured()) return { sent: false, code: SMS_REFUSAL.NOT_READY, reason: 'no SMS provider connected' };
  return adapter.send({ to: number, body });
}
