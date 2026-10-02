// R12.7 — the checks that run before anything ships.
//
// WHAT "BUILD" AND "LINT" MEAN IN THIS PROJECT, HONESTLY.
//
// There is no bundler here and no ESLint, and pretending otherwise would be
// the easiest way to report a green gate that checks nothing. So each of the
// four is defined as the strongest thing that is actually true:
//
//   BUILD  — there is no build step, so the equivalent is that every module
//            PARSES and every import RESOLVES. Without this a syntax error in
//            an api/ file is discovered by Vercel at deploy, or worse by the
//            first request, because nothing in a vanilla ESM project compiles
//            anything ahead of time.
//   LINT   — no linter is installed, and adding one is not this requirement.
//            What is checked instead are the project's own rules that have
//            actually been broken here before: a module that exports nothing,
//            a test file not picked up by the runner, a secret in source.
//   TESTS  — the suite, via the honest runner, with crashes counted.
//   BROWSER— the real page in real Chrome at desktop AND mobile, every view
//            visited, asserting no page errors and no horizontal overflow.
//
// The browser half is the part that cannot be faked by reading source, and it
// is where this build's UI bugs have actually been: buttons with no handler,
// panels that render a failed fetch as "none yet", a mobile layout that scrolls
// sideways because a modifier class outranked a breakpoint.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { check, section, done } from './world.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = ['lib', 'api', 'public', 'tests'];

const walk = (dir) => {
  const out = [];
  const full = join(ROOT, dir);
  if (!existsSync(full)) return out;
  for (const name of readdirSync(full)) {
    const p = join(full, name);
    if (statSync(p).isDirectory()) { out.push(...walk(join(dir, name))); continue; }
    if (['.js', '.mjs'].includes(extname(name))) out.push({ rel: join(dir, name), abs: p });
  }
  return out;
};

const files = DIRS.flatMap(walk);

// ---------------------------------------------------------------------------
section('C1  "build": every module parses');
check('there are modules to check', files.length > 40, String(files.length));

const parseFailures = [];
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f.abs], { stdio: 'pipe', timeout: 20000 });
  } catch (e) {
    parseFailures.push(`${f.rel}: ${String((e.stderr || '').toString()).split('\n').slice(0, 2).join(' ').slice(0, 120)}`);
  }
}
check('every module parses', parseFailures.length === 0, parseFailures.slice(0, 3).join(' | '));

// and the check is real: a file with a syntax error must be rejected
let caughtBadSyntax = false;
try {
  execFileSync(process.execPath, ['--check', '-'], { input: 'const x = ;', stdio: 'pipe', timeout: 20000 });
} catch {
  caughtBadSyntax = true;
}
check('the parse check actually rejects bad syntax', caughtBadSyntax,
  'if this passes, every file above was "checked" by something that accepts anything');

// ---------------------------------------------------------------------------
section('C2  "build": every import resolves');
// A module that parses can still fail at run time on a bad import — which in
// this project means a route that 500s on its first real request.
const importFailures = [];
for (const f of files) {
  // the test files import a browser-shaped world and some open sockets; they
  // are exercised by the suite itself rather than imported here
  if (f.rel.startsWith('tests')) continue;
  try {
    // as a file:// URL, because on Windows a bare `C:/...` is read as a URL
    // whose scheme is "C:" and every import fails for a reason that has
    // nothing to do with the module
    const url = pathToFileURL(f.abs).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
      stdio: 'pipe', timeout: 30000, cwd: ROOT,
    });
  } catch (e) {
    const msg = ((e.stderr || '').toString().match(/^(?:.*Error.*)$/m) || [''])[0];
    importFailures.push(`${f.rel}: ${msg.slice(0, 120)}`);
  }
}
check('every lib/, api/ and public/ module imports cleanly', importFailures.length === 0,
  importFailures.slice(0, 3).join(' | '));

// ---------------------------------------------------------------------------
section('C3  "lint": the rules this project has actually broken');
// Not a general linter — the specific mistakes made here before.

// 1. a test file the runner never runs is a test that cannot fail
const testFiles = files.filter((f) => f.rel.startsWith('tests') && f.rel.endsWith('.test.mjs'));
// The runner exits non-zero when anything fails or crashes, which is correct —
// but `execFileSync` turns that into a throw, and a gate that dies with a stack
// trace instead of reporting a failure is useless exactly when it matters. The
// output is read either way.
let runnerOut = '';
let runnerThrew = false;
try {
  runnerOut = execFileSync(process.execPath, [join(ROOT, 'tests', 'run-all.mjs')], {
    encoding: 'utf8', timeout: 900000, cwd: ROOT,
  });
} catch (e) {
  runnerThrew = true;
  runnerOut = `${(e.stdout || '').toString()}${(e.stderr || '').toString()}`;
}
const ranNames = new Set([...runnerOut.matchAll(/^\w+\s+(\S+\.test\.mjs)/gm)].map((m) => m[1]));
const unrun = testFiles.map((f) => f.rel.split(/[\\/]/).pop()).filter((n) => !ranNames.has(n));
check('there are test files', testFiles.length > 20, String(testFiles.length));
check('every test file is actually run by the runner', unrun.length === 0, unrun.join(', '));

// 2. no secret committed in source
const SECRET_SHAPES = [
  { re: /sk-ant-[A-Za-z0-9-]{20,}/, what: 'an Anthropic key' },
  { re: /\bre_[A-Za-z0-9]{24,}/, what: 'a Resend key' },
  { re: /ghp_[A-Za-z0-9]{30,}/, what: 'a GitHub token' },
  { re: /AKIA[0-9A-Z]{16}/, what: 'an AWS key' },
];
// Scanned over SHIPPED code only. `tests/` deliberately contains fake tokens —
// `tests/security.test.mjs` has an obviously-fake `ghp_abcdef...` precisely to
// prove the redaction masks it — and a scan that flagged those would be turned
// off within a week. What matters is that nothing reaches the deployment.
const shipped = files.filter((f) => !f.rel.startsWith('tests'));
const secretHits = [];
for (const f of shipped) {
  const src = readFileSync(f.abs, 'utf8');
  for (const s of SECRET_SHAPES) if (s.re.test(src)) secretHits.push(`${f.rel}: ${s.what}`);
}
check('no credential is committed in shipped code', secretHits.length === 0, secretHits.join(', '));
check('and the scan covers everything that deploys', shipped.length > 30, String(shipped.length));
// the fixtures in tests/ are expected, and their presence proves the patterns
// are the right shape to catch a real one
check('the scan recognises the fake token the redaction test uses',
  SECRET_SHAPES[2].re.test(readFileSync(join(ROOT, 'tests', 'security.test.mjs'), 'utf8')),
  'if it cannot see a token it is told about, it would not see a real one');
check('and that scan would catch one', SECRET_SHAPES[0].re.test('sk-ant-' + 'a'.repeat(32)),
  'a scan that matches nothing proves nothing');

// 3. a module in public/ that the page never loads is dead weight at best and
//    an untested promise at worst — wiring.test.mjs owns the full contract, so
//    this only checks that nothing has been added and forgotten entirely
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const publicModules = files
  .filter((f) => f.rel.startsWith('public') && f.rel.endsWith('.js'))
  .map((f) => f.rel.split(/[\\/]/).pop());
const orphans = publicModules.filter((m) => !html.includes(m) && !files.some((f) => !f.rel.startsWith('tests') && f.rel !== `public\\${m}` && readFileSync(f.abs, 'utf8').includes(`./${m}`)));
check('no front-end module is loaded by nothing', orphans.length === 0,
  `${orphans.join(', ')} — a module nothing imports is a tested promise that never runs`);

// ---------------------------------------------------------------------------
section('C4  "tests": the suite is green, and the runner is honest about crashes');
const summary = runnerOut.match(/(\d+) files · (\d+) checks passed · (\d+) failed · (\d+) crashed/);
check('the runner printed a summary', !!summary, runnerOut.split('\n').slice(-3).join(' '));
check('the runner exited cleanly', runnerThrew === false,
  (runnerOut.match(/^\s+- .*/gm) || ['the suite exited non-zero']).slice(0, 3).join(' | '));
check('nothing failed', !!summary && Number(summary[3]) === 0, summary && summary[3]);
check('nothing crashed', !!summary && Number(summary[4]) === 0, summary && summary[4]);
check('and it ran a serious number of checks', !!summary && Number(summary[2]) > 3000, summary && summary[2]);
check('across every test file', !!summary && Number(summary[1]) === testFiles.length,
  `${summary && summary[1]} files run, ${testFiles.length} on disk`);

// ---------------------------------------------------------------------------
section('C5  "browser": the real page, desktop and mobile, every view');
// The half that cannot be faked by reading source. Every UI bug this build has
// actually shipped was of this shape: a button with no handler, a panel
// rendering a failed fetch as "none yet", a mobile layout scrolling sideways
// because a modifier class outranked a breakpoint.
process.env.CRON_SECRET = process.env.CRON_SECRET || 'preflight-secret';
const puppeteer = (await import('puppeteer')).default;
const { startLocalApi } = await import('./harness/local-api.mjs');

const chrome = [
  'C:/Users/mondo/.cache/puppeteer/chrome/win64-154.0.8037.57/chrome-win64/chrome.exe',
  'C:/Users/mondo/.cache/puppeteer/chrome/win64-146.0.7680.153/chrome-win64/chrome.exe',
].find((p) => existsSync(p));
check('a browser is available to check with', !!chrome, 'no Chrome found; the browser gate cannot run');

const VIEWS = ['overview', 'clients', 'acquisition', 'automations', 'settings'];
const api = await startLocalApi();
const browser = await puppeteer.launch({ executablePath: chrome, headless: 'new', args: ['--no-sandbox'] });

for (const vp of [
  { name: 'desktop', width: 1440, height: 900, mobile: false },
  { name: 'mobile', width: 390, height: 844, mobile: true },
]) {
  const page = await browser.newPage();
  await page.setViewport({ width: vp.width, height: vp.height, isMobile: vp.mobile, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${vp.name}: ${String(e.message).slice(0, 120)}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${vp.name}: ${m.text().slice(0, 120)}`);
  });

  await page.goto(api.origin + '/', { waitUntil: 'networkidle2', timeout: 45000 });
  await new Promise((r) => setTimeout(r, 1500));
  check(`${vp.name}: the dashboard loads`, (await page.title()).length > 0, await page.title());

  for (const view of VIEWS) {
    const shown = await page.evaluate(async (v) => {
      if (window.IWgo) window.IWgo(v);
      await new Promise((r) => setTimeout(r, 450));
      const el = document.getElementById(`view-${v}`);
      return {
        exists: !!el,
        visible: !!el && !el.hidden,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        widest: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
      };
    }, view);
    check(`${vp.name}: the ${view} view exists`, shown.exists, JSON.stringify(shown));
    check(`${vp.name}: ${view} does not scroll sideways`, shown.overflow === false,
      `overflowing by ${shown.widest}px`);
  }

  check(`${vp.name}: no page errors across every view`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

await browser.close();
await api.stop();

done();
