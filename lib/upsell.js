// 6-month expansion / upsell engine. When a paying client has been on for ~6
// months and is trending up, we send one warm, curiosity-framed email pointing
// at a Calendly call — no specific offer named. Owner can preview / send from the
// drawer; cron can auto-send once UPSELL_AUTO=1 and Resend is verified.
import { store } from './store.js';
import { getHistory } from './history.js';

const CALENDLY = process.env.UPSELL_CALENDLY || 'https://calendly.com/mondoesanai/30min';
const SIG = process.env.REPORT_SIGNATURE || 'Inspiring Websites';
const MIN_MONTHS = Number(process.env.UPSELL_MIN_MONTHS || 6);

const monthsActive = (site) => {
  const from = site.trialEnds && site.trialEnds > (site.startedAt || 0) ? site.trialEnds : site.startedAt;
  return from ? Math.floor((Date.now() - from) / (30 * 864e5)) : 0;
};

function lastName(client) {
  const parts = String(client || '').trim().split(/\s+/);
  return parts.length > 1 ? parts[parts.length - 1] : parts[0] || 'there';
}

export async function upsellState(site) {
  if (!site.priceMonthly || (site.trialEnds && site.trialEnds > Date.now())) {
    return { eligible: false, reason: 'not a paying client yet', months: monthsActive(site) };
  }
  const months = monthsActive(site);
  const history = await getHistory(site.slug).catch(() => []);
  const rows = Array.isArray(history) ? history.filter(Boolean) : [];
  let growing = true;
  let growthNote = '';
  if (rows.length >= 2) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    const vFrom = first.visitors || 0;
    const vTo = last.visitors || 0;
    const sFrom = first.seo || 0;
    const sTo = last.seo || 0;
    growing = vTo >= vFrom || sTo > sFrom;
    if (vTo > vFrom) growthNote = `traffic is up about ${Math.round(((vTo - vFrom) / Math.max(1, vFrom)) * 100)}% since we started`;
    else if (sTo > sFrom) growthNote = `your SEO health has climbed from ${sFrom} to ${sTo}`;
  }
  const sentAt = Number(await store.get(`upsell:sent:${site.slug}`).catch(() => 0)) || 0;
  const eligible = months >= MIN_MONTHS && growing && !sentAt;
  return { eligible, months, growing, growthNote, sentAt, reason: eligible ? '' : sentAt ? 'already sent' : months < MIN_MONTHS ? `only ${months} months in` : 'not trending up' };
}

export function draftUpsell(site, state) {
  const name = lastName(site.client);
  const note = state.growthNote || `things have been trending the right way`;
  const subject = `${site.name} — ${state.months} months in, and it's working`;
  const body =
    `Hi Mr./Mrs. ${name},\n\n` +
    `It's been ${state.months} months since ${site.name} went live with us, and ${note}. Really glad to see it.\n\n` +
    `There's one thing outside the website itself that's quietly costing you customers every week — it's a straightforward fix and it's something we can handle for you. Rather than write it all out, it's a quick conversation.\n\n` +
    `Grab a 15-minute slot here and I'll walk you through it:\n${CALENDLY}\n\n` +
    `— ${SIG}`;
  return { subject, body };
}

// send via Resend (same setup as the monthly report). Returns {sent, reason}.
export async function sendUpsell(site) {
  const state = await upsellState(site);
  const { subject, body } = draftUpsell(site, state);
  const dest = site.email;
  if (!process.env.RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY not set' };
  if (!dest) return { sent: false, reason: 'no client email on file' };
  if (!process.env.REPORT_FROM) return { sent: false, reason: 'REPORT_FROM not set' };
  let Resend;
  try {
    ({ Resend } = await import('resend'));
  } catch {
    return { sent: false, reason: 'resend package unavailable' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.REPORT_FROM;
  try {
    const r = await resend.emails.send({ from, to: dest, subject, text: body });
    if (r.error) return { sent: false, reason: r.error.message, to: dest };
    await store.set(`upsell:sent:${site.slug}`, String(Date.now()));
    return { sent: true, id: r.data?.id || null, to: dest, subject };
  } catch (e) {
    return { sent: false, reason: String(e.message || e), to: dest };
  }
}
