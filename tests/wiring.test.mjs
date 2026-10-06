// Is every front-end module actually called by the page?
//
// Why this exists: `public/index.html` is ~2900 lines, so it overflows the
// reviewer's diff budget, and three cycles running the review could not see
// whether a new module was wired in. Twice the answer was "yes" and once —
// earlier in this build — it was genuinely "no" (recovery buttons rendered
// with no click handlers). Prose did not settle it; a check in the suite does.
//
// This is a static check and it is deliberately the *supplementary* half. The
// primary evidence is a live negative control: block the module at the network
// layer in a real browser and watch the behaviour disappear. That is recorded
// in VERIFICATION_REPORT.md per module. What this adds is a regression guard —
// if someone deletes a call site, the suite fails immediately instead of a
// person noticing a dead button months later.
//
// The teeth are in W3: a module that exports a render/wire function and is not
// listed here fails, so a new module cannot be quietly left unwired.
//
// Known limit, stated rather than hidden: this catches a call site being
// DELETED, not one being disabled. `false && wireActions(...)` still contains
// the text and still passes here. Only the live negative control catches that,
// which is why the browser check is the primary evidence and this is the
// regression guard.
import fs from 'node:fs';
import { readdirSync } from 'node:fs';
import { check, section, done } from './world.mjs';

const pub = new URL('../public/', import.meta.url);
const html = fs.readFileSync(new URL('index.html', pub), 'utf8');
const read = (f) => fs.readFileSync(new URL(f, pub), 'utf8');

/**
 * Every module the page loads, what it must call, and the element it renders
 * into. `host` is the file that does the calling.
 */
const WIRING = [
  { mod: 'nav.js', host: 'index.html', calls: ['initNav'], mount: [] },
  { mod: 'acquisition.js', host: 'index.html', calls: ['renderShell', 'renderBody'], mount: ['view-acquisition', 'acqBody'] },
  { mod: 'client-workspace.js', host: 'index.html', calls: ['renderClientRevisions', 'revisionSummary', 'wireFixButtons'], mount: ['drawerIn'] },
  { mod: 'attention.js', host: 'index.html', calls: ['buildAttention', 'renderAttention', 'wireAttention'], mount: ['attention'] },
  { mod: 'automation.js', host: 'index.html', calls: ['renderAutomation', 'wireAutomation', 'headline'], mount: ['autoPanel'] },
  { mod: 'actions.js', host: 'index.html', calls: ['buildActions', 'renderActions', 'wireActions'], mount: ['primaryActions'] },
  { mod: 'focus.js', host: 'index.html', calls: ['handleModalTab', 'restoreFocus'], mount: ['drawer'] },
  { mod: 'optimisation.js', host: 'index.html', calls: ['renderOptimisation', 'wireOptimisation'], mount: ['optPanel'] },
  { mod: 'relationships.js', host: 'index.html', calls: ['renderRelationships', 'wireRelationships'], mount: ['relPanel'] },
  { mod: 'today.js', host: 'index.html', calls: ['renderBookings', 'renderWork', 'renderHealth', 'wireToday'], mount: ['todayBookings', 'todayWork', 'todayHealth'] },
  { mod: 'sms-inbox.js', host: 'index.html', calls: ['renderWaiting', 'renderConversation', 'renderSmsStats', 'wireSmsInbox'], mount: ['smsWaiting', 'smsConversation', 'smsStats'] },
  // The touch/keyboard route to chart detail. It creates its own tooltip
  // element on first use, so there is no mount point to assert — what matters
  // is that the page both initialises it AND re-scans after each redraw, since
  // the panels are rebuilt rather than patched.
  { mod: 'chart-touch.js', host: 'index.html', calls: ['initChartTouch', 'wireCharts'], mount: [] },
  // The trend readout and its ‹ › stepping. Its mount point is created by
  // siteCard() rather than living in the page, so there is no static id to
  // assert — what matters is that the page wires it on first render AND
  // re-wires a card that is replaced after a background audit.
  { mod: 'trend.js', host: 'index.html', calls: ['wireTrends', 'IWwireTrend'], mount: [] },
  // states.js is a library for the other modules, not for the page
  { mod: 'states.js', host: 'acquisition.js', calls: ['renderPanel', 'panelState'], mount: [] },
];

// ---------------------------------------------------------------------------
section('W1  every module the page loads is actually imported');
for (const w of WIRING) {
  const host = w.host === 'index.html' ? html : read(w.host);
  const imported = host.includes(`'/${w.mod}'`) || host.includes(`'./${w.mod}'`) || host.includes(`"./${w.mod}"`);
  check(`${w.host} imports ${w.mod}`, imported, w.host);
}

// ---------------------------------------------------------------------------
section('W2  and calls its entry points, not just imports it');
// An import with no call is exactly the failure this build hit: a module that
// exists, is tested, and never runs.
for (const w of WIRING) {
  const host = w.host === 'index.html' ? html : read(w.host);
  for (const fn of w.calls) {
    check(`${w.host} calls ${w.mod}:${fn}()`, new RegExp(`\\b${fn}\\s*\\(`).test(host), `${w.mod}.${fn}`);
  }
  for (const id of w.mount) {
    // the element may live in the page, or be created by the module's own shell
    const inPage = html.includes(`id="${id}"`);
    const inModule = read(w.mod).includes(`id="${id}"`);
    check(`${w.mod} has somewhere to render: #${id}`, inPage || inModule, `page=${inPage} module=${inModule}`);
  }
}

// ---------------------------------------------------------------------------
section('W3  a new module cannot be quietly left unwired');
const files = readdirSync(pub).filter((f) => f.endsWith('.js'));
const listed = new Set(WIRING.map((w) => w.mod));
for (const f of files) {
  const src = read(f);
  const exportsUi = /export\s+function\s+(render|wire|build|init)/.test(src);
  if (!exportsUi) continue;
  check(`${f} is listed in the wiring table`, listed.has(f),
    `${f} exports a render/wire/build/init function but no call site is asserted. Add it to WIRING or the page may never call it.`);
}
check('the table covers something real, not an empty list', WIRING.length >= 7, String(WIRING.length));
check('every listed module exists on disk', WIRING.every((w) => files.includes(w.mod) || w.mod === 'index.html'),
  WIRING.filter((w) => !files.includes(w.mod)).map((w) => w.mod).join(','));

// ---------------------------------------------------------------------------
section('W4  the modules the page loads are the ones that exist');
for (const m of html.matchAll(/import\('\/([a-z-]+\.js)'\)/g)) {
  check(`the page does not load a missing module: ${m[1]}`, files.includes(m[1]), m[1]);
}

// ---------------------------------------------------------------------------
section('W5  a module failing to load must not take the page with it');
// Each dynamic import carries a .catch, so a blocked or broken module leaves
// the rest of the dashboard usable rather than throwing during start-up.
// The window has to reach past the then-callback: an earlier version of this
// check stopped at the first `;`, which lands INSIDE `.then((m)=>{ X=m; })`
// and reported every guarded import as unguarded.
for (const m of html.matchAll(/import\('\/([a-z-]+\.js)'\)/g)) {
  const after = html.slice(m.index, m.index + 700);
  check(`loading ${m[1]} is guarded against failure`, /\.catch\(/.test(after), m[1]);
}

done();
