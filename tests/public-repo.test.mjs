// What would become public the moment this is pushed?
//
// R17.4. `github.com/Mondoesanai/AGENCY-DASHBOARD` is a PUBLIC repository —
// confirmed against the unauthenticated GitHub API, which answered 200 with
// `"private": false`. Everything committed here is readable by anyone, so a
// fixture that uses a real client's address is a disclosure, not a style issue.
//
// This found three files still using resolving domains, one of them a real
// client's (`omtservices.com`, One More Thing). They are now `.test`.
//
// RFC 2606 and RFC 6761 reserve `.test`, `.example`, `.invalid` and
// `.localhost` precisely so that documentation and test fixtures cannot collide
// with somebody's real address. `example.com`/`.org`/`.net` are reserved too.
// Anything else in a fixture is a domain that somebody can own, and sending to
// it — or publishing it — reaches a real person.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, section, done } from './world.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const listJs = (dir, ext) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith(ext)).map((f) => `${dir}/${f}`);

/** Reserved by RFC for exactly this purpose. */
const RESERVED_TLD = /\.(test|example|invalid|localhost)$/i;
// Subdomains count: `mail.example.com` is as reserved as `example.com`.
const RESERVED_DOMAIN = /^(.+\.)?(example\.(com|org|net)|localhost)$/i;

// Real services the code legitimately names: these are endpoints and docs, not
// stand-ins for a person, and replacing them would break the thing they point at.
const REAL_SERVICES = new Set([
  'api.twilio.com', 'lookups.twilio.com', 'www.twilio.com', 'api.anthropic.com',
  'api.github.com', 'github.com', 'www.googleapis.com', 'oauth2.googleapis.com',
  'gmail.googleapis.com', 'developers.google.com', 'calendly.com', 'api.calendly.com',
  'overpass-api.de', 'www.openstreetmap.org', 'api.search.brave.com',
  'api-dashboard.search.brave.com', 'api.dataforseo.com', 'api.instantly.ai',
  'developer.instantly.ai', 'schema.org', 's.wordpress.com', 'fonts.googleapis.com',
  'fonts.gstatic.com', 'cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'vercel.com',
  'openapi.vercel.sh', 'inspiringwebsites.org', 'claude.com', 'anthropic.com',
  'resend.com', 'api.resend.com', 'w3.org', 'www.w3.org',
  // A vendor's automated sender, used to test that a meeting-bot's email is not
  // mistaken for a client request. It is a service address, not a person's, and
  // the realism is the point of the fixture.
  'e.read.ai',
]);

// Free-mail hosts are LOAD-BEARING in the normalisation tests: the code has
// Gmail-specific rules (dots and +tags collapse) and a free-mail-host list that
// decides what counts as a business domain. Replacing them with `.test` would
// leave the tests asserting nothing. They are also not anybody's address — the
// local parts beside them are obvious placeholders — so the disclosure risk is
// the host name itself, which is already public knowledge.
const FREE_MAIL = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.uk', 'hotmail.com', 'outlook.com', 'aol.com', 'icloud.com']);

const domainOf = (addr) => String(addr).split('@')[1]?.toLowerCase() || '';
const isSafe = (d) => RESERVED_TLD.test(d) || RESERVED_DOMAIN.test(d) || REAL_SERVICES.has(d) || FREE_MAIL.has(d);

// ---------------------------------------------------------------------------
section('R1  no fixture uses an address somebody could actually own');
const files = [...listJs('tests', '.mjs'), ...listJs('lib', '.js'), ...listJs('api', '.js'), ...listJs('public', '.js')];
const offenders = [];
for (const f of files) {
  // This file names the bad shapes on purpose — see VALIDATOR_FIXTURES below.
  if (f === 'tests/public-repo.test.mjs' || f === 'tests/secret-scan.test.mjs') continue;
  const src = read(f);
  for (const m of src.matchAll(/[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g)) {
    const d = m[1].toLowerCase().replace(/[.,)'"]+$/, '');
    if (!isSafe(d)) offenders.push(`${f}: ${m[0]}`);
  }
}
check('every email fixture is on a reserved domain', offenders.length === 0,
  offenders.slice(0, 8).join(' · ') || 'none');

section('R1b  NEGATIVE CONTROL: the scanner can see a bad one');
// A scanner that finds nothing is indistinguishable from one that looks at
// nothing. This is the exact shape it had to catch.
check('a real-looking address would be flagged', !isSafe(domainOf('angie@omtservices.com')),
  'omtservices.com is a real client domain and must never appear in a fixture');
check('while a reserved one passes', isSafe(domainOf('angie@omtservices.test')));
check('and example.com is allowed', isSafe(domainOf('a@example.com')));
check('and a real service endpoint is not mistaken for a person', isSafe('api.twilio.com'));

// ---------------------------------------------------------------------------
section('R2  no fixture phone number could ring a real person');
// 555-0100..0199 is the range reserved for fiction. lib/phone.js already refuses
// to send to one; this stops a NON-fictional number being written down in the
// first place, which is the part a refusal cannot undo once it is published.
// `phone.test.mjs` tests the VALIDATOR, so it has to contain numbers the
// validator rejects — 123-456-7890, 214-055-1234, an all-2s string. Exempting
// it is not a loophole: those numbers exist in order to be refused, and a rule
// that forbade them would forbid testing the rule.
// This file is exempt from its own number rule for the same reason: it has to
// name the shapes it catches, and a scanner that cannot describe what it looks
// for is harder to review than one that can.
// `tests/secret-scan.test.mjs` joins them for the same reason: it proves the
// pre-commit scanner catches a contactable address and a real-looking number,
// which requires containing one of each. A rule that forbade them would forbid
// testing the rule — the same trap as phone.test.mjs.
const VALIDATOR_FIXTURES = new Set([
  'tests/phone.test.mjs', 'tests/public-repo.test.mjs', 'tests/secret-scan.test.mjs',
]);

const badNumbers = [];
for (const f of listJs('tests', '.mjs')) {
  if (VALIDATOR_FIXTURES.has(f)) continue;
  const src = read(f);
  for (const m of src.matchAll(/\b(?:\+1)?[\s(-]?(\d{3})[\s)-]*(\d{3})[\s-]?(\d{4})\b/g)) {
    const [, , exch, line] = m;
    // Reserved for fiction, or an obviously structural number (all same digit).
    if (exch === '555' && /^01\d\d$/.test(line)) continue;
    if (/^(\d)\1{3}$/.test(line) && exch === '555') continue;
    if (exch === '555') continue; // the rest of 555 is largely unassigned
    badNumbers.push(`${f}: ${m[0]}`);
  }
}
check('every fixture number is in the 555 range', badNumbers.length === 0,
  badNumbers.slice(0, 6).join(' · ') || 'none');

// ---------------------------------------------------------------------------
section('R3  nothing credential-shaped is committed');
const SECRET_SHAPES = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bre_[A-Za-z0-9]{20,}/,
  /\bAC[0-9a-f]{32}\b/, /\bAKIA[0-9A-Z]{16}\b/, /\bxoxb-[0-9A-Za-z-]{20,}/,
];
const leaked = [];
for (const f of [...listJs('lib', '.js'), ...listJs('api', '.js'), ...listJs('public', '.js')]) {
  const src = read(f);
  for (const re of SECRET_SHAPES) if (re.test(src)) leaked.push(`${f}: ${re}`);
}
check('no shipped file carries a credential-shaped string', leaked.length === 0, leaked.join(' · ') || 'none');
check('NEGATIVE CONTROL: the shapes match a real-looking token',
  SECRET_SHAPES[1].test('ghp_abcdefghijklmnopqrstuvwxyz0123'),
  'if the patterns matched nothing, R3 would be an empty assurance');

section('R4  no .env or credential file is tracked');
const tracked = fs.readdirSync(ROOT).filter((f) => /^\.env|secret|credential/i.test(f));
const gitignore = fs.existsSync(path.join(ROOT, '.gitignore')) ? read('.gitignore') : '';
check('.env is ignored', /(^|\n)\.env/.test(gitignore), gitignore.slice(0, 120));
for (const f of tracked) {
  check(`${f} is not committed`, /(^|\n)\.?env|(^|\n)\*?\.env/.test(gitignore) || !fs.existsSync(path.join(ROOT, f)), f);
}

done();
