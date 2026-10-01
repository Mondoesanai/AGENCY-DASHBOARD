// R1.7 — client ↔ repository mapping audit.
//
// WHY THIS EXISTS
// ---------------
// `cfg.repo` is free text. Saving it only strips a github.com prefix and a
// trailing ".git" — nothing checks that the repo exists, that the token may
// push to it, that it still has that name, or that two different clients are
// not pointing at the same repository. Every one of those failures used to
// surface at commit time, deep inside a cycle, AFTER a billed model call, as a
// generic "could not read repo" that the pipeline then retried.
//
// The requirement is explicit about the standard: mismatches are DETECTED AND
// REPORTED, not retried. So each finding below carries
//   severity  — error (will fail), warn (might be wrong), ok
//   code      — stable, machine-checkable
//   action    — the same vocabulary the revision state machine already uses
//               (link-repo / check-repo / reconnect-github / fix-permissions)
//   message   — what the owner reads
// and, where a fix is unambiguous and safe, a `fix` the owner can apply.
//
// GitHub quietly redirects a renamed repository, so a stale name keeps working
// right up until someone creates a new repo with the old name — at which point
// the agent commits a client's changes into a stranger's repository. That is
// why `renamed` is an error and not a note.
//
// Network access is injected (`gh`) so the whole module is testable against
// fixtures with no token and no live calls.

import { store } from './store.js';
import { listSites, saveSiteConfig } from './registry.js';
import { ghGet, githubConfigured } from './github.js';

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Collapse a hostname or repo name to comparable letters+digits. */
export function collapse(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\.(vercel\.app|netlify\.app|github\.io|com|net|org|co|io|dev|app|us|biz)$/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Clean a configured repo string and say what was wrong with it.
 * Deliberately does NOT silently accept rubbish: a bare name with no owner is
 * unusable, and guessing the owner is how work lands in the wrong account.
 */
export function parseRepoRef(raw) {
  const original = String(raw ?? '');
  let s = original.trim();
  if (!s) return { ok: false, code: 'no-repo', value: '' };

  s = s
    .replace(/^git@github\.com:/i, '')
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');

  // owner/name/tree/main, owner/name/blob/... etc — keep the first two parts
  const parts = s.split('/').filter(Boolean);
  let trimmedExtra = false;
  if (parts.length > 2) {
    trimmedExtra = true;
    s = parts.slice(0, 2).join('/');
  }

  if (parts.length === 1) return { ok: false, code: 'missing-owner', value: s };
  if (!REPO_RE.test(s)) return { ok: false, code: 'malformed', value: s };

  return { ok: true, value: s, changed: s !== original.trim(), trimmedExtra };
}

const finding = (slug, severity, code, message, extra = {}) => ({
  slug,
  severity,
  code,
  message,
  ...extra,
});

/**
 * Audit one site's repo mapping.
 *
 * @param site {{slug, url, repo, seoAgent}}
 * @param deps.gh    async (path) => { status, body }  — GitHub GET
 * @param deps.blockedReason  cached `agent:blocked:<slug>` value, or ''
 */
export async function auditSiteRepo(site, { gh, blockedReason = '' } = {}) {
  const out = [];
  const slug = site.slug;
  const agentOff = site.seoAgent === false;

  const ref = parseRepoRef(site.repo);

  if (!ref.ok && ref.code === 'no-repo') {
    // Not a defect when the agent is deliberately off for this client.
    out.push(
      finding(
        slug,
        agentOff ? 'ok' : 'error',
        'no-repo',
        agentOff
          ? 'No repository linked, and automation is off for this client — nothing to do.'
          : 'Automation is on but no repository is linked, so every change request will block.',
        { action: agentOff ? null : 'link-repo', configured: '' }
      )
    );
    return out;
  }

  if (!ref.ok) {
    const msg =
      ref.code === 'missing-owner'
        ? `"${site.repo}" has no owner — it needs to be in the form owner/repository.`
        : `"${site.repo}" is not a usable repository name.`;
    out.push(finding(slug, 'error', ref.code, msg, { action: 'check-repo', configured: site.repo }));
    return out;
  }

  const configured = String(site.repo).trim();
  if (ref.changed) {
    out.push(
      finding(slug, 'warn', 'needs-tidy', `Stored as "${configured}" — the usable part is "${ref.value}".`, {
        action: 'check-repo',
        configured,
        fix: { repo: ref.value },
      })
    );
  }

  if (!gh) {
    out.push(
      finding(slug, 'warn', 'unchecked', 'Could not check this against GitHub — no connection available.', {
        action: 'reconnect-github',
        configured,
      })
    );
    return out;
  }

  let res;
  try {
    res = await gh(`/repos/${ref.value}`);
  } catch (e) {
    // A network failure is NOT evidence that the mapping is wrong. Saying
    // "repo missing" here would block a perfectly good client on a blip.
    out.push(
      finding(slug, 'warn', 'unreachable', `GitHub could not be reached to check this: ${e.message || e}`, {
        action: null,
        configured,
        transient: true,
      })
    );
    return out;
  }

  const status = res?.status;
  const body = res?.body || {};

  if (status === 404) {
    out.push(
      finding(
        slug,
        'error',
        'not-found',
        `GitHub has no repository "${ref.value}" that this token can see — it may have been renamed, deleted, or made private.`,
        { action: 'check-repo', configured }
      )
    );
    return out;
  }
  if (status === 401) {
    out.push(
      finding(slug, 'error', 'bad-token', 'The GitHub connection was rejected — the token is invalid or expired.', {
        action: 'reconnect-github',
        configured,
      })
    );
    return out;
  }
  if (status === 403) {
    out.push(
      finding(slug, 'error', 'no-access', `The GitHub token is not allowed to read "${ref.value}".`, {
        action: 'fix-permissions',
        configured,
      })
    );
    return out;
  }
  if (status !== 200) {
    out.push(
      finding(slug, 'warn', 'unreachable', `GitHub returned ${status} when checking "${ref.value}".`, {
        action: null,
        configured,
        transient: true,
      })
    );
    return out;
  }

  const canonical = body.full_name || ref.value;

  // Renamed or differently-cased: the redirect hides this until the old name is
  // reused by someone else, and then commits go to the wrong repository.
  if (canonical.toLowerCase() !== ref.value.toLowerCase()) {
    out.push(
      finding(slug, 'error', 'renamed', `"${ref.value}" now resolves to "${canonical}" — the stored name is out of date.`, {
        action: 'check-repo',
        configured,
        canonical,
        fix: { repo: canonical },
      })
    );
  } else if (canonical !== ref.value) {
    out.push(
      finding(slug, 'warn', 'case-drift', `Stored as "${ref.value}", GitHub spells it "${canonical}".`, {
        action: null,
        configured,
        canonical,
        fix: { repo: canonical },
      })
    );
  }

  // Push rights. Without them the agent spends a model call, writes a change,
  // then fails at the commit — which is exactly the pattern R1.4 forbids.
  if (body.permissions && body.permissions.push === false) {
    out.push(
      finding(slug, 'error', 'no-push', `The GitHub token can read "${canonical}" but cannot push to it, so no change can ever ship.`, {
        action: 'fix-permissions',
        configured,
        canonical,
      })
    );
  }

  if (body.archived) {
    out.push(
      finding(slug, 'error', 'archived', `"${canonical}" is archived on GitHub and will reject every push.`, {
        action: 'check-repo',
        configured,
        canonical,
      })
    );
  }

  if (body.size === 0 || body.empty === true) {
    out.push(
      finding(slug, 'error', 'empty', `"${canonical}" has no code pushed to it yet.`, {
        action: 'check-repo',
        configured,
        canonical,
      })
    );
  }

  // Does this repo plausibly belong to this client? Reported as UNCERTAIN, never
  // as a failure — plenty of real repos are named nothing like the domain.
  const siteSlug = collapse(site.url);
  const repoName = collapse(String(canonical).split('/')[1]);
  const homepage = collapse(body.homepage);
  if (siteSlug && repoName) {
    const related =
      repoName === siteSlug ||
      homepage === siteSlug ||
      repoName.includes(siteSlug) ||
      siteSlug.includes(repoName);
    if (!related) {
      out.push(
        finding(
          slug,
          'warn',
          'url-mismatch',
          `"${canonical}" does not look related to ${site.url} — worth confirming it is the right repository. This is a guess from the name, not a fault.`,
          { action: 'check-repo', configured, canonical, uncertain: true }
        )
      );
    }
  }

  // Stale cached integration state: a block was cached (12h TTL) but the repo
  // audits clean now. Nothing clears that except a successful SEO cycle, so a
  // fixed repo could stay "blocked" for half a day.
  const hardFailure = out.some((f) => f.severity === 'error');
  if (blockedReason && !hardFailure) {
    out.push(
      finding(slug, 'warn', 'stale-block', `This client is still marked blocked ("${String(blockedReason).slice(0, 120)}") but the repository checks out now.`, {
        action: null,
        configured,
        canonical,
        clearBlock: true,
      })
    );
  }

  if (!out.length) {
    out.push(finding(slug, 'ok', 'ok', `Linked to ${canonical}.`, { configured, canonical }));
  }
  return out;
}

/**
 * Audit every site, then add the findings that only exist ACROSS sites.
 * The collision check is the important one: two clients on one repository means
 * one client's change request edits the other client's website.
 */
export async function auditRepoMappings(sites, { gh, blockedReasons = {} } = {}) {
  const findings = [];
  for (const site of sites || []) {
    const f = await auditSiteRepo(site, { gh, blockedReason: blockedReasons[site.slug] || '' });
    findings.push(...f);
  }

  // group by canonical (or configured) repo, ignoring sites with no repo
  const byRepo = new Map();
  for (const f of findings) {
    const key = (f.canonical || f.configured || '').toLowerCase();
    if (!key) continue;
    if (!byRepo.has(key)) byRepo.set(key, new Set());
    byRepo.get(key).add(f.slug);
  }
  for (const [repo, slugSet] of byRepo) {
    if (slugSet.size < 2) continue;
    const slugs = [...slugSet].sort();
    for (const slug of slugs) {
      findings.push(
        finding(
          slug,
          'error',
          'collision',
          `${slugs.length} clients are linked to the same repository (${repo}): ${slugs.join(', ')}. A change request from one would edit another's website.`,
          { action: 'check-repo', configured: repo, others: slugs.filter((s) => s !== slug) }
        )
      );
    }
  }

  const bySlug = {};
  for (const f of findings) (bySlug[f.slug] ||= []).push(f);

  const worst = (list) =>
    list.some((f) => f.severity === 'error') ? 'error' : list.some((f) => f.severity === 'warn') ? 'warn' : 'ok';

  const sites_ = Object.entries(bySlug).map(([slug, list]) => ({
    slug,
    severity: worst(list),
    findings: list.filter((f) => f.code !== 'ok' || list.length === 1),
  }));

  return {
    checkedAt: Date.now(),
    counts: {
      sites: sites_.length,
      errors: findings.filter((f) => f.severity === 'error').length,
      warnings: findings.filter((f) => f.severity === 'warn').length,
      ok: sites_.filter((s) => s.severity === 'ok').length,
    },
    // worst first, so the dashboard shows what is actually broken at the top
    sites: sites_.sort((a, b) => {
      const rank = { error: 0, warn: 1, ok: 2 };
      return rank[a.severity] - rank[b.severity] || a.slug.localeCompare(b.slug);
    }),
    findings,
  };
}

/**
 * The subset of findings that can be auto-applied without a judgement call.
 * A rename/case/tidy fix rewrites a name GitHub itself just confirmed, and
 * clearing a stale block only removes a cached string. Everything else —
 * collisions, missing repos, permissions, a suspicious URL match — needs the
 * owner, and is deliberately NOT auto-applied.
 */
export function safeFixes(report) {
  const fixes = [];
  for (const f of report?.findings || []) {
    if (f.fix?.repo && (f.code === 'renamed' || f.code === 'case-drift' || f.code === 'needs-tidy')) {
      fixes.push({ slug: f.slug, code: f.code, patch: { repo: f.fix.repo }, was: f.configured });
    }
    if (f.clearBlock) fixes.push({ slug: f.slug, code: f.code, clearBlock: true });
  }
  return fixes;
}

/**
 * Map an audit report to the block reason the revision state machine already
 * understands, so a mapping fault BLOCKS a ticket with a precise cause instead
 * of failing mid-cycle and being retried. Returns null when nothing is wrong.
 */
export function blockReasonFor(report, slug) {
  const errors = (report?.findings || []).filter((f) => f.slug === slug && f.severity === 'error');
  if (!errors.length) return null;
  const order = ['no-repo', 'collision', 'renamed', 'not-found', 'bad-token', 'no-access', 'no-push', 'archived', 'empty', 'missing-owner', 'malformed'];
  errors.sort((a, b) => {
    const ia = order.indexOf(a.code);
    const ib = order.indexOf(b.code);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const top = errors[0];
  const map = {
    'no-repo': 'no GitHub repo set (Settings → Automation)',
    collision: `repo mapping conflict — ${top.message}`,
    renamed: `repo renamed on GitHub — ${top.message}`,
    'not-found': `repo unreachable — ${top.message}`,
    'bad-token': 'no GitHub token — the GitHub connection was rejected',
    'no-access': `permission — ${top.message}`,
    'no-push': `permission — ${top.message}`,
    archived: `repo unreachable — ${top.message}`,
    empty: `repo unreachable — ${top.message}`,
    'missing-owner': `repo unreachable — ${top.message}`,
    malformed: `repo unreachable — ${top.message}`,
  };
  return { code: top.code, reason: map[top.code] || `repo unreachable — ${top.message}`, action: top.action || 'check-repo' };
}

// ---- wiring ---------------------------------------------------------------

const BLOCK_KEY = (slug) => `repoaudit:block:${slug}`;
const REPORT_KEY = 'repoaudit:last';

/**
 * Audit every client's mapping, persist the per-site verdict so `agentStatus`
 * can block BEFORE spending anything, and optionally apply the safe fixes.
 *
 * The block key carries no TTL on purpose. A 12h TTL is what made the old
 * `agent:blocked:` key lie in both directions — it hid a still-broken mapping
 * after half a day, and kept a fixed one blocked until it expired. This key is
 * written on every audit and cleared the moment the mapping checks out, and
 * `saveSiteConfig` drops it when the repo is repointed.
 */
export async function runRepoAudit({ applyFixes = false, sites = null } = {}) {
  const all = sites || (await listSites());
  const blockedReasons = {};
  for (const s of all) {
    const v = await store.get(`agent:blocked:${s.slug}`).catch(() => null);
    if (v) blockedReasons[s.slug] = String(v);
  }

  const gh = githubConfigured() ? (path) => ghGet(path) : null;
  const report = await auditRepoMappings(all, { gh, blockedReasons });

  // persist the verdict per site
  for (const s of report.sites) {
    const block = blockReasonFor(report, s.slug);
    if (block) await store.set(BLOCK_KEY(s.slug), block.reason).catch(() => {});
    else await store.set(BLOCK_KEY(s.slug), '', { ex: 1 }).catch(() => {});
  }

  const applied = [];
  if (applyFixes) {
    for (const fix of safeFixes(report)) {
      try {
        if (fix.patch) {
          await saveSiteConfig(fix.slug, fix.patch);
          applied.push({ slug: fix.slug, code: fix.code, from: fix.was, to: fix.patch.repo });
        }
        if (fix.clearBlock) {
          await store.set(`agent:blocked:${fix.slug}`, '', { ex: 1 }).catch(() => {});
          applied.push({ slug: fix.slug, code: fix.code, cleared: true });
        }
      } catch (e) {
        applied.push({ slug: fix.slug, code: fix.code, error: e.message || String(e) });
      }
    }
  }

  const saved = { ...report, applied, githubChecked: !!gh };
  await store.set(REPORT_KEY, JSON.stringify(saved)).catch(() => {});
  return saved;
}

export async function lastRepoAudit() {
  const raw = await store.get(REPORT_KEY).catch(() => null);
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}
