// A real HTTP server running the REAL API handlers, for R12.2.
//
// Every test before this one called a library function directly. That proves
// the library works and proves nothing about the path the browser actually
// takes, which is where this build has repeatedly been wrong: a button with no
// handler, a route reporting a refusal as a success, a module imported and
// never called. Those are all invisible to a unit test and all obvious the
// first time a request travels the whole way.
//
// So this mounts `api/admin.js` and `api/collect.js` — the real files Vercel
// deploys, not copies — behind a real socket, beside the real `public/`
// directory. The only things faked are the ones that would otherwise reach
// outside this machine: the outbound provider call and the clock.
//
// What this deliberately does NOT do is reimplement any part of the handlers.
// The moment this file contains product logic it stops being a harness and
// starts being a second implementation that can agree with a broken one.

import { createServer, request as httpRequest } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, '..', '..', 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/** Adapt Node's response to the `res.status().json()` shape the handlers use. */
function vercelRes(res, record) {
  let code = 200;
  const out = {
    status(c) { code = c; return out; },
    setHeader(k, v) { res.setHeader(k, v); return out; },
    json(body) {
      record({ code, body });
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
      return out;
    },
    send(body) {
      record({ code, body });
      if (!res.headersSent) res.writeHead(code);
      res.end(typeof body === 'string' ? body : String(body));
      return out;
    },
    end(body) {
      record({ code, body: body ?? null });
      if (!res.headersSent) res.writeHead(code);
      res.end(body);
      return out;
    },
    redirect(where) {
      record({ code: 302, body: where });
      res.writeHead(302, { location: where });
      res.end();
      return out;
    },
  };
  return out;
}

const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        // form posts: the unsubscribe one-click POST is form-encoded
        const o = {};
        for (const [k, v] of new URLSearchParams(raw)) o[k] = v;
        resolve(o);
      }
    });
  });

/**
 * Start the server.
 *
 * Returns the port, a log of every request that went through (so a test can
 * assert what the BROWSER actually called, not what it believes it called),
 * and a stop function.
 */
export async function startLocalApi({ port = 0, extraRoutes = {}, host = '127.0.0.1' } = {}) {
  // Every function in api/, mounted at the path Vercel gives it. Listing them
  // by hand would mean a new endpoint is unreachable here until someone
  // remembers to add it — and an endpoint no full-path test can reach is
  // exactly the kind that ships unauthorised.
  const dir = join(HERE, '..', '..', 'api');
  const routes = {};
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.js')) continue;
    const mod = await import(pathToFileURL(join(dir, file)).href);
    if (typeof mod.default === 'function') routes[`/api/${file.replace(/\.js$/, '')}`] = mod.default;
  }

  const calls = [];

  const server = createServer(async (req, res) => {
    // No keep-alive. `fetch` otherwise holds a pooled connection per origin,
    // and a test that talks to two harness servers and then exits trips a
    // libuv assertion on Windows while those pools are torn down. Tests do not
    // need connection reuse, and a socket that closes when the response ends
    // is one less thing that can keep a process alive after it should be gone.
    res.setHeader('connection', 'close');

    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const query = Object.fromEntries(url.searchParams);
      const body = req.method === 'GET' ? {} : await readBody(req);
      const entry = { method: req.method, path, query, at: Date.now(), code: null };
      calls.push(entry);
      const vreq = { method: req.method, query, body, headers: req.headers, url: req.url };
      const vres = vercelRes(res, ({ code, body: out }) => {
        entry.code = code;
        entry.ok = !!(out && out.ok);
        entry.response = out;
      });
      // `extraRoutes` exists for ONE purpose: proving this harness reports a
      // crashing handler as a crash. Without a route that can be made to throw
      // on demand, that catch block below is never executed, and a harness
      // that quietly turns a 500 into `{ok: false}` would make every
      // full-path test built on it agree with a broken product.
      const handler = extraRoutes[path] || routes[path] || null;
      if (!handler) {
        entry.code = 404;
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'no such function' }));
      }
      try {
        await handler(vreq, vres);
      } catch (e) {
        // A handler that throws is a real failure and must look like one. It
        // must NOT be rendered as a tidy {ok:false}, because then a crash and
        // a refusal are indistinguishable to the caller — which is exactly the
        // confusion this whole harness exists to remove.
        entry.code = 500;
        entry.threw = String(e && e.message ? e.message : e);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'handler threw', detail: entry.threw }));
      }
      return;
    }

    // static, from the real public/ directory
    const file = path === '/' ? 'index.html' : path.replace(/^\//, '');
    try {
      const buf = await readFile(join(PUBLIC, file));
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });

  // Bound to loopback by default. A preview that answers on the LAN is a
  // preview someone else can reach, and this one runs without a password.
  await new Promise((resolve) => server.listen(port, host, resolve));
  const actual = server.address().port;

  /**
   * Make a request, over `node:http` rather than `fetch`.
   *
   * Two reasons, both learned the hard way. `fetch` keeps a connection pool
   * that outlives the response, and a test that makes two requests and then
   * calls `process.exit()` trips a libuv assertion while that pool is torn
   * down — the file prints "28 passed, 0 failed" and exits 127, which is green
   * output from a failing process. And `tests/world.mjs` replaces
   * `globalThis.fetch` with a stub for the whole suite, so a test using
   * `fetch` here is quietly going through that stub to reach its own server.
   * This goes straight to the socket and closes it.
   */
  const request = (path, { method = 'GET', headers = {}, body = null } = {}) =>
    new Promise((resolve, reject) => {
      const payload = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
      const req = httpRequest(
        {
          host: 'localhost',
          port: actual,
          path,
          method,
          agent: false, // no pooling: the socket closes with the response
          headers: {
            ...(payload == null ? {} : { 'content-length': Buffer.byteLength(payload) }),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text); } catch { /* not every response is JSON */ }
            resolve({ status: res.statusCode, headers: res.headers, text, json });
          });
        }
      );
      req.on('error', reject);
      if (payload != null) req.write(payload);
      req.end();
    });

  return {
    port: actual,
    origin: `http://localhost:${actual}`,
    request,
    get: (path, opts) => request(path, opts),
    post: (path, body, headers) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(headers || {}) },
        body,
      }),
    form: (path, fields) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(fields).toString(),
      }),
    calls,
    /** every API call the browser made, newest last */
    called: (name) => calls.filter((c) => c.query && c.query.do === name),
    // `fetch` keeps connections alive, so `server.close()` alone waits for
    // sockets that will never close on their own — and a test that starts
    // several servers then exits trips a libuv assertion on Windows. Dropping
    // the open sockets first makes shutdown deterministic.
    stop: () =>
      new Promise((resolve) => {
        if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A stand-in for the sending provider.
 *
 * It accepts, records and can be told to fail. Nothing in the test suite may
 * reach a real provider: that is not a style preference, it is the difference
 * between a test run and sending mail to strangers.
 */
export function providerFixture({ failWith = null } = {}) {
  const sent = [];
  const fetchImpl = async (url, opts = {}) => {
    let payload = {};
    try {
      payload = JSON.parse(opts.body || '{}');
    } catch { /* keep the raw body below */ }
    sent.push({ url: String(url), payload, raw: opts.body || '' });
    if (failWith) {
      return {
        ok: false,
        status: failWith.status || 500,
        async json() { return { message: failWith.message || 'provider error' }; },
        async text() { return failWith.message || 'provider error'; },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() { return { id: `fixture-${sent.length}` }; },
      async text() { return JSON.stringify({ id: `fixture-${sent.length}` }); },
    };
  };
  return { sent, fetchImpl };
}
