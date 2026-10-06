// The check that stops new exposure — does it actually bite?
//
// R18.3. The repository is public, so a commit is publication and cannot be
// undone by a later fix. The history audit says what is already out there; this
// is the half that can still help, and a scanner that finds nothing is
// indistinguishable from one that looks at nothing. So every rule here is
// proved against a planted example AND against something that must NOT trip it.
//
// None of the planted strings are real. They are placeholder-shaped on purpose,
// and this file is excluded from its own scan for exactly that reason.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, section, done } from './world.mjs';
import { scanText, worstOf, SKIP_PATH, SEVERITY, RULES } from '../tools/secret-scan.mjs';
import { scanStaged, report } from '../tools/pre-commit-scan.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Built at runtime so the literal never appears whole in this file.
const fake = (prefix, n = 40) => prefix + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(3).slice(0, n);

// ---------------------------------------------------------------------------
section('S1  each credential shape is caught');
const cases = [
  ['anthropic-key', fake('sk-ant-', 40)],
  ['github-token', fake('ghp_', 40)],
  ['resend-key', fake('re_', 30)],
  ['aws-key', 'AKIA' + 'ABCDEFGHIJKLMNOP'],
  ['slack-token', 'xoxb-' + '1234567890'.repeat(3)],
  ['private-key', '-----BEGIN RSA PRIVATE KEY-----'],
];
for (const [id, sample] of cases) {
  const hits = scanText(`const x = '${sample}';`);
  check(`${id} is detected`, hits.some((h) => h.id === id), hits.map((h) => h.id).join(',') || 'nothing');
}
check('a credential is at least high severity',
  worstOf(scanText(`x='${fake('sk-ant-', 40)}'`)) === SEVERITY.CRITICAL, worstOf(scanText(`x='${fake('sk-ant-', 40)}'`)));

section('S1b  NEGATIVE CONTROL: ordinary code does not trip it');
for (const safe of [
  'const id = "sk-ant-"; // the prefix alone',
  'const sha = "a1b2c3d4e5f6a7b8";',
  'import { ghost } from "./ghost.js";',
  'const re = /^abc$/;',
  'const version = "1.2.3-beta.4";',
]) {
  check(`"${safe.slice(0, 34)}…" is clean`, scanText(safe).length === 0, JSON.stringify(scanText(safe)));
}

// ---------------------------------------------------------------------------
section('S2  a contactable address is caught, a reserved one is not');
check('a resolving domain is flagged', scanText('email: "owner@realbusiness.co"').some((h) => h.id === 'contactable-email'));
for (const ok of ['a@example.com', 'b@thing.test', 'c@x.invalid', 'd@y.example', 'someone@gmail.com']) {
  check(`${ok} is allowed`, !scanText(`email: "${ok}"`).some((h) => h.id === 'contactable-email'), ok);
}
check('a service endpoint is not mistaken for a person',
  !scanText('fetch("https://api.twilio.com/x"); const a = "noreply@api.twilio.com";').some((h) => h.id === 'contactable-email'));

section('S2b  a number outside 555 is caught, and version strings are not');
check('a plausible number is flagged', scanText('call (214) 867-5309 now').some((h) => h.id === 'real-phone'));
check('555 is allowed', !scanText('call (214) 555-0147 now').some((h) => h.id === 'real-phone'));
for (const notPhone of [
  'const bytes = 1234567890;',
  'version 2026.10.06 build 1234',
  'const id = "1234567890";',
  'timestamp 1791301948130',
]) {
  check(`"${notPhone.slice(0, 30)}…" is not a phone number`,
    !scanText(notPhone).some((h) => h.id === 'real-phone'), JSON.stringify(scanText(notPhone)));
}

// ---------------------------------------------------------------------------
section('S3  nothing it reports contains the match itself');
// The rule that matters most: a scanner that prints the secret has copied it.
const noisy = `key=${fake('sk-ant-', 40)} mail=real@business.co phone=(214) 867-5309`;
const findings = scanText(noisy);
const serialised = JSON.stringify(findings);
check('something was found', findings.length >= 3, serialised);
check('but the key is not in the output', !serialised.includes('abcdefghij'), 'the matched text must never be returned');
check('nor the address', !serialised.includes('real@business.co'));
check('nor the number', !serialised.includes('867-5309'));
check('only a category, a severity and a count', findings.every((f) => f.id && f.severity && typeof f.count === 'number'));

const reported = report([{ path: 'x.js', findings }]);
check('the hook output carries no match either', !reported.lines.join('\n').includes('abcdefghij'), reported.lines.join(' '));
check('and it does block', reported.blocking >= 3, String(reported.blocking));

// ---------------------------------------------------------------------------
section('S4  the hook scans STAGED content, not the working tree');
// So that legitimate configuration outside Git is never read.
const staged = scanStaged({
  paths: ['fake-staged.js'],
  read: () => `const k = "${fake('ghp_', 40)}";`,
});
check('a staged credential is found', staged.length === 1 && staged[0].findings.some((f) => f.id === 'github-token'),
  JSON.stringify(staged).slice(0, 120));
check('and it blocks the commit', report(staged).blocking > 0);

const clean = scanStaged({ paths: ['ok.js'], read: () => 'export const ok = true;' });
check('NEGATIVE CONTROL: clean staged content does not block', report(clean).blocking === 0);

section('S4b  binaries and lockfiles are skipped, not scanned');
for (const p of ['public/logo.png', 'package-lock.json', 'node_modules/x/y.js', 'temporary screenshots/a.png']) {
  check(`${p} is skipped`, SKIP_PATH(p), p);
}
check('but real source is not skipped', !SKIP_PATH('lib/contacts.js'));
check('and the scanner excludes itself, because it names the shapes',
  SKIP_PATH('tools/secret-scan.mjs') && SKIP_PATH('tests/secret-scan.test.mjs'));

// ---------------------------------------------------------------------------
section('S5  the hook is committed and points at the scanner');
const hook = path.join(ROOT, '.githooks', 'pre-commit');
check('.githooks/pre-commit exists', fs.existsSync(hook));
const hookSrc = fs.readFileSync(hook, 'utf8');
check('it runs the scanner', /pre-commit-scan\.mjs/.test(hookSrc), hookSrc.slice(0, 80));
check('and it tells you how to enable it', /core\.hooksPath/.test(hookSrc),
  'git does not install hooks automatically, so the instruction has to be in the file');
check('and how to override it deliberately', /--no-verify/.test(hookSrc));
check('the scanner it points at exists', fs.existsSync(path.join(ROOT, 'tools', 'pre-commit-scan.mjs')));

check('every rule carries a severity', RULES.every((r) => !!r.severity));
check('and a plain-words description', RULES.every((r) => (r.what || '').length > 8));

done();
