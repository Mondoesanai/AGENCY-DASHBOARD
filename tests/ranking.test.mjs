// R9.4 — opens and raw clicks may not decide anything.
//
// This is not a preference about metrics. An open rate stopped measuring
// attention in 2021, when Apple Mail Privacy Protection began pre-fetching the
// tracking pixel for every message sent to its users whether or not anyone
// reads it. Gmail has proxied images since 2013. Security appliances fetch
// everything before delivery. What is left is substantially a measurement of
// WHICH MAIL CLIENTS the recipients use — so optimising against it optimises
// for writing to people with Apple devices.
//
// The checks below are about the gate refusing, the refusal carrying its
// reason, and the system declining to invent a contamination percentage it
// cannot know.
import { check, section, done } from './world.mjs';
import {
  RANKABLE, UNRANKABLE, unrankableReason,
  mayRankBy, rankVariants, openCaveat, rankingStatement,
} from '../lib/ranking.js';
import { PRIMARY, LADDER } from '../lib/outcomes.js';

// ---------------------------------------------------------------------------
section('K1  only outcomes that required a person may rank');
check('the rankable list is exactly the primary ladder', RANKABLE.join(',') === LADDER.map((l) => l.id).join(','), RANKABLE.join(','));
check('all four are there', RANKABLE.length === 4);
for (const id of RANKABLE) check(`"${id}" may rank`, mayRankBy(id).ok === true);

check('opens may not rank', mayRankBy('opened').ok === false);
check('raw clicks may not rank', mayRankBy('click-raw').ok === false);
check('human-looking clicks may not rank either', mayRankBy('click-human').ok === false);
check('machine clicks certainly may not', mayRankBy('click-filtered').ok === false);
check('delivery may not rank', mayRankBy('delivered').ok === false);
// anything unknown is refused rather than allowed by omission
let g = mayRankBy('vibes');
check('an unknown metric is refused', g.ok === false, JSON.stringify(g));
check('and the refusal explains the rule', /requires a person to have done something/.test(g.reason), g.reason);

// ---------------------------------------------------------------------------
section('K2  every refusal carries its reason, and the reasons are specific');
for (const u of UNRANKABLE) {
  check(`"${u.id}" has a stated reason`, u.why.length > 60, u.why);
  check(`and mayRankBy returns it`, mayRankBy(u.id).reason === u.why);
}
const openWhy = unrankableReason('opened');
check('the open refusal names Apple Mail Privacy Protection', /Apple Mail Privacy Protection/.test(openWhy), openWhy);
check('and Gmail image proxying', /Gmail proxies/.test(openWhy));
check('and says what an open rate actually measures', /which mail clients your recipients use/.test(openWhy));
check('and spells out the consequence', /ranks by device ownership/.test(openWhy));
check('the raw-click refusal explains the perverse incentive', /most heavily filtered recipients would look like the most interested/.test(unrankableReason('click-raw')));
check('even a human-looking click is called a weak signal', /weak signal/.test(unrankableReason('click-human')));
check('delivery is called a denominator', /denominator/.test(unrankableReason('delivered')));

// ---------------------------------------------------------------------------
section('K3  ranking refuses outright rather than substituting');
const breakdown = {
  ok: true,
  arms: [
    { variantId: 'a', label: 'A', assigned: 50, rungs: { [PRIMARY.QUALIFIED_REPLY]: 3, [PRIMARY.QUALIFIED_BOOKING]: 1, [PRIMARY.ATTENDED_CALL]: 0, [PRIMARY.RECORDED_SALE]: 0 } },
    { variantId: 'b', label: 'B', assigned: 50, rungs: { [PRIMARY.QUALIFIED_REPLY]: 7, [PRIMARY.QUALIFIED_BOOKING]: 0, [PRIMARY.ATTENDED_CALL]: 0, [PRIMARY.RECORDED_SALE]: 0 } },
  ],
};

let r = rankVariants(breakdown, PRIMARY.QUALIFIED_REPLY);
check('a permitted metric ranks', r.ok === true, JSON.stringify(r));
check('in descending order', r.ranked[0].variantId === 'b' && r.ranked[0].count === 7, JSON.stringify(r.ranked));
check('carrying the denominator so a count is readable', r.ranked[0].assigned === 50);
// the point: ordering is arithmetic, not a verdict
check('it says it is not a verdict', /not a verdict/.test(r.note));
check('and that sample size decides whether it means anything', /depends on the sample size/.test(r.note));

r = rankVariants(breakdown, 'opened');
check('ranking by opens is refused', r.ok === false, JSON.stringify(r));
check('nothing is ranked', r.ranked === null);
// the one that matters: no silent substitution
check('it does NOT quietly rank by something else instead', !Array.isArray(r.ranked));
check('and the reason is the open reason, not a generic one', /Apple Mail Privacy Protection/.test(r.reason));

r = rankVariants(breakdown, PRIMARY.RECORDED_SALE);
check('a permitted metric with all-zero counts still ranks', r.ok === true && r.ranked.every((x) => x.count === 0), JSON.stringify(r.ranked));
check('ranking with no breakdown is refused', rankVariants({ ok: false }, PRIMARY.QUALIFIED_REPLY).ok === false);

// ---------------------------------------------------------------------------
section('K4  opens are shown, with what they measure — and no invented number');
const c = openCaveat(412);
check('the count is carried, not hidden', c.opens === 412);
check('and marked unusable for ranking', c.usableForRanking === false);
check('it says what the number is', /tracking pixel was fetched/.test(c.measures));
check('and what it is not', /Whether anyone read the message/.test(c.doesNotMeasure));
check('the three causes are named', c.causes.length === 3 && c.causes.some((x) => /Apple/.test(x)) && c.causes.some((x) => /Gmail/.test(x)) && c.causes.some((x) => /appliance/i.test(x)));
// the refusal to guess
check('no contamination percentage is invented', c.contaminatedShare === null, String(c.contaminatedShare));
check('and it says why no number is offered', /not knowable from our side/.test(c.contaminationNote));
check('in words that name the failure mode', /guess wearing a percentage sign/.test(c.contaminationNote));

// ---------------------------------------------------------------------------
section('K5  the statement is built from real counts, not boilerplate');
let s = rankingStatement({ opens: 100, humanClicks: 3, filteredClicks: 9 });
check('it lists what may rank', s.rankableMetrics.length === 4);
check('and what is refused, with reasons', s.refusedMetrics.length === UNRANKABLE.length && s.refusedMetrics.every((x) => x.why.length > 60));
check('the open caveat is included', s.opens.opens === 100 && s.opens.usableForRanking === false);
// this share IS knowable, because we classified the clicks ourselves
check('the machine share of clicks is computed from the real counts', s.clicks.filteredSharePct === 75, String(s.clicks.filteredSharePct));
check('and stated plainly', /75% of recorded clicks were classified as machine activity/.test(s.clicks.note));
check('noting that raw counts would have included them', /Raw click counts would include all of them/.test(s.clicks.note));

s = rankingStatement({ opens: 0, humanClicks: 0, filteredClicks: 0 });
check('with no clicks, no share is claimed', s.clicks.filteredSharePct === null, String(s.clicks.filteredSharePct));
check('and it says nothing is known rather than reporting 0%', /nothing is known about how many would be machines/.test(s.clicks.note));

check('the summary says ranking needs a human act', /required a person to do something/.test(s.summary));
check('and explains why opens are shown at all', /hiding a number invites someone to go looking for it elsewhere/.test(s.summary));

// ---------------------------------------------------------------------------
section('K6  the real reporting route carries the gate');
{
  const handler = (await import('../api/admin.js')).default;
  const { createExperiment, setExperimentState, assign } = await import('../lib/experiments.js');
  const { store } = await import('../lib/store.js');
  const EID = 'exp-ranking';
  await store.set(`experiment:${EID}`, '').catch(() => {});
  await createExperiment({ id: EID, variable: 'subject', variants: [{ id: 'a' }, { id: 'b' }] });
  await setExperimentState(EID, 'running');
  await assign({ experimentId: EID, contactId: 'rank-1' });

  process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-secret';
  const mk = () => {
    const r = { statusCode: 0, body: null };
    r.setHeader = () => {};
    r.status = (c) => { r.statusCode = c; return r; };
    r.json = (b) => { r.body = b; return r; };
    r.send = (b) => { r.body = b; return r; };
    r.end = () => r;
    return r;
  };

  let res = mk();
  await handler({ method: 'GET', query: { do: 'experiments-list', secret: process.env.CRON_SECRET }, headers: {} }, res);
  check('the experiments route answers', res.statusCode === 200, String(res.statusCode));
  const row = (res.body?.experiments || []).find((x) => x.experiment.id === EID);
  check('the experiment is reported', !!row, JSON.stringify(res.body).slice(0, 160));
  check('every report carries the ranking statement', !!row?.ranking, JSON.stringify(row || {}).slice(0, 160));
  check('naming what may not rank', (row?.ranking?.refusedMetrics || []).some((m) => m.id === 'opened'));
  check('and the open caveat', row?.ranking?.opens?.usableForRanking === false);
  check('the ordering shown is by a primary outcome', row?.orderedBy?.metric === 'qualified-positive-reply', JSON.stringify(row?.orderedBy));

  // asking the route to rank by opens must be refused, not served
  res = mk();
  await handler({ method: 'GET', query: { do: 'experiment-rank', id: EID, metric: 'opened', secret: process.env.CRON_SECRET }, headers: {} }, res);
  check('ranking by opens is refused over HTTP too', res.statusCode === 400, String(res.statusCode));
  check('with the open reason', /Apple Mail Privacy Protection/.test(res.body?.reason || ''), JSON.stringify(res.body));
  check('and nothing ranked', res.body?.ranked === null);

  res = mk();
  await handler({ method: 'GET', query: { do: 'experiment-rank', id: EID, metric: 'qualified-positive-reply', secret: process.env.CRON_SECRET }, headers: {} }, res);
  check('a primary outcome is accepted', res.statusCode === 200 && Array.isArray(res.body?.ranked), JSON.stringify(res.body).slice(0, 140));

  await store.set(`experiment:${EID}`, '').catch(() => {});
}

done();
