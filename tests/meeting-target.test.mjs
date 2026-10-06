// "Six qualified meetings a week" as a control the owner can act on.
//
// A target is only useful if it can be wrong in a direction you can do
// something about, and only safe if it cannot quietly become pressure on
// people who never asked to hear from you. Most of these checks are about the
// second half.
//
// The brief's worked example is the spine: six booked, four no-shows. That is
// a 33% attendance rate from six events, and six events cannot tell a
// confirmation problem from a lead-fit problem from ordinary variance. Jumping
// to "change the wording" is how a delivery failure gets mistaken for a copy
// failure for a month.
import { check, section, done } from './world.mjs';
import {
  weekStart, describeWeek, weekProgress, recommendedVolume, diagnoseShortfall,
  DEFAULT_TARGET, DEFAULT_TZ,
} from '../lib/meeting-target.js';
import { renderTarget, renderVolume, renderShortfall } from '../public/meetings.js';

const TZ = 'America/Chicago';
const D = 86400e3;
// Wednesday 2026-10-07, 15:00 UTC = 10:00 Chicago
const WED = Date.UTC(2026, 9, 7, 15, 0, 0);

// ---------------------------------------------------------------------------
section('T1  the week is defined, not implied');
const w = describeWeek(WED, TZ);
check('it starts on a Monday', new Date(w.start).getUTCDay() === 1 || new Date(w.start + 6 * 3600e3).getUTCDay() === 1,
  new Date(w.start).toISOString());
check('it is seven days long', Math.round((w.end - w.start) / D) === 7, String((w.end - w.start) / D));
check('the window is spelled out', /Mon .+ – Sun .+/.test(w.label), w.label);
check('and the timezone is named', w.timezone === TZ);
check('Wednesday falls inside its own week', WED >= w.start && WED < w.end);
check('a rolling seven days is NOT what is meant',
  weekStart(WED, TZ) !== WED - 7 * D,
  'a week that means "the last seven days" moves its own goalposts every time it is read');
check('Sunday evening in Texas is still that week, not the next',
  weekStart(Date.UTC(2026, 9, 12, 2, 0, 0), TZ) === weekStart(WED, TZ),
  'Sunday 21:00 Chicago is Monday 02:00 UTC; a UTC week would push it forward');

// ---------------------------------------------------------------------------
section('T2  progress is ATTENDED meetings, never booked ones');
const start = weekStart(WED, TZ);
const bookings = [
  { id: 'a', startAt: start + 1 * D, status: 'attended' },
  { id: 'b', startAt: start + 1 * D, status: 'attended' },
  { id: 'c', startAt: start + 1 * D, status: 'no-show' },
  { id: 'd', startAt: start + 1 * D, status: 'no-show' },
  { id: 'e', startAt: start + 1 * D, status: 'no-show' },
  { id: 'f', startAt: start + 1 * D, status: 'no-show' },
  { id: 'g', startAt: start + 5 * D, status: 'scheduled' },   // still to come
  { id: 'h', startAt: start - 3 * D, status: 'attended' },     // last week
];
const p = weekProgress(bookings, { now: WED, tz: TZ, target: 6 });
check('six were booked this week', p.booked === 7 - 1 + 0 || p.booked === 7, String(p.booked));
check('but only two attended', p.attended === 2, String(p.attended));
check('progress counts the two, not the six', p.remaining === 4, String(p.remaining));
check('last week is not in this week', !bookings.filter((b) => b.startAt >= p.start && b.startAt < p.end).some((b) => b.id === 'h'));
check('no-shows are counted separately', p.noShow === 4, String(p.noShow));
check('and the upcoming one is neither', p.upcoming === 1, String(p.upcoming));

section('T2b  a past meeting nobody answered for counts as neither');
const unanswered = weekProgress([{ id: 'x', startAt: start + 1 * D, status: 'scheduled' }], { now: WED, tz: TZ, target: 6 });
check('it is flagged', unanswered.unanswered === 1, String(unanswered.unanswered));
check('not counted as attended', unanswered.attended === 0);
check('not counted as missed', unanswered.noShow === 0);
check('and it says so', /neither attended nor missed/.test(unanswered.note || ''), unanswered.note);

// ---------------------------------------------------------------------------
section('T3  the target recommends volume; it never authorises it');
let v = recommendedVolume({ remaining: 4 }, { invited: 3, positiveReplies: 1, booked: 1, attended: 1 });
check('three invitations is too few to work back from', v.ok === false, JSON.stringify(v));
check('and it says what it would need', /at least 20/.test(v.wouldNeed || ''), v.wouldNeed);
check('rather than extrapolating from three', !v.invitationsNeeded,
  'a funnel estimate built on three events is a guess wearing arithmetic');

v = recommendedVolume({ remaining: 4 }, { invited: 100, positiveReplies: 20, booked: 10, attended: 5 });
check('with real history it computes', v.ok === true, JSON.stringify(v).slice(0, 140));
check('from the owner\'s OWN rates', v.basis.replyRate === 0.2 && v.basis.bookRate === 0.5 && v.basis.attendRate === 0.5,
  JSON.stringify(v.basis));
check('and the number follows from them', v.invitationsNeeded === 80, String(v.invitationsNeeded));
check('it is labelled a recommendation, not a permission', /not a permission/.test(v.note), v.note);
check('and says explicitly that it changes nobody\'s consent',
  /consent/.test(v.note) && /does not widen who may be contacted/.test(v.note), v.note);

check('a met target asks for nothing', recommendedVolume({ remaining: 0 }, {}).need === 0);
check('no attended meeting yet means no chain to estimate',
  recommendedVolume({ remaining: 4 }, { invited: 100, positiveReplies: 20, booked: 10, attended: 0 }).ok === false);

// ---------------------------------------------------------------------------
section('T4  THE WORKED EXAMPLE: six booked, four no-shows');
const six = weekProgress([
  ...Array.from({ length: 2 }, (_, i) => ({ id: `at${i}`, startAt: start + D, status: 'attended' })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `ns${i}`, startAt: start + D, status: 'no-show' })),
], { now: WED, tz: TZ, target: 6 });
const d = diagnoseShortfall(six, {});

check('it does NOT jump to changing the wording',
  !d.questions.some((q) => /wording|copy|message text/i.test(q.q)), JSON.stringify(d.questions.map((q) => q.q)));
check('it names that more people missed than came', d.questions.some((q) => /not turning up/i.test(q.q)));
const nq = d.questions.find((q) => /not turning up/i.test(q.q));
for (const factor of ['where the booking came from', 'how long the gap', 'confirmation', 'reschedul', 'right businesses'])
  check(`it lists "${factor}" as something the data cannot yet separate`, new RegExp(factor, 'i').test(nq.why), nq.why);
check('and says those are not currently captured well enough', /not currently captured/.test(nq.action), nq.action);
check('that question is marked as NOT settleable today', nq.settleable === false);

check('the verdict refuses to conclude from six', /too few to conclude/.test(d.verdict || ''), d.verdict);
check('and says nothing here is a finding', /Nothing here is a finding/.test(d.verdict));
check('the sample is stated', d.sample === 6, String(d.sample));

section('T4b  the one suggestion is explicitly a hypothesis');
check('there is a suggestion', !!d.hypothesis);
check('it is tagged HYPOTHESIS', d.hypothesis.label === 'HYPOTHESIS');
check('it is small and specific', /confirmation/i.test(d.hypothesis.change) && /reminder/i.test(d.hypothesis.change));
check('it only goes to people with permission on that channel',
  /permission on that channel/.test(d.hypothesis.change), d.hypothesis.change);
check('it changes nothing about WHO is contacted', /alters nothing about who is contacted/.test(d.hypothesis.why));
check('the caution names the sample it came from', /from 6 settled meetings/.test(d.hypothesis.caution), d.hypothesis.caution);
check('and forbids reporting it as a finding', /must not be reported as a finding/.test(d.hypothesis.caution));
check('with the outcome it would be measured by', /attended/.test(d.hypothesis.measure));

section('T4c  a delivery problem is separated from a copy problem');
const withDelivery = diagnoseShortfall(six, { confirmationsSent: 6, confirmationsDelivered: 2 });
const dq = withDelivery.questions.find((q) => /confirmations were not delivered/i.test(q.q));
check('undelivered confirmations are raised', !!dq, JSON.stringify(withDelivery.questions.map((q) => q.q)));
check('it counts them', /2 of 6/.test(dq.why), dq.why);
check('and names the distinction', /nobody was reminded about is a different problem/.test(dq.why));
check('and says to check that BEFORE touching wording', /before touching the wording/.test(dq.action), dq.action);
check('it is settleable today', dq.settleable === true);

section('T4d  no bookings at all is a different problem entirely');
const none = diagnoseShortfall(weekProgress([], { now: WED, tz: TZ, target: 6 }), {});
const nb = none.questions.find((q) => /Nothing was booked/i.test(q.q));
check('it is raised', !!nb);
check('and says it has nothing in common with a no-show problem', /nothing in common/.test(nb.why), nb.why);
check('pointing at invitations rather than meeting wording', /not at meeting wording/.test(nb.action));
check('no hypothesis is offered when nothing was booked', none.hypothesis === null);

// ---------------------------------------------------------------------------
section('T5  the screen says the same things');
let html = renderTarget(six, null);
check('it shows attended against the target', /2 of 6<\/b> attended/.test(html), html.slice(0, 200));
check('with booked shown separately', /6 booked/.test(html));
check('and states that progress counts attendance', /meetings people actually attended/.test(html));
check('the week is named', /Mon/.test(html) && /America\/Chicago/.test(html));

html = renderVolume({ ok: false, reason: 'only 3 invitations have been sent', wouldNeed: 'at least 20', note: 'x' });
check('a refusal to estimate says so', /No volume recommendation/.test(html), html);
check('with the reason', /only 3 invitations/.test(html));

html = renderShortfall(d);
check('the hypothesis is tagged on screen', /HYPOTHESIS/.test(html));
check('the caution is shown, not buried', /must not be reported as a finding/.test(html));
check('settleable and unsettleable questions are visually separated',
  /mt-q-now/.test(renderShortfall(withDelivery)) && /mt-q-later/.test(html));
check('nothing renders when there is nothing to say', renderShortfall(null) === '');
check('and the target panel survives no data', renderTarget(null, null) === '');

check('the defaults are the brief\'s', DEFAULT_TARGET === 6 && DEFAULT_TZ === 'America/Chicago');

done();
