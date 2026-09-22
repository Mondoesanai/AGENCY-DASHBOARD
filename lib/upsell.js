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

// Concrete, specific observations to name in the email instead of generic
// "things are trending up" — this is what makes it read as "we actually
// looked at your site" rather than a form letter, and gives each signal a
// distinct, factual upsell angle instead of one vague pitch.
function computeSignals(rows) {
  if (!rows.length) return [];
  const last = rows[rows.length - 1];
  const first = rows[0];
  const signals = [];
  const visitors = last.visitors || 0;
  const conversions = last.conversions || 0;
  const convRate = visitors ? conversions / visitors : 0;
  if (visitors >= 150 && convRate < 0.02) {
    signals.push({
      key: 'low-conversion',
      text: `${visitors.toLocaleString()} visitors last month but only ${conversions} turned into an enquiry — real traffic that's landing and leaving. A focused landing page for your main offer usually closes that gap.`,
    });
  }
  if ((last.seo ?? 0) >= 85 && visitors < 400) {
    signals.push({
      key: 'seo-ready-low-traffic',
      text: `Technically your site is dialed in (SEO score ${last.seo}) but traffic is still modest — it's ready to carry more volume than it's getting. Paid search or an expanded keyword footprint would put that groundwork to work.`,
    });
  }
  if (first.visitors && last.visitors > first.visitors * 1.5) {
    signals.push({
      key: 'fast-growth',
      text: `Traffic's grown ${Math.round(((last.visitors - first.visitors) / Math.max(1, first.visitors)) * 100)}% since launch — worth checking whether the site's booking/contact flow can keep up with that pace.`,
    });
  }
  return signals;
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
  const signals = computeSignals(rows);
  const sentAt = Number(await store.get(`upsell:sent:${site.slug}`).catch(() => 0)) || 0;
  // a real, named signal is worth reaching out over even before the usual
  // 6-month mark — a specific observation, not tenure, is what makes this
  // worth a client's time to read.
  const eligible = (months >= MIN_MONTHS && growing && !sentAt) || (signals.length > 0 && !sentAt);
  return {
    eligible,
    months,
    growing,
    growthNote,
    signals,
    sentAt,
    reason: eligible ? '' : sentAt ? 'already sent' : months < MIN_MONTHS && !signals.length ? `only ${months} months in, nothing specific to flag yet` : 'not trending up',
  };
}

export function draftUpsell(site, state) {
  const name = lastName(site.client);
  const note = state.growthNote || `things have been trending the right way`;
  const subject = state.signals?.length ? `${site.name} — something worth a quick look` : `${site.name} — ${state.months} months in, and it's working`;
  const signalLines = (state.signals || []).map((s) => `• ${s.text}`).join('\n');
  const body = state.signals?.length
    ? `Hi Mr./Mrs. ${name},\n\n` +
      `Been keeping an eye on ${site.name}'s numbers, and noticed something worth flagging:\n\n${signalLines}\n\n` +
      `Nothing urgent, but it's the kind of thing worth 15 minutes to talk through — happy to walk you through what I'm seeing and what it'd take:\n${CALENDLY}\n\n` +
      `— ${SIG}`
    : `Hi Mr./Mrs. ${name},\n\n` +
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
