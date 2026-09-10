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
import { buildFindings, clientActions, improvementsForClient, overallGrade } from '../lib/suggestions.js';
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

async function aiPolish({ site, stats, audit, grade, findings, improvements, actions, angle, wins, style, dropped }) {
  if (!process.env.ANTHROPIC_API_KEY) return { __error: 'no ANTHROPIC_API_KEY set' };
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (e) {
    return { __error: 'sdk import failed: ' + (e.message || e) };
  }
  const client = new Anthropic();
  // Sonnet 5 is the practical default here (widely available on any key, cheap
  // enough for monthly emails across dozens of sites). Set ANTHROPIC_MODEL to override.
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const system = [
    'You are the account manager at a small web studio (Inspiring Websites) writing the',
    'monthly performance update for a client who is NOT technical. Warm, specific, encouraging,',
    'never hype. This month\'s tone angle is "' + angle + '" — honour it so consecutive months',
    'do not read the same. Return ONLY minified JSON:',
    '{"headline":string,"summary":string,"improvements":[{"title":string,"why":string}],',
    '"client_actions":[{"title":string,"why":string}],"builder_notes":[string],',
    '"email":{"subject":string,"body_text":string}}.',
    'summary = 2-3 sentences.',
    'improvements = 2-4 things WE will do to the website, outcome-framed, no jargon.',
    'client_actions = 3-5 things the BUSINESS OWNER can do this month that do NOT involve the',
    'website: ask recent customers for a Google review, add the site link to their Google Business',
    'Profile / email signature / social posts / business cards / invoices, reply to new leads fast,',
    'share the link in local community groups.',
    'builder_notes = 2-5 blunt technical to-dos for the web developer only.',
    'email.body_text = the full email to ' + (site.client || 'the client') + ' (greet by name,',
    'sign off "— Inspiring Websites"), 140-210 words. Structure: lead with the wins, then',
    '"What we\'re working on next" (improvements), then "A few things that would help on your end"',
    '(2-3 client_actions). Weave in these exact facts: ' + JSON.stringify(wins) + '.',
    dropped
      ? 'THIS WAS A DOWN MONTH — visitors fell. Do NOT spin it. Open by acknowledging plainly that traffic dipped this month, then pivot to "here is exactly what we are changing so next month goes the other way" (use the improvements), stay calm and confident, and end reassuring them one quiet month is not a trend.'
      : '',
    style ? 'IMPORTANT revision instruction for this pass — rewrite the email and summary to be: "' + style + '". Apply it fully (tone, length, warmth, detail) but keep every fact accurate.' : '',
  ].join(' ');
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
    rule_improvements: improvements,
    rule_client_actions: actions,
  };
  try {
    const r = await client.messages.create({
      model,
      max_tokens: 8000,
      system,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });
    const t = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (!t.trim()) return { __error: 'model returned no text (stop_reason: ' + (r.stop_reason || '?') + ')' };
    // tolerate ```json fences or a preamble — grab the outermost {...}
    let raw = t.replace(/```json|```/g, '').trim();
    const a = raw.indexOf('{');
    const b = raw.lastIndexOf('}');
    if (a >= 0 && b > a) raw = raw.slice(a, b + 1);
    try {
      return JSON.parse(raw);
    } catch (pe) {
      return { __error: 'could not parse model JSON: ' + (pe.message || pe) + ' — first 120 chars: ' + t.slice(0, 120) };
    }
  } catch (e) {
    return { __error: 'model call failed: ' + (e.status ? e.status + ' ' : '') + (e.message || e) };
  }
}

async function sendEmail({ site, subject, body, cardPng, reportUrl, to }) {
  const dest = to || site.email;
  if (!process.env.RESEND_API_KEY) return { sent: false, reason: 'RESEND_API_KEY not set in Vercel' };
  if (!dest) return { sent: false, reason: 'no recipient — set the client email' };
  if (!process.env.REPORT_FROM) return { sent: false, reason: 'REPORT_FROM not set in Vercel (must be an address on a Resend-verified domain)' };
  let Resend;
  try {
    ({ Resend } = await import('resend'));
  } catch {
    return { sent: false, reason: 'resend package not installed' };
  }
  const resend = new Resend(process.env.RESEND_API_KEY);
  const from = process.env.REPORT_FROM;

  // is the sending domain actually verified?
  let domainStatus = 'unknown';
  try {
    const fromDomain = from.split('@')[1] || '';
    const dl = await resend.domains.list();
    const list = dl?.data?.data || dl?.data || [];
    const d = Array.isArray(list) ? list.find((x) => x.name === fromDomain) : null;
    domainStatus = d ? d.status : `no domain "${fromDomain}" in this Resend account`;
  } catch (e) {
    domainStatus = 'could not check (' + (e.message || e) + ')';
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<div style="font:16px/1.65 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#12160f;max-width:580px">
    ${body.split('\n').map((p) => (p.trim() ? `<p style="margin:0 0 13px">${esc(p)}</p>` : '<div style="height:6px"></div>')).join('')}
    ${reportUrl ? `<p style="margin:18px 0 0"><a href="${esc(reportUrl)}" style="background:#1f6f4d;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;display:inline-block">View your full report</a></p>` : ''}
  </div>`;
  const attachments = cardPng
    ? [{ filename: `${site.slug}-report-${MK}.png`, content: cardPng.toString('base64') }]
    : [];
  try {
    const r = await resend.emails.send({ from, to: dest, subject, text: body, html, attachments });
    const accepted = !r.error;
    return {
      sent: accepted && domainStatus === 'verified',
      accepted,
      id: r.data?.id || null,
      to: dest,
      from,
      domainStatus,
      reason:
        r.error?.message ||
        (domainStatus !== 'verified'
          ? `Resend took the message (id ${r.data?.id || '?'}) but won't deliver it yet — the sending domain ${from.split('@')[1]} shows "${domainStatus}", not "verified". It'll go out on its own once that flips.`
          : null),
    };
  } catch (e) {
    return { sent: false, to: dest, from, domainStatus, reason: String(e.message || e) };
  }
}

async function buildForSite(site, { doSend, req, style }) {
  const [stats, audit, changelog] = await Promise.all([
    siteStats(site.slug, site.conversionEvents || []).catch(() => null),
    runAudit(site.url, { fresh: true }).catch(() => ({ ok: false, error: 'audit failed' })),
    readLog(site.slug),
  ]);
  const grade = overallGrade(audit, stats);
  const findings = buildFindings(audit, stats);
  const improvements = improvementsForClient(audit, stats);
  const actions = clientActions(audit, stats, site);

  const row =
    (await snapshot(site.slug, {
      seo: audit?.ok ? audit.scores.seo : null,
      perf: audit?.ok ? audit.scores.performance : null,
      a11y: audit?.ok ? audit.scores.accessibility : null,
      grade,
      visitors: stats?.visitors || 0,
      conversions: stats?.conversions || 0,
      pageviews: stats?.pageviews || 0,
    }).catch(() => null)) || {
      seo: audit?.ok ? audit.scores.seo : null,
      visitors: stats?.visitors || 0,
      conversions: stats?.conversions || 0,
      pageviews: stats?.pageviews || 0,
    };
  const history = await getHistory(site.slug).catch(() => []);
  const baseline = await getBaseline(site.slug).catch(() => null);
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
    improvements,
    clientActions: actions,
    changelog,
    reportUrl,
    signature: process.env.REPORT_SIGNATURE || 'Inspiring Websites',
    reviewUrl: site.reviewUrl,
    leadValue: site.leadValue || 0,
  });

  const aiRaw = await aiPolish({
    site,
    stats,
    audit,
    grade,
    findings,
    improvements,
    actions,
    angle,
    wins: rules.wins,
    style,
    dropped: rules.dropped,
  }).catch((e) => ({ __error: 'aiPolish threw: ' + (e.message || e) }));
  const aiError = aiRaw && aiRaw.__error ? aiRaw.__error : null;
  const ai = aiError ? null : aiRaw;

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
    improvements: ai?.improvements || improvements,
    clientActions: ai?.client_actions || actions,
    builderFindings: findings,
    builderExtra: ai?.builder_notes || [],
    email,
    reportUrl,
    metrics: row,
    aiGenerated: !!ai,
    aiError,
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

  return { ...report, emailResult, aiUsed: !!ai, aiError };
}

// Fast path: reword the email only. Reuses the last report's numbers, skips the
// fresh audit + history snapshot. Cheap enough to hit on every "regenerate".
async function regenEmail(site, { style, req }) {
  const prevRaw = await store.get(`report:${site.slug}:latest`).catch(() => null);
  const prev = prevRaw ? (typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw) : null;
  const [stats, audit, changelog] = await Promise.all([
    siteStats(site.slug, site.conversionEvents || []).catch(() => null),
    runAudit(site.url).catch(() => ({ ok: false })),
    readLog(site.slug),
  ]);
  const grade = overallGrade(audit, stats) || prev?.grade || null;
  const findings = buildFindings(audit, stats);
  const improvements = prev?.improvements?.length ? prev.improvements : improvementsForClient(audit, stats);
  const actions = prev?.clientActions?.length ? prev.clientActions : clientActions(audit, stats, site);
  const history = await getHistory(site.slug);
  const baseline = await getBaseline(site.slug);
  const msl = monthsSince(baseline, history);
  const angle = prev?.angle || pickAngle(msl);
  const row = prev?.metrics || {
    seo: audit?.ok ? audit.scores.seo : null,
    visitors: stats?.visitors || 0,
    conversions: stats?.conversions || 0,
  };
  const tok = reportToken(site.slug);
  const reportUrl = baseUrl(req) ? `${baseUrl(req)}/r/${site.slug}${tok ? `?t=${tok}` : ''}` : prev?.reportUrl || '';

  const rules = buildClientEmail({
    biz: site.name, client: site.client || 'there', month: MK, monthsSinceLaunch: msl,
    history, baseline, row, improvements, clientActions: actions, changelog, reportUrl,
    signature: process.env.REPORT_SIGNATURE || 'Inspiring Websites',
    reviewUrl: site.reviewUrl, leadValue: site.leadValue || 0,
  });
  const aiRaw = await aiPolish({ site, stats, audit, grade, findings, improvements, actions, angle, wins: rules.wins, style, dropped: rules.dropped }).catch((e) => ({ __error: 'aiPolish threw: ' + (e.message || e) }));
  const aiError = aiRaw && aiRaw.__error ? aiRaw.__error : null;
  const ai = aiError ? null : aiRaw;
  const email = ai?.email || { subject: rules.subject, body_text: rules.body_text };

  const report = {
    ...(prev || {}),
    slug: site.slug, name: site.name, month: MONTH, monthKey: MK, angle,
    generatedAt: Date.now(), grade,
    headline: ai?.headline || prev?.headline || `${site.name} — ${MONTH}`,
    summary: ai?.summary || prev?.summary || rules.wins.join(' '),
    wins: rules.wins,
    improvements: ai?.improvements || improvements,
    clientActions: ai?.client_actions || actions,
    email, reportUrl, metrics: row, aiGenerated: !!ai, aiError, lastStyle: style || null,
  };
  await store.set(`report:${site.slug}:latest`, JSON.stringify(report));
  await store.set(`report:${site.slug}:${MK}`, JSON.stringify(report));
  return { ...report, aiUsed: !!ai, aiError };
}

// Fast "Send now": email the report that's already on file. No fresh audit, no
// AI, no history snapshot — just render the card and send, so it can't hit the
// 60s function limit the way a full rebuild can.
async function sendLatest(site, { req }) {
  const prevRaw = await store.get(`report:${site.slug}:latest`).catch(() => null);
  const prev = prevRaw ? (typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw) : null;
  if (!prev || !prev.email) {
    // nothing generated yet — fall back to a full build (may be slow)
    return buildForSite(site, { doSend: true, req });
  }
  const history = await getHistory(site.slug).catch(() => []);
  const row = prev.metrics || {};
  const grade = prev.grade || null;
  let cardPng = null;
  try {
    cardPng = await renderPNG(buildCardSVG({ biz: site.name, url: site.url, month: MONTH, row, history, grade }));
  } catch {
    cardPng = null;
  }
  const emailResult = await sendEmail({
    site,
    subject: prev.email.subject,
    body: prev.email.body_text,
    cardPng,
    reportUrl: prev.reportUrl,
  });
  if (emailResult.sent) await store.set(`lastSent:${site.slug}`, MK);
  return { ...prev, emailResult, aiUsed: !!prev.aiGenerated, aiError: prev.aiError || null };
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad secret' });

  const all = await listSites();
  const only = req.query.slug ? all.filter((s) => s.slug === req.query.slug) : all;
  const doSend = req.query.send === '1';
  const emailOnly = req.query.emailonly === '1';
  const rebuild = req.query.rebuild === '1'; // force a full fresh build + send
  const style = String(req.query.style || '').slice(0, 140);

  const reports = [];
  for (const site of only) {
    try {
      if (emailOnly && !doSend) reports.push(await regenEmail(site, { style, req }));
      else if (doSend && !rebuild) reports.push(await sendLatest(site, { req }));
      else reports.push(await buildForSite(site, { doSend, req, style }));
    } catch (e) {
      const msg = String(e.message || e);
      reports.push({
        slug: site.slug,
        error: msg,
        emailResult: { sent: false, reason: `couldn't build the report before sending — ${msg}` },
      });
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
