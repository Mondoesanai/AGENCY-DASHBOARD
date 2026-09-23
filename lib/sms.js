// Text messages to the owner (Twilio), so the automation can ask a yes/no
// question instead of Mondo having to notice something is broken.
//
// Env (all four required, otherwise everything falls back to email):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN  - from the Twilio console
//   TWILIO_FROM                            - the Twilio number, +1XXXXXXXXXX
//   OWNER_PHONE                            - Mondo's own cell, +1XXXXXXXXXX
//
// Cost control: every text is one ~1c segment, so there's a hard daily cap
// (SMS_DAILY_CAP, default 20) and messages are forced to plain ASCII — an
// emoji or curly quote silently switches a text to a 70-character encoding
// and doubles or triples what it costs.
import { store } from './store.js';

const env = (k) => (process.env[k] || '').trim();
export const smsConfigured = () => !!(env('TWILIO_ACCOUNT_SID') && env('TWILIO_AUTH_TOKEN') && env('TWILIO_FROM') && env('OWNER_PHONE'));
const dailyCap = () => Math.max(1, Number(env('SMS_DAILY_CAP')) || 20);
export const digits = (p) => String(p || '').replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');

// plain GSM-safe text, kept short enough to stay one or two segments
export function plain(t, max = 300) {
  return String(t || '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\x20-\x7E\n]/g, '')
    .trim()
    .slice(0, max);
}

async function emailOwner(subject, body) {
  if (!env('RESEND_API_KEY') || !env('REPORT_FROM')) return { sent: false, reason: 'no email either' };
  try {
    const { Resend } = await import('resend');
    const r = await new Resend(env('RESEND_API_KEY')).emails.send({
      from: env('REPORT_FROM'),
      to: env('OWNER_EMAIL') || 'mondoesanai@gmail.com',
      subject,
      text: body,
    });
    return { sent: !r.error, via: 'email', reason: r.error?.message || null };
  } catch (e) {
    return { sent: false, reason: String(e.message || e) };
  }
}

// One raw text. Returns {sent, reason}. Never throws.
export async function sendSms(text) {
  if (!smsConfigured()) return { sent: false, reason: 'SMS not set up' };
  const day = new Date().toISOString().slice(0, 10);
  const key = `sms:count:${day}`;
  const used = Number(await store.get(key).catch(() => 0)) || 0;
  if (used >= dailyCap()) return { sent: false, reason: `daily text cap reached (${dailyCap()})` };
  try {
    const sid = env('TWILIO_ACCOUNT_SID');
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${env('TWILIO_AUTH_TOKEN')}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: env('OWNER_PHONE'), From: env('TWILIO_FROM'), Body: plain(text) }).toString(),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { sent: false, reason: j.message || `twilio ${r.status}` };
    await store.set(key, String(used + 1), { ex: 60 * 60 * 30 }).catch(() => {});
    return { sent: true, sid: j.sid };
  } catch (e) {
    return { sent: false, reason: String(e.message || e) };
  }
}

// An FYI — no reply needed. Falls back to email when texting isn't possible,
// so a message is never silently lost.
export async function notifyOwner(text, { subject } = {}) {
  const r = await sendSms(text);
  if (r.sent) return r;
  return emailOwner(subject || plain(text, 70), text + `\n\n(sent by email because: ${r.reason})`);
}

// A question that needs a yes/no. The answer comes back through the Twilio
// webhook (see lib/sms-actions.js) and is applied to whichever ask it
// refers to (the newest pending one, or "YES 7" for ask #7).
export async function askOwner({ kind, text, payload = {}, choices = 'Reply YES or NO' }) {
  const id = Number(await store.incr('sms:seq').catch(() => Date.now() % 100000));
  await store.set(`sms:ask:${id}`, JSON.stringify({ id, kind, payload, at: Date.now(), status: 'pending' }), { ex: 60 * 60 * 24 * 14 }).catch(() => {});
  const list = await pendingIds();
  list.push(id);
  await store.set('sms:pending', JSON.stringify(list.slice(-30)), { ex: 60 * 60 * 24 * 14 }).catch(() => {});
  const body = `${plain(text, 220)}\n${choices} (#${id})`;
  const r = await sendSms(body);
  if (r.sent) return { ...r, id };
  const e = await emailOwner(`Needs your answer (#${id}): ${plain(text, 60)}`, `${body}\n\nTexting isn't available (${r.reason}). Open the dashboard to act on it.`);
  return { ...e, id };
}

export async function pendingIds() {
  const raw = await store.get('sms:pending').catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a.map(Number) : [];
  } catch {
    return [];
  }
}
export async function getAsk(id) {
  const raw = await store.get(`sms:ask:${id}`).catch(() => null);
  try {
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    return null;
  }
}
export async function closeAsk(id) {
  const ask = await getAsk(id);
  if (ask) await store.set(`sms:ask:${id}`, JSON.stringify({ ...ask, status: 'answered', answeredAt: Date.now() }), { ex: 60 * 60 * 24 * 14 }).catch(() => {});
  const list = (await pendingIds()).filter((x) => x !== Number(id));
  await store.set('sms:pending', JSON.stringify(list), { ex: 60 * 60 * 24 * 14 }).catch(() => {});
}
