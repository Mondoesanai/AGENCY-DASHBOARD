// What "healthy" actually means for a scheduled worker.
//
// R18.5. `statusFor` decided health from ONE fact: when the worker last checked
// in. That is an ATTEMPT, and on this system an attempt can mean nothing more
// than that somebody opened the dashboard, because the page pokes the tick. So
// a worker that started every ten minutes and failed every single time read as
// `ok` — the "looks healthy while nothing works" failure, in the one place
// whose entire job is noticing that failure elsewhere.
//
// Health is now derived from TWO durable facts, and a third when it exists:
//
//   lastAttemptAt   it started. Proves the scheduler is alive, nothing more.
//   lastSuccessAt   it finished and did its job. The one that matters.
//   blocker         a named reason it cannot succeed, from the recovery sweep.
//
// FIVE STATES, and the distinctions are the point:
//
//   never-ran   no attempt has ever been recorded. Usually "not set up yet",
//               which is a fact about the RECORD, not proof it is broken.
//   blocked     it is attempting and not succeeding, or something names a
//               reason it cannot. **Carries an owner action.** This is the
//               state that did not exist before, and the one that was being
//               reported as healthy.
//   late        attempts have stopped, or are overdue against its own schedule.
//   healthy     attempted recently AND succeeded recently.
//   unknown     the record could not be read. Never an all-clear.
//
// `paused` is orthogonal and is reported alongside, not instead: an owner needs
// to know both that it is off and when it last did anything.
//
// WHAT THIS DELIBERATELY WILL NOT DO. It never claims healthy from an attempt
// alone. A worker with no outcome telemetry at all is reported as running with
// an unknown outcome, not as working — because nobody has ever recorded whether
// it worked, and borrowing a timestamp's credibility is how the original bug
// happened.

export const HEALTH = Object.freeze({
  HEALTHY: 'healthy',
  LATE: 'late',
  BLOCKED: 'blocked',
  NEVER: 'never-ran',
  UNKNOWN: 'unknown',
});

/** Worst first — an average would let one dead worker hide behind three good ones. */
export const HEALTH_RANK = Object.freeze({
  [HEALTH.BLOCKED]: 0,
  [HEALTH.LATE]: 1,
  [HEALTH.NEVER]: 2,
  [HEALTH.UNKNOWN]: 3,
  [HEALTH.HEALTHY]: 4,
});

export const HEALTH_WORD = Object.freeze({
  [HEALTH.HEALTHY]: 'Working',
  [HEALTH.LATE]: 'Late',
  [HEALTH.BLOCKED]: 'Blocked',
  [HEALTH.NEVER]: 'Never run',
  [HEALTH.UNKNOWN]: 'Unknown',
});

/**
 * How long after an attempt we stop believing a stale success.
 *
 * Three missed cycles. One late run is weather; three in a row is a pattern.
 * Expressed in cycles rather than minutes so a worker that runs daily and one
 * that runs every ten minutes are judged on their own schedule.
 */
export const SUCCESS_TOLERANCE_CYCLES = 3;

/**
 * Health for one worker, from durable data only.
 *
 * `blocker` is optional and comes from the recovery sweep: a named permanent
 * reason such as a missing credential or an unlinked repository. When one
 * exists it wins, because "late" is a timing problem and this is not.
 */
export function workerHealth(w, { now = Date.now(), blocker = null } = {}) {
  const every = Number(w?.everyMs) || 0;
  // NOT `?? null`: `undefined` means "the record could not be read" and `null`
  // means "read, and it has never run". Collapsing them would report an
  // unreadable record as a confident "never ran", which is the opposite of the
  // honesty this whole module is for.
  const attempt = w?.lastAttemptAt;
  const success = w?.lastSuccessAt;      // undefined = never recorded at all
  const hasTelemetry = success !== undefined;

  if (attempt === undefined) {
    return {
      health: HEALTH.UNKNOWN,
      why: 'Its record could not be read. This is not a report that it is running.',
      ownerAction: null,
    };
  }

  // A named permanent blocker outranks everything except having never run:
  // a worker that cannot possibly succeed is not merely late.
  if (blocker) {
    return {
      health: HEALTH.BLOCKED,
      why: blocker.text || 'Something it needs is missing.',
      ownerAction: blocker.ownerAction || blocker.action || 'A person needs to supply something.',
      blockerCode: blocker.code || null,
    };
  }

  if (!attempt) {
    return {
      health: HEALTH.NEVER,
      why: `No run has ever been recorded. It is run by ${w?.runBy || 'a scheduler'}, which may not be set up yet.`,
      ownerAction: `Check that ${w?.runBy || 'its scheduler'} is configured.`,
    };
  }

  const attemptAge = Math.max(0, now - attempt);
  const lateAfter = every ? every * SUCCESS_TOLERANCE_CYCLES : Infinity;

  // Attempts have stopped. Nothing is running, so nothing can be succeeding.
  if (attemptAge > lateAfter) {
    return {
      health: HEALTH.LATE,
      why: `It last started ${Math.round(attemptAge / 60000)} minutes ago, well past its schedule.`,
      ownerAction: `Check ${w?.runBy || 'its scheduler'} is still running.`,
    };
  }

  // THE CASE THAT USED TO READ AS HEALTHY: starting on time, never finishing.
  if (hasTelemetry && !success) {
    return {
      health: HEALTH.BLOCKED,
      why: 'It starts on schedule but has never recorded a success. Something is stopping it before it finishes.',
      ownerAction: 'Open the last failure on this worker and fix what it names.',
    };
  }

  if (hasTelemetry && success) {
    const successAge = Math.max(0, now - success);
    if (successAge > lateAfter) {
      return {
        health: HEALTH.BLOCKED,
        why: `It is still starting on schedule, but nothing has succeeded for ${Math.round(successAge / 60000)} minutes.`,
        ownerAction: 'Open the last failure on this worker and fix what it names.',
      };
    }
    return { health: HEALTH.HEALTHY, why: 'Started and finished on schedule.', ownerAction: null };
  }

  // Attempting on time, but nobody ever records whether it worked. Not a
  // failure, and emphatically not a success.
  return {
    health: HEALTH.UNKNOWN,
    why: 'It is starting on schedule, but nothing records whether it achieves anything. A timestamp proves it began, not that it worked.',
    ownerAction: null,
    noTelemetry: true,
  };
}

/**
 * The one answer the owner wants: what needs me, what is running, what is
 * blocked, and what would unblock it.
 *
 * Built from the worker list the automation status already produces, plus any
 * blockers the recovery sweep named. Returns counts AND the specific actions,
 * because "2 blocked" with no next step is a number, not an answer.
 */
export function answerFor(workers = [], { now = Date.now(), blockers = [], paused = false } = {}) {
  const byId = new Map(blockers.filter((b) => b && b.worker).map((b) => [b.worker, b]));
  const rows = workers
    .map((w) => {
      const h = workerHealth(w, { now, blocker: byId.get(w.id) || null });
      return {
        id: w.id,
        label: w.label,
        runBy: w.runBy,
        ...h,
        word: HEALTH_WORD[h.health] || h.health,
        lastAttemptAt: w.lastAttemptAt ?? null,
        lastSuccessAt: w.lastSuccessAt ?? null,
      };
    })
    // Worst first. An alphabetical or insertion order would let a blocked
    // worker sit below three healthy ones, which is the shape of list people
    // stop reading after the first line.
    .sort((a, b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health]);

  const blocked = rows.filter((r) => r.health === HEALTH.BLOCKED);
  const late = rows.filter((r) => r.health === HEALTH.LATE);
  const never = rows.filter((r) => r.health === HEALTH.NEVER);
  const healthy = rows.filter((r) => r.health === HEALTH.HEALTHY);
  const unknown = rows.filter((r) => r.health === HEALTH.UNKNOWN);

  // Every distinct action, deduplicated — three workers blocked by one missing
  // token is ONE thing to do, not three.
  const actions = [];
  const seen = new Set();
  for (const r of [...blocked, ...never, ...late]) {
    if (!r.ownerAction || seen.has(r.ownerAction)) continue;
    seen.add(r.ownerAction);
    actions.push({ action: r.ownerAction, because: r.label, health: r.health });
  }

  return {
    rows,
    paused,
    counts: {
      healthy: healthy.length, late: late.length, blocked: blocked.length,
      never: never.length, unknown: unknown.length,
    },
    // The four questions, answered in words rather than left to be inferred.
    needsYou: actions.length,
    running: paused ? 0 : healthy.length,
    blocked: blocked.length + never.length,
    actions,
    headline: paused
      ? 'Automation is paused. Nothing new is being started.'
      : actions.length
        ? `${actions.length} thing${actions.length === 1 ? '' : 's'} need you.`
        : unknown.length
          ? `Nothing is failing, but ${unknown.length} worker${unknown.length === 1 ? '' : 's'} record no outcome, so this is not a full all-clear.`
          : healthy.length
            ? 'Everything is running.'
            : 'Nothing is running yet.',
  };
}
