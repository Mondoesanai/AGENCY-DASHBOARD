// Builds the monthly client email. Rotates tone/structure by how many months
// the site has been live, so month 2 never reads like month 1. Always carries
// real numbers pulled from the history snapshots.
import { prevRow, delta, pctDelta } from './history.js';

const ANGLES = ['first-month', 'momentum', 'milestone', 'behind-the-scenes', 'recap'];

const SUBJECTS = {
  'first-month': (b) => `${b} — your website's first month`,
  momentum: (b) => `${b} — this month's website progress`,
  milestone: (b) => `${b} — a milestone this month`,
  'behind-the-scenes': (b) => `${b} — what we improved this month`,
  recap: (b) => `${b} — your website growth recap`,
};

const OPENERS = {
  'first-month': (c, b) =>
    `Hi ${c}, your website's first full month is in — here's where ${b} stands, and where we're taking it next.`,
  momentum: (c, b) =>
    `Hi ${c}, good news — ${b}'s website is building momentum. Here's this month's progress.`,
  milestone: (c, b) =>
    `Hi ${c}, ${b} hit a nice milestone this month. Here's what the numbers look like.`,
  'behind-the-scenes': (c, b) =>
    `Hi ${c}, here's what we worked on for ${b} this month, and what it did for your numbers.`,
  recap: (c, b) => `Hi ${c}, a quick recap of how ${b}'s website has been growing lately.`,
};

const CLOSERS = {
  'first-month': `We're just getting started — expect this to keep climbing.`,
  momentum: `Your website is turning into a real source of business.`,
  milestone: `Great to see the work paying off. More coming next month.`,
  'behind-the-scenes': `Small improvements every month add up fast.`,
  recap: `Thanks for trusting us with this — onward.`,
};

const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

export function pickAngle(monthsSinceLaunch) {
  const i = Math.max(0, monthsSinceLaunch || 0) % ANGLES.length;
  return ANGLES[i];
}

// ctx: { site, biz, client, month, monthsSinceLaunch, history, baseline,
//        row (this month's snapshot), stats, grade, clientSuggestions,
//        changelog (array of {date,text}), reportUrl, signature }
export function buildClientEmail(ctx) {
  const {
    biz,
    client = 'there',
    monthsSinceLaunch = 0,
    history = [],
    baseline,
    row = {},
    clientSuggestions = [],
    changelog = [],
    reportUrl,
    signature = 'The team',
    reviewUrl,
    leadValue = 0,
  } = ctx;

  const angle = pickAngle(monthsSinceLaunch);
  const prev = prevRow(history);

  const wins = [];
  if (prev) {
    if (row.seo != null && prev.seo != null && row.seo !== prev.seo)
      wins.push(`Your Google/SEO score moved from ${prev.seo} to ${row.seo}.`);
    if (row.visitors && (prev.visitors || prev.visitors === 0)) {
      const p = pctDelta(row.visitors, prev.visitors);
      wins.push(
        `Visitors: ${prev.visitors} → ${row.visitors} last month${
          p ? ` (${p > 0 ? '+' : ''}${p}%)` : ''
        }.`
      );
    }
    if (row.conversions != null && prev.conversions != null && (row.conversions || prev.conversions))
      wins.push(`Enquiries (calls, forms, bookings): ${prev.conversions} → ${row.conversions}.`);
  } else {
    if (row.seo != null) wins.push(`Google/SEO score is at ${row.seo}/100 and we're pushing it higher.`);
    if (row.visitors) wins.push(`${row.visitors} visitors in the first 30 days.`);
    if (row.conversions) wins.push(`${row.conversions} enquiries came through the site.`);
  }
  if (baseline && row.seo != null && baseline.seo != null && monthsSinceLaunch >= 2) {
    const d = delta(row.seo, baseline.seo);
    if (d > 0) wins.push(`Since we launched, your SEO score is up ${d} points.`);
  }
  if (leadValue && row.conversions)
    wins.push(`That's roughly ${money(row.conversions * leadValue)} in new enquiries this month.`);
  if (!wins.length) wins.push(`Everything's running smoothly and tracking is live.`);

  const L = [];
  L.push(OPENERS[angle](client, biz));
  L.push('');
  L.push('This month:');
  wins.forEach((w) => L.push(`• ${w}`));

  const thisMonthLog = changelog.filter(
    (c) => (c.date || '').slice(0, 7) === (ctx.month || '').slice(0, 7)
  );
  if (thisMonthLog.length) {
    L.push('');
    L.push('What we did:');
    thisMonthLog.forEach((c) => L.push(`• ${c.text}`));
  }

  if (clientSuggestions.length) {
    L.push('');
    L.push("What we're working on next:");
    clientSuggestions.slice(0, 3).forEach((s) => L.push(`• ${s.title}`));
  }

  L.push('');
  L.push(CLOSERS[angle]);

  if (reviewUrl && monthsSinceLaunch >= 3 && prev && row.visitors >= (prev.visitors || 0)) {
    L.push('');
    L.push(`PS — if you've been happy with how things are going, a quick Google review would mean a lot: ${reviewUrl}`);
  }

  L.push('');
  L.push(`— ${signature}`);
  if (reportUrl) {
    L.push('');
    L.push(`Full report: ${reportUrl}`);
  }

  return { angle, subject: SUBJECTS[angle](biz), body_text: L.join('\n'), wins };
}
