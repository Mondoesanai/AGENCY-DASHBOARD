// AI-curated builder to-do list. Specific and evidence-based ("add a click-to-
// call button above the fold — 71% of your traffic is mobile and there's none
// until you scroll"), not vague ("improve mobile"). Refreshes every 14 days per
// site, mixing SEO and conversion-rate items. When an item drops off the list
// on a refresh, it's logged as addressed so the monthly report can mention
// what's been worked on — in the client's real, measured numbers, never a
// invented improvement percentage tied to one specific fix (we can't honestly
// measure that causally, so we don't claim to).
import { store } from './store.js';
import { runAudit } from './audit.js';
import { siteStats } from './stats.js';
import { buildFindings } from './suggestions.js';
import { markAiMonth } from './aicost.js';

const TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MONTH = () => new Date().toISOString().slice(0, 7);
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

async function num(k) {
  const v = await store.get(k).catch(() => null);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
async function bump(k, usd) {
  const cur = await num(k);
  await store.set(k, String(+(cur + usd).toFixed(5)), { ex: 60 * 60 * 24 * 45 }).catch(() => {});
}
async function readArr(k) {
  const raw = await store.get(k).catch(() => null);
  try {
    const a = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}
const slugifyId = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export async function todosState(site) {
  const raw = await store.get(`todos:${site.slug}`).catch(() => null);
  const current = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  const nextRefresh = current ? current.generatedAt + TTL_MS : 0; // 0 = due now, never generated
  return {
    current,
    stale: !current || Date.now() >= nextRefresh,
    nextRefresh,
    completed: (await readArr(`todos:completed:${site.slug}`)).slice(0, 10),
  };
}

function parseItems(text) {
  let s = String(text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const parsed = JSON.parse(s);
  return Array.isArray(parsed.items) ? parsed.items : [];
}

export async function refreshTodos(site) {
  const key = process.env.ANTHROPIC_API_KEY_AGENT || process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'no Anthropic key set' };
  const m = MONTH();
  const cap = site.agentCap || 20;
  const spentSite = await num(`agent:spend:${site.slug}:${m}`);
  if (spentSite >= cap) return { ok: false, error: `this month's budget is used ($${spentSite.toFixed(2)} / $${cap})` };

  const [audit, stats] = await Promise.all([
    runAudit(site.url).catch(() => ({ ok: false })),
    siteStats(site.slug, site.conversionEvents || []).catch(() => null),
  ]);
  const findings = buildFindings(audit, stats).filter((f) => f.severity !== 'good');
  let ranks = null;
  try {
    const raw = await store.get(`agent:ranks:${site.slug}`);
    ranks = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    /* optional */
  }
  const { current: prev } = await todosState(site);

  let Anthropic;
  try {
    ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
  } catch (e) {
    return { ok: false, error: 'AI SDK unavailable: ' + (e.message || e) };
  }
  const client = new Anthropic({ apiKey: key });

  const mobilePct = stats?.device ? Math.round((stats.device.mobile / Math.max(1, stats.device.mobile + stats.device.desktop)) * 100) : null;
  let r;
  try {
    r = await client.messages.create({
      model: MODEL,
      max_tokens: 1400,
      system:
        'You are a sharp technical-SEO + conversion-rate consultant reviewing one real small-business website for its agency. Every to-do must be SPECIFIC and evidence-based — name the exact problem, the exact fix, and why it matters (ranking or getting more calls/bookings/leads). Never vague filler like "improve mobile experience" or "add more content." Return ONLY JSON.',
      messages: [
        {
          role: 'user',
          content: `Site: ${site.name} — ${site.url}
Audit scores: ${audit?.ok ? JSON.stringify(audit.scores) : 'unavailable'}
Failing technical checks: ${audit?.ok ? Object.entries(audit.checks || {}).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'none' : 'n/a'}
Traffic (30d): ${stats?.hasData ? `${stats.visitors} visitors, ${stats.conversions} conversions${mobilePct != null ? `, ${mobilePct}% mobile` : ''}` : 'no tracker data yet'}
Current Google rankings: ${ranks?.results?.length ? ranks.results.map((x) => `${x.keyword}: ${x.rank ? '#' + x.rank : 'not ranked'}`).join(', ') : 'not tracked yet'}
Rule-based technical findings: ${findings.map((f) => f.title).join(', ') || 'none open'}
Previous to-dos (avoid repeating ones already done, may resurface a still-open one worded better): ${prev?.items?.map((x) => x.title).join(', ') || 'none yet'}

Give the 5-7 highest-impact to-dos, mixing SEO and conversion-rate items, for a builder/agency to actually work through. JSON: {"items":[{"title":"short specific action","detail":"the evidence + why it matters, one or two sentences","category":"SEO"|"Conversion","severity":"high"|"med"|"low"}]}`,
        },
      ],
    });
  } catch (e) {
    return { ok: false, error: 'model call failed: ' + (e.status || '') + ' ' + (e.message || e) };
  }
  const text = (r.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const usd = +(((r.usage?.input_tokens || 0) / 1e6) * 3 + ((r.usage?.output_tokens || 0) / 1e6) * 15).toFixed(5);
  await bump(`agent:spend:${m}`, usd);
  await bump(`agent:spend:${site.slug}:${m}`, usd);
  await markAiMonth(m);

  let raw;
  try {
    raw = parseItems(text);
  } catch (e) {
    return { ok: false, error: 'could not parse response: ' + (e.message || e) };
  }
  const items = raw
    .slice(0, 8)
    .map((it) => ({
      id: slugifyId(it.title),
      title: String(it.title || '').slice(0, 140),
      detail: String(it.detail || '').slice(0, 400),
      category: /conv/i.test(it.category || '') ? 'Conversion' : 'SEO',
      severity: ['high', 'med', 'low'].includes(it.severity) ? it.severity : 'med',
    }))
    .filter((it) => it.title);
  if (!items.length) return { ok: false, error: 'model returned no usable to-dos' };

  // an item that was open last time and isn't anymore reads as "addressed" —
  // soft language on purpose: we know it's no longer on the list, we don't
  // claim to know exactly why, and we never attach a made-up improvement %.
  const newIds = new Set(items.map((x) => x.id));
  const addressed = (prev?.items || []).filter((x) => !newIds.has(x.id));
  if (addressed.length) {
    const log = await readArr(`todos:completed:${site.slug}`);
    addressed.forEach((x) => log.unshift({ ...x, addressedAt: Date.now() }));
    await store.set(`todos:completed:${site.slug}`, JSON.stringify(log.slice(0, 40)));
  }

  const record = { generatedAt: Date.now(), items };
  await store.set(`todos:${site.slug}`, JSON.stringify(record));
  return { ok: true, items, addressed, cost: usd };
}
