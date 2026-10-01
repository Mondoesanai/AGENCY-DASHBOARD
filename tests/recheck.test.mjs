// R5.9 — website rechecks create an internal opportunity, never a message.
import { W, check, section, done } from './world.mjs';
import {
  CHANGE, materialChange, invalidatesPremise, createOpportunity, listOpportunities,
  resolveOpportunity, recheckProspect, runRecheckSweep, DEFAULT_COOLDOWN_DAYS,
} from '../lib/recheck.js';
import { WEB_STATUS, saveProspects, updateProspect, getProspect } from '../lib/discovery.js';

const S = WEB_STATUS;
const okRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => ({}) });
const DAY = 86400000;

// ---------------------------------------------------------------------------
section('K1  only a real change in what is TRUE about them counts');
check('building a site is material', materialChange({ status: S.NOT_LINKED }, { status: S.PRESENT }).change === CHANGE.BUILT_A_SITE);
check('a site going down is material', materialChange({ status: S.PRESENT }, { status: S.INACCESSIBLE }).change === CHANGE.SITE_WENT_DOWN);
check('a site coming back is material', materialChange({ status: S.INACCESSIBLE }, { status: S.PRESENT }).change === CHANGE.SITE_CAME_BACK);
check('a site disappearing from the listing is material', materialChange({ status: S.PRESENT }, { status: S.NOT_LINKED }).change === CHANGE.SITE_DISAPPEARED);

check('an unchanged status is not material', materialChange({ status: S.PRESENT }, { status: S.PRESENT }).material === false);
check('and it says so plainly', /status unchanged/.test(materialChange({ status: S.PRESENT }, { status: S.PRESENT }).reason));
check('no previous status is not a change', materialChange(null, { status: S.PRESENT }).material === false);

// the noise rule — uncertain is inert in BOTH directions
check('moving INTO uncertain is not material', materialChange({ status: S.PRESENT }, { status: S.UNCERTAIN }).material === false);
check('moving OUT of uncertain is not material', materialChange({ status: S.UNCERTAIN }, { status: S.PRESENT }).material === false);
check('and the reason explains why that is noise', /about our confidence, not about the business/.test(materialChange({ status: S.UNCERTAIN }, { status: S.PRESENT }).reason));

// ---------------------------------------------------------------------------
section('K2  a change that invalidates the premise is flagged as such');
check('building a site invalidates a "no website found" approach', invalidatesPremise(CHANGE.BUILT_A_SITE) === true);
check('a site coming back does too', invalidatesPremise(CHANGE.SITE_CAME_BACK) === true);
check('a site going down does NOT — that is a new opening, not a dead one', invalidatesPremise(CHANGE.SITE_WENT_DOWN) === false);

// ---------------------------------------------------------------------------
section('K3  the cooldown decides contactability, not whether we record it');
const now = Date.UTC(2026, 9, 1);
let opp = await createOpportunity(
  { id: 'p-cool', name: 'Recently Contacted Co', lastContactedAt: now - 10 * DAY },
  { change: CHANGE.SITE_WENT_DOWN, reason: 'their site is down' },
  { now }
);
check('the opportunity is still created', !!opp && opp.change === CHANGE.SITE_WENT_DOWN);
check('but it is NOT contactable', opp.contactable === false);
// contacted 2026-09-21, so the 60-day cooldown runs to 2026-11-20
check('and it says when it becomes contactable', /cooldown runs until 2026-11-20/.test(opp.blockedBy || ''), opp.blockedBy);
check('with how long ago they were contacted', /contacted 10 days ago/.test(opp.blockedBy || ''), opp.blockedBy);
check('the record states it is not permission', /decided by the consent gate at send time/.test(opp.permissionNote));

opp = await createOpportunity(
  { id: 'p-old', name: 'Long Ago Co', lastContactedAt: now - 200 * DAY },
  { change: CHANGE.SITE_WENT_DOWN, reason: 'their site is down' },
  { now }
);
check('a prospect past the cooldown is contactable', opp.contactable === true && opp.cooldownUntil === null);

opp = await createOpportunity(
  { id: 'p-never', name: 'Never Contacted Co' },
  { change: CHANGE.BUILT_A_SITE, reason: 'they built one' },
  { now }
);
check('a never-contacted prospect is contactable', opp.contactable === true);
check('and a premise-invalidating change is flagged on the record', opp.premiseInvalidated === true);

// the record carries nothing that could be sent
const keys = Object.keys(opp);
check('the opportunity has no message body', !keys.some((k) => /body|message|subject|text/i.test(k)), keys.join(','));
check('and no recipient', !keys.some((k) => /to|recipient|email|phone/i.test(k)), keys.join(','));

// ---------------------------------------------------------------------------
section('K4  a recheck through the real path creates an opportunity, sends nothing');
await saveProspects([{ sourceId: 'osm:node/700', name: 'Changeling Roofing', email: 'info@changeling.test', website: 'changeling.test', city: 'Dallas', evidence: {} }]);
const PID = 'osm-node-700';
await updateProspect(PID, {
  web: { status: S.NOT_LINKED, observation: 'none linked', checkedAt: now - 200 * DAY },
  lastContactedAt: now - 200 * DAY,
});

// now their site exists and matches
const fetchBuilt = async () => okRes('<html><title>Changeling Roofing</title>Call us</html>');
let r = await recheckProspect(PID, { fetchImpl: fetchBuilt, now });
check('the recheck runs', r.ok === true, JSON.stringify(r).slice(0, 160));
check('it detects they built a site', r.change === CHANGE.BUILT_A_SITE, r.change);
check('an opportunity is created', !!r.opportunity);
check('and it is explicitly marked as not sent', r.sent === false);
check('nothing was emailed', W.emails.length === 0, String(W.emails.length));
check('nothing was texted', W.sms.length === 0, String(W.sms.length));

const p = await getProspect(PID);
check('the new status is stored', p.web.status === S.PRESENT, p.web.status);
check('and the previous one is kept for comparison', p.previousWeb?.status === S.NOT_LINKED);

// ---------------------------------------------------------------------------
section('K5  rechecks are spaced, and a no-change recheck creates nothing');
r = await recheckProspect(PID, { fetchImpl: fetchBuilt, now });
check('an immediate re-run is skipped', r.skipped === true, JSON.stringify(r));
check('and it says how long until the next one is due', /rechecks are \d+ days apart/.test(r.reason), r.reason);

r = await recheckProspect(PID, { fetchImpl: fetchBuilt, now, force: true });
check('a forced recheck with the same result reports no change', r.changed === false, JSON.stringify(r));
check('and creates no opportunity', r.opportunity === null);

r = await recheckProspect('does-not-exist', { fetchImpl: fetchBuilt, now });
check('an unknown prospect is refused rather than crashing', r.ok === false && /unknown prospect/.test(r.reason));

// ---------------------------------------------------------------------------
section('K6  the sweep is bounded and reports what it did');
await saveProspects([
  { sourceId: 'osm:node/701', name: 'Sweep One', website: 'one.test', evidence: {} },
  { sourceId: 'osm:node/702', name: 'Sweep Two', website: 'two.test', evidence: {} },
  { sourceId: 'osm:node/703', name: 'Sweep Three', website: 'three.test', evidence: {} },
]);
const sweep = await runRecheckSweep({ max: 2, fetchImpl: fetchBuilt, now });
check('the sweep respects its cap', sweep.checked <= 2, String(sweep.checked));
check('it states that nothing contacts anyone', /Nothing here contacts anyone/.test(sweep.note));
check('still nothing emailed after a sweep', W.emails.length === 0);

// ---------------------------------------------------------------------------
section('K7  opportunities can be listed and resolved');
const open = await listOpportunities();
check('open opportunities are listed', open.length > 0, String(open.length));
check('newest first', open.length < 2 || open[0].observedAt >= open[open.length - 1].observedAt);
const resolved = await resolveOpportunity(open[0].id, 'not worth chasing');
check('one can be resolved', resolved.status === 'resolved' && resolved.outcome === 'not worth chasing');
const after = await listOpportunities();
check('and it leaves the open list', !after.some((o) => o.id === resolved.id));

// ---------------------------------------------------------------------------
section('K8  the sweep actually runs inside the scheduled tick (not an orphan)');
// Driving the REAL runAutoTick, because a recheck module nothing calls would be
// exactly the orphan the reviewer caught last time.
const { runAutoTick } = await import('../lib/tick.js');
const { store } = await import('../lib/store.js');

await store.set('recheck:at', '0'); // make the daily gate due
const tick = await runAutoTick();
check('the tick reports a recheck phase', tick.recheck !== undefined, JSON.stringify(Object.keys(tick)));
check('and it actually checked prospects', tick.recheck.checked > 0, JSON.stringify(tick.recheck));
check('the tick still sent nothing', W.emails.length === 0 && W.sms.length === 0);

// the daily gate holds
const tick2 = await runAutoTick();
check('a second tick the same day does not sweep again', tick2.recheck === undefined, JSON.stringify(tick2.recheck));

done();
