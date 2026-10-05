// Does the system heal itself when nobody is watching?
//
// CORRECTION: an earlier version of this comment said recover() had only one
// caller, a button in the dashboard. That was wrong — .github/workflows/
// check-revisions.yml has been calling it every ~10 minutes all along. The
// real gaps were narrower and are what these checks cover:
//
//   - the sweep recorded NOTHING, so "is anything sweeping?" had no answer and
//     a stopped sweep was invisible. That workflow's own comments admit it:
//     "if GitHub Actions itself stops firing, nothing here notices."
//   - the daily pass is the floor beneath that workflow, and it ran the sweep
//     LAST, so the floor was dropped for lack of budget exactly during a long
//     outage — the one situation that makes a floor matter.
//
// The import inside the cron is dynamic, so a wrong path fails at RUN time in
// production, not at load time here — the first version of this wiring pointed
// at lib/notify.js, which does not exist. These checks resolve the modules for
// real rather than grepping for the text.
import fs from 'node:fs';
import { check, section, done } from './world.mjs';

const cron = fs.readFileSync(new URL('../api/cron-daily.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
section('H1  the daily pass runs the recovery sweep');
check('cron-daily calls recover()', /\brecover\s*\(/.test(cron));
check('and imports it from the recovery module', /import\(['"]\.\.\/lib\/recovery\.js['"]\)/.test(cron));
check('it passes a notifier, or nothing would ever be raised', /recover\(\s*\{\s*notify:/.test(cron));
check('the outcome is written into the run log', /action:\s*'recovery'/.test(cron));

// ---------------------------------------------------------------------------
section('H2  every module it reaches for actually exists');
// the real teeth: resolve them, do not pattern-match them
for (const spec of ['../lib/recovery.js', '../lib/sms.js']) {
  let mod = null, err = null;
  try { mod = await import(spec); } catch (e) { err = e; }
  check(`${spec} resolves`, !!mod, String(err?.message || '').slice(0, 120));
}
const { recover, diagnose, SEVERITY } = await import('../lib/recovery.js');
const { notifyOwner } = await import('../lib/sms.js');
check('recover is a function', typeof recover === 'function');
check('diagnose is a function', typeof diagnose === 'function');
check('notifyOwner is a function where the cron expects it', typeof notifyOwner === 'function');

// the exact dynamic specifiers the cron uses, pulled out and resolved
const specs = [...cron.matchAll(/await import\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
check('the cron uses dynamic imports', specs.length > 0, String(specs.length));
for (const s of specs.filter((s) => s.startsWith('../lib/'))) {
  let ok = true;
  try { await import(s); } catch { ok = false; }
  check(`cron dynamic import resolves: ${s}`, ok);
}

// ---------------------------------------------------------------------------
section('H3  the sweep is guarded so it cannot take the run down');
// both sweep call sites: the early one at the top and the ordinary one later
const early = cron.slice(cron.indexOf('the overdue self-healing sweep goes FIRST'), cron.indexOf('Health + billing'));
const late = cron.slice(cron.indexOf('The self-healing sweep, as a FLOOR'), cron.indexOf('real signal for'));
check('the early sweep is inside a try/catch', /catch\s*\(/.test(early));
check('and a failure there is logged, not thrown', /action:\s*'recovery-first',\s*error:/.test(early));
check('the later sweep is inside a try/catch', /catch\s*\(/.test(late));
check('a failure is logged rather than thrown', /action:\s*'recovery',\s*error:/.test(late));
check('it respects the remaining time budget', /remaining\s*>\s*\d+/.test(late));
check('and says so when it skips', /skipped:\s*true/.test(late));
check('skipping is only safe because another trigger is current',
  /10-minute trigger is current/.test(late), 'the reason must be stated, not assumed');

// ---------------------------------------------------------------------------
section('H4  it escalates the severities the new findings use');
// the client-silence findings are STUCK and CONFIG; if recover() ever stopped
// escalating those, the watchdog would go quiet without failing anything
const recoverySrc = fs.readFileSync(new URL('../lib/recovery.js', import.meta.url), 'utf8');
for (const sev of ['DEGRADED', 'STUCK', 'CONFIG']) {
  check(`${sev} findings are escalated`, new RegExp(`SEVERITY\\.${sev}`).test(recoverySrc.slice(recoverySrc.indexOf('3. Escalate'), recoverySrc.indexOf('3. Escalate') + 500)));
}
check('STUCK exists as a severity', !!SEVERITY.STUCK);
check('CONFIG exists as a severity', !!SEVERITY.CONFIG);

done();
