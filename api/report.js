// Monthly report builder.
//   - runs automatically on the 1st of each month (see vercel.json cron)
//   - or on demand:  /api/report?secret=YOUR_CRON_SECRET
//   - single site:    ...&slug=relax-tax
//   - also email it:   ...&send=1   (needs RESEND_API_KEY + an email in lib/sites.js)
//
// AI step is optional. With no ANTHROPIC_API_KEY it still produces a solid
// rules-only report. Model defaults to claude-opus-5; set ANTHROPIC_MODEL to
// claude-sonnet-5 for a cheaper run.
import { SITES, getSite } from '../lib/sites.js';
import { runAudit } from '../lib/audit.js';
import { siteStats } from '../lib/stats.js';
import { buildFindings, overallGrade } from '../lib/suggestions.js';
import { store } from '../lib/store.js';

const MONTH = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
const MONTH_KEY = new Date().toISOString().slice(0, 7);

function authed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // not configured yet -> allow (dev)
  const header = req.headers.authorization || '';
  return header === `Bearer ${secret}` || req.query.secret === secret;
}

function pct(n) {
  return `${n > 0 ? '+' : ''}${n}%`;
}

function rulesSummary(site, g, stats) {
  const bits = [];
  if (stats?.hasData) {
    bits.push(
      `${stats.visitors} visitors and ${stats.conversions} conversions in the last 30 days (${pct(
        stats.deltas.visitors
      )} vs the month before)`
    );
  }
  if (g) bits.push(`site health graded ${g.letter} (${g.score}/100)`);
  return bits.length
    ? `${site.name}: ${bits.join(', ')}.`
    : `${site.name}: baseline recorded, tracking is now live.`;
}

async function aiReport({ site, stats, audit, findings, grade }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    return null;
  }
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5';

  const payload = {
    business: site.name,
    contact: site.client,
    month: MONTH,
    grade,
    metrics: stats && {
      visitors: stats.visitors,
      pageviews: stats.pageviews,
      conversions: stats.conversions,
      changeVsLastMonth: stats.deltas,
      topPages: stats.topPages,
      trafficSources: stats.sources,
      device: stats.device,
    },
    audit: audit?.ok && { scores: audit.scores, vitals: audit.vitals },
    findings,
  };

  const system =
    'You are the account manager at a small web studio writing the monthly ' +
    'performance update for a client. Warm, plain-spoken, concrete, never hype. ' +
    'The client is not technical. Return ONLY valid minified JSON, no markdown, ' +
    'matching exactly: {"headline":string,"summary":string,' +
    '"wins":string[],"suggestions":[{"title":string,"why":string,"priority":"high"|"medium"|"low"}],' +
    '"email":{"subject":string,"body_text":string}}. ' +
    '"summary" is 2-3 sentences. "wins" is 1-3 short phrases (omit if genuinely none). ' +
    '"suggestions" is 3-5 items, most impactful first, each "why" one sentence in ' +
    'client language. "email.body_text" is the full plain-text email to ' +
    `${site.client} (greeting to "${site.client}", sign-off "— The team"), 120-200 words, ` +
    'leads with the good news, then 2-3 things we plan to improve next.';

  const res = await client.messages.create({
    model,
    max_tokens: 2000,
    system,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
  });
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  try {
    return JSON.parse(text.replace(/^```json\s*|\s*```$/g, '').trim());
  } catch {
    return null;
  }
}

async function sendEmail(site, report) {
  if (!process.env.RESEND_API_KEY || !site.email || !report?.email) return { sent: false };
  let Resend;
  try {
    ({ Resend } = await import('resend'));
  } catch {
    return { sent: false, error: 'resend not installed' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.REPORT_FROM || 'reports@example.com';
  const body = report.email.body_text || report.summary;
  const html = `<div style="font:16px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1d1a;max-width:560px">
    ${body
      .split('\n')
      .map((p) => `<p style="margin:0 0 14px">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`)
      .join('')}
  </div>`;
  try {
    const r = await resend.emails.send({
      from,
      to: site.email,
      subject: report.email.subject || `${site.name} — website update for ${MONTH}`,
      text: body,
      html,
    });
    return { sent: !r.error, id: r.data?.id, error: r.error?.message };
  } catch (e) {
    return { sent: false, error: String(e.message || e) };
  }
}

async function buildForSite(site, doSend) {
  const [stats, audit] = await Promise.all([
    siteStats(site.slug).catch(() => null),
    runAudit(site.url, { fresh: true }).catch(() => ({ ok: false, error: 'audit failed' })),
  ]);
  const findings = buildFindings(audit, stats);
  const grade = overallGrade(audit, stats);
  const ai = await aiReport({ site, stats, audit, findings, grade }).catch(() => null);

  const report = {
    slug: site.slug,
    name: site.name,
    month: MONTH,
    monthKey: MONTH_KEY,
    generatedAt: Date.now(),
    grade,
    headline: ai?.headline || `${site.name} — ${MONTH}`,
    summary: ai?.summary || rulesSummary(site, grade, stats),
    wins: ai?.wins || findings.filter((f) => f.severity === 'good').map((f) => f.title),
    suggestions:
      ai?.suggestions ||
      findings
        .filter((f) => f.severity !== 'good')
        .slice(0, 6)
        .map((f) => ({
          title: f.title,
          why: f.detail,
          priority: f.severity === 'high' ? 'high' : f.severity === 'med' ? 'medium' : 'low',
        })),
    email: ai?.email || null,
    metrics: stats,
    aiGenerated: !!ai,
  };

  await store.set(`report:${site.slug}:latest`, JSON.stringify(report));
  await store.set(`report:${site.slug}:${MONTH_KEY}`, JSON.stringify(report));

  let email = { sent: false };
  if (doSend) email = await sendEmail(site, report);
  return { ...report, emailResult: email };
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad secret' });

  const only = req.query.slug ? [getSite(req.query.slug)].filter(Boolean) : SITES;
  const doSend = req.query.send === '1';

  const reports = [];
  for (const site of only) {
    try {
      reports.push(await buildForSite(site, doSend));
    } catch (e) {
      reports.push({ slug: site.slug, error: String(e.message || e) });
    }
  }

  res.status(200).json({
    ok: true,
    month: MONTH,
    generated: reports.length,
    aiEnabled: !!process.env.ANTHROPIC_API_KEY,
    emailEnabled: !!process.env.RESEND_API_KEY,
    reports,
  });
}
