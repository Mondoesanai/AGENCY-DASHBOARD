// Tiny storage layer.
// Uses Vercel KV (Upstash Redis) in production. Falls back to an in-memory
// store for local dev so the app boots with zero setup.
//
// Env needed in production (set automatically when you add Vercel KV):
//   KV_REST_API_URL, KV_REST_API_TOKEN

let kv = null;
let usingKV = false;

async function getKV() {
  if (kv || kv === false) return kv;
  if (!process.env.KV_REST_API_URL) {
    kv = false;
    return kv;
  }
  try {
    const mod = await import('@vercel/kv');
    kv = mod.kv;
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
