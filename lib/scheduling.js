// Real appointment slots, or none at all.
//
// R19.1. The one rule everything here serves: **never invent an open slot.**
// A visitor who picks a time that is not really free gets a confirmation for a
// meeting that will not happen, and finds out when nobody joins. That is worse
// than showing no times.
//
// WHY GOOGLE AND NOT CALENDLY. Established by checking, not assumed:
//
//   Calendly   `vercel env ls` shows NO CALENDLY_* variables of any kind — no
//              API token, no webhook key. The repository has an inbound webhook
//              verifier and a hardcoded booking link, and nothing that could
//              read availability. Its Scheduling API also needs a paid plan,
//              which this task is not authorised to buy. It cannot be tested,
//              so it cannot be the production path.
//   Google     GOOGLE_CLIENT_ID / SECRET / REFRESH_TOKEN are already set, and
//              lib/google.js already creates, updates and deletes calendar
//              events. What it lacked was a free/busy read — the piece that
//              makes a slot genuine rather than a guess.
//
// So Google is the production path and Calendly stays behind the same boundary,
// ready to be added without touching the form. `ADAPTERS` is the whole contract:
// anything that can answer `availability` and `book` can be dropped in.
//
// THE DISCONNECTED ADAPTER IS NOT A STUB. With no credentials the honest
// product is a CALL REQUEST, not a confirmed appointment, and the page must say
// so. An adapter that quietly returned plausible times would be the exact lie
// this module exists to prevent.

import { store } from './store.js';

export const SCHED = Object.freeze({
  GOOGLE: 'google',
  CALENDLY: 'calendly',
  NONE: 'disconnected',
});

/**
 * What kind of call a slot can honestly be.
 *
 * These are shared constants rather than literals because they were literals
 * first, and three modules spelled them three ways: the slot list said
 * "introductory", the booking adapter said "introductory call", and the
 * confirmation compared against "introductory" and so never matched — so a
 * slot labelled "your preview may not be built yet" produced a confirmation
 * promising a walkthrough. The whole point of the distinction is honesty about
 * timing, and a mismatched string quietly inverted it.
 */
export const SLOT_KIND = Object.freeze({
  WALKTHROUGH: 'preview-walkthrough',
  INTRODUCTORY: 'introductory',
});

export const SLOT_KIND_LABEL = Object.freeze({
  'preview-walkthrough': 'Preview walkthrough',
  introductory: 'Introductory call',
});

/**
 * Owner rules. Every one of these narrows availability; none widens it.
 *
 * `previewLeadHours` is the interesting one: it is not a calendar constraint at
 * all, it is how long it takes to actually BUILD a preview. A call booked inside
 * that window is still a real call — it just cannot be a preview walkthrough, so
 * the page calls it an introductory call instead of promising something that
 * will not exist yet.
 */
export const DEFAULT_RULES = Object.freeze({
  timezone: 'America/Chicago',
  workdays: [1, 2, 3, 4, 5],          // Mon–Fri in the owner's timezone
  startHour: 9,
  endHour: 17,
  slotMinutes: 30,
  bufferMinutes: 15,                   // gap kept either side of an existing event
  minLeadHours: 4,                     // nothing sooner than this, ever
  previewLeadHours: 48,                // below this a call is INTRODUCTORY, not a walkthrough
  maxPerDay: 4,                        // capacity: preview calls are not the only work
  horizonDays: 14,
});

const RULES_KEY = 'scheduling:rules';

export async function getRules() {
  try {
    const raw = await store.get(RULES_KEY);
    const saved = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    return { ...DEFAULT_RULES, ...(saved || {}) };
  } catch {
    // An unreadable rule set must not mean "no rules". Falling back to the
    // defaults keeps every constraint in force; falling back to {} would drop
    // the lead time and offer a call in ten minutes.
    return { ...DEFAULT_RULES };
  }
}

export async function saveRules(patch = {}) {
  const next = { ...(await getRules()), ...patch };
  await store.set(RULES_KEY, JSON.stringify(next));
  return next;
}

/** Which adapter this deployment actually has, decided by credentials. */
export function schedulingProvider(env = process.env) {
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN) return SCHED.GOOGLE;
  if (env.CALENDLY_API_TOKEN && env.CALENDLY_EVENT_TYPE) return SCHED.CALENDLY;
  return SCHED.NONE;
}

/**
 * Candidate slots from the rules alone, before anything is removed.
 *
 * Pure, so every boundary is testable without a calendar. Times are produced in
 * the OWNER's timezone — converting for the visitor happens at the edge, once,
 * where the visitor's zone is actually known.
 */
export function candidateSlots(rules, { now = Date.now() } = {}) {
  const r = { ...DEFAULT_RULES, ...rules };
  const out = [];
  const earliest = now + r.minLeadHours * 3600e3;
  const latest = now + r.horizonDays * 86400e3;

  // Walk day by day in the owner's zone rather than in UTC, so a 9am slot stays
  // 9am across a daylight-saving change.
  for (let d = 0; d <= r.horizonDays; d++) {
    const dayStart = new Date(now + d * 86400e3);
    const local = new Date(dayStart.toLocaleString('en-US', { timeZone: r.timezone }));
    if (!r.workdays.includes(local.getDay())) continue;

    const offset = dayStart.getTime() - local.getTime();
    let madeToday = 0;
    for (let h = r.startHour * 60; h + r.slotMinutes <= r.endHour * 60; h += r.slotMinutes) {
      if (madeToday >= r.maxPerDay) break;
      const slotLocal = new Date(local);
      slotLocal.setHours(0, 0, 0, 0);
      const startAt = slotLocal.getTime() + h * 60e3 + offset;
      if (startAt < earliest || startAt > latest) continue;
      out.push({
        startAt,
        endAt: startAt + r.slotMinutes * 60e3,
        minutes: r.slotMinutes,
        // Honest about what the call can be. Below the production lead time a
        // preview cannot exist yet, so it is an introduction, not a walkthrough.
        kind: startAt - now >= r.previewLeadHours * 3600e3 ? SLOT_KIND.WALKTHROUGH : SLOT_KIND.INTRODUCTORY,
      });
      madeToday += 1;
    }
  }
  return out;
}

/**
 * Remove anything that collides with a real busy period, plus its buffer.
 *
 * `busy` is whatever the provider reported. An EMPTY array means "the calendar
 * said nothing is booked"; `null` means "we could not ask", and the caller must
 * treat those differently — which is why this refuses to be given null.
 */
export function removeBusy(slots, busy, rules) {
  if (!Array.isArray(busy)) {
    throw new Error('removeBusy needs a real busy list; "unknown" must not be treated as "free"');
  }
  const buf = (rules?.bufferMinutes ?? DEFAULT_RULES.bufferMinutes) * 60e3;
  return slots.filter((s) => !busy.some((b) => {
    const bs = Number(b.start ?? b.startAt);
    const be = Number(b.end ?? b.endAt);
    if (!Number.isFinite(bs) || !Number.isFinite(be)) return true; // unparseable = treat as busy
    return s.startAt < be + buf && s.endAt + buf > bs;
  }));
}

/** The adapter contract. Anything satisfying this can back the form. */
export function createDisconnectedScheduler(reason = 'no calendar is connected') {
  return {
    name: SCHED.NONE,
    connected: false,
    reason,
    async availability() {
      // NOT an empty slot list — that would read as "fully booked". The caller
      // has to be able to tell "no calendar" from "no free times".
      return { ok: false, connected: false, reason, slots: [] };
    },
    async book() {
      return {
        ok: false,
        connected: false,
        reason,
        // The honest product with no calendar: a request, not an appointment.
        requestOnly: true,
      };
    },
  };
}

/** Pick the adapter this deployment can actually use. */
export async function getScheduler({ env = process.env, now = Date.now() } = {}) {
  const provider = schedulingProvider(env);
  if (provider === SCHED.GOOGLE) {
    const { createGoogleScheduler } = await import('./scheduling-google.js');
    return createGoogleScheduler({ env, now });
  }
  if (provider === SCHED.CALENDLY) {
    // Deliberately absent. There are no credentials to test it with, and a
    // plausible-looking client nobody has ever run is worse than none: it would
    // read as support in every inventory and fail on the first real booking.
    return createDisconnectedScheduler(
      'Calendly credentials are present but no adapter is built; Google is the configured path.',
    );
  }
  return createDisconnectedScheduler(
    'No calendar is connected, so appointment times cannot be offered. A call request is recorded instead.',
  );
}
