// R12.3 — an opt-out that arrives while a send is already queued.
//
// This is the scenario in the whole list with the clearest victim. Someone
// clicks unsubscribe. At that moment a message to them is already scheduled,
// already selected as due, possibly already picked up by a worker. If the only
// consent check happened when the message was queued, that message goes out
// AFTER they said stop — which is the exact harm every other rule in this
// system is written to avoid, and it is invisible to any test that checks the
// gate once.
//
// So the property under test is not "opting out works". It is: **a decision
// made between queueing and sending still lands.** Which requires two gates,
// and requires the second one to be load-bearing — so the test first proves
// the person is STILL IN the already-computed due list after opting out,
// because if they were not, the second gate would be untested and nobody would
// notice until the day the first gate changed.
process.env.CRON_SECRET = 'sendrace-test-secret';
process.env.UNSUB_SECRET = 'sendrace-unsub-secret';

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { startLocalApi, providerFixture } from './harness/local-api.mjs';

const configuredRemote =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (configuredRemote) {
  console.log('\nREFUSED: this test writes contacts and suppressions; it runs against the in-memory store only.\n');
  console.log('0 passed, 1 failed');
  console.log('FAILED:');
  console.log(' - send-race test refused to run against a configured remote store');
  process.exit(1);
}

const { canContact } = await import('../lib/contacts.js');
const { createCampaign, enrolProspects, setCampaignStatus, dueSends, stopContact, getMember, CAMPAIGN_TYPES, MEMBER_STATE } =
  await import('../lib/campaigns.js');
const { maySend, sendProspectEmail } = await import('../lib/outreach-email.js');
const { makeToken } = await import('../lib/unsubscribe.js');

const ADDRESS = 'sendrace-victim@example.invalid';
const api = await startLocalApi();

// ---------------------------------------------------------------------------
section('S1  a real contact, really queued, through the real enrolment path');
// Enrolment goes prospect → contact → member. Building the member record by
// hand would skip the code that decides who may be enrolled at all, so the
// prospect is written and the real `enrolProspects` does the rest.
const PROSPECT_ID = 'sendrace-prospect';
await store.set(`prospect:${PROSPECT_ID}`, JSON.stringify({
  id: PROSPECT_ID,
  name: 'Race Roofing',
  contactName: 'Pat Race',
  email: ADDRESS,
  phone: '',
  website: '',
  sourceId: 'r12.3-send-race-test',
  qualification: { segment: 'no-site-found' },
}));

const made = await createCampaign({ name: 'Send race', type: CAMPAIGN_TYPES.COLD_NO_SITE });
check('a campaign exists', made && made.ok === true, JSON.stringify(made).slice(0, 160));
const campaignId = made.campaign.id;

const enrolled = await enrolProspects(campaignId, [PROSPECT_ID]);
check('the prospect is enrolled', enrolled && enrolled.enrolled === 1, JSON.stringify(enrolled).slice(0, 220));
const contactId = enrolled.enrolledDetail[0] && enrolled.enrolledDetail[0].contactId;
check('and it produced a contact', !!contactId, String(contactId));

const { getContact } = await import('../lib/contacts.js');
const contact = await getContact(contactId);
check('the contact is readable', !!contact, JSON.stringify(contact).slice(0, 120));
check('and may be contacted to begin with', (await canContact(contact, { channel: 'email', purpose: 'promotional' })).ok === true,
  JSON.stringify(await canContact(contact, { channel: 'email', purpose: 'promotional' })));

await setCampaignStatus(campaignId, 'running');

// make the first step due now
const member = await getMember(campaignId, contactId);
check('the member has a plan', !!member && Array.isArray(member.plan) && member.plan.length > 0, JSON.stringify(member).slice(0, 220));
member.plan = member.plan.map((p, i) => (i === 0 ? { ...p, at: Date.now() - 60000 } : p));
await store.set(`campaign:member:${campaignId}:${contactId}`, JSON.stringify(member));

// a Tuesday mid-morning, so the sending window is not what is under test here
const WHEN = new Date('2026-10-06T15:00:00Z').getTime();
const due = await dueSends(campaignId, { now: WHEN });
check('the send is due', (due.due || []).some((d) => d.contactId === contactId), JSON.stringify(due).slice(0, 220));

// THE WORKER HAS NOW TAKEN ITS LIST. Everything after this is the race.
const workersList = (due.due || []).filter((d) => d.contactId === contactId);
check('the worker is holding one queued send for this person', workersList.length === 1);

// ---------------------------------------------------------------------------
section('S2  they unsubscribe — through the real one-click endpoint');
const token = makeToken(ADDRESS);
check('the message carried a signed token', !!token && token.length > 8, String(token));

// a GET must change nothing: mail clients and scanners fetch links
let r = await api.get(`/api/collect?unsub=1&e=${encodeURIComponent(ADDRESS)}&t=${token}`);
check('a GET renders a page', r.status === 200, String(r.status));
check('and does NOT opt them out — a scanner fetching the link must not decide for them',
  (await canContact(contact, { channel: 'email', purpose: 'promotional' })).ok === true);

// RFC 8058 one-click is a POST
r = await api.form('/api/collect?unsub=1', { e: ADDRESS, t: token });
check('the one-click POST is accepted', r.status === 200, String(r.status));
check('and the address is suppressed', !!(await store.get(`suppress:email:${ADDRESS}`)));

// a forged token must not work — otherwise anyone could opt anyone out
const r2 = await api.form('/api/collect?unsub=1', { e: 'someone-else@example.invalid', t: 'forged' });
check('a forged token is refused', r2.status === 400, String(r2.status));
check('and did not suppress the address it named', !(await store.get('suppress:email:someone-else@example.invalid')));

// THE ORDER MATTERS, and the code says so: the address is suppressed FIRST,
// and updating the contact record and cancelling queued steps are best-effort
// afterwards. That promise is only real if the suppression survives when the
// rest fails — otherwise "best effort" quietly means "sometimes not at all".
{
  const other = 'sendrace-partial@example.invalid';
  const otherToken = makeToken(other);
  const realSmembers = store.smembers;
  store.smembers = async () => { throw new Error('store down'); };
  let partial = null;
  try {
    partial = await api.form('/api/collect?unsub=1', { e: other, t: otherToken });
  } finally {
    store.smembers = realSmembers;
  }
  check('an unsubscribe whose follow-up work fails still answers', !!partial && partial.status === 200, String(partial && partial.status));
  check('and the address is suppressed anyway', !!(await store.get(`suppress:email:${other}`)),
    'the suppression is what actually stops mail; everything after it is best effort');
  check('so that address can no longer be contacted',
    (await canContact({ id: 'x', email: { value: other } }, { channel: 'email', purpose: 'promotional' })).ok === false);
  await store.set(`suppress:email:${other}`, '').catch(() => {});
}

// ---------------------------------------------------------------------------
section('S3  the queued send is stopped — by the SECOND gate, not the first');
// The point of this section. If the already-computed list no longer contained
// them, the second gate would never run and nobody would know it was broken.
check('the worker is STILL holding the queued send it picked up before the opt-out',
  workersList.length === 1 && workersList[0].contactId === contactId,
  'the race only exists because the list was taken first');

const may = await maySend({ contact, campaignId, purpose: 'promotional', env: {} });
check('the send gate refuses', may.ok === false, JSON.stringify(may).slice(0, 160));
check('as not-contactable, before anything about configuration', may.code === 'not-contactable', String(may.code));
check('and says it was their decision', /opted out/i.test(may.reason || ''), may.reason);

// and the transport is watched: a gate that refuses while something else still
// calls the provider is the failure this is for
const fixture = providerFixture();
const attempt = await sendProspectEmail({
  contact,
  campaignId,
  message: { subject: 'A quick question about your website', text: 'hello', html: '<p>hello</p>' },
  env: { RESEND_API_KEY: 'fixture', OUTREACH_FROM_DOMAIN: 'o.example.invalid', PUBLIC_BASE_URL: api.origin },
  fetchImpl: fixture.fetchImpl,
});
check('the send is refused', attempt && attempt.ok === false, JSON.stringify(attempt).slice(0, 160));
check('NOTHING reached the provider', fixture.sent.length === 0, JSON.stringify(fixture.sent.map((s) => s.url)));

// ---------------------------------------------------------------------------
section('S4  and the rest of the campaign is stopped too, not just this step');
const stop = await stopContact(contactId, 'opted out mid-flight');
check('stopping the contact succeeds', stop && stop.ok !== false, JSON.stringify(stop).slice(0, 160));
const after = await getMember(campaignId, contactId);
check('their member record is no longer scheduled', !!after && after.state !== 'scheduled', JSON.stringify(after && after.state));
const dueAfter = await dueSends(campaignId, { now: WHEN });
check('and a fresh due list no longer contains them',
  !(dueAfter.due || []).some((d) => d.contactId === contactId), JSON.stringify(dueAfter).slice(0, 160));

// a later step must not resurrect them
const stillRefused = await maySend({ contact, campaignId, purpose: 'promotional', env: {} });
check('a later step is still refused', stillRefused.ok === false, JSON.stringify(stillRefused).slice(0, 120));

// ---------------------------------------------------------------------------
section('S5  the suppression outlives the contact record');
// the suppression is keyed on the ADDRESS precisely so that losing, merging or
// rewriting the contact cannot bring someone back onto the list
const rebuilt = { id: 'a-brand-new-record', email: { value: ADDRESS }, name: 'Race Roofing' };
const rebuiltMay = await canContact(rebuilt, { channel: 'email', purpose: 'promotional' });
check('a FRESH contact record with the same address is still refused', rebuiltMay.ok === false, JSON.stringify(rebuiltMay));
check('because the opt-out belongs to the person, not to the record', /opted out/i.test(rebuiltMay.reason || ''), rebuiltMay.reason);

// different address, same person's company — must NOT be suppressed by accident
const colleague = await canContact({ id: 'colleague', email: { value: 'someone.else@example.invalid' } }, { channel: 'email', purpose: 'promotional' });
check('a different address is not swept up by it', colleague.ok === true, JSON.stringify(colleague));

// ---------------------------------------------------------------------------
await store.set(`suppress:email:${ADDRESS}`, '').catch(() => {});
await api.stop();
done();
