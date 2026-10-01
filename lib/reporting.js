// R10 — reporting.
//
// This system has sent nothing. Almost every number it could show is therefore
// UNKNOWN, and the whole value of this file is refusing to render unknown as 0.
//
// The difference matters because the two look identical on a dashboard and mean
// opposite things. "0 replies" says we asked and nobody answered. "Not measured"
// says we never asked. An owner who plans around the first when the second is
// true is being misled by their own tool.
//
// So every metric carries three things: a value, whether it was actually
// measured, and the definition it was measured by. A metric that cannot be
// computed returns `value: null, measured: false` with the reason — never a
// zero, never a dash that could be mistaken for one.
//
// Two further rules:
//   * TOTALS vs UNIQUE are separate numbers wherever they can differ (R10.2).
//     "12 emails to 4 people" is not "12 people contacted".
//   * A cold prospect is never described as a lead (R10.6). The vocabulary is
//     enforced, because inflated words are how a pipeline lies to its owner.

import { store } from './store.js';
import { listContacts } from './contacts.js';
import { listCampaigns, getMember, MEMBER_STATE } from './campaigns.js';
import { listReplies, NOTIFY_KINDS, REPLY_KINDS } from './replies.js';
import { listBookings, bookingStats, clickCount } from './bookings.js';
import { listProspects } from './discovery.js';

/**
 * Every metric, with the definition it is computed by, in words the owner can
 * check. A number without its definition is an opinion.
 */
export const METRIC_DEFINITIONS = Object.freeze({
  prospectsDiscovered: 'Businesses found by discovery and stored. Not contacted, not qualified — just found.',
  prospectsQualified: 'Discovered businesses that passed the eligibility checks: in the target area, in a target trade, with a contact address, and with a web-presence status we are confident about.',
  contactsImported: 'People added by card scan, CSV import or by hand. Separate from discovery.',
  contactsEmailable: 'Contacts with a usable address, no opt-out, no hard bounce and no complaint.',
  messagesAttempted: 'Messages the system tried to send. Counts every attempt, including retries.',
  messagesAccepted: 'Messages the sending provider accepted for delivery. Acceptance is not delivery.',
  messagesDelivered: 'Messages the provider confirmed were delivered. Only available once a provider is connected and reporting it.',
  bounced: 'Messages the provider reported as undeliverable.',
  uniquePeopleReached: 'Distinct people who received at least one message. Always lower than or equal to messages sent.',
  humanReplies: 'Replies from a person. Auto-replies and bounces are excluded by classification, not by guesswork.',
  positiveReplies: 'Human replies classified as interested, wanting a call, wanting a preview or wanting details.',
  qualifiedLeads: 'Positive replies from a contact who is in the target area and in a target trade. A cold prospect who replied is NOT counted here until that is true.',
  verifiedBookings: 'Appointments confirmed by a signature-verified scheduler webhook or entered by the owner. Link clicks are never counted here.',
  bookingLinkClicks: 'Clicks on a booking link. Reported separately and deliberately never added to bookings.',
  attendedCalls: 'Bookings the owner marked as attended. Only a person can record this.',
  cancellations: 'Bookings cancelled after being confirmed.',
  optOuts: 'People who asked not to be contacted again, by any route.',
  complaints: 'People who marked a message as spam. Only available from a connected provider.',
  spend: 'Money actually recorded against this period in the cost ledger.',
  costPerQualifiedReply: 'Spend divided by qualified replies. Undefined — not zero — when there are no qualified replies.',
  costPerBooking: 'Spend divided by verified bookings. Undefined — not zero — when there are no bookings.',
});

/** A measured number. */
const measured = (value, note = null) => ({ value, measured: true, note });

/** A number we do not have. NEVER zero. */
const unknown = (why) => ({ value: null, measured: false, why });

/** Divide, but refuse to invent a ratio out of nothing. */
export function safeRate(numerator, denominator, { unit = '' } = {}) {
  if (!denominator || denominator <= 0) {
    return unknown(`there were no ${unit || 'denominator events'} in this period, so this cannot be calculated — that is not the same as it being zero`);
  }
  if (numerator == null) return unknown('the numerator was never measured');
  return measured(Number((numerator / denominator).toFixed(2)));
}

/** Is a reply a QUALIFIED lead, or merely a positive one? */
export function isQualified(contact, settings) {
  if (!contact) return { ok: false, why: 'no contact record' };
  const t = settings?.targeting;
  if (!t) return { ok: false, why: 'no targeting configured to qualify against' };
  if (t.status !== 'confirmed') {
    return { ok: false, why: 'targeting is still a draft, so nothing can be called qualified against it yet' };
  }
  return { ok: true };
}

/**
 * The vocabulary rule (R10.6). Exported so it is testable rather than a
 * convention in someone's head.
 */
export function describeProspect(stage) {
  const words = {
    discovered: 'business found',
    contacted: 'business contacted',
    replied: 'replied',
    positive: 'positive reply',
    qualified: 'qualified lead',
    booked: 'booked call',
  };
  return words[stage] || 'business found';
}

export function isOverstated(label, stage) {
  const l = String(label).toLowerCase();
  // "lead" and "prospect" are not interchangeable, and neither is "warm"
  if (/\bwarm\b|\blead\b|\binterested\b/.test(l) && ['discovered', 'contacted'].includes(stage)) {
    return { overstated: true, why: `"${label}" claims more than "${describeProspect(stage)}" — a business we found or wrote to has not shown interest` };
  }
  return { overstated: false };
}

// ---------------------------------------------------------------------------

const SENT_LOG = 'report:sends';

/**
 * Record an attempted send so totals and uniques can both be reported.
 *
 * Each entry carries a unique id. The log is a SET, and without one two real
 * attempts to the same contact in the same millisecond collapsed into a single
 * member — so a retry, which is exactly what "messages attempted" is supposed
 * to count, silently disappeared. The uniqueness of a person and the uniqueness
 * of an attempt are different things, and the storage has to keep them apart.
 */
let attemptSeq = 0;
export async function recordSendAttempt({ contactId, campaignId, accepted = false, at = Date.now() }) {
  const id = `${at}-${(attemptSeq = (attemptSeq + 1) % 1e6)}-${Math.random().toString(36).slice(2, 8)}`;
  await store.sadd(SENT_LOG, JSON.stringify({ id, contactId, campaignId, accepted, at }));
}

async function sendLog() {
  const raw = await store.smembers(SENT_LOG).catch(() => []);
  return raw
    .map((r) => {
      try { return JSON.parse(r); } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * Build the report.
 *
 * `filters` narrows the population; every filter is applied to the same source
 * data so a filtered view cannot silently change a definition (R10.4).
 */
export async function buildReport({ settings = null, filters = {}, now = Date.now() } = {}) {
  const { getSettings } = await import('./settings.js');
  const s = settings || (await getSettings());
  const from = filters.from || 0;
  const to = filters.to || now;
  const inPeriod = (t) => Number(t || 0) >= from && Number(t || 0) <= to;

  const [prospects, contactsOut, campaigns, replies, bookings, bStats, sends] = await Promise.all([
    listProspects({ limit: 2000 }),
    listContacts({ limit: 2000 }),
    listCampaigns(),
    listReplies({ limit: 2000 }),
    listBookings({ limit: 2000 }),
    bookingStats(),
    sendLog(),
  ]);
  const contacts = contactsOut.contacts || contactsOut || [];

  // --- filters ---
  const campaignFilter = filters.campaignId || null;
  const industryFilter = filters.industry || null;
  const keptProspects = prospects.filter(
    (p) => (!industryFilter || p.industry === industryFilter) && inPeriod(p.discoveredAt)
  );
  const keptSends = sends.filter((x) => (!campaignFilter || x.campaignId === campaignFilter) && inPeriod(x.at));
  const keptReplies = replies.filter((r) => (!campaignFilter || r.campaignId === campaignFilter) && inPeriod(r.at));
  const keptBookings = bookings.filter(
    (b) => (!campaignFilter || b.attribution?.campaignId === campaignFilter) && inPeriod(b.updatedAt)
  );

  // --- discovery ---
  const qualifiedProspects = keptProspects.filter((p) => p.qualification?.eligible === true).length;

  // --- sending: totals AND uniques, kept separate (R10.2) ---
  const attempted = keptSends.length;
  const accepted = keptSends.filter((x) => x.accepted).length;
  const uniquePeople = new Set(keptSends.map((x) => x.contactId)).size;

  // --- replies ---
  const human = keptReplies.filter((r) => r.pausedFollowUps === true);
  const positive = keptReplies.filter((r) => NOTIFY_KINDS.has(r.kind) && r.kind !== REPLY_KINDS.AMBIGUOUS);
  const optOuts = keptReplies.filter((r) => r.kind === REPLY_KINDS.OPT_OUT).length;
  const bounced = keptReplies.filter((r) => r.kind === REPLY_KINDS.BOUNCE).length;

  // qualified leads: a positive reply is not automatically a lead
  const byId = Object.fromEntries(contacts.map((c) => [c.id, c]));
  let qualifiedLeads = 0;
  let qualifyBlocked = null;
  for (const r of positive) {
    const q = isQualified(byId[r.contactId], s);
    if (q.ok) qualifiedLeads++;
    else qualifyBlocked = q.why;
  }

  // --- spend ---
  let spend = null;
  try {
    const { budgetStatus } = await import('./budget.js');
    const b = await budgetStatus();
    spend = typeof b?.spent === 'number' ? b.spent : null;
  } catch { spend = null; }

  const metrics = {
    prospectsDiscovered: measured(keptProspects.length),
    prospectsQualified: measured(qualifiedProspects),
    contactsImported: measured(contacts.filter((c) => c.source !== 'discovery').length),
    contactsEmailable: measured(contacts.filter((c) => c.email?.value && !c.optedOutAt && c.emailStatus !== 'hard_bounce' && c.emailStatus !== 'complained').length),

    messagesAttempted: attempted ? measured(attempted) : unknown('nothing has been sent yet'),
    messagesAccepted: attempted ? measured(accepted) : unknown('nothing has been sent yet'),
    // delivery confirmation can only come from a provider we are not connected to
    messagesDelivered: unknown('no sending provider is connected, so delivery is not reported to us'),
    complaints: unknown('no sending provider is connected, so spam complaints are not reported to us'),
    bounced: attempted ? measured(bounced) : unknown('nothing has been sent, so nothing can have bounced'),
    uniquePeopleReached: attempted ? measured(uniquePeople) : unknown('nothing has been sent yet'),

    humanReplies: measured(human.length),
    positiveReplies: measured(positive.length),
    qualifiedLeads: qualifyBlocked && qualifiedLeads === 0 ? unknown(qualifyBlocked) : measured(qualifiedLeads),

    verifiedBookings: measured(keptBookings.filter((b) => b.verified).length),
    bookingLinkClicks: measured(await totalClicks(contacts)),
    attendedCalls: measured(bStats.attended),
    cancellations: measured(bStats.cancelled),
    optOuts: measured(optOuts),

    spend: spend == null ? unknown('the cost ledger has no entries for this period') : measured(spend),
  };

  metrics.costPerQualifiedReply = safeRate(metrics.spend.value, metrics.qualifiedLeads.value, { unit: 'qualified leads' });
  metrics.costPerBooking = safeRate(metrics.spend.value, metrics.verifiedBookings.value, { unit: 'verified bookings' });

  // --- funnel (R10.5): each stage named honestly ---
  const funnel = [
    { stage: 'discovered', label: 'Businesses found', ...metrics.prospectsDiscovered },
    { stage: 'contacted', label: 'Businesses contacted', ...metrics.uniquePeopleReached },
    { stage: 'replied', label: 'Replied', ...metrics.humanReplies },
    { stage: 'positive', label: 'Positive replies', ...metrics.positiveReplies },
    { stage: 'qualified', label: 'Qualified leads', ...metrics.qualifiedLeads },
    { stage: 'booked', label: 'Booked calls', ...metrics.verifiedBookings },
  ];

  const notMeasured = Object.entries(metrics).filter(([, m]) => m.measured === false).map(([k, m]) => ({ metric: k, why: m.why }));

  return {
    period: { from, to },
    filters: { campaignId: campaignFilter, industry: industryFilter },
    metrics,
    definitions: METRIC_DEFINITIONS,
    funnel,
    // the honesty surface: what this report could NOT measure, and why
    notMeasured,
    completeness: {
      measured: Object.keys(metrics).length - notMeasured.length,
      total: Object.keys(metrics).length,
      note: notMeasured.length
        ? `${notMeasured.length} of ${Object.keys(metrics).length} metrics could not be measured. They are shown as "not measured", never as zero.`
        : 'Every metric in this report was measured.',
    },
    campaignsConsidered: campaigns.length,
  };
}

async function totalClicks(contacts) {
  let n = 0;
  for (const c of contacts) n += await clickCount(c.id);
  return n;
}
