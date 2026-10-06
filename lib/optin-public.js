// The two ways a person can give SMS permission themselves.
//
// R17.1. The owner originally wanted a blanket checkbox plus a first automated
// "reply YES if interested" text to discovered numbers, and then — after reading
// the provider requirements — cancelled that flow themselves. The reasoning is
// worth keeping next to the replacement, because it is the whole design:
//
//   THE FIRST TEXT IS ITSELF THE MARKETING MESSAGE. A text asking somebody to
//   reply YES so we can market to them is already promotional. It cannot be the
//   thing that obtains permission for itself, and an owner's assertion about a
//   list cannot supply it either: consent is given by each recipient, to each
//   sender, for each subject. One person cannot give it on another's behalf.
//
// So promotional permission has exactly two honest sources, and in both of them
// the RECIPIENT acts first:
//
//   KEYWORD   they text a published keyword to our number, having seen the
//             terms published alongside it. Their message is the evidence.
//   WEB/QR    they enter their own number on a page that shows the terms, and
//             submit it. The page and the wording version are the evidence.
//
// A third source exists and is deliberately weaker: an owner recording a real
// conversation with a named person (lib/optin.js:recordPermission). That is
// capped at a one-time follow-up and can never reach promotional, because the
// evidence is somebody's recollection rather than the person's own act.
//
// WHAT THIS MODULE DOES NOT DO. It does not decide whether a message may be
// sent. `lib/phone.js:mayText` does that, by comparing the recorded scope
// against the purpose of the message in hand — so a one-time follow-up
// permission refuses a promotional send even though both are "consent".

import { store } from './store.js';

/**
 * The published keyword and the terms that go with it.
 *
 * The wording is versioned because consent is to a specific statement. If the
 * terms change, messages sent under the old wording were agreed to under the
 * old wording, and the record has to say which.
 */
export const OPTIN_KEYWORD = 'PREVIEW';
export const OPTIN_WORDING_VERSION = 'public-optin-v1';

export function publishedTerms({ business = 'Inspiring Websites', frequency = 'a few messages a month' } = {}) {
  return `Text ${OPTIN_KEYWORD} to get a free website preview and occasional updates from ${business}. `
    + `${frequency[0].toUpperCase()}${frequency.slice(1)}. Message and data rates may apply. `
    + 'Reply STOP to cancel, HELP for help.';
}

/** Anything that is not a plain keyword match is not an enrolment. */
export function isOptInKeyword(text) {
  const whole = String(text || '').trim().toLowerCase().replace(/[.!,]+$/, '');
  return whole === OPTIN_KEYWORD.toLowerCase();
}

const seenKey = (e164) => `optin:keyword:${e164}`;

/**
 * A person texted the published keyword to our number.
 *
 * This is the strongest consent this system can hold: they sent it, unprompted,
 * from the number in question, having seen the terms. The message itself is the
 * evidence and is stored verbatim.
 *
 * A number that already opted out is NOT re-enrolled here. A single keyword is
 * thin evidence against a standing STOP, and the same reasoning that makes
 * START a human decision applies: the record has to say what they agreed to.
 */
export async function recordKeywordOptIn({ e164, rawText = '', at = Date.now(), business, findContact = null }) {
  if (!e164) return { ok: false, error: 'no number' };

  // Both key formats, via the shared helper — see contacts.js:suppressionKeys.
  // A read failure fails CLOSED: if we cannot tell whether this person already
  // said stop, we must not record a promotional permission for them.
  const { isPhoneSuppressed } = await import('./contacts.js');
  let blocked;
  try {
    blocked = await isPhoneSuppressed(e164);
  } catch {
    return {
      ok: false,
      error: 'whether this number had opted out could not be read',
      needsPerson: true,
      why: 'An unreadable opt-out list is not an all-clear. A person checks before this is recorded.',
    };
  }
  if (blocked) {
    return {
      ok: false,
      error: 'this number previously opted out',
      needsPerson: true,
      why: 'A standing STOP is not overturned by one keyword. A person decides, and records what they agreed to.',
    };
  }

  // If a form submission is waiting on this number, THIS is what confirms it.
  // Both acts are cited: the form captured what they agreed to and when, and the
  // message proves the handset is theirs. Either alone is weaker than the pair.
  const waiting = await pendingWebOptIn(e164);

  const record = {
    scope: 'promotional',
    channel: 'sms',
    source: waiting
      ? `${waiting.source}, confirmed by texting ${OPTIN_KEYWORD} from the number`
      : `texted ${OPTIN_KEYWORD} to our number`,
    wording: waiting?.wording || publishedTerms({ business }),
    wordingVersion: waiting?.wordingVersion || OPTIN_WORDING_VERSION,
    at: new Date(at).toISOString(),
    evidence: waiting
      ? `form submitted ${waiting.at}${waiting.name ? ` as "${waiting.name}"` : ''}, then confirmed from ${e164}: "${String(rawText || '').slice(0, 100)}"`
      : `their own message from ${e164}: "${String(rawText || '').slice(0, 120)}"`,
  };
  if (waiting) await store.del(pendingKey(e164)).catch(() => {});

  // Attach it to a contact when we can find one; otherwise hold it against the
  // number so it is applied when that person becomes a contact. A permission
  // that arrives before the contact record must not be thrown away.
  let contactId = null;
  if (typeof findContact === 'function') {
    const c = await findContact(e164).catch(() => null);
    if (c?.id) {
      const { saveContact } = await import('./contacts.js');
      await saveContact({ ...c, consentLog: [...(c.consentLog || []), record] });
      contactId = c.id;
    }
  }
  if (!contactId) {
    await store.set(seenKey(e164), JSON.stringify(record), { ex: 60 * 60 * 24 * 365 }).catch(() => {});
  }

  return { ok: true, scope: 'promotional', record, contactId, held: !contactId };
}

/** A permission recorded against a number before that person was a contact. */
export async function pendingKeywordOptIn(e164) {
  const raw = await store.get(seenKey(e164)).catch(() => null);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * Somebody filled in the opt-in form on a page or behind a QR code.
 *
 * The three refusals here are the ones that separate a real opt-in form from a
 * box somebody ticked on another person's behalf:
 *
 *   * the number must be given, and is the number consenting;
 *   * the consent box must actually have been ticked — a pre-ticked box is not
 *     consent, which is why `agreed` must arrive true rather than defaulting;
 *   * the wording shown on the page is recorded with it, so what they agreed to
 *     is known later even if the page changes.
 */
export async function recordWebOptIn({
  phone, agreed = false, pageUrl = '', at = Date.now(), business, findContact = null, name = '',
}) {
  const { parseNumber } = await import('./phone.js');
  const parsed = parseNumber(phone || '');
  if (!parsed.ok) {
    return { ok: false, error: parsed.reason || 'that does not look like a mobile number' };
  }
  if (agreed !== true) {
    return {
      ok: false,
      error: 'the consent box was not ticked',
      why: 'A pre-ticked or unticked box is not permission. The person has to agree to the wording shown.',
    };
  }

  // A standing opt-out outranks a form submission, and an unreadable list fails
  // closed — somebody who said stop must not be re-enrolled by a web form, least
  // of all one that anybody can fill in.
  const { isPhoneSuppressed } = await import('./contacts.js');
  try {
    if (await isPhoneSuppressed(parsed.e164)) {
      return { ok: false, error: 'this number has asked not to be contacted', needsPerson: true };
    }
  } catch {
    return { ok: false, error: 'whether this number had opted out could not be read', needsPerson: true };
  }

  // ---- PENDING, not consent --------------------------------------------
  //
  // R17.2, and the reason this function no longer grants anything.
  //
  // A web form proves that SOMEBODY typed a number. It does not prove it was
  // THEIR number. Anyone could enter a competitor's mobile, an ex-partner's, or
  // simply mistype a digit and land on a stranger — and before this change that
  // was enough to make the number promotional-SMS eligible. A probe confirmed
  // it: a third party enrolled a contact they had no relationship with, and the
  // promotional gate opened.
  //
  // So the form now records an INTENT TO OPT IN and nothing more. Promotional
  // permission arrives only when a message is received FROM that handset, which
  // is the one thing a third party cannot fake from a web page. No message is
  // sent to an unconfirmed number either — not even a confirmation prompt —
  // because sending to a number somebody else typed is the harm, and a
  // "did you mean to sign up?" text to a stranger is still a text to a stranger.
  const pending = {
    e164: parsed.e164,
    name: String(name || '').slice(0, 60),
    source: pageUrl ? `opt-in form at ${String(pageUrl).slice(0, 100)}` : 'opt-in form',
    wording: publishedTerms({ business }),
    wordingVersion: OPTIN_WORDING_VERSION,
    at: new Date(at).toISOString(),
    state: 'awaiting-confirmation',
  };
  await store.set(pendingKey(parsed.e164), JSON.stringify(pending), { ex: PENDING_TTL_SEC }).catch(() => {});

  return {
    ok: true,
    pending: true,
    scope: 'none',
    e164: parsed.e164,
    confirmBy: `text ${OPTIN_KEYWORD} from that phone`,
    record: pending,
    note: 'Recorded as an intention, not as permission. Nothing may be sent to this number until a '
      + 'message arrives from it.',
  };
}

const pendingKey = (e164) => `optin:pending:${e164}`;
/** A form submission is good for a week; after that they can submit again. */
export const PENDING_TTL_SEC = 60 * 60 * 24 * 7;

/** A form submission that is waiting for the handset to confirm it. */
export async function pendingWebOptIn(e164) {
  const raw = await store.get(pendingKey(e164)).catch(() => null);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/**
 * How each permission a contact holds was obtained, for the screen that has to
 * explain why texting is or is not allowed.
 *
 * Ordered weakest-first on purpose: the question a person asks is "can I send
 * this particular message", and the honest answer is governed by what the
 * record actually supports, not by the best-sounding entry in the log.
 */
export const SOURCE_STRENGTH = Object.freeze({
  'owner-recorded': { rank: 1, max: 'one_time_followup', words: 'the owner recorded a conversation' },
  'web-form': { rank: 2, max: 'promotional', words: 'they filled in the opt-in form themselves' },
  keyword: { rank: 3, max: 'promotional', words: 'they texted the keyword themselves' },
});

export function describeSource(record) {
  if (!record) return null;
  const src = String(record.source || '');
  if (/texted .* to our number/i.test(src)) return SOURCE_STRENGTH.keyword;
  if (/opt-in form/i.test(src)) return SOURCE_STRENGTH['web-form'];
  return SOURCE_STRENGTH['owner-recorded'];
}
