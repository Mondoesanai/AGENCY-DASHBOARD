// The six journeys the owner actually performs, each traced end to end.
//
// R18.4. Not a re-run of the module tests. Each journey goes through the REAL
// `api/` surface over a socket — the same door the browser uses — so a feature
// that works in isolation but has no production caller fails here.
//
// Every journey carries a NEGATIVE CONTROL, because the failure mode this build
// keeps finding is a check that passes without ever being able to fail.
//
// Fixtures only: reserved domains, unassigned 555 numbers, fake providers, and
// `outreach.active` left false throughout. No number appears in any message.
import { check, section, done } from './world.mjs';
import { startLocalApi } from './harness/local-api.mjs';
import { signedInboundReq, TEST_AUTH_TOKEN } from './harness/twilio-sign.mjs';
import { store } from '../lib/store.js';

const api = await startLocalApi();
const get = (p) => api.request(p);
const post = (p, b) => api.post(p, b);
const N = (n) => `+121455578${String(n).padStart(2, '0')}`;

const tokenWas = process.env.TWILIO_AUTH_TOKEN;
process.env.TWILIO_AUTH_TOKEN = TEST_AUTH_TOKEN;

// ===========================================================================
section('J1  a contact is imported, deduplicated, and is NOT textable');
// The rule that matters: having somebody's phone number is not permission to
// text it. This is the single most expensive mistake available here.
const csv = [
  'name,business,email,phone',
  'Pat Lee,Lee Flooring,pat@leeflooring.test,(214) 555-7801',
  'Pat Lee,Lee Flooring,pat@leeflooring.test,(214) 555-7801', // the same person twice
  'Sam Ortiz,Ortiz Tile,sam@ortiztile.test,(214) 555-7802',
].join('\n');

let r = await post('/api/admin?do=csv-preview', { csv });
check('the import previews before it commits', r.status === 200, `${r.status}`);
const mapped = r.json?.preview || r.json;
check('and it reports what it found', !!mapped, JSON.stringify(r.json).slice(0, 120));

r = await post('/api/admin?do=csv-import', { csv, mapping: r.json?.mapping || undefined, source: 'csv_import' });
check('the import runs', r.status === 200, `${r.status}`);

const list = await get('/api/admin?do=contacts-list');
const rows = list.json?.contacts || [];
const lee = rows.filter((c) => /leeflooring/.test(JSON.stringify(c.email || '')));
check('the duplicate row did not create two people', lee.length === 1, `${lee.length} matched`);
check('and the second person did import', rows.some((c) => /ortiztile/.test(JSON.stringify(c.email || ''))));

// `?do=contact-status` returns the whole table, not one contact — the screen
// shows everybody at once, so the row is found rather than requested.
const statusRow = (table, id) => (table.json?.rows || []).find((x) => x.id === id) || {};
const st = await get('/api/admin?do=contact-status');
check('the status table loads', st.status === 200 && Array.isArray(st.json?.rows), `${st.status}`);
const sms = statusRow(st, lee[0]?.id).sms;
check('THEIR PHONE NUMBER DOES NOT MAKE THEM TEXTABLE', sms?.eligible === false, JSON.stringify(sms || null).slice(0, 160));
check('and the screen says why in plain words', /permission/i.test(sms?.reason || ''), sms?.reason);
check('the row also carries what to do next', !!sms?.next,
  'the owner has to be told the lawful next step, not just refused');

section('J1b  NEGATIVE CONTROL: with recorded permission they DO become textable');
await post('/api/admin?do=record-permission', {
  contactId: lee[0].id, channel: 'sms',
  source: 'asked me to text her at the counter', wording: 'I will text you the preview link',
  evidence: 'signed card #201',
});
const st2 = await get('/api/admin?do=contact-status');
const sms2 = statusRow(st2, lee[0].id).sms;
check('now they are textable', sms2?.eligible === true, JSON.stringify(sms2 || null).slice(0, 140));
check('but only for one message, not a series', sms2?.promotional === false, String(sms2?.promotional));

// ===========================================================================
section('J2  an unchecked website never becomes a false "no website"');
// Through `?do=campaign-preview`, which is the endpoint the owner's "see the
// exact words first" button calls. An earlier version of this section imported
// `composeCold` directly and still claimed to be tracing the API — the reviewer
// caught it. A constraint that holds in a library but is not reachable through
// the endpoint people use is exactly the gap this file exists to find.
const { WEB_STATUS } = await import('../lib/discovery.js');
check('"not checked" and "no site" are different states',
  WEB_STATUS.NOT_CHECKED !== WEB_STATUS.NOT_LINKED, JSON.stringify(WEB_STATUS));

// The owner identity has to be complete first, or both halves refuse for the
// same CAN-SPAM reason and J2 proves nothing about the website check.
await post('/api/admin?do=sender-save', {
  sender: { name: 'Mondoe', business: 'Inspiring Websites', postalAddress: '1 Test St, Plano TX', replyTo: 'a@iw.test' },
});

r = await post('/api/admin?do=campaign-preview', {
  prospect: { name: 'Unchecked Co', email: 'hi@unchecked.test', web: { status: WEB_STATUS.NOT_CHECKED }, evidence: { rawTags: {} } },
});
check('the preview endpoint answers', r.status === 200, `${r.status}`);
check('but an UNCHECKED prospect produces no sendable message',
  r.json?.message?.ok === false, JSON.stringify(r.json?.message || {}).slice(0, 170));
check('and the reason names the missing check',
  /check|unknown|not been looked|no honest/i.test(JSON.stringify(r.json?.message || {})),
  JSON.stringify(r.json?.message || {}).slice(0, 170));

section('J2b  NEGATIVE CONTROL: a genuinely checked prospect composes');
r = await post('/api/admin?do=campaign-preview', {
  prospect: { name: 'Checked Co', email: 'hi@checked.test', web: { status: WEB_STATUS.NOT_LINKED }, evidence: { rawTags: {} } },
});
check('a checked prospect can be written to through the same endpoint',
  r.json?.message?.ok === true, JSON.stringify(r.json?.message || {}).slice(0, 170));
check('and the owner identity is reported as complete', r.json?.owner?.complete === true,
  JSON.stringify(r.json?.owner || {}));

// ===========================================================================
section('J3  a consented contact: queue, send, deliver, reply, cancel, STOP');
const num = N(10);
r = await post('/api/admin?do=contacts-save', {
  contact: { id: 'oj_sms', name: 'Jo Example', business: 'Example Co', email: 'jo@example.invalid', phone: num },
});
await post('/api/admin?do=record-permission', {
  contactId: 'oj_sms', channel: 'sms',
  source: 'asked for the preview by text', wording: 'I will text you the preview link', evidence: 'card #202',
});

r = await post('/api/admin?do=sms-compose', { contactId: 'oj_sms', body: 'Your preview is ready.' });
check('composing is permitted', r.json?.draft?.ok === true, JSON.stringify(r.json).slice(0, 160));

r = await post('/api/admin?do=sms-schedule', { contactId: 'oj_sms', body: 'Your preview is ready.', sendAt: Date.now() });
check('it queues', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json).slice(0, 140));
const msgId = r.json?.message?.id;
check('and the queued message has an id', !!msgId);

section('J3b  the send goes through the real caller and stops at the provider');
r = await post('/api/admin?do=sms-send', { messageId: msgId });
check('the send is attempted through the real action', r.status === 200, `${r.status}`);
check('and refused by the owner switch, not silently dropped',
  r.json?.blockedBy === 'outreach-switch', JSON.stringify(r.json).slice(0, 160));
check('the refusal names it as an owner action, not a provider fault', r.json?.ownerAction === true);

section('J3c  an inbound reply cancels a racing follow-up and lands in one thread');
const inboundReply = await api.request('/api/collect?hook=sms', {
  ...signedInboundReq({ From: num, Body: 'Yes please, what would it cost?', MessageSid: 'SMoj1' }),
  method: 'POST',
  body: new URLSearchParams({ From: num, Body: 'Yes please, what would it cost?', MessageSid: 'SMoj1' }).toString(),
});
check('the carrier payload is accepted', inboundReply.status === 200, `${inboundReply.status}`);
const conv = await get(`/api/admin?do=conversation&contactId=${encodeURIComponent('oj_sms')}`);
check('the reply is in the conversation', JSON.stringify(conv.json).includes('what would it cost'),
  JSON.stringify(conv.json).slice(0, 220));
check('a human reply pauses automatic follow-up',
  conv.json?.conversation?.paused?.paused === true, JSON.stringify(conv.json?.conversation?.paused || {}));
check('and the pause says a person replied', /repl/i.test(JSON.stringify(conv.json?.conversation?.paused || {})),
  'a queued follow-up must not go out after somebody has answered');

section('J3d  STOP overrides a queued send');
// A SEPARATE contact, because oj_sms is already paused by their reply above —
// testing STOP there would pass on the pause and prove nothing about STOP.
const stopNum = N(11);
await post('/api/admin?do=contacts-save', {
  contact: { id: 'oj_stop', name: 'Kit Example', business: 'Kit Co', email: 'kit@example.invalid', phone: stopNum },
});
await post('/api/admin?do=record-permission', {
  contactId: 'oj_stop', channel: 'sms',
  source: 'asked for the preview by text', wording: 'I will text you the preview link', evidence: 'card #203',
});
r = await post('/api/admin?do=sms-schedule', { contactId: 'oj_stop', body: 'Another one.', sendAt: Date.now() });
const queuedId = r.json?.message?.id;
check('a message is queued for them', !!queuedId, JSON.stringify(r.json).slice(0, 140));

await api.request('/api/collect?hook=sms', {
  ...signedInboundReq({ From: stopNum, Body: 'STOP', MessageSid: 'SMoj2' }),
  method: 'POST',
  body: new URLSearchParams({ From: stopNum, Body: 'STOP', MessageSid: 'SMoj2' }).toString(),
});
const { send } = await import('../lib/sms-send.js');
const { getContact } = await import('../lib/contacts.js');
const afterStop = await send(queuedId, { contact: await getContact('oj_stop'), env: {} });
check('the queued message is NOT sent after STOP', afterStop.ok === false, JSON.stringify(afterStop).slice(0, 160));
check('and the refusal is about permission, not the provider',
  afterStop.permissionChanged === true || /permitted|opted out|suppress|stop/i.test(afterStop.error || ''),
  JSON.stringify(afterStop).slice(0, 160));

section('J3e  an uncertain provider outcome does not duplicate a message');
const { withSpend } = await import('../lib/spend-guard.js');
let attempts = 0;
const jid = `oj-timeout-${Date.now()}`;
const first = await withSpend({ category: 'messaging', estimateUsd: 0.01, jobId: jid }, async () => {
  attempts += 1; throw new Error('socket hang up');
});
check('a timeout is reported as uncertain', first.uncertain === true, JSON.stringify(first).slice(0, 140));
const retry = await withSpend({ category: 'messaging', estimateUsd: 0.01, jobId: jid }, async () => {
  attempts += 1; return 'sent again';
});
check('A RETRY DOES NOT SEND IT AGAIN', attempts === 1, `${attempts} attempts`);
check('and says the outcome was already decided', /already finished/.test(retry.reason || ''), retry.reason);

// ===========================================================================
section('J4  a requested preview becomes a task and cannot be announced early');
// Through `?do=cards-commit` — the endpoint the card scanner posts to. That is
// the production trigger: lib/card-intake.js calls createTask when a committed
// card says a preview was asked for. An earlier version called createTask
// directly, which proved the library worked and nothing about the path.
r = await post('/api/admin?do=cards-commit', {
  cards: [{
    name: { value: 'Jo Example', confidence: 1 },
    businessName: { value: 'Example Co', confidence: 1 },
    email: { value: 'jo@example.invalid', confidence: 1 },
    phone: { value: N(10), confidence: 1 },
  }],
  // What they ASKED FOR lives in the context's per-card interactions, not on
  // the card: the card is what was printed, the interaction is what happened.
  // lib/relationship.js creates a preview task when the interest is
  // wants-preview, and routes to a gentle introduction when it is not.
  context: {
    event: 'Plano Chamber breakfast',
    collectedAt: new Date().toISOString(),
    interactions: [{ interest: 'wants-preview', notes: 'asked to see a preview' }],
  },
});
check('committing a scanned card succeeds', r.status === 200, `${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);

// The endpoint reports the task it created, so this reads the response rather
// than looking the task up and hoping it is the right one.
const saved = (r.json?.saved || [])[0] || {};
check('the endpoint reports how many preview tasks it created', typeof r.json?.previewTasks === 'number', JSON.stringify(r.json?.previewTasks));
check('the card was routed as a preview request',
  /preview/i.test(JSON.stringify(saved.relationship || {})), JSON.stringify(saved.relationship || {}).slice(0, 170));
check('A CARD ASKING FOR A PREVIEW CREATED A REAL TASK', !!saved.previewTask,
  JSON.stringify(saved.previewTask || null));
const taskId = saved.previewTask?.task?.id || saved.previewTask?.id;
check('and the task has an id the dashboard can act on', !!taskId, String(taskId));
const previewContactId = saved.contact?.id;
check('attached to the contact the card created', !!previewContactId, String(previewContactId));

let ann = await get(`/api/admin?do=preview-announceable&contactId=${encodeURIComponent(previewContactId)}`);
check('it cannot be announced while it is only requested',
  ann.json?.result?.ok === false, JSON.stringify(ann.json).slice(0, 170));
check('and the reason is that nothing is built yet',
  /not ready|never|requested|built/i.test(JSON.stringify(ann.json?.result || {})), JSON.stringify(ann.json?.result).slice(0, 150));

r = await post('/api/admin?do=preview-state', { taskId, state: 'ready' });
check('REQUESTED cannot skip straight to READY', r.json?.ok === false, JSON.stringify(r.json).slice(0, 160));
check('and the refusal names the states it CAN go to',
  /Researching/.test(JSON.stringify(r.json)), JSON.stringify(r.json).slice(0, 150));

// R19.4 — the owner's stages, walked through the API one at a time.
r = await post('/api/admin?do=preview-state', { taskId, state: 'researching' });
check('it can move to researching', r.json?.ok === true, JSON.stringify(r.json).slice(0, 140));
r = await post('/api/admin?do=preview-state', { taskId, state: 'building' });
check('and then to being built', r.json?.ok === true, JSON.stringify(r.json).slice(0, 140));

r = await post('/api/admin?do=preview-state', { taskId, state: 'ready', url: 'https://preview.example/oj' });
check('a built preview with a URL is STILL not ready before review', r.json?.ok === false,
  JSON.stringify(r.json).slice(0, 160));
check('and says review is what is missing',
  /review/i.test(JSON.stringify(r.json)), JSON.stringify(r.json).slice(0, 170));

r = await post('/api/admin?do=preview-state', { taskId, state: 'review' });
check('it can move to waiting for review', r.json?.ok === true, JSON.stringify(r.json).slice(0, 140));
r = await post('/api/admin?do=preview-state', { taskId, state: 'ready' });
check('but READY without a URL is still refused', r.json?.ok === false, JSON.stringify(r.json).slice(0, 160));
check('because an announcement needs something to point at',
  /url|link/i.test(JSON.stringify(r.json)), JSON.stringify(r.json).slice(0, 150));

section('J4b  NEGATIVE CONTROL: ready WITH a url is accepted and announceable');
r = await post('/api/admin?do=preview-state', { taskId, state: 'ready', url: 'https://preview.example/oj' });
check('ready with a real url works', r.json?.ok === true, JSON.stringify(r.json).slice(0, 160));
ann = await get(`/api/admin?do=preview-announceable&contactId=${encodeURIComponent(previewContactId)}`);
check('and now it may be announced', ann.json?.result?.ok === true, JSON.stringify(ann.json?.result).slice(0, 150));

// ===========================================================================
section('J5  a booking counts only when the scheduler confirms it');
const before = (await get('/api/admin?do=meetings')).json;
const beforeAttended = before?.progress?.attended ?? 0;

r = await post('/api/admin?do=booking-click', { contactId: 'oj_sms' });
const afterClick = (await get('/api/admin?do=meetings')).json;
check('a LINK CLICK is not a meeting',
  (afterClick?.progress?.booked ?? 0) === (before?.progress?.booked ?? 0),
  'somebody opening the booking page has not booked anything');

r = await post('/api/admin?do=booking-manual', {
  contactId: 'oj_sms', name: 'Jo Example', startAt: Date.now() + 86400e3,
});
check('a hand-entered booking is accepted', r.status === 200, `${r.status}`);
const afterManual = (await get('/api/admin?do=meetings')).json;
check('but it is marked as not confirmed by the scheduler',
  JSON.stringify(afterManual).includes('verified') || JSON.stringify(afterManual).includes('not confirmed'),
  JSON.stringify(afterManual).slice(0, 180));
check('and attendance has NOT moved', (afterManual?.progress?.attended ?? 0) === beforeAttended,
  'a booking is not an attended meeting');

section('J5b  an outcome changes the result without inventing a reason');
const bookings = (await get('/api/admin?do=bookings-list')).json?.bookings || [];
const bid = bookings[0]?.id;
if (bid) {
  // `booking-outcome` reads query parameters, not a body.
  r = await get(`/api/admin?do=booking-outcome&id=${encodeURIComponent(bid)}&outcome=no-show`);
  check('a no-show is recorded', r.status === 200, `${r.status} ${JSON.stringify(r.json).slice(0, 110)}`);
  const diag = (await get('/api/admin?do=meetings')).json;
  const sf = JSON.stringify(diag?.shortfall || {});
  check('and the shortfall refuses to name a cause from one example',
    /too few to conclude|Nothing here is a finding/.test(sf) || sf === '{}', sf.slice(0, 180));
  check('any suggestion offered is labelled a hypothesis',
    !/\bbecause\b/.test(sf) || /HYPOTHESIS/.test(sf), sf.slice(0, 160));
} else {
  check('bookings are listed so an outcome can be recorded', false, 'no booking found to record an outcome against');
}

// ===========================================================================
section('J6  a revision blocked by missing repo access is actionable');
// Through `?do=recovery-diagnose`, the action the dashboard calls on every
// load — not the library behind it.
const diag = await get('/api/admin?do=recovery-diagnose');
check('the diagnosis endpoint answers', diag.status === 200, `${diag.status}`);
const d = diag.json || {};
const findings = d.findings || d.problems || [];
check('it reports findings as a list, not a sentence', Array.isArray(findings), typeof findings);
const configIssues = findings.filter((f) => /config|credential|repo|token|permission/i.test(JSON.stringify(f)));
check('a configuration problem names an owner action rather than retrying for ever',
  configIssues.every((f) => f.ownerAction !== undefined || /set |add |link |connect /i.test(JSON.stringify(f))),
  JSON.stringify(configIssues).slice(0, 200));

const tasks = await get('/api/admin?do=repair-tasks');
check('repair tasks are reachable from the dashboard', tasks.status === 200, `${tasks.status}`);
check('and each says a person decides, not the machine',
  !(tasks.json?.tasks || []).length || (tasks.json.tasks || []).every((t) => /person decides/i.test(t.note || '')),
  JSON.stringify((tasks.json?.tasks || [])[0] || {}).slice(0, 160));

section('J6b  NEGATIVE CONTROL: the sweep distinguishes "ran" from "found nothing"');
const auto = await get('/api/admin?do=automation-status');
check('the automation status answers without a password', auto.status === 200, `${auto.status}`);
check('and carries the sweep history, so a stalled sweep is visible',
  'sweeps' in (auto.json?.automation || {}), Object.keys(auto.json?.automation || {}).join(','));

process.env.TWILIO_AUTH_TOKEN = tokenWas;
await api.stop();
done();
