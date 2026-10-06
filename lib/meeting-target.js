// "Six qualified meetings a week", as a control rather than a slogan.
//
// A target is only useful if it can be wrong in a direction the owner can act
// on, and only safe if it cannot quietly turn into pressure on people who did
// not ask to be contacted. Three rules hold this together:
//
//   1. PROGRESS IS MEASURED IN ATTENDED MEETINGS, not booked ones. A booking
//      somebody did not turn up to is not six-sevenths of a meeting; it is a
//      different outcome with a different cause.
//   2. THE TARGET GUIDES VOLUME, IT DOES NOT AUTHORISE IT. Being behind never
//      widens eligibility, never raises a sending cap, and never makes a
//      contact textable who was not already. It changes a recommendation on a
//      screen, and nothing else.
//   3. A SHORTFALL IS A QUESTION BEFORE IT IS AN ANSWER. "Six booked, four
//      no-shows" has at least six plausible causes and a sample of six cannot
//      distinguish them. Jumping to "change the wording" is how a confirmation
//      problem gets mistaken for a copy problem for a month.
//
// ON THE WEEK. Weeks start Monday in the owner's timezone, because a week that
// silently means "the last seven days" moves its own goalposts every time it
// is read, and a week in UTC puts Sunday evening in Texas into next week.

export const DEFAULT_TARGET = 6;
export const DEFAULT_TZ = 'America/Chicago';

/** Monday 00:00 in `tz`, as a timestamp. */
export function weekStart(now = Date.now(), tz = DEFAULT_TZ) {
  // Shift into the target zone, find Monday, then shift back. Done with the
  // Intl offset rather than a fixed -5/-6 so it stays right across DST.
  const d = new Date(now);
  const local = new Date(d.toLocaleString('en-US', { timeZone: tz }));
  const offset = d.getTime() - local.getTime();
  const dow = (local.getDay() + 6) % 7; // 0 = Monday
  local.setHours(0, 0, 0, 0);
  local.setDate(local.getDate() - dow);
  return local.getTime() + offset;
}

/** A readable description of the window being counted. */
export function describeWeek(now = Date.now(), tz = DEFAULT_TZ) {
  const start = weekStart(now, tz);
  const end = start + 7 * 86400e3;
  const fmt = (t) => new Date(t).toLocaleDateString('en-US', { timeZone: tz, month: 'short', day: 'numeric' });
  return { start, end, label: `Mon ${fmt(start)} – Sun ${fmt(end - 86400e3)}`, timezone: tz };
}

/**
 * Where the week stands.
 *
 * `attended` is the progress figure. `booked` is shown beside it because the
 * gap between them is the most informative number on the screen, but it is
 * never the one measured against the target.
 */
export function weekProgress(bookings = [], { now = Date.now(), tz = DEFAULT_TZ, target = DEFAULT_TARGET } = {}) {
  const { start, end, label } = describeWeek(now, tz);
  const inWeek = (bookings || []).filter((b) => b.startAt && b.startAt >= start && b.startAt < end);

  const attended = inWeek.filter((b) => b.status === 'attended').length;
  const noShow = inWeek.filter((b) => b.status === 'no-show').length;
  const cancelled = inWeek.filter((b) => b.status === 'cancelled').length;
  const upcoming = inWeek.filter((b) => b.status === 'scheduled' && b.startAt >= now).length;
  const unanswered = inWeek.filter((b) => b.status === 'scheduled' && b.startAt < now).length;

  return {
    target, timezone: tz, week: label, start, end,
    attended, noShow, cancelled, upcoming, unanswered,
    booked: inWeek.length,
    // measured against ATTENDED, deliberately
    remaining: Math.max(0, target - attended),
    onTrack: attended + upcoming >= target,
    // an unanswered past booking is counted as neither, and said so
    note: unanswered
      ? `${unanswered} meeting${unanswered === 1 ? '' : 's'} this week ${unanswered === 1 ? 'has' : 'have'} been and gone with no outcome recorded. They count as neither attended nor missed until somebody says.`
      : null,
  };
}

/**
 * What the target implies about volume — as a recommendation, never a
 * permission.
 *
 * Every number here is derived from the owner's OWN observed rates where they
 * exist. With too little history it refuses to extrapolate and says what it
 * would need, because a funnel estimate built on three events is a guess
 * wearing arithmetic.
 */
export function recommendedVolume(progress, history = {}, { minSample = 20 } = {}) {
  const need = progress.remaining;
  if (!need) {
    return { ok: true, need: 0, note: 'The target for this week is already met on attended meetings.' };
  }

  const invited = Number(history.invited || 0);
  const replied = Number(history.positiveReplies || 0);
  const booked = Number(history.booked || 0);
  const attended = Number(history.attended || 0);

  if (invited < minSample) {
    return {
      ok: false,
      need,
      reason: `only ${invited} invitation${invited === 1 ? '' : 's'} have been sent, so there is no reliable rate to work back from`,
      wouldNeed: `at least ${minSample} before a recommendation means anything`,
      // the honest fallback: a floor, clearly labelled as one
      note: 'Until then, the useful number is how many businesses are eligible to invite — not a funnel estimate.',
    };
  }

  const replyRate = replied / invited;
  const bookRate = replied ? booked / replied : 0;
  const attendRate = booked ? attended / booked : 0;
  const perInvite = replyRate * bookRate * attendRate;

  if (!perInvite) {
    return { ok: false, need, reason: 'no attended meeting has come from an invitation yet, so the chain cannot be estimated' };
  }

  return {
    ok: true,
    need,
    invitationsNeeded: Math.ceil(need / perInvite),
    basis: { invited, replyRate: +replyRate.toFixed(3), bookRate: +bookRate.toFixed(3), attendRate: +attendRate.toFixed(3) },
    // said plainly, because a recommendation that reads as an instruction is
    // how a target becomes pressure
    note: 'A recommendation, not a permission. It does not widen who may be contacted, raise a sending cap, or change anyone\'s consent.',
  };
}

/**
 * What a shortfall might actually be.
 *
 * Deliberately returns QUESTIONS, ordered by what the data can already rule in
 * or out, and refuses to name a winner. The worked example in the brief — six
 * booked, four no-shows — is a 33% attendance rate from six events, and six
 * events cannot distinguish a confirmation problem from a lead-fit problem
 * from ordinary variance.
 */
export function diagnoseShortfall(progress, detail = {}, { minSample = 20 } = {}) {
  const settled = progress.attended + progress.noShow;
  const questions = [];

  if (progress.unanswered) {
    questions.push({
      q: `${progress.unanswered} past meeting${progress.unanswered === 1 ? '' : 's'} have no outcome recorded`,
      why: 'Until these are answered the attendance rate is unknown, not low. This is the only item here that can be settled today.',
      action: 'Open Meetings and say whether each one happened.',
      settleable: true,
    });
  }

  if (settled >= 1 && progress.noShow > progress.attended) {
    questions.push({
      q: 'More people are not turning up than are',
      why: `That is ${progress.noShow} of ${settled}. Before changing anything, the data cannot yet separate: where the booking came from, how long the gap was between booking and meeting, whether a confirmation and a reminder were actually delivered, whether anyone rescheduled, and whether these were the right businesses to meet.`,
      action: 'Record those five things for the next few meetings. They are not currently captured well enough to compare.',
      settleable: false,
    });
  }

  if (detail.confirmationsSent != null && detail.confirmationsDelivered != null
      && detail.confirmationsSent > 0 && detail.confirmationsDelivered < detail.confirmationsSent) {
    questions.push({
      q: 'Some confirmations were not delivered',
      why: `${detail.confirmationsDelivered} of ${detail.confirmationsSent} arrived. A meeting nobody was reminded about is a different problem from a meeting nobody wanted.`,
      action: 'Check the delivery failures before touching the wording.',
      settleable: true,
    });
  }

  if (progress.booked === 0) {
    questions.push({
      q: 'Nothing was booked this week',
      why: 'A no-show problem and a no-booking problem have nothing in common, and this is the second one.',
      action: 'Look at invitations sent and replies received, not at meeting wording.',
      settleable: true,
    });
  }

  // the one bounded suggestion, explicitly a hypothesis
  const hypothesis = settled >= 1 && progress.noShow > 0
    ? {
      change: 'Send a short confirmation when the meeting is booked, and a reminder the morning of — to people who have permission on that channel.',
      why: 'It is the smallest change that addresses the most common cause, and it alters nothing about who is contacted.',
      label: 'HYPOTHESIS',
      caution: settled < minSample
        ? `This is a guess from ${settled} settled meeting${settled === 1 ? '' : 's'}. It is not supported by the data and must not be reported as a finding; ${minSample} would be the point at which the comparison means anything.`
        : `Compare attendance before and after across at least ${minSample} meetings either side.`,
      measure: 'attended ÷ settled meetings',
    }
    : null;

  return {
    questions,
    hypothesis,
    // refuses to conclude, and says why in the shape of the data
    verdict: settled < minSample
      ? `${settled} settled meeting${settled === 1 ? '' : 's'} is too few to conclude anything about why. Nothing here is a finding.`
      : null,
    sample: settled,
  };
}
