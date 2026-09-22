// A real "is this actually working" self-check — because the whole point of
// this pass was that problems were only ever discovered by their symptoms
// days later (SEO gone quiet since the 15th, a site's budget silently maxed
// out, a stuck revision nobody noticed). This surfaces the underlying signals
// directly: is every service actually configured, did the daily automation
// run recently, is the revisions inbox current, is any site's budget blown,
// are any tickets sitting unresolved.
import { store } from './store.js';
import { listSites } from './registry.js';
import { agentStatus } from './agent.js';
import { googleConfigured } from './google.js';
import { githubConfigured } from './github.js';
import { serpConfigured } from './serp.js';

async function num(k) {
  const v = await store.get(k).catch(() => null);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
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

export async function systemHealth() {
  const now = Date.now();
  const sites = await listSites();

  const env = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    anthropicAgent: !!(process.env.ANTHROPIC_API_KEY_AGENT || process.env.ANTHROPIC_API_KEY),
    github: githubConfigured(),
    resend: !!(process.env.RESEND_API_KEY && process.env.REPORT_FROM),
    google: googleConfigured(),
    dataforseo: serpConfigured(),
    storage: store.backend === 'vercel-kv',
    cronSecret: !!process.env.CRON_SECRET,
  };

  const cronLastRun = await num('cron:daily:lastRun');
  const revisionsLastCheckSec = await num('revisions:lastCheck');
  const revisionsLastCheck = revisionsLastCheckSec ? revisionsLastCheckSec * 1000 : 0;

  const budgets = [];
  for (const s of sites) {
    const st = await agentStatus(s).catch(() => null);
    if (!st || !st.cap) continue;
    if (st.spentThisMonth >= st.cap) budgets.push({ slug: s.slug, name: s.name, spent: st.spentThisMonth, cap: st.cap, exhausted: true });
    else if (st.spentThisMonth >= st.cap * 0.85) budgets.push({ slug: s.slug, name: s.name, spent: st.spentThisMonth, cap: st.cap, exhausted: false });
  }

  const allTickets = await readArr('revisions:all');
  const ticketsNeedingAttention = allTickets.filter((t) => t.status === 'needs attention').length;

  // sites that haven't had the one-time automatic conversion-tagging pass
  // yet — informational, not urgent (a brand-new site just hasn't had its
  // first cycle yet), but worth knowing since it's a one-click fix.
  const untagged = [];
  for (const s of sites) {
    if (!s.repo) continue; // can't tag without a repo linked
    const tagged = await store.get(`conv:tagged:${s.slug}`).catch(() => null);
    if (!tagged) untagged.push(s.slug);
  }

  const issues = [];
  if (!env.anthropic) issues.push({ level: 'critical', text: 'No ANTHROPIC_API_KEY set — the SEO agent, revision email-reading, and Compass are all offline.' });
  if (!env.github) issues.push({ level: 'critical', text: 'No GITHUB_TOKEN set — nothing can ship code changes to any client site.' });
  if (!env.resend) issues.push({ level: 'warn', text: 'Resend not fully configured (RESEND_API_KEY + REPORT_FROM) — client emails (reports, revision confirmations) can\'t send.' });
  if (!env.google) issues.push({ level: 'warn', text: 'Google isn\'t connected — the revisions inbox and calendar holds are offline.' });
  if (!env.storage) issues.push({ level: 'critical', text: 'Not using persistent storage (Vercel KV) — data may not be saved between requests.' });
  if (!cronLastRun) issues.push({ level: 'warn', text: 'The daily automation pass has never recorded a run.' });
  else if (now - cronLastRun > 30 * 3600000) issues.push({ level: 'critical', text: `Daily automation hasn't run in over a day — last seen ${new Date(cronLastRun).toLocaleString()}.` });
  if (env.google && revisionsLastCheck && now - revisionsLastCheck > 2 * 3600000) {
    issues.push({ level: 'warn', text: `Revisions inbox hasn't been checked in over 2 hours — last checked ${new Date(revisionsLastCheck).toLocaleString()}.` });
  }
  if (ticketsNeedingAttention) issues.push({ level: 'warn', text: `${ticketsNeedingAttention} revision ticket${ticketsNeedingAttention === 1 ? '' : 's'} need${ticketsNeedingAttention === 1 ? 's' : ''} a manual look.` });
  budgets.forEach((b) => {
    if (b.exhausted) issues.push({ level: 'warn', text: `${b.name}'s general SEO budget is used up ($${b.spent}/$${b.cap}) — discretionary work pauses until next month (client-requested revisions still go through regardless).` });
  });
  if (untagged.length) {
    issues.push({ level: 'info', text: `${untagged.length} site${untagged.length === 1 ? '' : 's'} haven't had conversion tracking auto-set-up yet — use "🎯 Set up conversion tracking on all sites" below to do it right now instead of waiting for their turn.` });
  }

  return {
    ok: true,
    checkedAt: now,
    env,
    cronLastRun,
    revisionsLastCheck,
    ticketsNeedingAttention,
    budgets,
    untagged,
    healthy: !issues.some((i) => i.level === 'critical'),
    issues,
  };
}
