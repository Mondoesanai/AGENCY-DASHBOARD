// Compass — the in-dashboard business coach. Reads the live portfolio + money
// numbers and answers founder-to-founder. Admin-gated. Tracks its own spend
// against a soft daily budget and a monthly cap (COACH_MONTHLY_BUDGET, default 15).
import { listSites } from '../lib/registry.js';
import { siteStats } from '../lib/stats.js';
import { runAudit } from '../lib/audit.js';
import { store } from '../lib/store.js';

function authed(req) {
  const s = process.env.CRON_SECRET;
  if (!s) return true;
  const h = req.headers.authorization || '';
  return h === `Bearer ${s}` || req.query.secret === s;
}

const DAY = () => new Date().toISOString().slice(0, 10);
const MONTH = () => new Date().toISOString().slice(0, 7);
const MONTHLY_CAP = Math.max(1, Number(process.env.COACH_MONTHLY_BUDGET || 15));
const DAILY_SOFT = +(MONTHLY_CAP / 20).toFixed(2); // ~20 working days
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

async function readNum(key) {
  const v = await store.get(key).catch(() => null);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
async function addSpend(usd) {
  if (!usd) return;
  for (const k of [`coach:spend:${DAY()}`, `coach:spend:${MONTH()}`]) {
    const cur = await readNum(k);
    await store.set(k, String(+(cur + usd).toFixed(5)), { ex: 60 * 60 * 24 * 40 }).catch(() => {});
  }
}
async function readArr(key) {
  const raw = await store.get(key).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

const monthsBetween = (from) => (from ? Math.max(0, Math.round((Date.now() - from) / (30 * 864e5))) : 0);

// A compact, current snapshot of the whole business for the model.
async function buildContext() {
  const sites = await listSites();
  const rows = [];
  let overheadTotal = 0;
  const overhead = await readArr('expenses:_business');
  overheadTotal = overhead.reduce((t, e) => t + (Number(e.amount) || 0), 0);

  for (const s of sites) {
    const [st, audit, expenses] = await Promise.all([
      siteStats(s.slug, s.conversionEvents || []).catch(() => null),
      runAudit(s.url, { cachedOnly: true }).catch(() => ({ ok: false })),
      readArr(`expenses:${s.slug}`),
    ]);
    const onTrial = !!(s.trialEnds && s.trialEnds > Date.now());
    rows.push({
      name: s.name,
      url: s.url,
      client: s.client || '',
      email: s.email || '',
      status: onTrial ? 'trial' : s.priceMonthly ? 'paying' : 'unpaid',
      priceMonthly: s.priceMonthly || 0,
      setupFee: s.setupFee || 0,
      monthsWith: monthsBetween(s.startedAt),
      trialEndsInDays: onTrial ? Math.ceil((s.trialEnds - Date.now()) / 864e5) : null,
      leadSource: s.leadSource || '',
      seoReady: audit?.ok ? audit.scores.seo : null,
      speed: audit?.ok ? audit.scores.performance : null,
      visitors30: st?.visitors ?? null,
      leads30: st?.conversions ?? null,
      deltaVisitorsPct: st?.deltas?.visitors ?? null,
      repo: s.repo || '',
      seoAgent: s.seoAgent !== false,
      expensesToDate: expenses.reduce((t, e) => t + (Number(e.amount) || 0), 0),
    });
  }

  const paying = rows.filter((r) => r.status === 'paying');
  const mrr = paying.reduce((t, r) => t + r.priceMonthly, 0);
  const aiMonth = await readNum(`coach:spend:${MONTH()}`);
  const agentMonth = await readNum(`agent:spend:${MONTH()}`);

  return {
    today: new Date().toISOString().slice(0, 10),
    company: {
      legalName: 'Inspiring Websites LLC',
      address: '2200 Driskell Drive, Corinth, TX 76210',
      state: 'TX (no state income tax)',
      taxReserveRule: 'holds back 20% of gross revenue',
      standardOffer: '$149/mo managed website + automated SEO',
    },
    counts: {
      total: rows.length,
      paying: paying.length,
      trial: rows.filter((r) => r.status === 'trial').length,
      unpaid: rows.filter((r) => r.status === 'unpaid').length,
    },
    money: {
      mrr,
      arr: mrr * 12,
      overheadTotalToDate: overheadTotal,
      aiCoachSpendThisMonth: +aiMonth.toFixed(2),
      seoAgentSpendThisMonth: +agentMonth.toFixed(2),
      overheadItems: overhead.slice(-8),
    },
    sites: rows,
  };
}

const SYSTEM = `You are Compass, the in-house business coach for Inspiring Websites LLC — a one-person web design + SEO agency run by Mondo (mondoesanai@gmail.com). You have the live numbers in the user message as JSON.

How to answer:
- Founder-to-founder. Direct, concrete, prioritized. No corporate filler, no long preambles.
- When asked "what should I do / what's next", give 2-4 specific moves ranked by impact, each with the number that justifies it.
- You can answer factual lookups from the data (a client's email, months active, which site has the worst SEO, whether the month is profitable after AI cost, etc.).
- If the data doesn't contain something, say so plainly — don't guess.
- Keep answers tight. A few sentences or a short list. Only go long if explicitly asked.
- Money: profit is revenue minus expenses; Mondo reserves 20% of revenue for taxes; TX has no state income tax.`;

export default async function handler(req, res) {
  if (!authed(req)) return res.status(401).json({ ok: false, error: 'bad password' });
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

  const key = process.env.ANTHROPIC_API_KEY_COACH || process.env.ANTHROPIC_API_KEY;
  if (!key)
    return res
      .status(200)
      .json({ ok: false, error: 'Compass needs ANTHROPIC_API_KEY_COACH (or ANTHROPIC_API_KEY) set in Vercel.' });

  let body = {};
  try {
    body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}');
  } catch {
    body = {};
  }
  const message = String(body.message || '').slice(0, 4000).trim();
  if (!message) return res.status(400).json({ ok: false, error: 'empty message' });
  const history = Array.isArray(body.history)
    ? body.history
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }))
    : [];

  const [spentDay, spentMonth] = await Promise.all([
    readNum(`coach:spend:${DAY()}`),
    readNum(`coach:spend:${MONTH()}`),
  ]);

  let ctx;
  try {
    ctx = await buildContext();
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'could not read the portfolio: ' + (e.message || e) });
  }

  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'AI SDK not available: ' + (e.message || e) });
  }
  const client = new Anthropic({ apiKey: key });

  const messages = [
    ...history,
    { role: 'user', content: `LIVE NUMBERS (${ctx.today}):\n${JSON.stringify(ctx)}\n\n---\nMONDO: ${message}` },
  ];

  let reply, usage;
  try {
    const r = await client.messages.create({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM,
      messages,
    });
    reply = (r.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    usage = r.usage || {};
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'model call failed: ' + (e.status || '') + ' ' + (e.message || e) });
  }
  if (!reply) return res.status(200).json({ ok: false, error: 'the model returned nothing' });

  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const usd = +(inTok / 1e6 * 3 + outTok / 1e6 * 15).toFixed(5);
  await addSpend(usd);

  const monthAfter = spentMonth + usd;
  const dayAfter = spentDay + usd;
  let warning = null;
  if (monthAfter >= MONTHLY_CAP)
    warning = `That puts Compass over its $${MONTHLY_CAP.toFixed(0)} monthly budget ($${monthAfter.toFixed(
      2
    )}). It'll keep answering — spend just carries a little past the cap now.`;
  else if (dayAfter >= DAILY_SOFT)
    warning = `Heads up — that's today's Compass budget used ($${dayAfter.toFixed(2)} of $${DAILY_SOFT.toFixed(
      2
    )}). You can keep going; it just eats into the days ahead.`;

  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    reply,
    usage: { in: inTok, out: outTok, usd },
    today: { spent: +dayAfter.toFixed(3), soft: DAILY_SOFT },
    month: { spent: +monthAfter.toFixed(3), cap: MONTHLY_CAP },
    warning,
  });
}
