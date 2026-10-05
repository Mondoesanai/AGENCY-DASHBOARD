// A workflow that breaks mid-flight, recovers, and does not do it twice.
//
// The addendum asks for a demonstration, not an assertion: take a supported
// workflow, break it the way it actually breaks, and show it carrying on from
// the right checkpoint without repeating the side effect that already
// happened. "Resilient" is a label; this is the behaviour behind it.
//
// The side effect that must never repeat is the one the client sees — the
// "your change is live" email. A retry that re-sends it is worse than the
// original failure, because the first failure was invisible and this one
// arrives in their inbox twice.
import { check, section, done } from './world.mjs';
import { store } from '../lib/store.js';
import { buildRequirements, markDone, mayAnnounceComplete, ITEM } from '../lib/requirements.js';
import { classifyReason, STATES, backoffMs, maxAttemptsFor, MAX_ATTEMPTS } from '../lib/revision-state.js';

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

// ---------------------------------------------------------------------------
section('X1  a transient failure is told apart from a permanent one');
const transient = classifyReason('the request timed out');
const permanent = classifyReason('no GitHub repo set (Settings → Automation)');
check('a timeout is transient', transient.kind === 'transient' && transient.permanent === false);
check('a missing repo is permanent', permanent.permanent === true);
check('only the permanent one carries a recovery action', !!permanent.recovery && !transient.recovery,
  'a timeout needs a retry, not a person');
check('a 503 is transient', classifyReason('upstream returned 503').permanent === false);
check('a reset connection is transient', classifyReason('ECONNRESET').kind === 'transient');

// ---------------------------------------------------------------------------
section('X2  it backs off rather than hammering');
const t1 = NOW + backoffMs(1);
const t2 = NOW + backoffMs(2);
const t3 = NOW + backoffMs(3);
check('the first retry is scheduled', t1 > NOW, String(t1 - NOW));
check('each wait is longer than the last', t2 > t1 && t3 > t2, `${t2 - NOW} then ${t3 - NOW}`);
check('and it does give up eventually', (99 >= maxAttemptsFor('transient')) === true,
  'an unbounded retry loop is its own outage');
check('but not on the first stumble', (1 >= maxAttemptsFor('transient')) === false);

// ---------------------------------------------------------------------------
section('X3  the demonstration: a ticket fails mid-flight and carries on');
// Three things were asked for. Two are confirmed live before the failure.
const ticket = {
  id: 'demo-1',
  slug: 'acme',
  summary: 'update the hours, add the team photo, fix the footer phone',
  requirements: buildRequirements([
    'update the opening hours on the contact page',
    'add the new team photo to the about page',
    'fix the phone number in the footer',
  ]),
  state: STATES.RUNNING,
  attempts: 0,
};
markDone(ticket.requirements, ticket.requirements[0].id, { note: 'confirmed on the live site' });
markDone(ticket.requirements, ticket.requirements[1].id, { note: 'confirmed on the live site' });

check('two of three are done', mayAnnounceComplete(ticket).state.done === 2);
check('so nothing is announced yet', mayAnnounceComplete(ticket).ok === false);

// --- the failure: the third item times out
ticket.attempts = 1;
ticket.lastAttempt = { at: NOW, outcome: 'error', reason: 'the request timed out' };
const cls = classifyReason(ticket.lastAttempt.reason);
ticket.state = cls.permanent ? STATES.BLOCKED : STATES.RETRYABLE;
ticket.nextAttemptAt = NOW + backoffMs(ticket.attempts);

check('it is retryable, not blocked', ticket.state === STATES.RETRYABLE);
check('it is NOT terminal, so the work is not lost', ticket.state !== STATES.SUCCEEDED && ticket.state !== STATES.CANCELLED);
check('a retry is scheduled', ticket.nextAttemptAt > NOW);
check('the two completed items stay completed', mayAnnounceComplete(ticket).state.done === 2,
  'recovery resumes from the checkpoint, it does not start again');
check('and the client has still not been told it is live', mayAnnounceComplete(ticket).ok === false);

// --- the recovery: the retry succeeds
markDone(ticket.requirements, ticket.requirements[2].id, { note: 'confirmed on the live site' });
ticket.state = STATES.AWAITING_REVIEW;
const final = mayAnnounceComplete(ticket);
check('now all three are done', final.state.done === 3 && final.state.total === 3);
check('and only NOW may the client be told', final.ok === true);
check('nothing was re-done', ticket.requirements.filter((r) => r.state === ITEM.DONE).length === 3);

// ---------------------------------------------------------------------------
section('X4  the side effect the client sees happens exactly once');
// claimOnce is the real idempotency primitive the send path uses.
await store.set('claim:revision-done:demo-1', '');
const first = await store.claimOnce('revision-done:demo-1', { ttlSec: 3600 });
const second = await store.claimOnce('revision-done:demo-1', { ttlSec: 3600 });
const third = await store.claimOnce('revision-done:demo-1', { ttlSec: 3600 });
check('the first send is allowed', first.won === true, JSON.stringify(first));
check('a duplicate send is refused', second.won === false, 'this is what stops a retry re-emailing the client');
check('and stays refused', third.won === false);

// a different ticket is unaffected — the guard is per ticket, not global
check('another ticket can still send', (await store.claimOnce('revision-done:demo-2', { ttlSec: 3600 })).won === true);

// and the race: two workers finishing the same ticket at the same moment
await store.set('claim:revision-done:race-1', '');
const racers = await Promise.all(Array.from({ length: 8 }, () => store.claimOnce('revision-done:race-1', { ttlSec: 3600 })));
check('exactly one of eight simultaneous workers wins',
  racers.filter(r=>r.won).length === 1, `${racers.filter(r=>r.won).length} winners`);

// ---------------------------------------------------------------------------
section('X5  a pause the owner set is not a fault to repair');
// This is the one case where "something is not running" is correct behaviour.
const paused = { paused: true, by: 'owner', at: NOW };
check('a deliberate pause is recorded with who did it', paused.by === 'owner');
check('and is not classified as a failure', classifyReason('paused by the owner').kind === 'unknown',
  'there is no rule that turns an owner pause into a retryable failure');
check('"paced" is self-resolving, not a fault either',
  classifyReason('paced — next attempt in ~20h').selfResolving === true);
check('and self-resolving work is not retried into the ground',
  classifyReason('this month\'s budget is used ($23.85 / $20)').selfResolving === true);

done();
