// One submission: a contact, a booking, a preview task — and nothing invented.
//
// R19.3/R19.4. This is the only place the public form can write, so it is the
// only place that has to get the ordering right.
//
// THE ORDER, and why each step is where it is:
//
//  1. VALIDATE. A bad email or an unfetchable URL is told to the visitor with
//     their typing intact. Nothing is created.
//  2. DEDUPLICATE. A double-click, a flaky connection and a retried POST all
//     look identical from here, so the same submission within a short window
//     returns the FIRST result rather than making a second booking.
//  3. BOOK FIRST, THEN RECORD. A booking can fail — the slot goes, the provider
//     refuses, the calendar stops answering. Creating the contact and the
//     preview task first would leave a task for a call that does not exist.
//     Contact and task are only written once the provider has confirmed.
//  4. NEVER OVERWRITE CONSENT OR SUPPRESSION. The contact is merged, not
//     replaced. Someone who opted out last month and fills this form in today
//     has asked for a preview; they have not un-asked to be left alone.
//
// AND THE ONE THING A FORM MUST NOT DO: entering a phone number is not SMS
// permission. The optional checkbox creates a PENDING record and nothing else.
// Promotional permission still requires the handset confirmation that
// lib/optin-public.js already enforces, and booking never depends on it.

import { store } from './store.js';
import { SLOT_KIND } from './scheduling.js';

export const REQUEST_STATE = Object.freeze({
  BOOKED: 'booked',
  CALL_REQUESTED: 'call-requested',   // no calendar connected — a request, not an appointment
});

const reqKey = (id) => `preq:${id}`;
const dedupeKey = (fp) => `preq:fp:${fp}`;
const prefillKey = (ref) => `preq:prefill:${ref}`;

/** Cheap, stable fingerprint of one submission. Not a secret, never shown. */
function fingerprint(b) {
  const parts = [
    String(b.email || '').trim().toLowerCase(),
    String(b.startAt || ''),
    String(b.businessName || '').trim().toLowerCase(),
  ].join('|');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) h = ((h * 33) ^ parts.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * What we tell them, given what actually happened.
 *
 * Pulled out as its own function because it is the sentence most able to be
 * wrong: it is the only place the product promises a timing. The confident
 * wording — "we will have your preview ready to walk through" — is the MATCHED
 * branch, so an unrecognised kind produces the careful sentence instead of the
 * confident one. A browser check found this inverted once, when the slot card
 * and this comparison used two spellings of the same kind.
 */
export function confirmationMessage(state, kind) {
  if (state !== REQUEST_STATE.BOOKED) {
    return 'We have your request. Your appointment is NOT yet confirmed — we will email you with times.';
  }
  if (kind === SLOT_KIND.WALKTHROUGH) {
    return 'Your call is confirmed. We will have your preview ready to walk through.';
  }
  return 'Your call is confirmed. It is an introductory call — your preview may not be built yet, and we will send it as soon as it is ready.';
}

/**
 * Is this a website we could safely look at later?
 *
 * Validated as a STRING here and never fetched during the request. Fetching a
 * URL a stranger typed, from our server, on a public endpoint, is how an
 * open-redirect turns into a request to an internal address. The research step
 * does the fetching later, under its own rules.
 */
export function checkWebsite(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, url: null, verified: false, note: 'no website given' };
  let u;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return { ok: false, reason: 'that does not look like a web address' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, reason: 'only web addresses are accepted' };
  }
  const host = u.hostname.toLowerCase();
  // Anything that could point back inside our own network is refused outright.
  if (
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')
    || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
  ) {
    return { ok: false, reason: 'that address cannot be checked' };
  }
  if (!/\.[a-z]{2,}$/i.test(host)) return { ok: false, reason: 'that does not look like a web address' };
  return {
    ok: true,
    url: `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, '')}`,
    // NOT verified. The visitor typing it proves they typed it. Verification is
    // a separate step that actually loads the site, and labelling this verified
    // would put an unchecked claim into the outbound segment.
    verified: false,
    note: 'given by the visitor; not yet checked',
  };
}

/** Store a business-level prefill under an opaque reference. */
export async function makePrefill({ businessName = '', website = '', sourceRef = '' } = {}) {
  const ref = `pf_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
  await store.set(prefillKey(ref), JSON.stringify({
    businessName: String(businessName).slice(0, 120),
    website: String(website).slice(0, 200),
    sourceRef: String(sourceRef).slice(0, 60),
  }), { ex: 60 * 60 * 24 * 60 }).catch(() => {});
  return { ok: true, ref };
}

/**
 * Read a prefill. BUSINESS fields only.
 *
 * Deliberately never returns a name, email or phone, even though the CRM knows
 * them: a link that is forwarded, posted or guessed would otherwise hand
 * somebody else's personal details to whoever opened it.
 */
export async function readPrefill(ref) {
  if (!/^pf_[a-z0-9]{6,20}$/i.test(String(ref || ''))) return { ok: false, prefill: null };
  const raw = await store.get(prefillKey(ref)).catch(() => null);
  if (!raw) return { ok: false, prefill: null };
  try {
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { ok: true, prefill: { businessName: p.businessName || '', website: p.website || '' }, sourceRef: p.sourceRef || null };
  } catch {
    return { ok: false, prefill: null };
  }
}

/**
 * The whole submission.
 *
 * Returns `{ ok, state, booking?, previewTask?, consent }` or a refusal that
 * the page can render beside the field that caused it.
 */
export async function submitRequest(body = {}, { ip = '', now = Date.now() } = {}) {
  const name = String(body.name || '').trim().slice(0, 80);
  const businessName = String(body.businessName || '').trim().slice(0, 120);
  const email = String(body.email || '').trim().slice(0, 160);
  const phone = String(body.phone || '').trim().slice(0, 40);
  const notes = String(body.notes || '').trim().slice(0, 600);
  const timezone = String(body.timezone || '').trim().slice(0, 60) || 'America/Chicago';
  const wantsSms = body.smsOptIn === true;
  const willAttend = body.willAttend === true;
  const startAt = Number(body.startAt) || null;

  // ---- 1. validate, naming the field so the page can point at it -----------
  const fieldErrors = {};
  if (!name) fieldErrors.name = 'Please tell us your name.';
  if (!businessName) fieldErrors.businessName = 'Please tell us your business name.';
  if (!EMAIL_RE.test(email)) fieldErrors.email = 'Please check that email address.';
  const site = checkWebsite(body.website);
  if (!site.ok) fieldErrors.website = site.reason;
  if (Object.keys(fieldErrors).length) {
    return { ok: false, status: 400, fieldErrors, error: 'Please check the highlighted fields.' };
  }

  // ---- 2. the same submission twice is one submission ----------------------
  const fp = fingerprint({ email, startAt, businessName });
  const seen = await store.get(dedupeKey(fp)).catch(() => null);
  if (seen) {
    try {
      const prev = typeof seen === 'string' ? JSON.parse(seen) : seen;
      return { ...prev, ok: true, duplicate: true };
    } catch { /* fall through and treat as new */ }
  }

  // R19.7 — they sent their details. This is its OWN funnel event and is never
  // a booking: most of the value of measuring the funnel is being able to see
  // the gap between this number and the next one.
  const { record: funnel, FUNNEL } = await import('./funnel.js');
  await funnel(FUNNEL.SUBMITTED, { requestId: fp, at: now });

  // ---- 3. book BEFORE recording anything ----------------------------------
  const { getScheduler } = await import('./scheduling.js');
  const sched = await getScheduler({ now });
  let booking = null;
  let state = REQUEST_STATE.CALL_REQUESTED;
  // Set when a connected calendar was asked and could not book. The request is
  // still kept; this is what makes the answer say so rather than pretend the
  // visitor never chose a time.
  let bookingFailed = null;

  if (startAt && sched.connected) {
    const res = await sched.book({
      startAt, minutes: Number(body.minutes) || undefined,
      name, email, businessName, website: site.url, notes, timezone,
      sourceRef: String(body.sourceRef || '').slice(0, 60),
    });
    if (res.ok) {
      booking = res;
      state = REQUEST_STATE.BOOKED;
      // Only here, and only with the provider's own id. `record` refuses it
      // without one, which is what stops a submission ever counting as a
      // booking.
      await funnel(FUNNEL.BOOKED, { requestId: fp, at: now, providerId: res.providerId });
    } else if (res.taken) {
      // The visitor's typing is NOT discarded — the page re-offers real times
      // and keeps everything they entered.
      return { ok: false, status: 409, slotTaken: true, error: 'That time was taken a moment ago. Here are the next available times.', keepInput: true };
    } else if (res.uncertain) {
      // Reconcile before anything else. A retry here could create a second
      // appointment, so the request is parked and a person checks.
      const id = `pr_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      await store.set(reqKey(id), JSON.stringify({
        id, at: now, state: 'uncertain', name, businessName, email, phone,
        website: site.url, notes, timezone, startAt, needsReconciliation: true,
      }), { ex: 60 * 60 * 24 * 30 }).catch(() => {});
      return {
        ok: false, status: 202, uncertain: true, requestId: id,
        error: 'We could not confirm that time with the calendar. We have your request and will confirm by email — please do not submit again.',
        keepInput: true,
      };
    } else {
      // KEEP THE REQUEST. The calendar refused or would not answer, which is
      // our problem, not theirs — and they have already typed everything we
      // need. Discarding it would mean a person who wanted a preview has to
      // find the page again and start over, for a failure on our side.
      //
      // It falls through to the recording below as a CALL REQUEST, so the
      // contact, the consent choice and the preview task are all created. The
      // one thing it does NOT become is a confirmed appointment.
      bookingFailed = res.reason || 'the calendar did not answer';
    }
  }

  // ---- 4. now record: contact, consent, preview task -----------------------
  const { upsertContact, field } = await import('./contacts.js');
  const up = await upsertContact({
    name: field(name, { confidence: 1, source: 'preview-request' }),
    businessName: field(businessName, { confidence: 1, source: 'preview-request' }),
    email: field(email, { confidence: 1, source: 'preview-request' }),
    ...(phone ? { phone: field(phone, { confidence: 1, source: 'preview-request' }) } : {}),
    ...(site.url ? { website: field(site.url, { confidence: 1, source: 'preview-request' }) } : {}),
    source: 'preview_request',
    // Attribution survives, so the owner can tell a QR code from a networking
    // follow-up from a cold email months later.
    event: String(body.sourceRef || '').slice(0, 60) || null,
    // NOTE: no consentLog here. `upsertContact` merges, so an existing
    // suppression or consent record is untouched — asking for a preview is not
    // un-asking to be left alone.
  });
  const contactId = up?.contact?.id || up?.id || null;

  // The optional SMS choice: a PENDING record and nothing more. Promotional
  // permission still needs the handset confirmation, and booking never waited
  // for it.
  let consent = { sms: 'not requested' };
  if (wantsSms && phone) {
    try {
      const { recordWebOptIn } = await import('./optin-public.js');
      const r = await recordWebOptIn({
        phone, agreed: true, name,
        pageUrl: 'preview-request-form',
        business: 'Inspiring Websites',
      });
      consent = r.ok
        ? { sms: 'pending-handset-confirmation', confirmBy: r.confirmBy }
        : { sms: 'refused', why: r.error };
    } catch {
      consent = { sms: 'not recorded' };
    }
  }

  // The attendance tick is an acknowledgment. Stored as its own fact so nothing
  // can later read it as evidence that they turned up.
  const attendance = willAttend
    ? { acknowledged: true, at: now, meaning: 'They said they plan to attend. This is NOT attendance.' }
    : { acknowledged: false };
  // R19.7 — recorded as RECONFIRMED. `funnel.record` will not accept ATTENDED
  // without somebody having observed it, so a ticked box cannot become one.
  if (willAttend) await funnel(FUNNEL.RECONFIRMED, { requestId: fp, contactId, at: now });

  // ---- the preview production task ----------------------------------------
  let previewTask = null;
  try {
    const { createTask } = await import('./previews.js');
    const made = await createTask({
      contactId,
      businessName,
      website: site.url || '',
      conversationNotes: notes,
      requestedVia: String(body.sourceRef || 'preview request form').slice(0, 80),
      promisedBy: booking?.startAt || null,
    });
    previewTask = made?.task || null;
  } catch { /* the booking stands even if the task could not be written */ }

  const result = {
    ok: true,
    state,
    contactId,
    booking: booking ? {
      providerId: booking.providerId,
      startAt: booking.startAt,
      minutes: booking.minutes,
      kind: booking.kind,
      meetingUrl: booking.meetingUrl || null,
      manageUrl: booking.htmlLink || null,
    } : null,
    previewTaskId: previewTask?.id || null,
    consent,
    attendance,
    // Named, so the owner's screen can tell "no calendar connected" apart from
    // "the calendar refused this person's booking a minute ago".
    bookingFailed,
    // Said plainly so the page cannot imply more than happened.
    message: bookingFailed
      ? 'We have your request, and the time you chose. Your appointment is NOT yet confirmed — our calendar did not answer, and we will email you to confirm it.'
      : confirmationMessage(state, booking?.kind),
  };

  await store.set(dedupeKey(fp), JSON.stringify(result), { ex: 60 * 30 }).catch(() => {});
  return result;
}
