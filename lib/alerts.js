// Daily "something needs you" email — the whole point of systemHealth() was
// catching problems early, but a dashboard tile nobody's looking at is just
// as silent as no check at all. Sends once a day, only when there's actually
// something worth seeing (critical/warn issues), straight to the owner.
import { systemHealth } from './health.js';

export async function sendHealthAlert() {
  if (!process.env.RESEND_API_KEY || !process.env.REPORT_FROM) {
    return { sent: false, reason: 'Resend not configured' };
  }
  const to = process.env.OWNER_EMAIL || 'mondoesanai@gmail.com';
  const h = await systemHealth();
  const worth = h.issues.filter((i) => i.level === 'critical' || i.level === 'warn');
  if (!worth.length) return { sent: false, reason: 'nothing needing attention' };

  const crit = worth.filter((i) => i.level === 'critical');
  const warn = worth.filter((i) => i.level === 'warn');
  const subject = `${crit.length ? '🔴' : '🟡'} Dashboard needs a look — ${worth.length} thing${worth.length === 1 ? '' : 's'}`;
  const lines = [
    ...crit.map((i) => `🔴 ${i.text}`),
    ...warn.map((i) => `🟡 ${i.text}`),
  ];
  const body = `Daily check found ${worth.length} thing${worth.length === 1 ? '' : 's'} worth a look:\n\n${lines.join('\n\n')}\n\n— sent automatically from the agency dashboard's daily health check`;

  let Resend;
  try {
    ({ Resend } = await import('resend'));
  } catch {
    return { sent: false, reason: 'resend package unavailable' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  try {
    const r = await resend.emails.send({ from: process.env.REPORT_FROM, to, subject, text: body });
    if (r.error) return { sent: false, reason: r.error.message };
    return { sent: true, id: r.data?.id || null, count: worth.length };
  } catch (e) {
    return { sent: false, reason: String(e.message || e) };
  }
}
