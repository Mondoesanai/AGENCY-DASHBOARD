// One admin function that routes to the smaller admin handlers, so we stay
// under Vercel Hobby's 12-function-per-deployment limit.
//   /api/admin?do=coach     (POST)  -> Compass chat
//   /api/admin?do=receipts          -> ledger / receipts / tax (?one=, ?format=csv)
//   /api/admin?do=repos             -> GitHub repo list + match (?match=<url>)
import '../lib/boot.js'; // patches console to redact secrets — must be first
import { guardSharedStore } from '../lib/environment.js';
import { coachHandler } from '../lib/coach.js';
import { authed, authError } from '../lib/auth.js';
import { receiptsHandler } from '../lib/receipts.js';
import { reposHandler } from '../lib/repos.js';
import { runRepoAudit, lastRepoAudit } from '../lib/repo-audit.js';
import { getSettings, saveSettings, pricingBlocker, ownerIdentity, saveSender } from '../lib/settings.js';
import { listContacts, upsertContact, optOut } from '../lib/contacts.js';
import { scanCards, saveCards, previewCsv, importCsv } from '../lib/card-intake.js';
import { runDiscovery, listProspects, getProspect, ATTRIBUTION as DISCOVERY_ATTRIBUTION } from '../lib/discovery.js';
import { listCampaigns, createCampaign, composeCold, enrolProspects, setCampaignStatus, dueSends } from '../lib/campaigns.js';
import { sendReadiness } from '../lib/outreach-email.js';
import { listOpportunities, resolveOpportunity, runRecheckSweep } from '../lib/recheck.js';
import { recordReply, listReplies, markHandled, REPLY_KINDS } from '../lib/replies.js';
import { getKnowledge, saveKnowledge, draftAnswer, containsUnapprovedClaim } from '../lib/knowledge.js';
import { getReplyMode, setReplyMode, sendDraft, takeOver, conversationFor } from '../lib/replies.js';
import { listBookings, bookingStats, recordManualBooking, recordOutcome, recordBookingLinkClick } from '../lib/bookings.js';
import { buildReport, METRIC_DEFINITIONS } from '../lib/reporting.js';
import { erasePerson, exportPerson, runRetentionSweep, RETENTION } from '../lib/retention.js';
import { listSites } from '../lib/registry.js';
import { runAgentCycle, agentStatus, refreshRanksIfStale } from '../lib/agent.js';
import { upsellState, draftUpsell, sendUpsell } from '../lib/upsell.js';
import { todosState, refreshTodos } from '../lib/todos.js';
import { backfillRevisionLabels, backfillGmailLabels, revisionsStatus, checkRevisionInbox, recheckTicket, submitManualRevision, markTicketDone, cancelTicket, assignTicketToSite, retryTicket } from '../lib/revisions.js';
import { systemHealth } from '../lib/health.js';
import { autoTagConversions } from '../lib/conversions-setup.js';
import { sendClientEmail } from '../lib/winsrecap.js';
import { markAiMonth } from '../lib/aicost.js';
import { store } from '../lib/store.js';
import { runAutoTick } from '../lib/tick.js';
import { handleInbound } from '../lib/sms-actions.js';


async function siteBySlug(slug) {
  return (await listSites()).find((s) => s.slug === slug) || null;
}


export default async function handler(req, res) {
  // R18.2 — refuse to run against the live database from a non-production
  // deployment. Preview shares production's KV (see lib/environment.js).
  if (guardSharedStore(req, res)) return;
  // ticket status is client-request/scheduling info, not financial — same
  // trust level as the public /api/sites feed, so it's never password-gated.
  // Same for system-health — it's config/uptime flags (same trust level
  // /api/sites already exposes via emailEnabled/aiEnabled/backend), not
  // client revenue, and it needs to load without a click for the "tell me
  // proactively when something's wrong" goal to actually work.
  if (req.query.do === 'revisions-status') {
    return res.status(200).json({ ok: true, status: await revisionsStatus() });
  }
  // Does this deployment require a password at all?
  //
  // Public on purpose and safe to be: it reveals a posture, never a secret,
  // and the page needs it BEFORE it can authenticate. Without it the page has
  // to guess, and its guess was "always locked" — which is why a local preview
  // demanded a password that the server was not actually checking.
  //
  // 'enforced' = a secret is set and checked. 'locked' = deployed with no
  // secret, so everything is refused. 'open' = local development only, which
  // `authMode()` can only return when VERCEL/VERCEL_ENV are absent.
  if (req.query.do === 'auth-mode') {
    const { authMode, isDeployed } = await import('../lib/auth.js');
    const mode = authMode();
    return res.status(200).json({
      ok: true,
      mode,
      deployed: isDeployed(),
      requiresPassword: mode !== 'open',
    });
  }
  if (req.query.do === 'system-health') {
    const h = await systemHealth();
    try {
      const t = await store.get('auto:trace');
      h.autoTrace = t ? (typeof t === 'string' ? JSON.parse(t) : t) : null;
    } catch { /* optional */ }
    return res.status(200).json(h);
  }
  // R2.6 — automation status is last-ran timestamps and schedule names. Same
  // trust level as system-health above (no client data, no money), and it has
  // to load without a password or the Overview tile would show "unknown" to
  // anyone who has not unlocked. PAUSING, which changes behaviour, is gated.
  if (req.query.do === 'automation-status') {
    const { automationStatus } = await import('../lib/heartbeat.js');
    // R18.5 — the blockers are fetched HERE and passed in, because
    // `recovery.js:diagnose` already calls `automationStatus`. Having the
    // status fetch its own blockers made the two modules call each other until
    // the process ran out of heap. The caller holds both; neither reaches for
    // the other.
    let blockers = [];
    try {
      const { diagnose } = await import('../lib/recovery.js');
      const d = await diagnose({});
      blockers = (d?.findings || [])
        .filter((f) => f && (f.action || f.severity === 'needs-configuration'))
        .map((f) => ({
          worker: f.worker || null,
          code: f.id || null,
          text: f.what || '',
          ownerAction: f.action || null,
        }));
    } catch { /* attempt-vs-success reasoning stands without them */ }
    const automation = await automationStatus(Date.now(), { blockers });
    // R16.6/R16.7 — raised alerts and the sweep's own history. Without these the
    // panel can say every worker looks fine while the sweep that would have
    // noticed otherwise has not run for days, and an alert raised last week has
    // no way to be put down.
    try {
      const { sweepHistory, sweepHealth, listEscalations } = await import('../lib/recovery.js');
      automation.sweeps = await sweepHistory({ limit: 10 }).catch(() => null);
      automation.sweepHealth = await sweepHealth({}).catch(() => null);
      if (typeof listEscalations === 'function') {
        automation.escalations = await listEscalations().catch(() => []);
      }
    } catch { /* the worker rows above stand on their own */ }
    return res.status(200).json({ ok: true, automation });
  }
  // GitHub throttles scheduled workflows hard (a "every 10 min" job actually
  // ran every 4-6 hours), so the automation can't depend on one scheduler.
  // This lets anything that's alive — the dashboard open in a browser, an
  // external uptime pinger — nudge it. No secret needed: it can only run the
  // same per-site-paced, budget-capped tick, and a KV lock caps it at one run
  // per 8 minutes no matter who calls or how often.
  if (req.query.do === 'auto-poke') {
    // R17.5 — PRODUCTION ONLY, and this is not a precaution.
    //
    // `vercel env ls` shows KV_URL, REDIS_URL and the three KV_REST_API_*
    // variables scoped to **Production AND Preview**, while CRON_SECRET is
    // Production-only. So a preview deployment is correctly `locked` for the
    // admin surface — and this endpoint sits ABOVE that gate, deliberately, so
    // that a browser or an uptime pinger can nudge the tick without a secret.
    //
    // Those two facts together are worse than either: every preview deployment
    // would expose an unauthenticated endpoint that runs the real tick against
    // the REAL production database. It would write auto:pokeAt, auto:trace and
    // the heartbeat into production, could trip the deliverability check and
    // PAUSE production automation, and — because DATAFORSEO_LOGIN/PASSWORD are
    // also Preview-scoped — could spend real rank-tracking credits.
    //
    // The tick belongs to production. Anywhere else it is refused.
    // Classified by lib/environment.js rather than by a second hand-rolled
    // check — two answers to "is this production" drift apart eventually, and
    // this one decides whether real money is spent.
    const { deploymentEnv, MAY_TOUCH_LIVE } = await import('../lib/environment.js');
    const where = deploymentEnv();
    if (!MAY_TOUCH_LIVE.includes(where)) {
      return res.status(403).json({
        ok: false,
        error: `the tick only runs in production (this is "${where}")`,
        why: 'Preview shares production\'s database, so a tick from here would write to live data.',
      });
    }
    const last = Number(await store.get('auto:pokeAt').catch(() => 0)) || 0;
    if (Date.now() - last < 8 * 60000) return res.status(200).json({ ok: true, skipped: 'ran recently' });
    await store.set('auto:pokeAt', String(Date.now()), { ex: 3600 }).catch(() => {});
    return res.status(200).json(await runAutoTick());
  }
  if (!authed(req)) return res.status(401).json({ ok: false, error: authError() });
  switch (req.query.do) {
    case 'coach':
      return coachHandler(req, res);
    case 'receipts':
      return receiptsHandler(req, res);
    case 'repos':
      return reposHandler(req, res);
    // ---- Acquisition (R3 contacts, R4 discovery, R6 sending readiness) ----
    case 'settings-get':
      return res.status(200).json({ ok: true, settings: await getSettings(), pricingBlocker: pricingBlocker(await getSettings()) });
    // R2.6 — the pause control. Gated: it changes what the machine does.
    case 'automation-pause': {
      const { setPaused, automationStatus } = await import('../lib/heartbeat.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      await setPaused({ paused: body.paused === true, by: 'owner', reason: body.reason || '' });
      return res.status(200).json({ ok: true, automation: await automationStatus() });
    }
    // R9.1 / R9.2 — experiments, and the two outcomes only the owner can
    // assert. Gated, because an unauthenticated "we made a sale" would be the
    // easiest number in the system to poison.
    case 'experiments-list': {
      const { listExperiments, tally } = await import('../lib/experiments.js');
      const { primaryBreakdown } = await import('../lib/outcomes.js');
      const { secondaryBreakdown, harmWarnings } = await import('../lib/secondary.js');
      const { rankingStatement, rankVariants } = await import('../lib/ranking.js');
      const { sampleSizeStatement } = await import('../lib/significance.js');
      const exps = await listExperiments();
      const withCounts = [];
      for (const e of exps) {
        const t = await tally(e.id);
        // one more look at this experiment
        const looks = Number(await store.incr(`experiment:looks:${e.id}`, 1).catch(() => 0)) || 0;
        const primary = primaryBreakdown(t);
        const secondary = secondaryBreakdown(t);
        // R9.4 — every report carries what may and may not order variants, and
        // what an open actually measures. Built from the real counts so the
        // statement cannot drift from the numbers beside it.
        const opens = Number(await store.get('delivery:count:opened').catch(() => 0)) || 0;
        const human = (secondary.arms || []).reduce((n, a) => n + (a.counts['click-human'] || 0), 0);
        const filtered = (secondary.arms || []).reduce((n, a) => n + (a.counts['click-filtered'] || 0), 0);
        withCounts.push({
          experiment: e,
          primary,
          secondary,
          harm: harmWarnings(secondary),
          ranking: rankingStatement({ opens, humanClicks: human, filteredClicks: filtered }),
          // the ordering the dashboard may show, by the one metric that counts
          orderedBy: rankVariants(primary, 'qualified-positive-reply'),
          // R9.5 — every report answers "can I believe this yet?" before
          // anyone reads the counts. Looks are recorded because checking
          // repeatedly and stopping at the first apparent difference is its
          // own way of manufacturing a result.
          certainty: sampleSizeStatement({
            arms: (primary.arms || []).map((a) => ({
              variantId: a.variantId,
              assigned: a.assigned,
              successes: a.rungs?.['qualified-positive-reply'] || 0,
            })),
            looks,
          }),
        });
      }
      return res.status(200).json({ ok: true, experiments: withCounts });
    }
    // R9.4 — ordering by an arbitrary metric goes through the gate, so a caller
    // asking for "opens" is refused with the reason rather than quietly served
    // something else.
    case 'experiment-rank': {
      const { listExperiments, tally } = await import('../lib/experiments.js');
      const { primaryBreakdown } = await import('../lib/outcomes.js');
      const { rankVariants } = await import('../lib/ranking.js');
      const t = await tally(req.query.id);
      if (!t.ok) return res.status(404).json(t);
      const out = rankVariants(primaryBreakdown(t), String(req.query.metric || ''));
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'experiment-create': {
      const { createExperiment } = await import('../lib/experiments.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return res.status(200).json(await createExperiment(body));
    }
    // R9.7 — the ledger, the bounds, the undo, and the one reassignment path.
    case 'optimisation-log': {
      const { listChanges, getBounds } = await import('../lib/optimisation-log.js');
      return res.status(200).json({ ok: true, changes: await listChanges({ limit: Number(req.query.limit) || 50 }), bounds: await getBounds() });
    }
    case 'optimisation-bounds': {
      const { setBounds } = await import('../lib/optimisation-log.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await setBounds(body.bounds || body, { by: 'owner' });
      // a refusal comes back as { ok: false }; reporting that as the new bounds
      // would tell the caller their change applied when it did not
      if (out && out.ok === false) return res.status(400).json(out);
      return res.status(200).json({ ok: true, bounds: out });
    }
    // Everything the landing screen needs, in one call — three round trips on
    // the screen the owner opens most would be three chances to be slow.
    case 'today': {
      const [{ listBookings }, { dueFollowUps }, { queue }, { queueHealth }] = await Promise.all([
        import('../lib/bookings.js'), import('../lib/relationship.js'),
        import('../lib/previews.js'), import('../lib/jobs.js'),
      ]);
      // "connected" is about the SCHEDULER, not about whether anyone booked.
      // Without the signing key every booking payload is refused, so a booking
      // could not have arrived — which is a different fact from none arriving.
      const connected = !!process.env.CALENDLY_WEBHOOK_KEY;
      let bookings = [];
      let bookingError = null;
      try {
        const all = await listBookings({ limit: 50 });
        bookings = (all || [])
          .filter((b) => b.status === 'scheduled' && Number(b.startAt) > Date.now())
          .sort((a, b) => a.startAt - b.startAt);
      } catch (e) { bookingError = String(e.message || e); }

      let work = {};
      try {
        const [fu, pv, qh] = await Promise.all([dueFollowUps({}), queue({}), queueHealth({})]);
        const owed = (pv.tasks || []).filter((t) => t.state === 'requested' || t.state === 'in-progress').length;
        work = { followUpsDue: fu.dueCount || 0, previewsOwed: owed, queued: qh.queued || 0 };
      } catch (e) { work = { error: String(e.message || e) }; }

      return res.status(200).json({
        ok: true,
        bookings: { connected, bookings, error: bookingError },
        work,
      });
    }

    // ---- Client onboarding progress ---------------------------------------
    case 'onboarding': {
      const { allStatuses, statusFor } = await import('../lib/onboarding.js');
      if (req.query.slug) {
        const { listSites } = await import('../lib/registry.js');
        const site = (await listSites()).find((s) => s.slug === req.query.slug);
        if (!site) return res.status(404).json({ ok: false, error: 'no such client' });
        return res.status(200).json(await statusFor(site, {}));
      }
      return res.status(200).json(await allStatuses({}));
    }
    case 'onboarding-recheck': {
      const { recheck } = await import('../lib/onboarding.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await recheck(body.slug || req.query.slug, {});
      return res.status(out.ok ? 200 : 404).json(out);
    }

    // ---- Operational recovery ---------------------------------------------
    // `diagnose` looks and changes nothing, so the dashboard can call it on
    // every load. `recover` acts, and is reached by the independent scheduler.
    case 'recovery-diagnose': {
      const { diagnose, sweepHistory, sweepHealth } = await import('../lib/recovery.js');
      const out = await diagnose({});
      // R16.7 — the diagnosis says what is wrong NOW. On its own that cannot
      // distinguish "the sweep ran and found nothing" from "the sweep has not
      // run for three days", and those need opposite responses. The history and
      // the staleness check are what tell them apart.
      return res.status(200).json({
        ...out,
        sweeps: await sweepHistory({ limit: 10 }).catch(() => null),
        sweepHealth: await sweepHealth({}).catch(() => null),
      });
    }
    // R16.6 — an escalation that can be raised but never lowered teaches the
    // owner to ignore the whole alert area, which defeats every other alert in
    // it. Acknowledging is an owner action and is recorded as one.
    case 'recovery-ack': {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (!body.id) return res.status(400).json({ ok: false, error: 'which escalation?' });
      const { clearEscalation } = await import('../lib/recovery.js');
      const out = await clearEscalation(body.id);
      return res.status(200).json({
        ...out,
        note: 'Acknowledged. If the underlying problem is still there, the next sweep will raise it again — '
          + 'this clears the alert, not the cause.',
      });
    }
    case 'recovery-run': {
      const { recover } = await import('../lib/recovery.js');
      const { notifyOwner } = await import('../lib/sms.js');
      return res.status(200).json(await recover({ notify: (t) => notifyOwner(t, { subject: 'Automation needs you' }) }));
    }
    case 'repair-tasks': {
      const { listRepairTasks } = await import('../lib/recovery.js');
      return res.status(200).json(await listRepairTasks({}));
    }

    // ---- Relationship workflow (business cards -> follow-up) --------------
    case 'followups-due': {
      const { dueFollowUps } = await import('../lib/relationship.js');
      const { queue } = await import('../lib/previews.js');
      const [due, previews] = await Promise.all([
        dueFollowUps({ limit: Number(req.query.limit) || 50 }),
        queue({ limit: 50 }),
      ]);
      return res.status(200).json({ ok: true, followUps: due, previews });
    }
    // R15.2 — who we may contact, on which channel, and why.
    //
    // Email and SMS are computed separately and each carries its own reason
    // and next action, because the requirement this exists for is that a
    // contact marked emailable must never look SMS-eligible.
    case 'contact-status': {
      const { statusTable } = await import('../lib/optin.js');
      const { listContacts } = await import('../lib/contacts.js');
      const contacts = await listContacts({ limit: Number(req.query.limit) || 200 });
      return res.status(200).json({ ok: true, ...(await statusTable(contacts.contacts || contacts || [])) });
    }

    // R15.1 — the invitation. GET reviews, POST sends.
    //
    // A GET never sends anything: the owner sees exactly who would be written
    // to, who would be skipped and why, and the composed message, before
    // anything leaves. That separation is deliberate — a one-click bulk send
    // with no preview is how an unfinished message reaches 400 businesses.
    case 'invite-review': {
      const { invitationCandidates, sendInvitations } = await import('../lib/optin.js');
      const { listContacts, getContact } = await import('../lib/contacts.js');
      const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
      const contacts = ids.length
        ? (await Promise.all(ids.map((id) => getContact(id)))).filter(Boolean)
        : ((await listContacts({ limit: 200 })).contacts || []);
      const cands = await invitationCandidates(contacts);
      const { getSettings } = await import('../lib/settings.js');
      const s = await getSettings();
      const owner = { name: s.business?.ownerName, businessName: s.business?.name, postalAddress: s.business?.postalAddress };
      // dry run: composes every message and applies every refusal, sends none
      const preview = await sendInvitations(
        contacts.filter((c) => cands.eligible.some((e) => e.id === c.id)),
        { owner, previewUrlFor: async () => null, dryRun: true }
      );
      return res.status(200).json({ ok: true, candidates: cands, preview, sendsNothing: true });
    }
    case 'invite-send': {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'sending is a POST' });
      const { sendInvitations } = await import('../lib/optin.js');
      const { getContact } = await import('../lib/contacts.js');
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length) return res.status(400).json({ ok: false, error: 'no contacts selected' });
      const contacts = (await Promise.all(ids.map((id) => getContact(id)))).filter(Boolean);
      const { getSettings } = await import('../lib/settings.js');
      const s = await getSettings();
      // The owner's master switch governs this exactly as it governs every
      // other outbound path. With outreach off, nothing is sent and it says so.
      if (!s.outreach?.active) {
        return res.status(200).json({ ok: false, error: 'outreach is switched off, so no invitation was sent', paused: true, selected: ids.length });
      }
      const owner = { name: s.business?.ownerName, businessName: s.business?.name, postalAddress: s.business?.postalAddress };
      const out = await sendInvitations(contacts, { owner, previewUrlFor: async () => null, send: null });
      return res.status(200).json(out);
    }
    // R15.3 Q4 — which real meetings are booked, cancelled or missed.
    //
    // `schedulerConnected` travels with the data because "no meetings" and
    // "no scheduler, so a meeting could not arrive" are different facts and
    // the screen has to tell them apart.
    case 'meetings': {
      const { listBookings, bookingStats } = await import('../lib/bookings.js');
      const { weekProgress, recommendedVolume, diagnoseShortfall, DEFAULT_TARGET, DEFAULT_TZ } = await import('../lib/meeting-target.js');
      const [bookings, stats] = await Promise.all([listBookings({ limit: 200 }), bookingStats()]);

      // R15.6 — the week, measured in ATTENDED meetings. The settings hold the
      // owner's target and timezone; both default rather than being guessed.
      const { getSettings } = await import('../lib/settings.js');
      const s = await getSettings().catch(() => ({}));
      const target = Number(s.meetings?.weeklyTarget) || DEFAULT_TARGET;
      const tz = s.business?.timezone || DEFAULT_TZ;
      const progress = weekProgress(bookings, { target, tz });

      // History for the volume recommendation comes from what actually
      // happened, never from an assumed funnel.
      const history = {
        invited: Number(s.stats?.invited || 0),
        positiveReplies: Number(s.stats?.positiveReplies || 0),
        booked: stats.verifiedBookings || 0,
        attended: stats.attended || 0,
      };

      return res.status(200).json({
        ok: true, bookings, stats, progress,
        volume: recommendedVolume(progress, history),
        shortfall: diagnoseShortfall(progress, {}),
        schedulerConnected: !!process.env.CALENDLY_WEBHOOK_KEY,
      });
    }
    case 'meeting-outcome': {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'recording an outcome is a POST' });
      const { recordOutcome } = await import('../lib/bookings.js');
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      if (!body.id || !body.outcome) return res.status(400).json({ ok: false, error: 'a booking id and an outcome are required' });
      return res.status(200).json(await recordOutcome(body.id, body.outcome, { by: 'owner' }));
    }

    // R16.5 — one person's permission, with the evidence for it. The honest
    // alternative to a bulk checkbox: see lib/optin.js:recordPermission.
    case 'record-permission': {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { getContact } = await import('../lib/contacts.js');
      const { recordPermission, contactStatus } = await import('../lib/optin.js');
      const contact = await getContact(body.contactId);
      if (!contact) return res.status(404).json({ ok: false, error: 'no such contact' });
      const out = await recordPermission(contact, {
        channel: body.channel === 'email' ? 'email' : 'sms',
        scope: body.scope || undefined,
        source: body.source, wording: body.wording, evidence: body.evidence,
        by: body.by || 'owner',
      });
      if (!out.ok) return res.status(400).json(out);
      const fresh = await getContact(body.contactId);
      return res.status(200).json({ ...out, status: await contactStatus(fresh) });
    }
    case 'attest-consent': {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'this is a POST' });
      const { attestConsent } = await import('../lib/optin.js');
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      return res.status(200).json(await attestConsent({ contactIds: body.ids || [], by: body.by || 'owner', basis: body.basis || '' }));
    }

    case 'relationship-get': {
      const { getRoute, describe } = await import('../lib/relationship.js');
      const rel = await getRoute(req.query.contactId);
      // `undefined` means unreadable, which is not the same as "none"
      if (rel === undefined) return res.status(503).json({ ok: false, error: 'the relationship record could not be read' });
      return res.status(200).json({ ok: true, relationship: rel, summary: describe(rel) });
    }
    case 'relationship-edit': {
      const { editRoute } = await import('../lib/relationship.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await editRoute(body.contactId, body, { by: 'owner' });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'preview-state': {
      const { setState, attach } = await import('../lib/previews.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = body.attachOnly
        ? await attach(body.taskId, body.url, { by: 'owner' })
        : await setState(body.taskId, body.state, { url: body.url || null, by: 'owner', note: body.note || '' });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'preview-announceable': {
      const { mayAnnounce } = await import('../lib/previews.js');
      return res.status(200).json({ ok: true, result: await mayAnnounce(req.query.contactId) });
    }

    // ---- Unified inbox + SMS ---------------------------------------------
    case 'conversations': {
      const { waiting } = await import('../lib/conversations.js');
      return res.status(200).json(await waiting({ limit: Number(req.query.limit) || 50 }));
    }
    case 'conversation': {
      const { conversationFor } = await import('../lib/conversations.js');
      const { forContact } = await import('../lib/sms-send.js');
      const [conv, messages] = await Promise.all([
        conversationFor(req.query.contactId),
        forContact(req.query.contactId),
      ]);
      return res.status(200).json({ ok: conv.ok, conversation: conv, smsMessages: messages });
    }
    case 'conversation-takeover': {
      const { takeOver } = await import('../lib/conversations.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await takeOver(body.contactId, { by: 'owner' });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'conversation-mode': {
      const { setOwnership } = await import('../lib/conversations.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await setOwnership(body.contactId, body.mode, { by: 'owner' });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'conversation-pause': {
      const { setPaused } = await import('../lib/conversations.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await setPaused(body.contactId, !!body.paused, { reason: body.reason || '', by: 'owner' });
      return res.status(200).json(out);
    }
    case 'sms-compose': {
      // preview only — composes and checks, sends nothing
      const { compose } = await import('../lib/sms-send.js');
      const { getContact } = await import('../lib/contacts.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const contact = await getContact(body.contactId);
      if (!contact) return res.status(404).json({ ok: false, error: 'no such contact' });
      return res.status(200).json({ ok: true, draft: await compose({ contact, body: body.body, purpose: body.purpose || 'one_time_followup' }) });
    }
    case 'sms-schedule': {
      const { schedule } = await import('../lib/sms-send.js');
      const { getContact } = await import('../lib/contacts.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const contact = await getContact(body.contactId);
      if (!contact) return res.status(404).json({ ok: false, error: 'no such contact' });
      const out = await schedule({ contact, body: body.body, purpose: body.purpose || 'one_time_followup', sendAt: Number(body.sendAt) || Date.now(), by: 'owner' });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    // R16.5 — the Send button's actual path.
    //
    // Until this existed, `schedule` queued a message and NOTHING drained the
    // queue: `lib/sms-send.js:send` had no caller anywhere in production, while
    // the interface asked "Send this text? It goes to a real phone if a provider
    // is connected." Both halves of that were wrong — nothing went anywhere, and
    // nothing ever would. The reachability audit missed it because `send` is too
    // common a word to match on, which is why that detector now checks imports.
    //
    // Two gates, both deliberate. The owner's outreach switch is checked here
    // rather than inside `send`, so the refusal names the switch instead of
    // looking like a provider fault; per-contact permission is re-checked inside
    // `send` at the moment of sending, because consent can be withdrawn between
    // composing and sending and the queue must never outrun it.
    case 'sms-send': {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      if (!body.messageId) return res.status(400).json({ ok: false, error: 'which message?' });

      const { getSettings } = await import('../lib/settings.js');
      const settings = await getSettings();
      if (!settings?.outreach?.active) {
        return res.status(200).json({
          ok: false,
          blockedBy: 'outreach-switch',
          error: 'Outreach is switched off, so nothing was sent. This is the owner\'s switch, not a provider problem.',
          ownerAction: true,
        });
      }

      const { send, getMessage } = await import('../lib/sms-send.js');
      const { getContact } = await import('../lib/contacts.js');
      const msg = await getMessage(body.messageId);
      if (!msg) return res.status(404).json({ ok: false, error: 'no such message' });
      const contact = await getContact(msg.contactId);
      if (!contact) return res.status(404).json({ ok: false, error: 'no such contact' });

      const out = await send(body.messageId, { contact });
      return res.status(200).json(out);
    }
    case 'sms-stats': {
      // R13.8 — one report, with relationship work kept apart from cold
      // discovery, and carrying the two figures that nothing computed before:
      // what a qualified conversation cost, and how long people wait for an
      // answer. Both refuse to produce a number from too little data rather
      // than producing a flattering one.
      const { relationshipReport } = await import('../lib/relationship-report.js');
      return res.status(200).json(await relationshipReport({}));
    }

    // R9.9 — the deliverability trip: what the numbers are, and the one way
    // back. Starting again is an owner action and has no automatic equivalent.
    case 'deliverability': {
      const { check, stopState } = await import('../lib/deliverability.js');
      return res.status(200).json({ ok: true, result: await check(), stop: await stopState() });
    }
    case 'deliverability-resume': {
      const { clearStop } = await import('../lib/deliverability.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await clearStop({ by: 'owner', note: body.note || '' });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    // R9.8 — the six things optimisation may never touch, with their reasons,
    // so the interface can state them rather than the owner taking it on faith.
    case 'optimisation-prohibitions': {
      const { describe } = await import('../lib/prohibition.js');
      return res.status(200).json({ ok: true, domains: describe() });
    }
    case 'optimisation-revert': {
      const { revertExperimentChange } = await import('../lib/experiments.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await revertExperimentChange(body.changeId || req.query.changeId);
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'experiment-reassign': {
      const { reassign } = await import('../lib/experiments.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await reassign({ experimentId: body.experimentId, contactId: body.contactId, toVariantId: body.toVariantId, by: 'owner', reason: body.reason || '' });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'experiment-state': {
      const { setExperimentState } = await import('../lib/experiments.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return res.status(200).json(await setExperimentState(body.id, body.state));
    }
    case 'record-sale': {
      const { recordPrimaryOutcome, PRIMARY } = await import('../lib/outcomes.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await recordPrimaryOutcome({
        experimentId: body.experimentId,
        contactId: body.contactId,
        outcome: PRIMARY.RECORDED_SALE,
        source: 'owner',
        amount: body.amount,
        evidence: { note: body.note || '' },
      });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    // R6.11 — the SMS adapter and its A2P registration, built and deliberately
    // left disconnected. Reading is gated like the rest of acquisition.
    case 'sms-readiness': {
      const { smsReadiness, REGISTRATION_REQUIREMENTS, sampleMessages } = await import('../lib/sms-outreach.js');
      return res.status(200).json({
        ok: true,
        sms: await smsReadiness(),
        requirements: REGISTRATION_REQUIREMENTS,
        samples: sampleMessages({ business: 'Inspiring Websites LLC', ownerName: 'Mondo' }),
      });
    }
    case 'sms-registration-save': {
      const { saveRegistration, registrationStatus } = await import('../lib/sms-outreach.js');
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      await saveRegistration(body.fields || {}, { note: body.note || '' });
      return res.status(200).json({ ok: true, registration: await registrationStatus() });
    }
    // R2.9 — what each integration has actually PROVEN, not what is configured.
    case 'integrations': {
      const { allStatuses } = await import('../lib/integrations.js');
      return res.status(200).json({ ok: true, integrations: await allStatuses() });
    }
    // R8.8 — the budget state has been computed since it was built and shown
    // nowhere. Period, spent, reserved, remaining, next reset, both windows.
    case 'budget-status': {
      const { budgetStatus } = await import('../lib/budget.js');
      return res.status(200).json({ ok: true, budget: await budgetStatus() });
    }
    // R16.3 — the owner sets the limit the enforcement path reads. Until this
    // existed, a limit could only be written by reaching into the store, so the
    // cap the panel displayed was one nobody could actually change.
    case 'budget-save': {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
      const { setBudgetSettings, budgetStatus, toCents } = await import('../lib/budget.js');
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});

      // An empty string means "no limit", which is different from zero: zero
      // would refuse everything, and typing a number then clearing it must not
      // silently become a total stop.
      const limit = (v) => {
        if (v === '' || v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return undefined; // invalid, reject below
        return toCents(n);
      };
      const weekly = limit(body.weeklyUsd);
      const monthly = limit(body.monthlyUsd);
      if (weekly === undefined || monthly === undefined) {
        return res.status(400).json({ ok: false, error: 'a limit must be a number of dollars, or blank for no limit' });
      }
      const pct = body.conversationReservePct == null ? undefined : Math.max(0, Math.min(90, Number(body.conversationReservePct) || 0));

      await setBudgetSettings({
        weeklyLimitCents: weekly,
        monthlyLimitCents: monthly,
        ...(pct == null ? {} : { conversationReservePct: pct }),
      });
      return res.status(200).json({ ok: true, budget: await budgetStatus() });
    }
    case 'settings-save': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const saved = await saveSettings(body.patch || body);
      return res.status(200).json({ ok: true, settings: saved, pricingBlocker: pricingBlocker(saved) });
    }
    case 'contacts-list': {
      const out = await listContacts({ limit: Number(req.query.limit) || 200, offset: Number(req.query.offset) || 0, source: req.query.source || null });
      return res.status(200).json({ ok: true, ...out });
    }
    case 'contacts-save': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await upsertContact(body.contact || {});
      return res.status(200).json({ ok: true, contact: out.contact, action: out.action });
    }
    case 'contacts-optout': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      await optOut({ email: body.email, phone: body.phone, reason: body.reason || 'manual' });
      return res.status(200).json({ ok: true });
    }
    case 'cards-scan': {
      // existing OCR backend, now reachable from a screen
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await scanCards(body.images || [], { note: body.note || '' });
      return res.status(200).json({ ok: true, ...out });
    }
    case 'cards-commit': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await saveCards(body.cards || [], body.context || {});
      // R18.4 — `saveCards` returns an ARRAY, and spreading an array into an
      // object produced `{ ok: true, "0": {...}, "1": {...} }`: numeric keys no
      // client can iterate. The page got away with it by reading only `ok`,
      // which also meant the owner was never told a preview task had been
      // created from a card — the one thing on this path worth seeing.
      const saved = Array.isArray(out) ? out : [out];
      return res.status(200).json({
        ok: true,
        saved,
        previewTasks: saved.filter((s) => s?.previewTask).length,
        needsReview: saved.filter((s) => s?.review).length,
      });
    }
    case 'csv-preview': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await previewCsv(body.csv || '', body.mapping || null);
      return res.status(200).json({ ok: true, ...out });
    }
    case 'csv-import': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await importCsv(body.csv || '', body.mapping || null, body.context || {});
      return res.status(200).json({ ok: true, ...out });
    }
    case 'discovery-run': {
      const out = await runDiscovery({
        industries: req.query.industries ? String(req.query.industries).split(',') : null,
        max: Math.min(Number(req.query.max) || 25, 100),
      });
      return res.status(200).json({ ok: out.ok !== false, ...out });
    }
    case 'prospects-list': {
      const rows = await listProspects({ limit: Number(req.query.limit) || 200 });
      return res.status(200).json({ ok: true, prospects: rows, attribution: DISCOVERY_ATTRIBUTION });
    }
    case 'campaigns-list':
      return res.status(200).json({ ok: true, campaigns: await listCampaigns() });
    case 'campaign-create': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await createCampaign({ name: body.name, type: body.type, cadence: body.cadence || {} });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'campaign-preview': {
      // Compose WITHOUT sending, so the owner reads the exact words first.
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const owner = await ownerIdentity();
      const prospect = body.prospectId ? await getProspect(body.prospectId) : body.prospect;
      if (!prospect) return res.status(404).json({ ok: false, error: 'unknown prospect' });
      const msg = await composeCold(prospect, { owner, preview: body.preview || null });
      return res.status(200).json({ ok: true, message: msg, owner: { complete: !!(owner.name && owner.business && owner.postalAddress) } });
    }
    case 'campaign-add-prospects': {
      // Turn qualified prospects into contacts, then into campaign members.
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await enrolProspects(body.campaignId, body.prospectIds || []);
      return res.status(200).json({ ok: true, ...out });
    }
    case 'campaign-status': {
      const c = await setCampaignStatus(req.query.id, req.query.status);
      if (!c) return res.status(400).json({ ok: false, error: 'unknown campaign or status' });
      return res.status(200).json({ ok: true, campaign: c });
    }
    case 'campaign-due': {
      const out = await dueSends(req.query.id, { window: { startHour: 8, endHour: 17 } });
      return res.status(200).json({ ok: true, ...out });
    }
    case 'sender-save': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const saved = await saveSender(body.sender || body);
      return res.status(200).json({ ok: true, sender: saved.sender, identity: await ownerIdentity() });
    }
    case 'opportunities-list':
      return res.status(200).json({ ok: true, opportunities: await listOpportunities({ limit: Number(req.query.limit) || 100 }) });
    case 'opportunity-resolve': {
      const o = await resolveOpportunity(req.query.id, req.query.outcome || 'actioned');
      if (!o) return res.status(404).json({ ok: false, error: 'unknown opportunity' });
      return res.status(200).json({ ok: true, opportunity: o });
    }
    case 'recheck-run': {
      const out = await runRecheckSweep({ max: Math.min(Number(req.query.max) || 10, 50) });
      return res.status(200).json({ ok: true, ...out });
    }
    case 'replies-list':
      return res.status(200).json({ ok: true, replies: await listReplies({ limit: Number(req.query.limit) || 100, onlyUnhandled: req.query.unhandled === '1' }), kinds: REPLY_KINDS });
    case 'reply-record': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await recordReply({ contactId: body.contactId, kind: body.kind, text: body.text, campaignId: body.campaignId || null });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'reply-handled': {
      const out = await markHandled(req.query.id, req.query.by || 'owner');
      if (!out) return res.status(404).json({ ok: false, error: 'unknown reply' });
      return res.status(200).json({ ok: true, reply: out });
    }
    case 'knowledge-get':
      return res.status(200).json({ ok: true, entries: (await getKnowledge()).map((e) => ({ id: e.id, approved: e.approved, answer: typeof e.answer === 'function' ? '(assembled from your settings)' : e.answer, needs: e.needs || null, matchPhrases: e.matchPhrases || null, custom: !!e.custom })) });
    case 'knowledge-save': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const saved = await saveKnowledge(body.entries || []);
      return res.status(200).json({ ok: true, entries: saved });
    }
    case 'reply-draft': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const d = await draftAnswer({ kind: body.kind, text: body.text || '', bookingUrl: body.bookingUrl || null });
      const guard = d.ok ? containsUnapprovedClaim(d.body) : { clean: true, findings: [] };
      return res.status(200).json({ ok: true, draft: d, guard, note: 'This is a draft for you to read. Nothing is sent from here.' });
    }
    case 'reply-mode':
      return res.status(200).json({ ok: true, mode: req.query.set ? await setReplyMode(req.query.set) : await getReplyMode() });
    case 'reply-send': {
      const out = await sendDraft(req.query.id, { approvedBy: req.query.by || 'owner' });
      return res.status(200).json(out);
    }
    case 'reply-takeover': {
      const out = await takeOver(req.query.contactId, req.query.by || 'owner');
      return res.status(200).json({ ok: true, ...out });
    }
    case 'conversation': {
      return res.status(200).json({ ok: true, conversation: await conversationFor(req.query.contactId) });
    }
    case 'bookings-list':
      return res.status(200).json({ ok: true, bookings: await listBookings({ limit: Number(req.query.limit) || 200 }), stats: await bookingStats() });
    case 'booking-manual': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return res.status(200).json(await recordManualBooking({ contactId: body.contactId, campaignId: body.campaignId || null, startAt: body.startAt, by: body.by || 'owner' }));
    }
    case 'booking-outcome': {
      const out = await recordOutcome(req.query.id, req.query.outcome, { by: req.query.by || 'owner' });
      return res.status(out.ok ? 200 : 400).json(out);
    }
    case 'booking-click': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      return res.status(200).json(await recordBookingLinkClick(body.contactId, { campaignId: body.campaignId || null }));
    }
    case 'acquisition-report': {
      const filters = {};
      if (req.query.campaignId) filters.campaignId = req.query.campaignId;
      if (req.query.industry) filters.industry = req.query.industry;
      if (req.query.from) filters.from = Number(req.query.from);
      if (req.query.to) filters.to = Number(req.query.to);
      return res.status(200).json({ ok: true, report: await buildReport({ filters }) });
    }
    case 'metric-definitions':
      return res.status(200).json({ ok: true, definitions: METRIC_DEFINITIONS });
    case 'person-erase': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await erasePerson({ contactId: body.contactId, email: body.email, reason: body.reason || 'requested', by: body.by || 'owner' });
      return res.status(out.ok ? 200 : 404).json(out);
    }
    case 'person-export': {
      const out = await exportPerson(req.query.contactId);
      return res.status(out.ok ? 200 : 404).json(out);
    }
    case 'retention-sweep': {
      const out = await runRetentionSweep({ dryRun: req.query.apply !== '1' });
      return res.status(200).json({ ok: true, windows: RETENTION, ...out });
    }
    case 'outreach-readiness':
      return res.status(200).json({ ok: true, readiness: await sendReadiness({}) });
    // R1.7 — client↔repo mapping audit. `fix=1` applies only the unambiguous
    // fixes (a name GitHub itself just confirmed, a stale cached block);
    // collisions, missing repos and permission faults are reported for the
    // owner to decide, never auto-changed.
    case 'repo-audit': {
      const out = req.query.cached === '1' ? await lastRepoAudit() : await runRepoAudit({ applyFixes: req.query.fix === '1' });
      return res.status(200).json({ ok: true, report: out });
    }
    case 'agent-status': {
      const site = await siteBySlug(req.query.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      return res.status(200).json({ ok: true, status: await agentStatus(site) });
    }
    case 'agent-run': {
      const site = await siteBySlug(req.query.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      // reset=1: forget today's failure count (used after a real bug is fixed, so the site isn't stuck waiting until tomorrow)
      if (req.query.reset === '1') await store.set('agent:fail:' + site.slug + ':' + new Date().toISOString().slice(0, 10), '0', { ex: 60 * 60 * 30 }).catch(() => {});
      const out = await runAgentCycle(site, { manual: true, blogNow: req.query.blog === '1' });
      return res.status(200).json(out);
    }
    case 'todos-refresh': {
      const site = await siteBySlug(req.query.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      const out = await refreshTodos(site);
      return res.status(200).json(out);
    }
    case 'upsell': {
      const site = await siteBySlug(req.query.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      const state = await upsellState(site);
      if (req.query.send === '1') {
        const r = await sendUpsell(site);
        return res.status(200).json({ ok: true, ...r, state });
      }
      return res.status(200).json({ ok: true, state, draft: draftUpsell(site, state) });
    }
    case 'gmail-backfill': {
      if (req.query.revisions === '1') return res.status(200).json(await backfillRevisionLabels());
      // file existing mail into the business folders (header-only, no AI spend)
      const out = await backfillGmailLabels({ days: Number(req.query.days) || 60, max: Number(req.query.max) || 200 });
      return res.status(200).json(out);
    }
    case 'revisions-rescan': {
      // put wrongly-dropped mail back in the queue (default: anything with an attachment or "revision" in the subject, last 14 days) and re-read it
      const q = req.query.q || 'has:attachment OR subject:(revision OR revisions OR update OR change)';
      const out = await checkRevisionInbox({ rescan: { q, days: Number(req.query.days) || 14 } });
      return res.status(200).json(out);
    }
    case 'email-client': {
      const site = await siteBySlug(req.query.slug);
      if (!site) return res.status(404).json({ ok: false, error: 'unknown site' });
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await sendClientEmail(site, { subject: body.subject || req.query.subject, body: body.body || req.query.body });
      return res.status(200).json(out);
    }
    case 'revisions-submit': {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const out = await submitManualRevision({ slug: body.slug || req.query.slug, text: body.text || req.query.text, subject: body.subject || req.query.subject });
      return res.status(200).json(out);
    }
    case 'revisions-recheck': {
      const out = await recheckTicket(req.query.id, { files: String(req.query.files || '').split(',').map((x) => x.trim()).filter(Boolean) });
      return res.status(200).json(out);
    }
    case 'revisions-content': {
      // the full text the agent works from for a ticket (client email + attachment text)
      const txt = await store.get('revisions:attach:' + String(req.query.id || '')).catch(() => null);
      return res.status(200).json({ ok: true, content: txt || null });
    }
    case 'revisions-check': {
      const out = await checkRevisionInbox();
      return res.status(200).json(out);
    }
    case 'revisions-done': {
      const out = await markTicketDone(req.query.id);
      return res.status(200).json(out);
    }
    case 'revisions-cancel': {
      const out = await cancelTicket(req.query.id);
      return res.status(200).json(out);
    }
    case 'revisions-retry': {
      const out = await retryTicket(req.query.id);
      return res.status(200).json(out);
    }
    case 'revisions-assign': {
      const out = await assignTicketToSite(req.query.id, req.query.slug);
      return res.status(200).json(out);
    }
    case 'conversions-setup-all': {
      // Forces conversion auto-tagging right now for every site that hasn't
      // had it yet, instead of waiting on each one's turn in the daily
      // rotation — for retrofitting sites that existed before this feature.
      // With ?slug=<slug>, scans just that one site (from a site's own
      // settings) and always re-scans even if it already ran once, since a
      // site's homepage can change after the first pass.
      const onlySlug = req.query.slug || null;
      const forceIt = onlySlug ? req.query.force !== '0' : req.query.force === '1';
      const sites = onlySlug ? (await listSites()).filter((s) => s.slug === onlySlug) : await listSites();
      if (onlySlug && !sites.length) return res.status(404).json({ ok: false, error: 'unknown site' });
      const t0 = Date.now();
      const results = [];
      for (const site of sites) {
        if (Date.now() - t0 > 45000) {
          results.push({ slug: site.slug, skipped: true, reason: 'out of time this run — re-run to pick up the rest' });
          continue;
        }
        const already = await store.get(`conv:tagged:${site.slug}`).catch(() => null);
        if (already && !forceIt) {
          results.push({ slug: site.slug, skipped: true, reason: 'already tagged' });
          continue;
        }
        const m = new Date().toISOString().slice(0, 7);
        const spend = async (usd) => {
          const cur = Number(await store.get(`agent:spend:${site.slug}:${m}`).catch(() => 0)) || 0;
          await store.set(`agent:spend:${site.slug}:${m}`, String(+(cur + usd).toFixed(5)), { ex: 60 * 60 * 24 * 45 }).catch(() => {});
          const curAll = Number(await store.get(`agent:spend:${m}`).catch(() => 0)) || 0;
          await store.set(`agent:spend:${m}`, String(+(curAll + usd).toFixed(5)), { ex: 60 * 60 * 24 * 45 }).catch(() => {});
          await markAiMonth(m);
        };
        const r = await autoTagConversions(site, { spend }).catch((e) => ({ ok: false, error: String(e.message || e) }));
        await store.set(`conv:tagged:${site.slug}`, String(Date.now()), { ex: 60 * 60 * 24 * 365 }).catch(() => {});
        results.push({ slug: site.slug, ...r });
      }
      return res.status(200).json({ ok: true, results });
    }
    case 'sms-inbound': {
      // Twilio webhook (set the number's "A message comes in" URL to
      // /api/admin?do=sms-inbound&secret=<CRON_SECRET>). Form-encoded body.
      let b = req.body;
      if (typeof b === 'string') b = Object.fromEntries(new URLSearchParams(b));
      const reply = await handleInbound({ from: b?.From, body: b?.Body }).catch(() => '');
      const xml = String(reply || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(`<?xml version="1.0" encoding="UTF-8"?><Response>${xml ? `<Message>${xml}</Message>` : ''}</Response>`);
    }
    case 'auto-tick':
      return res.status(200).json(await runAutoTick());
    case 'ranks-refresh-all': {
      // Manual "don't wait for the cron" trigger — the whole reason this
      // exists is the daily cron's own reliability is currently in
      // question, so ranking freshness can't fully depend on it working.
      // ?force=1 ignores the ~3-day staleness check and rechecks everyone.
      // ?slug=<slug> limits it to one site (always forces, like the
      // per-site button — waiting 3 days to prove the button worked would
      // defeat the point of a manual "check it now" action).
      const onlySlug = req.query.slug || null;
      const force = onlySlug ? true : req.query.force === '1';
      const sites = onlySlug ? (await listSites()).filter((s) => s.slug === onlySlug) : await listSites();
      if (onlySlug && !sites.length) return res.status(404).json({ ok: false, error: 'unknown site' });
      const t0 = Date.now();
      const results = [];
      for (const site of sites) {
        if (Date.now() - t0 > 45000) {
          results.push({ slug: site.slug, skipped: true, reason: 'out of time this run — re-run to pick up the rest' });
          continue;
        }
        const r = await refreshRanksIfStale(site, { force }).catch((e) => ({ ok: false, error: String(e.message || e) }));
        results.push({ slug: site.slug, ...r });
      }
      return res.status(200).json({ ok: true, results });
    }
    default:
      return res.status(400).json({ ok: false, error: 'unknown admin action' });
  }
}
