// R6.12 — a number's TYPE says whether a text can arrive. It never says whether
// one may be sent.
//
// This is an easy mistake to make and an expensive one. A lookup API returns a
// clean, confident answer — `{ "type": "mobile" }` — and it is extremely
// tempting to read that as a green light, because it arrives at exactly the
// moment you are asking "can I text this person?". It answers a different
// question. "Mobile" means the carrier will deliver. Consent means the person
// agreed to hear from you. One is a fact about wires; the other is a fact
// about a person, and only the second is permission.
//
// So the two answers are computed by two functions that cannot reach each
// other's inputs:
//
//   deliverability(number, lineType)  → can a text physically arrive?
//   mayText({ contact, purpose })     → are we allowed to send one?
//
// `mayText` consults consent, suppression and opt-out. It consults line type
// ONLY to refuse — a landline cannot receive a text, so sending one wastes a
// segment fee and may reach a stranger who inherited the number. There is no
// path through `mayText` in which a line type makes an answer more permissive.
//
// Validation matters for its own reason: a malformed or implausible number is
// not merely undeliverable, it may belong to SOMEONE ELSE. A transposed digit
// in a number typed off a business card is a real person who never met you.

import { store } from './store.js';

export const LINE_TYPE = Object.freeze({
  MOBILE: 'mobile',
  LANDLINE: 'landline',
  VOIP: 'voip',
  UNKNOWN: 'unknown',
});

/** Line types that can actually receive SMS. VoIP sometimes can; "sometimes"
 *  is not a basis for spending a fee, so it is treated as unproven. */
export const SMS_CAPABLE = Object.freeze({
  mobile: true,
  landline: false,
  voip: null, // unproven — may or may not
  unknown: null,
});

// ---------------------------------------------------------------------------
// Validation, with no provider involved
// ---------------------------------------------------------------------------

/**
 * Parse to E.164 and say what is wrong, specifically.
 *
 * North American numbering plan rules are checked because they are the ones
 * this business sends to, and because they catch the typo cases: an area code
 * or exchange starting with 0 or 1 cannot exist, so such a number is not
 * "probably fine" — it is certainly wrong, and the digits are someone's.
 */
export function parseNumber(raw, { defaultCountry = 'US' } = {}) {
  const original = String(raw ?? '').trim();
  const problems = [];
  if (!original) return { ok: false, e164: '', problems: [{ code: 'empty', text: 'No number was given.' }] };

  // an extension is not part of the number
  const extMatch = original.match(/(?:\bext?\.?|x)\s*(\d{1,6})\s*$/i);
  const ext = extMatch ? extMatch[1] : null;
  const withoutExt = extMatch ? original.slice(0, extMatch.index) : original;

  const hasPlus = /^\s*\+/.test(withoutExt);
  const d = withoutExt.replace(/\D/g, '');
  if (!d) return { ok: false, e164: '', ext, problems: [{ code: 'no-digits', text: `"${original}" contains no digits.` }] };

  let e164 = '';
  let nanp = null;

  if (!hasPlus && defaultCountry === 'US') {
    if (d.length === 10) { e164 = `+1${d}`; nanp = d; }
    else if (d.length === 11 && d.startsWith('1')) { e164 = `+${d}`; nanp = d.slice(1); }
    else if (d.length < 10) {
      problems.push({ code: 'too-short', text: `"${original}" has ${d.length} digits; a US number needs 10.` });
    } else if (d.length > 11) {
      // might be international typed without a plus
      e164 = `+${d}`;
      problems.push({ code: 'assumed-international', text: `"${original}" has ${d.length} digits and no country code marker; treating it as international, which may be wrong.` });
    } else {
      problems.push({ code: 'bad-length', text: `"${original}" has ${d.length} digits, which is not a usable length.` });
    }
  } else {
    if (d.length < 8 || d.length > 15) {
      problems.push({ code: 'bad-length', text: `"${original}" has ${d.length} digits; E.164 allows 8 to 15.` });
    } else {
      e164 = `+${d}`;
      if (d.startsWith('1') && d.length === 11) nanp = d.slice(1);
    }
  }

  // NANP structure — these are not style preferences, they are impossible
  if (nanp) {
    const area = nanp.slice(0, 3);
    const exchange = nanp.slice(3, 6);
    if (/^[01]/.test(area)) problems.push({ code: 'bad-area-code', text: `Area code ${area} cannot start with 0 or 1.` });
    if (/^[01]/.test(exchange)) problems.push({ code: 'bad-exchange', text: `Exchange ${exchange} cannot start with 0 or 1.` });
    if (/^(\d)\1{2}$/.test(area) && area !== '800') problems.push({ code: 'suspect-area-code', severity: 'suspect', text: `Area code ${area} is a repeated digit, which is almost always a typo.` });
    // 555-0100..0199 is reserved for fiction; the rest of 555 is mostly unassigned
    if (exchange === '555' && /^01\d\d$/.test(nanp.slice(6))) {
      problems.push({ code: 'fictional', severity: 'suspect', text: `${area}-555-${nanp.slice(6)} is in the range reserved for fiction. It is not a real number, so nothing may be sent to it.` });
    }
    if (/^(\d)\1{9}$/.test(nanp)) problems.push({ code: 'repeated-digits', severity: 'suspect', text: 'Every digit is the same, which is a placeholder, not a number.' });
    if (nanp === '1234567890' || nanp === '0123456789') problems.push({ code: 'sequential', severity: 'suspect', text: 'The digits are sequential, which is a placeholder.' });
  }

  // "fatal" means this cannot be a phone number at all. "suspect" means it
  // parses but is a placeholder — fiction range, repeated or sequential digits.
  // Parsing succeeds for a suspect number so storing and displaying one still
  // works; SENDING to one is refused separately, by mayText. The distinction
  // matters because a number can be perfectly well-formed and still be nobody.
  const fatal = problems.some((p) => p.severity !== 'suspect' && p.code !== 'assumed-international');
  const placeholder = problems.some((p) => p.severity === 'suspect');
  return {
    ok: !!e164 && !fatal,
    placeholder,
    e164: fatal ? '' : e164,
    national: nanp,
    ext,
    problems,
  };
}

/** True only for a number we are confident is real and well-formed. */
export function isValidNumber(raw, opts) {
  return parseNumber(raw, opts).ok;
}

// ---------------------------------------------------------------------------
// Line type: recorded as evidence, with where it came from
// ---------------------------------------------------------------------------

const LT_KEY = (e164) => `phone:type:${e164}`;

/**
 * Record what a lookup said. The SOURCE is stored with it, because "the
 * carrier told us" and "someone typed it in" are different strengths of claim,
 * and because an unsourced line type is indistinguishable from a guess.
 */
export async function recordLineType(e164, { type, source, at = Date.now(), carrier = null }) {
  if (!e164 || !Object.values(LINE_TYPE).includes(type)) {
    return { ok: false, error: `line type must be one of ${Object.values(LINE_TYPE).join(', ')}` };
  }
  if (!source) return { ok: false, error: 'a line type must say where it came from' };
  const rec = { type, source: String(source).slice(0, 60), carrier: carrier ? String(carrier).slice(0, 80) : null, at };
  await store.set(LT_KEY(e164), JSON.stringify(rec), { ex: 60 * 60 * 24 * 180 }).catch(() => {});
  return { ok: true, ...rec };
}

export async function getLineType(e164) {
  if (!e164) return { type: LINE_TYPE.UNKNOWN, source: null, at: null };
  let raw;
  try {
    raw = await store.get(LT_KEY(e164));
  } catch {
    return { type: LINE_TYPE.UNKNOWN, source: null, at: null, unreadable: true };
  }
  if (!raw) return { type: LINE_TYPE.UNKNOWN, source: null, at: null };
  try {
    const r = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { type: r.type || LINE_TYPE.UNKNOWN, source: r.source || null, carrier: r.carrier || null, at: r.at || null };
  } catch {
    return { type: LINE_TYPE.UNKNOWN, source: null, at: null };
  }
}

/**
 * Can a text physically arrive? This is the ONLY question line type answers.
 * It is deliberately a separate function with a separate name so that reading
 * a call site tells you which question was asked.
 */
export function deliverability(parsed, lineType = LINE_TYPE.UNKNOWN) {
  if (!parsed?.ok) {
    return { deliverable: false, certain: true, reason: parsed?.problems?.[0]?.text || 'the number is not usable' };
  }
  const capable = SMS_CAPABLE[lineType];
  if (capable === true) return { deliverable: true, certain: true, reason: 'a mobile number can receive SMS' };
  if (capable === false) return { deliverable: false, certain: true, reason: `a ${lineType} cannot receive SMS` };
  return {
    deliverable: null,
    certain: false,
    reason: lineType === LINE_TYPE.VOIP
      ? 'VoIP numbers sometimes receive SMS and sometimes do not; this one is unproven'
      : 'the line type is not known, so whether a text would arrive is unknown',
  };
}

// ---------------------------------------------------------------------------
// Permission — the question line type does NOT answer
// ---------------------------------------------------------------------------

/**
 * May we text this contact?
 *
 * Consent is established FIRST and on its own. Line type is consulted only
 * afterwards and only to refuse. There is no branch in this function where a
 * line type makes the answer more permissive, and the test suite asserts that
 * by running every line type against every consent scope.
 */
export async function mayText({ contact, purpose = 'one_time_followup', now = Date.now() }) {
  const raw = contact?.phone?.value || contact?.phone || '';
  const parsed = parseNumber(raw);

  // 1. CONSENT. Nothing about the number is consulted here.
  let scope = 'none';
  try {
    const { effectiveConsent } = await import('./contacts.js');
    const c = effectiveConsent(contact, 'sms');
    scope = typeof c === 'string' ? c : c?.scope || 'none';
  } catch {
    return { ok: false, code: 'consent-unknown', reason: 'consent could not be established, so the answer is no' };
  }

  const covers = {
    transactional: ['transactional', 'one_time_followup', 'promotional'],
    one_time_followup: ['one_time_followup', 'promotional'],
    promotional: ['promotional'],
  }[purpose] || [];
  if (!covers.includes(scope)) {
    return {
      ok: false,
      code: 'no-consent',
      reason: `this contact's SMS permission is "${scope}", which does not cover a ${purpose.replace(/_/g, ' ')} message`,
      scope,
    };
  }

  // 2. a standing opt-out outranks any consent recorded earlier
  if (parsed.ok) {
    try {
      // Both key formats — see contacts.js:suppressionKeys. Reading only the
      // E.164 one missed suppressions written by retention.js.
      const { isPhoneSuppressed } = await import('./contacts.js');
      if (await isPhoneSuppressed(parsed.e164)) {
        return { ok: false, code: 'opted-out', reason: 'this number has asked not to be contacted', scope };
      }
    } catch {
      // an unreadable suppression list must not read as "not suppressed"
      return { ok: false, code: 'opted-out-unknown', reason: 'whether this number opted out could not be read, so it is treated as opted out', scope };
    }
  }

  // 3. the number itself must be usable — a wrong number is someone else's
  if (!parsed.ok) {
    return { ok: false, code: 'invalid-number', reason: parsed.problems[0]?.text || 'the number is not usable', scope, problems: parsed.problems };
  }

  // 4. a placeholder parses, but must never be sent to: nothing would arrive,
  //    and if the digits are a typo for a real number it reaches a stranger
  if (parsed.placeholder) {
    const p = parsed.problems.find((x) => x.severity === 'suspect');
    return { ok: false, code: 'placeholder-number', reason: p?.text || 'this looks like a placeholder, not a real number', scope };
  }

  // 5. line type, ONLY to refuse
  const lt = await getLineType(parsed.e164);
  const d = deliverability(parsed, lt.type);
  if (d.deliverable === false) {
    return { ok: false, code: 'undeliverable', reason: d.reason, scope, lineType: lt.type };
  }

  // Note what is NOT here: `if (lt.type === 'mobile') return { ok: true }`.
  // Reaching this line means consent was established on its own.
  return {
    ok: true,
    scope,
    lineType: lt.type,
    e164: parsed.e164,
    deliverabilityKnown: d.certain,
    note: d.certain ? null : d.reason,
  };
}

// ---------------------------------------------------------------------------
// The lookup adapter — shipped disconnected, like the sender (R6.11)
// ---------------------------------------------------------------------------

export const LOOKUP_PROVIDER = Object.freeze({
  key: 'twilio-lookup',
  label: 'Twilio Lookup',
  docs: 'https://www.twilio.com/docs/lookup/v2-api',
  endpoint: 'https://lookups.twilio.com/v2/PhoneNumbers/{E164}',
  envKeys: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'],
  // stated so nobody treats this as free validation
  billing: 'Line-type intelligence is billed per lookup. Validation alone is free; the type is not.',
});

export function createDisconnectedLookupAdapter(reason = 'number lookup is not connected') {
  return { name: 'none', configured: () => false, lookup: async () => ({ ok: false, error: reason, disconnected: true }) };
}

export function createTwilioLookupAdapter({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const sid = () => env.TWILIO_ACCOUNT_SID;
  const token = () => env.TWILIO_AUTH_TOKEN;
  return {
    name: 'twilio-lookup',
    configured: () => !!(sid() && token()),
    async lookup(e164) {
      if (!sid() || !token()) return { ok: false, error: 'not connected: no credentials', disconnected: true };
      try {
        const res = await fetchImpl(`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`, {
          headers: { Authorization: 'Basic ' + Buffer.from(`${sid()}:${token()}`).toString('base64') },
          signal: AbortSignal.timeout(10000),
        });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, status: res.status, error: j.message || `lookup ${res.status}` };
        const t = String(j.line_type_intelligence?.type || '').toLowerCase();
        const type = t.includes('mobile') ? LINE_TYPE.MOBILE
          : t.includes('landline') || t.includes('fixed') ? LINE_TYPE.LANDLINE
            : t.includes('voip') || t.includes('nonFixedVoip'.toLowerCase()) ? LINE_TYPE.VOIP
              : LINE_TYPE.UNKNOWN;
        return {
          ok: true,
          valid: j.valid !== false,
          type,
          carrier: j.line_type_intelligence?.carrier_name || null,
          // said out loud in the RESULT, not only in a comment, because this
          // object is what a future caller will read
          meaning: 'This says whether a text can be delivered. It is not consent and must never be used as consent.',
        };
      } catch (e) {
        return { ok: false, error: String(e.message || e), transient: true };
      }
    },
  };
}

export function getLookupAdapter({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const a = createTwilioLookupAdapter({ env, fetchImpl });
  return a.configured() ? a : createDisconnectedLookupAdapter('no lookup credentials configured');
}
