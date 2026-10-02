// R6.7 — match an inbound reply to the message it is actually a reply to.
//
// What was there before matched on the sender's email address alone, and then
// picked the campaign by iterating `campaigns:all` and taking the FIRST one the
// contact had been sent anything in. A contact enrolled in two campaigns had
// their reply attributed to whichever campaign the key iteration happened to
// hit first. That is not a long-shot edge case — a prospect who did not answer
// a "no website found" campaign and was later enrolled in a follow-up is
// exactly the person who eventually replies, and the credit landed on the
// wrong campaign. Everything downstream — which message works, cost per
// booking, whether to send more of them — is built on that attribution.
//
// Email already carries the answer. A reply quotes the message it answers in
// `In-Reply-To`, and the whole ancestry in `References`. If we record the
// Message-ID we sent, the match is exact and needs no guessing.
//
// The order here is deliberate, strongest evidence first:
//
//   1. In-Reply-To / References matching a Message-ID we recorded  → certain
//   2. the provider's own thread id, if the adapter gives us one   → certain
//   3. exact sender address + exactly one campaign they were sent  → likely
//   4. exact sender address + several campaigns                    → ambiguous
//   5. no address match                                            → none
//
// Ambiguous is a real answer and it is kept. Attributing a reply to a guessed
// campaign would quietly corrupt every number built on it (R2.9), so the reply
// is recorded against the contact with the campaign left unknown and flagged
// for a person.

import { store } from './store.js';

export const MATCH = Object.freeze({
  THREAD: 'thread-header',     // certain: the reply quotes a message we sent
  PROVIDER_THREAD: 'provider-thread',
  SOLE_CAMPAIGN: 'sole-campaign',
  AMBIGUOUS: 'ambiguous-campaign',
  NONE: 'no-match',
});

export const CONFIDENCE = Object.freeze({
  'thread-header': 'certain',
  'provider-thread': 'certain',
  'sole-campaign': 'likely',
  'ambiguous-campaign': 'unknown',
  'no-match': 'none',
});

const MSGKEY = (id) => `thread:msg:${normaliseId(id)}`;

/** Message-IDs are compared without their angle brackets or case. */
export function normaliseId(id) {
  return String(id || '').trim().replace(/^<|>$/g, '').toLowerCase();
}

/**
 * Pull every message id a reply refers to, newest-first.
 *
 * `In-Reply-To` is the direct parent and is the strongest single signal.
 * `References` is the whole ancestry, oldest first, so it is reversed: the
 * nearest ancestor is the one most likely to be ours.
 */
export function referencedIds(headers = {}) {
  const get = (name) => {
    const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
    return k ? String(headers[k] || '') : '';
  };
  // Most senders write `<id@host>`, but a bare id without brackets is common
  // enough in the wild that refusing it would drop real matches.
  const parse = (raw) => {
    const bracketed = raw.match(/<[^>]+>/g);
    if (bracketed) return bracketed;
    const bare = raw.trim();
    return bare && /\S+@\S+/.test(bare) ? bare.split(/\s+/) : [];
  };
  const ids = [];
  for (const r of parse(get('in-reply-to'))) ids.push(normaliseId(r));
  for (const r of parse(get('references')).reverse()) ids.push(normaliseId(r));
  return [...new Set(ids.filter(Boolean))];
}

/**
 * Remember that we sent this Message-ID to this contact in this campaign.
 * Called from the send path — a reply can only be matched to a message we
 * actually recorded.
 */
export async function recordSentMessage({ messageId, contactId, campaignId, step = null, at = Date.now(), threadId = null }) {
  const id = normaliseId(messageId);
  if (!id || !contactId) return { ok: false, error: 'a sent message needs an id and a contact' };
  const rec = { messageId: id, contactId, campaignId: campaignId || null, step, at, threadId: threadId ? String(threadId) : null };
  await store.set(MSGKEY(id), JSON.stringify(rec), { ex: 60 * 60 * 24 * 365 }).catch(() => {});
  if (rec.threadId) {
    await store.set(`thread:prov:${rec.threadId}`, JSON.stringify(rec), { ex: 60 * 60 * 24 * 365 }).catch(() => {});
  }
  return { ok: true, ...rec };
}

async function readJson(key) {
  let raw;
  try {
    raw = await store.get(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

/** Which of the ids this reply quotes is one of ours? */
export async function matchByHeaders(headers = {}) {
  for (const id of referencedIds(headers)) {
    const rec = await readJson(MSGKEY(id));
    if (rec) return rec;
  }
  return null;
}

/**
 * Every campaign this contact has actually been SENT something in.
 * Enrolment is not a send: a reply cannot be an answer to a message that was
 * never delivered, so an enrolled-but-unsent campaign is not a candidate.
 */
export async function campaignsSentTo(contactId) {
  const ids = await store.smembers('campaigns:all').catch(() => []);
  const out = [];
  for (const cid of ids) {
    const m = await readJson(`campaign:member:${cid}:${contactId}`);
    if (!m) continue;
    if ((m.sentSteps || []).length > 0) out.push({ campaignId: cid, lastSentAt: m.lastSentAt || 0, steps: m.sentSteps.length });
  }
  return out.sort((a, b) => (b.lastSentAt || 0) - (a.lastSentAt || 0));
}

/**
 * The whole match, strongest evidence first.
 *
 * @param {object} msg               the inbound message
 * @param {function} findContact     address → { id } | null (exact match only)
 * @returns {{contactId, campaignId, how, confidence, reason, candidates}}
 */
export async function matchReply(msg = {}, { findContact } = {}) {
  const headers = msg.headers || {};

  // 1. the reply quotes a message we sent. Nothing beats this.
  const byHeader = await matchByHeaders(headers);
  if (byHeader) {
    return {
      contactId: byHeader.contactId,
      campaignId: byHeader.campaignId,
      step: byHeader.step ?? null,
      how: MATCH.THREAD,
      confidence: CONFIDENCE[MATCH.THREAD],
      reason: 'the reply quotes a message we sent, so the contact and campaign are exact',
      candidates: [],
    };
  }

  // 2. the provider's own thread id, where the adapter supplies one
  if (msg.threadId) {
    const byThread = await readJson(`thread:prov:${msg.threadId}`);
    if (byThread) {
      return {
        contactId: byThread.contactId,
        campaignId: byThread.campaignId,
        step: byThread.step ?? null,
        how: MATCH.PROVIDER_THREAD,
        confidence: CONFIDENCE[MATCH.PROVIDER_THREAD],
        reason: 'the provider put this in the same thread as a message we sent',
        candidates: [],
      };
    }
  }

  // 3/4/5. fall back to the sender's address
  const address = addressOf(msg.from);
  const contact = typeof findContact === 'function' ? await findContact(address, msg) : null;
  if (!contact) {
    return {
      contactId: null, campaignId: null, step: null,
      how: MATCH.NONE, confidence: CONFIDENCE[MATCH.NONE],
      reason: address ? `no contact matches ${address}` : 'the message had no usable sender address',
      candidates: [],
    };
  }

  const sent = await campaignsSentTo(contact.id);
  if (sent.length === 1) {
    return {
      contactId: contact.id, campaignId: sent[0].campaignId, step: null,
      how: MATCH.SOLE_CAMPAIGN, confidence: CONFIDENCE[MATCH.SOLE_CAMPAIGN],
      reason: 'the sender matches a contact who has been sent exactly one campaign',
      candidates: sent,
    };
  }
  if (sent.length === 0) {
    return {
      contactId: contact.id, campaignId: null, step: null,
      how: MATCH.AMBIGUOUS, confidence: CONFIDENCE[MATCH.AMBIGUOUS],
      reason: 'the sender is a known contact, but nothing has been sent to them — this is not a reply to a campaign',
      candidates: [],
    };
  }
  // More than one. The reply still belongs to this person — it must still
  // pause their follow-ups — but which campaign earned it is NOT known, and
  // guessing would put the credit on the wrong message.
  return {
    contactId: contact.id,
    campaignId: null,
    step: null,
    how: MATCH.AMBIGUOUS,
    confidence: CONFIDENCE[MATCH.AMBIGUOUS],
    reason: `this contact has been sent ${sent.length} campaigns and the reply quotes none of them, so which one it answers is unknown`,
    candidates: sent,
  };
}

/** `Name <a@b.test>` or a bare address, lowercased. */
export function addressOf(from) {
  const s = String(from || '');
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}
