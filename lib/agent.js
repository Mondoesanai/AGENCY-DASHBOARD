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
import { autoTagConversions } from './conversions-setup.js';
import { summarizeRanks, appendRankHistory } from './ranks.js';

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
      const r = await rankBatch({ domain: site.url, keywords: keywords.slice(0, 12), device: 'mobile' });
      ranks = { at: Date.now(), ...r };
      await store.set(`agent:ranks:${site.slug}`, JSON.stringify(ranks));
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
    const r = await rankBatch({ domain: site.url, keywords: keywords.slice(0, 12), device: 'mobile' });
    const ranks = { at: Date.now(), ...r };
    await store.set(`agent:ranks:${site.slug}`, JSON.stringify(ranks));
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
  const files = [];
  // case-insensitive, REASON optional, and tolerant of extra spaces/dashes
  // around the BEGIN/END markers — small formatting drift shouldn't be able
  // to sink an otherwise-correct reply.
  const re = /^FILE:\s*(.+?)\s*\r?\n(?:REASON:\s*(.*?)\s*\r?\n)?-{2,}\s*BEGIN CONTENT\s*-{2,}\r?\n([\s\S]*?)\r?\n-{2,}\s*END CONTENT\s*-{2,}/gim;
  let m;
  while ((m = re.exec(s))) files.push({ path: m[1].trim(), reason: (m[2] || '').trim(), content: m[3] });
  return { summary, commitMessage, blocked, files };
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
  const hasPendingRevision = (todosPeek.current?.items || []).some((it) => it.source === 'revision');
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
    return await runAgentCycleInner(site, st, opts);
  } finally {
    await clearRunning(site.slug);
  }
}

async function runAgentCycleInner(site, st, { manual = false } = {}) {
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
      return { ok: true, slug: site.slug, action: 'conversions', result, status: await agentStatus(site) };
    }
  }

  // ---- rank refresh (skip when there's an urgent revision to get to) ----
  let ranks = null;
  if (serpConfigured() && !pendingRevision) {
    await setRunning(site.slug, 'Checking Google rankings');
    try {
      const r = await rankBatch({ domain: site.url, keywords: keywords.slice(0, 12), device: 'mobile' });
      ranks = { at: Date.now(), ...r };
      await store.set(`agent:ranks:${site.slug}`, JSON.stringify(ranks));
      const rankSummary = summarizeRanks(ranks);
      if (rankSummary) {
        await appendRankHistory(site.slug, { at: ranks.at, avgRank: rankSummary.avgRank, bestRank: rankSummary.bestRank, inTop10: rankSummary.inTop10, inTop3: rankSummary.inTop3 });
      }
      await log(site.slug, { action: 'ranks', detail: `Checked ${r.results.length} keywords · ${rankSummary?.inTop10 || 0} in top 10`, cost: 0 });
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
  // A 6000-char (then 16000) per-file cap was enough to silently truncate
  // BEFORE reaching the relevant part of a real page. Sonnet's context
  // window has plenty of room for full real-world page sizes — raised well
  // past what any realistic small-site page total should hit, so ordering
  // is now a backstop, not the only thing standing between this and the
  // same failure on a bigger site.
  const PER_FILE_CAP = 100000;
  const TOTAL_SAMPLE_BUDGET = 400000;
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
SUMMARY: one line
COMMIT: commit message
BLOCKED: one line, only if something here can't be done via a file edit
FILE: path/to/file
REASON: one line
---BEGIN CONTENT---
the complete new file content, verbatim — no escaping needed
---END CONTENT---`;
  try {
    // 4000 was too tight for a real file's complete content plus any
    // explanation — the reply got cut off mid-file, no closing
    // ---END CONTENT---, zero files parsed, and it LOOKED like a format
    // problem when the real issue was running out of room.
    const PLAN_TOKENS = 8000;
    const first = await callAgent(key, planSystem, planUser, PLAN_TOKENS);
    await spend(first.usd);
    plan = parsePlan(first.text);
    const firstTruncated = first.stopReason === 'max_tokens';
    // The model looked at the actual code and concluded (with a specific,
    // stated reason) that nothing here is a file edit — e.g. a value read
    // live from a database at runtime. That's a real, useful answer, not a
    // format failure — retrying against the same unchanged file content
    // would just produce the identical answer again at the cost of another
    // billed call. Stop immediately and surface the reason, don't retry.
    if (!plan.files.length && plan.blocked) {
      await log(site.slug, { action: 'error', detail: 'blocked: ' + plan.blocked });
      if (pendingRevision) await bumpRevisionFailure(pendingRevision.id, { immediate: true });
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
      const retryPrompt = firstTruncated
        ? `${planUser}\n\nYour previous reply got cut off before finishing — it ran out of room. This time, skip any explanation or preamble and go STRAIGHT to the format: SUMMARY, COMMIT, then one FILE / REASON / ---BEGIN CONTENT--- / ---END CONTENT--- block per file, nothing else.`
        : `${planUser}\n\nYour previous reply could not be used because it didn't follow the required format. Here is exactly what you sent:\n"""\n${first.text.slice(0, 3000)}\n"""\nReply again, following the format EXACTLY — SUMMARY, COMMIT, then one FILE / REASON / ---BEGIN CONTENT--- / ---END CONTENT--- block per file (or just a BLOCKED line if truly nothing here is file-editable). Nothing else before or after.`;
      const retry = await callAgent(key, planSystem, retryPrompt, PLAN_TOKENS);
      await spend(retry.usd);
      plan = parsePlan(retry.text);
      if (!plan.files.length && plan.blocked) {
        await log(site.slug, { action: 'error', detail: 'blocked (after retry): ' + plan.blocked });
        if (pendingRevision) await bumpRevisionFailure(pendingRevision.id, { immediate: true });
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
    files.every((f) => !f.path.includes('..') && knownOrNew(f.path) && !visualBlockApplies(f.path) && !looksSpammy(f.content) && f.content.length < 60000);
  if (!safe) {
    await log(site.slug, { action: 'skipped', detail: `Plan rejected by safety check (${files.length} files): ${plan.summary || ''}` });
    let reason = 'plan failed safety check';
    if (pendingRevision) {
      const n = await bumpRevisionFailure(pendingRevision.id);
      if (n >= REVISION_FAIL_LIMIT) reason += ` — gave up after ${n} failed attempts, needs a manual look`;
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
