// What is already public in this repository's history?
//
// R18.3. The working tree was cleaned in an earlier pass. That does not undo
// publication: every commit is still fetchable, and anyone who cloned has it
// regardless of what is fixed later. So this answers "what is out there", not
// "is it fixed".
//
//   node tools/audit-history.mjs
//
// Walks every blob reachable from every ref. Reports CATEGORIES, COUNTS,
// SEVERITIES and the number of distinct objects and commits — never the matched
// text. Paths are shown only for the people-and-businesses categories, where a
// path is a filename rather than a secret.
import { execFileSync } from 'node:child_process';
import { scanText, SKIP_PATH, SEVERITY } from './secret-scan.mjs';

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });

console.log('Scanning reachable history — this reads every blob, so it takes a moment.\n');

// Every (sha, path) pair reachable from any ref.
const objects = git(['rev-list', '--objects', '--all'])
  .split('\n')
  .map((l) => {
    const i = l.indexOf(' ');
    return i < 0 ? null : { sha: l.slice(0, i), path: l.slice(i + 1) };
  })
  .filter((o) => o && o.path && !SKIP_PATH(o.path));

const byRule = new Map();
let scanned = 0;
let skippedBinary = 0;

for (const { sha, path } of objects) {
  let text;
  try {
    text = git(['cat-file', '-p', sha]);
  } catch { continue; }
  // crude binary check: a NUL byte means this is not source
  if (text.includes('\u0000')) { skippedBinary += 1; continue; }
  scanned += 1;
  for (const f of scanText(text)) {
    if (!byRule.has(f.id)) byRule.set(f.id, { ...f, count: 0, objects: 0, paths: new Set() });
    const agg = byRule.get(f.id);
    agg.count += f.count;
    agg.objects += 1;
    agg.paths.add(path);
  }
}

console.log(`${scanned} text objects scanned (${skippedBinary} binary skipped, ${objects.length} considered)\n`);

const ORDER = [SEVERITY.CRITICAL, SEVERITY.HIGH, SEVERITY.MEDIUM, SEVERITY.LOW];
const rows = [...byRule.values()].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));

if (!rows.length) {
  console.log('No findings in any reachable object.');
} else {
  console.log('| Severity | Category | Occurrences | Objects | Distinct paths |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.severity} | ${r.what} | ${r.count} | ${r.objects} | ${r.paths.size} |`);
  }
  console.log('');
  // Paths only for the categories where a path is a filename, not a secret.
  for (const r of rows) {
    if (r.severity === SEVERITY.CRITICAL || r.severity === SEVERITY.HIGH) {
      console.log(`${r.what}: ${r.paths.size} distinct path(s) — withheld, because a path plus a category is most of a lookup.`);
      continue;
    }
    const list = [...r.paths].sort().slice(0, 12);
    console.log(`${r.what} — paths (${r.paths.size}):`);
    for (const p of list) console.log(`   ${p}`);
    if (r.paths.size > list.length) console.log(`   …and ${r.paths.size - list.length} more`);
  }
}

console.log('\nNo value from any match has been printed, written or logged.');
console.log('Local cleanup does not erase published history, and does not reach clones or forks.');
