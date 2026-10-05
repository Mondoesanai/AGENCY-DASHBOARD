// Routine operation without the owner diagnosing things.
//
// Most of the machinery already existed — leases, backoff, dead letter, outage
// deferral, idempotency. What is tested here is the sweep over it and the two
// behaviours that were missing: escalating ONCE, and resuming work that was
// blocked by configuration after the configuration is supplied.
//
// And the boundary: this recovers WORKFLOWS. It does not repair code. A defect
// becomes a repair task with sanitised diagnostics and stops there.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import {
  diagnose, recover, escalateOnce, clearEscalation, resumeBlocked,
  openRepairTask, listRepairTasks, sanitise, SEVERITY, RE_ESCALATE_AFTER_MS,
} from '../lib/recovery.js';

const NOW = Date.UTC(2026, 9, 6, 12);

// ---------------------------------------------------------------------------
section('V1  it looks without changing anything');
const before = await diagnose({ now: NOW });
const after = await diagnose({ now: NOW });
check('diagnose answers', before.ok === true);
check('every finding names what is wrong', (before.findings || []).every((f) => f.what && f.what.length > 10));
check('and exactly ONE thing to do about it', (before.findings || []).every((f) => typeof f.action === 'string' && f.action.length > 10),
  JSON.stringify((before.findings || []).map((f) => f.action).slice(0, 2)));
check('findings carry a severity', (before.findings || []).every((f) => Object.values(SEVERITY).includes(f.severity)));
check('running it twice changes nothing', JSON.stringify(before.counts) === JSON.stringify(after.counts));
check('each finding has a stable id, so it can be deduplicated',
  (before.findings || []).every((f) => f.id && !/\d{10,}/.test(f.id)), JSON.stringify((before.findings || []).map((f) => f.id)));

// ---------------------------------------------------------------------------
section('V2  an issue is raised ONCE, not every sweep');
await store.set('recovery:escalated:test-issue', '').catch(() => {});
const sent = [];
const notify = async (t) => { sent.push(t); };
const f = { id: 'test-issue', severity: SEVERITY.STUCK, what: 'The daily pass has not run since Tuesday.', action: 'Check the Vercel cron is enabled.' };

let e = await escalateOnce(f, { now: NOW, notify });
check('the first time, it is raised', e.sent === true, JSON.stringify(e));
check('and the owner is told', sent.length === 1, String(sent.length));
check('the message carries what to do', /What to do: Check the Vercel cron/.test(sent[0]), sent[0]);

e = await escalateOnce(f, { now: NOW + 60e3, notify });
check('a minute later it is NOT raised again', e.sent === false, JSON.stringify(e));
e = await escalateOnce(f, { now: NOW + 6 * 3600e3, notify });
check('six hours later, still not', e.sent === false);
check('and nothing further was sent', sent.length === 1, String(sent.length));

e = await escalateOnce(f, { now: NOW + RE_ESCALATE_AFTER_MS + 1000, notify });
check('after the window, an unresolved issue is raised again', e.sent === true);
check('because silence forever is its own failure', sent.length === 2);

// a resolved issue may legitimately come back
await clearEscalation('test-issue');
e = await escalateOnce(f, { now: NOW + RE_ESCALATE_AFTER_MS + 2000, notify });
check('once cleared, a recurrence is raised immediately', e.sent === true, JSON.stringify(e));

// if we cannot tell whether it was raised, we do NOT raise it
const realGet = store.get;
store.get = async (k) => { if (String(k).startsWith('recovery:escalated:')) throw new Error('store down'); return realGet.call(store, k); };
e = await escalateOnce(f, { now: NOW, notify });
store.get = realGet;
check('an unreadable record does NOT produce a duplicate alert', e.sent === false, JSON.stringify(e));
check('and says why it held back', /could not read/i.test(e.reason), e.reason);

// ---------------------------------------------------------------------------
section('V3  work blocked by configuration resumes once it is supplied');
const { enqueue, fail, claim, getJob, JOB_STATE } = await import('../lib/jobs.js');
const blocked = await enqueue({ type: 'provider-enrol', payload: { campaignId: 'c1' }, maxAttempts: 2, runAt: NOW });
await claim({ worker: 'w', now: NOW, types: ['provider-enrol'] });
await fail(blocked.job.id, 'no email provider is connected', { now: NOW, permanent: true });
check('it is dead, correctly — retrying would not connect a provider',
  (await getJob(blocked.job.id)).state === JOB_STATE.DEAD, (await getJob(blocked.job.id)).state);

let r = await resumeBlocked({ env: {}, now: NOW });
check('with still nothing configured, nothing is resumed', r.resumed === 0, JSON.stringify(r));
check('and it says so rather than claiming success', /nothing has been configured/i.test(r.reason), r.reason);

r = await resumeBlocked({ env: { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'd.example' }, now: NOW });
check('once the provider IS connected, the job is replayed', r.resumed >= 1, JSON.stringify(r));
check('and it says what changed', /now connected/i.test(r.reason), r.reason);
const revived = await getJob(blocked.job.id);
check('the job is alive again', revived.state !== JOB_STATE.DEAD, revived.state);

// a job that died for a DIFFERENT reason is not resurrected
const other = await enqueue({ type: 'recheck-website', payload: { prospectId: 'p1' }, maxAttempts: 1, runAt: NOW });
await claim({ worker: 'w', now: NOW, types: ['recheck-website'] });
await fail(other.job.id, 'unknown prospect', { now: NOW, permanent: true });
await resumeBlocked({ env: { INSTANTLY_API_KEY: 'k', OUTREACH_FROM_DOMAIN: 'd.example' }, now: NOW });
check('a job that died for an unrelated reason stays dead',
  (await getJob(other.job.id)).state === JOB_STATE.DEAD, (await getJob(other.job.id)).state);

// ---------------------------------------------------------------------------
section('V4  it recovers workflows; it does NOT repair code');
const task = await openRepairTask({
  title: 'The revisions poller throws on a malformed subject line',
  diagnostics: 'TypeError at parseSubject\nkey sk-ant-abcdefghijklmnopqrstuvwxyz012345\nfrom owner@realclient.com\ncalled +1 214 555 0201',
  now: NOW,
});
check('a repair task is opened', task.ok === true && !!task.task.id, JSON.stringify(task).slice(0, 120));
check('it carries the title', /malformed subject/.test(task.task.title));
check('and states that a person decides', /person decides/i.test(task.task.note), task.task.note);

const d = task.task.diagnostics;
check('the credential is redacted', !/sk-ant-abcdef/.test(d), d);
check('the email address is redacted', !/owner@realclient\.com/.test(d), d);
check('the phone number is redacted', !/214\s*555\s*0201/.test(d), d);
check('but the actual error survives', /TypeError at parseSubject/.test(d), d);

check('sanitise catches a GitHub token', !/ghp_abc/.test(sanitise('ghp_abcdefghijklmnopqrstuvwxyz0123')));
check('and a Resend key', !/re_abc/.test(sanitise('re_abcdefghijklmnopqrstuvwx')));
check('and leaves ordinary prose alone', /the queue was empty/.test(sanitise('the queue was empty')));

const list = await listRepairTasks({});
check('the task is listed', list.ok === true && list.tasks.some((t) => t.id === task.task.id));
check('a repair task is never auto-applied — it only records', list.tasks.every((t) => t.state === 'open'));

// ---------------------------------------------------------------------------
section('V5  recover() acts, and reports exactly what it did');
const out = await recover({ now: NOW, notify: async () => {}, env: {} });
check('it runs', out.ok === true);
check('it reports its findings', Array.isArray(out.findings));
check('and the actions it took, by name', Array.isArray(out.actions));
check('every action says what it was', (out.actions || []).every((a) => typeof a.action === 'string'), JSON.stringify(out.actions));
check('nothing it did involved deploying or editing code',
  !(out.actions || []).some((a) => /deploy|commit|push|rewrite/i.test(a.action)), JSON.stringify(out.actions));

done();
