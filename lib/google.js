// Google OAuth (installed-app flow, long-lived refresh token) — reads Mondo's
// own Info@ inbox and writes to his own Calendar. Never touches a client's
// Google account. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1';
const CAL = 'https://www.googleapis.com/calendar/v3';

export function googleConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REFRESH_TOKEN);
}

let cached = null; // access token cache — lives only as long as this warm function instance
async function accessToken() {
  if (cached && cached.exp > Date.now() + 30000) return cached.token;
  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('google token refresh failed: ' + (j.error_description || j.error || r.status));
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3500) * 1000 };
  return cached.token;
}

async function gcall(url, opts = {}) {
  const token = await accessToken();
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  const text = await r.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!r.ok) throw new Error(`google ${r.status}: ${(body && body.error && body.error.message) || String(body).slice(0, 150)}`);
  return body;
}

function b64url(s) {
  return Buffer.from(s, 'base64').toString('utf8');
}
function decodeBody(payload) {
  function walk(p) {
    if (!p) return '';
    if (p.mimeType === 'text/plain' && p.body?.data) return b64url(p.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    if (p.parts) {
      for (const part of p.parts) {
        const t = walk(part);
        if (t) return t;
      }
    }
    if (p.mimeType === 'text/html' && p.body?.data) return b64url(p.body.data.replace(/-/g, '+').replace(/_/g, '/')).replace(/<[^>]+>/g, ' ');
    return '';
  }
  return walk(payload).replace(/\s+/g, ' ').trim().slice(0, 14000);
}

// New inbox mail since `sinceDateStr` (Gmail date query, YYYY/MM/DD), skipping
// anything already labeled processed. Coarse day-level filter — the label is
// the real once-only guarantee.
// one full message (headers, text body, attachments with a fetch())
export async function getMessageById(id) {
  const msg = await gcall(`${GMAIL}/users/me/messages/${id}?format=full`);
  const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
  return {
    id: msg.id,
    threadId: msg.threadId,
    from: headers.from || '',
    subject: headers.subject || '(no subject)',
    messageIdHeader: headers['message-id'] || '',
    snippet: msg.snippet || '',
    body: decodeBody(msg.payload),
    attachments: listAttachments(msg.payload).map((a) => ({ ...a, fetch: () => getAttachment(msg.id, a) })),
  };
}

export async function listNewMail(sinceDateStr) {
  const q = `in:inbox after:${sinceDateStr} -label:iw-processed`;
  const list = await gcall(`${GMAIL}/users/me/messages?q=${encodeURIComponent(q)}&maxResults=25`);
  const ids = (list.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) out.push(await getMessageById(id));
  return out;
}

// files attached to a message (name, type, size, and where to download them)
function listAttachments(payload) {
  const found = [];
  (function walk(p) {
    if (!p) return;
    if (p.filename && (p.body?.attachmentId || p.body?.data)) found.push({ filename: p.filename, mimeType: p.mimeType || '', size: p.body.size || 0, attachmentId: p.body.attachmentId || null, inline: p.body.data || null });
    (p.parts || []).forEach(walk);
  })(payload);
  return found;
}
async function getAttachment(messageId, a) {
  let data = a.inline;
  if (!data) data = (await gcall(`${GMAIL}/users/me/messages/${messageId}/attachments/${a.attachmentId}`)).data;
  return Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

// Puts already-handled mail back in the queue (removes the "processed" label) so
// a message that was wrongly dropped can be picked up again. `q` narrows it.
export async function unlabelProcessed(q = '', { days = 14 } = {}) {
  const labels = await gcall(`${GMAIL}/users/me/labels`);
  const label = (labels.labels || []).find((l) => l.name === 'iw-processed');
  if (!label) return 0;
  const query = `in:inbox label:iw-processed newer_than:${days}d ${q}`.trim();
  const list = await gcall(`${GMAIL}/users/me/messages?q=${encodeURIComponent(query)}&maxResults=25`);
  const ids = (list.messages || []).map((m) => m.id);
  for (const id of ids) {
    await gcall(`${GMAIL}/users/me/messages/${id}/modify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ removeLabelIds: [label.id] }) });
  }
  return ids.length;
}

// True if this conversation already contains a message WE sent — meaning the
// incoming mail is someone answering us / continuing a chat, not a fresh
// request. Fails toward "yes, it's a conversation" (safer: no auto-reply).
export async function threadHasSentMessage(threadId) {
  try {
    const t = await gcall(`${GMAIL}/users/me/threads/${threadId}?format=minimal`);
    return (t.messages || []).some((m) => (m.labelIds || []).includes('SENT'));
  } catch {
    return true;
  }
}

// The visible labels the owner actually reads in Gmail. `iw-processed` stays
// hidden — it's bookkeeping, not something to browse — but these two are real
// folders so the inbox sorts itself:
//   Revisions      what clients asked us to change
//   Website Agent  what the automation did (agent + Vercel/GitHub build mail)
// Gmail nests labels with "/". Clicking a parent in Gmail does NOT show mail
// filed only under its children, so every business message gets BOTH the
// parent and its specific sub-label. Result:
//
//   Inspiring Websites                 <- click this, see everything business
//     ├ Revisions                      <- what clients asked us to change
//     ├ Website Agent                  <- what the automation + host did
//     └ Clients                        <- everything else from a client
//
// The owner's personal and unrelated mail is never touched.
const PARENT = 'Inspiring Websites';
export const LABELS = Object.freeze({
  PROCESSED: 'iw-processed', // hidden bookkeeping, not a folder to browse
  PARENT,
  REVISIONS: `${PARENT}/Revisions`,
  AGENT: `${PARENT}/Website Agent`,
  CLIENTS: `${PARENT}/Clients`,
});

const CATEGORY_LABEL = Object.freeze({
  revision: LABELS.REVISIONS,
  agent: LABELS.AGENT,
  client: LABELS.CLIENTS,
});

let labelCache = null;

/** Find a label by name, creating it if it doesn't exist yet. Cached per warm instance. */
export async function ensureLabel(name, { hidden = false } = {}) {
  if (!labelCache) {
    const res = await gcall(`${GMAIL}/users/me/labels`);
    labelCache = new Map((res.labels || []).map((l) => [l.name, l.id]));
  }
  if (labelCache.has(name)) return labelCache.get(name);
  const created = await gcall(`${GMAIL}/users/me/labels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      labelListVisibility: hidden ? 'labelHide' : 'labelShow',
      messageListVisibility: hidden ? 'hide' : 'show',
    }),
  });
  // A concurrent run may have created it a moment earlier; Gmail returns 409.
  // Re-read rather than failing the whole inbox pass over a label.
  if (!created?.id) {
    const res = await gcall(`${GMAIL}/users/me/labels`);
    labelCache = new Map((res.labels || []).map((l) => [l.name, l.id]));
    return labelCache.get(name) || null;
  }
  labelCache.set(name, created.id);
  return created.id;
}

/**
 * Mark a message handled, and file it under the label that says WHY.
 * `category` is 'revision' (a client asking for a change), 'agent' (our own
 * automation / the host's build mail), or 'client' (anything else from a
 * client). Each of those also gets the parent label, so one click shows the
 * whole business. Anything else is just marked processed and left where it is
 * — the owner's normal mail is never filed.
 */
export async function labelProcessed(messageId, category = null) {
  const addLabelIds = [];
  const processedId = await ensureLabel(LABELS.PROCESSED, { hidden: true }).catch(() => null);
  if (processedId) addLabelIds.push(processedId);
  const child = CATEGORY_LABEL[category];
  if (child) {
    // parent first so Gmail renders the nesting correctly on first creation
    const parentId = await ensureLabel(LABELS.PARENT).catch(() => null);
    if (parentId) addLabelIds.push(parentId);
    const id = await ensureLabel(child).catch(() => null);
    if (id) addLabelIds.push(id);
  }
  if (!addLabelIds.length) return;
  await gcall(`${GMAIL}/users/me/messages/${messageId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds, removeLabelIds: ['UNREAD'] }),
  });
}

/**
 * One-time catch-up: file mail that was already handled before the labels
 * existed. Walks recent mail, decides a category from the headers alone (no AI
 * cost, no re-processing, no replies sent), and applies the labels.
 * `classify` is injected so the caller owns the "is this a client?" decision.
 */
export async function backfillLabels({ days = 60, max = 200, classify }) {
  const out = { scanned: 0, labelled: 0, byCategory: { revision: 0, agent: 0, client: 0, skipped: 0 } };
  let pageToken = null;
  do {
    const q = encodeURIComponent(`in:inbox newer_than:${days}d`);
    const url = `${GMAIL}/users/me/messages?q=${q}&maxResults=100${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const list = await gcall(url);
    pageToken = list.nextPageToken || null;
    for (const { id } of list.messages || []) {
      if (out.scanned >= max) return out;
      out.scanned++;
      const msg = await gcall(`${GMAIL}/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
      const info = { id, from: headers.from || '', subject: headers.subject || '', snippet: msg.snippet || '' };
      const category = looksLikeAgentMail(info) ? 'agent' : await classify(info);
      if (!category) {
        out.byCategory.skipped++;
        continue;
      }
      await labelProcessed(id, category).catch(() => {});
      out.labelled++;
      out.byCategory[category]++;
    }
  } while (pageToken && out.scanned < max);
  return out;
}

/**
 * Is this message automation mail rather than a person writing to us?
 * Covers the dashboard's own notifications and the deploy/build mail from the
 * host and GitHub — the stuff the owner wants filed under "Website Agent"
 * instead of sitting in the inbox.
 */
export function looksLikeAgentMail({ from = '', subject = '' } = {}) {
  const f = String(from).toLowerCase();
  const s = String(subject).toLowerCase();
  if (/@(vercel|github|netlify|cloudflare)\.com|noreply@github|notifications@github/.test(f)) return true;
  if (/vercel|deployment|deploy(ed|ment)? (succeeded|failed|ready)|build (failed|succeeded)|pull request|\[.*\] (merge|commit)/.test(s)) return true;
  // the dashboard's own outgoing notifications, when they land back here
  if (/revision (done|blocked)|seo paused|rank drop|blog post:|dashboard needs a look|revisions completed/.test(s)) return true;
  return false;
}

let myEmailCache = null;
export async function getMyEmailAddress() {
  if (myEmailCache) return myEmailCache;
  const profile = await gcall(`${GMAIL}/users/me/profile`);
  myEmailCache = profile.emailAddress;
  return myEmailCache;
}

// A fresh message (its own thread) — used for Mondo's own confirmation
// notifications, as opposed to sendGmailReply which stays in the client's thread.
export async function sendGmailMessage({ to, subject, body }) {
  const headerLines = [`To: ${to}`, `Subject: ${subject}`, 'Content-Type: text/plain; charset="UTF-8"'].join('\r\n');
  const raw = Buffer.from(`${headerLines}\r\n\r\n${body}`)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return gcall(`${GMAIL}/users/me/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
}

// Real threaded reply, sent from the same Info@ account, not a third-party sender.
export async function sendGmailReply({ to, subject, body, threadId, inReplyTo }) {
  const headerLines = [
    `To: ${to}`,
    `Subject: ${subject.startsWith('Re:') ? subject : 'Re: ' + subject}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : '',
    inReplyTo ? `References: ${inReplyTo}` : '',
    'Content-Type: text/plain; charset="UTF-8"',
  ].filter(Boolean).join('\r\n');
  const raw = Buffer.from(`${headerLines}\r\n\r\n${body}`)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return gcall(`${GMAIL}/users/me/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw, threadId }),
  });
}

/**
 * R19.1 — what is actually busy, straight from the calendar.
 *
 * This was the missing piece. The module could create, move and delete events
 * but could not ask what was already there, so any slot offered to a visitor
 * would have been a guess. `freeBusy.query` is the authoritative answer.
 *
 * Returns `{ ok, busy }`. On failure `ok` is false and `busy` is **null**, not
 * `[]`: an empty array means "the calendar says nothing is booked", and null
 * means "we could not ask". Collapsing those would offer the owner's whole
 * week as free during an outage.
 */
export async function calendarBusy({ from, to, calendarId = 'primary' }) {
  try {
    const body = await gcall(`${CAL}/freeBusy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: new Date(from).toISOString(),
        timeMax: new Date(to).toISOString(),
        items: [{ id: calendarId }],
      }),
    });
    const cal = body?.calendars?.[calendarId];
    if (cal?.errors?.length) {
      return { ok: false, busy: null, error: cal.errors.map((e) => e.reason).join(', ') };
    }
    const busy = (cal?.busy || []).map((b) => ({
      start: Date.parse(b.start),
      end: Date.parse(b.end),
    })).filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end));
    return { ok: true, busy };
  } catch (e) {
    return { ok: false, busy: null, error: String(e?.message || e).slice(0, 160) };
  }
}

/**
 * Create the appointment with the invitee on it.
 *
 * `attendees` is what makes this an appointment rather than a note in the
 * owner's diary: Google sends the invitation and the calendar reminder, and the
 * invitee gets a cancel/reschedule handle of their own.
 */
export async function createAppointment({
  title, description, startAt, durationMinutes = 30,
  attendeeEmail, attendeeName = '', timezone = 'America/Chicago', sendUpdates = 'all',
}) {
  const end = new Date(new Date(startAt).getTime() + durationMinutes * 60000);
  const ev = await gcall(`${CAL}/calendars/primary/events?sendUpdates=${encodeURIComponent(sendUpdates)}&conferenceDataVersion=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: title,
      description,
      start: { dateTime: new Date(startAt).toISOString(), timeZone: timezone },
      end: { dateTime: end.toISOString(), timeZone: timezone },
      attendees: attendeeEmail ? [{ email: attendeeEmail, displayName: attendeeName || undefined }] : [],
      // A real meeting link, created by the provider rather than described by us.
      conferenceData: { createRequest: { requestId: `iw-${Date.now().toString(36)}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } },
      guestsCanModify: false,
      reminders: { useDefault: true },
    }),
  });
  return {
    id: ev.id,
    htmlLink: ev.htmlLink,
    meetingUrl: ev.hangoutLink || ev.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri || null,
    status: ev.status || null,
    iCalUID: ev.iCalUID || null,
  };
}

export async function createCalendarEvent({ title, description, startAt, durationMinutes = 30 }) {
  const end = new Date(startAt.getTime() + durationMinutes * 60000);
  const ev = await gcall(`${CAL}/calendars/primary/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: title,
      description,
      start: { dateTime: startAt.toISOString() },
      end: { dateTime: end.toISOString() },
    }),
  });
  return { id: ev.id, htmlLink: ev.htmlLink };
}

export async function updateCalendarEvent(eventId, { startAt, durationMinutes = 30 }) {
  if (!eventId) return;
  const end = new Date(startAt.getTime() + durationMinutes * 60000);
  await gcall(`${CAL}/calendars/primary/events/${eventId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      start: { dateTime: startAt.toISOString() },
      end: { dateTime: end.toISOString() },
    }),
  });
}

export async function deleteCalendarEvent(eventId) {
  if (!eventId) return;
  await gcall(`${CAL}/calendars/primary/events/${eventId}`, { method: 'DELETE' });
}
