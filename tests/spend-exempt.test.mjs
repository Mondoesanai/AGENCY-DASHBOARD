// Can a paid call reach a provider without passing the budget?
//
// R16.1. Wiring twelve call sites is worth little if the thirteenth is added
// next month outside the guard. `tests/spend-enforcement.test.mjs` proves the
// cap works; this proves nothing goes around it.
//
// The rule is structural rather than behavioural: the Anthropic SDK may be
// imported in exactly one file, and that file routes every call through
// `withSpend`. Anywhere else, importing it is the defect — there is no
// legitimate reason for a second door.
//
// Known limit, stated rather than implied: this reasons about imports, not
// about execution. A call made through a transitive dependency, or a paid
// endpoint reached with bare `fetch` that this file does not know about, is
// invisible here. That is why PAID_PATHS is a written-down list checked against
// the code below rather than a claim that the code was scanned exhaustively.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, section, done } from './world.mjs';
import { PAID_PATHS } from '../lib/spend-guard.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listJs = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`);
const SOURCES = [...listJs('lib'), ...listJs('api')];

// Comments discuss the SDK by name in several places; only real code counts.
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

// ---------------------------------------------------------------------------
section('X1  the model SDK has exactly one door');
const importers = SOURCES.filter((f) => /@anthropic-ai\/sdk/.test(stripComments(read(f))));
check('only lib/ai-client.js imports the Anthropic SDK',
  importers.length === 1 && importers[0] === 'lib/ai-client.js',
  importers.join(', ') || '(none — which would mean the model is unreachable)');
check('and that door goes through the spend guard',
  /withSpend\s*\(/.test(read('lib/ai-client.js')), 'lib/ai-client.js');
check('every model call in it reserves before it runs',
  read('lib/ai-client.js').indexOf('withSpend') < read('lib/ai-client.js').indexOf('real.messages.create'),
  'the guard has to wrap the call, not follow it');

section('X2  nobody constructs a raw client');
for (const f of SOURCES) {
  if (f === 'lib/ai-client.js') continue;
  check(`${f} does not build its own model client`, !/new\s+Anthropic\s*\(/.test(stripComments(read(f))), f);
}

section('X3  the twelve former call sites now use the guarded client');
// Named individually, because "no direct imports" would also be satisfied by
// accidentally deleting a feature.
const WIRED = [
  'lib/agent.js', 'lib/attachments.js', 'lib/card-intake.js', 'lib/coach.js',
  'lib/conversions-setup.js', 'lib/revisions.js', 'lib/todos.js',
  'api/report.js', 'api/site.js',
];
for (const f of WIRED) {
  check(`${f} obtains its client from the guarded door`, /aiClient\s*\(/.test(stripComments(read(f))), f);
}
const revisions = stripComments(read('lib/revisions.js'));
check('all three call sites in lib/revisions.js are wired',
  (revisions.match(/aiClient\s*\(/g) || []).length >= 3,
  String((revisions.match(/aiClient\s*\(/g) || []).length));
const site = stripComments(read('api/site.js'));
check('both call sites in api/site.js are wired',
  (site.match(/aiClient\s*\(/g) || []).length >= 2,
  String((site.match(/aiClient\s*\(/g) || []).length));

section('X4  inbound work is marked essential, discretionary work is not');
// Getting this backwards is the dangerous direction: a client's email going
// unread because a report generator used the month would be a silent failure of
// exactly the kind this build keeps finding.
const ESSENTIAL_SITES = ['lib/attachments.js', 'lib/revisions.js'];
for (const f of ESSENTIAL_SITES) {
  check(`${f} marks inbound client work as essential`, /essential:\s*true/.test(read(f)), f);
}
check('the SEO agent is NOT essential — it is the thing a cap exists to stop',
  !/essential:\s*true/.test(stripComments(read('lib/agent.js'))), 'lib/agent.js');
check('the monthly report is not essential either',
  !/essential:\s*true/.test(stripComments(read('api/report.js'))), 'api/report.js');
check('Compass is conversational so a live question is not cut off mid-thread',
  /conversational:\s*true/.test(read('lib/coach.js')), 'lib/coach.js');

section('X5  the written-down list of paid paths matches the code');
for (const p of PAID_PATHS) {
  check(`${p.what}: its module exists`, fs.existsSync(path.join(ROOT, p.where)), p.where);
  if (p.guard === 'withSpend') {
    const src = stripComments(read(p.where));
    check(`${p.what}: actually guarded`, /withSpend\s*\(|aiClient\s*\(/.test(src),
      `${p.where} is listed as guarded but neither withSpend nor aiClient appears in it`);
  }
}
const guarded = PAID_PATHS.filter((p) => p.guard === 'withSpend');
check('most paid paths go through the guard', guarded.length >= 4, String(guarded.length));
check('the ones that do not are each explained',
  PAID_PATHS.filter((p) => p.guard !== 'withSpend').every((p) => ['own-cap', 'unreachable'].includes(p.guard)),
  'a path with no guard and no reason is the bug this file exists to catch');

section('X6  the unreachable paid paths really are unreachable');
// `unreachable` is a strong claim — it is the reason those paths are allowed to
// skip the guard — so it is checked against the reachability audit rather than
// taken on trust.
const reach = read('tests/reachability.test.mjs');
for (const p of PAID_PATHS.filter((x) => x.guard === 'unreachable')) {
  const mod = p.where.replace('lib/', '');
  check(`${p.what} is recorded as unreachable in the audit`,
    new RegExp(`lib/${mod.replace('.', '\\.')}:`).test(reach),
    `${p.where} claims 'unreachable' but has no entry in the reachability allowlist`);
}

done();
