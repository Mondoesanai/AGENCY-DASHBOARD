// The autonomous per-site SEO agent. One cycle = one small, safe unit of work:
//   - first run for a site: propose 8-12 niche+geo target keywords, save them
//   - otherwise: refresh rankings (DataForSEO) + ship ONE technical-SEO
//     improvement as a pull request (or a direct commit if agentAutoMerge)
// Budget-capped per site (agentBudget, default $18, hard cap $20) and tracked in
// agent:spend:<month> + agent:spend:<slug>:<month>.
import { store } from './store.js';
import { runAudit } from './audit.js';
import { rankBatch, serpConfigured } from './serp.js';
import { repoInfo, listFiles, getFileContent, commitChangeset, githubConfigured, prNumberFromUrl } from './github.js';
import { saveSiteConfig } from './registry.js';
import { markAiMonth } from './aicost.js';
import { buildFindings } from './suggestions.js';
import { todosState, completeTodo } from './todos.js';
import { autoTagConversions } from './conversions-setup.js';
import { summarizeRanks, appendRankHistory, saveRanks, readPrevRanks, keywordTable } from './ranks.js';
import { notifyOwner, askOwner, smsConfigured } from './sms.js';

const MONTH = () => new Date().toISOString().slice(0, 7);
const AGENT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
// A revision task that keeps failing the same way was being retried on
// EVERY check forever — GitHub Actions every ~10min, the dashboard's own
// live poll every 3min while open — and every attempt is a real, billed
// planning call (now sometimes two, with the retry-on-bad-format logic)
// whether it ships or not. With no circuit breaker, a task that could never
// succeed (wrong file shown, a since-fixed bug, whatever) just quietly
// burned the site's whole monthly budget with nothing to show for it. Give
// up after this many consecutive failures and flag it for a human instead.
const REVISION_FAIL_LIMIT = 3;
async function bumpRevisionFailure(id, { immediate = false } = {}) {
  const key = `agent:revfail:${id}`;
  // immediate: skip straight to the give-up threshold — for when the model
  // has already given a clear, specific reason the task can't be done via a
  // file edit (see BLOCKED below). Retrying won't change that the content
  // isn't there to find; two more identical attempts would just be the same
  // accurate answer costing money three times instead of once.
  const next = immediate ? REVISION_FAIL_LIMIT : ((Number(await store.get(key).catch(() => 0)) || 0) + 1);
  await store.set(key, String(next), { ex: 60 * 60 * 24 * 7 }).catch(() => {});
  if (next >= REVISION_FAIL_LIMIT) {
    await store.set(`agent:revgaveup:${id}`, '1', { ex: 60 * 60 * 24 * 30 }).catch(() => {});
  }
  return next;
}
async function clearRevisionFailure(id) {
  await store.set(`agent:revfail:${id}`, '', { ex: 1 }).catch(() => {});
}

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

// seconds — a stuck/crashed run self-clears instead of wedging the site.
// api/admin.js is capped at maxDuration:60 in vercel.json, so a single cycle
// can never legitimately still be "running" much past that; 6 minutes was
// needlessly generous and turned every function-timeout crash (silent —
// Vercel SIGKILLs before the finally{clearRunning()} block can run) into a
// ~6-minute dead zone where every check on that site correctly, but
// uselessly, declined with "already running."
const RUNNING_TTL = 90;
// A site with few competing eligible sites could get its daily cron turn
// EVERY day — at real per-cycle cost, that burns a $20/mo budget in under
// two weeks, then the site goes dark for the rest of the month (exactly
// what was reported: budget gone in ~2 weeks, silence after). Google also
// reads a steady drip of small changes very differently than a burst
// followed by nothing. This floor makes sure discretionary (non-revision)
// work paces itself across the whole month instead of front-loading —
// client-requested revisions are exempt, see runAgentCycle below.
const FAIL_CAP_PER_DAY = 3;
const MIN_DISCRETIONARY_GAP_MS = 2 * 24 * 3600000; // ~2 days between a site's general SEO cycles
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
  const lastCycleAt = Number(await store.get(`agent:lastCycleAt:${site.slug}`).catch(() => 0)) || 0;
  const sinceLastCycle = Date.now() - lastCycleAt;
  if (lastCycleAt && sinceLastCycle < MIN_DISCRETIONARY_GAP_MS) {
    const hrsLeft = Math.ceil((MIN_DISCRETIONARY_GAP_MS - sinceLastCycle) / 3600000);
    reasons.push(`paced — spreads the month's budget out instead of front-loading it; next general cycle in ~${hrsLeft}h`);
  }
  // Every failed attempt is a billed model call. After 3 in a day, stop until
  // tomorrow instead of burning the monthly budget on repeats. Starts with
  // "paced" on purpose: client revisions are exempt from pacing reasons.
  const failsToday = Number(await store.get(`agent:fail:${site.slug}:${new Date().toISOString().slice(0, 10)}`).catch(() => 0)) || 0;
  if (failsToday >= FAIL_CAP_PER_DAY) reasons.push(`paced — paused for today after ${failsToday} failed attempts (protects the budget); resumes tomorrow`);
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

// user: a string, or { prefix, suffix } — the (large) prefix is marked cacheable so
// a retry that re-sends the same file contents pays ~10% for them instead of
// 100%. Every failed attempt used to be billed in full twice (attempt + retry)
// on a prompt that can be 100k tokens; that was a big part of the budget burn.
async function callAgent(key, system, user, maxTokens, opts = {}) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });
  const model = opts.model || AGENT_MODEL;
  const content =
    typeof user === 'string'
      ? user
      : [{ type: 'text', text: user.prefix, cache_control: { type: 'ephemeral' } }, ...(user.suffix ? [{ type: 'text', text: user.suffix }] : [])];
  const r = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] });
  const text = (r.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const [inRate, outRate] = /haiku/i.test(model) ? [1, 5] : [3, 15];
  const u = r.usage || {};
  const usd = +(
    ((u.input_tokens || 0) / 1e6) * inRate +
    ((u.cache_creation_input_tokens || 0) / 1e6) * inRate * 1.25 +
    ((u.cache_read_input_tokens || 0) / 1e6) * inRate * 0.1 +
    ((u.output_tokens || 0) / 1e6) * outRate
  ).toFixed(5);
  // stop_reason 'max_tokens' means the reply got cut off mid-sentence — for
  // a real file's complete content that silently produces zero usable files
  // (no closing ---END CONTENT---), which read as "didn't match the format"
  // when the real problem was running out of room, not a formatting slip.
  return { text, usd, stopReason: r.stop_reason || null };
}
function parseJSON(text) {
  let s = String(text || '').trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

// Shared by the first-run step inside a normal cycle AND initKeywordTracking
// (called straight from "Add site" so keyword targeting doesn't wait for
// this site's turn in the daily rotation, which could be days away).
async function pickKeywords(site, homepage, { key, spend }) {
  const { text, usd } = await callAgent(
    key,
    'You are a local SEO strategist. Return ONLY JSON.',
    `Business: ${site.name}\nURL: ${site.url}\nHomepage HTML (truncated):\n${homepage}\n\nPropose 8–12 realistic, buyer-intent search phrases this specific local business should rank for — niche + city/area specific (e.g. "mobile car detailing corinth tx"). No generic head terms. JSON: {"keywords":["..."]}`,
    700
  );
  await spend(usd);
  const keywords = (parseJSON(text).keywords || []).map((k) => String(k).toLowerCase().trim()).filter(Boolean).slice(0, 12);
  if (keywords.length) {
    await store.set(`agent:keywords:${site.slug}`, JSON.stringify(keywords));
    await saveSiteConfig(site.slug, { agentKeywords: keywords.join(', ') }).catch(() => {});
  }
  return keywords;
}

// Called once from "Add site" (api/site.js) for a brand-new site — picks
// target keywords and, if DataForSEO is configured, runs the first real
// rank check immediately, instead of both waiting for this site's turn in
// the daily rotation. Safe to call even if keywords already exist (no-op).
export async function initKeywordTracking(site) {
  const key = process.env.ANTHROPIC_API_KEY_AGENT || process.env.ANTHROPIC_API_KEY;
  if (!key) return { ok: false, error: 'no Anthropic key set' };
  const existing = await readArr(`agent:keywords:${site.slug}`);
  if (existing.length) return { ok: true, keywords: existing, alreadySet: true };
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
  let keywords = [];
  try {
    keywords = await pickKeywords(site, homepage, { key, spend });
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
  if (!keywords.length) return { ok: true, keywords: [], note: 'could not determine target keywords from the homepage yet' };
  await log(site.slug, { action: 'keywords', detail: `Set ${keywords.length} target keywords` });
  let ranks = null;
  let rankSummary = null;
  if (serpConfigured()) {
    try {
      const r = await rankBatch({ domain: site.url, keywords: keywords.slice(0, 15), device: 'mobile' });
      ranks = { at: Date.now(), ...r };
      await saveRanks(site.slug, ranks);
      rankSummary = summarizeRanks(ranks);
      if (rankSummary) {
        await appendRankHistory(site.slug, { at: ranks.at, avgRank: rankSummary.avgRank, bestRank: rankSummary.bestRank, inTop10: rankSummary.inTop10, inTop3: rankSummary.inTop3 });
      }
      await log(site.slug, { action: 'ranks', detail: `Checked ${r.results.length} keywords · ${rankSummary?.inTop10 || 0} in top 10` });
    } catch (e) {
      await log(site.slug, { action: 'error', detail: 'initial rank check: ' + (e.message || e) });
    }
  }
  return { ok: true, keywords, ranks: rankSummary };
}

// Rank checks were only ever a side-effect of a site's full discretionary
// cycle — which is gated by the 2-day pacing floor, the monthly budget cap,
// AND loses its turn entirely whenever a revision is pending. A site stuck
// behind any of those (or just unlucky in the daily rotation) could go
// weeks with no refresh at all — exactly the "this is old news" complaint.
// DataForSEO cost is small and independent of the Anthropic budget that
// actually gates the rest of the cycle, so rank-freshness shouldn't have to
// wait on it. Called from cron-daily.js for every eligible site, completely
// separate from the technical-fix rotation below.
const RANK_REFRESH_INTERVAL_MS = 3 * 24 * 3600000; // recheck at least every ~3 days
export async function refreshRanksIfStale(site, { force = false } = {}) {
  if (!serpConfigured()) return { ok: false, skipped: true, reason: 'DataForSEO not configured' };
  const keywords = await readArr(`agent:keywords:${site.slug}`);
  if (!keywords.length) return { ok: false, skipped: true, reason: 'no keywords set yet' };
  if (!force) {
    const raw = await store.get(`agent:ranks:${site.slug}`).catch(() => null);
    let last = null;
    try {
      last = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
    } catch {
      last = null;
    }
    if (last && last.at && Date.now() - last.at < RANK_REFRESH_INTERVAL_MS) {
      return { ok: true, skipped: true, reason: 'checked recently' };
    }
  }
  try {
    const r = await rankBatch({ domain: site.url, keywords: keywords.slice(0, 15), device: 'mobile', concurrency: 8 });
    const ranks = { at: Date.now(), ...r };
    await saveRanks(site.slug, ranks);
    const summary = summarizeRanks(ranks);
    if (summary) {
      await appendRankHistory(site.slug, { at: ranks.at, avgRank: summary.avgRank, bestRank: summary.bestRank, inTop10: summary.inTop10, inTop3: summary.inTop3 });
    }
    await log(site.slug, { action: 'ranks', detail: `Checked ${r.results.length} keywords · ${summary?.inTop10 || 0} in top 10` });
    return { ok: true, ranks: summary };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

// ---- keeping the agent productive ------------------------------------------
// Why sites went weeks with "nothing shipped" even on days the cycle ran: the
// target was always "first open to-do, else first audit finding", and the top
// finding on a fast-to-load site is usually something the agent can never
// ship ("compress the hero image" — image files are off-limits). Same target,
// same dead end, every cycle, forever. Three fixes work together:
//  1. Anything that ends in no-change/format failure is remembered as "stuck"
//     for 14 days so the next cycle moves on to something else.
//  2. Targets that need image/video/font work are never picked at all.
//  3. When the to-do list and audit are exhausted, a rotating playbook of
//     safe, invisible on-page improvements (titles/descriptions per page, alt
//     text, structured data, sitemap/robots/llms.txt) keeps real work flowing
//     — steady incremental change instead of a burst followed by silence.
const STUCK_TTL_MS = 14 * 864e5;
// only work that genuinely needs a binary file changed — NOT "add alt text to
// images", which is a plain markup edit and very much shippable.
const UNSHIPPABLE = /(compress\w*|resiz\w*|shrink\w*|optimi[sz]\w*|convert\w*|reduc\w*|serv\w*|replac\w*)\b[^.\n]{0,50}\b(images?|photos?|hero|videos?|fonts?|files?)\b|\b(webp|avif)\b|\blargest content\w*|\blcp\b|\bcore web vitals\b|\bcontrast\b|\bcolou?rs?\b|\bfont size\b|\bspacing\b|\blayout\b/i;
async function stuckKeys(slug) {
  const now = Date.now();
  return new Set((await readArr(`agent:stuck:${slug}`)).filter((x) => now - x.at < STUCK_TTL_MS).map((x) => x.key));
}
async function markStuck(slug, key) {
  if (!key) return;
  const now = Date.now();
  const list = (await readArr(`agent:stuck:${slug}`)).filter((x) => now - x.at < STUCK_TTL_MS && x.key !== key);
  list.push({ key, at: now });
  await store.set(`agent:stuck:${slug}`, JSON.stringify(list.slice(-80)), { ex: 60 * 60 * 24 * 30 }).catch(() => {});
}
async function playbookDone(slug) {
  return new Set(await readArr(`agent:playbook:${slug}`));
}
async function markPlaybookDone(slug, key) {
  const list = await readArr(`agent:playbook:${slug}`);
  if (!list.includes(key)) list.push(key);
  await store.set(`agent:playbook:${slug}`, JSON.stringify(list.slice(-200)), { ex: 60 * 60 * 24 * 400 }).catch(() => {});
}
async function rankContext(slug) {
  const raw = await store.get(`agent:ranks:${slug}`).catch(() => null);
  let r = null;
  try {
    r = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    r = null;
  }
  if (!r?.results?.length) return '';
  return r.results
    .filter((x) => !x.error)
    .map((x) => `${x.keyword}: ${x.rank ? '#' + x.rank : 'not in top ' + (r.depth || 100)}`)
    .join('; ');
}
// Ordered list of safe improvements this site hasn't had yet. Every step is
// invisible to a visitor (no design/layout change) so it can ship unattended.
// What Google shows today for the searches this site does NOT yet win: the
// titles that outrank it and the questions people ask. Fed into the title /
// description step so it writes against real competition, not blind.
async function serpIntel(slug) {
  const raw = await store.get(`agent:ranks:${slug}`).catch(() => null);
  let r = null;
  try {
    r = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    r = null;
  }
  if (!r?.results?.length) return '';
  return r.results
    .filter((x) => !x.error && (!x.rank || x.rank > 3) && (x.topTitles?.length || x.paa?.length))
    .slice(0, 4)
    .map((x) => {
      const t = (x.topTitles || []).slice(0, 3).map((y) => `"${y.title}" (${y.domain})`).join(' | ');
      const q = (x.paa || []).slice(0, 3).join('; ');
      return `${x.keyword} [you: ${x.rank ? '#' + x.rank : 'not ranking'}] top results: ${t || 'n/a'}${q ? ' — people also ask: ' + q : ''}`;
    })
    .join('\n');
}
const HAIKU = 'claude-haiku-4-5-20251001';
// Grows the keyword list from Google's own related searches / People Also Ask
// for the searches already tracked — how a real SEO finds the next long-tail
// term instead of freezing the list at whatever was guessed on day one.
async function expandKeywords(site, { key, spend }) {
  const raw = await store.get(`agent:ranks:${site.slug}`).catch(() => null);
  let r = null;
  try {
    r = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    r = null;
  }
  const current = await readArr(`agent:keywords:${site.slug}`);
  const ideas = [...new Set((r?.results || []).flatMap((x) => [...(x.related || []), ...(x.paa || [])]))].slice(0, 40);
  if (!ideas.length || current.length >= 15) return { added: [] };
  const { text, usd } = await callAgent(
    key,
    'You are a local SEO strategist. Return ONLY JSON.',
    `Business: ${site.name} — ${site.url}
Already targeting: ${current.join('; ')}
Google's related searches and People-Also-Ask for those:
${ideas.join('\n')}

Pick up to 5 NEW, realistic, buyer-intent searches this specific business can genuinely win (niche + place, long-tail, question-style is fine) that are not already covered. Skip anything the business does not offer or cannot serve. JSON: {"keywords":["..."]}`,
    500,
    { model: HAIKU }
  );
  await spend(usd);
  const fresh = (parseJSON(text).keywords || []).map((k) => String(k).toLowerCase().trim()).filter((k) => k && !current.includes(k)).slice(0, 5);
  if (!fresh.length) return { added: [] };
  const merged = [...current, ...fresh].slice(0, 15);
  await store.set(`agent:keywords:${site.slug}`, JSON.stringify(merged));
  await saveSiteConfig(site.slug, { agentKeywords: merged.join(', ') }).catch(() => {});
  return { added: fresh };
}
// ---- rank-drop recovery ------------------------------------------------------
// A keyword that fell 8+ places (or dropped out of the results) since the last
// check is the most valuable thing to work on — it's a page that WAS winning.
// This puts a targeted re-optimisation of that keyword's page at the front of
// the queue instead of waiting for the monthly rotation to reach it.
async function recoveryItems(slug, htmlFiles) {
  const [curRaw, prev] = await Promise.all([store.get(`agent:ranks:${slug}`).catch(() => null), readPrevRanks(slug)]);
  let cur = null;
  try {
    cur = curRaw ? (typeof curRaw === 'string' ? JSON.parse(curRaw) : curRaw) : null;
  } catch {
    cur = null;
  }
  if (!cur || !prev) return [];
  const M = MONTH();
  const home = htmlFiles.find((p) => /(^|\/)index\.html?$/i.test(p)) || htmlFiles[0];
  const pageFor = (url) => {
    try {
      const path = new URL(url).pathname.replace(/^\/+|\/+$/g, '');
      if (!path) return home;
      return htmlFiles.find((p) => p === path || p === path + '.html' || p === path + '/index.html') || home;
    } catch {
      return home;
    }
  };
  return keywordTable(cur, prev)
    .filter((k) => k.change != null && (k.change <= -8 || (k.rank == null && k.prevRank != null && k.prevRank <= 30)))
    .slice(0, 2)
    .map((k) => {
      const page = pageFor((cur.results.find((x) => x.keyword === k.keyword) || {}).url || (prev.results || []).find((x) => x.keyword === k.keyword)?.url || '');
      return {
        key: `recover:${k.keyword}:${M}`,
        pages: [page],
        recover: true,
        keyword: k.keyword,
        from: k.prevRank,
        to: k.rank,
        title: `Recover the ranking for "${k.keyword}" (was #${k.prevRank}, now ${k.rank ? '#' + k.rank : 'off the first ' + (cur.depth || 100)})`,
        detail: `The search "${k.keyword}" ${k.rank ? `dropped from #${k.prevRank} to #${k.rank}` : `fell out of the results (it was #${k.prevRank})`}. Re-optimise ONLY the <title>, <meta name="description"> and Open Graph title/description in ${page} so it wins this search back: lead with the keyword's intent, be more specific and more useful than the competing results, keep it natural (title ≤ 60 chars, description ≤ 155). Change nothing visible on the page.`,
      };
    });
}

// ---- a whole new page, approved by text ------------------------------------
// New content is the biggest lever the leading SEO tools pull and the riskiest
// thing to publish unattended, so it is drafted as an UNMERGED pull request and
// the owner is texted to approve it. YES publishes, NO discards. Needs text
// messaging (there is no other way to ask), and one per site per month.
async function pickNewPageKeyword(slug) {
  const raw = await store.get(`agent:ranks:${slug}`).catch(() => null);
  let r = null;
  try {
    r = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : null;
  } catch {
    r = null;
  }
  const covered = new Set((await readArr(`agent:pages:${slug}`)).map((p) => p.keyword));
  const options = (r?.results || []).filter((x) => !x.error && (!x.rank || x.rank > 10) && !covered.has(x.keyword));
  // closest to page 1 first (a page on a term already at #11-40 usually wins fastest), then unranked
  options.sort((a, b) => (a.rank || 999) - (b.rank || 999));
  return options[0] || null;
}
const slugForPage = (kw) => String(kw).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

async function runNewPage(site, { key, spend, tree, homepageFile, pbKey }) {
  const target = await pickNewPageKeyword(site.slug);
  if (!target) {
    await markPlaybookDone(site.slug, pbKey);
    return { ok: true, action: 'no-change', reason: 'no keyword needs a new page right now' };
  }
  const keyword = target.keyword;
  const path = `${slugForPage(keyword)}.html`;
  if (tree.files.includes(path)) {
    await markPlaybookDone(site.slug, pbKey);
    return { ok: true, action: 'no-change', reason: 'a page for that keyword already exists' };
  }
  const template = await getFileContent(site.repo, homepageFile, tree.branch);
  if (!template) return { ok: false, error: 'could not read the homepage to use as a template' };
  const hasSitemap = tree.files.includes('sitemap.xml');
  const sitemap = hasSitemap ? await getFileContent(site.repo, 'sitemap.xml', tree.branch) : null;
  const intel = await serpIntel(site.slug);
  const ranksRaw = await store.get(`agent:ranks:${site.slug}`).catch(() => null);
  let rr = null;
  try {
    rr = ranksRaw ? (typeof ranksRaw === 'string' ? JSON.parse(ranksRaw) : ranksRaw) : null;
  } catch {
    rr = null;
  }
  const mine = (rr?.results || []).find((x) => x.keyword === keyword) || {};
  const user = `Business: ${site.name} — ${site.url}
Target search: "${keyword}" (this site currently ${mine.rank ? 'ranks #' + mine.rank : 'does not rank'} for it)
Existing pages: ${tree.files.filter((p) => /\.html?$/i.test(p)).join(', ')}
What Google shows for this search today — titles that outrank this site:
${(mine.topTitles || []).map((t) => `- "${t.title}" (${t.domain})`).join('\n') || '(none captured)'}
Questions people ask about it (answer the useful ones on the page): ${(mine.paa || []).join(' | ') || '(none captured)'}
Related searches: ${(mine.related || []).join(' | ') || '(none captured)'}

The site's homepage, whose <head>, header/navigation and footer you must reuse so the new page looks like part of the site:
${template.slice(0, 60000)}
${sitemap ? `\nCurrent sitemap.xml:\n${sitemap.slice(0, 6000)}` : ''}

TASK: create ONE new page, ${path}, that genuinely deserves to rank for "${keyword}".
Rules:
- Copy the <head> (stylesheet/font/script links, meta viewport, favicon), header/nav and footer markup from the homepage so it matches the site. If the homepage's styling is a large inline <style> block that cannot reasonably be reused, reply ONLY: NOOP: template uses large inline styles
- Body: 350-600 words of specific, genuinely useful content for someone searching "${keyword}", with one H1 (natural use of the keyword), H2 sections that answer the questions above, and clear links back to the homepage and the most relevant existing pages.
- Use ONLY facts stated on the homepage (services, location, hours, contact). NEVER invent prices, guarantees, awards, testimonials, statistics, addresses, phone numbers or years in business. If a useful fact isn't on the site, leave it out.
- Unique <title> (≤60 chars) and <meta name="description"> (≤155 chars), a <link rel="canonical"> to https://${String(site.url).replace(/^https?:\/\//, '').replace(/\/+$/, '')}/${path}, and a JSON-LD block (Service or LocalBusiness) using only facts from the site.
${sitemap ? '- Also add this page to sitemap.xml with a PATCH (insert one <url> entry before </urlset>; the FIND must appear exactly once).' : ''}

Reply in EXACTLY this format:
SUMMARY: ONE plain-English sentence for the business owner, e.g. "Added a new page for people searching '${keyword}'"
COMMIT: commit message
FILE: ${path}
REASON: one line
---BEGIN CONTENT---
the complete new page
---END CONTENT---
${sitemap ? 'PATCH: sitemap.xml\nREASON: list the new page\n---FIND---\n</urlset>\n---REPLACE---\n<url>...</url>\n</urlset>\n---END PATCH---' : ''}`;
  const planSystem = 'You are a senior local-SEO content writer and front-end engineer building one new page for a real client site. You never invent facts. Reply in the exact plain-text format requested — no JSON, no markdown fences.';
  const first = await callAgent(key, planSystem, { prefix: user }, 8000);
  await spend(first.usd);
  const plan = await finalizePlan(first.text, { repo: site.repo, branch: tree.branch });
  if (!plan.files.length && plan.noop) {
    await markPlaybookDone(site.slug, pbKey);
    return { ok: true, action: 'no-change', reason: 'new page skipped — ' + plan.noop };
  }
  const page = plan.files.find((f) => f.path === path);
  const bad =
    !page ||
    !/<title>[^<]{5,}/i.test(page.content) ||
    !/<h1[\s>]/i.test(page.content) ||
    page.content.length < 1500 ||
    page.content.length > 60000 ||
    looksSpammy(page.content) ||
    plan.files.some((f) => f.path.includes('..') || (f.path !== path && f.path !== 'sitemap.xml'));
  if (bad) {
    await markStuck(site.slug, 'pb:' + pbKey);
    return { ok: false, error: 'new page draft did not pass the checks' + (plan.patchErrors?.length ? ' (' + plan.patchErrors[0] + ')' : '') };
  }
  const res = await commitChangeset(site.repo, {
    files: plan.files.map((f) => ({ path: f.path, content: f.content })),
    message: (plan.commitMessage || `New page: ${keyword}`).slice(0, 100),
    branchPrefix: 'seo-newpage',
    autoMerge: false,
    body: `**${plan.summary || 'New page'}**\n\nTarget search: "${keyword}"\n\nDrafted by the Inspiring Websites SEO agent. Not published until approved.`,
  });
  const number = prNumberFromUrl(res.prUrl);
  await markPlaybookDone(site.slug, pbKey);
  const pages = await readArr(`agent:pages:${site.slug}`);
  pages.push({ keyword, path, at: Date.now(), prUrl: res.prUrl });
  await store.set(`agent:pages:${site.slug}`, JSON.stringify(pages.slice(-30)), { ex: 60 * 60 * 24 * 400 }).catch(() => {});
  await log(site.slug, { action: 'new page drafted', detail: `${path} for "${keyword}" — waiting for approval`, prUrl: res.prUrl });
  await askOwner({
    kind: 'new-page',
    text: `${site.name}: new page drafted for "${keyword}". Not live, not in your menu. Review ${res.prUrl} Publish it?`,
    payload: { repo: site.repo, number, slug: site.slug, path, keyword, summary: plan.summary || `Added a new page for people searching "${keyword}"` },
  }).catch(() => {});
  return { ok: true, action: 'new-page-proposed', reason: null, pr: res };
}

function buildPlaybook({ keywords, rankLine, intel, files, htmlFiles, done, homepage, recover = [], newPageOk = false }) {
  const M = MONTH();
  const kw = keywords.slice(0, 8).join(', ') || '(none set yet)';
  const items = [];
  const has = (re) => files.some((p) => re.test(p));
  const pages = htmlFiles.slice().sort((a, b) => (/(^|\/)index\.html?$/i.test(a) ? -1 : /(^|\/)index\.html?$/i.test(b) ? 1 : 0)).slice(0, 8);
  if (!has(/(^|\/)sitemap\.xml$/i)) {
    items.push({ key: 'sitemap', pages: [], title: 'Add a sitemap.xml so Google finds every page', detail: `Create sitemap.xml at the site root listing every page (${pages.join(', ')}) using the live domain URLs.` });
  }
  if (!has(/(^|\/)robots\.txt$/i)) {
    items.push({ key: 'robots', pages: [], title: 'Add a robots.txt that points Google to the sitemap', detail: 'Create robots.txt allowing all crawlers and referencing the sitemap URL.' });
  }
  if (!has(/(^|\/)llms\.txt$/i)) {
    items.push({ key: 'llms', pages: [], title: 'Add an llms.txt so AI search tools describe the business correctly', detail: 'Create llms.txt: business name, what it does, where it serves, and the key pages — only facts stated on the site.' });
  }
  const hasSchema = /application\/ld\+json/i.test(homepage) && /(LocalBusiness|Organization|ProfessionalService|Store|Restaurant|HealthAndBeautyBusiness|AutomotiveBusiness)/i.test(homepage);
  if (pages.length && !hasSchema) {
    items.push({ key: 'schema:home', pages: [pages[0]], title: 'Add LocalBusiness structured data to the homepage', detail: `Edit ${pages[0]}: add one JSON-LD LocalBusiness/Organization block (name, url, description, areaServed, services offered) using ONLY facts already stated on the site — never invent an address, phone, rating or review. Add it inside <head>; change nothing visible.` });
  }
  items.push({ key: `kw:${M}`, kind: 'keywords', pages: [], title: 'Find new long-tail searches from Google suggestions', detail: '' });
  if (newPageOk) items.push({ key: `newpage:${M}`, kind: 'newpage', pages: [], title: 'Draft a new page for a search this site does not win yet', detail: '' });
  for (const p of pages) {
    items.push({
      key: `meta:${p}:${M}`,
      pages: [p],
      title: `Sharpen the Google title & description on ${p}`,
      detail: `Edit ONLY the <title>, <meta name="description"> and Open Graph title/description tags in ${p} (nothing visible on the page). Target keywords: ${kw}. Current rankings — ${rankLine || 'not checked yet'}. Prioritise keywords ranking 11–40 that this page genuinely covers. Also make sure the page has exactly one <link rel="canonical"> pointing at its own live URL (add it if missing, fix it if it points elsewhere). Title ≤ 60 chars, description ≤ 155 chars, written for a human first, keep the brand name, use a keyword only where it reads naturally.${intel ? `

What Google shows today for the searches this site does NOT yet win — write a title and description that can genuinely compete with these (better, more specific, more useful; never copy them):
${intel}` : ''}`,
    });
  }
  for (const p of pages) {
    items.push({
      key: `perf:${p}`,
      pages: [p],
      title: `Speed up loading on ${p} without changing how it looks`,
      detail: `Edit ONLY markup attributes in ${p} — never image/video files, never visible design, never CSS. Allowed, and only where clearly safe: (1) add decoding="async" to <img>; (2) add loading="lazy" ONLY to images clearly far down the page or in the footer — never to the first screen; (3) mark the single main hero/first-screen image with fetchpriority="high" (and no lazy loading); (4) add <link rel="preconnect"> for third-party origins (fonts, analytics) that the page really loads from. Do NOT add width/height attributes (that can visibly resize an image) and do NOT add defer/async to scripts (that can break the page). Slow pages rank worse and lose visitors. If nothing here is safely improvable, reply NOOP.`,
    });
  }
  for (const p of pages) {
    items.push({
      key: `alt:${p}:${M}`,
      pages: [p],
      title: `Write descriptive image alt text on ${p}`,
      detail: `Edit ONLY alt="" attributes in ${p}: give every meaningful image a specific, natural, descriptive alt (what it shows, and the business/location where it truthfully fits). Leave decorative images with empty alt. Change nothing else.`,
    });
  }
  return [...recover, ...items].filter((i) => !done.has(i.key));
}
async function noteFailure(slug, why) {
  const key = `agent:fail:${slug}:${new Date().toISOString().slice(0, 10)}`;
  const n = (Number(await store.get(key).catch(() => 0)) || 0) + 1;
  await store.set(key, String(n), { ex: 60 * 60 * 30 }).catch(() => {});
  if (n === FAIL_CAP_PER_DAY) {
    await notifyOwner(`SEO on ${slug} paused for today after ${n} failed attempts (${String(why || 'unknown').slice(0, 90)}). It resumes tomorrow on its own.`, { subject: `SEO paused today: ${slug}` }).catch(() => {});
  }
}
async function noteShipped(slug, text) {
  const list = await readArr(`changelog:${slug}`);
  list.push({ date: new Date().toISOString().slice(0, 10), text: String(text).slice(0, 300) });
  while (list.length > 60) list.shift();
  await store.set(`changelog:${slug}`, JSON.stringify(list)).catch(() => {});
}
// A cycle that shipped nothing shouldn't burn the whole 2-day pacing window —
// let the next scheduler tick (a couple of hours) try the next candidate.
// One-off setup steps (picking keywords, tagging conversions) are not the site's
// "general cycle" — don't make the real work wait 2 days behind them.
async function freeCycle(slug) {
  await store.set(`agent:lastCycleAt:${slug}`, String(Date.now() - MIN_DISCRETIONARY_GAP_MS + 10 * 60000), { ex: 60 * 60 * 24 * 45 }).catch(() => {});
}
async function retrySoon(slug) {
  // ...but never more than 4 quick retries a day per site, so a run of
  // "nothing to change here" answers can't quietly burn the monthly budget.
  const dayKey = `agent:idle:${slug}:${new Date().toISOString().slice(0, 10)}`;
  const tries = (Number(await store.get(dayKey).catch(() => 0)) || 0) + 1;
  await store.set(dayKey, String(tries), { ex: 60 * 60 * 30 }).catch(() => {});
  if (tries > 4) return;
  await store.set(`agent:lastCycleAt:${slug}`, String(Date.now() - MIN_DISCRETIONARY_GAP_MS + 2 * 3600000), { ex: 60 * 60 * 24 * 45 }).catch(() => {});
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
  // Optional — set when part or all of the task isn't something a file edit
  // can do at all (e.g. it's live database/app state, a third-party
  // dashboard setting, DNS, anything not actually stored in this repo).
  // Lets the model ship whatever IS file-editable and say plainly what
  // isn't, instead of the whole reply reading as a generic "wrong format"
  // failure that just gets retried forever against content that can never
  // change the outcome.
  const blocked = (s.match(/^BLOCKED:\s*(.+)$/im) || [])[1]?.trim() || '';
  // Optional — for recurring, non-client work only: the target is already in
  // good shape, so there's honestly nothing to change. Lets the model say so
  // instead of inventing a pointless edit (or failing the format).
  const noop = (s.match(/^NOOP:\s*(.+)$/im) || [])[1]?.trim() || '';
  const files = [];
  // case-insensitive, REASON optional, and tolerant of extra spaces/dashes
  // around the BEGIN/END markers — small formatting drift shouldn't be able
  // to sink an otherwise-correct reply.
  const re = /^FILE:\s*(.+?)\s*\r?\n(?:REASON:\s*(.*?)\s*\r?\n)?-{2,}\s*BEGIN CONTENT\s*-{2,}\r?\n([\s\S]*?)\r?\n-{2,}\s*END CONTENT\s*-{2,}/gim;
  let m;
  while ((m = re.exec(s))) files.push({ path: m[1].trim(), reason: (m[2] || '').trim(), content: m[3] });
  // PATCH blocks: small exact find/replace edits to an EXISTING file, so a
  // 50KB+ page can be changed without the model re-typing all of it (which
  // blew past the reply's token limit and made big pages un-editable).
  const patches = [];
  const pre = /^PATCH:\s*(.+?)\s*\r?\n(?:REASON:\s*(.*?)\s*\r?\n)?-{2,}\s*FIND\s*-{2,}\r?\n([\s\S]*?)\r?\n-{2,}\s*REPLACE\s*-{2,}\r?\n([\s\S]*?)\r?\n-{2,}\s*END PATCH\s*-{2,}/gim;
  let pm;
  while ((pm = pre.exec(s))) patches.push({ path: pm[1].trim(), reason: (pm[2] || '').trim(), find: pm[3], replace: pm[4] });
  return { summary, commitMessage, blocked, noop, files, patches };
}

// Turns PATCH blocks into ordinary {path, content} file changes by applying
// each exact find/replace to the file's real, full, current content (fetched
// fresh — the prompt sample may have been truncated). Every FIND must match
// exactly once; anything else is reported back so the retry can fix it
// instead of silently shipping a wrong edit.
async function finalizePlan(text, { repo, branch, fetchFile = getFileContent }) {
  const plan = parsePlan(text);
  plan.patchErrors = [];
  plan.originals = {};
  if (!plan.patches.length) return plan;
  const byPath = new Map();
  for (const p of plan.patches) {
    const path = p.path.replace(/^\/+/, '');
    if (!byPath.has(path)) byPath.set(path, []);
    byPath.get(path).push(p);
  }
  for (const [path, list] of byPath) {
    const original = await fetchFile(repo, path, branch);
    if (original == null) {
      plan.patchErrors.push(`${path}: could not read the current file`);
      continue;
    }
    let content = original;
    let ok = true;
    for (const p of list) {
      const n = p.find ? content.split(p.find).length - 1 : 0;
      if (n !== 1) {
        plan.patchErrors.push(`${path}: the FIND text ${n === 0 ? 'was not found' : 'matched ' + n + ' places (must be unique — include more surrounding text)'}: "${p.find.slice(0, 80).replace(/\s+/g, ' ')}"`);
        ok = false;
        break;
      }
      content = content.replace(p.find, () => p.replace);
    }
    if (!ok || content === original) continue;
    plan.files.push({ path, reason: list.map((x) => x.reason).filter(Boolean)[0] || 'update', content, patched: true, replaceText: list.map((x) => x.replace).join('\n') });
    plan.originals[path] = original;
  }
  return plan;
}

// A client-requested revision isn't optional AI-discretion work — it
// shouldn't wait on the monthly SEO exploration budget or the pacing floor
// that's meant to spread THAT spend across the month. But exempting it
// from any ceiling at all is genuinely risky if the agent itself has a bug
// (exactly what was happening this week) — every failed attempt still
// costs real money, and with no cap, a systemic problem could burn an
// unbounded amount while shipping nothing. This is the actual backstop:
// a small, separate ceiling just for revision spend. The 3-strike circuit
// breaker still stops any ONE stuck ticket after 3 tries; this stops the
// site's TOTAL revision spend for the month if several different tickets
// each burn their 3 strikes.
const REVISION_MONTHLY_CEILING = 8;

export async function runAgentCycle(site, opts = {}) {
  const st = await agentStatus(site);
  const todosPeek = await todosState(site).catch(() => ({ current: null }));
  // A revision counts as pending ONLY if the agent hasn't already given up on it.
  // Given-up revisions stay in the list (so the ticket can show "needs attention"),
  // and counting them here exempted the site from BOTH the monthly budget cap and
  // the pacing floor for every later cycle — a site stuck on one impossible
  // revision could ship discretionary work over and over, far past its cap
  // (one hit $23.81 of $20 and shipped 5 times in 40 minutes).
  const revItemsPeek = (todosPeek.current?.items || []).filter((it) => it.source === 'revision');
  const revGaveUp = await Promise.all(revItemsPeek.map((it) => store.get(`agent:revgaveup:${it.id}`).catch(() => null)));
  const hasPendingRevision = revItemsPeek.some((it, i) => !revGaveUp[i]);
  let reasons = st.reasons;
  if (hasPendingRevision) {
    const m = MONTH();
    const revSpent = Number(await store.get(`agent:revspend:${site.slug}:${m}`).catch(() => 0)) || 0;
    const exemptReasons = st.reasons.filter((r) => !r.includes('budget is used') && !r.startsWith('paced'));
    reasons =
      revSpent < REVISION_MONTHLY_CEILING
        ? exemptReasons
        : [...exemptReasons, `revision attempts have used $${revSpent.toFixed(2)} this month without shipping — pausing automatic retries so this can't run unbounded; check the ticket's Last attempt for what's actually wrong`];
  }
  if (reasons.length) return { ok: false, skipped: true, slug: site.slug, reason: reasons.join('; '), status: st };
  if (st.running) return { ok: false, alreadyRunning: true, slug: site.slug, reason: `already running — ${st.runningTask || 'working'} (started ${st.runningSince ? Math.round((Date.now() - st.runningSince) / 1000) : '?'}s ago)`, status: st };
  await setRunning(site.slug, 'Starting a cycle');
  try {
    // ctx lets the inner cycle report WHICH revision it worked, so callers can
    // attach the outcome to that exact ticket (not just "the first queued one")
    const ctx = {};
    const res = await runAgentCycleInner(site, st, { ...opts, ctx });
    return ctx.todoId ? { ...res, todoId: ctx.todoId } : res;
  } finally {
    await clearRunning(site.slug);
  }
}

async function runAgentCycleInner(site, st, { manual = false, ctx = {} } = {}) {
  const key = process.env.ANTHROPIC_API_KEY_AGENT || process.env.ANTHROPIC_API_KEY;
  const m = MONTH();
  // set true right after pendingRevision is known, below — tracks spend on
  // revision work separately so REVISION_SPEND_CEILING (in runAgentCycle)
  // can bound it even though revisions are exempt from the site's regular
  // discretionary cap.
  let spendIsRevisionWork = false;
  const spend = async (usd) => {
    await bump(`agent:spend:${m}`, usd);
    await bump(`agent:spend:${site.slug}:${m}`, usd);
    if (spendIsRevisionWork) await bump(`agent:revspend:${site.slug}:${m}`, usd);
    await markAiMonth(m);
  };

  let homepage = '';
  try {
    homepage = (await fetch(site.url, { signal: AbortSignal.timeout(12000) }).then((r) => r.text())).slice(0, 14000);
  } catch {
    /* ok */
  }

  // a client-requested revision jumps the whole queue — it doesn't wait on
  // this site's first-run keyword step or its rank-check turn. Picks the
  // OLDEST pending revision, not just the first array entry — new revisions
  // get PREPENDED to the to-do list (addRevisionTodo), so a plain .find()
  // here always grabbed the newest request instead of the one that's
  // actually been waiting longest, silently starving whichever ticket the
  // dashboard was telling Mondo was "next in line." Skips any revision the
  // agent already gave up on (REVISION_FAIL_LIMIT consecutive failures) so
  // a permanently-stuck task stops burning the budget on repeat attempts —
  // resolveCompletedTickets() in lib/revisions.js surfaces that on the
  // ticket itself so it's not just silently frozen.
  const todosRec = await todosState(site).catch(() => ({ current: null }));
  const revisionItemsAll = (todosRec.current?.items || []).filter((it) => it.source === 'revision');
  const revisionGiveUpFlags = await Promise.all(revisionItemsAll.map((it) => store.get(`agent:revgaveup:${it.id}`).catch(() => null)));
  const revisionItems = revisionItemsAll.filter((it, i) => !revisionGiveUpFlags[i]);
  const pendingRevision = revisionItems.length
    ? revisionItems.reduce((oldest, it) => ((it.addedAt || 0) < (oldest.addedAt || 0) ? it : oldest))
    : null;
  spendIsRevisionWork = !!pendingRevision;
  if (pendingRevision) ctx.todoId = pendingRevision.id;
  // Mark this site's turn as used for pacing purposes — but only for
  // discretionary work. A revision cycle shouldn't push out the next
  // general SEO check; the two tracks are independent on purpose.
  if (!pendingRevision) await store.set(`agent:lastCycleAt:${site.slug}`, String(Date.now()), { ex: 60 * 60 * 24 * 45 }).catch(() => {});

  // ---- first run: establish target keywords ----
  let keywords = st.keywords;
  if (!keywords.length && !pendingRevision) {
    await setRunning(site.slug, 'Picking target keywords');
    try {
      keywords = await pickKeywords(site, homepage, { key, spend });
      if (keywords.length) await log(site.slug, { action: 'keywords', detail: `Set ${keywords.length} target keywords` });
    } catch (e) {
      await log(site.slug, { action: 'error', detail: 'keyword step: ' + (e.message || e) });
      return { ok: false, slug: site.slug, error: 'keyword step failed: ' + (e.message || e) };
    }
    await freeCycle(site.slug);
    return { ok: true, slug: site.slug, action: 'keywords', keywords, status: await agentStatus(site) };
  }

  // ---- first run (part 2): auto-instrument conversion tracking ----
  // One-time per site — scans the homepage for buttons/links the tracker's
  // built-in patterns don't already catch (tel/sms/mailto/WhatsApp/booking/
  // review/directions/form-submit) and commits data-track="..." onto the
  // ones a model judges to be real conversions. Without this, "what counts
  // as a conversion" only ever got fixed by a human manually editing code —
  // see lib/conversions-setup.js for the full story.
  if (!pendingRevision) {
    const convKey = `conv:tagged:${site.slug}`;
    const alreadyTagged = await store.get(convKey).catch(() => null);
    if (!alreadyTagged) {
      await setRunning(site.slug, 'Setting up conversion tracking');
      let result;
      try {
        result = await autoTagConversions(site, { spend });
      } catch (e) {
        result = { ok: false, error: String(e.message || e) };
      }
      await store.set(convKey, String(Date.now()), { ex: 60 * 60 * 24 * 365 }).catch(() => {});
      await log(site.slug, {
        action: result.ok ? 'conversions' : 'error',
        detail: result.ok
          ? result.tagged
            ? `Tagged ${result.tagged} conversion element${result.tagged === 1 ? '' : 's'}: ${(result.applied || []).map((a) => a.name).join(', ')}`
            : result.note || 'nothing new to tag'
          : 'conversion setup: ' + result.error,
      });
      await freeCycle(site.slug);
      return { ok: true, slug: site.slug, action: 'conversions', result, status: await agentStatus(site) };
    }
  }

  // ---- rankings ----
  // No inline re-check any more: rankings refresh on their own ~3-day schedule
  // (refreshRanksIfStale, driven by the automation tick). Doing 12 live SERP
  // lookups here cost ~15s of a 60s function budget on EVERY cycle and pushed
  // real work over Vercel's limit.
  const ranks = null;

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
  // Only trust audit findings from a REAL audit. When the scan is missing or
  // rate-limited, buildFindings() returns "Could not reach the site for a
  // scan" — a problem with our tooling, not the site. It used to be handed to
  // the agent as its task every cycle (nothing a file edit can fix), burning
  // budget and starving the real work behind it.
  const findings = audit?.ok ? buildFindings(audit, null).filter((f) => f.severity !== 'good') : [];
  // pick the first candidate that hasn't already dead-ended and that a file
  // edit can actually accomplish; fall through to the playbook when none is.
  let targetKey = null; // stuck-tracking key for a non-revision target
  let playbookKey = null;
  let playbookKind = null;
  let playbookPages = null; // pages a playbook task needs sampled (keeps the prompt small + fast)
  let targetItem = pendingRevision;
  if (!targetItem) {
    const stuck = await stuckKeys(site.slug);
    const pool = [
      ...aiTodoItems.map((it) => ({ ...it, _key: it.id || 'todo:' + it.title })),
      ...findings.map((f) => ({ id: null, title: f.title, detail: f.detail, category: 'SEO', _key: 'finding:' + f.title })),
    ].filter((it) => !stuck.has(it._key) && !UNSHIPPABLE.test(`${it.title} ${it.detail || ''}`));
    if (pool.length) {
      targetItem = pool[0];
      targetKey = pool[0]._key;
    } else {
      const done = await playbookDone(site.slug);
      const pb = buildPlaybook({
        keywords,
        rankLine: await rankContext(site.slug),
        intel: await serpIntel(site.slug),
        recover: await recoveryItems(site.slug, htmlFiles),
        newPageOk: smsConfigured(),
        files: tree.files,
        htmlFiles,
        done,
        homepage,
      }).find((i) => !stuck.has('pb:' + i.key));
      if (pb) {
        targetItem = { id: null, title: pb.title, detail: pb.detail, category: 'SEO' };
        playbookKey = pb.key;
        playbookPages = pb.pages || null;
        playbookKind = pb.kind || null;
        if (pb.recover && !(await store.get(`recoverNotified:${site.slug}:${pb.key}`).catch(() => null))) {
          await store.set(`recoverNotified:${site.slug}:${pb.key}`, '1', { ex: 60 * 60 * 24 * 40 }).catch(() => {});
          await notifyOwner(`Rank drop on ${site.name}: "${pb.keyword}" went from #${pb.from} to ${pb.to ? '#' + pb.to : 'off page 10'}. I'm working on winning it back.`, { subject: `Rank drop: ${site.name}` }).catch(() => {});
        }
        targetKey = 'pb:' + pb.key;
      }
    }
  }
  // not a file edit: grow the tracked keyword list from Google's suggestions
  if (playbookKind === 'keywords') {
    try {
      const r = await expandKeywords(site, { key, spend });
      await markPlaybookDone(site.slug, playbookKey);
      if (r.added.length) {
        await noteShipped(site.slug, `Started tracking ${r.added.length} more searches your customers use: ${r.added.join(', ')}`);
        await log(site.slug, { action: 'keywords', detail: 'Added ' + r.added.join(', ') });
      }
      await retrySoon(site.slug);
      return { ok: true, slug: site.slug, action: r.added.length ? 'keywords-expanded' : 'no-change', reason: r.added.length ? null : 'no new search ideas yet', ranks, status: await agentStatus(site) };
    } catch (e) {
      await markStuck(site.slug, targetKey);
      await noteFailure(site.slug, e.message || e);
      return { ok: false, slug: site.slug, error: 'keyword expansion failed: ' + (e.message || e), ranks };
    }
  }
  if (playbookKind === 'newpage') {
    try {
      const home = htmlFiles.find((p) => /(^|\/)index\.html?$/i.test(p)) || htmlFiles[0];
      const r = await runNewPage(site, { key, spend, tree, homepageFile: home, pbKey: playbookKey });
      if (r.action === 'no-change' || r.ok === false) await retrySoon(site.slug);
      if (r.ok === false) await noteFailure(site.slug, r.error);
      return { slug: site.slug, ranks, status: await agentStatus(site), ...r };
    } catch (e) {
      await markStuck(site.slug, targetKey);
      await noteFailure(site.slug, e.message || e);
      return { ok: false, slug: site.slug, error: 'new page failed: ' + (e.message || e), ranks };
    }
  }
  if (!targetItem) {
    await log(site.slug, { action: 'no-change', detail: 'everything on the playbook is done for now — next round starts next month' });
    return { ok: true, slug: site.slug, action: 'no-change', reason: 'playbook complete for this month', ranks, status: await agentStatus(site) };
  }

  // Which HTML file(s) is this task actually about? Filename-keyword scoring
  // is a weak signal on its own — a real page was named "c.html" (a per-item
  // detail template, nothing about the task's wording matched it) — so for a
  // small site, EVERY page gets included rather than guessing which few
  // matter. But inclusion order still matters: the fetch loop below spends a
  // shared total budget file by file, and on the very next attempt after
  // that fix landed, a 132KB homepage (unrelated to this task, but tree-
  // order put it 3rd) silently ate the entire remaining budget before the
  // actually-relevant 10KB rankings page was ever reached — same failure,
  // new cause. Scoring now always determines fetch ORDER (most relevant
  // first), even when every file is going to be included either way, so a
  // big irrelevant file can never crowd out a small relevant one again.
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
    .sort((a, b) => b.score - a.score); // stable — ties keep their original order
  let likelyTargets;
  if (htmlFiles.length <= 8) {
    likelyTargets = scoredHtml.map((x) => x.p); // small site: everyone's included, relevance just sets priority
  } else {
    const top = scoredHtml.filter((x) => x.score > 0).slice(0, 6).map((x) => x.p);
    likelyTargets = top.length ? top : scoredHtml.slice(0, 4).map((x) => x.p);
  }
  // A playbook task only ever needs its one page (or, for sitemap/robots/llms,
  // just the homepage for context) — sampling the whole site made every cycle
  // slow and expensive for no benefit.
  if (playbookKey && playbookPages) {
    const home = htmlFiles.find((p) => /(^|\/)index\.html?$/i.test(p)) || htmlFiles[0];
    likelyTargets = (playbookPages.length ? playbookPages : [home]).filter(Boolean);
  }
  // A 6000-char (then 16000) per-file cap was enough to silently truncate
  // BEFORE reaching the relevant part of a real page. Sonnet's context
  // window has plenty of room for full real-world page sizes — raised well
  // past what any realistic small-site page total should hit, so ordering
  // is now a backstop, not the only thing standing between this and the
  // same failure on a bigger site.
  const PER_FILE_CAP = 100000;
  const TOTAL_SAMPLE_BUDGET = playbookKey ? 90000 : 400000;
  const sample = {};
  let budgetLeft = TOTAL_SAMPLE_BUDGET;
  for (const p of [...configish, ...likelyTargets].filter(Boolean).slice(0, 10)) {
    if (budgetLeft <= 500) break;
    const c = await getFileContent(site.repo, p, tree.branch);
    if (!c) continue;
    const take = c.slice(0, Math.min(PER_FILE_CAP, budgetLeft));
    sample[p] = take;
    budgetLeft -= take.length;
  }
  // a client-requested style tweak needs the actual stylesheet, not just the
  // page markup — pull in whichever CSS file(s) the sampled page(s) actually
  // link to, so a revision cycle that's allowed to touch color/style isn't
  // stuck unable to because the stylesheet was never shown to it.
  if (pendingRevision) {
    const cssFiles = tree.files.filter((p) => /\.(css|scss|less)$/i.test(p));
    const linked = new Set();
    for (const html of Object.values(sample)) {
      const hrefs = [...html.matchAll(/<link[^>]+href=["']([^"']+\.(?:css|scss|less))["']/gi)].map((m) => m[1].replace(/^\.?\//, ''));
      hrefs.forEach((h) => {
        const match = cssFiles.find((p) => p === h || p.endsWith('/' + h));
        if (match) linked.add(match);
      });
    }
    for (const p of [...linked].slice(0, 2)) {
      if (budgetLeft <= 500) break;
      const c = await getFileContent(site.repo, p, tree.branch);
      if (!c) continue;
      const take = c.slice(0, Math.min(PER_FILE_CAP, budgetLeft));
      sample[p] = take;
      budgetLeft -= take.length;
    }
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

Requests are often intentionally short — "bracelet 003" or "the receipt system" won't be explained further, because to the actual site owner/developer it's obvious what that refers to. Read the file contents you were given like a developer joining this specific codebase: figure out how the feature actually works (what's a template vs. static content, what's rendered from an id/param, what's computed at request time) before deciding what to change and where.

Some things genuinely cannot be done by editing a file in this repo — a value read live from a database/API at runtime (look for fetch/API calls, Firebase/Supabase/etc. reads, anything keyed by an id that isn't hardcoded), a third-party dashboard setting, DNS, billing. If part of the task is like that, say so plainly with BLOCKED (see format below) instead of guessing or refusing the whole task — and still make whatever part IS a real file edit.

HARD RULES — this ships straight to the live site with no human review, so:
${
  pendingRevision
    ? '- This is a specific client-requested change, so a narrow color/style edit is allowed ONLY if that is exactly what was asked for (e.g. "make this button green") — touch nothing else about the design, and never touch actual image/photo files.'
    : '- NEVER touch colors, fonts, visual design, spacing/layout, or images/photos. Don\'t edit any .css/.scss file or anything under an images/img/assets/media folder.'
}
- NEVER restructure the page (no removing/reordering sections beyond exactly what was asked, no changing what a page looks like to a visitor beyond the specific request). Technical + content only.
- Keep every change minimal, correct, and exactly what the to-do item asks for. At most 3 files.

Reply in EXACTLY this format (repeat the FILE block per file; BLOCKED is optional — include it ONLY if part or all of the task isn't achievable via a file edit, one specific sentence saying exactly what and why; omit it entirely if everything requested is file-editable. Nothing before SUMMARY or after the last ---END CONTENT--- / BLOCKED line):
${pendingRevision ? '' : `If the task's goal is ALREADY fully met on this site (nothing genuinely worth improving), reply with ONLY one line: NOOP: <why it's already good>. Do not invent a change just to have one.\n\n`}SUMMARY: ONE plain-English sentence a non-technical business owner would understand and be glad to read on their report (e.g. "Rewrote the Google title and description on your homepage so it reads better and includes 'mobile car detailing corinth tx'") — no file names, no jargon
COMMIT: commit message
BLOCKED: one line, only if something here can't be done via a file edit

HOW TO EDIT — pick per file:
- EXISTING file (strongly preferred, and REQUIRED for any file over ~6KB): one or more PATCH blocks, each an exact find/replace. Never re-type a whole existing page.
PATCH: path/to/file
REASON: one line
---FIND---
exact text copied verbatim from the file above; must appear EXACTLY ONCE in that file (include enough surrounding text to make it unique)
---REPLACE---
the new text that takes its place
---END PATCH---
- NEW file, or an existing file under ~6KB you are fully rewriting: a FILE block.
FILE: path/to/file
REASON: one line
---BEGIN CONTENT---
the complete file content, verbatim — no escaping needed
---END CONTENT---`;
  try {
    // 4000 was too tight for a real file's complete content plus any
    // explanation — the reply got cut off mid-file, no closing
    // ---END CONTENT---, zero files parsed, and it LOOKED like a format
    // problem when the real issue was running out of room.
    const PLAN_TOKENS = 8000;
    const first = await callAgent(key, planSystem, { prefix: planUser }, PLAN_TOKENS);
    await spend(first.usd);
    plan = await finalizePlan(first.text, { repo: site.repo, branch: tree.branch });
    const firstTruncated = first.stopReason === 'max_tokens';
    // The model looked at the actual code and concluded (with a specific,
    // stated reason) that nothing here is a file edit — e.g. a value read
    // live from a database at runtime. That's a real, useful answer, not a
    // format failure — retrying against the same unchanged file content
    // would just produce the identical answer again at the cost of another
    // billed call. Stop immediately and surface the reason, don't retry.
    // already-good: recurring work has nothing worth changing right now. Not
    // an error and not a dead end — mark it done for this round and let the
    // next scheduler tick move straight to the next item.
    if (!pendingRevision && !plan.files.length && plan.noop) {
      if (playbookKey) await markPlaybookDone(site.slug, playbookKey);
      else await markStuck(site.slug, targetKey);
      await log(site.slug, { action: 'no-change', detail: 'already good — ' + plan.noop });
      await retrySoon(site.slug);
      return { ok: true, slug: site.slug, action: 'no-change', reason: 'already good — ' + plan.noop, ranks, status: await agentStatus(site) };
    }
    if (!plan.files.length && plan.blocked) {
      await log(site.slug, { action: 'error', detail: 'blocked: ' + plan.blocked });
      if (pendingRevision) await bumpRevisionFailure(pendingRevision.id, { immediate: true });
      else {
        await markStuck(site.slug, targetKey);
        await noteFailure(site.slug, plan.blocked);
        await retrySoon(site.slug);
      }
      return { ok: false, slug: site.slug, error: plan.blocked, blocked: true, ranks };
    }
    if (!plan.files.length) {
      // one retry — if it got cut off, tell it to be concise and skip
      // straight to the format instead of explaining first; if it just
      // didn't follow the format, show it exactly what it sent so a
      // one-off slip has a real chance to self-correct.
      await log(site.slug, {
        action: 'error',
        detail: firstTruncated
          ? 'planning: first reply was cut off (hit the token limit) before finishing a file, retrying once'
          : "planning: first reply didn't match FILE/CONTENT format, retrying once",
        sample: first.text.slice(0, 1500),
      });
      const retryPrompt = plan.patchErrors && plan.patchErrors.length
        ? `Your previous reply's PATCH blocks could not be applied:\n- ${plan.patchErrors.join('\n- ')}\nReply again with corrected PATCH blocks. Copy each FIND text EXACTLY, character for character (same whitespace/quotes), from the file contents shown above, and make it unique in the file. Same format as before, nothing else.`
        : firstTruncated
        ? `Your previous reply got cut off before finishing — it ran out of room. This time, skip any explanation or preamble and go STRAIGHT to the format: SUMMARY, COMMIT, then one FILE / REASON / ---BEGIN CONTENT--- / ---END CONTENT--- block per file, nothing else.`
        : `Your previous reply could not be used because it didn't follow the required format. Here is exactly what you sent:\n"""\n${first.text.slice(0, 3000)}\n"""\nReply again, following the format EXACTLY — SUMMARY, COMMIT, then one FILE / REASON / ---BEGIN CONTENT--- / ---END CONTENT--- block per file (or just a BLOCKED line if truly nothing here is file-editable). Nothing else before or after.`;
      const retry = await callAgent(key, planSystem, { prefix: planUser, suffix: retryPrompt }, PLAN_TOKENS);
      await spend(retry.usd);
      plan = await finalizePlan(retry.text, { repo: site.repo, branch: tree.branch });
      if (!pendingRevision && !plan.files.length && plan.noop) {
        if (playbookKey) await markPlaybookDone(site.slug, playbookKey);
        else await markStuck(site.slug, targetKey);
        await log(site.slug, { action: 'no-change', detail: 'already good — ' + plan.noop });
        await retrySoon(site.slug);
        return { ok: true, slug: site.slug, action: 'no-change', reason: 'already good — ' + plan.noop, ranks, status: await agentStatus(site) };
      }
      if (!plan.files.length && plan.blocked) {
        await log(site.slug, { action: 'error', detail: 'blocked (after retry): ' + plan.blocked });
        if (pendingRevision) await bumpRevisionFailure(pendingRevision.id, { immediate: true });
        else {
          await markStuck(site.slug, targetKey);
          await noteFailure(site.slug, plan.blocked);
          await retrySoon(site.slug);
        }
        return { ok: false, slug: site.slug, error: plan.blocked, blocked: true, ranks };
      }
      if (!plan.files.length) {
        const retryTruncated = retry.stopReason === 'max_tokens';
        throw new Error(
          (retryTruncated ? 'model reply was cut off before finishing (hit the token limit), even after a retry' : 'model reply did not match the expected FILE/CONTENT format, even after a retry') +
            ' — sample: ' +
            retry.text.slice(0, 400).replace(/\s+/g, ' ')
        );
      }
    }
  } catch (e) {
    await log(site.slug, { action: 'error', detail: 'planning: ' + (e.message || e) });
    let errMsg = 'planning failed: ' + (e.message || e);
    if (pendingRevision) {
      const n = await bumpRevisionFailure(pendingRevision.id);
      if (n >= REVISION_FAIL_LIMIT) errMsg += ` — gave up after ${n} failed attempts, needs a manual look`;
    } else if (/^model reply/i.test(String(e.message || e))) {
      // the model couldn't produce a usable answer for this target twice in a row — move on
      await markStuck(site.slug, targetKey);
      await noteFailure(site.slug, e.message || e);
      await retrySoon(site.slug);
    }
    return { ok: false, slug: site.slug, error: errMsg, ranks };
  }

  const files = Array.isArray(plan.files) ? plan.files.filter((f) => f && f.path && typeof f.content === 'string') : [];
  const knownOrNew = (p) => sample[p] !== undefined || /(^|\/)(llms\.txt|robots\.txt|sitemap\.xml|humans\.txt)$/i.test(p);
  // belt-and-suspenders on top of the prompt's hard rules. Real image/photo
  // files are ALWAYS off-limits — an LLM can't meaningfully edit a binary
  // asset — regardless of what's being worked on. Stylesheets are only
  // blocked for the agent's own AI-picked SEO to-dos; an explicit,
  // client-requested revision (pendingRevision) is allowed a narrow color/
  // style edit, since that's exactly what a human asked for, not the AI
  // deciding on its own to touch the site's design.
  const isBinaryAsset = (p) => /\.(jpe?g|png|gif|svg|webp|avif|ico|bmp|tiff?)$/i.test(p) || /(^|\/)(images?|img|assets\/(img|media|photos?)|media|photos?)\//i.test(p);
  const isStylingFile = (p) => /\.(css|scss|less)$/i.test(p);
  const visualBlockApplies = (p) => isBinaryAsset(p) || (!pendingRevision && isStylingFile(p));
  const safe =
    files.length > 0 &&
    files.length <= 6 &&
    files.every(
      (f) =>
        !f.path.includes('..') &&
        knownOrNew(f.path) &&
        !visualBlockApplies(f.path) &&
        // a patched file is judged on what was actually ADDED, not the whole
        // existing page (a big real page trips the word-frequency check)
        (f.patched ? !looksSpammy(f.replaceText) && f.replaceText.length < 20000 : !looksSpammy(f.content) && f.content.length < 60000)
    );
  if (!safe) {
    await log(site.slug, { action: 'skipped', detail: `Plan rejected by safety check (${files.length} files): ${plan.summary || ''}` });
    let reason = 'plan failed safety check';
    if (pendingRevision) {
      const n = await bumpRevisionFailure(pendingRevision.id);
      if (n >= REVISION_FAIL_LIMIT) reason += ` — gave up after ${n} failed attempts, needs a manual look`;
    } else {
      await markStuck(site.slug, targetKey);
      await noteFailure(site.slug, 'plan failed the safety check');
      await retrySoon(site.slug);
    }
    return { ok: true, slug: site.slug, action: 'no-change', reason, ranks, status: await agentStatus(site) };
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
        (plan.blocked ? `\n\n⚠️ Not included — ${plan.blocked}` : '') +
        `\n\n_Automated by the Inspiring Websites SEO agent._`,
    });
    await log(site.slug, {
      action: site.agentAutoMerge ? 'shipped' : 'PR opened',
      detail: plan.summary || files.map((f) => f.path).join(', '),
      prUrl: res.prUrl,
      branch: res.branch,
    });
    if (pendingRevision) await clearRevisionFailure(pendingRevision.id);
    else {
      // recurring work: remember it's done (playbook) or recently handled
      // (audit finding) so the next cycle moves on instead of repeating it,
      // and put a plain-English line on the client's "what we did" list.
      if (playbookKey) await markPlaybookDone(site.slug, playbookKey);
      else if (!targetItem.id) await markStuck(site.slug, targetKey);
      if (!targetItem.id) await noteShipped(site.slug, plan.summary || targetItem.title);
    }
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
            files: files.map((f) => ({ path: f.path, before: plan.originals?.[f.path] ?? sample[f.path] ?? null })),
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
      // a partial ship — some of what was asked for went out, but the model
      // flagged part of it as not achievable via a file edit. Surfaced as
      // the attempt's "reason" so it shows on the ticket even though the
      // outcome is "shipped", instead of looking fully resolved.
      reason: plan.blocked || null,
      blocked: !!plan.blocked,
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


