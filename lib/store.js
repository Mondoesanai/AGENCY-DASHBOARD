// Tiny storage layer.
// Uses Upstash Redis (via @vercel/kv's REST client) in production. Falls back
// to an in-memory store for local dev so the app boots with zero setup.
//
// Works with EITHER env var pair, whichever the integration sets:
//   KV_REST_API_URL        + KV_REST_API_TOKEN          (Vercel KV / older Upstash)
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   (Upstash marketplace)

const REST_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

let kv = null;
let usingKV = false;

async function getKV() {
  if (kv || kv === false) return kv;
  if (!REST_URL || !REST_TOKEN) {
    kv = false;
    return kv;
  }
  try {
    const { createClient } = await import('@vercel/kv');
    kv = createClient({ url: REST_URL, token: REST_TOKEN });
    usingKV = true;
    return kv;
  } catch {
    kv = false;
    return kv;
  }
}

// ---- in-memory fallback (dev only) --------------------------------------
const mem = {
  str: new Map(),
  zset: new Map(), // key -> Map(member -> score)
  set: new Map(),  // key -> Set(members)  (approx HLL)
  sset: new Map(), // key -> Set(members)  (plain set)
};

function zmap(key) {
  if (!mem.zset.has(key)) mem.zset.set(key, new Map());
  return mem.zset.get(key);
}

// ---- public API -------------------------------------------------------
export const store = {
  get backend() {
    return usingKV ? 'vercel-kv' : 'memory';
  },

  async incr(key, by = 1) {
    const k = await getKV();
    if (k) return k.incrby(key, by);
    mem.str.set(key, (Number(mem.str.get(key)) || 0) + by);
    return mem.str.get(key);
  },

  async get(key) {
    const k = await getKV();
    if (k) return k.get(key);
    const v = mem.str.get(key);
    return v === undefined ? null : v;
  },

  async set(key, value, opts) {
    const k = await getKV();
    if (k) return k.set(key, value, opts);
    mem.str.set(key, value);
    return 'OK';
  },

  async sadd(key, member) {
    const k = await getKV();
    if (k) return k.sadd(key, member);
    if (!mem.sset.has(key)) mem.sset.set(key, new Set());
    mem.sset.get(key).add(member);
    return 1;
  },

  async srem(key, member) {
    const k = await getKV();
    if (k) return k.srem(key, member);
    mem.sset.get(key)?.delete(member);
    return 1;
  },

  // Real delete. `set(key, '', {ex:1})` was the workaround everywhere else;
  // that leaves a falsy-but-present key for a second and can't remove set
  // members at all, which matters once contacts can be erased on request.
  async del(key) {
    const k = await getKV();
    if (k) return k.del(key);
    mem.str.delete(key);
    mem.zset.delete(key);
    mem.set.delete(key);
    mem.sset.delete(key);
    return 1;
  },

  // Atomic check-and-increment used for budget reservations.
  // INCR is atomic in Redis, so two workers racing the same allowance both get
  // a distinct post-increment value; whichever pushes past the cap rolls its
  // own increment back and is refused. Without this, concurrent workers each
  // read "spent < cap" and both proceed, overspending the owner's limit.
  // Returns { ok, value, limit } — ok:false means the caller must not spend.
  async reserve(key, amount, limit) {
    const after = await this.incr(key, amount);
    if (limit != null && after > limit) {
      await this.incr(key, -amount); // give it back
      return { ok: false, value: after - amount, limit };
    }
    return { ok: true, value: after, limit };
  },

  // R12.4 — "am I the first?", atomically.
  //
  // The pattern this replaces is read-then-write:
  //
  //     if (await store.get(k)) return duplicate;
  //     await store.set(k, ...);
  //
  // which is correct right up until two callers run it at once, and then both
  // read nothing and both proceed. That is not theoretical here: ten workers
  // racing one job queue all claimed the SAME job, and fifty simultaneous
  // deliveries of one webhook were all treated as new. INCR is atomic in
  // Redis, so exactly one caller can ever see 1.
  //
  // The token is written separately, after the claim is won, purely so the key
  // can carry a timestamp and a TTL. It is a record, not the lock.
  async claimOnce(key, { ttlSec = null, now = Date.now() } = {}) {
    const n = await this.incr(`claim:${key}`, 1);
    if (n !== 1) return { won: false, holders: n };
    if (ttlSec != null) {
      await this.set(key, String(now), { ex: ttlSec }).catch(() => {});
      // the counter has to outlive the record, or the claim is forgotten first
      // and a late duplicate is treated as fresh
      await this.set(`claim:${key}`, '1', { ex: Math.round(ttlSec * 1.5) }).catch(() => {});
    }
    return { won: true };
  },

  async smembers(key) {
    const k = await getKV();
    if (k) return k.smembers(key);
    return mem.sset.has(key) ? [...mem.sset.get(key)] : [];
  },

  async mget(keys) {
    if (!keys.length) return [];
    const k = await getKV();
    if (k) return k.mget(...keys);
    return keys.map((key) => {
      const v = mem.str.get(key);
      return v === undefined ? null : v;
    });
  },

  // approximate unique count (HyperLogLog in KV, Set in memory)
  async pfadd(key, member) {
    const k = await getKV();
    if (k) return k.pfadd(key, member);
    if (!mem.set.has(key)) mem.set.set(key, new Set());
    mem.set.get(key).add(member);
    return 1;
  },

  async pfcount(key) {
    const k = await getKV();
    if (k) return k.pfcount(key);
    return mem.set.has(key) ? mem.set.get(key).size : 0;
  },

  async zincr(key, member, by = 1) {
    const k = await getKV();
    if (k) return k.zincrby(key, by, member);
    const m = zmap(key);
    m.set(member, (m.get(member) || 0) + by);
    return m.get(member);
  },

  // top N members as [{ member, score }]
  async ztop(key, n = 10) {
    const k = await getKV();
    if (k) {
      const raw = await k.zrange(key, 0, n - 1, { rev: true, withScores: true });
      const out = [];
      for (let i = 0; i < raw.length; i += 2) {
        out.push({ member: raw[i], score: Number(raw[i + 1]) });
      }
      return out;
    }
    const m = zmap(key);
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([member, score]) => ({ member, score }));
  },
};

export function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

// list of YYYY-MM-DD strings for the last `n` days ending today (inclusive)
export function lastDays(n) {
  const out = [];
  const now = new Date();
  for (let i = 0; i < n; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}
