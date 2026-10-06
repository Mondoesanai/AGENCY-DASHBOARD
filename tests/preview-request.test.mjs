// The form promises things. These are the checks that it keeps them.
//
// R19.2/R19.3. Five promises are made on the page, and each one is a way the
// product could lie:
//
//   · "complimentary and without obligation"  → no fabricated redesign, and no
//     claim that a preview is ready before one exists;
//   · "Entering it does not sign you up"      → a phone number alone never
//     becomes promotional permission;
//   · "not required to book"                  → booking must succeed with the
//     SMS box untouched, and must not differ;
//   · "Up to N texts"                         → N is enforced, not decorative;
//   · a confirmation                          → shown only after the provider
//     confirmed, never after a submission.
//
// Every one is checked with a NEGATIVE CONTROL beside it: a check that only
// passes because the gate is there, so removing the gate fails the suite rather
// than quietly passing it.

import { check, section, done } from './world.mjs';
import { readFile } from 'node:fs/promises';
import { store } from '../lib/store.js';
import { checkWebsite, submitRequest, makePrefill, readPrefill, REQUEST_STATE } from '../lib/preview-request.js';
import {
  MAX_REQUEST_TEXTS, TEXTABLE_KINDS, REQUEST_MESSAGE_PLAN, OWNER,
  notificationOwner, claimRequestText, consentCopy, requestTextLedger,
} from '../lib/request-sms.js';
import { saveRules, DEFAULT_RULES } from '../lib/scheduling.js';

const HTML = await readFile(new URL('../public/request.html', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
section('P1  the page says what the owner asked it to say');

check('the heading is the owner\'s heading',
  HTML.includes('See what your business website could become'));
check('the preview is described as complimentary AND without obligation',
  /complimentary and without obligation/i.test(HTML));
check('the paid outcome is stated, not hidden',
  /build price/i.test(HTML) && /monthly maintenance fee/i.test(HTML),
  'a free preview that leads to a priced build has to say so on the page that asks for the booking');

// Negative control for the whole "do not pretend" rule.
check('no fabricated redesign is displayed',
  !/<img[^>]+src=["']https?:\/\//i.test(HTML),
  'the page must not show a mocked-up redesign of a business it has never seen');
check('the page never claims a preview is already ready',
  !/your preview is ready/i.test(HTML),
  'readiness is a state the preview task reaches, not a thing a landing page asserts');

section('P2  exactly two checkboxes, both unticked, neither required');
const boxes = [...HTML.matchAll(/<input[^>]*type=["']checkbox["'][^>]*>/gi)].map((m) => m[0]);
check(`exactly two checkboxes (found ${boxes.length})`, boxes.length === 2,
  boxes.join('\n'));
check('neither is pre-ticked', boxes.every((b) => !/\bchecked\b/i.test(b)),
  'a pre-ticked consent box is not consent');
check('neither is required', boxes.every((b) => !/\brequired\b/i.test(b)),
  'making either one required would make SMS a condition of booking');
check('one is the SMS box', boxes.some((b) => /id=["']smsOptIn["']/.test(b)));
check('the other is the attendance box', boxes.some((b) => /id=["']willAttend["']/.test(b)));

section('P3  the SMS consent line, word for word');
check('the lead line is the owner\'s wording',
  /I agree to receive texts from Inspiring Websites/.test(HTML));
check('"See more" is the disclosure control',
  /<summary[^>]*>See more<\/summary>/.test(HTML),
  'the owner asked for a short line plus See more, not a wall of text');
check('the detail names the scope',
  /confirmation, reminders,\s*\n?\s*rescheduling information/i.test(HTML.replace(/\s+/g, ' '))
  || /confirmation, reminders, rescheduling information/i.test(HTML.replace(/\s+/g, ' ')));
check('the detail promises a text AFTER the appointment',
  /follow-up text\s*after the appointment/i.test(HTML.replace(/\s+/g, ' ')),
  'the owner asked for this explicitly: "ITLL SAY THAT WE WILL TEXT THEM AFTER THE APPOINTMENT AS WELL"');
check('STOP and HELP are both present', /\bSTOP\b/.test(HTML) && /\bHELP\b/.test(HTML));
check('rates line is present', /Message and data rates may apply/.test(HTML));
check('optionality is stated inside the consent itself',
  /Texts are optional and are not required to book/.test(HTML));
check('Terms and Privacy are linked from the consent',
  /optin-terms\.html/.test(HTML) && /optin-privacy\.html/.test(HTML));

section('P4  the quoted maximum is the enforced maximum');
const quoted = HTML.match(/Up to <b id="smsMax">(\d+)<\/b> texts/);
check('the page quotes a number', !!quoted, 'the consent line has to state a frequency');
check(`the quoted number (${quoted?.[1]}) equals MAX_REQUEST_TEXTS (${MAX_REQUEST_TEXTS})`,
  Number(quoted?.[1]) === MAX_REQUEST_TEXTS,
  'this is the check that stops the page drifting into a figure nothing enforces');
check('the maximum is derived from the plan, not typed',
  MAX_REQUEST_TEXTS === REQUEST_MESSAGE_PLAN.filter((m) => m.channel === 'sms' && m.owner === OWNER.US).length);
check('the plan includes the post-appointment follow-up the owner asked for',
  TEXTABLE_KINDS.includes('post-appointment-followup'));

section('P4b  no notification has two owners');
for (const row of REQUEST_MESSAGE_PLAN) {
  const dupes = REQUEST_MESSAGE_PLAN.filter((o) => o.kind === row.kind && o.channel === row.channel);
  check(`"${row.kind}" on ${row.channel} has one owner`, dupes.length === 1);
}
check('the calendar owns the appointment email, not us',
  notificationOwner('calendar-invitation', 'email').owner === OWNER.CALENDAR);
check('and we refuse to send it ourselves',
  notificationOwner('calendar-invitation', 'email').weSend === false,
  'Google already emails the invitation with sendUpdates:all — ours would be the duplicate');
check('we own the preview delivery email, which the calendar knows nothing about',
  notificationOwner('preview-delivery', 'email').weSend === true);

section('P4c  the ceiling actually refuses');
const RQ = `rq_${Math.random().toString(36).slice(2, 8)}`;
let granted = 0;
for (const kind of TEXTABLE_KINDS) {
  // bookingConfirmed is true throughout this section: it is about the CAP,
  // and the separate booking requirement is checked in P4c2.
  const r = await claimRequestText({ requestId: RQ, kind, bookingConfirmed: true });
  if (r.ok) granted++;
}
check(`all ${MAX_REQUEST_TEXTS} planned texts are allowed once`, granted === MAX_REQUEST_TEXTS);
const again = await claimRequestText({ requestId: RQ, kind: TEXTABLE_KINDS[0], bookingConfirmed: true });
check('the same kind twice is refused', again.ok === false && again.alreadySent === true,
  'a retried job must not re-text somebody');
// Negative control: a fresh request must still be able to send, or the above
// would pass simply because everything is refused.
const RQ2 = `rq_${Math.random().toString(36).slice(2, 8)}`;
const fresh = await claimRequestText({ requestId: RQ2, kind: TEXTABLE_KINDS[0], bookingConfirmed: true });
check('a DIFFERENT request still gets its allowance', fresh.ok === true,
  'negative control — proves the refusal above is per-request, not blanket');
const notOurs = await claimRequestText({ requestId: RQ2, kind: 'calendar-invitation', bookingConfirmed: true });
check('a calendar-owned notification cannot be texted', notOurs.ok === false);
const unknown = await claimRequestText({ requestId: RQ2, kind: 'anything-at-all', bookingConfirmed: true });
check('an unplanned kind is refused', unknown.ok === false);
const noId = await claimRequestText({ kind: TEXTABLE_KINDS[0], bookingConfirmed: true });
check('no request id is refused', noId.ok === false,
  'an uncounted text is an uncapped text');

section('P4c2  only a CONFIRMED appointment gets reminders');
const RQ3 = `rq_${Math.random().toString(36).slice(2, 8)}`;
for (const kind of ['reminder-24h', 'reminder-1h', 'booking-confirmation', 'reschedule-or-cancel', 'no-show-followup']) {
  const r = await claimRequestText({ requestId: RQ3, kind, bookingConfirmed: false });
  check(`"${kind}" is refused when nothing was booked`, r.ok === false && r.needsBooking === true, JSON.stringify(r));
}
const unknownBooking = await claimRequestText({ requestId: RQ3, kind: 'reminder-24h' });
check('and refused when we cannot say whether it was booked',
  unknownBooking.ok === false && unknownBooking.needsBooking === true,
  'a missing answer must not read as "yes"');
check('the refusal says why it matters',
  /clear the time for it/i.test(unknownBooking.reason), unknownBooking.reason);
// The texts that make sense for an unbooked REQUEST still do.
const stillFine = await claimRequestText({ requestId: RQ3, kind: 'preview-ready', bookingConfirmed: false });
check('NEGATIVE CONTROL: a preview-ready text does not need an appointment', stillFine.ok === true, JSON.stringify(stillFine));
const withBooking = await claimRequestText({ requestId: RQ3, kind: 'reminder-24h', bookingConfirmed: true });
check('NEGATIVE CONTROL: with a confirmed booking the reminder is allowed', withBooking.ok === true, JSON.stringify(withBooking));

const ledger = await requestTextLedger(RQ);
check('the ledger reports the allowance spent', ledger.used === MAX_REQUEST_TEXTS && ledger.remaining === 0);

section('P4d  a store outage must not make texting easier');
const realIncr = store.incr;
store.incr = async () => { throw new Error('kv down'); };
const duringOutage = await claimRequestText({ requestId: `rq_out_${Date.now()}`, kind: TEXTABLE_KINDS[1], bookingConfirmed: true });
store.incr = realIncr;
check('the allowance fails CLOSED when the counter cannot be read',
  duringOutage.ok === false && duringOutage.retryable === true,
  'if an outage let messages through uncounted, the quoted maximum would be fiction');

// ---------------------------------------------------------------------------
section('P5  website entry is validated as a string and never fetched');
check('a plain domain is accepted and normalised',
  checkWebsite('example.com').url === 'https://example.com');
check('an existing scheme is kept', checkWebsite('http://example.com/x/').url === 'http://example.com/x');
check('nothing given is fine', checkWebsite('').ok === true && checkWebsite('').url === null,
  'an inbound person without a website may still ask for help');
check('localhost is refused', checkWebsite('http://localhost:3000').ok === false);
check('a bare IP is refused', checkWebsite('http://169.254.169.254/latest/meta-data').ok === false,
  'a public endpoint that fetches whatever a stranger types is how an internal address gets read');
check('an internal suffix is refused', checkWebsite('http://db.internal').ok === false);
check('a non-web scheme is refused', checkWebsite('file:///etc/passwd').ok === false);
check('nonsense is refused with a readable reason',
  checkWebsite('not a website').ok === false && /web address/i.test(checkWebsite('not a website').reason));

section('P5b  a typed URL is NEVER labelled verified');
check('a perfectly valid URL still comes back unverified',
  checkWebsite('https://realbusiness.example').verified === false,
  'the owner was explicit: do not label an unverified listing link as a verified website');
check('and says why', /not yet checked/i.test(checkWebsite('https://realbusiness.example').note));

// ---------------------------------------------------------------------------
section('P6  prefill carries business details and never personal ones');
const pf = await makePrefill({ businessName: 'Acme Roofing', website: 'https://acme.example', sourceRef: 'qr-booth-3' });
const read = await readPrefill(pf.ref);
check('business name comes back', read.prefill.businessName === 'Acme Roofing');
check('the website comes back', read.prefill.website === 'https://acme.example');
check('the source attribution is preserved', read.sourceRef === 'qr-booth-3',
  'a QR code, a networking event and a cold email must stay distinguishable');
check('no name is returned', read.prefill.name === undefined);
check('no email is returned', read.prefill.email === undefined);
check('no phone is returned', read.prefill.phone === undefined,
  'a forwarded link must not hand somebody else\'s details to whoever opens it');
check('a guessed reference returns nothing', (await readPrefill('pf_zzzzzzzzzz')).prefill === null);
check('a malformed reference is rejected outright', (await readPrefill('../../etc')).ok === false);

// ---------------------------------------------------------------------------
section('P7  submission: bad input keeps the visitor\'s typing');
const bad = await submitRequest({ name: '', businessName: '', email: 'nope', website: 'http://localhost' });
check('it is refused', bad.ok === false);
check('errors are per-field, so the page can point at them',
  !!bad.fieldErrors.name && !!bad.fieldErrors.businessName && !!bad.fieldErrors.email && !!bad.fieldErrors.website,
  JSON.stringify(bad.fieldErrors));
check('the errors are in plain language',
  !/regex|invalid|400|ERR_/i.test(JSON.stringify(bad.fieldErrors)), JSON.stringify(bad.fieldErrors));
check('nothing was created', bad.contactId === undefined && bad.booking === undefined);

// ---------------------------------------------------------------------------
section('P8  with no calendar connected: a REQUEST, never a confirmation');
await saveRules({ ...DEFAULT_RULES });
const envBefore = { ...process.env };
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.GOOGLE_CLIENT_SECRET;
delete process.env.GOOGLE_REFRESH_TOKEN;

const noCal = await submitRequest({
  name: 'Dana Example', businessName: 'Example Supply Co', email: 'dana@example.test',
  phone: '+15557770101', website: 'example.test', timezone: 'America/Chicago',
  startAt: Date.now() + 3 * 86400e3, minutes: 30, smsOptIn: false, willAttend: true,
});
check('the submission is accepted', noCal.ok === true, JSON.stringify(noCal).slice(0, 300));
check('but the state is call-requested, NOT booked', noCal.state === REQUEST_STATE.CALL_REQUESTED,
  'with no calendar there is no appointment to confirm');
check('no booking object is returned', noCal.booking === null);
check('and the message says the appointment is not confirmed',
  /NOT yet confirmed/i.test(noCal.message), noCal.message);

section('P8b  the attendance tick is an acknowledgment, never attendance');
check('it is recorded', noCal.attendance.acknowledged === true);
check('and labelled as not being evidence of attendance',
  /NOT attendance/i.test(noCal.attendance.meaning), JSON.stringify(noCal.attendance));
check('it did not touch SMS eligibility', noCal.consent.sms === 'not requested',
  'ticking "I plan to attend" must never enrol anybody in texts');

section('P8c  a phone number alone is not SMS permission');
check('the phone was taken but consent was not granted', noCal.consent.sms === 'not requested');
// Negative control: asking for SMS reaches a PENDING state and no further.
const withSms = await submitRequest({
  name: 'Lee Example', businessName: 'Lee Tools', email: 'lee@example.test',
  phone: '+15557770142', timezone: 'America/Chicago', smsOptIn: true, willAttend: false,
});
check('asking for texts is recorded', withSms.ok === true);
check('but only as PENDING handset confirmation',
  withSms.consent.sms === 'pending-handset-confirmation' || withSms.consent.sms === 'refused',
  JSON.stringify(withSms.consent));
check('and it is NOT a granted promotional consent',
  withSms.consent.sms !== 'granted' && withSms.consent.sms !== true,
  'a web form cannot supply the handset confirmation the campaign requires');
check('booking did not depend on it', withSms.state === REQUEST_STATE.CALL_REQUESTED,
  'the SMS answer must not change whether the request goes through');

section('P8c2  a failed booking KEEPS the request');
// The calendar refusing is our problem, not theirs, and they have already typed
// everything we need. Discarding it would make a person who wanted a preview
// find the page again and start over, because of a failure on our side.
// Driven through the REAL Google adapter rather than a stubbed scheduler: the
// credentials are present so it is genuinely connected, and only the network
// is faked. The token call succeeds and free/busy fails, which is the adapter's
// generic refusal — neither "taken" nor "uncertain", both handled above.
const savedEnv = {
  id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET, refresh: process.env.GOOGLE_REFRESH_TOKEN,
};
process.env.GOOGLE_CLIENT_ID = 'fake-id';
process.env.GOOGLE_CLIENT_SECRET = 'fake-secret';
process.env.GOOGLE_REFRESH_TOKEN = 'fake-refresh';
const savedFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/oauth2/.test(u)) {
    const body = { access_token: 'fake-token', expires_in: 3600 };
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }
  // free/busy is down, so the slot cannot be re-checked and nothing is booked
  return { ok: false, status: 503, json: async () => ({}), text: async () => 'unavailable' };
};
const failed = await submitRequest({
  name: 'Kit Example', businessName: 'Kit Cabinets', email: 'kit@example.test',
  phone: '+15557770177', timezone: 'America/Chicago',
  startAt: Date.now() + 5 * 86400e3, minutes: 30, willAttend: true,
});
globalThis.fetch = savedFetch;
if (savedEnv.id === undefined) delete process.env.GOOGLE_CLIENT_ID; else process.env.GOOGLE_CLIENT_ID = savedEnv.id;
if (savedEnv.secret === undefined) delete process.env.GOOGLE_CLIENT_SECRET; else process.env.GOOGLE_CLIENT_SECRET = savedEnv.secret;
if (savedEnv.refresh === undefined) delete process.env.GOOGLE_REFRESH_TOKEN; else process.env.GOOGLE_REFRESH_TOKEN = savedEnv.refresh;

check('the request is NOT thrown away', failed.ok === true, JSON.stringify(failed).slice(0, 220));
check('a contact was still created', !!failed.contactId);
check('and a preview task was still created', !!failed.previewTaskId,
  'the work they asked for is the point; the calendar is an implementation detail to them');
check('but it is a call request, not a confirmed appointment',
  failed.state === REQUEST_STATE.CALL_REQUESTED && failed.booking === null);
check('the failure is named for the owner', !!failed.bookingFailed, String(failed.bookingFailed));
check('and the message tells them plainly it is not confirmed',
  /NOT yet confirmed/.test(failed.message), failed.message);
check('without claiming a time was booked',
  !/confirmed\./i.test(failed.message.split('NOT')[0]), failed.message);

section('P8d  the same submission twice is one submission');
const first = await submitRequest({
  name: 'Robin Example', businessName: 'Robin Signs', email: 'robin@example.test',
  timezone: 'America/Chicago', startAt: 1790000000000,
});
const second = await submitRequest({
  name: 'Robin Example', businessName: 'Robin Signs', email: 'robin@example.test',
  timezone: 'America/Chicago', startAt: 1790000000000,
});
check('the second is recognised as the same', second.duplicate === true,
  'a double-click, a flaky connection and a retried POST are indistinguishable from here');
check('and returns the first result', second.contactId === first.contactId);
// Negative control: a genuinely different submission must NOT be deduplicated.
const other = await submitRequest({
  name: 'Robin Example', businessName: 'Robin Signs', email: 'robin@example.test',
  timezone: 'America/Chicago', startAt: 1790003600000,
});
check('a different TIME is a different submission', other.duplicate !== true,
  'negative control — proves the dedupe is keyed on the submission, not on the person');

Object.assign(process.env, envBefore);

// ---------------------------------------------------------------------------
section('P9  the page shows a confirmation only after the provider confirms');
check('the confirmation branch is gated on ok AND a booking object',
  /j\.state === 'booked' \? 'Your call is confirmed\.' : 'We have your request\.'/.test(HTML),
  'the two outcomes must render differently, or a request reads as an appointment');
check('a submission alone never prints "confirmed"',
  !/>\s*Your call is confirmed/.test(HTML),
  'the confirmed wording exists only inside the branch that saw a provider confirmation');
check('an uncertain result disables the button rather than inviting a retry',
  /uncertain[\s\S]{0,400}disabled = true/.test(HTML),
  'retrying an uncertain booking is how one person ends up with two appointments');
check('a taken slot reloads real times instead of guessing',
  /slotTaken[\s\S]{0,200}loadSlots\(\)/.test(HTML));
check('no path clears the form on failure',
  !/\.value\s*=\s*''/.test(HTML) && !/\.reset\(\)/.test(HTML),
  'an accessible error does not delete what was entered');

section('P9b  disconnected scheduling is shown as disconnected');
check('the page has a not-live branch', /Online booking is not available right now/.test(HTML));
check('which says the appointment is not confirmed',
  /will not be confirmed until we reply/i.test(HTML));
check('and changes the button away from "Schedule"',
  /Request my preview call/.test(HTML),
  'a button that says Schedule when nothing can be scheduled is the lie');

section('P9c  accessibility and touch targets');
check('every field has a label element', (HTML.match(/<label class="f"/g) || []).length >= 5);
check('the live region announces the result', /aria-live="polite"/.test(HTML));
check('focus-visible is styled, not removed',
  /focus-visible\{outline:2px/.test(HTML.replace(/\s/g, '')) || /:focus-visible/.test(HTML));
check('no transition-all', !/transition-all/.test(HTML));
check('inputs meet a 44px-ish touch target', /min-height:46px/.test(HTML));
check('the viewport is mobile-first', /width=device-width/.test(HTML));

section('P9d  times are rendered in the VISITOR\'s timezone');
check('the timezone is read from the browser',
  /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/.test(HTML));
check('and sent to the server with the request', /timezone: TZ/.test(HTML));
check('the chosen slot shows date, time, duration and zone together',
  /fmtDay\(chosen\.startAt\)[\s\S]{0,120}fmtTime\(chosen\.startAt\)[\s\S]{0,200}TZ/.test(HTML),
  'the attendance tick has to sit beside the exact appointment it acknowledges');
check('an introductory call is labelled as one',
  /introductory call/i.test(HTML),
  'preview timing must be honest: a call sooner than the build lead time is not a walkthrough');

section('P9d2  the day picker shows fewer times, never different ones');
check('days are built from the server\'s slots only',
  /for \(const s of SLOTS\)[\s\S]{0,260}DAYS\.push/.test(HTML),
  'grouping must not be able to introduce a time the server did not offer');
check('every rendered time comes from the chosen day\'s own slots',
  /day\.slots\.map\(\(s\) => '<label class="slot">'/.test(HTML));
check('the radio value is the real instant', /value="' \+ s\.startAt \+ '"/.test(HTML));
check('a selected time survives switching days',
  /chosen && chosen\.startAt === s\.startAt \? ' checked' : ''/.test(HTML),
  're-rendering the list must not silently drop what they already picked');
check('the introductory warning is still shown, once per day',
  /anyIntro \? '<p class="daynote">/.test(HTML),
  'moving it off every row must not be how it disappears');
check('day buttons report their state to assistive tech', /aria-pressed="/.test(HTML));
check('the day strip is labelled', /aria-label="Choose a day"/.test(HTML));

section('P9e  rescheduling is offered, not buried');
check('the confirmation carries a reschedule link', /Reschedule or cancel/.test(HTML));
check('the attendance line points at it',
  /I'll use the reschedule link|I’ll use the reschedule link/.test(HTML));

// ---------------------------------------------------------------------------
section('P9f  the slot, the event and the confirmation agree about the kind');
// Found in a browser, not in a unit test: the slot card said "introductory —
// your preview may not be built yet" and the confirmation said "we will have
// your preview ready to walk through", because three modules spelled the kind
// three ways and the comparison silently never matched.
const { SLOT_KIND, SLOT_KIND_LABEL, candidateSlots: cs, DEFAULT_RULES: DR } = await import('../lib/scheduling.js');
const schedGoogleSrc = await readFile(new URL('../lib/scheduling-google.js', import.meta.url), 'utf8');
const requestSrc = await readFile(new URL('../lib/preview-request.js', import.meta.url), 'utf8');

const slotKinds = new Set(cs({ ...DR }, { now: Date.UTC(2026, 9, 12, 14, 0, 0) }).map((s) => s.kind));
check('the slot list only ever emits the shared kinds',
  [...slotKinds].every((k) => Object.values(SLOT_KIND).includes(k)), [...slotKinds].join(', '));
check('both kinds are actually produced', slotKinds.size === 2,
  'if only one appears the distinction is not being made at all');
check('the booking adapter uses the constants, not its own literals',
  /SLOT_KIND\.(WALKTHROUGH|INTRODUCTORY)/.test(schedGoogleSrc)
  && !/'introductory call'|'preview walkthrough'/.test(schedGoogleSrc), 'lib/scheduling-google.js');
const { confirmationMessage } = await import('../lib/preview-request.js');
check('a walkthrough slot promises a walkthrough',
  /walk through/i.test(confirmationMessage(REQUEST_STATE.BOOKED, SLOT_KIND.WALKTHROUGH)));
check('an introductory slot does NOT promise one',
  /may not be built yet/i.test(confirmationMessage(REQUEST_STATE.BOOKED, SLOT_KIND.INTRODUCTORY))
  && !/walk through/i.test(confirmationMessage(REQUEST_STATE.BOOKED, SLOT_KIND.INTRODUCTORY)),
  confirmationMessage(REQUEST_STATE.BOOKED, SLOT_KIND.INTRODUCTORY));
// The actual regression: a kind nobody recognises must not fall into the
// confident sentence.
for (const bogus of ['introductory call', 'preview walkthrough', undefined, null, '']) {
  check(`an unrecognised kind (${JSON.stringify(bogus)}) gets the cautious wording`,
    !/walk through/i.test(confirmationMessage(REQUEST_STATE.BOOKED, bogus)),
    confirmationMessage(REQUEST_STATE.BOOKED, bogus));
}
check('and with nothing booked it says so outright',
  /NOT yet confirmed/.test(confirmationMessage(REQUEST_STATE.CALL_REQUESTED, SLOT_KIND.WALKTHROUGH)),
  'the kind must never upgrade a request into a confirmation');
check('the confirmation is built by that one function, not inline',
  /confirmationMessage\(state, booking\?\.kind\)/.test(requestSrc), 'lib/preview-request.js');
// Counted in CODE only. A comment quoting the sentence is documentation, not a
// second place it can be produced — and an earlier version of this check read
// its own prose and failed.
const requestCode = requestSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
check('and the walkthrough promise is produced in ONLY one place',
  (requestCode.match(/ready to walk through/g) || []).length === 1,
  'a second copy of that sentence is a second place it can be wrong');
check('the page renders the same vocabulary',
  HTML.includes("s.kind === 'introductory'") && SLOT_KIND.INTRODUCTORY === 'introductory');
check('every kind has a human label', Object.values(SLOT_KIND).every((k) => !!SLOT_KIND_LABEL[k]));

// ---------------------------------------------------------------------------
section('P10  the preview task states the owner asked for');
const { PREVIEW_STATE, STATE_LABEL, createTask, setState, getTask, queue, stats } = await import('../lib/previews.js');
for (const s of ['requested', 'researching', 'building', 'review', 'ready', 'blocked']) {
  check(`"${s}" exists as a state`, Object.values(PREVIEW_STATE).includes(s));
  check(`and reads in plain language: "${STATE_LABEL[s]}"`,
    !!STATE_LABEL[s] && STATE_LABEL[s] !== s && !/[-_]/.test(STATE_LABEL[s]));
}

section('P10b  READY requires a real URL *and* a review');
const t = (await createTask({ contactId: 'c_p10', businessName: 'Tenth Street Tyres', requestedVia: 'test' })).task;
check('a new task starts as requested', t.state === PREVIEW_STATE.REQUESTED);
check('requested cannot jump to ready', (await setState(t.id, PREVIEW_STATE.READY, { url: 'https://p.example/x' })).ok === false);
await setState(t.id, PREVIEW_STATE.RESEARCHING);
await setState(t.id, PREVIEW_STATE.BUILDING);
const builtNotReviewed = await setState(t.id, PREVIEW_STATE.READY, { url: 'https://p.example/x' });
check('a built preview with a real URL is not ready until reviewed', builtNotReviewed.ok === false,
  JSON.stringify(builtNotReviewed).slice(0, 180));
check('and the refusal names review', /review/i.test(builtNotReviewed.error), builtNotReviewed.error);
await setState(t.id, PREVIEW_STATE.REVIEW);
check('review without a URL is still not ready', (await setState(t.id, PREVIEW_STATE.READY)).ok === false,
  'the other half of the requirement: a review of nothing is not a review');
const nowReady = await setState(t.id, PREVIEW_STATE.READY, { url: 'https://p.example/x' });
check('reviewed AND with a URL, it is ready', nowReady.ok === true, JSON.stringify(nowReady).slice(0, 160));
check('and records who reviewed it', !!nowReady.task.reviewedBy);

section('P10c  blocked has to say what it is blocked on');
const t2 = (await createTask({ contactId: 'c_p10b', businessName: 'Blocked Co', requestedVia: 'test' })).task;
check('blocking with no reason is refused', (await setState(t2.id, PREVIEW_STATE.BLOCKED)).ok === false,
  'a blocked task with no reason is one nobody can unblock');
const blocked = await setState(t2.id, PREVIEW_STATE.BLOCKED, { note: 'waiting on their logo files' });
check('with a reason it blocks', blocked.ok === true, JSON.stringify(blocked).slice(0, 140));
check('and the reason is kept', /logo files/.test(blocked.task.blockedReason));
const unblocked = await setState(t2.id, PREVIEW_STATE.RESEARCHING);
check('unblocking returns it to a working stage', unblocked.ok === true);
check('and clears the stale reason', !unblocked.task.blockedReason,
  'a resolved blocker left on the record reads as still blocked');

section('P10d  blocked work surfaces instead of sinking');
await setState(t2.id, PREVIEW_STATE.BLOCKED, { note: 'waiting on their logo files' });
const q = await queue({ limit: 200 });
const firstBlockedAt = (q.tasks || []).findIndex((x) => x.state === PREVIEW_STATE.BLOCKED);
const firstMovingAt = (q.tasks || []).findIndex((x) => x.state !== PREVIEW_STATE.BLOCKED);
check('blocked tasks sort above the work that is moving',
  firstBlockedAt >= 0 && (firstMovingAt === -1 || firstBlockedAt < firstMovingAt),
  `blocked at ${firstBlockedAt}, moving at ${firstMovingAt}`);
const st = await stats();
check('the counts separate blocked from in-flight', typeof st.blocked === 'number' && st.blocked >= 1, JSON.stringify(st));
check('and a blocked promise still counts as a promise not kept', st.brokenPromises >= st.blocked, JSON.stringify(st));

done();
