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
import { buildFindings } from './suggestions.js';
import { todosState, completeTodo } from './todos.js';

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

const RUNNING_TTL = 6 * 60; // seconds — a stuck/crashed run self-clears instead of wedging the site forever
async function setRunning(slug, task) {
  await store.set(`agent:running:${slug}`, JSON.stringify({ since: Date.now(), task }), { ex: RUNNING_TTL }).catch(() => {});
}
async function clearRunning(slug) {
  await store.set(`agent:running:${slug}`, '', { ex: 1 }).catch(() => {});
}
async function readRunning(slug) {
  const raw = await store.get(`agent:running:${slug}`).catch(() => null);
  try {
    return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    return null;
  }
}
function nextStepFor(reasons, keywords, ranks) {
  if (reasons.length) return reasons[0];
  if (!keywords.length) return 'Picking target keywords (first run)';
  if (!ranks) return 'Checking Google rankings for the first time';
  return 'Checking rankings, then shipping the next technical-SEO improvement';
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
  const blocked = await store.get(`agent:blocked:${site.slug}`).catch(() => null);
  if (blocked) reasons.push(blocked);
  const keywords = (await readArr(`agent:keywords:${site.slug}`)) || [];
  const ranks = (await store.get(`agent:ranks:${site.slug}`).catch(() => null)) || null;
  const running = await readRunning(site.slug);
  return {
    eligible: reasons.length === 0,
    reasons,
    running: !!running,
    runningSince: running?.since || null,
    runningTask: running?.task || null,
    spentThisMonth: +spentSite.toFixed(2),
    budget,
    cap,
    keywords,
    lastLog: (await readArr(`agent:log:${site.slug}`)).slice(0, 8),
    ranks,
    nextStep: running ? running.task : nextStepFor(reasons, keywords, ranks),
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

// Delimiter format instead of JSON for the file-change plan — asking a model
// to hand-escape arbitrary multi-line HTML/JS as a JSON string is exactly the
// failure mode that broke this (unescaped quotes/newlines -> "unterminated
// string" parse errors). Plain delimiters sidestep escaping entirely: content
// is captured verbatim between markers, nothing to get wrong.
function parsePlan(text) {
  let s = String(text || '').trim();
  // the model is told not to, but sometimes wraps the whole reply in a
  // markdown fence anyway — strip it rather than let that alone fail parsing.
  s = s.replace(/^```[a-z]*\r?\n/i, '').replace(/\r?\n```\s*$/, '');
  const summary = (s.match(/^SUMMARY:\s*(.+)$/im) || [])[1]?.trim() || '';
  const commitMessage = (s.match(/^COMMIT:\s*(.+)$/im) || [])[1]?.trim() || '';
  const files = [];
  // case-insensitive, REASON optional, and tolerant of extra spaces/dashes
  // around the BEGIN/END markers — small formatting drift shouldn't be able
  // to sink an otherwise-correct reply.
  const re = /^FILE:\s*(.+?)\s*\r?\n(?:REASON:\s*(.*?)\s*\r?\n)?-{2,}\s*BEGIN CONTENT\s*-{2,}\r?\n([\s\S]*?)\r?\n-{2,}\s*END CONTENT\s*-{2,}/gim;
  let m;
  while ((m = re.exec(s))) files.push({ path: m[1].trim(), reason: (m[2] || '').trim(), content: m[3] });
  return { summary, commitMessage, files };
}

export async function runAgentCycle(site, opts = {}) {
  const st = await agentStatus(site);
  if (!st.eligible) return { ok: false, skipped: true, slug: site.slug, reason: st.reasons.join('; '), status: st };
  if (st.running) return { ok: false, alreadyRunning: true, slug: site.slug, reason: `already running — ${st.runningTask || 'working'} (started ${st.runningSince ? Math.round((Date.now() - st.runningSince) / 1000) : '?'}s ago)`, status: st };
  await setRunning(site.slug, 'Starting a cycle');
  try {
    return await runAgentCycleInner(site, st, opts);
  } finally {
    await clearRunning(site.slug);
  }
}

async function runAgentCycleInner(site, st, { manual = false } = {}) {
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

  // a client-requested revision jumps the whole queue — it doesn't wait on
  // this site's first-run keyword step or its rank-check turn.
  const todosRec = await todosState(site).catch(() => ({ current: null }));
  const pendingRevision = (todosRec.current?.items || []).find((it) => it.source === 'revision');

  // ---- first run: establish target keywords ----
  let keywords = st.keywords;
  if (!keywords.length && !pendingRevision) {
    await setRunning(site.slug, 'Picking target keywords');
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

  // ---- rank refresh (skip when there's an urgent revision to get to) ----
  let ranks = null;
  if (serpConfigured() && !pendingRevision) {
    await setRunning(site.slug, 'Checking Google rankings');
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
  await setRunning(site.slug, 'Reading the repo for a technical-SEO opportunity');
  let tree;
  try {
    tree = await listFiles(site.repo);
  } catch (e) {
    if (e.repoEmpty) {
      // short TTL so this doesn't wedge the site eligible forever — the next
      // attempt (cron or manual) retries for real and clears it on success
      await store.set(`agent:blocked:${site.slug}`, e.message, { ex: 60 * 60 * 12 }).catch(() => {});
      await log(site.slug, { action: 'blocked', detail: e.message });
      return { ok: false, slug: site.slug, blocked: true, error: e.message, ranks };
    }
    await log(site.slug, { action: 'error', detail: 'repo read: ' + (e.message || e) });
    return { ok: false, slug: site.slug, error: 'could not read repo: ' + (e.message || e), ranks };
  }
  await store.set(`agent:blocked:${site.slug}`, '', { ex: 1 }).catch(() => {});
  const htmlFiles = tree.files.filter((p) => /\.(html?|njk|liquid|ejs|astro|jsx|tsx|vue|svelte)$/i.test(p)).slice(0, 12);
  const configish = tree.files.filter((p) => /(^|\/)(robots\.txt|sitemap\.xml|llms\.txt|_headers|site\.webmanifest)$/i.test(p));
  const audit = await runAudit(site.url, { cachedOnly: true }).catch(() => ({ ok: false }));
  // Pick ONE specific target for this cycle, in priority order: a pending
  // client revision beats everything; otherwise the AI-curated to-do list
  // (same one Mondo sees on the To-dos tab); otherwise the rule-based audit
  // findings as a last resort for a brand-new site with no to-dos yet.
  // Computed BEFORE the file sample below on purpose — see why there.
  const aiTodoItems = (todosRec.current?.items || []).filter((it) => it.source !== 'revision');
  const findings = buildFindings(audit, null).filter((f) => f.severity !== 'good');
  const targetItem =
    pendingRevision ||
    aiTodoItems[0] ||
    (findings[0] && { id: null, title: findings[0].title, detail: findings[0].detail, category: 'SEO' });
  if (!targetItem) {
    await log(site.slug, { action: 'no-change', detail: 'nothing open to work on this cycle' });
    return { ok: true, slug: site.slug, action: 'no-change', reason: 'no open to-dos', ranks, status: await agentStatus(site) };
  }

  // Which HTML file(s) is this task actually about? Previously this always
  // sampled just htmlFiles[0] regardless of the task — so a revision like
  // "update rankings.html" got planned against whatever page happened to be
  // first in the repo listing, the model correctly refused to touch a file
  // it was never shown content for, and the safety check rejected the
  // resulting empty/off-target plan. Score every HTML file by whether the
  // task's own wording names it, and sample the best matches instead of a
  // fixed guess.
  const taskText = `${targetItem.title || ''} ${targetItem.detail || ''}`.toLowerCase();
  const scoredHtml = htmlFiles
    .map((p) => {
      const base = p.toLowerCase().replace(/^.*\//, '').replace(/\.\w+$/, '');
      let score = base === 'index' || base === 'home' ? 0.5 : 0; // mild default relevance for the homepage
      if (base.length > 2 && taskText.includes(base)) score += 3;
      const spaced = base.replace(/[-_]/g, ' ');
      if (spaced.length > 2 && spaced !== base && taskText.includes(spaced)) score += 3;
      return { p, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((x) => x.p);
  const likelyTargets = [...new Set([...scoredHtml.slice(0, 4), htmlFiles[0]])].filter(Boolean);
  const sample = {};
  for (const p of [...configish, ...likelyTargets].filter(Boolean).slice(0, 6)) {
    const c = await getFileContent(site.repo, p, tree.branch);
    if (c) sample[p] = c.slice(0, 6000);
  }

  let plan;
  await setRunning(site.slug, pendingRevision ? `Working on: ${pendingRevision.title}` : 'Planning the next technical-SEO fix');
  const planSystem =
    'You are a senior technical-SEO + front-end engineer editing a real client website. Make ONE focused, safe change that accomplishes exactly the task given. Never keyword-stuff. Reply in the exact plain-text format requested — no JSON, no markdown code fences.';
  const planUser = `Site: ${site.name} — ${site.url}
Target keywords: ${keywords.join(', ') || '(not set yet)'}
Repo files (${tree.files.length}): ${tree.files.slice(0, 120).join(', ')}
Existing file contents:
${Object.entries(sample).map(([p, c]) => `--- ${p} ---\n${c}`).join('\n\n') || '(none fetched)'}

YOUR TASK THIS CYCLE — accomplish exactly this, nothing else:
[${targetItem.category}] ${targetItem.title}
${targetItem.detail || ''}

Only edit files you were shown the full content of, or CREATE new small files (llms.txt, robots.txt, sitemap.xml) if the task calls for one.

HARD RULES — this ships straight to the live site with no human review, so:
- NEVER touch colors, fonts, visual design, spacing/layout, or images/photos. Don't edit any .css/.scss file or anything under an images/img/assets/media folder.
- NEVER restructure the page (no removing/reordering sections, no changing what a page looks like to a visitor). Technical + content only.
- Keep every change minimal, correct, and exactly what the to-do item asks for. At most 3 files.

Reply in EXACTLY this format (repeat the FILE block per file, nothing before SUMMARY or after the last ---END CONTENT---):
SUMMARY: one line
COMMIT: commit message
FILE: path/to/file
REASON: one line
---BEGIN CONTENT---
the complete new file content, verbatim — no escaping needed
---END CONTENT---`;
  try {
    const first = await callAgent(key, planSystem, planUser, 4000);
    await spend(first.usd);
    plan = parsePlan(first.text);
    if (!plan.files.length) {
      // one retry, showing the model exactly what it sent so a one-off
      // formatting slip (wrong casing, extra prose, a missed marker) has a
      // real chance to self-correct instead of failing the whole cycle.
      await log(site.slug, {
        action: 'error',
        detail: "planning: first reply didn't match FILE/CONTENT format, retrying once",
        sample: first.text.slice(0, 500),
      });
      const retry = await callAgent(
        key,
        planSystem,
        `${planUser}\n\nYour previous reply could not be used because it didn't follow the required format. Here is exactly what you sent:\n"""\n${first.text.slice(0, 2000)}\n"""\nReply again, following the format EXACTLY — SUMMARY, COMMIT, then one FILE / REASON / ---BEGIN CONTENT--- / ---END CONTENT--- block per file. Nothing else before or after.`,
        4000
      );
      await spend(retry.usd);
      plan = parsePlan(retry.text);
      if (!plan.files.length) {
        throw new Error(
          'model reply did not match the expected FILE/CONTENT format, even after a retry — sample: ' +
            retry.text.slice(0, 200).replace(/\s+/g, ' ')
        );
      }
    }
  } catch (e) {
    await log(site.slug, { action: 'error', detail: 'planning: ' + (e.message || e) });
    return { ok: false, slug: site.slug, error: 'planning failed: ' + (e.message || e), ranks };
  }

  const files = Array.isArray(plan.files) ? plan.files.filter((f) => f && f.path && typeof f.content === 'string') : [];
  const knownOrNew = (p) => sample[p] !== undefined || /(^|\/)(llms\.txt|robots\.txt|sitemap\.xml|humans\.txt)$/i.test(p);
  // belt-and-suspenders on top of the prompt's hard rules: no visual-asset file
  // can ever be part of a plan, no matter what the model tried to hand back.
  const isVisualAsset = (p) => /\.(css|scss|less|jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?)$/i.test(p) || /(^|\/)(images?|img|assets\/(img|media|photos?)|media|photos?)\//i.test(p);
  const safe =
    files.length > 0 &&
    files.length <= 6 &&
    files.every((f) => !f.path.includes('..') && knownOrNew(f.path) && !isVisualAsset(f.path) && !looksSpammy(f.content) && f.content.length < 60000);
  if (!safe) {
    await log(site.slug, { action: 'skipped', detail: `Plan rejected by safety check (${files.length} files): ${plan.summary || ''}` });
    return { ok: true, slug: site.slug, action: 'no-change', reason: 'plan failed safety check', ranks, status: await agentStatus(site) };
  }

  await setRunning(site.slug, site.agentAutoMerge ? 'Committing the fix to your site' : 'Opening a pull request with the fix');
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
    let completedTodo = null;
    if (targetItem.id) {
      // save what each file looked like before, keyed by the to-do id (not the
      // ticket — agent.js doesn't know about tickets) so a wrong-site match can
      // be reverted later without needing to re-derive anything.
      await store
        .set(
          `revert:${targetItem.id}`,
          JSON.stringify({
            repo: site.repo,
            branch: tree.branch,
            files: files.map((f) => ({ path: f.path, before: sample[f.path] ?? null })),
          }),
          { ex: 60 * 60 * 24 * 30 }
        )
        .catch(() => {});
      completedTodo = await completeTodo(site.slug, targetItem.id).catch(() => null);
    }
    return {
      ok: true,
      slug: site.slug,
      action: 'change',
      summary: plan.summary,
      files: files.map((f) => f.path),
      pr: res,
      ranks,
      revisionCompleted: pendingRevision ? { ...targetItem, ...(completedTodo || {}) } : null,
      status: await agentStatus(site),
    };
  } catch (e) {
    await log(site.slug, { action: 'error', detail: 'commit: ' + (e.message || e) });
    return { ok: false, slug: site.slug, error: 'commit failed: ' + (e.message || e), ranks };
  }
}
