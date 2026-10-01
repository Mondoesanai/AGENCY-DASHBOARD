// R1.7 — client ↔ repository mapping audit.
//
// The standard the requirement sets is "mismatches are detected and REPORTED
// rather than retried", so every case below checks two things: that the fault
// is found, and that it produces a cause the pipeline will treat as permanent
// instead of looping on.
import { W, addRepo, renameRepo, denyRepo, check, section, done } from './world.mjs';
import {
  parseRepoRef,
  collapse,
  auditSiteRepo,
  auditRepoMappings,
  safeFixes,
  blockReasonFor,
  runRepoAudit,
  lastRepoAudit,
} from '../lib/repo-audit.js';
import { classifyReason, transition, STATES, isDue } from '../lib/revision-state.js';
import { store } from '../lib/store.js';
import { saveSiteConfig } from '../lib/registry.js';
import { agentStatus } from '../lib/agent.js';

// a GitHub stub driven by a table: path -> {status, body}
const ghFrom = (table) => async (path) => {
  if (!(path in table)) return { status: 404, body: { message: 'Not Found' } };
  const v = table[path];
  if (v === 'throw') throw new Error('socket hang up');
  return v;
};
const repoOk = (full_name, extra = {}) => ({
  status: 200,
  body: { full_name, default_branch: 'main', permissions: { push: true }, size: 12, homepage: '', ...extra },
});
const site = (over = {}) => ({ slug: 'acme', url: 'https://acme-plumbing.com', repo: 'Mondoesanai/acme-plumbing', seoAgent: true, ...over });
const codes = (f) => f.map((x) => x.code).sort();
const byCode = (f, code) => f.find((x) => x.code === code);

// ---------------------------------------------------------------------------
section('P  parsing a configured repo string');

check('a clean owner/name is accepted', parseRepoRef('Mondoesanai/acme').value === 'Mondoesanai/acme');
check('a full GitHub URL is reduced', parseRepoRef('https://github.com/Mondoesanai/acme').value === 'Mondoesanai/acme');
check('a .git suffix is dropped', parseRepoRef('Mondoesanai/acme.git').value === 'Mondoesanai/acme');
check('an SSH remote is reduced', parseRepoRef('git@github.com:Mondoesanai/acme.git').value === 'Mondoesanai/acme');
check('a pasted tree URL keeps only owner/name', parseRepoRef('https://github.com/Mondoesanai/acme/tree/main/src').value === 'Mondoesanai/acme');
check('surrounding whitespace is ignored', parseRepoRef('  Mondoesanai/acme  ').value === 'Mondoesanai/acme');
// the important negative: never invent an owner
const bare = parseRepoRef('acme-plumbing');
check('a bare name with no owner is REJECTED, not guessed', bare.ok === false && bare.code === 'missing-owner');
check('an empty value reports no-repo', parseRepoRef('').code === 'no-repo');
check('nonsense is rejected', parseRepoRef('what is this/??').ok === false);
check('collapse() ignores host noise', collapse('https://www.acme-plumbing.com/') === 'acmeplumbing');
check('collapse() ignores a vercel domain suffix', collapse('acme-plumbing.vercel.app') === 'acmeplumbing');

// ---------------------------------------------------------------------------
section('A  faults that must BLOCK, because retrying them can never work');

let f = await auditSiteRepo(site({ repo: '' }), { gh: ghFrom({}) });
check('automation on with no repo is an error', byCode(f, 'no-repo').severity === 'error');
check('and it names the action', byCode(f, 'no-repo').action === 'link-repo');

f = await auditSiteRepo(site({ repo: '', seoAgent: false }), { gh: ghFrom({}) });
check('but no repo with automation OFF is not a fault', byCode(f, 'no-repo').severity === 'ok');

f = await auditSiteRepo(site(), { gh: ghFrom({}) });
check('a repo GitHub cannot see is not-found', byCode(f, 'not-found').severity === 'error');
check('the message says it may be renamed/deleted/private rather than guessing', /renamed, deleted, or made private/.test(byCode(f, 'not-found').message));

f = await auditSiteRepo(site(), { gh: ghFrom({ '/repos/Mondoesanai/acme-plumbing': { status: 401, body: {} } }) });
check('a rejected token is bad-token, not a missing repo', byCode(f, 'bad-token').code === 'bad-token');
check('and it asks for a reconnect', byCode(f, 'bad-token').action === 'reconnect-github');

f = await auditSiteRepo(site(), { gh: ghFrom({ '/repos/Mondoesanai/acme-plumbing': { status: 403, body: {} } }) });
check('403 is a permission fault, distinct from 404', byCode(f, 'no-access').action === 'fix-permissions');

// THE expensive one: read works, push does not. The agent used to spend a model
// call writing a change, then fail at the commit.
f = await auditSiteRepo(site(), {
  gh: ghFrom({ '/repos/Mondoesanai/acme-plumbing': repoOk('Mondoesanai/acme-plumbing', { permissions: { push: false } }) }),
});
check('a read-only token is caught before any work is done', byCode(f, 'no-push').severity === 'error');
check('and it says plainly that nothing can ever ship', /no change can ever ship/.test(byCode(f, 'no-push').message));

f = await auditSiteRepo(site(), {
  gh: ghFrom({ '/repos/Mondoesanai/acme-plumbing': repoOk('Mondoesanai/acme-plumbing', { archived: true }) }),
});
check('an archived repo is an error', byCode(f, 'archived').severity === 'error');

f = await auditSiteRepo(site(), {
  gh: ghFrom({ '/repos/Mondoesanai/acme-plumbing': repoOk('Mondoesanai/acme-plumbing', { size: 0 }) }),
});
check('an empty repo is an error', byCode(f, 'empty').severity === 'error');

// ---------------------------------------------------------------------------
section('B  the rename trap');
// GitHub serves a renamed repo through a redirect and answers with the NEW
// full_name. So a stale mapping keeps working silently — until somebody
// registers the old name, and then a client's changes land in a stranger's repo.
f = await auditSiteRepo(site(), {
  gh: ghFrom({ '/repos/Mondoesanai/acme-plumbing': repoOk('Mondoesanai/acme-plumbing-site') }),
});
check('a rename is detected even though GitHub answered 200', byCode(f, 'renamed') !== undefined);
check('it is an error, not a note — the stale name is a hazard', byCode(f, 'renamed').severity === 'error');
check('it carries the corrected name as a fix', byCode(f, 'renamed').fix.repo === 'Mondoesanai/acme-plumbing-site');

f = await auditSiteRepo(site({ repo: 'mondoesanai/Acme-Plumbing' }), {
  gh: ghFrom({ '/repos/mondoesanai/Acme-Plumbing': repoOk('Mondoesanai/acme-plumbing') }),
});
check('a pure case difference is only a warning', byCode(f, 'case-drift').severity === 'warn');
check('and it still offers the canonical spelling', byCode(f, 'case-drift').fix.repo === 'Mondoesanai/acme-plumbing');

// ---------------------------------------------------------------------------
section('C  a network blip is NOT evidence of a broken mapping');
// Treating a timeout as "repo missing" would block a healthy client.
f = await auditSiteRepo(site(), { gh: ghFrom({ '/repos/Mondoesanai/acme-plumbing': 'throw' }) });
check('an unreachable GitHub is a warning, not an error', byCode(f, 'unreachable').severity === 'warn');
check('it is marked transient', byCode(f, 'unreachable').transient === true);
check('it proposes no action, because there is nothing to fix', byCode(f, 'unreachable').action === null);
f = await auditSiteRepo(site(), { gh: ghFrom({ '/repos/Mondoesanai/acme-plumbing': { status: 502, body: {} } }) });
check('a 5xx is also only transient', byCode(f, 'unreachable').severity === 'warn');
f = await auditSiteRepo(site(), { gh: null });
check('no GitHub connection at all reports "unchecked", not "broken"', byCode(f, 'unchecked').severity === 'warn');

// ---------------------------------------------------------------------------
section('D  a suspicious match is UNCERTAIN, never a failure');
f = await auditSiteRepo(site({ repo: 'Mondoesanai/totally-different' }), {
  gh: ghFrom({ '/repos/Mondoesanai/totally-different': repoOk('Mondoesanai/totally-different') }),
});
check('a repo unlike the domain is flagged', byCode(f, 'url-mismatch') !== undefined);
check('as a warning only', byCode(f, 'url-mismatch').severity === 'warn');
check('explicitly marked uncertain', byCode(f, 'url-mismatch').uncertain === true);
check('and it admits it is a guess from the name', /a guess from the name, not a fault/.test(byCode(f, 'url-mismatch').message));

f = await auditSiteRepo(site({ repo: 'Mondoesanai/totally-different' }), {
  gh: ghFrom({ '/repos/Mondoesanai/totally-different': repoOk('Mondoesanai/totally-different', { homepage: 'https://acme-plumbing.com' }) }),
});
check('a matching homepage clears the suspicion', byCode(f, 'url-mismatch') === undefined, codes(f).join(','));

// ---------------------------------------------------------------------------
section('E  two clients on one repository');
// The worst mapping fault: a change request from one client edits another
// client's live website.
let rep = await auditRepoMappings(
  [
    { slug: 'acme', url: 'https://acme-plumbing.com', repo: 'Mondoesanai/shared-site', seoAgent: true },
    { slug: 'beta', url: 'https://beta-roofing.com', repo: 'Mondoesanai/shared-site', seoAgent: true },
  ],
  { gh: ghFrom({ '/repos/Mondoesanai/shared-site': repoOk('Mondoesanai/shared-site') }) }
);
const coll = rep.findings.filter((x) => x.code === 'collision');
check('both clients are flagged, not just the second', coll.length === 2, String(coll.length));
check('it is an error', coll[0].severity === 'error');
check('the message spells out the actual consequence', /would edit another's website/.test(coll[0].message));
check('each finding names the other client', coll[0].others.includes('beta') || coll[0].others.includes('acme'));
check('and the report counts them', rep.counts.errors >= 2);

// one client, same repo twice over — must NOT be called a collision
rep = await auditRepoMappings([{ slug: 'acme', url: 'https://acme-plumbing.com', repo: 'Mondoesanai/acme-plumbing', seoAgent: true }], {
  gh: ghFrom({ '/repos/Mondoesanai/acme-plumbing': repoOk('Mondoesanai/acme-plumbing') }),
});
check('a single client is never a collision with itself', rep.findings.every((x) => x.code !== 'collision'));
check('a healthy mapping reports ok', rep.sites[0].severity === 'ok', JSON.stringify(rep.sites[0]));

// a collision hiding behind a rename: different configured names, same real repo
rep = await auditRepoMappings(
  [
    { slug: 'acme', url: 'https://acme-plumbing.com', repo: 'Mondoesanai/old-name', seoAgent: true },
    { slug: 'beta', url: 'https://beta-roofing.com', repo: 'Mondoesanai/new-name', seoAgent: true },
  ],
  {
    gh: ghFrom({
      '/repos/Mondoesanai/old-name': repoOk('Mondoesanai/new-name'),
      '/repos/Mondoesanai/new-name': repoOk('Mondoesanai/new-name'),
    }),
  }
);
check('a collision is still caught when one side is a stale name', rep.findings.filter((x) => x.code === 'collision').length === 2);

// ---------------------------------------------------------------------------
section('F  only unambiguous fixes are auto-applied');
rep = await auditRepoMappings(
  [
    { slug: 'acme', url: 'https://acme-plumbing.com', repo: 'Mondoesanai/acme-plumbing', seoAgent: true },
    { slug: 'beta', url: 'https://beta-roofing.com', repo: 'Mondoesanai/shared', seoAgent: true },
    { slug: 'gamma', url: 'https://gamma-hvac.com', repo: 'Mondoesanai/shared', seoAgent: true },
    { slug: 'delta', url: 'https://delta-law.com', repo: '', seoAgent: true },
  ],
  {
    gh: ghFrom({
      '/repos/Mondoesanai/acme-plumbing': repoOk('Mondoesanai/acme-plumbing-v2'),
      '/repos/Mondoesanai/shared': repoOk('Mondoesanai/shared'),
    }),
  }
);
let fixes = safeFixes(rep);
check('the rename is offered as a fix', fixes.some((x) => x.slug === 'acme' && x.patch.repo === 'Mondoesanai/acme-plumbing-v2'));
check('the collision is NOT auto-fixable', !fixes.some((x) => x.slug === 'beta' || x.slug === 'gamma'));
check('a missing repo is NOT auto-fixable', !fixes.some((x) => x.slug === 'delta'));
check('a suspicious URL match is NOT auto-fixable', !fixes.some((x) => x.code === 'url-mismatch'));
check('the worst-affected clients sort to the top', rep.sites[0].severity === 'error');

// ---------------------------------------------------------------------------
section('G  findings become causes the state machine treats as PERMANENT');
// This is the join to R1.4: detected-and-reported only counts if the pipeline
// then stops retrying.
const cases = [
  ['collision', [{ slug: 'acme', url: 'https://a.com', repo: 'o/shared', seoAgent: true }, { slug: 'beta', url: 'https://b.com', repo: 'o/shared', seoAgent: true }], { '/repos/o/shared': repoOk('o/shared') }],
  ['renamed', [{ slug: 'acme', url: 'https://acme.com', repo: 'o/acme', seoAgent: true }], { '/repos/o/acme': repoOk('o/acme-2') }],
  ['no-push', [{ slug: 'acme', url: 'https://acme.com', repo: 'o/acme', seoAgent: true }], { '/repos/o/acme': repoOk('o/acme', { permissions: { push: false } }) }],
  ['not-found', [{ slug: 'acme', url: 'https://acme.com', repo: 'o/acme', seoAgent: true }], {}],
  ['no-repo', [{ slug: 'acme', url: 'https://acme.com', repo: '', seoAgent: true }], {}],
];
for (const [name, sites, table] of cases) {
  const r = await auditRepoMappings(sites, { gh: ghFrom(table) });
  const block = blockReasonFor(r, 'acme');
  check(`${name} produces a block reason`, !!block, JSON.stringify(r.findings.map((x) => x.code)));
  const cls = classifyReason(block.reason);
  check(`${name} is classified PERMANENT, so it is never retried`, cls.permanent === true, `${block.reason} -> ${JSON.stringify(cls)}`);
  let t = { state: STATES.QUEUED, attempts: 0 };
  for (let i = 0; i < 4; i++) t = { ...t, ...transition(t, { type: 'ineligible', reason: block.reason }) };
  check(`${name} blocks the ticket instead of looping`, t.state === STATES.BLOCKED, t.state);
  check(`${name} stops the worker picking it up`, isDue(t) === false);
  check(`${name} tells the owner what to do`, !!t.blockedBy?.label, JSON.stringify(t.blockedBy));
}

// a transient fault must NOT become a block
let rTrans = await auditRepoMappings([{ slug: 'acme', url: 'https://acme.com', repo: 'o/acme', seoAgent: true }], {
  gh: ghFrom({ '/repos/o/acme': 'throw' }),
});
check('a network blip produces NO block reason', blockReasonFor(rTrans, 'acme') === null);
check('a healthy mapping produces no block reason', blockReasonFor(await auditRepoMappings([{ slug: 'acme', url: 'https://acme.com', repo: 'o/acme', seoAgent: true }], { gh: ghFrom({ '/repos/o/acme': repoOk('o/acme', { homepage: 'https://acme.com' }) }) }), 'acme') === null);

// ---------------------------------------------------------------------------
section('H  end to end through the real app: audit -> agentStatus blocks');
// Driven through the real registry, the real store and the fake GitHub.
W.repoAliases = {};
W.repoDeny = {};
addRepo('Mondoesanai/renewity-new', { 'index.html': '<html><title>R</title></html>' });
renameRepo('Mondoesanai/renewity-old', 'Mondoesanai/renewity-new');

await saveSiteConfig('renewity', { url: 'https://renewity-assisted-living.com', repo: 'Mondoesanai/renewity-old', seoAgent: true });
let cfgSites = [{ slug: 'renewity', url: 'https://renewity-assisted-living.com', repo: 'Mondoesanai/renewity-old', seoAgent: true }];

let live = await runRepoAudit({ sites: cfgSites, applyFixes: false });
check('the live audit finds the stale name', live.findings.some((x) => x.slug === 'renewity' && x.code === 'renamed'), JSON.stringify(live.findings.map((x) => x.code)));
check('it records that GitHub was actually consulted', live.githubChecked === true);

let st = await agentStatus({ slug: 'renewity', url: 'https://renewity-assisted-living.com', repo: 'Mondoesanai/renewity-old', seoAgent: true });
check('agentStatus now refuses to run the cycle', st.eligible === false);
check('and the reason is the mapping fault, not a vague failure', st.reasons.some((r) => /renamed/.test(r)), st.reasons.join(' | '));

// applying the safe fix must actually repoint the client and unblock it
live = await runRepoAudit({ sites: cfgSites, applyFixes: true });
check('the fix was applied', live.applied.some((a) => a.slug === 'renewity' && a.to === 'Mondoesanai/renewity-new'), JSON.stringify(live.applied));
const fixed = { slug: 'renewity', url: 'https://renewity-assisted-living.com', repo: 'Mondoesanai/renewity-new', seoAgent: true };
await runRepoAudit({ sites: [fixed], applyFixes: false });
st = await agentStatus(fixed);
check('after the fix the mapping no longer blocks', !st.reasons.some((r) => /renamed|repo mapping|unreachable/.test(r)), st.reasons.join(' | '));

const stored = await lastRepoAudit();
check('the report is persisted for the dashboard to read', stored && stored.counts && typeof stored.counts.errors === 'number');

// ---------------------------------------------------------------------------
section('I  stale cached integration state');
// REGRESSION: `agent:blocked:<slug>` held a repo failure for 12h and was only
// cleared by a later SUCCESSFUL cycle. Repointing a client at the right repo
// therefore left the OLD repo's error in place, keeping the site ineligible for
// up to half a day after the problem was gone.
addRepo('Mondoesanai/good-site', { 'index.html': '<html></html>' });
await saveSiteConfig('stale', { url: 'https://good-site.com', repo: 'Mondoesanai/wrong-site', seoAgent: true });
await store.set('agent:blocked:stale', 'has no code pushed to it yet');
let staleSt = await agentStatus({ slug: 'stale', url: 'https://good-site.com', repo: 'Mondoesanai/wrong-site', seoAgent: true });
check('the cached block makes the site ineligible', staleSt.eligible === false);

await saveSiteConfig('stale', { repo: 'Mondoesanai/good-site' });
const leftover = await store.get('agent:blocked:stale').catch(() => null);
check('repointing the repo clears the block cached against the old one', !leftover, String(leftover));
staleSt = await agentStatus({ slug: 'stale', url: 'https://good-site.com', repo: 'Mondoesanai/good-site', seoAgent: true });
check('and the site is no longer held back by the stale state', !staleSt.reasons.some((r) => /no code pushed/.test(r)), staleSt.reasons.join(' | '));

// the other direction: a block that is still cached while the repo audits clean
await store.set('agent:blocked:stale', 'some old transient failure');
const clean = await auditRepoMappings([{ slug: 'stale', url: 'https://good-site.com', repo: 'Mondoesanai/good-site', seoAgent: true }], {
  gh: ghFrom({ '/repos/Mondoesanai/good-site': repoOk('Mondoesanai/good-site', { homepage: 'https://good-site.com' }) }),
  blockedReasons: { stale: 'some old transient failure' },
});
check('a stale block on a healthy repo is reported', clean.findings.some((x) => x.code === 'stale-block'));
check('and it is auto-clearable', safeFixes(clean).some((x) => x.clearBlock && x.slug === 'stale'));
check('but a stale block alongside a REAL fault is not reported as stale', !(
  await auditRepoMappings([{ slug: 'stale', url: 'https://good-site.com', repo: 'Mondoesanai/missing', seoAgent: true }], {
    gh: ghFrom({}),
    blockedReasons: { stale: 'x' },
  })
).findings.some((x) => x.code === 'stale-block'));

// ---------------------------------------------------------------------------
section('J  a denied repo is reported, and reporting does not change the repo');
denyRepo('Mondoesanai/locked', 403);
const before = (await saveSiteConfig('locked', { url: 'https://locked.com', repo: 'Mondoesanai/locked', seoAgent: true })).repo;
const dr = await runRepoAudit({ sites: [{ slug: 'locked', url: 'https://locked.com', repo: 'Mondoesanai/locked', seoAgent: true }], applyFixes: true });
check('a 403 is surfaced as a permission fault', dr.findings.some((x) => x.slug === 'locked' && x.code === 'no-access'), JSON.stringify(dr.findings.map((x) => x.code)));
check('the audit did NOT silently repoint the client', (await saveSiteConfig('locked', {})).repo === before);
check('and it blocks the agent with a permission reason', /permission/.test(blockReasonFor(dr, 'locked').reason));

done();
