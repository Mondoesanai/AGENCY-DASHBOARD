// R2.4 — the Overview summarises what needs attention.
//
// The behaviour worth testing is not "does a list render". It is: does the
// right thing reach the top, does a problem stay visible until it is fixed,
// and — the one that matters most — does the page ever claim "nothing needs
// you" when it has not actually looked?
import { check, section, done } from './world.mjs';
import {
  buildAttention,
  attentionSummary,
  renderAttention,
  wireAttention,
  itemById,
  reportOverdue,
  needsPerson,
  PERSON_KINDS,
  KIND_RANK,
  SEVERITY as SEVERITY_ORDER,
  SHOW_FIRST,
  isSetup,
} from '../public/attention.js';

const NOW = new Date('2026-10-20T12:00:00Z').getTime();

const site = (over = {}) => ({
  slug: 'acme',
  name: 'Acme Roofing',
  url: 'https://acme.test',
  repo: 'Mondoesanai/acme',
  seoAgent: true,
  hasTracker: true,
  awaitingData: false,
  onTrial: false,
  billingDay: null,
  report: null,
  audit: { ok: true, scores: { seo: 90 } },
  stats: { hasData: true, deltas: { visitors: 5 } },
  ...over,
});
const ticket = (over = {}) => ({ slug: 'acme', state: 'queued', at: NOW, summary: 'change the phone number', ...over });
/** Everything loaded, nothing wrong — the baseline every check below moves off. */
const worker = (over = {}) => ({ id: 'tick', label: 'Site improvements', status: 'ok', text: 'Last ran 2 minutes ago.', lastAt: NOW - 120e3, ...over });
const healthyAutomation = () => ({
  pause: { known: true, paused: false, at: null, by: '', reason: '' },
  workers: [worker(), worker({ id: 'jobs', label: 'Outreach queue' })],
  worst: 'ok',
  anyUnknown: false,
  allOk: true,
});
/** R9.9 — read, and nothing wrong with it. */
const healthyDeliverability = () => ({
  stop: { known: true, stopped: false },
  result: { worst: 'ok', signals: [], totals: { delivered: 200, bounced: 0, complained: 0, unsubscribed: 0, known: true, days: 14 } },
});
const clean = (over = {}) => ({
  sites: [site()],
  portfolio: {},
  tickets: [],
  replies: [],
  automation: healthyAutomation(),
  deliverability: healthyDeliverability(),
  generatedAt: NOW - 60e3,
  now: NOW,
  ...over,
});

// ---------------------------------------------------------------------------
section('A1  silence has to be earned');
let r = buildAttention(clean());
check('a clean portfolio produces no items', r.items.length === 0, JSON.stringify(r.items));
check('and says so plainly', attentionSummary(r) === 'Nothing needs you right now.', attentionSummary(r));
check('allClear is true only when nothing was skipped', r.allClear === true);
check('it names what it looked at', r.checked.includes('change requests') && r.checked.includes('client sites'));

// the important one: a source that did not load must NOT read as all-clear
r = buildAttention({ sites: [site()], now: NOW });
check('a missing source is recorded, not assumed empty', r.notChecked.includes('change requests') && r.notChecked.includes('replies'), JSON.stringify(r.notChecked));
check('allClear is false when something was not checked', r.allClear === false);
check('the summary admits the gap instead of saying all clear', /did not load, so that part is unknown/.test(attentionSummary(r)), attentionSummary(r));
check('it does not say "nothing needs you right now"', attentionSummary(r) !== 'Nothing needs you right now.');

let html = renderAttention(r);
check('the rendered empty state says it is not a full all-clear', /not a full all-clear/.test(html), html);
check('and names the sources it could not check', /change requests, replies|replies and change requests|change requests and replies/.test(html), html);

// ---------------------------------------------------------------------------
section('A2  a stuck client request is the top of the list');
r = buildAttention(
  clean({
    tickets: [ticket({ state: 'blocked', blockedBy: { action: 'link-repo', label: 'Link this site’s GitHub repository' } })],
    sites: [site({ stats: { hasData: true, deltas: { visitors: -40 } } })],
  })
);
check('both the stuck request and the traffic fall are listed', r.items.length === 2, JSON.stringify(r.items.map((i) => i.kind)));
check('the thing needing a person ranks above the thing to watch', r.items[0].kind === 'request-stuck', r.items[0].kind);
check('it uses the client\'s name, not their slug', /Acme Roofing/.test(r.items[0].title), r.items[0].title);
check('it carries the recovery label from the state machine', /Link this site’s GitHub repository/.test(r.items[0].detail));
check('and reassures that the work is not lost', /resumes by itself/.test(r.items[0].detail));
check('the action goes to that client\'s requests', r.items[0].action.slug === 'acme' && r.items[0].action.pane === 'revisions', JSON.stringify(r.items[0].action));
check('a falling-traffic item states the real number', /down 40%/.test(r.items[1].title), r.items[1].title);

// a request still retrying is information, not an emergency
r = buildAttention(clean({ tickets: [ticket({ state: 'retryable', attempts: 4 })] }));
check('a retrying request is only "worth a look"', r.items[0].severity === 'watch', JSON.stringify(r.items[0]));
check('and says the machine is still on it', /still retrying on its own/.test(r.items[0].detail));
r = buildAttention(clean({ tickets: [ticket({ state: 'retryable', attempts: 1 })] }));
check('one failure is not worth the owner\'s attention yet', r.items.length === 0);

// ---------------------------------------------------------------------------
section('A3  causes are surfaced, not just symptoms');
r = buildAttention(clean({ sites: [site({ repo: '' })] }));
check('automation on with no repo is flagged before anything gets stuck', r.items[0].kind === 'no-repo', JSON.stringify(r.items));
check('it explains the consequence', /Any request that arrives will queue and wait/.test(r.items[0].detail));
r = buildAttention(clean({ sites: [site({ repo: '', seoAgent: false })] }));
check('a client with automation deliberately off is not nagged', r.items.length === 0, JSON.stringify(r.items));

r = buildAttention(clean({ sites: [site({ hasTracker: false })] }));
check('a silent tracker is reported', r.items[0].kind === 'no-tracker');
check('and explains that blank is not zero', /blank because nothing is being measured, not because they are zero/.test(r.items[0].detail));
r = buildAttention(clean({ sites: [site({ hasTracker: false, awaitingData: true })] }));
check('a brand-new site awaiting its first visit is not a fault', r.items.length === 0);

// quota and a dead site are different problems with different fixes
r = buildAttention(clean({ sites: [site({ audit: { ok: false, pending: false, error: 'daily quota exceeded' } })] }));
check('a rate-limited check is information', r.items[0].severity === 'info' && r.items[0].kind === 'audit-quota');
check('and names the key that removes it', /PAGESPEED_API_KEY/.test(r.items[0].detail));
r = buildAttention(clean({ sites: [site({ audit: { ok: false, pending: false, error: 'ECONNREFUSED' } })] }));
check('a failing check is worth a look', r.items[0].severity === 'watch' && r.items[0].kind === 'audit-failed');
check('and repeats the real error', /ECONNREFUSED/.test(r.items[0].detail));
r = buildAttention(clean({ sites: [site({ audit: { ok: false, pending: true } })] }));
check('an audit that has simply not run yet is not a fault', r.items.length === 0);

// ---------------------------------------------------------------------------
section('A4  money-shaped things the owner must not miss');
// the 20th, billing day the 1st, newest report from September
r = buildAttention(clean({ sites: [site({ billingDay: 1, report: { month: '2026-09' } })] }));
check('an overdue report needs the owner', r.items[0].kind === 'report-overdue' && r.items[0].severity === 'act', JSON.stringify(r.items));
check('it says which month is missing and when billing was', /1st/.test(r.items[0].detail) && /2026-09/.test(r.items[0].detail), r.items[0].detail);
r = buildAttention(clean({ sites: [site({ billingDay: 1, report: { month: '2026-10' } })] }));
check('this month\'s report present means nothing to do', r.items.length === 0);
r = buildAttention(clean({ sites: [site({ billingDay: 25, report: { month: '2026-09' } })] }));
check('a billing day still to come is not overdue', r.items.length === 0);
check('reportOverdue refuses to guess without a billing day', reportOverdue(site({ billingDay: null }), NOW) === false);
check('reportOverdue refuses to guess from an unparseable month', reportOverdue(site({ billingDay: 1, report: { month: 'October' } }), NOW) === false);

r = buildAttention(clean({ sites: [site({ onTrial: true, trialDaysLeft: 2 })] }));
check('a trial about to end needs the owner', r.items[0].kind === 'trial-ending' && r.items[0].severity === 'act');
check('and states that nothing happens by itself', /Nothing happens automatically/.test(r.items[0].detail));
r = buildAttention(clean({ sites: [site({ onTrial: true, trialDaysLeft: 0 })] }));
check('an ended trial reads as ended, not as "in 0 days"', /the trial has ended/.test(r.items[0].title), r.items[0].title);
r = buildAttention(clean({ sites: [site({ onTrial: true, trialDaysLeft: 14 })] }));
check('a trial with time left is not nagged about', r.items.length === 0);

// ---------------------------------------------------------------------------
section('A5  replies held for a person');
r = buildAttention(clean({ replies: [{ kind: 'interested' }, { kind: 'wants-call' }, { kind: 'opt-out' }] }));
check('held replies are one item with a count, not three rows', r.items.length === 1 && r.items[0].count === 2, JSON.stringify(r.items));
check('it needs the owner', r.items[0].severity === 'act');
check('and says the hold was deliberate', /held back on purpose/.test(r.items[0].detail));
check('it points at the inbox', r.items[0].action.view === 'acquisition' && r.items[0].action.tab === 'inbox');

// one the owner has already dealt with must stop asking
r = buildAttention(clean({ replies: [{ kind: 'interested', handled: true }] }));
check('a reply already handled is not still demanding attention', r.items.length === 0, JSON.stringify(r.items));
check('an auto-reply or bounce never asks for a person', !needsPerson({ kind: 'auto-reply' }) && !needsPerson({ kind: 'bounce' }));
check('a null reply does not throw', needsPerson(null) === false);

// The browser module cannot import the server's NOTIFY_KINDS, so pin them:
// if lib/replies.js starts holding a new kind for a person, this fails rather
// than letting that kind vanish from the Overview.
const { NOTIFY_KINDS } = await import('../lib/replies.js');
check('every kind the server holds for a person is one the Overview surfaces',
  [...NOTIFY_KINDS].every((k) => PERSON_KINDS.includes(k)),
  `server=${[...NOTIFY_KINDS].join(',')} overview=${PERSON_KINDS.join(',')}`);
check('and the Overview invents none of its own',
  PERSON_KINDS.every((k) => NOTIFY_KINDS.has(k)),
  PERSON_KINDS.filter((k) => !NOTIFY_KINDS.has(k)).join(','));

// ---------------------------------------------------------------------------
section('A6  stale figures are declared');
r = buildAttention(clean({ generatedAt: NOW - 9 * 3600e3 }));
check('old figures are called old', r.items[0].kind === 'stale', JSON.stringify(r.items));
check('with the real age', /9 hours old/.test(r.items[0].title), r.items[0].title);
check('it is only information', r.items[0].severity === 'info');
r = buildAttention(clean({ generatedAt: NOW - 60e3 }));
check('fresh figures say nothing', r.items.length === 0);

// ---------------------------------------------------------------------------
section('A6b  order inside a severity is decided, not alphabetical');
// All four "needs you": a stuck client request must beat a prospect reply, and
// a cause must beat the symptom it will cause.
r = buildAttention(
  clean({
    sites: [site({ slug: 'zeta', name: 'Zeta Plumbing', repo: '', billingDay: 1, report: { month: '2026-09' } })],
    tickets: [ticket({ slug: 'zeta', state: 'blocked', blockedBy: { action: 'link-repo', label: 'Link it' } })],
    replies: [{ kind: 'interested' }],
  })
);
check('four things need the owner', r.counts.act === 4, JSON.stringify(r.items.map((i) => i.kind)));
check('the client waiting on work comes first', r.items[0].kind === 'request-stuck', r.items[0].kind);
check('the cause of future sticking comes next', r.items[1].kind === 'no-repo', r.items[1].kind);
check('then the report a client is expecting', r.items[2].kind === 'report-overdue', r.items[2].kind);
check('chasing new business comes last of the four', r.items[3].kind === 'reply-waiting', r.items[3].kind);

// The two orderings — severity and kind — must not be able to disagree. Every
// kind the builder can emit needs a rank, and no "worth a look" kind may be
// ranked above something that needs a person, or a new kind would quietly
// out-rank a stuck client request.
const everyKind = buildAttention({
  now: NOW,
  generatedAt: NOW - 9 * 3600e3,
  replies: [{ kind: 'interested' }],
  tickets: [
    ticket({ state: 'blocked', blockedBy: { action: 'link-repo', label: 'Link it' } }),
    ticket({ slug: 'b', state: 'retryable', attempts: 4 }),
  ],
  sites: [
    site({ slug: 'a', repo: '', billingDay: 1, report: { month: '2026-09' }, onTrial: true, trialDaysLeft: 1 }),
    site({ slug: 'b', name: 'B', hasTracker: false, audit: { ok: false, pending: false, error: 'boom' }, stats: { hasData: true, deltas: { visitors: -30 } } }),
    site({ slug: 'c', name: 'C', audit: { ok: false, pending: false, error: 'quota exceeded' } }),
  ],
}).items;
const kinds = [...new Set(everyKind.map((i) => i.kind))];
check('the fixture really exercises every kind', kinds.length === 11, `${kinds.length}: ${kinds.join(',')}`);
check('every kind that can be emitted has a rank', kinds.every((k) => k in KIND_RANK), kinds.filter((k) => !(k in KIND_RANK)).join(','));
const worstRank = (sev) => Math.max(...everyKind.filter((i) => i.severity === sev).map((i) => KIND_RANK[i.kind]));
const bestRank = (sev) => Math.min(...everyKind.filter((i) => i.severity === sev).map((i) => KIND_RANK[i.kind]));
check('no "worth a look" kind outranks one that needs you', worstRank('act') < bestRank('watch'), `${worstRank('act')} vs ${bestRank('watch')}`);
check('no "for information" kind outranks one worth a look', worstRank('watch') < bestRank('info'), `${worstRank('watch')} vs ${bestRank('info')}`);
check('and the rendered order is severity-descending throughout',
  everyKind.every((it, i, all) => i === 0 || SEVERITY_ORDER[all[i - 1].severity] <= SEVERITY_ORDER[it.severity]),
  everyKind.map((i) => `${i.severity}:${i.kind}`).join(' > '));

// ---------------------------------------------------------------------------
section('A7  the overview stays an overview');
// R16.12 — the cap applies to WORK. These eleven are all `no-repo`, which is
// one-off plumbing, so they belong in the setup block; an earlier version of
// this test used them to check the cap and started counting setup rows too.
const many = Array.from({ length: 11 }, (_, i) => site({ slug: `c${i}`, name: `Client ${i}`, repo: '' }));
r = buildAttention(clean({ sites: many }));
check('all of them are counted', r.items.length === 11, String(r.items.length));
html = renderAttention(r);
check('all eleven are setup items, not daily work', r.items.every(isSetup), r.items.map((i) => i.kind).join(','));
check('so they are grouped as things to set up', /11 things still to set up/.test(html), html.slice(0, 400));
check('and the day reads as clear, rather than as eleven emergencies',
  /Nothing needs you right now/.test(html), html.slice(0, 400));
check('the header counts them as setup, not as eleven things needing you',
  /Nothing needs you right now · 11 still to set up/.test(html), html.slice(0, 260));
check('so the headline never names a count the reader cannot see',
  !/11 need you/.test(html),
  'the first version said "11 need you" while all eleven sat folded away in the setup block');
check('nothing is hidden — every one is still rendered',
  (html.match(/class="attn-item/g) || []).length === 11, String((html.match(/class="attn-item/g) || []).length));

section('A7b  and real work IS capped');
// Overdue reports are the daily job, not plumbing.
const overdue = Array.from({ length: 11 }, (_, i) => site({
  slug: `w${i}`, name: `Client ${i}`, billingDay: 1, report: { month: '2020-01' },
}));
const rw = buildAttention(clean({ sites: overdue, now: Date.parse('2026-10-20T12:00:00Z') }));
check('all eleven are real work', rw.items.length === 11 && !rw.items.some(isSetup),
  rw.items.map((i) => i.kind).join(','));
const workHtml = renderAttention(rw);
check(`only ${SHOW_FIRST} are shown at once`, (workHtml.match(/class="attn-item/g) || []).length === SHOW_FIRST,
  String((workHtml.match(/class="attn-item/g) || []).length));
check('the rest are offered, not hidden', /Show 5 more/.test(workHtml), workHtml.slice(-300));
check('and no setup block appears when there is no plumbing', !/still to set up/.test(workHtml));

// only the things needing a person get a loud button
html = renderAttention(buildAttention(clean({ sites: [site({ repo: '' }), site({ slug: 'b', name: 'B', hasTracker: false })] })));
check('an item needing you has the primary button', /class="btn sm attn-go"/.test(html), html);
check('a "worth a look" item is quieter', /class="btn sm ghost attn-go"/.test(html), html);
check('severity is carried in words, not only colour', /needs you<\/span>/.test(html) && /worth a look<\/span>/.test(html));
html = renderAttention(r, { expanded: true });
check('expanding shows them all', (html.match(/class="attn-item/g) || []).length === 11);

// ---------------------------------------------------------------------------
section('A8  loading, error and all-clear are three different screens');
html = renderAttention(buildAttention(clean()), { loading: true });
check('loading says it is still checking', /Checking what needs you/.test(html));
check('loading does not claim all clear', !/Nothing needs you right now/.test(html));
html = renderAttention(buildAttention(clean()), { error: 'the feed did not answer' });
check('an error says what failed', /the feed did not answer/.test(html));
check('and refuses to be read as an all-clear', /not an all-clear/.test(html), html);
html = renderAttention(buildAttention(clean()));
check('a true all-clear says what it checked', /Nothing needs you right now/.test(html) && /Checked:/.test(html), html);

// ---------------------------------------------------------------------------
section('A9  nothing in here can be hidden');
// The old banner wrote the dismissed set into localStorage under a key built
// from the slugs in it, so the same real problems never came back. Checked by
// behaviour: render the problem, then render it again, and look at what the
// markup actually offers the owner.
html = renderAttention(buildAttention(clean({ sites: [site({ repo: '' })] })));
check('the rendered block offers no way to dismiss an item', !/dismiss|data-ack|ackBtn/i.test(html), html.slice(0, 400));

const a = buildAttention(clean({ sites: [site({ repo: '' })] }));
const b = buildAttention(clean({ sites: [site({ repo: '' })] }));
check('a problem reported once is reported again', a.items.length === 1 && b.items.length === 1);
check('with a stable id so the UI can act on it', a.items[0].id === b.items[0].id && a.items[0].id === 'no-repo:acme', a.items[0].id);
// nothing is carried between calls: fixing the cause is the only way out
const fixed = buildAttention(clean({ sites: [site({ repo: 'Mondoesanai/acme' })] }));
check('and it leaves only when the cause is fixed', fixed.items.length === 0, JSON.stringify(fixed.items));

// ---------------------------------------------------------------------------
section('A10  the buttons are wired (the same mistake, not made twice)');
const spy = () => { const calls = []; const f = (...x) => calls.push(x); f.calls = calls; return f; };
function fakeRoot() {
  const ls = [];
  return {
    ls,
    addEventListener: (t, fn) => ls.push([t, fn]),
    click(target) {
      const ev = { target };
      ls.filter(([t]) => t === 'click').forEach(([, fn]) => fn(ev));
    },
  };
}
const target = (sel, el) => ({ closest: (s) => (s === sel ? el : null) });

r = buildAttention(clean({ sites: [site({ repo: '' })] }));
let root = fakeRoot();
const go = spy();
const expand = spy();
check('wiring reports success', wireAttention(root, r, { go, expand }) === true);
check('one delegated listener', root.ls.length === 1);
root.click(target('[data-attn]', { dataset: { attn: 'no-repo:acme' } }));
check('clicking an item hands over its action', go.calls[0]?.[0]?.slug === 'acme', JSON.stringify(go.calls));
check('and the item itself', go.calls[0]?.[1]?.kind === 'no-repo');
check('the action names the pane that fixes it', go.calls[0]?.[0]?.pane === 'settings');
root.click(target('.attn-more', {}));
check('"show more" expands instead of navigating', expand.calls.length === 1 && go.calls.length === 1);
root.click(target('[data-attn]', { dataset: { attn: 'no-such-item' } }));
check('an id with no item does nothing rather than throwing', go.calls.length === 1);
check('itemById finds a real one', itemById(r, 'no-repo:acme')?.kind === 'no-repo');
check('and returns null for a stranger', itemById(r, 'nope') === null);

// ---------------------------------------------------------------------------
section('A12  a stopped worker is the first thing the owner sees (R2.6)');
r = buildAttention(
  clean({
    tickets: [ticket({ state: 'blocked', blockedBy: { action: 'link-repo', label: 'Link it' } })],
    automation: { ...healthyAutomation(), allOk: false, workers: [worker({ status: 'stalled', text: 'Last ran 2 days ago — well past its schedule.' })] },
  })
);
check('a stalled worker is listed', r.items.some((i) => i.kind === 'automation-stalled'), JSON.stringify(r.items.map((i) => i.kind)));
check('it needs the owner', r.items[0].severity === 'act');
check('and outranks even a stuck client request', r.items[0].kind === 'automation-stalled', r.items[0].kind);
check('because nothing else can resolve while it is down', /Nothing it does is happening/.test(r.items[0].detail));
check('it carries the real silence, not a schedule', /2 days ago/.test(r.items[0].detail));

r = buildAttention(clean({ automation: { ...healthyAutomation(), allOk: false, workers: [worker({ status: 'never', label: 'Outreach queue', text: 'Has never checked in.' })] } }));
check('a worker that has never run is also flagged', r.items[0].kind === 'automation-stalled' && /never run/.test(r.items[0].title), r.items[0].title);

r = buildAttention(clean({ automation: { ...healthyAutomation(), allOk: false, workers: [worker({ status: 'slow' })] } }));
check('merely slow is not worth interrupting the owner', r.items.length === 0, JSON.stringify(r.items));

r = buildAttention(clean({ automation: { ...healthyAutomation(), pause: { known: true, paused: true, by: 'owner', at: NOW - 3600e3, reason: '' } } }));
check('a pause is reported so it is not forgotten', r.items[0].kind === 'automation-paused', JSON.stringify(r.items));
check('but as a thing to look at, not an emergency', r.items[0].severity === 'watch');
check('and says queued work is waiting, not lost', /waiting, not lost/.test(r.items[0].detail));
check('a paused automation does not also report its workers as stalled', r.items.filter((i) => i.kind === 'automation-stalled').length === 0);

r = buildAttention({ sites: [site()], tickets: [], replies: [], now: NOW });
check('automation not loaded is listed as unchecked, not assumed healthy', r.notChecked.includes('automation'), JSON.stringify(r.notChecked));
check('and that blocks the all-clear', r.allClear === false);

// ---------------------------------------------------------------------------
section('A10b  outreach stopping itself (R9.9)');
// This is the one item here the owner cannot find out any other way: nothing
// errors and nothing looks broken, messages simply stop going out.
r = buildAttention(clean({
  deliverability: {
    stop: { known: true, stopped: true, by: 'automatic', reason: 'hard bounces: 90 of 300 in the last 14 days (30.0%). What to do: check where these addresses came from.' },
    result: { worst: 'pause', signals: [], totals: {} },
  },
}));
let d = r.items.find((i) => i.kind === 'deliverability-stopped');
check('a self-stop is raised', !!d, JSON.stringify(r.items.map((i) => i.kind)));
check('as something to act on', !!d && d.severity === 'act');
check('it carries the numbers that stopped it', !!d && /90 of 300/.test(d.detail), d && d.detail);
check('and what to do about it', !!d && /where these addresses came from/.test(d.detail));
check('it says client work is unaffected', !!d && /Client site work is unaffected/.test(d.detail));
check('and that nothing will restart it for them', !!d && /until you start it again/.test(d.detail));
check('it blocks the all-clear', r.allClear === false);

// it ranks below a paying client's stuck work and above chasing new business
r = buildAttention(clean({
  tickets: [ticket({ state: 'blocked', needsOwner: true })],
  replies: [{ id: 'r1', from: 'a@b.com', subject: 'yes', kind: 'interested', needsOwner: true, at: NOW - 3600e3 }],
  deliverability: { stop: { known: true, stopped: true, reason: 'bad' }, result: { worst: 'pause', signals: [] } },
}));
const actKinds = r.items.filter((i) => i.severity === 'act').map((i) => i.kind);
check("a stuck client request still comes first", actKinds.indexOf('request-stuck') < actKinds.indexOf("deliverability-stopped"), JSON.stringify(actKinds));
check("and the self-stop comes before a waiting reply", actKinds.indexOf("deliverability-stopped") < actKinds.indexOf("reply-waiting"), JSON.stringify(actKinds));

// unreadable is not fine
r = buildAttention(clean({ deliverability: { stop: { known: false, stopped: false }, result: { worst: 'unknown', signals: [] } } }));
d = r.items.find((i) => i.kind === 'deliverability-unknown');
check('an unreadable stop flag is raised', !!d, JSON.stringify(r.items.map((i) => i.kind)));
check('and says it is not the same as fine', !!d && /not the same as sending being fine/.test(d.detail));
check('it is not raised as an emergency', !!d && d.severity === 'watch');

// a warning is a warning, not a stop
r = buildAttention(clean({
  deliverability: {
    stop: { known: true, stopped: false },
    result: { worst: 'warn', signals: [{ level: 'warn', reason: 'hard bounces: 2 of 25 (8.0%)' }] },
  },
}));
d = r.items.find((i) => i.kind === 'deliverability-warn');
check('a warning is raised', !!d);
check('as something to watch, not act on', !!d && d.severity === 'watch');
check('and says nothing has been stopped', !!d && /Nothing has been stopped/.test(d.detail), d && d.detail);
check('a healthy deliverability raises nothing', buildAttention(clean()).items.filter((i) => /^deliverability/.test(i.kind)).length === 0);

r = buildAttention({ sites: [site()], tickets: [], replies: [], automation: healthyAutomation(), now: NOW });
check('deliverability not loaded is listed as unchecked, not assumed fine', r.notChecked.includes('deliverability'), JSON.stringify(r.notChecked));
check('and that blocks the all-clear too', r.allClear === false);

// ---------------------------------------------------------------------------
section('A11  client-supplied text cannot inject');
r = buildAttention(clean({ sites: [site({ name: '<img src=x onerror=alert(1)>', repo: '' })] }));
html = renderAttention(r);
check('a hostile client name is escaped', !/<img src=x/.test(html) && /&lt;img/.test(html), html.slice(0, 240));
r = buildAttention(
  clean({ tickets: [ticket({ state: 'blocked', blockedBy: { label: '<script>bad()</script>', action: 'check-repo' } })] })
);
check('a hostile blocked label is escaped', !/<script>bad/.test(renderAttention(r)));

done();
