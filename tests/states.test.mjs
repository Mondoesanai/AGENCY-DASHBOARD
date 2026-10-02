// R2.5 — loading, empty, error, disconnected, success, recovery.
// R8.8 — the budget shown honestly: two windows over the same money.
//
// The defect under test is specific and it was everywhere: a panel fetches a
// list, the request fails, and the panel renders "No contacts yet." Empty and
// broken looked identical, so the dashboard told the owner something false in
// a calm voice. Every check below is a variation on "can this screen still do
// that?"
import { check, section, done } from './world.mjs';
import { classify, renderPanel, renderSuccess, renderRecovery, PANEL } from '../public/states.js';
import {
  panelState,
  renderContacts,
  renderInbox,
  renderCampaigns,
  renderProspects,
  renderAcqSettings,
  renderBudget,
  resetWords,
} from '../public/acquisition.js';
import { renderClientRevisions } from '../public/client-workspace.js';

// ---------------------------------------------------------------------------
section('S1  a failed fetch is not an empty list');
check('a response that never came is an error', classify(null).status === PANEL.ERROR);
check('and says the server did not answer', /did not answer/.test(classify(null).error));
check('a refusal is an error, not emptiness', classify({ ok: false, error: 'boom' }, { key: 'rows' }).status === PANEL.ERROR);
check('the real reason is carried through', classify({ ok: false, error: 'boom' }).error === 'boom');
check('a refusal with no reason still says something', /no reason/.test(classify({ ok: false }).error));
check('a password refusal is its own state', classify({ ok: false, error: 'locked' }).status === PANEL.LOCKED);
check('a 401 is recognised too', classify({ ok: false, error: 'unauthorized (401)' }).status === PANEL.LOCKED);
check('undefined means still loading, not empty', classify(undefined).status === PANEL.LOADING);

check('a success with an empty list is genuinely empty', classify({ ok: true, rows: [] }, { key: 'rows' }).status === PANEL.EMPTY);
check('a success with rows is ready', classify({ ok: true, rows: [1] }, { key: 'rows' }).status === PANEL.READY);
check('and the rows come through', classify({ ok: true, rows: [1, 2] }, { key: 'rows' }).items.length === 2);
// the quiet one: a 200 that simply does not contain the field
check('a 200 missing the field is an error, not "none yet"', classify({ ok: true }, { key: 'rows' }).status === PANEL.ERROR, JSON.stringify(classify({ ok: true }, { key: 'rows' })));
check('and says what was missing', /had no rows/.test(classify({ ok: true }, { key: 'rows' }).error));
check('an unconfigured integration is disconnected, not empty', classify({ ok: true, configured: false, rows: [] }, { key: 'rows' }).status === PANEL.DISCONNECTED);

// ---------------------------------------------------------------------------
section('S2  each state says a different thing, and none of them reassure wrongly');
let h = renderPanel({ status: PANEL.LOADING }, { thing: 'contacts' });
check('loading says it is loading', /Loading contacts/.test(h));
check('loading does not claim there are none', !/No contacts/.test(h));

h = renderPanel({ status: PANEL.ERROR, error: 'the database refused' }, { thing: 'contacts' });
check('an error names what failed', /the database refused/.test(h));
check('and states it is not an empty list', /not an empty list/.test(h), h);
check('and that the contents are unknown', /unknown/.test(h));
check('and offers a way to retry', /data-retry="contacts"/.test(h));

h = renderPanel({ status: PANEL.DISCONNECTED }, { thing: 'replies' });
check('disconnected says nothing is watching', /Nothing is watching for replies/.test(h));
check('and that nothing was missed', /none have been missed/.test(h));
check('it does not say there are none', !/No replies yet/.test(h));

h = renderPanel({ status: PANEL.EMPTY }, { thing: 'replies' });
check('empty says none have arrived', /none have arrived/.test(h));
check('and that nothing was lost', /not that any were lost/.test(h));

h = renderPanel({ status: PANEL.LOCKED }, { thing: 'contacts' });
check('locked says it was not allowed to load', /not been allowed to load/.test(h));
check('and that nothing is missing', /Nothing is missing/.test(h));

check('ready renders nothing, so the caller draws the real thing', renderPanel({ status: PANEL.READY }, { thing: 'x' }) === null);

// ---------------------------------------------------------------------------
section('S3  success says what happened, not "done"');
h = renderSuccess('Imported 14 contacts.', '3 were already known and were skipped.');
check('it states the real outcome', /Imported 14 contacts/.test(h));
check('including what did not happen', /3 were already known/.test(h));
check('and is announced to a screen reader', /role="status"/.test(h));

// ---------------------------------------------------------------------------
section('S4  recovery (R1.5) has one implementation');
h = renderRecovery({ label: 'Link this site’s repository', hint: 'It resumes once linked.', action: 'link-repo', slug: 'acme', actionLabel: 'Link a repository' });
check('the action is in words the owner can act on', /Link this site’s repository/.test(h));
check('with the explanation', /resumes once linked/.test(h));
check('and a button carrying the action and the client', /data-fix="link-repo"/.test(h) && /data-slug="acme"/.test(h));
check('nothing to recover renders nothing', renderRecovery({}) === '');
h = renderRecovery({ label: '<script>bad()</script>', action: 'check-repo' });
check('a hostile label is escaped', !/<script>bad/.test(h) && /&lt;script/.test(h));
// the per-client list must use that one implementation, so the two cannot drift
const viaWorkspace = renderClientRevisions({
  slug: 'acme',
  tickets: [{ slug: 'acme', state: 'blocked', at: 1, summary: 's', blockedBy: { action: 'link-repo', label: 'L', hint: 'H' } }],
});
check('the client card renders recovery through the same markup', /data-fix="link-repo"/.test(viaWorkspace) && /data-slug="acme"/.test(viaWorkspace));

// ---------------------------------------------------------------------------
section('S5  the acquisition panels can no longer fake an empty list');
const failed = { load: { contacts: { error: 'the request did not reach the server' } } };
h = renderContacts({ ...failed, contacts: [] });
check('a failed contacts load says it could not load them', /Could not load contacts/.test(h), h.slice(0, 160));
check('and does NOT say "No contacts yet"', !/No contacts yet/.test(h));
check('and does not read as an all-clear', /not an empty list/.test(h));

h = renderContacts({ contacts: [] });
check('a genuine empty still explains what fills it', /No contacts yet/.test(h) && /Add contacts/.test(h));

h = renderInbox({ load: { inbox: { error: 'boom' } }, replies: [] });
check('a failed replies load says so', /Could not load replies/.test(h));
check('and does not claim no replies', !/No replies yet/.test(h));
h = renderInbox({ replies: [] });
check('a genuine empty inbox still explains itself', /No replies yet/.test(h));

h = renderCampaigns({ load: { campaigns: { error: 'boom' } }, campaigns: [] });
check('a failed campaigns load says so', /Could not load campaigns/.test(h));
check('and does not claim no campaigns', !/No campaigns yet/.test(h));

h = renderProspects({ load: { prospects: { error: 'boom' } }, prospects: [] });
check('a failed prospects load says so', /Could not load prospects/.test(h));
check('and does not claim nothing was searched', !/Nothing searched yet/.test(h));
h = renderProspects({ prospects: [] });
check('a genuine empty prospects list keeps the way out of being empty', /acqDiscoverBtn/.test(h) && /Nothing searched yet/.test(h));

// The case that actually distinguishes the early return: rows are still in
// memory from a previous good load, and the refresh just failed. Showing the
// old rows with no warning presents stale data as current.
h = renderInbox({ load: { inbox: { error: 'boom' } }, replies: [{ id: 'r1', kind: 'interested', text: 'call me', at: 1 }] });
check('a failed refresh does not quietly show the previous replies', /Could not load replies/.test(h), h.slice(0, 160));
check('and the stale row is not rendered as current', !/call me/.test(h));
h = renderContacts({ load: { contacts: { error: 'boom' } }, contacts: [{ id: 'c1', name: 'Old Row' }] });
check('the same for contacts', /Could not load contacts/.test(h) && !/Old Row/.test(h));
h = renderCampaigns({ load: { campaigns: { error: 'boom' } }, campaigns: [{ id: 'k1', name: 'Old Campaign' }] });
check('and campaigns', /Could not load campaigns/.test(h) && !/Old Campaign/.test(h));
h = renderProspects({ load: { prospects: { error: 'boom' } }, prospects: [{ id: 'p1', name: 'Old Prospect' }] });
check('and prospects', /Could not load prospects/.test(h) && !/Old Prospect/.test(h));

h = renderAcqSettings({ load: { settings: { error: 'boom' } } });
check('settings that failed stop pretending to load', /Could not load settings/.test(h), h.slice(0, 140));
check('settings still loading say so', /Loading settings/.test(renderAcqSettings({})));

// a locked panel is told apart from a broken one
h = renderContacts({ load: { contacts: { error: 'locked' } }, contacts: [] });
check('a locked panel says to enter the password', /Enter your password/.test(h), h.slice(0, 140));
check('and is not reported as a failure', !/Could not load/.test(h));

// ---------------------------------------------------------------------------
section('S5b  the sending gate never says "live" when it does not know');
// The most consequential sentence in the app. An unanswered readiness check
// used to fall through to "Sending is live."
h = renderCampaigns({ campaigns: [{ id: 'k', name: 'K', type: 'cold-weak-site', status: 'draft', cadence: { followUps: 2, gapDays: 4 }, counts: {} }] });
check('with no readiness answer it does not claim sending is live', !/Sending is live/.test(h), h.slice(0, 200));
check('it says the state is not known', /is not known right now/.test(h));
check('and explicitly that this is not a green light', /not a green light/.test(h));
check('and that nothing goes out regardless', /refused server-side/.test(h));
h = renderCampaigns({ campaigns: [{ id: 'k', name: 'K', type: 'cold-weak-site', status: 'draft', cadence: { followUps: 2, gapDays: 4 }, counts: {} }], readiness: { ready: true, blockers: [], provider: 'instantly', connected: true } });
check('a real pass does say sending is live', /Sending is live/.test(h));
h = renderCampaigns({ campaigns: [{ id: 'k', name: 'K', type: 'cold-weak-site', status: 'draft', cadence: { followUps: 2, gapDays: 4 }, counts: {} }], readiness: { ready: false, blockers: [{ text: 'no account' }], provider: 'instantly', connected: false } });
check('a real failure lists the blockers', /Nothing can be sent yet/.test(h) && /no account/.test(h));

h = renderAcqSettings({ settings: { pricing: { configured: false, includes: [] }, targeting: { status: 'draft', source: 's', geography: { label: 'DFW' }, weeklyVolume: 5, exclusions: { minYearsInBusiness: 3 }, industries: [] } }, readinessError: 'the check timed out' });
check('a failed readiness check says so instead of spinning', /Could not check whether sending is possible/.test(h));
check('and says to treat it as unknown, not ready', /unknown, not as ready/.test(h));
check('a readiness check still running keeps the spinner', /Checking…/.test(renderAcqSettings({ settings: { pricing: { configured: false, includes: [] }, targeting: { status: 'draft', source: 's', geography: { label: 'DFW' }, weeklyVolume: 5, exclusions: { minYearsInBusiness: 3 }, industries: [] } } })));

// ---------------------------------------------------------------------------
section('S6  panelState only infers "empty" when the host reported a good load');
check('no record at all with rows is ready', panelState({}, 'contacts', [1]).status === PANEL.READY);
check('no record and no rows is empty', panelState({}, 'contacts', []).status === PANEL.EMPTY);
check('loading beats everything', panelState({ loading: true }, 'contacts', [1]).status === PANEL.LOADING);
check('a recorded error beats rows', panelState({ load: { contacts: { error: 'x' } } }, 'contacts', [1]).status === PANEL.ERROR);
check('configured false is disconnected', panelState({ load: { contacts: { configured: false } } }, 'contacts', []).status === PANEL.DISCONNECTED);

// ---------------------------------------------------------------------------
section('S7  R8.8 — the budget, shown without double counting');
const B = {
  paused: false,
  bindingPeriod: 'week',
  week: { period: 'week', key: '2026-W40', limitCents: 5000, spentCents: 1200, reservedCents: 300, committedCents: 1500, remainingCents: 3500, conversationReserveCents: 500, resetsAt: new Date(Date.now() + 3 * 864e5).toISOString(), enforced: true },
  month: { period: 'month', key: '2026-10', limitCents: 15000, spentCents: 4200, reservedCents: 300, committedCents: 4500, remainingCents: 10500, conversationReserveCents: 1500, resetsAt: new Date(Date.now() + 20 * 864e5).toISOString(), enforced: true },
  uncappableNote: 'This limit controls what the app chooses to spend.',
};
h = renderBudget(B);
check('both windows are shown', /This week/.test(h) && /This month/.test(h));
check('the period key is shown, not just a label', /2026-W40/.test(h) && /2026-10/.test(h));
check('spent is shown', /\$12\.00/.test(h) && /\$42\.00/.test(h), h.match(/\$\d+\.\d\d/g)?.join(' '));
check('reserved is shown separately from spent', /\$3\.00/.test(h) && /jobs still running/.test(h));
check('remaining is shown', /\$35\.00/.test(h) && /\$105\.00/.test(h));
check('and the next reset in words', /in 3 days/.test(h), h.match(/in [^<]*/)?.[0]);
// the point of the requirement
check('it says the two rows are not two budgets', /two windows over the same money/.test(h));
check('and says not to add them together', /Do not add them together/.test(h));
check('the binding window is named', /weekly<\/b> limit is the one actually stopping work/.test(h));
check('the conversation reserve is explained', /held back for live conversations/.test(h));
check('the uncappable warning is carried', /controls what the app chooses to spend/.test(h));

// no limit set must not read as "nothing is being spent"
h = renderBudget({ ...B, bindingPeriod: null, week: { ...B.week, limitCents: null, remainingCents: null, enforced: false }, month: { ...B.month, limitCents: null, remainingCents: null, enforced: false } });
check('with no limit it says nothing is capping spending', /No limit is set/.test(h));
check('and that spending is still recorded', /not a claim that nothing is being spent/.test(h));
check('the limit column says so rather than showing $0', /no limit set/.test(h) && !/\$0\.00<\/td>/.test(h));

h = renderBudget({ ...B, paused: true });
check('a paused automation is stated first', /Automation is paused/.test(h));

h = renderBudget(null, 'the store did not answer');
check('an unreadable budget is an error', /Could not read the spending state/.test(h));
check('and explicitly not a report of zero', /not a report of zero spending/.test(h));
check('an unknown budget with no error is still loading', /Reading the spending state/.test(renderBudget(null)));

check('a reset within the hour reads in minutes', /in 30 min/.test(resetWords(new Date(Date.now() + 30 * 60000).toISOString())));
check('a reset later today reads in hours', /in 5 hours/.test(resetWords(new Date(Date.now() + 5 * 3600e3).toISOString())));
check('a past reset reads as now', resetWords(new Date(Date.now() - 1000).toISOString()) === 'now');
check('an unparseable reset says unknown rather than guessing', resetWords('not a date') === 'unknown');

done();
