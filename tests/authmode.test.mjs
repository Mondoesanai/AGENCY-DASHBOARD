// The password loop, and the rule that makes a no-password preview safe.
//
// WHAT WENT WRONG. The owner opened the preview, typed a password, and the
// screen reset and asked for a password again. Two separate faults:
//
//   1. On a 401 the page WIPED the stored key and re-rendered the locked form,
//      so a single typo looked like the app forgetting what you just did —
//      with the message "Enter your password above", which is the thing you
//      had just done.
//   2. The preview required a password at all. The server was running in local
//      mode and not checking one, so the page was gating on a credential
//      nothing would validate.
//
// WHY THE ACCEPTANCE CHECKS MISSED IT. They set `localStorage.iw_secret`
// directly and never typed into the form, so the only path a real person takes
// was the one path never exercised. That is the lesson worth keeping.
import { check, section, done } from './world.mjs';
import { startLocalApi } from './harness/local-api.mjs';

// ---------------------------------------------------------------------------
section('A1  the server decides the mode, and a deployment can never be open');
const { authMode, isDeployed } = await import('../lib/auth.js');

const saved = { secret: process.env.CRON_SECRET, vercel: process.env.VERCEL, env: process.env.VERCEL_ENV };
const set = (o) => {
  for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};

set({ CRON_SECRET: undefined, VERCEL: undefined, VERCEL_ENV: undefined });
check('local, no secret -> open', authMode() === 'open', authMode());
check('and it knows it is not deployed', isDeployed() === false);

set({ VERCEL: '1' });
check('DEPLOYED with no secret -> locked, never open', authMode() === 'locked', authMode());
set({ VERCEL: undefined, VERCEL_ENV: 'production' });
check('VERCEL_ENV alone is enough to be deployed', authMode() === 'locked', authMode());

set({ VERCEL_ENV: undefined, CRON_SECRET: 'x' });
check('a secret always means enforced', authMode() === 'enforced', authMode());
set({ VERCEL: '1' });
check('deployed with a secret is enforced', authMode() === 'enforced', authMode());

set({ CRON_SECRET: saved.secret, VERCEL: saved.vercel, VERCEL_ENV: saved.env });

check('there are exactly three modes and only one is open',
  ['open', 'locked', 'enforced'].length === 3);

// ---------------------------------------------------------------------------
section('A2  the mode is readable BEFORE authenticating, and leaks nothing');
set({ CRON_SECRET: undefined, VERCEL: undefined, VERCEL_ENV: undefined });
let api = await startLocalApi();
let r = await api.get('/api/admin?do=auth-mode');
check('the route answers without a secret', r.status === 200, String(r.status));
check('and reports open', r.json && r.json.mode === 'open', JSON.stringify(r.json));
check('saying no password is required', r.json.requiresPassword === false);
check('it carries no secret of any kind', !/secret|token|key|password["\s:]+\w/i.test(r.text.replace(/requiresPassword/g, '')),
  r.text.slice(0, 140));

// with auth open, an admin route works with NO secret at all
r = await api.get('/api/admin?do=followups-due');
check('an admin route works with no secret when the mode is open', r.status === 200 && r.json.ok === true,
  `${r.status} ${JSON.stringify(r.json).slice(0, 80)}`);
await api.stop();

// ---------------------------------------------------------------------------
section('A3  with a secret set, nothing is open and the gate still bites');
set({ CRON_SECRET: 'the-real-secret' });
api = await startLocalApi();
r = await api.get('/api/admin?do=auth-mode');
check('the mode reports enforced', r.json && r.json.mode === 'enforced', JSON.stringify(r.json));
check('and says a password IS required', r.json.requiresPassword === true);

r = await api.get('/api/admin?do=followups-due');
check('an admin route with no secret is refused', r.status === 401, String(r.status));
r = await api.get('/api/admin?do=followups-due&secret=wrong');
check('a wrong secret is refused', r.status === 401, String(r.status));
r = await api.get('/api/admin?do=followups-due&secret=the-real-secret');
check('the right secret is accepted', r.status === 200 && r.json.ok === true, String(r.status));

// the thing that must never exist: a way for the CLIENT to ask for open mode
for (const attempt of [
  '/api/admin?do=followups-due&preview=1',
  '/api/admin?do=followups-due&authMode=open',
  '/api/admin?do=followups-due&mode=open',
  '/api/admin?do=followups-due&secret=&open=true',
  '/api/admin?do=followups-due&noauth=1',
]) {
  const res = await api.get(attempt);
  check(`"${attempt.split('&')[1]}" does not open the gate`, res.status === 401, `${res.status} on ${attempt}`);
}
const hdr = await api.get('/api/admin?do=followups-due', { headers: { 'x-preview-mode': 'open', 'x-auth-bypass': '1' } });
check('nor do headers claiming preview mode', hdr.status === 401, String(hdr.status));

await api.stop();
set({ CRON_SECRET: saved.secret, VERCEL: saved.vercel, VERCEL_ENV: saved.env });

// ---------------------------------------------------------------------------
section('A4  the preview refuses to start unless it is isolated');
// `preview.mjs` is a script, so its guards are checked by reading what it
// refuses on. Each of these is a condition under which a no-password server
// must not come up.
const src = (await import('node:fs')).readFileSync(new URL('../preview.mjs', import.meta.url), 'utf8');
check('it deletes CRON_SECRET rather than inventing one', /delete process\.env\.CRON_SECRET/.test(src));
check('it refuses when VERCEL is set', /VERCEL \|\| process\.env\.VERCEL_ENV/.test(src) && /refuse\(/.test(src));
check('it refuses when remote storage is configured', /KV_REST_API_URL[\s\S]{0,200}refuse\(/.test(src));
check('it refuses when provider credentials are present', /INSTANTLY_API_KEY[\s\S]{0,200}refuse\(/.test(src));
check('it binds to loopback only', /host: '127\.0\.0\.1'/.test(src));
check('and the refusal explains itself rather than just exiting', /REFUSED TO START/.test(src));

// the harness binds to loopback by default, not just when asked
const hsrc = (await import('node:fs')).readFileSync(new URL('./harness/local-api.mjs', import.meta.url), 'utf8');
check('the harness defaults to 127.0.0.1', /host = '127\.0\.0\.1'/.test(hsrc));
check('and passes the host to listen', /server\.listen\(port, host/.test(hsrc));

done();
