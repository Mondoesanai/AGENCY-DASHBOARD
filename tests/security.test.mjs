// R11.7 — server-side secrets, authorization on every endpoint, safe logging.
// Plus the R11.6 provider bridge the reviewer found missing.
import fs from 'node:fs';
import path from 'node:path';
import { check, section, done } from './world.mjs';
import { mask, redact, redactText, safeLog, containsSecret } from '../lib/redact.js';
import { throwFromProviderResult, enqueue, runOne, getJob, JOB_STATE, claim, fail } from '../lib/jobs.js';

const ROOT = path.resolve(import.meta.dirname, '..');

// ---------------------------------------------------------------------------
section('S1  a redacted value cannot be used, only recognised');
check('a short value is fully hidden', mask('abc') === '[redacted]');
check('a long one keeps a hint of which secret it was', /^\[redacted:sk-…\d+chars\]$/.test(mask('sk-abcdefghijklmnop')), mask('sk-abcdefghijklmnop'));
check('and never the usable part', !mask('sk-abcdefghijklmnop').includes('defghij'));
check('an empty value is still redacted', mask('') === '[redacted]');

// ---------------------------------------------------------------------------
section('S2  secrets are caught by NAME, however deeply nested');
const cfg = {
  public: 'fine',
  CRON_SECRET: 'Doelee39-not-real',
  nested: { apiKey: 'sk-abc123def456ghi789', deeper: { refresh_token: 'rt-abcdefghijklmnop' } },
  headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz', 'content-type': 'application/json' },
  list: [{ password: 'hunter2hunter2' }],
};
const red = redact(cfg);
const asText = JSON.stringify(red);
check('a public value survives', red.public === 'fine');
check('CRON_SECRET is masked', !asText.includes('Doelee39-not-real'), asText);
check('a nested apiKey is masked', !asText.includes('sk-abc123def456ghi789'));
check('a doubly nested refresh_token is masked', !asText.includes('rt-abcdefghijklmnop'));
check('an Authorization header is masked', !asText.includes('abcdefghijklmnopqrstuvwxyz'));
check('a password inside an array is masked', !asText.includes('hunter2hunter2'));
check('non-secret headers survive', red.headers['content-type'] === 'application/json');

// ---------------------------------------------------------------------------
section('S3  secrets are also caught by SHAPE, under innocent key names');
const sneaky = {
  // the exact way this happens in practice: a debug dump under a harmless name
  debugInfo: 'calling with Bearer abcdefghijklmnopqrstuvwxyz0123',
  note: 'the key is sk-livekey123456789012 and it works',
  gh: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  url: 'https://dash.test/api/admin?do=receipts&secret=Doelee39-not-real',
};
const red2 = JSON.stringify(redact(sneaky));
check('a bearer token in free text is masked', !red2.includes('abcdefghijklmnopqrstuvwxyz0123'), red2);
check('an sk- key in prose is masked', !red2.includes('sk-livekey123456789012'));
check('a GitHub token is masked', !red2.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
check('a secret in a query string is masked', !red2.includes('Doelee39-not-real'), red2);
check('but the rest of the URL survives, so the log is still useful', red2.includes('do=receipts'));

// ---------------------------------------------------------------------------
section('S4  the logger is safe against the objects people actually log');
const logged = [];
const realLog = console.log;
console.log = (...a) => logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

safeLog('request', { headers: { Authorization: 'Bearer supersecrettokenvalue123' } });
safeLog(`fetching https://x.test/api?token=livetoken123456789`);
const err = new Error('github 401: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected');
safeLog('failed', err);

console.log = realLog;
const all = logged.join('\n');
check('nothing logged contains a bearer token', !all.includes('supersecrettokenvalue123'), all);
check('nothing logged contains a query token', !all.includes('livetoken123456789'));
check('an error message is redacted too', !all.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), all);
check('and the log is still readable', /github 401/.test(all), all);

// a circular object must not hang the logger
const circ = { name: 'req' };
circ.self = circ;
let threw = false;
try { redact(circ); } catch { threw = true; }
check('a circular object is handled, not thrown on', threw === false);
check('and marked as circular', JSON.stringify(redact(circ)).includes('[circular]'));

// ---------------------------------------------------------------------------
section('S5  AUDIT — the real source does not log secrets');
// A scan, not a proof: it catches the obvious mistakes, which are the ones that
// actually happen. Stated as such rather than as a guarantee.
const files = [];
for (const dir of ['lib', 'api']) {
  for (const f of fs.readdirSync(path.join(ROOT, dir))) {
    if (f.endsWith('.js')) files.push(path.join(dir, f));
  }
}
check('there is source to audit', files.length > 20, String(files.length));

const offenders = [];
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  src.split('\n').forEach((line, i) => {
    // a comment showing what NOT to do is not an offence
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (!/console\.(log|error|warn)/.test(line)) return;
    // logging a whole env, a whole headers object, or a named secret
    if (/console\.\w+\([^)]*\b(process\.env\b(?!\.\w)|req\.headers\b(?!\.)|CRON_SECRET|GITHUB_TOKEN|ANTHROPIC_API_KEY|signingKey|apiKey)\b/.test(line)) {
      offenders.push(`${f}:${i + 1} ${line.trim().slice(0, 100)}`);
    }
  });
}
check('no source line logs a secret or a whole env/headers object', offenders.length === 0, offenders.join(' | '));

// the supervisor's own log is on disk — check it never captured one
const supLog = path.resolve(ROOT, '..', '.claude', 'supervisor', 'supervisor.log');
if (fs.existsSync(supLog)) {
  const c = containsSecret(fs.readFileSync(supLog, 'utf8'));
  check('the supervisor log contains no credential-shaped strings', c.clean === true, (c.hits || []).join(', '));
}

// ---------------------------------------------------------------------------
section('S6  secrets stay server-side — the browser bundle has none');
for (const f of ['public/index.html', 'public/acquisition.js', 'public/nav.js']) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  check(`${f} contains no process.env`, !/process\.env\.[A-Z]/.test(src), f);
  const c = containsSecret(src);
  check(`${f} contains no credential-shaped literal`, c.clean === true, (c.hits || []).join(', '));
}

// ---------------------------------------------------------------------------
section('S7  R11.6 end to end — a provider 429 reaches the queue as a deferral');
// The reviewer found this gap: the queue handled rate limits but nothing
// converted a provider response into that signal.
let e429 = null;
try {
  throwFromProviderResult({ ok: false, status: 429, error: 'rate limited', retryAfter: 90 }, { what: 'test call' });
} catch (err) { e429 = err; }
check('a 429 result becomes a throw', !!e429);
check('marked as rate limited', e429.rateLimited === true);
check('carrying Retry-After in seconds', e429.retryAfterSec === 90, String(e429.retryAfterSec));
check('and NOT marked permanent', !e429.permanent);

let ePerm = null;
try { throwFromProviderResult({ ok: false, status: 401, error: 'bad key' }); } catch (err) { ePerm = err; }
check('a 401 is permanent — waiting will not fix credentials', ePerm.permanent === true);
let e404 = null;
try { throwFromProviderResult({ ok: false, status: 404, error: 'no such campaign' }); } catch (err) { e404 = err; }
check('a 404 is permanent too', e404.permanent === true);
let e500 = null;
try { throwFromProviderResult({ ok: false, status: 500, error: 'server error' }); } catch (err) { e500 = err; }
check('a 500 is neither — it retries normally', !e500.permanent && !e500.rateLimited);
check('a successful result passes through untouched', throwFromProviderResult({ ok: true, data: 1 }).data === 1);
// a provider that says "rate limit" in words without a 429
let eWords = null;
try { throwFromProviderResult({ ok: false, status: 400, error: 'Too Many Requests, slow down' }); } catch (err) { eWords = err; }
check('a rate limit described in words is still detected', eWords.rateLimited === true, eWords.message);

// and the whole path: handler throws -> job defers without spending an attempt
const handlers = {
  'provider-call': async () => throwFromProviderResult({ ok: false, status: 429, error: 'rate limited', retryAfter: 45 }),
};
const j = await enqueue({ type: 'provider-call', payload: {}, maxAttempts: 2 });
const r1 = await runOne({ handlers, now: Date.now(), types: ['provider-call'] });
check('the job is deferred, not failed', r1.deferred === true && r1.failed === false, JSON.stringify(r1));
const after = await getJob(j.job.id);
check('its attempt was given back', after.attempts === 0, String(after.attempts));
check('it is queued for later', after.state === JOB_STATE.QUEUED);
check('with the provider Retry-After honoured', after.runAt - Date.now() > 40000, String(after.runAt - Date.now()));
check('and a two-attempt job survives repeated rate limits', after.state !== JOB_STATE.DEAD);

// ---------------------------------------------------------------------------
section('S8  the redaction is INSTALLED, not merely available');
// The reviewer's point: a library nothing calls protects nothing. The
// acceptance criterion is a runtime outcome — "no credential leaks in logs" —
// so the sink itself is patched rather than every call site rewritten.
const { installSafeConsole, isSafeConsoleInstalled } = await import('../lib/redact.js');

// every serverless entry point must load the patch, and load it FIRST
const apiDir = path.join(ROOT, 'api');
const entries = fs.readdirSync(apiDir).filter((f) => f.endsWith('.js'));
check('there are entry points to check', entries.length === 12, String(entries.length));
const missing = entries.filter((f) => !fs.readFileSync(path.join(apiDir, f), 'utf8').includes("from '../lib/boot.js'") && !fs.readFileSync(path.join(apiDir, f), 'utf8').includes("import '../lib/boot.js'"));
check('every entry point loads the patch', missing.length === 0, missing.join(', '));

const notFirst = entries.filter((f) => {
  const imports = fs.readFileSync(path.join(apiDir, f), 'utf8').split('\n').filter((l) => /^import\s/.test(l));
  return imports.length > 0 && !imports[0].includes('boot.js');
});
check('and loads it BEFORE anything that could log', notFirst.length === 0, notFirst.join(', '));

// now the behaviour itself: a RAW console.log must be redacted once booted
await import('../lib/boot.js');
check('the patch reports itself installed', isSafeConsoleInstalled() === true);
check('installing twice is harmless', installSafeConsole() === installSafeConsole());

const captured = [];
const realLog2 = console.log;
// capture at the layer BELOW the patch, so we see what would really be written
const inner = { log: (...a) => captured.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')), error() {}, warn() {}, info() {} };
const handle = installSafeConsole(inner);

// the exact mistake this exists to stop: logging a whole request object
inner.log('incoming', { headers: { authorization: 'Bearer livetoken1234567890abcdef' }, query: { secret: 'Doelee39RealValue' } });
inner.log(`calling https://api.test/v1?api_key=sk-live9876543210abcdef`);
inner.log('error from provider: ghp_abcdefghijklmnopqrstuvwxyz0123456789');

handle.restore();
console.log = realLog2;

const out = captured.join('\n');
check('a bearer token in a logged object is masked', !out.includes('Bearer livetoken1234567890abcdef'), out);
check('a secret in a logged query object is masked', !out.includes('Doelee39RealValue'), out);
check('an api_key in a logged URL is masked', !out.includes('sk-live9876543210abcdef'), out);
check('a provider token in a plain string is masked', !out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), out);
check('the logs are still useful', /incoming/.test(out) && /api\.test/.test(out), out);

// and the audit function agrees there is nothing credential-shaped left
const audit = containsSecret(out);
check('containsSecret finds nothing in the captured output', audit.clean === true, (audit.hits || []).join(', '));

done();
