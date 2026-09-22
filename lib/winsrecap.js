// Lightweight "here's what's happened lately" email — shorter and more
// casual than the formal monthly report, sent twice a month (in addition to
// it) so clients hear from us more than once a month without it turning
// into a second full report. Pulls the same recent-activity data the live
// client report page shows (api/public-report.js), just as an email.
import { store } from './store.js';

async function readArr(k) {
  const raw = await store.get(k).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

export async function draftWinsRecap(site) {
  const cutoff = Date.now() - 15 * 864e5; // last ~2 weeks
  const [manual, autoShipped] = await Promise.all([readArr(`changelog:${site.slug}`), readArr(`todos:completed:${site.slug}`)]);
  const items = [
    ...manual.filter((c) => (Date.parse(c.date) || 0) >= cutoff).map((c) => c.text),
    ...autoShipped.filter((x) => (x.addressedAt || 0) >= cutoff).map((x) => (x.source === 'revision' ? 'You asked for this — ' : '') + x.title),
  ].slice(0, 5);
  if (!items.length) return null; // nothing to recap — caller skips sending
  const subject = `${site.name} — quick update`;
  const body =
    `Hi,\n\nQuick one — here's what's happened on ${site.name} recently:\n\n` +
    items.map((i) => `• ${i}`).join('\n') +
    `\n\nMore to come. Full numbers as usual in your monthly report.\n\n— ${process.env.REPORT_SIGNATURE || 'Inspiring Websites'}`;
  return { subject, body, items };
}

export async function sendWinsRecap(site) {
  if (!process.env.RESEND_API_KEY || !process.env.REPORT_FROM) return { sent: false, reason: 'Resend not configured' };
  if (!site.email) return { sent: false, reason: 'no client email on file' };
  const draft = await draftWinsRecap(site);
  if (!draft) return { sent: false, reason: 'nothing new to recap this window' };
  let Resend;
  try {
    ({ Resend } = await import('resend'));
  } catch {
    return { sent: false, reason: 'resend package unavailable' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    const r = await resend.emails.send({ from: process.env.REPORT_FROM, to: site.email, subject: draft.subject, text: draft.body });
    if (r.error) return { sent: false, reason: r.error.message };
    return { sent: true, id: r.data?.id || null, items: draft.items };
  } catch (e) {
    return { sent: false, reason: String(e.message || e) };
  }
}
