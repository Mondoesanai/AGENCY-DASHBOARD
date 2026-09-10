// The autonomous per-site SEO agent. One cycle = one small, safe unit of work:
//   - first run for a site: propose 8-12 niche+geo target keywords, save them
//   - otherwise: refresh rankings (DataForSEO) + ship ONE technical-SEO
//     improvement as a pull request (or a direct commit if agentAutoMerge)
// Budget-capped per site (agentBudget, default $18, hard cap $20) and tracked in
// agent:spend:<month> + agent:spend:<slug>:<month>.
import { store } from './store.js';
import { runAudit } from './audit.js';
import { rankBatch, serpConfigured } from './serp.js';
import { repoInfo, listFiles, getFileContent, commitChangeset, githubConfigured } from './github.js';
import { saveSiteConfig } from './registry.js';
import { markAiMonth } from './aicost.js';

const MONTH = () => new Date().toISOString().slice(0, 7);
const AGENT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';

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
async function log(slug, entry) {
  const list = await readArr(`agent:log:${slug}`);
  list.unshift({ at: Date.now(), ...entry });
  await store.set(`agent:log:${slug}`, JSON.stringify(list.slice(0, 40))).catch(() => {});
}

export async function agentStatus(site) {
  const m = MONTH();
  const spentSite = await num(`agent:spend:${site.slug}:${m}`);
  const budget = site.agentBudget || 18;
  const cap = site.agentCap || 20;
  const reasons = [];
  if (site.seoAgent === false) reasons.push('agent turned off for this site');
  if (!site.repo) reasons.push('no GitHub repo set (Settings → Automation)');
  if (!githubConfigured()) reasons.push('GITHUB_TOKEN not set in Vercel');
  if (!(process.env.ANTHROPIC_API_KEY_AGENT || process.env.ANTHROPIC_API_KEY)) reasons.push('no Anthropic key for the agent');
  if (spentSite >= cap) reasons.push(`this month's budget is used ($${spentSite.toFixed(2)} / $${cap})`);
  return {
    eligible: reasons.length === 0,
    reasons,
    spentThisMonth: +spentSite.toFixed(2),
    budget,
    cap,
    keywords: (await readArr(`agent:keywords:${site.slug}`)) || [],
    lastLog: (await readArr(`agent:log:${site.slug}`)).slice(0, 8),
    ranks: (await store.get(`agent:ranks:${site.slug}`).catch(() => null)) || null,
  };
}

function looksSpammy(text) {
  const t = String(text || '').toLowerCase();
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 40) return false;
  const counts = {};
  for (const w of words) counts[w] = (counts[w] || 0) + 1;
  const top = Math.max(...Object.values(counts));
  return top / words.length > 0.06; // any single word >6% of the copy
}

async function callAgent(key, system, user, maxTokens) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const r = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = (r.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const usd = +((r.usage?.input_tokens || 0) / 1e6 * 3 + (r.usage?.output_tokens || 0) / 1e6 * 15).toFixed(5);
  return { text, usd };
}
function parseJSON(text) {
  let s = String(text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

export async function runAgentCycle(site, { manual = false } = {}) {
  const st = await agentStatus(site);
  if (!st.eligible) return { ok: false, skipped: true, slug: site.slug, reason: st.reasons.join('; '), status: st };

  const key = process.env.ANTHROPIC_API_KEY_AGENT || process.env.ANTHROPIC_API_KEY;
  const m = MONTH();
  const spend = async (usd) => {
    await bump(`agent:spend:${m}`, usd);
    await bump(`agent:spend:${site.slug}:${m}`, usd);
    await markAiMonth(m);
  };

  let homepage = '';
  try {
    homepage = (await fetch(site.url, { signal: AbortSignal.timeout(12000) }).then((r) => r.text())).slice(0, 14000);
  } catch {
    /* ok */
  }

  // ---- first run: establish target keywords ----
  let keywords = st.keywords;
  if (!keywords.length) {
    try {
      const { text, usd } = await callAgent(
        key,
        'You are a local SEO strategist. Return ONLY JSON.',
        `Business: ${site.name}\nURL: ${site.url}\nHomepage HTML (truncated):\n${homepage}\n\nPropose 8–12 realistic, buyer-intent search phrases this specific local business should rank for — niche + city/area specific (e.g. "mobile car detailing corinth tx"). No generic head terms. JSON: {"keywords":["..."]}`,
        700
      );
      await spend(usd);
      keywords = (parseJSON(text).keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 12);
      if (keywords.length) {
        await store.set(`agent:keywords:${site.slug}`, JSON.stringify(keywords));
        await saveSiteConfig(site.slug, { agentKeywords: keywords.join(', ') }).catch(() => {});
        await log(site.slug, { action: 'keywords', detail: `Set ${keywords.length} target keywords`, cost: usd });
      }
    } catch (e) {
      await log(site.slug, { action: 'error', detail: 'keyword step: ' + (e.message || e) });
      return { ok: false, slug: site.slug, error: 'keyword step failed: ' + (e.message || e) };
    }
    return { ok: true, slug: site.slug, action: 'keywords', keywords, status: await agentStatus(site) };
  }

  // ---- rank refresh ----
  let ranks = null;
  if (serpConfigured()) {
    try {
      ranks = await rankBatch({ domain: site.url, keywords: keywords.slice(0, 12), device: 'mobile' });
      await store.set(`agent:ranks:${site.slug}`, JSON.stringify({ at: Date.now(), ...ranks }));
      const won = ranks.results.filter((r) => r.rank && r.rank <= 10).length;
      await log(site.slug, { action: 'ranks', detail: `Checked ${ranks.results.length} keywords · ${won} in top 10`, cost: 0 });
    } catch (e) {
      await log(site.slug, { action: 'error', detail: 'rank check: ' + (e.message || e) });
    }
  }

  // ---- one technical-SEO improvement ----
  let tree;
  try {
    tree = await listFiles(site.repo);
  } catch (e) {
    await log(site.slug, { action: 'error', detail: 'repo read: ' + (e.message || e) });
    return { ok: false, slug: site.slug, error: 'could not read repo: ' + (e.message || e), ranks };
  }
  const htmlFiles = tree.files.filter((p) => /\.(html?|njk|liquid|ejs|astro|jsx|tsx|vue|svelte)$/i.test(p)).slice(0, 12);
  const configish = tree.files.filter((p) => /(^|\/)(robots\.txt|sitemap\.xml|llms\.txt|_headers|site\.webmanifest)$/i.test(p));
  const sample = {};
  for (const p of [...configish, htmlFiles[0]].filter(Boolean).slice(0, 4)) {
    const c = await getFileContent(site.repo, p, tree.branch);
    if (c) sample[p] = c.slice(0, 6000);
  }
  const audit = await runAudit(site.url, { cachedOnly: true }).catch(() => ({ ok: false }));

  let plan;
  try {
    const { text, usd } = await callAgent(
      key,
      'You are a senior technical-SEO engineer editing a real client website. Make ONE focused, safe improvement. Never keyword-stuff. Return ONLY JSON.',
      `Site: ${site.name} — ${site.url}
Target keywords: ${keywords.join(', ')}
Repo files (${tree.files.length}): ${tree.files.slice(0, 120).join(', ')}
Existing file contents:
${Object.entries(sample).map(([p, c]) => `--- ${p} ---\n${c}`).join('\n\n') || '(none fetched)'}
Audit failing checks: ${audit?.ok ? Object.entries(audit.checks || {}).filter(([, v]) => !v).map(([k]) => k).join(', ') || 'none' : 'audit not available'}

Pick the single highest-impact technical SEO fix that fits what you can see. Examples: add/repair <title> + meta description on a page, add LocalBusiness JSON-LD, create/improve llms.txt, add a sitemap.xml or robots.txt, add descriptive alt text, add internal links to key pages, fix a heading hierarchy. Only edit files you were shown the full content of, or CREATE new small files (llms.txt, robots.txt, sitemap.xml). Keep every change minimal and correct.
JSON: {"summary":"one line","commitMessage":"...","files":[{"path":"...","content":"FULL new file content","reason":"..."}]}`,
      4000
    );
    await spend(usd);
    plan = parseJSON(text);
  } catch (e) {
    await log(site.slug, { action: 'error', detail: 'planning: ' + (e.message || e) });
    return { ok: false, slug: site.slug, error: 'planning failed: ' + (e.message || e), ranks };
  }

  const files = Array.isArray(plan.files) ? plan.files.filter((f) => f && f.path && typeof f.content === 'string') : [];
  const knownOrNew = (p) => sample[p] !== undefined || /(^|\/)(llms\.txt|robots\.txt|sitemap\.xml|humans\.txt)$/i.test(p);
  const safe =
    files.length > 0 &&
    files.length <= 6 &&
    files.every((f) => !f.path.includes('..') && knownOrNew(f.path) && !looksSpammy(f.content) && f.content.length < 60000);
  if (!safe) {
    await log(site.slug, { action: 'skipped', detail: `Plan rejected by safety check (${files.length} files): ${plan.summary || ''}` });
    return { ok: true, slug: site.slug, action: 'no-change', reason: 'plan failed safety check', ranks, status: await agentStatus(site) };
  }

  try {
    const res = await commitChangeset(site.repo, {
      files: files.map((f) => ({ path: f.path.replace(/^\/+/, ''), content: f.content })),
      message: (plan.commitMessage || plan.summary || 'SEO improvement').slice(0, 100),
      branchPrefix: 'seo-agent',
      autoMerge: !!site.agentAutoMerge,
      body:
        `**${plan.summary || 'SEO improvement'}**\n\n` +
        files.map((f) => `- \`${f.path}\` — ${f.reason || 'update'}`).join('\n') +
        `\n\n_Automated by the Inspiring Websites SEO agent._`,
    });
    await log(site.slug, {
      action: site.agentAutoMerge ? 'shipped' : 'PR opened',
      detail: plan.summary || files.map((f) => f.path).join(', '),
      prUrl: res.prUrl,
      branch: res.branch,
    });
    return { ok: true, slug: site.slug, action: 'change', summary: plan.summary, files: files.map((f) => f.path), pr: res, ranks, status: await agentStatus(site) };
  } catch (e) {
    await log(site.slug, { action: 'error', detail: 'commit: ' + (e.message || e) });
    return { ok: false, slug: site.slug, error: 'commit failed: ' + (e.message || e), ranks };
  }
}
