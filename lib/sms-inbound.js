// R6.14 — STOP is immediate and OURS. HELP answers. Quiet hours are the
// recipient's, not ours. A provider failure is never silence.
//
// The line this replaces was a comment in `lib/sms-actions.js`:
//
//     if (cmd === 'stop') return ''; // Twilio handles STOP/opt-out itself
//
// Twilio does handle STOP at the carrier level for its own numbers, and that
// is genuinely useful, but relying on it alone is wrong in three ways:
//
//   1. OUR database would not know. The dashboard would still show the person
//      as contactable, campaigns would keep queueing messages for them, and
//      the owner would keep seeing them in lists as though nothing happened.
//   2. It is provider-specific. Change provider, change number pool, or send
//      one message through anything else, and the opt-out does not travel.
//   3. It covers SMS only. Someone who texts STOP has told us to stop — using
//      that to keep emailing them is a technicality, not consent.
//
// So STOP is recorded by us, first, before anything else can fail.
//
// QUIET HOURS are the recipient's local hours, not the sender's. A business in
// Texas texting a prospect in California at 8:30am Central is reaching them at
// 6:30am. The timezone is inferred from the area code, and where it cannot be
// inferred the send is REFUSED rather than guessed — the cost of refusing is a
// delayed message, and the cost of guessing is waking someone at 5am.

import { store } from './store.js';

// ---------------------------------------------------------------------------
// Inbound keywords
// ---------------------------------------------------------------------------

/** The opt-out words carriers require to be honoured, plus the obvious ones. */
export const STOP_WORDS = Object.freeze([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'optout', 'opt-out', 'revoke',
]);
export const HELP_WORDS = Object.freeze(['help', 'info']);
export const START_WORDS = Object.freeze(['start', 'unstop', 'yes']);

export const INBOUND = Object.freeze({
  STOP: 'stop',
  HELP: 'help',
  START: 'start',
  MESSAGE: 'message', // a real reply, for a person to read
});

/**
 * Classify one inbound message.
 *
 * Deliberately generous about what counts as STOP and strict about what counts
 * as START. Getting STOP wrong means continuing to message someone who told
 * you to stop; getting START wrong means failing to resume someone who asked
 * — the first is the one that matters, so ambiguity resolves towards stopping.
 */
export function classifyInbound(text) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: INBOUND.MESSAGE, word: null, text: raw };

  // punctuation and case are not meaningful here; "STOP." and "stop!" are stop
  const first = raw.toLowerCase().replace(/[^a-z\s-]/g, ' ').trim().split(/\s+/)[0] || '';
  const wholeShort = raw.toLowerCase().replace(/[^a-z\s-]/g, ' ').trim();

  if (STOP_WORDS.includes(first)) return { kind: INBOUND.STOP, word: first, text: raw };
  // "please stop", "stop texting me" — the word appears in a short message
  if (wholeShort.split(/\s+/).length <= 5 && STOP_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(wholeShort))) {
    return { kind: INBOUND.STOP, word: STOP_WORDS.find((w) => new RegExp(`\\b${w}\\b`).test(wholeShort)), text: raw };
  }
  if (HELP_WORDS.includes(first)) return { kind: INBOUND.HELP, word: first, text: raw };
  // START only when it is the entire message: "yes please send details" is a
  // reply to read, not a resubscribe instruction
  if (START_WORDS.includes(wholeShort)) return { kind: INBOUND.START, word: wholeShort, text: raw };
  return { kind: INBOUND.MESSAGE, word: null, text: raw };
}

/**
 * The HELP reply. Carriers require it to identify the sender, say what the
 * messages are, how to stop, and that rates may apply.
 */
export function helpReply({ business = '', supportEmail = '' } = {}) {
  const who = business || 'this sender';
  return [
    `${who}: you are receiving messages because you asked us to follow up.`,
    'Reply STOP to stop. Msg&data rates may apply.',
    supportEmail ? `Questions: ${supportEmail}` : '',
  ].filter(Boolean).join(' ');
}

export function stopReply({ business = '' } = {}) {
  const who = business || 'This sender';
  return `${who}: you will not receive any further messages. Reply START if that was a mistake.`;
}

// ---------------------------------------------------------------------------
// Handling inbound
// ---------------------------------------------------------------------------

/**
 * Handle one inbound message from a prospect.
 *
 * STOP is recorded FIRST and does not depend on anything else succeeding:
 * finding the contact, cancelling queued sends and notifying the owner are all
 * best-effort afterwards. If the suppression write is the only thing that
 * happens, the person still stops hearing from us, which is the promise.
 */
export async function handleInboundSms({ from, body, business = '', supportEmail = '', now = Date.now() }) {
  const { parseNumber } = await import('./phone.js');
  const parsed = parseNumber(from);
  const e164 = parsed.e164 || String(from || '').trim();
  const verdict = classifyInbound(body);

  if (verdict.kind === INBOUND.STOP) {
    // 1. ours, immediately, before anything that can fail
    await store.set(`suppress:phone:${e164}`, JSON.stringify({ at: new Date(now).toISOString(), reason: `replied ${verdict.word}` })).catch(() => {});

    const out = { kind: INBOUND.STOP, suppressed: true, e164, reply: stopReply({ business }), cancelled: 0, contactId: null, alsoEmail: false };

    // 2. everything else is best effort
    try {
      // findDuplicates is the one that exists and uses the byPhone index. An
      // earlier draft called a `findByPhone` that does not exist, guarded by a
      // typeof check — which would have degraded silently and left the contact
      // record untouched for ever.
      const { findDuplicates } = await import('./contacts.js');
      const matches = await findDuplicates({ phone: e164 });
      const contact = (matches || []).find((m) => m.certainty === 'exact' || m.certainty === 'likely')?.contact || null;
      if (contact) {
        out.contactId = contact.id;
        const { optOut } = await import('./contacts.js');
        // Someone who says stop has told us to stop. Continuing to email them
        // because they only said it by text is a technicality, not consent.
        await optOut({ contactId: contact.id, phone: e164, reason: `replied ${verdict.word}`, channel: 'sms' }).catch(() => {});
        out.alsoEmail = true;
        const { stopContact } = await import('./campaigns.js');
        const stopped = await stopContact(contact.id, `replied ${verdict.word}`).catch(() => null);
        out.cancelled = stopped?.totalCancelled || 0;
      }
    } catch { /* the suppression above already stops the messages */ }

    return out;
  }

  if (verdict.kind === INBOUND.HELP) {
    return { kind: INBOUND.HELP, reply: helpReply({ business, supportEmail }), suppressed: false, e164 };
  }

  if (verdict.kind === INBOUND.START) {
    // Resubscribing is NOT automatic. A previous STOP is a standing
    // instruction, and one word is thin evidence to overturn it, so this is
    // recorded for a person rather than acted on.
    return {
      kind: INBOUND.START,
      reply: '',
      suppressed: true,
      e164,
      needsPerson: true,
      note: 'Someone sent START after opting out. Resubscribing is not automatic — a person decides, and the consent record has to say what they agreed to.',
    };
  }

  // ---- a real reply from a person -------------------------------------
  //
  // This used to return `needsPerson: true` and stop. Nothing acted on it: the
  // message was not classified, not recorded, and did not pause anything. The
  // only consumer is the TwiML response in api/collect.js, which reads `reply`
  // and ignores the rest — so somebody texting "yes, send me the pricing"
  // produced an empty <Response/> and vanished. The email path had recorded
  // and queued replies since R7.2; the SMS path reached the same point and
  // dropped them.
  //
  // Three things now happen, in the order that matters if a later one fails:
  //
  //   1. PAUSE. Somebody answering is the clearest possible signal to stop
  //      sending at them. It happens first and across every channel, because
  //      continuing to email a person who just texted back is the same mistake
  //      wearing a different hat.
  //   2. CLASSIFY with the SAME classifier as email. Two classifiers for one
  //      question is how "not interested" comes to mean different things on
  //      two channels.
  //   3. RECORD into the SAME queue the owner already reads, so a text and an
  //      email arrive in one place rather than one being somewhere nobody
  //      thought to look.
  const out = { kind: INBOUND.MESSAGE, reply: '', suppressed: false, e164, needsPerson: true, text: verdict.text };

  let contact = null;
  try {
    const { findDuplicates } = await import('./contacts.js');
    const matches = await findDuplicates({ phone: e164 });
    contact = (matches || []).find((m) => m.certainty === 'exact' || m.certainty === 'likely')?.contact || null;
  } catch { /* an unmatched number is still classified below */ }
  out.contactId = contact?.id || null;

  if (contact) {
    // 1. stop talking, on every channel
    try {
      const { setPaused, record, CHANNEL, DIRECTION, cancelQueuedReplies } = await import('./conversations.js');
      await setPaused(contact.id, true, { reason: 'they replied', by: 'inbound-sms' });
      await cancelQueuedReplies(contact.id, 'they replied, so queued messages are not sent').catch(() => {});
      await record({
        contactId: contact.id, channel: CHANNEL.SMS, direction: DIRECTION.IN,
        body: verdict.text, at: now,
      }).catch(() => {});
      out.paused = true;
    } catch { out.paused = false; }
    try {
      const { stopContact } = await import('./campaigns.js');
      const stopped = await stopContact(contact.id, 'they replied by text').catch(() => null);
      out.cancelled = stopped?.totalCancelled || 0;
    } catch { /* the pause above already holds the conversation */ }
  }

  // 2. one classifier, shared with email
  try {
    const { classifyReply, recordReply, NOTIFY_KINDS, REPLY_KINDS } = await import('./replies.js');
    const cls = classifyReply({ text: verdict.text, from: e164 });
    out.replyKind = cls.kind;
    out.notify = NOTIFY_KINDS.has(cls.kind);

    // A wrong number is a correction, so it is handled differently from a
    // refusal: stop texting THIS NUMBER, but do not write off the business.
    // Marking them opted-out would throw away a real prospect who may be
    // perfectly reachable by email or at a different number — and leaving the
    // bad number unsuppressed means texting a stranger again.
    if (cls.kind === REPLY_KINDS.WRONG_NUMBER) {
      await store.set(`suppress:phone:${e164}`, JSON.stringify({
        at: new Date(now).toISOString(),
        reason: 'they told us this is the wrong number',
      })).catch(() => {});
      out.suppressed = true;
      out.wrongNumber = true;
      // the contact keeps every other channel; only the number is wrong
      if (contact) {
        try {
          const { saveContact } = await import('./contacts.js');
          await saveContact({ ...contact, phoneWrong: { at: new Date(now).toISOString(), saidBy: e164 } });
        } catch { /* the suppression above already stops the texts */ }
      }
      out.note = 'The number is suppressed. The business is NOT opted out — they may still be reachable by email or at another number.';
    }
    // 3. into the queue the owner already reads
    if (contact) {
      const rec = await recordReply({
        contactId: contact.id, kind: cls.kind, text: verdict.text, at: now,
        match: { channel: 'sms', from: e164 },
      }).catch(() => null);
      out.replyId = rec?.id || null;
    }
  } catch { /* the message is still returned for a person to read */ }

  return out;
}

// ---------------------------------------------------------------------------
// Quiet hours — the RECIPIENT's local time
// ---------------------------------------------------------------------------

/**
 * Area code → UTC offset band. Deliberately partial: this covers the common
 * North American codes, and anything not listed is UNKNOWN rather than
 * guessed. An unknown timezone refuses the send; the cost is a delayed
 * message, where the cost of a guess is waking someone at 5am.
 */
const AREA_TZ = Object.freeze({
  // Eastern
  201: 'America/New_York', 202: 'America/New_York', 203: 'America/New_York', 212: 'America/New_York',
  215: 'America/New_York', 229: 'America/New_York', 239: 'America/New_York', 240: 'America/New_York',
  305: 'America/New_York', 321: 'America/New_York', 347: 'America/New_York', 404: 'America/New_York',
  407: 'America/New_York', 412: 'America/New_York', 443: 'America/New_York', 508: 'America/New_York',
  516: 'America/New_York', 518: 'America/New_York', 561: 'America/New_York', 603: 'America/New_York',
  617: 'America/New_York', 646: 'America/New_York', 703: 'America/New_York', 716: 'America/New_York',
  718: 'America/New_York', 727: 'America/New_York', 813: 'America/New_York', 843: 'America/New_York',
  904: 'America/New_York', 917: 'America/New_York', 919: 'America/New_York', 954: 'America/New_York',
  // Central
  210: 'America/Chicago', 214: 'America/Chicago', 224: 'America/Chicago', 281: 'America/Chicago',
  312: 'America/Chicago', 314: 'America/Chicago', 316: 'America/Chicago', 405: 'America/Chicago',
  409: 'America/Chicago', 414: 'America/Chicago', 469: 'America/Chicago', 501: 'America/Chicago',
  504: 'America/Chicago', 512: 'America/Chicago', 601: 'America/Chicago', 612: 'America/Chicago',
  615: 'America/Chicago', 630: 'America/Chicago', 682: 'America/Chicago', 713: 'America/Chicago',
  737: 'America/Chicago', 763: 'America/Chicago', 817: 'America/Chicago', 832: 'America/Chicago',
  903: 'America/Chicago', 913: 'America/Chicago', 940: 'America/Chicago', 972: 'America/Chicago',
  // Mountain
  303: 'America/Denver', 385: 'America/Denver', 406: 'America/Denver', 505: 'America/Denver',
  575: 'America/Denver', 719: 'America/Denver', 720: 'America/Denver', 801: 'America/Denver',
  970: 'America/Denver', 602: 'America/Phoenix', 480: 'America/Phoenix', 520: 'America/Phoenix',
  // Pacific
  206: 'America/Los_Angeles', 213: 'America/Los_Angeles', 310: 'America/Los_Angeles',
  323: 'America/Los_Angeles', 408: 'America/Los_Angeles', 415: 'America/Los_Angeles',
  425: 'America/Los_Angeles', 503: 'America/Los_Angeles', 509: 'America/Los_Angeles',
  510: 'America/Los_Angeles', 530: 'America/Los_Angeles', 541: 'America/Los_Angeles',
  559: 'America/Los_Angeles', 619: 'America/Los_Angeles', 626: 'America/Los_Angeles',
  650: 'America/Los_Angeles', 702: 'America/Los_Angeles', 707: 'America/Los_Angeles',
  714: 'America/Los_Angeles', 760: 'America/Los_Angeles', 805: 'America/Los_Angeles',
  818: 'America/Los_Angeles', 858: 'America/Los_Angeles', 909: 'America/Los_Angeles',
  916: 'America/Los_Angeles', 925: 'America/Los_Angeles', 949: 'America/Los_Angeles',
});

export function timezoneForNumber(e164) {
  const m = String(e164 || '').match(/^\+1(\d{3})/);
  if (!m) return null;
  return AREA_TZ[Number(m[1])] || null;
}

/** The hour, 0–23, in a named zone. Uses the platform's own tz database. */
export function hourIn(timezone, at = Date.now()) {
  try {
    const s = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', hour12: false }).format(new Date(at));
    const h = Number(s);
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

/** TCPA's window: 8am to 9pm, the recipient's local time. */
export const QUIET_HOURS = Object.freeze({ earliest: 8, latest: 21 });

/**
 * May a message be sent to this number right now?
 *
 * An unknown timezone is a REFUSAL, not a default. The whole point of the rule
 * is the person on the other end, and "we could not work out where they are"
 * is not a reason to risk 5am.
 */
export function withinQuietHours(e164, { at = Date.now(), timezone = null } = {}) {
  const tz = timezone || timezoneForNumber(e164);
  if (!tz) {
    return {
      ok: false,
      reason: 'the recipient\'s timezone could not be worked out from the number, so the time where they are is unknown. Sending is refused rather than risking the middle of the night.',
      timezone: null,
      hour: null,
    };
  }
  const h = hourIn(tz, at);
  if (h === null) {
    return { ok: false, reason: `the local time in ${tz} could not be read`, timezone: tz, hour: null };
  }
  if (h < QUIET_HOURS.earliest || h >= QUIET_HOURS.latest) {
    return {
      ok: false,
      reason: `it is ${h}:00 where they are, outside the ${QUIET_HOURS.earliest}:00–${QUIET_HOURS.latest}:00 window`,
      timezone: tz,
      hour: h,
      retryAfterHour: QUIET_HOURS.earliest,
    };
  }
  return { ok: true, timezone: tz, hour: h };
}

// ---------------------------------------------------------------------------
// Provider failures
// ---------------------------------------------------------------------------

export const SEND_FAILURE = Object.freeze({
  PERMANENT: 'permanent',   // never retry: the number or the content is the problem
  TRANSIENT: 'transient',   // retry later
  AMBIGUOUS: 'ambiguous',   // unknown whether it was delivered — reconcile first
  SUPPRESSED: 'suppressed', // the carrier is enforcing an opt-out we did not know about
});

/**
 * Classify a provider failure.
 *
 * The one that matters most is `SUPPRESSED`: Twilio error 21610 means the
 * recipient has opted out at the carrier. That is the carrier telling us about
 * a STOP we never saw, and it must be written into OUR records — otherwise we
 * will try again tomorrow and be refused again, for ever, while the dashboard
 * keeps showing them as contactable.
 */
export function classifySendFailure(err = {}) {
  const code = Number(err.code || err.status || 0);
  const msg = String(err.message || err.error || '').toLowerCase();

  if (code === 21610 || /unsubscrib|opted out|blacklist/.test(msg)) {
    return { kind: SEND_FAILURE.SUPPRESSED, retry: false, recordOptOut: true, reason: 'the carrier reports this number has opted out' };
  }
  if (code === 21211 || code === 21614 || /invalid.*number|not a (valid )?mobile/.test(msg)) {
    return { kind: SEND_FAILURE.PERMANENT, retry: false, reason: 'the number cannot receive this message' };
  }
  if (code === 21408 || code === 21612 || /permission|not enabled|region/.test(msg)) {
    return { kind: SEND_FAILURE.PERMANENT, retry: false, reason: 'this account is not permitted to message that destination' };
  }
  if (code === 429 || code === 20429 || /rate limit|too many/.test(msg)) {
    return { kind: SEND_FAILURE.TRANSIENT, retry: true, retryAfterMs: 60000, reason: 'rate limited' };
  }
  if (code >= 500 || /timeout|timed out|socket hang up|econnreset|aborted/.test(msg)) {
    // a timeout is not a failure to send — it is not knowing
    return {
      kind: /timeout|timed out|socket hang up|aborted/.test(msg) ? SEND_FAILURE.AMBIGUOUS : SEND_FAILURE.TRANSIENT,
      retry: true,
      retryAfterMs: 30000,
      reason: /timeout|timed out|socket hang up|aborted/.test(msg)
        ? 'the request timed out, so whether it was delivered is unknown and must be reconciled before any retry'
        : 'the provider had a server error',
    };
  }
  return { kind: SEND_FAILURE.TRANSIENT, retry: true, retryAfterMs: 60000, reason: err.message || err.error || 'the provider refused without a reason we recognise' };
}

/**
 * Act on a classified failure. A carrier-reported opt-out is written into our
 * own records, which is the whole point of noticing it.
 */
export async function applySendFailure(e164, err) {
  const verdict = classifySendFailure(err);
  if (verdict.recordOptOut && e164) {
    await store.set(`suppress:phone:${e164}`, JSON.stringify({
      at: new Date().toISOString(),
      reason: 'the carrier reported an opt-out we had not recorded',
    })).catch(() => {});
    verdict.suppressedLocally = true;
  }
  return verdict;
}
