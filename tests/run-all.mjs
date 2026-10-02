// One place that runs every test file and totals honestly.
//
// Written after a reporting bug of my own: the ad-hoc shell loop read the LAST
// line of each file's output, but a failing file ends with "FAILED:" and a list
// of names, so the summary line was never seen — the file contributed 0 and was
// skipped in silence. A runner that can hide a failure is worse than no runner.
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.test.mjs')).sort();

let passed = 0, failed = 0, crashed = 0;
const bad = [];

for (const f of files) {
  let out = '';
  let threw = false;
  try {
    out = execFileSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    threw = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const m = out.match(/^(\d+) passed, (\d+) failed$/m);
  if (!m) {
    crashed++;
    bad.push(`${f}: produced no summary (crashed before finishing)`);
    console.log(`CRASH  ${f}`);
    console.log(out.split('\n').slice(-6).map((l) => '       ' + l).join('\n'));
    continue;
  }
  passed += +m[1];
  failed += +m[2];
  if (+m[2] > 0) {
    bad.push(`${f}: ${m[2]} failing`);
    console.log(`FAIL   ${f.padEnd(32)} ${m[0]}`);
    out.split('\n').filter((l) => /^\s+-\s/.test(l)).slice(0, 6).forEach((l) => console.log('       ' + l.trim()));
  } else if (threw) {
    // a file that reported 0 failures but still exited non-zero is itself a fault
    crashed++;
    bad.push(`${f}: exited non-zero despite reporting no failures`);
    console.log(`ODD    ${f}: non-zero exit with no reported failure`);
  } else {
    console.log(`ok     ${f.padEnd(32)} ${m[0]}`);
  }
}

console.log('-'.repeat(60));
console.log(`${files.length} files · ${passed} checks passed · ${failed} failed · ${crashed} crashed`);
if (bad.length) {
  console.log('PROBLEMS:');
  bad.forEach((b) => console.log('  - ' + b));
  process.exit(1);
}
