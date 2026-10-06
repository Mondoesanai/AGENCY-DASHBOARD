// Scan staged content and refuse the commit if it would publish something.
//
// R18.3. Invoked by `.githooks/pre-commit`. Exported too, so the test can drive
// the same function the hook runs rather than a lookalike.
//
// STAGED CONTENT ONLY. Legitimate configuration held outside Git — .env files,
// Vercel environment variables, anything gitignored — is never read. The rule
// is "do not commit it", not "do not have it", and a check that fought the
// owner's real configuration would simply be bypassed with --no-verify.
import { execFileSync } from 'node:child_process';
import { scanText, SKIP_PATH, SEVERITY } from './secret-scan.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

/** Paths staged for commit, excluding deletions. */
export function stagedPaths() {
  const out = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
  return out.split('\n').map((s) => s.trim()).filter(Boolean).filter((p) => !SKIP_PATH(p));
}

/** The staged version of a file — not the working tree, which may differ. */
export function stagedContent(path) {
  try {
    return git(['show', `:${path}`]);
  } catch {
    return '';
  }
}

/**
 * Findings across everything staged. Returns `[{ path, findings }]`,
 * and never the matched text.
 */
export function scanStaged({ paths = null, read = stagedContent } = {}) {
  const list = paths || stagedPaths();
  const out = [];
  for (const p of list) {
    const text = read(p);
    if (!text || text.includes('\u0000')) continue;
    const findings = scanText(text);
    if (findings.length) out.push({ path: p, findings });
  }
  return out;
}

/** Blocking severities. A `low` finding is reported, never blocking. */
const BLOCKS = new Set([SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM]);

export function report(results) {
  const lines = [];
  let blocking = 0;
  for (const { path, findings } of results) {
    for (const f of findings) {
      const blocks = BLOCKS.has(f.severity);
      if (blocks) blocking += 1;
      // The COUNT and the CATEGORY, never the value — a hook that printed the
      // secret into a terminal would have copied it somewhere new.
      lines.push(`  ${blocks ? 'BLOCK' : 'note '}  ${path}: ${f.count} x ${f.what} (${f.severity})`);
    }
  }
  return { lines, blocking };
}

// --- run as the hook -------------------------------------------------------
if (process.argv[1] && /pre-commit-scan\.mjs$/.test(process.argv[1])) {
  let results = [];
  try {
    results = scanStaged();
  } catch (e) {
    // A scanner that cannot run must not block a commit silently, and must not
    // pass silently either. Say so and let the commit through: the history
    // audit remains the backstop.
    console.error(`pre-commit scan could not run (${String(e.message || e).slice(0, 80)}) — not blocking, but nothing was checked.`);
    process.exit(0);
  }
  const { lines, blocking } = report(results);
  if (!lines.length) process.exit(0);

  console.error('\npre-commit scan — this repository is PUBLIC, and a commit is publication.\n');
  for (const l of lines) console.error(l);
  if (!blocking) {
    console.error('\nNothing blocking. Committing.\n');
    process.exit(0);
  }
  console.error(`\n${blocking} finding(s) would be published.`);
  console.error('Use a reserved domain (.test / .example / .invalid), a 555-01xx number, or keep the');
  console.error('real value outside Git entirely (.env, or a Vercel environment variable).');
  console.error('If this is deliberate and you have checked it: git commit --no-verify\n');
  process.exit(1);
}
