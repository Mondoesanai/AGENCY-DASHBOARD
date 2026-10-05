// One conversation per person, across every channel.
//
// The thing this prevents is the experience of being on the receiving end of
// two systems that do not know about each other: an email pitch on Tuesday, a
// text making the same pitch on Wednesday, and a reply to one of them that the
// other never hears about. From the outside that is not "multi-channel", it is
// being pestered by something that is not listening.
//
// So history is kept against the CONTACT, not against a campaign or a channel,
// and four rules fall out of that:
//
//   1. A reply — on any channel — pauses the follow-ups on every channel.
//      Someone who answered is in a conversation, not in a sequence.
//   2. Manual takeover CANCELS queued automatic replies. Not "marks them as
//      superseded": cancels them, because the failure mode is the owner typing
//      a careful answer while a drafted one goes out underneath it.
//   3. Automatic turns are bounded. A model answering a stranger indefinitely
//      is how a system ends up making commitments nobody approved.
//   4. An unanswered cold email never becomes a text. That escalation is the
//      single most-complained-about pattern in outreach and it is prohibited
//      here rather than discouraged.

import { store } from './store.js';

const THREAD = (contactId) => `conv:${contactId}`;
const INDEX = 'conv:all';
const OWNERSHIP = (contactId) => `conv:owner:${contactId}`;
const PAUSED = (contactId) => `conv:paused:${contactId}`;

export const CHANNEL = Object.freeze({ EMAIL: 'email', SMS: 'sms' });

export const DIRECTION = Object.freeze({ OUT: 'outbound', IN: 'inbound' });

/** Who is driving this conversation right now. */
export const OWNER = Object.freeze({
  AUTOMATIC: 'automatic',   // drafts may be sent by the system, within limits
  DRAFT_ONLY: 'draft-only', // the system may draft; only a person sends
  PERSON: 'person',         // a person has taken over; nothing automatic goes out
});

/** How many automatic turns before a person has to look. */
export const MAX_AUTOMATIC_TURNS = 3;

async function read(key, fallback) {
  try {
    const raw = await store.get(key);
    if (!raw) return fallback;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return undefined; // UNDEFINED means "could not read", which is not "empty"
  }
}

/** The whole history for one person, oldest first. */
export async function thread(contactId) {
  const t = await read(THREAD(contactId), []);
  if (t === undefined) return { ok: false, error: 'the conversation could not be read', messages: [] };
  return { ok: true, messages: Array.isArray(t) ? t : [] };
}

/**
 * Record a message. Everything that goes out or comes in lands here, whatever
 * sent it — campaign step, drafted reply, owner typing in the dashboard.
 */
export async function record({
  contactId, channel, direction, body = '', subject = null,
  at = Date.now(), by = 'system', campaignId = null, messageId = null,
  state = null, meta = {},
}) {
  if (!contactId) return { ok: false, error: 'a message needs a contact' };
  if (!Object.values(CHANNEL).includes(channel)) return { ok: false, error: `unknown channel "${channel}"` };
  if (!Object.values(DIRECTION).includes(direction)) return { ok: false, error: `unknown direction "${direction}"` };

  const current = await thread(contactId);
  if (!current.ok) return { ok: false, error: current.error };

  const entry = {
    id: `m_${at}_${Math.random().toString(36).slice(2, 7)}`,
    contactId, channel, direction,
    subject: subject ? String(subject).slice(0, 200) : null,
    body: String(body).slice(0, 4000),
    at, by, campaignId, messageId, state, meta,
  };
  const next = [...current.messages, entry].slice(-200);
  await store.set(THREAD(contactId), JSON.stringify(next));
  await store.sadd(INDEX, contactId).catch(() => {});

  // An inbound message is a reply, and a reply changes everything downstream.
  if (direction === DIRECTION.IN) await onInbound(contactId, entry);
  return { ok: true, entry };
}

/**
 * Someone answered.
 *
 * Pauses sequences on EVERY channel, not just the one they replied on — they
 * are talking to a person now, and a scheduled follow-up arriving mid-exchange
 * reads as nobody having noticed.
 */
async function onInbound(contactId, entry) {
  await store.set(PAUSED(contactId), JSON.stringify({
    paused: true, at: entry.at, reason: `they replied on ${entry.channel}`,
  })).catch(() => {});

  try {
    const { stopContact } = await import('./campaigns.js');
    await stopContact(contactId, `replied on ${entry.channel}`);
  } catch { /* the pause above is what actually holds the sends */ }
}

/** Is this contact's sequence paused, and why? Fails closed. */
export async function isPaused(contactId) {
  const p = await read(PAUSED(contactId), null);
  if (p === undefined) {
    return { paused: true, known: false, reason: 'the conversation state could not be read, so nothing is sent' };
  }
  if (!p) return { paused: false, known: true };
  return { paused: !!p.paused, known: true, reason: p.reason, at: p.at };
}

/** The owner can pause or resume one person without touching anyone else. */
export async function setPaused(contactId, paused, { reason = '', by = 'owner' } = {}) {
  await store.set(PAUSED(contactId), JSON.stringify({
    paused: !!paused, at: Date.now(), reason: reason || (paused ? 'paused by the owner' : ''), by,
  }));
  return { ok: true, paused: !!paused };
}

// ---------------------------------------------------------------------------
// Ownership and takeover
// ---------------------------------------------------------------------------

export async function ownership(contactId) {
  const o = await read(OWNERSHIP(contactId), null);
  if (o === undefined) {
    // cannot read who owns it -> treat as a person's, so nothing automatic goes
    return { mode: OWNER.PERSON, known: false, reason: 'ownership could not be read, so nothing automatic will send' };
  }
  if (!o) return { mode: OWNER.DRAFT_ONLY, known: true, reason: 'default: drafts are written, a person sends them' };
  return { mode: o.mode, known: true, by: o.by, at: o.at, reason: o.reason || '' };
}

/**
 * A person takes over.
 *
 * Cancels queued automatic replies as part of the same action — the whole
 * point. An implementation that set a flag and left the queue alone would
 * still let a drafted reply go out while the owner was typing.
 */
export async function takeOver(contactId, { by = 'owner', reason = 'the owner took over' } = {}) {
  await store.set(OWNERSHIP(contactId), JSON.stringify({
    mode: OWNER.PERSON, by, at: Date.now(), reason,
  }));
  const cancelled = await cancelQueuedReplies(contactId, 'a person took over this conversation');
  return { ok: true, mode: OWNER.PERSON, cancelledQueuedReplies: cancelled.cancelled, cancelled: cancelled.ids };
}

export async function setOwnership(contactId, mode, { by = 'owner' } = {}) {
  if (!Object.values(OWNER).includes(mode)) return { ok: false, error: `unknown mode "${mode}"` };
  await store.set(OWNERSHIP(contactId), JSON.stringify({ mode, by, at: Date.now() }));
  if (mode === OWNER.PERSON) await cancelQueuedReplies(contactId, 'a person took over this conversation');
  return { ok: true, mode };
}

/**
 * Cancel anything queued that would answer this person automatically.
 *
 * Walks the real job queue rather than keeping a private list, because a
 * private list is one more thing that can disagree with what will actually run.
 */
export async function cancelQueuedReplies(contactId, reason = 'cancelled') {
  const ids = [];
  try {
    const { listJobs, cancelJob } = await import('./jobs.js');
    const jobs = await listJobs({ limit: 500 });
    for (const job of jobs.jobs || jobs || []) {
      const p = job.payload || {};
      const isReply = /reply|sms-send|auto-answer/.test(String(job.type || ''));
      if (!isReply) continue;
      if (p.contactId !== contactId) continue;
      if (job.state === 'done' || job.state === 'dead' || job.state === 'cancelled') continue;
      const out = await cancelJob(job.id, reason);
      if (out && out.ok !== false) ids.push(job.id);
    }
  } catch {
    // the queue could not be read; the ownership flag still blocks sending,
    // and this is reported rather than silently treated as "nothing queued"
    return { cancelled: 0, ids: [], known: false };
  }
  return { cancelled: ids.length, ids, known: true };
}

/**
 * May the system answer this person automatically right now?
 *
 * Four ways the answer is no, and the order is deliberate: ownership first
 * (a person is here), then the turn budget, then whether the topic is one we
 * have approved information for.
 */
export async function mayAutoReply(contactId, { confidence = 1, topicApproved = true } = {}) {
  const own = await ownership(contactId);
  if (own.mode === OWNER.PERSON) {
    return { ok: false, reason: own.reason || 'a person has taken over this conversation' };
  }
  if (own.mode === OWNER.DRAFT_ONLY) {
    return { ok: false, reason: 'this conversation is in draft-only mode, so a person sends every reply', draftOnly: true };
  }
  if (!own.known) return { ok: false, reason: own.reason };

  const t = await thread(contactId);
  if (!t.ok) return { ok: false, reason: 'the conversation could not be read, so nothing is sent' };
  const autoTurns = t.messages.filter((m) => m.direction === DIRECTION.OUT && m.by === 'automatic').length;
  if (autoTurns >= MAX_AUTOMATIC_TURNS) {
    return {
      ok: false,
      reason: `${autoTurns} automatic replies have already gone to this person. A person takes it from here.`,
      escalate: true,
    };
  }
  if (!topicApproved) {
    return { ok: false, reason: 'this question is outside what the system has approved information for', escalate: true };
  }
  if (confidence < 0.6) {
    return { ok: false, reason: `the draft is only ${Math.round(confidence * 100)}% confident, which is not enough to send unseen`, escalate: true };
  }
  return { ok: true, turnsUsed: autoTurns, turnsLeft: MAX_AUTOMATIC_TURNS - autoTurns };
}

// ---------------------------------------------------------------------------
// Choosing a channel
// ---------------------------------------------------------------------------

/**
 * Which channel should the next message use — if any?
 *
 * The rule that does the most work is the prohibition: an unanswered cold
 * email does NOT become a text. Escalating channels because someone ignored
 * you is the behaviour people describe as harassment, and it is refused here
 * by name rather than left to judgement.
 */
export async function chooseChannel(contact, { purpose = 'one_time_followup', preferred = null } = {}) {
  if (!contact) return { ok: false, reason: 'no contact' };
  const contactId = contact.id;

  const paused = await isPaused(contactId);
  if (paused.paused) return { ok: false, reason: paused.reason || 'this conversation is paused' };

  const t = await thread(contactId);
  if (!t.ok) return { ok: false, reason: 'the conversation could not be read' };
  const msgs = t.messages;

  const theyReplied = msgs.find((m) => m.direction === DIRECTION.IN);
  const coldEmailSent = msgs.some((m) => m.direction === DIRECTION.OUT && m.channel === CHANNEL.EMAIL && m.campaignId);

  // what each channel permits, asked of the real gates
  const { canContact } = await import('./contacts.js');
  const { mayText } = await import('./phone.js');
  const emailOk = await canContact(contact, { channel: 'email', purpose: 'promotional' });
  const smsOk = await mayText({ contact, purpose });

  // 1. THE PROHIBITION
  if (!theyReplied && coldEmailSent && smsOk.ok) {
    return {
      ok: false,
      reason: 'an unanswered cold email does not become a text. If they did not reply to the email, the answer is to stop, not to switch channel.',
      prohibited: true,
    };
  }

  // 2. they answered on a channel — reply where they are
  if (theyReplied) {
    const where = theyReplied.channel;
    const gate = where === CHANNEL.SMS ? smsOk : emailOk;
    if (gate.ok) return { ok: true, channel: where, reason: `they replied on ${where}, so the conversation continues there` };
    return { ok: false, reason: `they replied on ${where} but that channel is no longer permitted: ${gate.reason}` };
  }

  // 3. an explicit preference, if it is permitted
  if (preferred === CHANNEL.SMS && smsOk.ok) return { ok: true, channel: CHANNEL.SMS, reason: 'their recorded preference' };
  if (preferred === CHANNEL.EMAIL && emailOk.ok) return { ok: true, channel: CHANNEL.EMAIL, reason: 'their recorded preference' };

  // 4. whatever is actually permitted, email first — it is the lower-cost,
  //    lower-intrusion channel and the one most consent covers
  if (emailOk.ok) return { ok: true, channel: CHANNEL.EMAIL, reason: 'email is permitted' };
  if (smsOk.ok) return { ok: true, channel: CHANNEL.SMS, reason: 'SMS is permitted and email is not' };

  return {
    ok: false,
    reason: `no channel is permitted — email: ${emailOk.reason || 'no'}; SMS: ${smsOk.reason || 'no'}`,
  };
}

/** Everything the inbox needs for one person. */
export async function conversationFor(contactId) {
  const [t, own, paused] = await Promise.all([thread(contactId), ownership(contactId), isPaused(contactId)]);
  return {
    ok: t.ok,
    contactId,
    messages: t.messages,
    ownership: own,
    paused,
    lastInbound: [...t.messages].reverse().find((m) => m.direction === DIRECTION.IN) || null,
    lastOutbound: [...t.messages].reverse().find((m) => m.direction === DIRECTION.OUT) || null,
  };
}

/** Every conversation with something waiting, newest first. */
export async function waiting({ limit = 50 } = {}) {
  let ids = [];
  try {
    ids = await store.smembers(INDEX);
  } catch {
    return { ok: false, error: 'the conversation list could not be read', conversations: [] };
  }
  const out = [];
  for (const id of ids) {
    const c = await conversationFor(id);
    if (!c.ok || !c.lastInbound) continue;
    const answered = c.lastOutbound && c.lastOutbound.at > c.lastInbound.at;
    if (!answered) out.push(c);
  }
  out.sort((a, b) => (b.lastInbound?.at || 0) - (a.lastInbound?.at || 0));
  return { ok: true, conversations: out.slice(0, limit), total: out.length };
}
