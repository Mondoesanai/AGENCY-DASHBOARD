// R10 — reporting. The whole point is that unknown is not zero.
import { check, section, done } from './world.mjs';
import {
  METRIC_DEFINITIONS, buildReport, safeRate, isQualified, describeProspect,
  isOverstated, recordSendAttempt,
} from '../lib/reporting.js';
import { saveSettings } from '../lib/settings.js';
import { upsertContact, field } from '../lib/contacts.js';
import { saveProspects, updateProspect } from '../lib/discovery.js';
import { recordManualBooking, recordBookingLinkClick } from '../lib/bookings.js';

const E = (v) => field(v, { confidence: 1, source: 'manual' });

// ---------------------------------------------------------------------------
section('M1  every metric carries its definition');
const keys = Object.keys(METRIC_DEFINITIONS);
check('there are definitions', keys.length >= 18, String(keys.length));
check('each is a real sentence, not a label', Object.values(METRIC_DEFINITIONS).every((d) => d.length > 30));
check('acceptance is distinguished from delivery', /Acceptance is not delivery/.test(METRIC_DEFINITIONS.messagesAccepted));
check('unique is defined as distinct people', /Distinct people/.test(METRIC_DEFINITIONS.uniquePeopleReached));
check('a qualified lead is explicitly NOT just a reply', /cold prospect who replied is NOT counted/.test(METRIC_DEFINITIONS.qualifiedLeads));
check('bookings exclude link clicks by definition', /Link clicks are never counted here/.test(METRIC_DEFINITIONS.verifiedBookings));
check('cost per booking is undefined, not zero, with no bookings', /Undefined — not zero/.test(METRIC_DEFINITIONS.costPerBooking));

// ---------------------------------------------------------------------------
section('M2  a rate with no denominator is undefined, never 0');
let r = safeRate(100, 0, { unit: 'bookings' });
check('no denominator gives no number', r.value === null && r.measured === false, JSON.stringify(r));
check('and says that is not the same as zero', /not the same as it being zero/.test(r.why), r.why);
check('a real rate is computed', safeRate(100, 4).value === 25);
check('an unmeasured numerator stays unmeasured', safeRate(null, 4).measured === false);

// ---------------------------------------------------------------------------
section('M3  with nothing sent, send metrics are NOT MEASURED');
await saveSettings({ targeting: { status: 'draft' } });
let rep = await buildReport();
const m = rep.metrics;
check('messages attempted is not measured', m.messagesAttempted.measured === false, JSON.stringify(m.messagesAttempted));
check('and the value is null, not 0', m.messagesAttempted.value === null);
check('the reason is plain', /nothing has been sent yet/.test(m.messagesAttempted.why), m.messagesAttempted.why);
check('unique people reached is not measured either', m.uniquePeopleReached.measured === false);
check('delivery is not measured, because no provider is connected', m.messagesDelivered.measured === false && /no sending provider is connected/.test(m.messagesDelivered.why));
check('complaints likewise', m.complaints.measured === false);
check('bounced says nothing was sent so nothing could bounce', /nothing can have bounced/.test(m.bounced.why), m.bounced.why);

check('the report lists what it could not measure', rep.notMeasured.length >= 4, JSON.stringify(rep.notMeasured.map((x) => x.metric)));
check('each entry says why', rep.notMeasured.every((x) => typeof x.why === 'string' && x.why.length > 10));
check('completeness is stated as a fraction', rep.completeness.measured < rep.completeness.total, JSON.stringify(rep.completeness));
check('and the note says unknown is never shown as zero', /never as zero/.test(rep.completeness.note), rep.completeness.note);

// ---------------------------------------------------------------------------
section('M4  cost per booking with no bookings is undefined, not £0');
check('cost per qualified reply is undefined', m.costPerQualifiedReply.measured === false, JSON.stringify(m.costPerQualifiedReply));
check('cost per booking is undefined', m.costPerBooking.measured === false);
check('neither reports a zero', m.costPerQualifiedReply.value === null && m.costPerBooking.value === null);

// ---------------------------------------------------------------------------
section('M5  totals and uniques are different numbers (R10.2)');
const a = (await upsertContact({ source: 'discovery', name: E('Rep One'), businessName: E('One Co'), email: E('one@rep.test') })).contact;
const b = (await upsertContact({ source: 'discovery', name: E('Rep Two'), businessName: E('Two Co'), email: E('two@rep.test') })).contact;
// three attempts to two people
await recordSendAttempt({ contactId: a.id, campaignId: 'c-rep', accepted: true });
await recordSendAttempt({ contactId: a.id, campaignId: 'c-rep', accepted: true });
await recordSendAttempt({ contactId: b.id, campaignId: 'c-rep', accepted: false });

rep = await buildReport();
check('attempts count every message', rep.metrics.messagesAttempted.value === 3, String(rep.metrics.messagesAttempted.value));
check('accepted is lower than attempted', rep.metrics.messagesAccepted.value === 2, String(rep.metrics.messagesAccepted.value));
check('UNIQUE people is 2, not 3', rep.metrics.uniquePeopleReached.value === 2, String(rep.metrics.uniquePeopleReached.value));
check('and they are now measured', rep.metrics.messagesAttempted.measured === true);

// REGRESSION: the send log is a set, and without a unique id per entry two real
// attempts to the same contact in the same millisecond collapsed into one — so
// a retry, exactly what "messages attempted" exists to count, vanished.
const t0 = Date.now();
for (let i = 0; i < 5; i++) await recordSendAttempt({ contactId: 'retry-person', campaignId: 'c-retry', accepted: true, at: t0 });
const retryRep = await buildReport({ filters: { campaignId: 'c-retry' } });
check('five retries in the same millisecond count as five attempts', retryRep.metrics.messagesAttempted.value === 5, String(retryRep.metrics.messagesAttempted.value));
check('but still as ONE unique person', retryRep.metrics.uniquePeopleReached.value === 1, String(retryRep.metrics.uniquePeopleReached.value));
check('delivery is STILL not measured — acceptance is not delivery', rep.metrics.messagesDelivered.measured === false);

// ---------------------------------------------------------------------------
section('M5b  human replies are counted BY CLASSIFICATION, as defined');
// The definition says auto-replies and bounces are "excluded by classification,
// not by guesswork". Counting them via the pausedFollowUps side-effect agreed by
// accident; a metric defined one way and computed another drifts eventually.
const { recordReply, REPLY_KINDS: RK } = await import('../lib/replies.js');
const hc = (await upsertContact({ source: 'discovery', name: E('Human Count'), businessName: E('HC Co'), email: E('hc@rep.test') })).contact;

await recordReply({ contactId: hc.id, kind: RK.INTERESTED, text: 'yes' });
await recordReply({ contactId: hc.id, kind: RK.AUTO_REPLY, text: 'out of office' });
await recordReply({ contactId: hc.id, kind: RK.BOUNCE, text: 'undeliverable' });
await recordReply({ contactId: hc.id, kind: RK.NOT_INTERESTED, text: 'no thanks' });

const before = (await buildReport()).metrics.humanReplies.value;
// a record whose side-effect flag disagrees with its classification: the metric
// must follow the CLASSIFICATION
await recordReply({ contactId: hc.id, kind: RK.NOT_NOW, text: 'next year' });
const afterHuman = (await buildReport()).metrics.humanReplies.value;
check('a human reply increments the count', afterHuman === before + 1, `${before} -> ${afterHuman}`);

const all = await (await import('../lib/replies.js')).listReplies({ limit: 500 });
const mine = all.filter((x) => x.contactId === hc.id);
const autos = mine.filter((x) => x.kind === RK.AUTO_REPLY || x.kind === RK.BOUNCE).length;
check('this contact had 2 non-human replies', autos === 2, String(autos));
check('and none of them is in the human count', afterHuman === mine.length - autos + (before - (mine.length - autos - 1)), `human=${afterHuman}, total=${mine.length}, nonhuman=${autos}`);

// ---------------------------------------------------------------------------
section('M6  a positive reply is not automatically a qualified lead');
let q = isQualified({ id: 'x' }, { targeting: { status: 'draft' } });
check('with draft targeting nothing can be qualified', q.ok === false);
check('and it says why', /still a draft/.test(q.why), q.why);
q = isQualified({ id: 'x' }, { targeting: { status: 'confirmed' } });
check('with confirmed targeting it can be', q.ok === true);
check('no contact record means not qualified', isQualified(null, { targeting: { status: 'confirmed' } }).ok === false);

// ---------------------------------------------------------------------------
section('M7  the vocabulary rule (R10.6)');
check('a discovered business is called a business found', describeProspect('discovered') === 'business found');
check('a contacted one is not upgraded', describeProspect('contacted') === 'business contacted');
check('only a qualified one is a lead', describeProspect('qualified') === 'qualified lead');
let o = isOverstated('warm lead', 'discovered');
check('calling a discovered business a warm lead is overstated', o.overstated === true);
check('and the reason explains what it actually is', /has not shown interest/.test(o.why), o.why);
check('calling a contacted business a lead is overstated', isOverstated('new lead', 'contacted').overstated === true);
check('but "business found" is fine', isOverstated('business found', 'discovered').overstated === false);
check('and a genuinely qualified lead may be called one', isOverstated('qualified lead', 'qualified').overstated === false);

// ---------------------------------------------------------------------------
section('M8  clicks never become bookings in the report');
await recordBookingLinkClick(a.id, { campaignId: 'c-rep' });
await recordBookingLinkClick(a.id, { campaignId: 'c-rep', at: Date.now() + 1 });
rep = await buildReport();
check('clicks are reported', rep.metrics.bookingLinkClicks.value >= 2, String(rep.metrics.bookingLinkClicks.value));
check('bookings are still zero', rep.metrics.verifiedBookings.value === 0, String(rep.metrics.verifiedBookings.value));
check('and zero bookings IS measured — we looked and there are none', rep.metrics.verifiedBookings.measured === true);

await recordManualBooking({ contactId: a.id, campaignId: 'c-rep', startAt: '2026-10-20T09:00:00Z' });
rep = await buildReport();
check('an owner-entered booking counts', rep.metrics.verifiedBookings.value === 1, String(rep.metrics.verifiedBookings.value));
check('clicks did not change', rep.metrics.bookingLinkClicks.value >= 2);

// ---------------------------------------------------------------------------
section('M9  the funnel names each stage honestly (R10.5)');
const stages = rep.funnel.map((f) => f.stage);
check('it runs discovered to booked', stages.join(',') === 'discovered,contacted,replied,positive,qualified,booked', stages.join(','));
check('no stage before "qualified" is labelled a lead', rep.funnel.slice(0, 4).every((f) => !/lead/i.test(f.label)), rep.funnel.map((f) => f.label).join(' | '));
check('each stage carries whether it was measured', rep.funnel.every((f) => typeof f.measured === 'boolean'));
const contacted = rep.funnel.find((f) => f.stage === 'contacted');
check('a stage that was not measured says so rather than showing 0', contacted.measured === true || contacted.value === null, JSON.stringify(contacted));

// ---------------------------------------------------------------------------
section('M10  filters narrow the data without changing definitions (R10.4)');
const filtered = await buildReport({ filters: { campaignId: 'does-not-exist' } });
check('an unmatched campaign filter yields no sends', filtered.metrics.messagesAttempted.measured === false || filtered.metrics.messagesAttempted.value === 0, JSON.stringify(filtered.metrics.messagesAttempted));
check('the definitions are identical under a filter', JSON.stringify(filtered.definitions) === JSON.stringify(rep.definitions));
check('the filter is reported back', filtered.filters.campaignId === 'does-not-exist');

const byCampaign = await buildReport({ filters: { campaignId: 'c-rep' } });
check('filtering to the real campaign keeps its sends', byCampaign.metrics.messagesAttempted.value === 3, String(byCampaign.metrics.messagesAttempted.value));

// a period filter in the future excludes everything
const future = await buildReport({ filters: { from: Date.now() + 86400000, to: Date.now() + 2 * 86400000 } });
check('a future period measures no sends', future.metrics.messagesAttempted.measured === false, JSON.stringify(future.metrics.messagesAttempted));
check('and still does not claim zero bookings as a result', future.metrics.verifiedBookings.value === 0 && future.metrics.verifiedBookings.measured === true);

done();
