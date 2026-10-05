# What the supervisor actually did

From `.claude/supervisor/state.json` and `supervisor.log`, read 2026-10-05.
Nothing here is reconstructed from memory.

## Status now

| | |
|---|---|
| **Status** | `blocked` — not running, not paused |
| **Last decision** | `BLOCKED` at **2026-10-02T06:46:06Z** |
| **Stated reason** | *"Nothing left that does not need owner input. 119 verified, 1 waiting on external input: R6.4 Sender config + SPF/DKIM/DMARC guidance"* |
| **Window** | activated **2026-10-01T21:29:50Z**, 48h, deadline **2026-10-03T21:29:50Z** |
| **Window state** | **expired** — the deadline passed two days before this report |
| **Renewals** | **0.** It never renewed itself, as instructed |

## It did NOT run for 48 hours

This is the number most likely to be misread, so it is stated plainly.

* Activation to final cycle: **9 hours 16 minutes** (21:29:50Z → 06:46:06Z).
* **42 cycles** of a 400 cap.
* It then stopped because there was nothing left it could do without the owner
  — not because the window ended, and not because it failed.
* The remaining ~38 hours of the authorised window were never used.

Anyone describing this as "48 hours of continuous supervised development"
would be wrong on both counts: it was about nine hours, and it was not
continuous.

## Continuations and interruptions

`state.json` keeps the last 25 cycles (18–42). Across those:

| | |
|---|---|
| Automatic continuations | **24** (`CONTINUE`) |
| Blocked | **1** (the final cycle) |
| Recorded failures | **0** |
| Cycles with no progress | **0** at the end |

Every recorded cycle advanced something: the test total rises monotonically
across the history, from 1,738 at cycle 18 to 4,090 at cycle 42.

**It was interrupted and restarted early on.** Between 22:19 and 23:04 on
2026-10-01 the log records repeated stops with the reason *"two consecutive
cycles with no change to the repository, the checklist, or the test count"* —
its own no-progress guard firing — followed by resumed cycles. Those restarts
were manual. After cycle 18 the run was clean.

Two gaps in the cycle record are worth naming rather than smoothing over:

* cycle 40 → 41: **162 minutes**
* cycle 35 → 36: **107 minutes**

Both are longer than a working cycle and neither is explained in the state
file. They are consistent with the session being idle rather than with a
failure, but the logs do not establish that, so it is not claimed.

## Isolation held

* The supervisor is bound to session `939cd2ef…` and project
  `C:/Users/mondo/Inspiring Websites website`.
* On **2026-10-05T19:07:01Z** the log records
  `IGNORED session 9672945b (bound: 939cd2ef)` — a different session was
  refused, three days after the deadline.
* A separate project (`personal-agent`) routes to its own `state-jarvis.json`.
  The other session was not affected.

## A caveat about the log

`supervisor.log` is a **single shared file** written by every run on this
machine: this project's cycles, the `personal-agent` project, and the
supervisor's own `isolation.test.mjs` fixtures. So the raw counts in it
(283 CONTINUE / 248 STOP / 67 BLOCKED) **are not this project's run** — they
include synthetic test entries such as *"trial limit reached: 3 continuations"*
and *"cannot read the build plan at C:/definitely…"*.

The authoritative per-project record is `state.json`. Where this report gives a
number, it comes from there.

## Usage

| | |
|---|---|
| `devSpendUsd` in state | **2.5259** |
| What that is | the supervisor's **own running estimate** of model spend for its reviewer calls |
| What it is **not** | **a bill.** No invoice, no metered statement, no reconciliation against an account |

The state file also carries this note verbatim:

> *"Development usage is whatever this session consumes on the owner's Claude
> plan. No separate metering is available to this process, so no dollar figure
> is claimed."*

That note and the `devSpendUsd` figure contradict each other, and the note is
the one to believe: **$2.53 is an estimate produced by the thing being
measured, not billing.** The actual cost of this work is whatever the session
consumed on the owner's plan, which this process cannot see.

No credits were bought, no paid overage was enabled, and the acquisition app's
operating-budget key was not used.
