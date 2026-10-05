// Does the system heal itself when nobody is watching?
//
// recover() has existed for a while and was wired to exactly one caller: a
// button in the dashboard. So the self-healing sweep only ran while somebody
// was looking at it, which is the opposite of the point. Two real client
// requests died in the same week with every worker reporting green, and
// nothing swept for it because nothing was scheduled to.
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
const block = cron.slice(cron.indexOf('The self-healing sweep'), cron.indexOf('The self-healing sweep') + 1400);
check('it is inside a try/catch', /catch\s*\(/.test(block), block.slice(0, 80));
check('a failure is logged rather than thrown', /action:\s*'recovery',\s*error:/.test(block));
check('it respects the remaining time budget', /remaining\s*>\s*\d+/.test(block));
check('and says so when it skips', /skipped:\s*true/.test(block));

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
