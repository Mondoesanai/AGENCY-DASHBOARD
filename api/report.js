// Build (and optionally send) the monthly client report.
//   /api/report?secret=SECRET                 -> all sites, generate only
//   /api/report?secret=SECRET&slug=relax-tax  -> one site
//   ...&send=1                                 -> also email it (needs Resend + client email)
//
// Always: snapshots this month's numbers, builds a rotating client email, and
// (on send) attaches a branded PNG report card + links the shareable report page.
import { listSites } from '../lib/registry.js';
import { runAudit } from '../lib/audit.js';
import { siteStats } from '../lib/stats.js';
import { buildFindings, clientSuggestions, overallGrade } from '../lib/suggestions.js';
import { snapshot, getHistory, getBaseline, monthKey } from '../lib/history.js';
import { buildClientEmail, pickAngle } from '../lib/email.js';
import { buildCardSVG, renderPNG } from '../lib/card.js';
import { reportToken } from '../lib/token.js';
import { store } from '../lib/store.js';

const MONTH = new Date().toLocaleString('en-US', { month: 'long', year: 'numeric' });
const MK = monthKey();

function authed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${secret}` || req.query.secret === secret;
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host}` : '';
}

async function readLog(slug) {
  const raw = await store.get(`changelog:${slug}`).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function monthsSince(baseline, history) {
  if (baseline?.month) {
    const [by, bm] = baseline.month.split('-').map(Number);
    const now = new Date();
    return (now.getUTCFullYear() - by) * 12 + (now.getUTCMonth() + 1 - bm);
  }
  return Math.max(0, (history?.length || 1) - 1);
}

async function aiPolish({ site, stats, audit, grade, findings, suggestions, angle, wins }) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch {
    return null;
  }
  const client = new Anthropic();
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5';
  const system =
    'You are the account manager at a small web studio (Inspiring Websites) writing the ' +
    'monthly performance update for a client who is NOT technical. Warm, specific, ' +
    'encouraging, never hype. This month\'s tone angle is "' + angle + '" — honour it so ' +
    'consecutive months do not read the same. Return ONLY minified JSON: ' +
    '{"headline":string,"summary":string,"client_suggestions":[{"title":string,"why":string}],' +
    '"builder_notes":[string],"email":{"subject":string,"body_text":string}}. ' +
    'summary = 2-3 sentences. client_suggestions = 3-5, outcome-framed, no jargon. ' +
    'builder_notes = 2-5 blunt technical to-dos for the web developer only. ' +
    'email.body_text = the full email to ' + (site.client || 'the client') +
    ' (greet them by name, sign off "— Inspiring Websites"), 130-200 words, lead with the ' +
    'wins provided, then what we are improving next. Weave in these exact facts: ' + JSON.stringify(wins) + '.';
  const payload = {
    business: site.name,
    month: MONTH,
    angle,
    grade,
    scores: audit?.ok ? audit.scores : null,
    metrics: stats && {
      visitors: stats.visitors,
      conversions: stats.conversions,
      change: stats.deltas,
      topPages: stats.topPages,
      sources: stats.sources,
    },
    rule_findings: findings.slice(0, 8),
    rule_client_suggestions: suggestions,
  };
  try {
    const r = await client.messages.create({
      model,
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
    const t = r.content.find((b) => b.type === 'text')?.text || '';
    return JSON.parse(t.replace(/^```json\s*|\s*```$/g, '').trim());
  } catch {
    return null;
  }
}

async function sendEmail({ site, subject, body, cardPng, reportUrl }) {
  if (!process.env.RESEND_API_KEY || !site.email) return { sent: false, reason: 'no resend key or client email' };
  let Resend;
  try {
    ({ Resend } = await import('resend'));
  } catch {
    return { sent: false, reason: 'resend not installed' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.REPORT_FROM || 'reports@example.com';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<div style="font:16px/1.65 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#12160f;max-width:580px">
    ${body.split('\n').map((p) => (p.trim() ? `<p style="margin:0 0 13px">${esc(p)}</p>` : '<div style="height:6px"></div>')).join('')}
    ${reportUrl ? `<p style="margin:18px 0 0"><a href="${esc(reportUrl)}" style="background:#1f6f4d;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;display:inline-block">View your full report</a></p>` : ''}
  </div>`;
  const attachments = cardPng
    ? [{ filename: `${site.slug}-report-${MK}.png`, content: cardPng.toString('base64') }]
    : [];
  try {
    const r = await resend.emails.send({ from, to: site.email, subject, text: body, html, attachments });
    return { sent: !r.error, id: r.data?.id, reason: r.error?.message };
  } catch (e) {
    return { sent: false, reason: String(e.message || e) };
  }
}

async function buildForSite(site, { doSend, req }) {
  const [stats, audit, changelog] = await Promise.all([
    siteStats(site.slug).catch(() => null),
    runAudit(site.url, { fresh: true }).catch(() => ({ ok: false, error: 'audit failed' })),
    readLog(site.slug),
  ]);
  const grade = overallGrade(audit, stats);
  const findings = buildFindings(audit, stats);
  const suggestions = clientSuggestions(audit, stats);

  const row = await snapshot(site.slug, {
    seo: audit?.ok ? audit.scores.seo : null,
    perf: audit?.ok ? audit.scores.performance : null,
    a11y: audit?.ok ? audit.scores.accessibility : null,
    grade,
    visitors: stats?.visitors || 0,
    conversions: stats?.conversions || 0,
    pageviews: stats?.pageviews || 0,
  });
  const history = await getHistory(site.slug);
  const baseline = await getBaseline(site.slug);
  const msl = monthsSince(baseline, history);
  const angle = pickAngle(msl);
  const tok = reportToken(site.slug);
  const reportUrl = baseUrl(req)
    ? `${baseUrl(req)}/r/${site.slug}${tok ? `?t=${tok}` : ''}`
    : '';

  const rules = buildClientEmail({
    biz: site.name,
    client: site.client || 'there',
    month: MK,
    monthsSinceLaunch: msl,
    history,
    baseline,
    row,
    clientSuggestions: suggestions,
    changelog,
    reportUrl,
    signature: process.env.REPORT_SIGNATURE || 'Inspiring Websites',
    reviewUrl: site.reviewUrl,
    leadValue: site.leadValue || 0,
  });

  const ai = await aiPolish({
    site,
    stats,
    audit,
    grade,
    findings,
    suggestions,
    angle,
    wins: rules.wins,
  }).catch(() => null);

  const email = ai?.email || { subject: rules.subject, body_text: rules.body_text };

  const report = {
    slug: site.slug,
    name: site.name,
    month: MONTH,
    monthKey: MK,
    angle,
    monthsSinceLaunch: msl,
    generatedAt: Date.now(),
    grade,
    headline: ai?.headline || `${site.name} — ${MONTH}`,
    summary: ai?.summary || rules.wins.join(' '),
    wins: rules.wins,
    clientSuggestions: ai?.client_suggestions || suggestions,
    builderFindings: findings,
    builderExtra: ai?.builder_notes || [],
    email,
    reportUrl,
    metrics: row,
    aiGenerated: !!ai,
  };
  await store.set(`report:${site.slug}:latest`, JSON.stringify(report));
  await store.set(`report:${site.slug}:${MK}`, JSON.stringify(report));

  let emailResult = { sent: false, reason: 'send not requested' };
  if (doSend) {
    let cardPng = null;
    try {
      cardPng = await renderPNG(buildCardSVG({ biz: site.name, url: site.url, month: MONTH, row, history, grade }));
    } catch {
      cardPng = null;
    }
    emailResult = await sendEmail({ site, subject: email.subject, body: email.body_text, cardPng, reportUrl });
    if (emailResult.sent) await store.set(`lastSent:${site.slug}`, MK);
  }

  return { ...report, emailResult };
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad secret' });

  const all = await listSites();
  const only = req.query.slug ? all.filter((s) => s.slug === req.query.slug) : all;
  const doSend = req.query.send === '1';

  const reports = [];
  for (const site of only) {
    try {
      reports.push(await buildForSite(site, { doSend, req }));
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

export { buildForSite };
