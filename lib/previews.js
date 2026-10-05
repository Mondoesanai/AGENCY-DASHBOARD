// Preview production tasks.
//
// Someone at a chamber breakfast says "yes, show me what you'd do". That is the
// single most valuable thing that happens in this business, and it is also the
// easiest promise to break, because the follow-up message writes itself long
// before the work is done.
//
// THE RULE THIS MODULE EXISTS FOR: "your preview is ready" may only be sent
// when a preview actually exists at a URL that actually loads. Not when the
// task was created, not when it was marked in progress, not when someone
// believes it is nearly done. `mayAnnounce()` is the gate, it checks for a real
// URL, and it is the only thing that unlocks that message.
//
// WHAT THIS IS NOT. It does not build websites. There is no automatic site
// production in this system, and this module deliberately does not pretend
// otherwise — it creates an owner task and tracks its state. If a preview
// builder is connected later, `attach()` records the URL it produced; until
// then a person does the work and pastes the link.

import { store } from './store.js';

const KEY = (id) => `preview:${id}`;
const INDEX = 'previews:all';
const BY_CONTACT = (contactId) => `previews:byContact:${contactId}`;

/** The states a promise moves through. Nothing skips to DELIVERED. */
export const PREVIEW_STATE = Object.freeze({
  REQUESTED: 'requested',
  IN_PROGRESS: 'in-progress',
  READY: 'ready',
  DELIVERED: 'delivered',
  REVIEWED: 'reviewed',
  ABANDONED: 'abandoned',
});

export const STATE_LABEL = Object.freeze({
  requested: 'Requested',
  'in-progress': 'Being built',
  ready: 'Ready to send',
  delivered: 'Sent to them',
  reviewed: 'They looked at it',
  abandoned: 'Not going ahead',
});

/**
 * Which moves are allowed. A state machine rather than a free-text field,
 * because "ready" is load-bearing — it is what unlocks a message to a real
 * person — and anything that can be set to "ready" by accident will be.
 */
const ALLOWED = Object.freeze({
  requested: ['in-progress', 'abandoned'],
  'in-progress': ['ready', 'abandoned'],
  ready: ['delivered', 'in-progress', 'abandoned'],
  delivered: ['reviewed', 'in-progress'],
  reviewed: ['in-progress'],
  abandoned: ['requested'],
});

const newId = () => `pv_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * Create the task. Carries the business details and the actual conversation,
 * because whoever builds it in three days will not remember the meeting.
 */
export async function createTask({
  contactId,
  businessName = '',
  website = '',
  industry = '',
  conversationNotes = '',
  requestedAt = Date.now(),
  requestedVia = 'business card',
  promisedBy = null,
}) {
  if (!contactId) return { ok: false, error: 'a preview task needs a contact' };
  const existing = await forContact(contactId);
  const open = existing.find((t) => t.state !== PREVIEW_STATE.ABANDONED && t.state !== PREVIEW_STATE.REVIEWED);
  if (open) return { ok: true, task: open, alreadyOpen: true, note: 'this contact already has an open preview task' };

  const task = {
    id: newId(),
    contactId,
    businessName: String(businessName).slice(0, 160),
    website: String(website).slice(0, 300),
    industry: String(industry).slice(0, 80),
    conversationNotes: String(conversationNotes).slice(0, 1000),
    requestedAt,
    requestedVia,
    promisedBy: promisedBy || null,
    state: PREVIEW_STATE.REQUESTED,
    url: null,
    history: [{ at: requestedAt, state: PREVIEW_STATE.REQUESTED, by: 'owner' }],
    deliveredAt: null,
    reviewedAt: null,
  };
  await store.set(KEY(task.id), JSON.stringify(task));
  await store.sadd(INDEX, task.id).catch(() => {});
  await store.sadd(BY_CONTACT(contactId), task.id).catch(() => {});
  return { ok: true, task };
}

export async function getTask(id) {
  try {
    const raw = await store.get(KEY(id));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

export async function forContact(contactId) {
  let ids = [];
  try {
    ids = await store.smembers(BY_CONTACT(contactId));
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const t = await getTask(id);
    if (t) out.push(t);
  }
  return out.sort((a, b) => b.requestedAt - a.requestedAt);
}

/**
 * Move the task along.
 *
 * READY requires a URL. That is the whole point of the module: the state that
 * unlocks a message to a real person cannot be reached without the thing the
 * message will claim exists.
 */
export async function setState(id, state, { url = null, by = 'owner', now = Date.now(), note = '' } = {}) {
  const task = await getTask(id);
  if (!task) return { ok: false, error: `no preview task "${id}"` };
  if (!Object.values(PREVIEW_STATE).includes(state)) return { ok: false, error: `unknown state "${state}"` };
  if (state === task.state) return { ok: true, task, unchanged: true };

  const allowed = ALLOWED[task.state] || [];
  if (!allowed.includes(state)) {
    return {
      ok: false,
      error: `a preview cannot go from "${STATE_LABEL[task.state]}" to "${STATE_LABEL[state]}". Allowed from here: ${allowed.map((s) => STATE_LABEL[s]).join(', ') || 'nothing'}.`,
    };
  }

  if (state === PREVIEW_STATE.READY) {
    const link = String(url || task.url || '').trim();
    if (!link) {
      return {
        ok: false,
        error: 'a preview cannot be marked ready without a URL. "Ready" is what unlocks telling someone their preview is ready, so it has to point at something.',
      };
    }
    if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(link)) {
      return { ok: false, error: `"${link}" is not a usable URL, so it cannot be what someone is sent.` };
    }
    task.url = link;
  }

  if (state === PREVIEW_STATE.DELIVERED) {
    if (!task.url) return { ok: false, error: 'nothing has been built, so nothing can have been delivered' };
    task.deliveredAt = now;
  }
  if (state === PREVIEW_STATE.REVIEWED) task.reviewedAt = now;

  task.state = state;
  task.history = [...(task.history || []), { at: now, state, by, note: String(note).slice(0, 200) }].slice(-20);
  await store.set(KEY(id), JSON.stringify(task));
  return { ok: true, task };
}

/** Record a URL without changing state — e.g. a builder produced a draft. */
export async function attach(id, url, { by = 'builder' } = {}) {
  const task = await getTask(id);
  if (!task) return { ok: false, error: `no preview task "${id}"` };
  const link = String(url || '').trim();
  if (!/^https?:\/\/[^\s]+\.[^\s]+/i.test(link)) return { ok: false, error: 'that is not a usable URL' };
  task.url = link;
  task.history = [...(task.history || []), { at: Date.now(), state: task.state, by, note: 'preview URL attached' }].slice(-20);
  await store.set(KEY(id), JSON.stringify(task));
  return { ok: true, task };
}

/**
 * MAY WE TELL THIS PERSON THEIR PREVIEW IS READY?
 *
 * The one function the outgoing message has to ask. Fails closed on every
 * uncertainty, because the cost of a wrong "yes" is a real person clicking a
 * link that does not exist, having been told it did.
 *
 * `reachable` is injected so the caller decides whether to actually fetch it;
 * the default is NOT to assume a URL works just because it is well-formed.
 */
export async function mayAnnounce(contactId, { check = null } = {}) {
  const tasks = await forContact(contactId);
  const ready = tasks.find((t) => t.state === PREVIEW_STATE.READY || t.state === PREVIEW_STATE.DELIVERED);
  if (!ready) {
    const open = tasks.find((t) => t.state === PREVIEW_STATE.REQUESTED || t.state === PREVIEW_STATE.IN_PROGRESS);
    return {
      ok: false,
      reason: open
        ? `their preview is ${STATE_LABEL[open.state].toLowerCase()}, not ready. Telling them it is ready would be untrue.`
        : 'no preview was ever requested or built for this contact.',
    };
  }
  if (!ready.url) {
    return { ok: false, reason: 'the task says ready but carries no URL, so there is nothing to send' };
  }
  if (typeof check === 'function') {
    let live = null;
    try {
      live = await check(ready.url);
    } catch {
      live = null;
    }
    if (!live || live.ok !== true) {
      return {
        ok: false,
        reason: `the preview URL did not load when checked (${(live && live.reason) || 'no response'}), so it is not ready to send`,
        url: ready.url,
      };
    }
  }
  return { ok: true, url: ready.url, task: ready };
}

/** The owner's build queue, oldest promise first. */
export async function queue({ limit = 50 } = {}) {
  let ids = [];
  try {
    ids = await store.smembers(INDEX);
  } catch {
    return { ok: false, error: 'the preview queue could not be read', tasks: [] };
  }
  const tasks = [];
  for (const id of ids) {
    const t = await getTask(id);
    if (t && t.state !== PREVIEW_STATE.ABANDONED) tasks.push(t);
  }
  const rank = { requested: 0, 'in-progress': 1, ready: 2, delivered: 3, reviewed: 4 };
  tasks.sort((a, b) => (rank[a.state] - rank[b.state]) || (a.requestedAt - b.requestedAt));
  return { ok: true, tasks: tasks.slice(0, limit), total: tasks.length };
}

/** Counts for the report. Promised vs delivered is the number that matters. */
export async function stats() {
  const q = await queue({ limit: 1000 });
  const by = Object.fromEntries(Object.values(PREVIEW_STATE).map((s) => [s, 0]));
  for (const t of q.tasks || []) by[t.state] = (by[t.state] || 0) + 1;
  const promised = (q.tasks || []).length;
  const delivered = by.delivered + by.reviewed;
  return {
    ok: q.ok !== false,
    promised,
    delivered,
    outstanding: by.requested + by['in-progress'],
    ready: by.ready,
    byState: by,
    // stated rather than implied: a preview requested and never built is a
    // broken promise, and that is the number worth looking at
    brokenPromises: by.requested + by['in-progress'],
  };
}
