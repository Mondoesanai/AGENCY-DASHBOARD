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
import { summarizeRanks, readRankHistory, readPrevRanks, keywordTable } from '../lib/ranks.js';

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

// Merge the manual "what we did this month" log with to-dos the AI has
// auto-shipped since the last check — so "This month we also worked on..."
// in the client email reflects real automated work, not just what Mondo
// typed by hand. Only the last ~35 days' worth (one billing cycle + buffer).
async function withAutoShipped(slug, changelog) {
  const raw = await store.get(`todos:completed:${slug}`).catch(() => null);
  let done = [];
  try {
    done = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  } catch {
    done = [];
  }
  const cutoff = Date.now() - 35 * 864e5;
  const auto = done
    .filter((x) => x.addressedAt && x.addressedAt >= cutoff)
    .map((x) => ({ date: new Date(x.addressedAt).toISOString().slice(0, 10), text: x.title, source: x.source }));
  return [...changelog, ...auto];
}

function monthsSince(baseline, history) {
  if (baseline?.month) {
    const [by, bm] = baseline.month.split('-').map(Number);
    const now = new Date();
    return (now.getUTCFullYear() - by) * 12 + (now.getUTCMonth() + 1 - bm);
  }
  return Math.max(0, (history?.length || 1) - 1);
}

async function readJson(key) {
  const raw = await store.get(key).catch(() => null);
  try {
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    return null;
  }
}

// Everything real we know about this site's period, in one place — so the
// report can talk about actual rankings movement and actual shipped work
// instead of only visitor counts. The old prompt only ever saw traffic and
// audit scores, which is why "what we're doing" read as a generic "we're
// making it faster on mobile" no matter what had really happened.
async function buildReportContext(site, stats, changelog, period) {
  const cutoff = Date.now() - (period === 'biweekly' ? 16 : 35) * 864e5;
  const shippedWork = (changelog || [])
    .filter((c) => (Date.parse(c.date) || 0) >= cutoff)
    .map((c) => ({ date: c.date, what: c.text, askedForByClient: c.source === 'revision' }));
  const [cur, prev, hist, lastReport] = await Promise.all([
    readJson(`agent:ranks:${site.slug}`),
    readPrevRanks(site.slug),
    readRankHistory(site.slug).catch(() => []),
    readJson(`report:${site.slug}:latest`),
  ]);
  const summary = summarizeRanks(cur);
  return {
    period: period === 'biweekly' ? 'the last two weeks' : 'this past month',
    rankings: summary
      ? {
          checkedAt: summary.checkedAt ? new Date(summary.checkedAt).toISOString().slice(0, 10) : null,
          keywordsTracked: summary.tracked,
          averagePosition: summary.avgRank,
          bestPosition: summary.bestRank,
          inTop3: summary.inTop3,
          inTop10: summary.inTop10,
          notInTop100Count: summary.tracked - summary.found,
          pagesGoogleHasIndexed: summary.indexed ? summary.indexed.count : null,
          competingPagesEstimate: summary.roughField,
          keywords: keywordTable(cur, prev).slice(0, 12),
          topCompetitors: (summary.competitors || []).slice(0, 4).map((c) => c.domain),
          checksSoFar: hist.length,
          firstAveragePosition: hist.length > 1 ? hist[0].avgRank : null,
        }
      : null,
    shippedWork,
    enquiriesByType: (stats?.events || []).slice(0, 8),
    enquirySources: (stats?.leadSources || []).slice(0, 6),
    deviceSplit: stats?.device || null,
    avgSecondsOnSite: stats?.avgDwell ?? null,
    previousClientActions: (lastReport?.clientActions || []).map((a) => a.title).slice(0, 6),
  };
}

async function aiPolish({ site, stats, audit, grade, findings, improvements, actions, angle, wins, style, dropped, changelog, period }) {
  const ctx = await buildReportContext(site, stats, changelog, period).catch(() => ({}));
  if (!process.env.ANTHROPIC_API_KEY) return { __error: 'no ANTHROPIC_API_KEY set' };
  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (e) {
    return { __error: 'sdk import failed: ' + (e.message || e) };
  }
  // Hard per-call timeout, no retries. The whole report has to fit inside a 60s
  // serverless function alongside everything else, and a model call still running
  // when the function is killed means the client's email NEVER sends. A live test
  // showed one big report call taking over 45s. A call that times out here just
  // falls back to the rule-based email, which still goes out.
  const client = new Anthropic({ maxRetries: 0, timeout: Number(process.env.REPORT_MODEL_TIMEOUT_MS) || 36000 });
  // Sonnet 5 is the practical default here (widely available on any key, cheap
  // enough for monthly emails across dozens of sites). Set ANTHROPIC_MODEL to override.
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
  const biweekly = period === 'biweekly';
  const system = [
    'You are the account manager at a small web studio (Inspiring Websites) writing the',
    (biweekly ? 'two-week check-in' : 'monthly performance update') + ' for a client who is NOT technical. Warm, specific, encouraging,',
    'never hype, never vague. This time\'s tone angle is "' + angle + '" — honour it so consecutive',
    'updates do not read the same. Every claim must come from the data you are given — NEVER invent',
    'a ranking, a number, or a piece of work that is not in the data. Return ONLY minified JSON:',
    '{"headline":string,"summary":string,"progress":string,"work_done":[{"title":string,"detail":string}],',
    '"improvements":[{"title":string,"why":string}],',
    '"client_actions":[{"title":string,"why":string,"target":string}],"builder_notes":[string],',
    '"email":{"subject":string,"body_text":string}}.',
    'summary = 2-3 sentences.',
    'progress = 2-4 sentences on Google ranking progress using the rankings data: average position,',
    'how many keywords are in the top 10 / top 3, which specific keywords moved and by how much',
    '(name them), and — if nothing ranks yet — say honestly that a new site typically takes 1-3 months of',
    'steady work to break into the results, that we are tracking it every few days, and what the',
    'estimated competing-pages number is doing. Reassuring but truthful; if positions dropped, say so plainly.',
    'work_done = 3-7 items: what WE actually did for the site in this period, taken ONLY from shippedWork',
    '(plain-English, benefit-framed: what changed and why it helps them get found), plus the fact that rankings',
    'were re-checked. title = short outcome, detail = one plain sentence. If shippedWork is thin, list fewer',
    'items — never pad or invent.',
    'improvements = 2-4 things WE will do NEXT, specific to their data (name the page / keyword), no jargon.',
    'NEVER promise image compression or resizing, colour / contrast / font / layout changes, or anything about\n    the visual design — this system does not do those automatically, so promising them is a broken promise.',
    'Only promise the kind of work it really does: search titles and descriptions, structured data, sitemap,',
    'image descriptions, loading hints, new pages, and targeting specific searches.',
    'client_actions = 3-4 things the BUSINESS OWNER can do THIS WEEK to help their site grow. They must be',
    'SPECIFIC and MEASURABLE, built from their own numbers, and never generic. Each one has: title (the exact',
    'action), why (one sentence tying it to THEIR data — a real page, keyword, traffic source, or enquiry count',
    'from the data), and target (a concrete number + timeframe, e.g. "10 people tapping Book Now by Sunday").',
    'Good: "Text your booking link to 10 past customers this week — your report will show how many tapped it',
    'under Enquiry sources." Good: "Post your top page (/rankings) in the group where most of your visitors',
    'come from (social: 247 visits) — aim for 25 clicks." BAD (never write these): "ask for a Google review",',
    '"share on social media", "add the link to your email signature" with no number, no how, no tie to data.',
    'Do NOT repeat any of previousClientActions. Prefer actions whose result we can measure in the next report.',
    'builder_notes = 2-5 blunt technical to-dos for the web developer only.',
    'email.body_text = the full email to ' + (site.client || 'the client') + ' (greet by name,',
    'sign off "— Inspiring Websites"), 230-320 words, plain text with short paragraphs and simple "•" bullets.',
    'Structure: (1) one-line headline of how things are going, (2) "Where you rank in Google" — the real',
    'numbers from progress, (3) "What we did" — 3-5 bullets from work_done, (4) "Your plan for this week" —',
    '2-3 client_actions each with its target number, (5) one sentence on what to expect next.',
    'Weave in these exact facts: ' + JSON.stringify(wins) + '.',
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
    ...ctx,
  };
  // Three small calls IN PARALLEL: generation time is dominated by output length, and
  // two half-report calls still hit the 36s timeout on two real sites (dashboard
  // showed "AI polish failed — using the rules version"). Each part is ~500 tokens.
  // If a part is slow or fails, it is retried ONCE on the fast model instead of
  // dropping the whole report to the generic fallback.
  const parts = [
    'PART A of 3 — return ONLY these keys: headline, summary, progress, improvements, builder_notes. Leave out work_done, client_actions and email.',
    'PART B of 3 — return ONLY these keys: work_done and client_actions. Leave out everything else.',
    'PART C of 3 — return ONLY the key: email. It must contain the real ranking line and the "what we did" bullets and the weekly plan with target numbers, all taken from the data.',
  ];
  const env = Number(process.env.REPORT_MODEL_TIMEOUT_MS);
  const attempt = async (mdl, ms, part) => {
    try {
      const resp = await client.messages.create(
        { model: mdl, max_tokens: 2200, system: system + ' ' + part, messages: [{ role: 'user', content: JSON.stringify(payload) }] },
        { timeout: ms }
      );
      const t = (resp.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');
      if (!t.trim()) return { __error: 'model returned no text (stop_reason: ' + (resp.stop_reason || '?') + ')' };
      // tolerate ```json fences or a preamble — grab the outermost {...}
      let raw = t.replace(/```json|```/g, '').trim();
      const i = raw.indexOf('{');
      const j = raw.lastIndexOf('}');
      if (i >= 0 && j > i) raw = raw.slice(i, j + 1);
      try {
        return JSON.parse(raw);
      } catch (pe) {
        return { __error: 'could not parse model JSON: ' + (pe.message || pe) + ' — first 120 chars: ' + t.slice(0, 120) };
      }
    } catch (e) {
      return { __error: 'model call failed: ' + (e.status ? e.status + ' ' : '') + (e.message || e) };
    }
  };
  const one = async (part) => {
    const first = await attempt(model, env || 24000, part);
    if (!first.__error) return first;
    return attempt('claude-haiku-4-5-20251001', env || 12000, part);
  };
  const [pa, pb, pc] = await Promise.all(parts.map(one));
  const bad = [pa, pb, pc].find((x) => x.__error);
  if (bad) return { __error: bad.__error };
  return { ...pa, ...pb, ...pc };
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

// The audit's generic "fixes" include things this system deliberately never
// does on its own (compress/resize images, change colours or contrast, fonts,
// layout). A client report that says "we're working on compressing your hero
// image" is a promise nobody is going to keep, so those never reach the report.
const NOT_AUTOMATED = /compress|resiz|hero image|webp|contrast|grey|gray|colou?r|font|layout|spacing|darken|lighten|image size|largest content|\blcp\b/i;
const doable = (x) => !NOT_AUTOMATED.test(`${x?.title || ''} ${x?.why || ''}`);

async function auditWithin(url, { fresh, cachedOnly, ms }) {
  const bad = { ok: false, error: 'audit failed' };
  if (cachedOnly) return runAudit(url, { cachedOnly: true }).catch(() => bad);
  const live = runAudit(url, { fresh }).catch(() => bad);
  const first = await Promise.race([live, new Promise((resolve) => setTimeout(() => resolve(null), ms))]);
  if (first) return first;
  return runAudit(url, { cachedOnly: true }).catch(() => bad);
}

async function buildForSite(site, { doSend, req, style, isBatch, period, sentKey, fast }) {
  const [stats, audit, changelogRaw] = await Promise.all([
    siteStats(site.slug, site.conversionEvents || []).catch(() => null),
    // A live speed test can take 15-40s by itself, and the model call comes after
    // it inside the same 60s function — so wait for a fresh one only briefly, then
    // settle for the cached scores. fast: never wait at all (background refresh).
    auditWithin(site.url, { fresh: !isBatch && !fast, cachedOnly: !!fast, ms: 8000 }),
    readLog(site.slug),
  ]);
  const changelog = await withAutoShipped(site.slug, changelogRaw);
  const grade = overallGrade(audit, stats);
  const findings = buildFindings(audit, stats);
  const improvements = improvementsForClient(audit, stats).filter(doable);
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

  // "Generate all" pressed twice in a day shouldn't pay for AI twice — reuse
  // today's AI wording if there is one; numbers/audit above are still fresh.
  let prevForSkip = null;
  if (isBatch) {
    const prevRaw = await store.get(`report:${site.slug}:latest`).catch(() => null);
    prevForSkip = prevRaw ? (typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw) : null;
  }
  const skipAi = isBatch && prevForSkip?.aiGenerated && prevForSkip?.generatedAt &&
    new Date(prevForSkip.generatedAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);

  let ai, aiError;
  if (skipAi) {
    ai = { email: prevForSkip.email, headline: prevForSkip.headline, summary: prevForSkip.summary, progress: prevForSkip.progress, work_done: prevForSkip.workDone, improvements: prevForSkip.improvements, client_actions: prevForSkip.clientActions, builder_notes: prevForSkip.builderExtra };
    aiError = null;
  } else {
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
      changelog,
      period,
    }).catch((e) => ({ __error: 'aiPolish threw: ' + (e.message || e) }));
    aiError = aiRaw && aiRaw.__error ? aiRaw.__error : null;
    ai = aiError ? null : aiRaw;
  }

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
    reportVersion: 2, // bump to have the automation regenerate every stored report once
    progress: ai?.progress || '',
    workDone: ai?.work_done || [],
    period: period || 'monthly',
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
    if (emailResult.sent) await store.set(sentKey || `lastSent:${site.slug}`, MK);
  }

  return { ...report, emailResult, aiUsed: !!ai, aiError };
}

// Fast path: reword the email only. Reuses the last report's numbers, skips the
// fresh audit + history snapshot. Cheap enough to hit on every "regenerate".
async function regenEmail(site, { style, req }) {
  const prevRaw = await store.get(`report:${site.slug}:latest`).catch(() => null);
  const prev = prevRaw ? (typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw) : null;
  const [stats, audit, changelogRaw] = await Promise.all([
    siteStats(site.slug, site.conversionEvents || []).catch(() => null),
    runAudit(site.url).catch(() => ({ ok: false })),
    readLog(site.slug),
  ]);
  const changelog = await withAutoShipped(site.slug, changelogRaw);
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
  const aiRaw = await aiPolish({ site, stats, audit, grade, findings, improvements, actions, angle, wins: rules.wins, style, dropped: rules.dropped, changelog, period: prev?.period }).catch((e) => ({ __error: 'aiPolish threw: ' + (e.message || e) }));
  const aiError = aiRaw && aiRaw.__error ? aiRaw.__error : null;
  const ai = aiError ? null : aiRaw;
  const email = ai?.email || { subject: rules.subject, body_text: rules.body_text };

  const report = {
    ...(prev || {}),
    slug: site.slug, name: site.name, month: MONTH, monthKey: MK, angle,
    generatedAt: Date.now(), grade,
    headline: ai?.headline || prev?.headline || `${site.name} — ${MONTH}`,
    summary: ai?.summary || prev?.summary || rules.wins.join(' '),
    reportVersion: 2,
    progress: ai?.progress || prev?.progress || '',
    workDone: ai?.work_done || prev?.workDone || [],
    period: prev?.period || 'monthly',
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
// Fast "Send now": no fresh PageSpeed scan, no AI call (that's what "Regenerate
// email" is for) — but the NUMBERS are always recomputed live from the tracker
// right before sending. A stored report can be hours or days old; what actually
// goes out to the client never should be. siteStats()/cached-audit are just KV
// reads, so this stays well under the timeout that a full rebuild risks.
async function sendLatest(site, { req }) {
  const prevRaw = await store.get(`report:${site.slug}:latest`).catch(() => null);
  const prev = prevRaw ? (typeof prevRaw === 'string' ? JSON.parse(prevRaw) : prevRaw) : null;
  if (!prev || !prev.email) {
    // nothing generated yet — fall back to a full build (may be slow)
    return buildForSite(site, { doSend: true, req });
  }

  const [stats, audit, changelogRaw, history, baseline] = await Promise.all([
    siteStats(site.slug, site.conversionEvents || []).catch(() => null),
    runAudit(site.url).catch(() => ({ ok: false })), // cache-preferring, not forced-fresh — fast
    readLog(site.slug),
    getHistory(site.slug).catch(() => []),
    getBaseline(site.slug),
  ]);
  const changelog = await withAutoShipped(site.slug, changelogRaw);
  const grade = overallGrade(audit, stats) || prev.grade || null;
  const row = {
    seo: audit?.ok ? audit.scores.seo : prev.metrics?.seo ?? null,
    perf: audit?.ok ? audit.scores.performance : prev.metrics?.perf,
    visitors: stats?.visitors ?? prev.metrics?.visitors ?? 0,
    conversions: stats?.conversions ?? prev.metrics?.conversions ?? 0,
    pageviews: stats?.pageviews ?? prev.metrics?.pageviews ?? 0,
  };
  const msl = monthsSince(baseline, history);
  const improvements = prev.improvements?.length ? prev.improvements : improvementsForClient(audit, stats);
  const actions = prev.clientActions?.length ? prev.clientActions : clientActions(audit, stats, site);
  const reportUrl = prev.reportUrl || '';

  // rebuild the email body with today's real numbers — rules-based, free, no
  // AI call. If the last "Regenerate email" happened today, keep that AI
  // wording (it's already current); otherwise fresh rules text beats stale
  // AI text with yesterday's — or last week's — numbers baked into the sentences.
  const rules = buildClientEmail({
    biz: site.name, client: site.client || 'there', month: MK, monthsSinceLaunch: msl,
    history, baseline, row, improvements, clientActions: actions, changelog, reportUrl,
    signature: process.env.REPORT_SIGNATURE || 'Inspiring Websites',
    reviewUrl: site.reviewUrl, leadValue: site.leadValue || 0,
  });
  const generatedToday = prev.generatedAt && new Date(prev.generatedAt).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10);
  const email = generatedToday && prev.aiGenerated ? prev.email : { subject: rules.subject, body_text: rules.body_text };

  let cardPng = null;
  try {
    cardPng = await renderPNG(buildCardSVG({ biz: site.name, url: site.url, month: MONTH, row, history, grade }));
  } catch {
    cardPng = null;
  }
  const emailResult = await sendEmail({ site, subject: email.subject, body: email.body_text, cardPng, reportUrl });
  if (emailResult.sent) await store.set(`lastSent:${site.slug}`, MK);

  const updated = { ...prev, grade, metrics: row, email, emailResult, aiUsed: !!(generatedToday && prev.aiGenerated), aiError: prev.aiError || null };
  await store.set(`report:${site.slug}:latest`, JSON.stringify(updated));
  return updated;
}

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad secret' });

  const t0 = Date.now();
  const all = await listSites();
  const only = req.query.slug ? all.filter((s) => s.slug === req.query.slug) : all;
  const doSend = req.query.send === '1';
  const emailOnly = req.query.emailonly === '1';
  const rebuild = req.query.rebuild === '1'; // force a full fresh build + send
  const style = String(req.query.style || '').slice(0, 140);
  // "Generate all" (no ?slug=, more than one site) is a batch pass — go easy
  // on the AI/PageSpeed budget for it (no forced-fresh scan, skip the AI call
  // if today's report already has one) unlike an explicit single-site
  // "Regenerate", which always does a real fresh rebuild on request.
  const isBatch = !req.query.slug && only.length > 1;
  const HARD_LIMIT_MS = 55000;

  const reports = [];
  for (const site of only) {
    if (isBatch && Date.now() - t0 > HARD_LIMIT_MS) {
      reports.push({ slug: site.slug, skipped: true, reason: 'out of time this run — press Generate all again, or it catches up in tonight’s automatic pass' });
      continue;
    }
    try {
      if (emailOnly && !doSend) reports.push(await regenEmail(site, { style, req }));
      else if (doSend && !rebuild) reports.push(await sendLatest(site, { req }));
      else reports.push(await buildForSite(site, { doSend, req, style, isBatch }));
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
