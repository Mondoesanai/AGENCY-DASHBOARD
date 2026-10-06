// Ten events that are not each other.
//
// R19.7. A funnel is only useful if each stage counts a different thing. The
// way it goes wrong is always the same: a page view, a slot click and a form
// submission get folded into "bookings", the number looks healthy, and the
// week has no meetings in it. The owner asked for the opposite explicitly —
// count bookings only after provider confirmation, and never count page views,
// slot selections or form submissions as bookings.
//
// So the checks here are mostly refusals, and each has a negative control: the
// same event WITH its evidence must be accepted, or the funnel would simply be
// a set of counters that never move.

import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  FUNNEL, FUNNEL_ORDER, FUNNEL_EXITS, FUNNEL_LABEL, record, report, recent,
} from '../lib/funnel.js';

const countOf = async (ev) => Number(await store.get(`funnel:${ev}`)) || 0;

// ---------------------------------------------------------------------------
section('F1  the ten events the owner named all exist and are distinct');
for (const [name, ev] of [
  ['invitation', FUNNEL.INVITATION], ['form visit', FUNNEL.FORM_VISIT],
  ['submitted request', FUNNEL.SUBMITTED], ['confirmed booking', FUNNEL.BOOKED],
  ['preview built', FUNNEL.PREVIEW_BUILT], ['preview delivered', FUNNEL.PREVIEW_DELIVERED],
  ['reconfirmation', FUNNEL.RECONFIRMED], ['attended call', FUNNEL.ATTENDED],
  ['cancellation', FUNNEL.CANCELLED], ['no-show', FUNNEL.NO_SHOW],
]) {
  check(`"${name}" is its own event`, typeof ev === 'string' && ev.length > 0);
  check(`and reads in plain language: "${FUNNEL_LABEL[ev]}"`, !!FUNNEL_LABEL[ev] && FUNNEL_LABEL[ev] !== ev);
}
check('all ten are different values', new Set(Object.values(FUNNEL)).size === 10, String(new Set(Object.values(FUNNEL)).size));
check('cancellation and no-show are exits, not stages',
  FUNNEL_EXITS.includes(FUNNEL.CANCELLED) && FUNNEL_EXITS.includes(FUNNEL.NO_SHOW)
  && !FUNNEL_ORDER.includes(FUNNEL.CANCELLED) && !FUNNEL_ORDER.includes(FUNNEL.NO_SHOW),
  'counting a cancellation as a funnel stage would make dropping out look like progress');

// ---------------------------------------------------------------------------
section('F2  a booking needs the PROVIDER, not a form submission');
const bookedBefore = await countOf(FUNNEL.BOOKED);

const noProvider = await record(FUNNEL.BOOKED, { requestId: 'r1' });
check('a booking with no provider id is refused', noProvider.ok === false, JSON.stringify(noProvider));
check('and says what was missing', noProvider.missing === 'providerId', noProvider.missing);
check('naming the actual rule',
  /page view|slot selection|form submission/i.test(noProvider.reason), noProvider.reason);
check('the count did not move', (await countOf(FUNNEL.BOOKED)) === bookedBefore);

// The three things that must never become a booking, recorded for real.
await record(FUNNEL.FORM_VISIT, { at: Date.now() });
await record(FUNNEL.SUBMITTED, { requestId: 'r1' });
await record(FUNNEL.INVITATION, { contactId: 'c1' });
check('a form visit does not increment bookings', (await countOf(FUNNEL.BOOKED)) === bookedBefore);
check('nor does a submitted request', (await countOf(FUNNEL.BOOKED)) === bookedBefore);
check('nor does an invitation', (await countOf(FUNNEL.BOOKED)) === bookedBefore);
check('but they do increment their OWN counts',
  (await countOf(FUNNEL.FORM_VISIT)) >= 1 && (await countOf(FUNNEL.SUBMITTED)) >= 1 && (await countOf(FUNNEL.INVITATION)) >= 1);

section('F2b  NEGATIVE CONTROL: with a provider id it IS a booking');
const real = await record(FUNNEL.BOOKED, { requestId: 'r1', providerId: 'evt_real_1' });
check('a provider-confirmed booking is accepted', real.ok === true, JSON.stringify(real));
check('and the count moved by exactly one', (await countOf(FUNNEL.BOOKED)) === bookedBefore + 1);

// ---------------------------------------------------------------------------
section('F3  attendance is observed, never ticked');
const attendedBefore = await countOf(FUNNEL.ATTENDED);
const ticked = await record(FUNNEL.ATTENDED, { contactId: 'c1' });
check('attendance with nobody observing it is refused', ticked.ok === false, JSON.stringify(ticked));
check('and the reason names the checkbox explicitly',
  /plan to attend/i.test(ticked.reason), ticked.reason);
await record(FUNNEL.RECONFIRMED, { contactId: 'c1' });
check('a reconfirmation does NOT increment attendance', (await countOf(FUNNEL.ATTENDED)) === attendedBefore,
  'this is the exact conflation the owner ruled out: an acknowledgment is not evidence they came');
check('it increments reconfirmations instead', (await countOf(FUNNEL.RECONFIRMED)) >= 1);

const observed = await record(FUNNEL.ATTENDED, { contactId: 'c1', observedBy: 'owner' });
check('NEGATIVE CONTROL: attendance observed by a person is accepted', observed.ok === true, JSON.stringify(observed));

section('F3b  a preview counts as built only when there is a URL');
check('preview-built with no URL is refused', (await record(FUNNEL.PREVIEW_BUILT, {})).ok === false);
check('and says "being built" is not built',
  /being built["”]? is not built/i.test((await record(FUNNEL.PREVIEW_BUILT, {})).reason || ''),
  (await record(FUNNEL.PREVIEW_BUILT, {})).reason);
check('NEGATIVE CONTROL: with a real URL it is accepted',
  (await record(FUNNEL.PREVIEW_BUILT, { previewUrl: 'https://p.example/x' })).ok === true);
check('an unknown event is refused outright', (await record('made-up-event', {})).ok === false);

// ---------------------------------------------------------------------------
section('F4  the report says where people are lost');
const rep = await report();
check('it is readable', rep.readable === true, JSON.stringify(rep).slice(0, 160));
check('every ordered stage is present', rep.stages.length === FUNNEL_ORDER.length);
check('each stage carries a count and a label', rep.stages.every((s) => typeof s.count === 'number' && !!s.label));
check('the first stage has no previous to compare against', rep.stages[0].fromPrevious === null);
check('the exits are reported separately from the stages',
  rep.exits.length === FUNNEL_EXITS.length && !rep.stages.some((s) => FUNNEL_EXITS.includes(s.event)));
check('the two most-confused numbers are reported side by side',
  typeof rep.submittedButNotBooked === 'number' && typeof rep.bookedButNotAttended === 'number',
  JSON.stringify({ a: rep.submittedButNotBooked, b: rep.bookedButNotAttended }));
check('and the rule is stated on the report itself',
  /only when the scheduling provider confirmed it/i.test(rep.note), rep.note);

section('F4b  an unreadable store does NOT report zeros');
const realGet = store.get;
store.get = async () => { throw new Error('kv down'); };
const broken = await report();
store.get = realGet;
check('it says it could not read', broken.readable === false, JSON.stringify(broken).slice(0, 160));
check('rather than showing an empty funnel', (broken.stages || []).length === 0,
  '"nobody came" and "I could not count" are different claims, and the first is much worse to get wrong');
check('and says so in words', /not being shown rather than shown as zero/i.test(broken.why || ''), broken.why);

// ---------------------------------------------------------------------------
section('F5  the events are recorded by the REAL paths, not only by tests');
const { readFile } = await import('node:fs/promises');
const src = async (p) => readFile(new URL(p, import.meta.url), 'utf8');

const previewRequest = await src('../lib/preview-request.js');
check('a submitted request is recorded where the form is handled',
  /funnel\(FUNNEL\.SUBMITTED/.test(previewRequest), 'lib/preview-request.js');
check('a booking is recorded with the provider id from the booking result',
  /funnel\(FUNNEL\.BOOKED[\s\S]{0,120}providerId: res\.providerId/.test(previewRequest), 'lib/preview-request.js');
check('and only inside the branch where the provider said ok',
  previewRequest.indexOf('funnel(FUNNEL.BOOKED') > previewRequest.indexOf('if (res.ok)'), 'lib/preview-request.js');
check('the attendance tick records RECONFIRMED, not ATTENDED',
  /if \(willAttend\) await funnel\(FUNNEL\.RECONFIRMED/.test(previewRequest)
  && !/funnel\(FUNNEL\.ATTENDED/.test(previewRequest), 'lib/preview-request.js');

const previews = await src('../lib/previews.js');
check('preview built and delivered are recorded by the state machine',
  /FUNNEL\.PREVIEW_BUILT : FUNNEL\.PREVIEW_DELIVERED/.test(previews), 'lib/previews.js');

const bookings = await src('../lib/bookings.js');
check('attended and no-show are recorded where a person records the outcome',
  /FUNNEL\.ATTENDED : FUNNEL\.NO_SHOW/.test(bookings), 'lib/bookings.js');
check('with the person who said so as the evidence', /observedBy: by/.test(bookings), 'lib/bookings.js');
check('a cancellation is recorded from the verified webhook',
  /funnel\(FUNNEL\.CANCELLED/.test(bookings), 'lib/bookings.js');

const collect = await src('../api/collect.js');
check('a form visit is recorded when the page asks for real times',
  /funnel\(FUNNEL\.FORM_VISIT/.test(collect), 'api/collect.js');

const outreach = await src('../lib/outreach-email.js');
check('an invitation is recorded only after the provider accepted the send',
  /funnel\(FUNNEL\.INVITATION/.test(outreach)
  && outreach.indexOf('funnel(FUNNEL.INVITATION') > outreach.indexOf('await markSent(contact.id, campaignId, { provider: adapter.name })'),
  'lib/outreach-email.js');

section('F5b  end to end: a real submission moves the right counters');
const before = { sub: await countOf(FUNNEL.SUBMITTED), booked: await countOf(FUNNEL.BOOKED), recon: await countOf(FUNNEL.RECONFIRMED) };
const { submitRequest } = await import('../lib/preview-request.js');
const out = await submitRequest({
  name: 'Funnel Tester', businessName: 'Funnel Co', email: `funnel${Date.now()}@example.test`,
  timezone: 'America/Chicago', willAttend: true,
});
check('the submission went through', out.ok === true, JSON.stringify(out).slice(0, 160));
check('submitted went up by one', (await countOf(FUNNEL.SUBMITTED)) === before.sub + 1);
check('reconfirmed went up by one', (await countOf(FUNNEL.RECONFIRMED)) === before.recon + 1);
check('but bookings did NOT move', (await countOf(FUNNEL.BOOKED)) === before.booked,
  'no calendar is connected, so nothing was confirmed — and a submission is never a booking');

section('F6  the recent log is readable and newest first');
const r = await recent(10);
check('it reads', r.ok === true);
check('and carries real events', r.events.length > 0, String(r.events.length));
check('newest first', r.events.every((e, i) => i === 0 || (r.events[i - 1].at || 0) >= (e.at || 0)));

done();
