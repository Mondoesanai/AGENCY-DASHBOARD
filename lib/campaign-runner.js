// The one thing the send path was missing: something that runs it.
//
// R24.3. Every piece of the cold-email path existed and was tested — the
// consent gate, the composer, the integrity check, the idempotency ledger, the
// timeout reconciler, the durable queue, the webhook that receives replies and
// bounces, the suppression list, the dashboard panels. What did not exist was a
// PRODUCER: nothing read "who is due" and walked them through it. So
// `lib/jobs.js:enqueue` had no callers, `guardedSend` had no callers, and
// `sendProspectEmail` had no callers, and the reachability audit recorded all
// three as HELD — correct, but it meant the system could not have sent a single
// email even with a paid provider key in place. "Credentials are the only thing
// missing" was not true, and this module is what makes it true.
//
// WHAT THIS DOES NOT DO
// ---------------------
// It does not decide to send. The owner's switch decides, and it is checked
// first so that a refusal names the switch rather than looking like a provider
// fault. With the switch off this returns a refusal and touches nothing — no
// provider call, no job, no state change, no counter.
//
// THE FOUR THINGS IT HAS TO GET RIGHT
// -----------------------------------
//  1. AN OPT-OUT ARRIVING MID-FLIGHT WINS. The gap between "this person is due"
//     and "the provider has it" is where a message to someone who just said
//     STOP comes from. `guardedSend` closes it: claim, prepare, re-check the
//     claim, only then commit.
//
//  2. A TIMEOUT IS NOT A FAILURE. An ambiguous outcome is parked for
//     reconciliation and never retried blindly, because the retry is what
//     sends the duplicate. `sendProspectEmail` owns that; this module must not
//     "helpfully" retry around it.
//
//  3. IT CANNOT RUN AWAY. A bounded number of sends per invocation and per day,
//     from the owner's settings, with the cap reported in the result. An
//     automation that discovers 4,000 due members must not act on all of them.
//
//  4. EVERY OUTCOME IS WRITTEN DOWN. A send that was refused, parked, or failed
//     is as much a result as one that went out, and the dashboard shows all of
//     them. Silence is the one outcome this must never produce.

import { store } from './store.js';

/** Hard ceiling per invocation, whatever the settings say. */
export const MAX_PER_RUN = 25;
/** Hard ceiling per day, whatever the settings say. */
export const MAX_PER_DAY = 200;

export const RUN_OUTCOME = Object.freeze({
  SENT: 'sent',
  REFUSED: 'refused',          // consent, suppression, integrity — a correct no
  PARKED: 'needs-reconciliation', // ambiguous; a human or a reconciler decides
  FAILED: 'failed',            // the provider said no for a reason we can read
  SKIPPED: 'skipped',          // claim lost — usually an opt-out that just landed
});

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);
const SENT_TODAY = (d) => `outreach:sentday:${d}`;

/** How many have gone out today, for the daily cap. Unreadable counts as full. */
export async function sentToday(now = Date.now()) {
  try {
    return Number(await store.get(SENT_TODAY(dayKey(now)))) || 0;
  } catch {
    // An unreadable counter must not read as "nothing sent yet" — that is the
    // reading that sends another two hundred.
    return null;
  }
}

async function bumpSentToday(now, by = 1) {
  const k = SENT_TODAY(dayKey(now));
  const cur = Number(await store.get(k).catch(() => 0)) || 0;
  await store.set(k, String(cur + by), { ex: 60 * 60 * 48 }).catch(() => {});
}

/**
 * Walk the due members of one campaign through the real send path.
 *
 * `deps` exists for tests: a fake provider adapter and a fake clock, injected
 * at the boundary, so the whole journey can be driven without a provider. It
 * is NOT a way to bypass the gates — the switch, the consent check and the
 * suppression list are read from the real store either way.
 */
export async function runCampaignSends(campaignId, {
  now = Date.now(),
  limit = null,
  env = process.env,
  fetchImpl = globalThis.fetch,
  lookup = null,
} = {}) {
  const { getSettings } = await import('./settings.js');
  const settings = await getSettings();

  // 1. THE SWITCH, FIRST. Before the campaign is read, before the provider is
  //    asked anything. An owner who has not switched outreach on must get an
  //    answer that names the switch.
  if (settings.outreach?.active !== true) {
    return {
      ok: false,
      paused: true,
      switchOff: true,
      reason: 'outreach is switched off, so nothing was sent and no provider was contacted',
      results: [],
      attempted: 0,
    };
  }

  const { dueSends, getCampaign, composeCold, composeWarm, markStepSent, MEMBER_STATE, getMember } = await import('./campaigns.js');
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, reason: 'unknown campaign', results: [], attempted: 0 };

  // 2. The sending window is the campaign's, not this function's. `dueSends`
  //    holds anything outside it rather than sending early.
  const due = await dueSends(campaignId, { now, window: { startHour: 8, endHour: 17 } });
  if (!due.ok) return { ok: false, reason: due.reason, results: [], attempted: 0 };
  if (!due.due.length) {
    return {
      ok: true, attempted: 0, results: [],
      note: due.note || 'nothing is due', held: due.held || 0,
    };
  }

  // 3. The caps. Both ceilings apply and the tighter one wins, and an
  //    unreadable daily counter stops the run rather than resetting it.
  const today = await sentToday(now);
  if (today === null) {
    return {
      ok: false,
      reason: 'the daily send counter could not be read, so the cap cannot be enforced and nothing was sent',
      results: [], attempted: 0,
    };
  }
  const configuredPerRun = Number(settings.outreach?.maxPerRun) || MAX_PER_RUN;
  const configuredPerDay = Number(settings.outreach?.maxPerDay) || MAX_PER_DAY;
  const perRun = Math.max(0, Math.min(limit ?? configuredPerRun, MAX_PER_RUN));
  const dayLeft = Math.max(0, Math.min(configuredPerDay, MAX_PER_DAY) - today);
  const budget = Math.min(perRun, dayLeft);

  if (budget <= 0) {
    return {
      ok: true, attempted: 0, results: [], cappedOut: true,
      reason: dayLeft <= 0
        ? `the daily cap of ${Math.min(configuredPerDay, MAX_PER_DAY)} is already used (${today} sent today)`
        : 'the per-run cap is zero',
      due: due.due.length,
    };
  }

  const { guardedSend } = await import('./replies.js');
  const { sendProspectEmail } = await import('./outreach-email.js');
  const { getContact } = await import('./contacts.js');

  // `ownerIdentity()` is the sanctioned accessor and it reads `settings.sender`.
  //
  // Both existing entry points read `settings.business` instead — a key that
  // does not exist in the settings shape at all — so every composed message was
  // refused with "sender identity incomplete" no matter what the owner had
  // configured. That refusal reads like a CAN-SPAM problem and is really a
  // wrong key name, which is why it survived: the message was accurate about
  // the symptom and silent about the cause.
  //
  // `businessName` is sent alongside `business` because the two composers
  // disagree: composeCold/composeWarm read `owner.business`, the invitation
  // composer reads `owner.businessName`.
  const { ownerIdentity } = await import('./settings.js');
  const identity = await ownerIdentity();
  const owner = {
    name: identity.name,
    business: identity.business,
    businessName: identity.business,
    postalAddress: identity.postalAddress,
    unsubscribeLine: identity.unsubscribeLine,
    replyTo: identity.replyTo,
  };
  // Refused here, once, naming what is missing — rather than once per member
  // with a reason that sounds like a legal problem.
  if (!identity.complete) {
    return {
      ok: false,
      // `problems` are objects with a `text`; joining them raw produced
      // "[object Object]", which is a refusal that tells the owner nothing.
      reason: 'the sender identity is incomplete, so no cold message may be composed: '
        + identity.problems.map((p) => p.text || String(p)).join(' '),
      problems: identity.problems,
      missing: identity.missing,
      ownerAction: true,
      results: [],
      attempted: 0,
    };
  }

  const results = [];
  let sent = 0;

  for (const item of due.due.slice(0, budget)) {
    const contact = await getContact(item.contactId).catch(() => null);
    if (!contact) {
      results.push({ contactId: item.contactId, step: item.step, outcome: RUN_OUTCOME.REFUSED, reason: 'the contact record is gone' });
      continue;
    }

    // A member who stopped between dueSends and now is not sent to. Cheap to
    // check, and it is the check that matters most.
    const member = await getMember(campaignId, item.contactId).catch(() => null);
    if (member && member.state === MEMBER_STATE.STOPPED) {
      results.push({ contactId: item.contactId, step: item.step, outcome: RUN_OUTCOME.SKIPPED, reason: 'the member stopped' });
      continue;
    }

    // 4. claim → prepare → RE-CHECK → commit. The re-check is the whole point:
    //    an opt-out that lands while the body is being composed wins.
    const guarded = await guardedSend({
      campaignId,
      contactId: item.contactId,
      step: item.step,
      prepare: async () => {
        // `kind` is the authoritative discriminator, not the step number: the
        // intro is step 0, so branching on `step === 1` composed every first
        // email as a follow-up and every one was refused with "no recorded
        // relationship" — a correct refusal to a question nobody meant to ask.
        const isIntro = item.kind ? item.kind === 'intro' : item.step === 0;
        // The two shapes do not line up, and this is the seam.
        //
        // `composeCold` reads `prospect.web.status` to find its one honest
        // opening line. A CONTACT stores the same object under `websiteCheck`
        // — `enrolProspects` does `websiteCheck: p.web` on the way in. So
        // composing from a campaign member always found no observation and
        // refused with "no honest opening", for every prospect, for ever.
        //
        // Normalised here rather than in either composer, because `web` is the
        // prospect's word and `websiteCheck` is the contact's, and both are
        // right in their own module.
        const forComposer = contact.web ? contact : { ...contact, web: contact.websiteCheck || null };

        if (!isIntro) return composeWarm(forComposer, { owner, settings });

        // The send gate only admits a business with a VERIFIED working site,
        // and the listing-based observation has nothing to say about one — the
        // two policies were mutually exclusive, so nothing was sendable. For
        // that case the opening comes from a real measurement or not at all.
        let observation = null;
        if (forComposer.web?.status === 'verified-present') {
          const { measuredObservation } = await import('./campaigns.js');
          const m = await measuredObservation(forComposer);
          if (!m.ok) return { ok: false, reason: m.reason, needsAudit: m.needsAudit || null };
          observation = m;
        }
        return composeCold(forComposer, { owner, settings, observation });
      },
      commit: async (message) => sendProspectEmail({
        contact, campaignId, message, env, fetchImpl, lookup,
      }),
    });

    if (!guarded.sent) {
      // `stage` says WHERE it stopped, which is the difference between "we
      // refused" and "somebody opted out while we were writing".
      results.push({
        contactId: item.contactId,
        step: item.step,
        outcome: guarded.stage === 'recheck' || guarded.stage === 'claim' ? RUN_OUTCOME.SKIPPED : RUN_OUTCOME.REFUSED,
        stage: guarded.stage,
        reason: guarded.reason,
      });
      continue;
    }

    const r = guarded.result || {};
    if (r.sent) {
      await markStepSent(campaignId, item.contactId, item.step).catch(() => {});
      await bumpSentToday(now);
      sent++;
      results.push({ contactId: item.contactId, step: item.step, outcome: RUN_OUTCOME.SENT, providerId: r.providerId || null });
      continue;
    }

    // Ambiguous: the provider may or may not have it. This is NOT retried here
    // and the step is NOT marked sent — the reconciler settles it before any
    // future attempt. Retrying is what sends the duplicate.
    if (r.code === 'ambiguous' || r.code === 'needs-reconciliation') {
      results.push({
        contactId: item.contactId, step: item.step,
        outcome: RUN_OUTCOME.PARKED, reason: r.reason, needsHuman: !!r.needsHuman,
      });
      continue;
    }

    // Already delivered on a previous attempt, discovered by reconciliation.
    // The step IS marked sent: it went out, we just did not know it.
    if (r.alreadySent) {
      await markStepSent(campaignId, item.contactId, item.step).catch(() => {});
      results.push({ contactId: item.contactId, step: item.step, outcome: RUN_OUTCOME.SENT, reconciled: true, providerId: r.providerId || null });
      continue;
    }

    results.push({
      contactId: item.contactId, step: item.step,
      outcome: r.code === 'disconnected' || r.code === 'not-ready' ? RUN_OUTCOME.REFUSED : RUN_OUTCOME.FAILED,
      code: r.code || null,
      reason: r.reason,
    });
  }

  const tally = results.reduce((a, r) => { a[r.outcome] = (a[r.outcome] || 0) + 1; return a; }, {});

  // Written down so the dashboard shows the last run even when it sent nothing
  // — "it ran and refused everything" and "it never ran" are different facts.
  await store.set(`outreach:lastrun:${campaignId}`, JSON.stringify({
    at: now, attempted: results.length, sent, tally, budget,
  }), { ex: 60 * 60 * 24 * 30 }).catch(() => {});

  return {
    ok: true,
    campaignId,
    attempted: results.length,
    sent,
    tally,
    results,
    budget: { perRun, dayLeft, used: sent, sentTodayBefore: today },
    due: due.due.length,
    note: results.length < due.due.length ? `${due.due.length - results.length} left for the next run (cap)` : undefined,
  };
}

/** The last run of a campaign, for the dashboard. Null means it never ran. */
export async function lastRun(campaignId) {
  try {
    const raw = await store.get(`outreach:lastrun:${campaignId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Enrol due members with the provider through the DURABLE queue.
 *
 * Separate from the send walk above because the two fail differently: enrolment
 * is a bulk call the provider rate-limits (documented at 20 requests a minute),
 * so a 429 must defer the job rather than spend one of its attempts. That
 * behaviour lives in the queue, which is why this is the thing that finally
 * gives `lib/jobs.js:enqueue` a producer.
 */
export async function enqueueProviderEnrolment(campaignId, leads, { now = Date.now() } = {}) {
  const { getSettings } = await import('./settings.js');
  const settings = await getSettings();
  if (settings.outreach?.active !== true) {
    return { ok: false, paused: true, reason: 'outreach is switched off, so nothing was queued' };
  }
  if (!Array.isArray(leads) || !leads.length) return { ok: false, reason: 'no leads to enrol' };

  const { enqueue } = await import('./jobs.js');
  // Batched to the provider's documented bulk limit, and keyed so the same
  // batch queued twice is one job rather than two.
  const BATCH = 500;
  const jobs = [];
  for (let i = 0; i < leads.length; i += BATCH) {
    const slice = leads.slice(i, i + BATCH);
    const job = await enqueue({
      type: 'provider-enrol',
      payload: { campaignId, leads: slice },
      idempotencyKey: `provider-enrol:${campaignId}:${i}:${slice.length}`,
      runAt: now,
    });
    jobs.push(job);
  }
  return { ok: true, queued: jobs.length, leads: leads.length, jobs: jobs.map((j) => j?.id || null) };
}
