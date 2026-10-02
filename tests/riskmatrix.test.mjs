// R12.1 — the risk matrix, kept honest.
//
// A matrix is a document, and a document can claim anything. The specific way
// this goes wrong is not malice: a test file gets renamed or deleted, the row
// that names it keeps saying "covered", and the matrix slowly becomes a list
// of reassurances about tests that no longer exist. By the time anyone notices
// it is the only record of what was thought to be covered.
//
// So every file named in RISK_MATRIX.md has to exist AND be run by the suite,
// every severe risk has to name at least two independent covering files
// (because the severe row is the one where a single point of failure matters
// most), and the gaps section has to still be there — a matrix with no stated
// gaps is a matrix that has stopped being honest, not a system with no gaps.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, section, done } from './world.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MATRIX = join(ROOT, 'RISK_MATRIX.md');

check('the matrix exists', existsSync(MATRIX), MATRIX);
const doc = readFileSync(MATRIX, 'utf8');

// ---- parse the rows -------------------------------------------------------
const rows = [];
for (const line of doc.split('\n')) {
  const m = line.match(/^\|\s*([SHML]\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|$/);
  if (!m) continue;
  rows.push({
    id: m[1],
    risk: m[2],
    coverRaw: m[3],
    covers: [...m[3].matchAll(/`([a-z0-9-]+)`/g)].map((x) => x[1]),
    control: m[4].trim(),
  });
}

// ---------------------------------------------------------------------------
section('R1  the matrix is actually populated');
check('there are rows', rows.length >= 30, String(rows.length));
check('every severity band is represented',
  ['S', 'H', 'M', 'L'].every((b) => rows.some((r) => r.id.startsWith(b))),
  JSON.stringify([...new Set(rows.map((r) => r.id[0]))]));
check('severe risks are the largest band, because harm ranks first',
  rows.filter((r) => r.id.startsWith('S')).length >= 10, String(rows.filter((r) => r.id.startsWith('S')).length));
check('every row states a risk in words', rows.every((r) => r.risk.length > 25),
  JSON.stringify(rows.filter((r) => r.risk.length <= 25).map((r) => r.id)));
check('every row names at least one covering test', rows.every((r) => r.covers.length > 0),
  JSON.stringify(rows.filter((r) => !r.covers.length).map((r) => r.id)));
check('no two rows share an id', new Set(rows.map((r) => r.id)).size === rows.length);

// ---------------------------------------------------------------------------
section('R2  every test the matrix names actually exists');
const missing = [];
for (const r of rows) {
  for (const name of r.covers) {
    const asTest = join(ROOT, 'tests', `${name}.test.mjs`);
    const asScript = join(ROOT, 'tests', `${name}.mjs`);
    if (!existsSync(asTest) && !existsSync(asScript)) missing.push(`${r.id} → ${name}`);
  }
}
check('no row names a test that does not exist', missing.length === 0, missing.join(', '));

// and the check is real: a name that cannot exist must be reported
check('the existence check would catch a made-up name',
  !existsSync(join(ROOT, 'tests', 'definitely-not-a-test.test.mjs')),
  'if this file existed the check above would prove nothing');

// ---------------------------------------------------------------------------
section('R3  every test the matrix names is actually RUN');
// A test file that exists but is never executed covers nothing. This checks
// the runner's INCLUSION RULE rather than running the suite: this file is
// itself part of the suite, so shelling out to the runner from inside it
// recurses for ever — which it did, until the run had to be killed.
const runner = readFileSync(join(ROOT, 'tests', 'run-all.mjs'), 'utf8');
const rule = runner.match(/endsWith\('([^']+)'\)/);
check('the runner selects files by a suffix rule', !!rule, runner.split('\n').slice(10, 16).join(' '));
const SUFFIX = rule ? rule[1] : '.test.mjs';
check('and that rule is the one this check assumes', SUFFIX === '.test.mjs', SUFFIX);

const onDisk = new Set(
  readdirSync(join(ROOT, 'tests'))
    .filter((f) => f.endsWith(SUFFIX))
    .map((f) => f.slice(0, -SUFFIX.length))
);
// `preflight` is a gate, run on its own rather than as a suite member
const EXEMPT = new Set(['preflight']);
const notRun = [];
for (const r of rows) {
  for (const name of r.covers) {
    if (EXEMPT.has(name)) continue;
    if (!onDisk.has(name)) notRun.push(`${r.id} → ${name}`);
  }
}
check('the runner picks up a serious number of files', onDisk.size > 50, String(onDisk.size));
check('every named test is one the runner will execute', notRun.length === 0, notRun.join(', '));
// the exempt one has to exist too, or "exempt" is just a way of not checking
check('the exempt gate exists as a script', existsSync(join(ROOT, 'tests', 'preflight.mjs')));
check('and is deliberately NOT a suite member', !onDisk.has('preflight'),
  'if it were, running it from the suite would recurse');

// ---------------------------------------------------------------------------
section('R4  the severe band has no single point of failure');
// For the risks where a person is harmed, one test file carrying the whole
// claim is itself the risk: delete or weaken it and the harm becomes invisible.
// A row may be covered by one file only if it SAYS SO — the point is that a
// concentration of risk is visible, not that it is forbidden. Padding the
// citations with loosely-related files to satisfy the rule would be worse than
// the concentration it hides.
const severe = rows.filter((r) => r.id.startsWith('S'));
const undeclaredThin = severe.filter((r) => r.covers.length < 2 && !/\(single\)/i.test(r.coverRaw || ''));
check('every severe risk is covered by two test files, or declares that it is not',
  undeclaredThin.length === 0, JSON.stringify(undeclaredThin.map((r) => `${r.id} (${r.covers.join(',')})`)));

const declaredSingle = severe.filter((r) => /\(single\)/i.test(r.coverRaw || ''));
check('any single-covered severe risk is listed in the gaps', declaredSingle.every((r) => {
  const gaps = doc.split(/##\s*Gaps/i)[1] || '';
  return gaps.includes(r.id);
}), JSON.stringify(declaredSingle.map((r) => r.id)));
// matched against whitespace-normalised text, because the document is wrapped
// and a phrase that spans two lines is still the same phrase
const flat = doc.replace(/\s+/g, ' ');
check('and the gaps say what a single point of failure means',
  /weakening one file would make that harm invisible/i.test(flat));

check('every severe risk records that a control bit', rows
  .filter((r) => r.id.startsWith('S'))
  .every((r) => /yes/i.test(r.control)),
  JSON.stringify(rows.filter((r) => r.id.startsWith('S') && !/yes/i.test(r.control)).map((r) => r.id)));

// ---------------------------------------------------------------------------
section('R5  the gaps are stated, not quietly dropped');
// A matrix with no gaps section is not a system without gaps; it is a matrix
// that has stopped being honest. These three are known and must stay visible
// until they are genuinely closed.
check('there is a gaps section', /##\s*Gaps/i.test(doc));
check('the send leg is named as unexercised', /send leg[\s\S]{0,200}refusal direction/i.test(doc));
check('the soak is named as not run', /soak has not been run/i.test(doc));
check('the externally blocked item is named', /R6\.4/.test(doc));
check('and the gaps say WHY, not just THAT', /outreach is deliberately inactive/i.test(doc) && /owner action/i.test(doc));

// the gaps have to match the plan: a gap closed here but open there, or the
// reverse, means one of the two documents is lying
const plan = readFileSync(join(ROOT, 'BUILD_PLAN.md'), 'utf8');
const planRow = (id) => plan.split('\n').find((l) => l.startsWith(`| ${id} |`)) || '';
check('the plan agrees R12.2 is partial', /`\[~\]`/.test(planRow('R12.2')), planRow('R12.2').slice(0, 90));
check('the plan agrees R6.4 is blocked', /`\[!\]`/.test(planRow('R6.4')), planRow('R6.4').slice(0, 90));
check('the plan agrees the soak itself has not been run', /has NOT been run|not been run/i.test(planRow('R12.6')),
  planRow('R12.6').slice(0, 120));

done();
