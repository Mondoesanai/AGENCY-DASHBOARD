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
  return walk(payload).replace(/\s+/g, ' ').trim().slice(0, 4000);
}

// New inbox mail since `sinceDateStr` (Gmail date query, YYYY/MM/DD), skipping
// anything already labeled processed. Coarse day-level filter — the label is
// the real once-only guarantee.
export async function listNewMail(sinceDateStr) {
  const q = `in:inbox after:${sinceDateStr} -label:iw-processed`;
  const list = await gcall(`${GMAIL}/users/me/messages?q=${encodeURIComponent(q)}&maxResults=25`);
  const ids = (list.messages || []).map((m) => m.id);
  const out = [];
  for (const id of ids) {
    const msg = await gcall(`${GMAIL}/users/me/messages/${id}?format=full`);
    const headers = Object.fromEntries((msg.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value]));
    out.push({
      id: msg.id,
      threadId: msg.threadId,
      from: headers.from || '',
      subject: headers.subject || '(no subject)',
      messageIdHeader: headers['message-id'] || '',
      snippet: msg.snippet || '',
      body: decodeBody(msg.payload),
    });
  }
  return out;
}

export async function labelProcessed(messageId) {
  const labels = await gcall(`${GMAIL}/users/me/labels`);
  let label = (labels.labels || []).find((l) => l.name === 'iw-processed');
  if (!label) {
    label = await gcall(`${GMAIL}/users/me/labels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'iw-processed', labelListVisibility: 'labelHide', messageListVisibility: 'hide' }),
    });
  }
  await gcall(`${GMAIL}/users/me/messages/${messageId}/modify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addLabelIds: [label.id], removeLabelIds: ['UNREAD'] }),
  });
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
