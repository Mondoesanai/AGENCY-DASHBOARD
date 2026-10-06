// The Google Calendar scheduling adapter.
//
// R19.1. Satisfies the contract in `lib/scheduling.js`: `availability()` and
// `book()`. Google is the production path because it is the one with
// credentials that already exist — see that file for why not Calendly.
//
// THE TWO THINGS THIS HAS TO GET RIGHT:
//
//  1. A SLOT IS ONLY OFFERED IF IT IS REALLY FREE. Candidate times come from
//     the owner's rules; anything overlapping a real busy period, plus its
//     buffer, is removed. If free/busy cannot be read, NOTHING is offered —
//     "we could not ask" must never render as "the whole week is open".
//
//  2. TWO PEOPLE CANNOT TAKE THE SAME SLOT. The gap between reading
//     availability and creating the event is where a double booking lives, so
//     the slot is claimed atomically BEFORE the provider is called, and the
//     claim is released if the provider then refuses. `store.claimOnce` is an
//     atomic INCR, so exactly one racer wins.

import { store } from './store.js';
import { candidateSlots, removeBusy, getRules, SCHED, SLOT_KIND, SLOT_KIND_LABEL } from './scheduling.js';

/** One claim key per slot start — the lock two racers contend for. */
const slotKey = (startAt) => `sched:slot:${Math.floor(Number(startAt) / 1000)}`;

export function createGoogleScheduler({ env = process.env, now = Date.now() } = {}) {
  return {
    name: SCHED.GOOGLE,
    connected: true,

    /**
     * Real free times, newest rules applied.
     *
     * `visitorTz` only affects how the caller renders; the slots themselves are
     * absolute instants, so a visitor in another zone sees the same moment
     * described in their own words rather than a different moment.
     */
    async availability({ from = now, days = null, visitorTz = null } = {}) {
      const rules = await getRules();
      const horizon = days || rules.horizonDays;
      const to = from + horizon * 86400e3;

      const { calendarBusy } = await import('./google.js');
      const busyResult = await calendarBusy({ from, to });

      if (!busyResult.ok || !Array.isArray(busyResult.busy)) {
        // Fails CLOSED. Offering times we could not verify is the one failure
        // this adapter exists to prevent.
        return {
          ok: false,
          connected: true,
          reason: `the calendar could not be read (${busyResult.error || 'unknown'}), so no times can be offered`,
          slots: [],
        };
      }

      const all = candidateSlots(rules, { now: from });
      const free = removeBusy(all, busyResult.busy, rules);

      // Slots already claimed by an in-flight booking are gone too, even though
      // the provider has not been told yet.
      const open = [];
      for (const s of free) {
        const claimed = await store.get(slotKey(s.startAt)).catch(() => null);
        if (!claimed) open.push(s);
      }

      return {
        ok: true,
        connected: true,
        slots: open,
        timezone: rules.timezone,
        visitorTz: visitorTz || null,
        rules: {
          minutes: rules.slotMinutes,
          previewLeadHours: rules.previewLeadHours,
          maxPerDay: rules.maxPerDay,
        },
      };
    },

    /**
     * Claim the slot, then create the appointment.
     *
     * Order matters and is the whole design. Claim first: if the claim is lost
     * the other person already has it and nothing was sent to Google. Create
     * second: if Google refuses, the claim is released so the slot returns to
     * the pool. If Google's answer never arrives the claim is KEPT and the
     * outcome is reported as uncertain — a retry that re-books is worse than a
     * slot briefly held.
     */
    async book({ startAt, minutes, name, email, businessName, website, notes, timezone, sourceRef }) {
      const rules = await getRules();
      const dur = Number(minutes) || rules.slotMinutes;

      // 1. Is it still really free? Availability is a snapshot; this is the
      //    re-check at the moment of booking.
      const { calendarBusy } = await import('./google.js');
      const recheck = await calendarBusy({ from: startAt - 60e3, to: startAt + dur * 60e3 + 60e3 });
      if (!recheck.ok) {
        return { ok: false, reason: 'the calendar could not be re-checked, so nothing was booked', retryable: true };
      }
      const stillFree = removeBusy(
        [{ startAt, endAt: startAt + dur * 60e3 }], recheck.busy, rules,
      ).length === 1;
      if (!stillFree) {
        return { ok: false, taken: true, reason: 'that time was taken while you were filling the form' };
      }

      // 2. Claim it atomically. Exactly one of two racers gets through.
      const claim = await store.claimOnce(slotKey(startAt), { ttlSec: 15 * 60, now }).catch(() => null);
      if (!claim) {
        return { ok: false, reason: 'the booking lock could not be read, so nothing was booked', retryable: true };
      }
      if (!claim.won) {
        return { ok: false, taken: true, reason: 'somebody else booked that time a moment ago' };
      }

      // 3. Create it with the invitee on it.
      const { createAppointment } = await import('./google.js');
      // The SAME vocabulary the slot list used. The event title is a label of
      // that kind, not a second spelling of it.
      const kind = startAt - now >= rules.previewLeadHours * 3600e3 ? SLOT_KIND.WALKTHROUGH : SLOT_KIND.INTRODUCTORY;
      try {
        const ev = await createAppointment({
          title: `${businessName || name} — ${SLOT_KIND_LABEL[kind].toLowerCase()} (Inspiring Websites)`,
          description: [
            `Requested a complimentary website preview.`,
            businessName ? `Business: ${businessName}` : '',
            website ? `Website: ${website}` : '',
            notes ? `Notes: ${notes}` : '',
            sourceRef ? `Source: ${sourceRef}` : '',
          ].filter(Boolean).join('\n'),
          startAt: new Date(startAt),
          durationMinutes: dur,
          attendeeEmail: email,
          attendeeName: name,
          timezone: timezone || rules.timezone,
        });
        return {
          ok: true,
          providerId: ev.id,
          provider: SCHED.GOOGLE,
          meetingUrl: ev.meetingUrl,
          htmlLink: ev.htmlLink,
          startAt,
          minutes: dur,
          kind,
        };
      } catch (e) {
        const msg = String(e?.message || e);
        // A 4xx proves the provider rejected it, so the slot is genuinely free
        // again and the claim must go back. Anything else may have succeeded:
        // keep the claim, report uncertain, and let a person reconcile.
        const status = Number(e?.status ?? e?.statusCode ?? NaN);
        const certainlyNotCreated = Number.isFinite(status) && status >= 400 && status < 500 && status !== 408;
        if (certainlyNotCreated) {
          await store.del(slotKey(startAt)).catch(() => {});
          return { ok: false, reason: `the calendar refused it: ${msg.slice(0, 120)}` };
        }
        return {
          ok: false,
          uncertain: true,
          reason: 'the calendar did not answer, so it is not known whether the appointment was created',
          // Said explicitly because the caller must NOT retry on this.
          doNotRetry: true,
          startAt,
        };
      }
    },

    /** Hand a held slot back — used when a booking is abandoned before creation. */
    async releaseSlot(startAt) {
      await store.del(slotKey(startAt)).catch(() => {});
      return { ok: true };
    },
  };
}
