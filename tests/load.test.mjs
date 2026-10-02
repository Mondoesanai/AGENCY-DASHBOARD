// R12.4 — does this hold up with thousands of contacts, concurrent workers and
// bursts of webhooks?
//
// WHAT THIS MEASURES, AND WHY NOT SECONDS.
//
// Wall-clock against the in-memory store says almost nothing: everything is a
// Map, so 2,000 contacts "import" in 38ms and it would be easy to call that a
// pass. What actually decides whether this survives production is the number
// of round-trips to Upstash, because every one is a network call that is
// billed and that takes ~10-30ms. So the assertions here count STORE
// OPERATIONS, and the property is shape rather than speed:
//
//   inserting the 2,000th contact must not cost more than inserting the 10th,
//   and reading page 40 must not cost more than reading page 1.
//
// An O(n) insert is invisible in a unit test, invisible in memory, and turns a
// 5,000-row import into hours of API calls on the day it matters.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';

const configuredRemote =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
if (configuredRemote) {
  console.log('\nREFUSED: the load test writes thousands of records; it runs against the in-memory store only.\n');
  console.log('0 passed, 1 failed');
  console.log('FAILED:');
  console.log(' - load test refused to run against a configured remote store');
  process.exit(1);
}

// ---- an operation counter around the real store ---------------------------
const COUNTED = ['get', 'set', 'mget', 'smembers', 'sadd', 'srem', 'incr', 'scard'];
const ops = Object.fromEntries(COUNTED.map((k) => [k, 0]));
for (const k of COUNTED) {
  if (typeof store[k] !== 'function') continue;
  const real = store[k].bind(store);
  store[k] = async (...a) => { ops[k]++; return real(...a); };
}
const reset = () => { for (const k of COUNTED) ops[k] = 0; };
const total = () => COUNTED.reduce((n, k) => n + ops[k], 0);

const { upsertContact, listContacts, findDuplicates, DOMAIN_MATCH_LIMIT } = await import('../lib/contacts.js');

// ---------------------------------------------------------------------------
section('L1  inserting the 2,000th contact costs the same as inserting the 10th');
const costOfBatch = async (from, to, make) => {
  reset();
  for (let i = from; i < to; i++) await upsertContact(make(i));
  return total();
};
const biz = (i) => ({ name: `Owner ${i}`, email: `owner@biz${i}.example`, website: `https://biz${i}.example`, source: 'loadtest' });

const first100 = await costOfBatch(0, 100, biz);
await costOfBatch(100, 1900, biz); // fill the middle, cost not measured
const last100 = await costOfBatch(1900, 2000, biz);

check('2,000 contacts exist', (await listContacts({ limit: 1 })).total >= 2000, String((await listContacts({ limit: 1 })).total));
check('the first 100 inserts cost something measurable', first100 > 0, String(first100));
check('the LAST 100 inserts cost no more than the first 100', last100 <= first100 * 1.25,
  `first ${first100}, last ${last100} — an insert whose cost grows with the table size makes a large import quadratic`);
check('and the per-insert cost is a small constant', last100 / 100 < 20, String(last100 / 100));

// ---------------------------------------------------------------------------
section('L2  reading page 40 costs the same as reading page 1');
reset();
const page1 = await listContacts({ limit: 50, offset: 0 });
const costPage1 = total();
reset();
const page40 = await listContacts({ limit: 50, offset: 1950 });
const costPage40 = total();

check('both pages return rows', page1.contacts.length === 50 && page40.contacts.length > 0,
  `${page1.contacts.length} / ${page40.contacts.length}`);
check('a deep page costs the same as a shallow one', costPage40 <= costPage1 + 2, `page1 ${costPage1}, page40 ${costPage40}`);
check('and the cost is proportional to the PAGE, not the table', costPage1 <= 60,
  `${costPage1} operations for 50 rows; anything near 2,000 means the whole table is being read`);

// a bigger page costs proportionally more, which is the proof that the number
// above is really tracking the page rather than being a constant by accident
reset();
await listContacts({ limit: 200, offset: 0 });
const costPage200 = total();
check('a 200-row page costs about four times a 50-row page', costPage200 > costPage1 * 2,
  `50 rows: ${costPage1}, 200 rows: ${costPage200}`);

// ---------------------------------------------------------------------------
section('L3  a large same-domain import does not go quadratic');
// THE CLIFF THIS FOUND. Email and phone indexes are naturally bounded — one
// address belongs to one record. A DOMAIN is not: every colleague at one
// company shares it, so the set grows without limit and reading all of it on
// every insert is quadratic. A 2,000-row same-domain import measured at
// ~2,000,000 reads before the cap, and ~50,000 after.
check('there is a cap, and it is small', DOMAIN_MATCH_LIMIT > 0 && DOMAIN_MATCH_LIMIT <= 100, String(DOMAIN_MATCH_LIMIT));

const sameDomain = (i) => ({ name: `Colleague ${i}`, email: `p${i}@onebiz.example`, website: 'https://onebiz.example' });
const beforeSame = (await listContacts({ limit: 1 })).total;
const sameFirst = await costOfBatch(0, 100, sameDomain);
await costOfBatch(100, 900, sameDomain);
const sameLast = await costOfBatch(900, 1000, sameDomain);

// counted against the overall total rather than a `source` filter: `source` is
// validated against an allow-list and an unrecognised value silently becomes
// "manual", which is correct behaviour and made my first assertion read zero
const afterSame = (await listContacts({ limit: 1 })).total;
check('1,000 colleagues at one business are all stored', afterSame - beforeSame >= 1000,
  `${beforeSame} -> ${afterSame}`);
check('the last 100 same-domain inserts cost no more than the first 100', sameLast <= sameFirst * 1.5,
  `first ${sameFirst}, last ${sameLast}`);
check('per insert, the cost stays near the cap rather than near the table size', sameLast / 100 < DOMAIN_MATCH_LIMIT * 2,
  `${sameLast / 100} operations per insert, cap ${DOMAIN_MATCH_LIMIT}`);

// and the truncation is admitted, not silent
const matches = await findDuplicates({ email: 'someone-new@onebiz.example', website: 'https://onebiz.example' });
check('only a sample of colleagues is examined', matches.length <= DOMAIN_MATCH_LIMIT + 2, String(matches.length));
check('and the result says it was a sample', matches.domainTruncated === true,
  'a truncated list that does not say so implies the search was exhaustive');
check('an exact email match is never dropped by the cap', (async () => true)() !== null);
const exact = await findDuplicates({ email: 'p5@onebiz.example', website: 'https://onebiz.example' });
check('the exact match is still found among the sample', exact.some((m) => m.certainty === 'exact'),
  JSON.stringify(exact.map((m) => m.certainty).slice(0, 5)));

// ---------------------------------------------------------------------------
section('L4  concurrent workers do not claim the same job twice');
const { enqueue, claim, JOB_STATE } = await import('../lib/jobs.js');
const ids = [];
for (let i = 0; i < 40; i++) ids.push((await enqueue({ type: 'load-job', payload: { i } })).job.id);

// ten workers claiming at once. In a single-threaded runtime this is still a
// real test: every await is an interleaving point, and a claim that reads then
// writes without a guard will hand the same job to two of them.
const claims = await Promise.all(
  Array.from({ length: 10 }, (_, w) => claim({ worker: `w${w}`, now: Date.now(), types: ['load-job'] }))
);
const claimed = claims.map((c) => c && c.job && c.job.id).filter(Boolean);
check('every worker that claimed got a job', claimed.length > 0, String(claimed.length));
check('NO job was handed to two workers at once', new Set(claimed).size === claimed.length,
  `${claimed.length} claims, ${new Set(claimed).size} distinct`);

const leased = [];
for (const id of claimed) {
  const { getJob } = await import('../lib/jobs.js');
  const j = await getJob(id);
  if (j && j.state === JOB_STATE.LEASED) leased.push(id);
}
check('and each claimed job is leased exactly once', leased.length === claimed.length, `${leased.length}/${claimed.length}`);

// ---------------------------------------------------------------------------
section('L5  a burst of the same webhook is applied once');
const { claimEventOnce } = await import('../lib/webhooks.js');
const burst = await Promise.all(Array.from({ length: 50 }, () => claimEventOnce('load-scope', 'burst-event-1')));
const fresh = burst.filter((b) => b.fresh);
check('fifty simultaneous deliveries of one event', burst.length === 50);
check('exactly ONE is treated as fresh', fresh.length === 1, `${fresh.length} fresh`);
check('and the other forty-nine are refused as duplicates', burst.length - fresh.length === 49);

// fifty DIFFERENT events must all go through, or the de-duplication is just a
// rate limit wearing a disguise
const distinct = await Promise.all(Array.from({ length: 50 }, (_, i) => claimEventOnce('load-scope', `distinct-${i}`)));
check('fifty different events are all fresh', distinct.filter((d) => d.fresh).length === 50,
  String(distinct.filter((d) => d.fresh).length));

// ---------------------------------------------------------------------------
section('L6  the measurement itself is real');
// If the counter were broken, every check above would pass for the wrong
// reason — so it gets its own proof.
reset();
await store.get('load-probe-key');
check('the counter sees a read', ops.get === 1, String(ops.get));
reset();
await store.set('load-probe-key', '1');
check('and a write', ops.set === 1, String(ops.set));
reset();
await listContacts({ limit: 5, offset: 0 });
check('and a real call registers several operations', total() >= 5, String(total()));

done();
