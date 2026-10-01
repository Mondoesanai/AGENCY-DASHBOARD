// Governance checks (R12.1, R12.8, R11.7).
//
// The owner's standing rule is that neither the builder nor the supervisor may
// silently remove a requirement or weaken an acceptance criterion in order to
// declare completion. Until now that was a sentence in a document, which is
// worth nothing — a document cannot enforce itself.
//
// These checks make it mechanical:
//   * every requirement in the spec is tracked in the plan, and vice versa
//   * every requirement has a non-empty acceptance criterion
//   * nothing is ticked [x] without a real evidence row at L1 or higher
//   * the plan's own tally matches the measured counts
//   * every API endpoint either checks authorization or is on an explicit
//     allowlist that says why it is public
//
// A failure here is not a style complaint. It means a claim has drifted from
// its evidence.
import fs from 'node:fs';
import path from 'node:path';
import { check, section, done } from './world.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const specText = read('PROJECT_SPEC.md');
const planText = read('BUILD_PLAN.md');
const verText = read('VERIFICATION_REPORT.md');

// ---------------------------------------------------------------------------
section('G1  the spec and the plan describe the same system');

// spec rows: | R1.1 | requirement | acceptance criteria |
const spec = new Map();
for (const line of specText.split('\n')) {
  const m = line.match(/^\|\s*(R\d+\.\d+)\s*\|([^|]*)\|([^|]*)\|/);
  if (m) spec.set(m[1], { req: m[2].trim(), accept: m[3].trim() });
}

// plan tasks, in either shape
const plan = new Map();
for (const line of planText.split('\n')) {
  const row = line.match(/^\s*\|\s*(R\d+\.\d+)\s*\|([^|]*)\|(.*)$/);
  if (!row) continue;
  const mark = row[3].match(/`\[([ xXbB~!])\]`/);
  if (!mark) continue;
  plan.set(row[1], { task: row[2].trim(), mark: mark[1].toLowerCase(), line });
}

check('the spec defines requirements', spec.size > 0, String(spec.size));
check('the plan tracks requirements', plan.size > 0, String(plan.size));

const missingFromPlan = [...spec.keys()].filter((id) => !plan.has(id));
check('every spec requirement is tracked in the plan', missingFromPlan.length === 0, missingFromPlan.join(', '));

const notInSpec = [...plan.keys()].filter((id) => !spec.has(id));
check('every plan task maps to a spec requirement', notInSpec.length === 0, notInSpec.join(', '));

const noAccept = [...spec.entries()].filter(([, v]) => !v.accept || v.accept.length < 8).map(([k]) => k);
check('every requirement has a non-empty acceptance criterion', noAccept.length === 0, noAccept.join(', '));

const noText = [...spec.entries()].filter(([, v]) => !v.req || v.req.length < 8).map(([k]) => k);
check('no requirement has been blanked out', noText.length === 0, noText.join(', '));

// ---------------------------------------------------------------------------
section('G2  nothing is ticked without evidence');

// evidence rows: | R1.7 | check | L1+L2 | result |   (level in any cell)
const evidence = new Map();
for (const line of verText.split('\n')) {
  const m = line.match(/^\|\s*\*{0,2}(R\d+\.\d+[a-z]?)\*{0,2}\s*\|(.*)$/);
  if (!m) continue;
  const id = m[1];
  const levels = [...m[2].matchAll(/L([0-4])/g)].map((x) => Number(x[1]));
  const best = levels.length ? Math.max(...levels) : null;
  const prev = evidence.get(id);
  if (!prev || (best ?? -1) > (prev.level ?? -1)) evidence.set(id, { level: best, line });
}
// an "R1.7a" style sub-row counts as evidence for R1.7
const evidenceFor = (id) => {
  let best = evidence.get(id)?.level ?? null;
  for (const [k, v] of evidence) {
    if (k.startsWith(id) && k !== id && (v.level ?? -1) > (best ?? -1)) best = v.level;
  }
  return best;
};

const ticked = [...plan.entries()].filter(([, v]) => v.mark === 'x').map(([k]) => k);
check('some requirements are ticked', ticked.length > 0, String(ticked.length));

const tickedNoEvidence = ticked.filter((id) => evidenceFor(id) === null);
check(
  'every [x] has an evidence row in the verification report',
  tickedNoEvidence.length === 0,
  'ticked with no evidence: ' + tickedNoEvidence.join(', ')
);

const tickedWeakEvidence = ticked.filter((id) => {
  const lvl = evidenceFor(id);
  return lvl !== null && lvl < 1;
});
check(
  'no [x] rests on an L0 "claimed" row',
  tickedWeakEvidence.length === 0,
  'ticked on L0 only: ' + tickedWeakEvidence.join(', ')
);

// the reverse direction: evidence for something the plan says is not done
const evidencedNotTicked = [...evidence.keys()]
  .filter((id) => plan.has(id) && (evidence.get(id).level ?? 0) >= 1 && plan.get(id).mark !== 'x');
check(
  'anything with real evidence is marked done in the plan',
  evidencedNotTicked.length === 0,
  'has evidence but not ticked: ' + evidencedNotTicked.join(', ')
);

// ---------------------------------------------------------------------------
section('G3  the plan\'s own tally is true');

const counts = { x: 0, b: 0, '~': 0, '!': 0, ' ': 0 };
for (const [, v] of plan) {
  const eff = /\[!\]/.test(v.line.replace(/`\[[ xXbB~]\]`/g, '')) ? '!' : v.mark;
  counts[eff] = (counts[eff] || 0) + 1;
}
const stated = (label) => {
  const m = planText.match(new RegExp('\\|\\s*`\\[' + label + '\\]`[^|]*\\|\\s*(\\d+)'));
  return m ? Number(m[1]) : null;
};
for (const [label, key] of [['x', 'x'], ['b', 'b'], ['~', '~'], ['!', '!'], [' ', ' ']]) {
  const s = stated(label === ' ' ? ' ' : label);
  if (s === null) continue;
  check(`the stated count for [${label}] matches the real one`, s === counts[key], `stated ${s}, actual ${counts[key]}`);
}

// ---------------------------------------------------------------------------
section('G4  every endpoint is authorized, or explicitly public');

// Each entry must say WHY it is reachable without a password. Adding a file to
// this list is a deliberate, reviewable act.
const PUBLIC_BY_DESIGN = {
  'collect.js': 'the analytics beacon client sites POST to — must be open, carries no client data back',
  't.js': 'the tracking pixel/script served to client sites',
  'public-report.js': 'the client-facing monthly report, protected by a per-site token rather than the admin password',
  'shot.js': 'screenshot proxy for report images, no stored data',
  'audit.js': 'runs a public PageSpeed-style audit of a URL anyone could audit themselves',
  'card.js': 'business-card upload endpoint, rate-limited; guarded inside the handler',
};

const apiFiles = fs.readdirSync(path.join(ROOT, 'api')).filter((f) => f.endsWith('.js'));
check('the api directory was found', apiFiles.length > 0, String(apiFiles.length));
check('still within the Vercel Hobby 12-function limit', apiFiles.length <= 12, `${apiFiles.length} functions`);

const unguarded = [];
for (const f of apiFiles) {
  const src = read(path.join('api', f));
  const guarded = /\bauthed\s*\(/.test(src) || /CRON_SECRET/.test(src) || /reportToken|verifyToken/.test(src);
  if (!guarded && !PUBLIC_BY_DESIGN[f]) unguarded.push(f);
}
check(
  'no endpoint is unauthenticated by accident',
  unguarded.length === 0,
  'no auth check and not on the public allowlist: ' + unguarded.join(', ')
);

// the allowlist must not rot: every entry must still exist
const staleAllow = Object.keys(PUBLIC_BY_DESIGN).filter((f) => !apiFiles.includes(f));
check('the public allowlist has no stale entries', staleAllow.length === 0, staleAllow.join(', '));

// and the gate itself must fail closed — a regression here is the one that
// quietly publishes the client book
const authSrc = read('lib/auth.js');
check('there is exactly one shared auth gate', /export function authed/.test(authSrc));
const localGates = apiFiles.filter((f) => /function authed\s*\(/.test(read(path.join('api', f))));
check('no endpoint defines its own competing auth gate', localGates.length === 0, localGates.join(', '));
check('the shared gate denies when deployed without a secret', /isDeployed\(\) \? 'locked'/.test(authSrc));

// ---------------------------------------------------------------------------
section('G5  the verification report keeps its honesty clauses');
check('it still states that a tick is not verification', /is not verification/.test(verText));
check('it still carries the L0–L4 level definitions', /L0 claimed/.test(verText) && /L4 production-observed/.test(verText));
check('it still keeps an explicit not-yet-verified list', /Not yet verified/.test(verText));
check('it still refuses to call an unconfigured integration production-ready', /production-ready/.test(verText));
check('the plan still records what is blocked on the owner', /externally blocked/.test(planText));
check('the plan still forbids weakening a requirement to declare completion', /never erased|silently/.test(planText));

done();
