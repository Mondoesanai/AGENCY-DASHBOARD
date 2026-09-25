// A fake outside world so the REAL application code can be driven end to end
// without touching production: GitHub (git-data API semantics), Anthropic,
// DataForSEO, Gmail/Calendar, Resend, Twilio. Import this FIRST — it sets the
// env vars the lib modules read at load time.
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.GITHUB_TOKEN = 'test-token';
process.env.AGENT_BLOG = 'off'; // blog tests switch it on
process.env.RESEND_API_KEY = 're_test';
process.env.REPORT_FROM = 'reports@acme-agency.test';
process.env.OWNER_EMAIL = 'owner@example.test';
process.env.DATAFORSEO_LOGIN = 'l';
process.env.DATAFORSEO_PASSWORD = 'p';
process.env.GOOGLE_CLIENT_ID = 'gid';
process.env.GOOGLE_CLIENT_SECRET = 'gsec';
process.env.GOOGLE_REFRESH_TOKEN = 'gref';
process.env.TWILIO_ACCOUNT_SID = 'ACtest';
process.env.TWILIO_AUTH_TOKEN = 'tok';
process.env.TWILIO_FROM = '+15550001111';
process.env.OWNER_PHONE = '+15551234567';
process.env.SMS_DAILY_CAP = '50';
process.env.PUBLIC_BASE_URL = 'https://dash.test';
delete process.env.CRON_SECRET;

export const W = {
  repos: {}, // 'owner/name' -> { files: {path: content}, sha: n }
  pending: {}, // tree sha -> {files}
  merged: [], // commits merged into main
  anthropic: [], // queue of reply texts OR functions(req)->text
  anthropicCalls: [],
  sms: [],
  emails: [],
  gmail: { inbox: [], threads: {}, sent: [], modified: [] },
  calendar: [],
  dfs: { ranks: {}, calls: 0 }, // keyword -> our rank (null = not found)
  pages: {}, // url -> html served for live-site fetches
};

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s) => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

export function addRepo(name, files) {
  W.repos[name] = { files: { ...files }, n: 1, blobs: {}, sha: 'base1' };
}
export function addMail(m) {
  const id = m.id || 'm' + (W.gmail.inbox.length + 1);
  const threadId = m.threadId || 't' + id;
  W.gmail.inbox.push({ id, threadId, from: m.from, subject: m.subject, body: m.body, snippet: m.body.slice(0, 80), labels: ['INBOX'], attachments: m.attachments || [] });
  W.gmail.threads[threadId] = m.threadHasSent ? ['INBOX', 'SENT'] : ['INBOX'];
  return id;
}

function repoOf(url) {
  const m = url.match(/\/repos\/([^/]+\/[^/]+)/);
  return m ? { name: m[1], repo: W.repos[m[1]] } : { name: null, repo: null };
}

async function github(url, method, body) {
  const u = new URL(url);
  const p = u.pathname;
  const { repo, name } = repoOf(url);
  if (!repo) return json({ message: 'Not Found' }, 404);
  if (/^\/repos\/[^/]+\/[^/]+$/.test(p)) return json({ default_branch: 'main', private: false });
  if (p.endsWith('/git/ref/heads/main')) return json({ object: { sha: repo.sha } });
  if (/\/git\/trees\/[^/]+$/.test(p) && method === 'GET') {
    return json({ tree: Object.keys(repo.files).map((path) => ({ path, type: 'blob' })), truncated: false });
  }
  if (p.includes('/contents/') && method === 'GET') {
    const path = decodeURIComponent(p.split('/contents/')[1]);
    if (!(path in repo.files)) return json({ message: 'Not Found' }, 404);
    return json({ content: b64(repo.files[path]) });
  }
  if (/\/git\/commits\/[^/]+$/.test(p) && method === 'GET') return json({ tree: { sha: 'tree0' } });
  if (p.endsWith('/git/blobs') && method === 'POST') {
    const sha = 'blob' + Object.keys(repo.blobs).length;
    repo.blobs[sha] = Buffer.from(body.content, 'base64').toString('utf8');
    return json({ sha });
  }
  if (p.endsWith('/git/trees') && method === 'POST') {
    const sha = 'tree' + (repo.n++);
    const files = { ...repo.files };
    for (const it of body.tree) files[it.path] = repo.blobs[it.sha];
    W.pending[sha] = files;
    return json({ sha });
  }
  if (p.endsWith('/git/commits') && method === 'POST') {
    const sha = 'commit' + (repo.n++);
    W.pending[sha] = { tree: body.tree, message: body.message };
    return json({ sha });
  }
  if (p.endsWith('/git/refs') && method === 'POST') {
    repo.refs = repo.refs || {};
    repo.refs[body.ref.replace('refs/heads/', '')] = body.sha;
    return json({ ref: body.ref });
  }
  if (p.endsWith('/pulls') && method === 'POST') {
    repo.prCount = (repo.prCount || 0) + 1;
    repo.prs = repo.prs || {};
    repo.prs[repo.prCount] = { ...body, state: 'open' };
    return json({ number: repo.prCount, html_url: `https://github.com/${name}/pull/${repo.prCount}` });
  }
  if (/\/pulls\/\d+\/merge$/.test(p) && method === 'PUT') {
    // squash-merge THIS pull request: its branch's tree becomes main
    const num = /\/pulls\/(\d+)\/merge/.exec(p)[1];
    const pr = repo.prs[num];
    const commit = repo.refs[pr.head];
    const files = W.pending[W.pending[commit].tree];
    repo.files = { ...files };
    repo.sha = 'merged' + repo.n++;
    pr.state = 'merged';
    W.merged.push({ repo: name, title: pr.title });
    return json({ merged: true });
  }
  if (/\/pulls\/\d+$/.test(p) && method === 'PATCH') {
    repo.prs[p.split('/').pop()].state = body.state;
    return json({});
  }
  return json({ message: 'unhandled ' + method + ' ' + p }, 500);
}

function anthropic(body) {
  const next = W.router ? undefined : W.anthropic.shift();
  const req = { model: body.model, system: body.system, messages: body.messages, max_tokens: body.max_tokens };
  W.anthropicCalls.push(req);
  const flat = JSON.stringify(body.messages);
  let text;
  if (W.router) text = W.router(req, flat);
  else if (typeof next === 'function') text = next(req, flat);
  else if (typeof next === 'string') text = next;
  else text = '{"isRevision": false, "slug": null, "confident": false, "summary": ""}';
  return json({
    id: 'msg_test', type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: Math.round(flat.length / 4), output_tokens: Math.round(String(text).length / 4), cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
}

function dataforseo(body) {
  W.dfs.calls++;
  const kw = body[0].keyword;
  if (/^site:/.test(kw)) {
    const d = kw.slice(5);
    return json({ status_code: 20000, cost: 0.002, tasks: [{ status_code: 20000, result: [{ se_results_count: 3, items: [1, 2, 3].map((i) => ({ type: 'organic', rank_absolute: i, domain: d, url: `https://${d}/p${i}`, title: 'p' + i })) }] }] });
  }
  const rank = kw in W.dfs.ranks ? W.dfs.ranks[kw] : null;
  const items = [
    { type: 'organic', rank_absolute: 1, domain: 'bigcompetitor.com', url: 'https://bigcompetitor.com/x', title: `Best ${kw} - BigCompetitor` },
    { type: 'organic', rank_absolute: 2, domain: 'other.org', url: 'https://other.org/y', title: `${kw} guide | Other` },
    { type: 'people_also_ask', items: [{ title: `How much does ${kw} cost?` }, { title: `Is ${kw} worth it?` }] },
    { type: 'related_searches', items: [`${kw} near me`, `cheap ${kw}`] },
  ];
  if (rank) items.push({ type: 'organic', rank_absolute: rank, domain: W.dfs.domain || 'acme.test', url: `https://${W.dfs.domain || 'acme.test'}/`, title: 'Acme' });
  return json({ status_code: 20000, cost: 0.002, tasks: [{ status_code: 20000, result: [{ se_results_count: 1200000, items }] }] });
}

function gmail(url, method, body) {
  const u = new URL(url);
  const p = u.pathname;
  if (p.endsWith('/users/me/messages') && method === 'GET') {
    const wantsProcessed = /label:iw-processed/.test(u.searchParams.get('q') || '') && !/-label:iw-processed/.test(u.searchParams.get('q') || '');
    const set = W.gmail.inbox.filter((m) => (wantsProcessed ? m.labels.includes('iw-processed') : !m.labels.includes('iw-processed')));
    return json({ messages: set.map((m) => ({ id: m.id })) });
  }
  {
    const am = p.match(/\/users\/me\/messages\/([^/]+)\/attachments\/(.+)$/);
    if (am) {
      const m = W.gmail.inbox.find((x) => x.id === am[1]);
      const a = m && m.attachments[Number(am[2].split('-').pop())];
      return a ? json({ data: b64url(a.data.toString('binary')).length ? a.data.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '' }) : json({ error: { message: 'nf' } }, 404);
    }
  }
  if (/\/users\/me\/messages\/[^/]+$/.test(p) && method === 'GET') {
    const m = W.gmail.inbox.find((x) => x.id === p.split('/').pop());
    if (!m) return json({ error: { message: 'nf' } }, 404);
    return json({
      id: m.id, threadId: m.threadId, snippet: m.snippet,
      payload: {
        mimeType: m.attachments && m.attachments.length ? 'multipart/mixed' : 'text/plain',
        headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, { name: 'Message-ID', value: `<${m.id}@mail.test>` }],
        body: m.attachments && m.attachments.length ? {} : { data: b64url(m.body) },
        parts: m.attachments && m.attachments.length ? [{ mimeType: 'text/plain', body: { data: b64url(m.body) } }, ...m.attachments.map((a, i) => ({ filename: a.filename, mimeType: a.mimeType || 'application/octet-stream', body: { attachmentId: `att-${m.id}-${i}`, size: a.data.length } }))] : undefined,
      },
    });
  }
  if (/\/threads\/[^/]+$/.test(p)) {
    const labels = W.gmail.threads[p.split('/').pop()] || [];
    return json({ messages: [{ labelIds: labels }] });
  }
  if (p.endsWith('/users/me/labels') && method === 'GET') return json({ labels: [{ id: 'L1', name: 'iw-processed' }] });
  if (p.endsWith('/modify')) {
    const id = p.split('/').slice(-2)[0];
    const m = W.gmail.inbox.find((x) => x.id === id);
    if (m && body && !body.addLabelIds && Array.isArray(body.removeLabelIds) && body.removeLabelIds.length) m.labels = m.labels.filter((l) => l !== 'iw-processed');
    else if (m) m.labels.push('iw-processed');
    W.gmail.modified.push(id);
    return json({});
  }
  if (p.endsWith('/users/me/messages/send') && method === 'POST') {
    const raw = Buffer.from(body.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    W.gmail.sent.push(raw);
    return json({ id: 'sent' + W.gmail.sent.length });
  }
  if (p.endsWith('/users/me/profile')) return json({ emailAddress: 'info@agency.test' });
  if (p.includes('/calendars/primary/events')) {
    if (method === 'POST') { W.calendar.push(body); return json({ id: 'ev' + W.calendar.length, htmlLink: 'https://cal.test/ev' + W.calendar.length }); }
    return json({});
  }
  return json({ error: { message: 'unhandled gmail ' + method + ' ' + p } }, 500);
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url || String(input);
  const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
  let bodyRaw = init.body;
  if (bodyRaw === undefined && typeof input !== 'string' && input.body) bodyRaw = await input.text();
  let body = null;
  if (typeof bodyRaw === 'string') { try { body = JSON.parse(bodyRaw); } catch { body = bodyRaw; } }
  if (url.startsWith('https://api.github.com')) return github(url, method, body);
  if (url.startsWith('https://api.anthropic.com')) {
    const dly = W.delayFor ? W.delayFor(body) : W.delayMs;
    if (dly) {
      // like a real network call: an aborted request (client timeout) rejects
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, dly);
        init.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
        });
      });
    }
    return anthropic(body);
  }
  if (url.startsWith('https://api.dataforseo.com')) return dataforseo(body);
  if (url.startsWith('https://oauth2.googleapis.com')) return json({ access_token: 'at', expires_in: 3500 });
  if (url.startsWith('https://gmail.googleapis.com') || url.startsWith('https://www.googleapis.com/calendar')) return gmail(url, method, body);
  if (url.startsWith('https://api.twilio.com')) {
    const p = new URLSearchParams(bodyRaw);
    W.sms.push({ to: p.get('To'), body: p.get('Body') });
    return json({ sid: 'SM' + W.sms.length });
  }
  if (url.startsWith('https://api.resend.com/domains')) return json({ data: [{ name: 'acme-agency.test', status: 'verified' }] });
  if (url.startsWith('https://api.resend.com/emails')) {
    W.emails.push({ ...body });
    return json({ id: 'em' + W.emails.length });
  }
  if (url.includes('pagespeedonline')) return json({ error: { message: 'quota' } }, 429);
  if (url in W.pages) return new Response(W.pages[url], { status: 200, headers: { 'content-type': 'text/html' } });
  if (url.startsWith('https://acme.test') || url.includes('.test')) return new Response('<html><head><title>Acme</title></head><body>hi</body></html>', { status: 200 });
  return realFetch(input, init);
};

// tiny assertion helper -> prints PASS/FAIL and tallies
export const T = { pass: 0, fail: 0, failures: [] };
export function check(name, cond, detail = '') {
  if (cond) { T.pass++; console.log('  PASS ', name); }
  else { T.fail++; T.failures.push(name); console.log('  FAIL ', name, detail ? '-> ' + detail : ''); }
}
export function section(t) { console.log('\n== ' + t); }
export function done() {
  console.log(`\n${T.pass} passed, ${T.fail} failed`);
  if (T.fail) console.log('FAILED:\n - ' + T.failures.join('\n - '));
  process.exit(T.fail ? 1 : 0);
}
export { b64, b64url };
