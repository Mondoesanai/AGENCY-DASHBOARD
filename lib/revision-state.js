// The revision state machine.
//
// WHY THIS EXISTS — the bug it fixes:
//
// A revision ticket's real state used to be spread across four places: the
// ticket's own `status` string, the `agent:revfail:<todoId>` counter, the
// `agent:revgaveup:<todoId>` flag, and whether the to-do still existed in
// `todos:<slug>`. Reading "what is actually happening to this request" meant
// cross-referencing all four, which is how a finished revision could still be
// displayed as failed, and how a ticket could look queued forever.
//
// Worse: every reason the agent declined to work a ticket was treated the
// same. `agentStatus()` returns a flat list of strings mixing three different
// kinds of thing —
//
//   "no GitHub repo set (Settings → Automation)"   <- permanent. A human must act.
//   "paced — next attempt in ~20h"                 <- temporary by design. Will self-resolve.
//   "this month's budget is used ($23.85 / $20)"   <- self-resolves at month rollover.
//
// — and `runAgentCycle` returned `{skipped:true}` for all of them, so
// `recordAttempt` wrote "not eligible yet" and nothing else happened. No
// failure counted, nothing blocked, no recovery action shown, no escalation.
// A ticket on a site with no linked repo was therefore retried on EVERY tick,
// forever, writing a new "Last attempt: not eligible yet" line each time while
// the client waited. That is the "checked repeatedly and still fails with
// repository eligibility errors" symptom.
//
// This module makes state explicit and classifies WHY work stopped, so a
// permanent configuration failure blocks with an actionable recovery step
// instead of retrying until someone notices.

export const STATES = Object.freeze({
  QUEUED: 'queued', // accepted, waiting its turn
  VALIDATING: 'validating', // checking the site/repo/integration can actually be worked
  RUNNING: 'running', // the agent is mid-cycle on it
  AWAITING_REVIEW: 'awaiting_review', // shipped, waiting on the live-site QA check or a human look
  SUCCEEDED: 'succeeded', // live and confirmed
  RETRYABLE: 'retryable', // failed, will try again after nextAttemptAt
  BLOCKED: 'blocked', // will NOT retry on its own — needs a human action first
  CANCELLED: 'cancelled', // closed without doing it
});

const TERMINAL = new Set([STATES.SUCCEEDED, STATES.CANCELLED]);
export const isTerminal = (s) => TERMINAL.has(s);
// blocked is NOT terminal: it resumes the moment the blocking condition is fixed
export const isOpen = (s) => !TERMINAL.has(s);

// Legacy `status` values the dashboard UI and the existing tests still read.
// Every state maps onto one so nothing downstream breaks while both exist.
export function legacyStatus(state) {
  switch (state) {
    case STATES.SUCCEEDED:
      return 'done';
    case STATES.CANCELLED:
      return 'cancelled';
    case STATES.AWAITING_REVIEW:
    case STATES.BLOCKED:
      return 'needs attention';
    default:
      return 'scheduled';
  }
}

// ---------------------------------------------------------------------------
// Why did work stop? Classify the reason text the agent/cycle gave back.
//
// `permanent: true` means retrying changes nothing — the condition cannot
// clear without a human doing something. Those become BLOCKED with a recovery
// action, never a retry loop.
//
// `selfResolving: true` means it WILL clear on its own at a known time (pacing
// windows, monthly budget reset, daily failure cooldown). Those stay QUEUED —
// they're not failures and must not burn the retry budget.
// ---------------------------------------------------------------------------

const RULES = [
  {
    kind: 'no-repo',
    permanent: true,
    test: /no GitHub repo set|repo not set|no repository/i,
    recovery: {
      action: 'link-repo',
      label: 'Link this site’s GitHub repository',
      hint: 'Open the site → Settings → Automation and choose its repository. The queued request stays and resumes automatically once it’s linked.',
    },
  },
  {
    kind: 'no-github-token',
    permanent: true,
    test: /GITHUB_TOKEN not set|github token/i,
    recovery: {
      action: 'reconnect-github',
      label: 'Reconnect GitHub',
      hint: 'GITHUB_TOKEN is missing in Vercel. Add it, then this resumes automatically — nothing needs re-sending.',
    },
  },
  {
    kind: 'repo-unreachable',
    permanent: true,
    test: /github 404|not found|repository (is )?(empty|missing|gone)|could not read repo|repoEmpty/i,
    recovery: {
      action: 'check-repo',
      label: 'Check the repository still exists and the token can see it',
      hint: 'The linked repository could not be read. It may have been renamed, deleted, made private, or the token’s access revoked.',
    },
  },
  // R1.7 mapping faults. Both are permanent: retrying cannot fix a name that
  // is out of date, and retrying a shared repository would only do the damage
  // again. They are separate from repo-unreachable because the thing the owner
  // has to DO is different in each case.
  {
    kind: 'repo-renamed',
    permanent: true,
    test: /repo renamed on github|now resolves to|stored name is out of date/i,
    recovery: {
      action: 'check-repo',
      label: 'Confirm the repository’s new name',
      hint: 'GitHub reports this repository under a different name now. Until the stored name is updated, work could land in the wrong place if someone reuses the old name.',
    },
  },
  {
    kind: 'repo-collision',
    permanent: true,
    test: /repo mapping conflict|linked to the same repository/i,
    recovery: {
      action: 'check-repo',
      label: 'Give each client their own repository',
      hint: 'More than one client points at this repository, so a change request from one would edit another client’s website. Nothing will be worked until each client has its own.',
    },
  },
  {
    kind: 'permission',
    permanent: true,
    test: /github 40[13]|permission|forbidden|not authori[sz]ed|insufficient/i,
    recovery: {
      action: 'fix-permissions',
      label: 'Grant the token write access to this repository',
      hint: 'The token can see the repo but can’t write to it. Re-issue it with Contents: read & write for this repository.',
    },
  },
  {
    kind: 'agent-off',
    permanent: true,
    test: /agent (is )?turned off/i,
    recovery: {
      action: 'enable-agent',
      label: 'Turn the automation back on for this site',
      hint: 'Automation is switched off for this site, so queued requests won’t be worked.',
    },
  },
  {
    kind: 'no-ai-key',
    permanent: true,
    test: /no Anthropic key/i,
    recovery: {
      action: 'add-ai-key',
      label: 'Add the Anthropic API key',
      hint: 'ANTHROPIC_API_KEY is missing in Vercel, so no work can be planned.',
    },
  },
  // --- self-resolving: not failures, must not count against retries ---
  { kind: 'paced', permanent: false, selfResolving: true, test: /^paced\b|spreading the work out|a cycle just ran/i },
  { kind: 'budget', permanent: false, selfResolving: true, test: /budget is used|budget.*\$/i },
  { kind: 'already-running', permanent: false, selfResolving: true, test: /already running/i },
  // --- transient: worth retrying with backoff ---
  {
    kind: 'transient',
    permanent: false,
    test: /timeout|timed out|aborted|ETIMEDOUT|ECONNRESET|socket hang up|rate limit|429|50[0234]|temporarily|try again/i,
  },
  // --- content: the model couldn't produce a usable, safe change ---
  {
    kind: 'content',
    permanent: false,
    test: /safety check|keyword stuffing|did not match the expected|cut off|token limit|could not parse|FIND text/i,
  },
  // --- blocked by the work itself being impossible via a file edit ---
  {
    kind: 'not-file-editable',
    permanent: true,
    test: /can'?t do .* by editing files|not .* a file edit|third-party dashboard|stored in a (database|CMS)|requires the client'?s/i,
    recovery: {
      action: 'owner-review',
      label: 'This needs a person — it isn’t a file change',
      hint: 'The request depends on something outside the site’s code (a third-party dashboard, a live database value, DNS, or billing).',
    },
  },
];

export function classifyReason(text) {
  const s = String(text || '').trim();
  if (!s) return { kind: 'unknown', permanent: false, selfResolving: false, recovery: null };
  for (const r of RULES) {
    if (r.test.test(s)) {
      return { kind: r.kind, permanent: !!r.permanent, selfResolving: !!r.selfResolving, recovery: r.recovery || null };
    }
  }
  return { kind: 'unknown', permanent: false, selfResolving: false, recovery: null };
}

// ---------------------------------------------------------------------------
// Bounded retries with exponential backoff.
// Content failures get fewer tries than transient ones — a model that produced
// an unusable plan twice will usually do it again, whereas a network blip
// genuinely is worth another go.
// ---------------------------------------------------------------------------

export const MAX_ATTEMPTS = Object.freeze({ transient: 5, content: 3, unknown: 3 });
const BASE_DELAY_MS = 10 * 60 * 1000; // 10 min
const MAX_DELAY_MS = 6 * 60 * 60 * 1000; // 6 h

export function backoffMs(attempt) {
  return Math.min(BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)), MAX_DELAY_MS);
}

export function maxAttemptsFor(kind) {
  return MAX_ATTEMPTS[kind] ?? MAX_ATTEMPTS.unknown;
}

/**
 * The single transition function. Given where a ticket is and what just
 * happened, decide where it goes next. Pure — no I/O, so it is directly
 * testable and the same logic can run from the agent, the inbox check, or a
 * manual retry.
 *
 * @param {object} ticket  current ticket ({state, attempts, ...})
 * @param {object} event   {type, reason, at}
 *   type: 'claim' | 'validated' | 'shipped' | 'verified' | 'rejected'
 *       | 'failed' | 'ineligible' | 'cancel' | 'retry' | 'manual-done'
 * @returns {object} patch to merge onto the ticket
 */
export function transition(ticket, event) {
  const now = event.at || Date.now();
  const state = ticket.state || STATES.QUEUED;
  const attempts = Number(ticket.attempts) || 0;

  switch (event.type) {
    case 'claim':
      return { state: STATES.RUNNING, startedAt: now, stateReason: null };

    case 'validated':
      return { state: STATES.RUNNING, stateReason: null, blockedBy: null };

    case 'shipped':
      // shipped but not yet confirmed on the live site
      return { state: STATES.AWAITING_REVIEW, shippedAt: now, stateReason: null, blockedBy: null, attempts: 0 };

    case 'verified':
      return { state: STATES.SUCCEEDED, doneAt: now, stateReason: null, blockedBy: null };

    case 'rejected':
      // QA looked at the live site and it doesn't reflect the request
      return { state: STATES.AWAITING_REVIEW, stateReason: event.reason || 'the live site does not reflect this yet', needsOwner: true };

    case 'manual-done':
      return { state: STATES.SUCCEEDED, doneAt: now, stateReason: null, blockedBy: null, needsOwner: false };

    case 'cancel':
      return { state: STATES.CANCELLED, doneAt: now, stateReason: event.reason || null, needsOwner: false };

    case 'retry':
      // explicit human retry always gets a clean slate — that's the point of
      // the button: "I fixed the thing that was blocking it"
      return { state: STATES.QUEUED, attempts: 0, nextAttemptAt: 0, stateReason: null, blockedBy: null, needsOwner: false };

    case 'ineligible': {
      // the cycle declined to work it. WHY decides what happens.
      const c = classifyReason(event.reason);
      if (c.permanent) {
        return {
          state: STATES.BLOCKED,
          stateReason: event.reason || null,
          stateKind: c.kind,
          blockedBy: c.recovery,
          needsOwner: true,
          blockedAt: ticket.blockedAt || now,
        };
      }
      // self-resolving (pacing, budget, already-running) — NOT a failure.
      // Stay queued, don't touch the attempt count, don't escalate.
      return { state: STATES.QUEUED, stateReason: event.reason || null, stateKind: c.kind };
    }

    case 'failed': {
      const c = classifyReason(event.reason);
      if (c.permanent) {
        return {
          state: STATES.BLOCKED,
          stateReason: event.reason || null,
          stateKind: c.kind,
          blockedBy: c.recovery,
          needsOwner: true,
          blockedAt: ticket.blockedAt || now,
        };
      }
      const n = attempts + 1;
      const max = maxAttemptsFor(c.kind);
      if (n >= max) {
        return {
          state: STATES.BLOCKED,
          attempts: n,
          stateReason: event.reason || null,
          stateKind: c.kind,
          needsOwner: true,
          blockedAt: now,
          blockedBy: {
            action: 'owner-review',
            label: `Tried ${n} times and couldn’t complete it`,
            hint: 'Automatic retries have stopped so they don’t keep spending. Fix whatever’s in the way, then press Retry.',
          },
        };
      }
      return {
        state: STATES.RETRYABLE,
        attempts: n,
        stateReason: event.reason || null,
        stateKind: c.kind,
        nextAttemptAt: now + backoffMs(n),
      };
    }

    default:
      return {};
  }
}

/** Is this ticket due to be worked right now? */
export function isDue(ticket, now = Date.now()) {
  const state = ticket.state || STATES.QUEUED;
  if (state === STATES.QUEUED || state === STATES.VALIDATING) return true;
  if (state === STATES.RETRYABLE) return now >= (Number(ticket.nextAttemptAt) || 0);
  return false; // running, awaiting review, blocked, succeeded, cancelled
}

/** One short line a non-technical owner can act on. */
export function explain(ticket) {
  const state = ticket.state || STATES.QUEUED;
  switch (state) {
    case STATES.QUEUED:
      return ticket.stateKind === 'paced' || ticket.stateKind === 'budget'
        ? `Waiting — ${ticket.stateReason}`
        : 'Queued, waiting its turn.';
    case STATES.VALIDATING:
      return 'Checking this site can be worked on.';
    case STATES.RUNNING:
      return 'Working on it now.';
    case STATES.AWAITING_REVIEW:
      return ticket.needsOwner ? `Shipped, but needs your eyes — ${ticket.stateReason || 'the automatic check wasn’t sure'}` : 'Shipped — confirming it on the live site.';
    case STATES.SUCCEEDED:
      return 'Done and live.';
    case STATES.RETRYABLE: {
      const mins = Math.max(1, Math.round(((Number(ticket.nextAttemptAt) || 0) - Date.now()) / 60000));
      return `Didn’t work that time — trying again in about ${mins} min.`;
    }
    case STATES.BLOCKED:
      return ticket.blockedBy?.label ? `Stopped: ${ticket.blockedBy.label}` : `Stopped — ${ticket.stateReason || 'needs a look'}`;
    case STATES.CANCELLED:
      return 'Cancelled.';
    default:
      return '';
  }
}

/**
 * Backfill: derive a state for tickets created before this module existed, so
 * old tickets display correctly instead of all collapsing to "queued".
 */
export function deriveLegacyState(t) {
  if (t.state) return t.state;
  if (t.status === 'done') return STATES.SUCCEEDED;
  if (t.status === 'cancelled') return STATES.CANCELLED;
  if (t.status === 'needs attention') {
    const c = classifyReason(t.verify?.note || t.lastAttempt?.reason || '');
    return c.permanent || t.verify?.verified === false ? STATES.BLOCKED : STATES.AWAITING_REVIEW;
  }
  return STATES.QUEUED;
}
