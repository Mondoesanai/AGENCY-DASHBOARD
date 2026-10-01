# Verification Report

**Evidence, not claims.** A ticked box in `BUILD_PLAN.md` or a sentence in a commit
message is not verification. An entry belongs here only when a check was actually
executed and its result observed.

Verification levels used throughout:

| Level | Meaning |
|---|---|
| **L0 claimed** | Someone said it works. Carries no weight on its own. |
| **L1 unit** | Logic proven by an automated test against mocked dependencies. |
| **L2 integration** | Proven through the real application code path end to end, with external providers faked. |
| **L3 staging-live** | Executed against a real external provider in a non-production or safe context. |
| **L4 production-observed** | Observed working on live production data. |

Last updated: 2026-10-01 · Suite totals at this date: **468 automated checks, 0 failing**
(revision-state 46 · contacts 54 · card-intake 50 · budget 42 · inbox 85 · agent 101 ·
platform 59 · reports 31) plus **48 supervisor isolation checks, 0 failing**.

> Correction, same day: this line previously read "450". That was an addition error on my
> part — the per-suite figures were right and summed to 468. Recorded here rather than
> quietly edited, because a verification report that silently revises its own numbers is
> worth nothing.

---

## R1 — Existing dashboard repair

| Req | Check performed | Level | Result |
|---|---|---|---|
| R1.1 | Inventory of `api/`, `lib/`, `public/`, `tests/`, cron drivers, KV key space, hosting limits | L2 | Done. Recorded as the constraints table in `BUILD_PLAN.md`. Found the binding constraint: **12/12 Vercel Hobby functions already used**, so no new API files are possible. |
| R1.2 | Root cause of "revision checked repeatedly, still fails" traced in code | L2 | **Found and reproduced.** `agentStatus()` returns one flat list of decline reasons mixing permanent config problems with self-resolving ones; `runAgentCycle` returned `{skipped:true}` for all of them; `recordAttempt` logged "not eligible yet" and did nothing else. A ticket on a repo-less site was retried on **every tick, forever**. Observed live on the real Renewity ticket. |
| R1.3 | State machine with 8 states as a pure function | L1 | `lib/revision-state.js`; 46 checks in `tests/revision-state.test.mjs`. |
| R1.4 | Permanent vs transient classification; bounded backoff | L1 | Permanent causes block after one attempt (5 cause types checked). Transient retries are exponential, capped at 6h, then block. Content failures get fewer retries than network blips. |
| R1.5 | Actionable recovery text | L1 | Each permanent cause yields a named action (`link-repo`, `reconnect-github`, `check-repo`, `fix-permissions`, `enable-agent`, `add-ai-key`) with owner-readable wording. |
| R1.6 | Request preserved through block → fix → resume | **L2** | `tests/inbox.test.mjs` I12/I12b: six automation passes on a repo-less site leave it blocked with the request text intact, zero AI spend; after linking a repo and pressing Retry, the saved request is worked and the change lands in the repo. |
| R1.7 | Repo-mapping audit | — | **Not yet implemented.** |
| R1.8 | Existing flow verification | partial | Revisions, automations/scheduling, agent cycles and reporting are covered by the existing suites. Clients CRUD, analytics ranges/empty states, authz isolation, integration connect/disconnect and settings persistence are **not yet systematically verified**. |
| R1.9 | Shipped work never shows as failed | L1+L2 | State machine test R6; plus a real bug found and fixed during wiring — `resolveCompletedTickets` guarded on the legacy status string and would never have closed out a shipped-but-unverified ticket. |

### Supporting live production evidence (L4)

| What | Evidence |
|---|---|
| Gmail auto-filing | Backfill run against the real inbox: 200 scanned, 79 filed (70 Website Agent, 9 Clients), 121 unrelated left untouched. Revisions folder filled from 22 stored ticket ids → 19 labelled, 0 failures. |
| Revision pipeline repairs | Three separate real-world bugs found and fixed with regression tests: client replies in an existing thread silently dropped; the dashboard's own notification mail re-ingested as a client request; a manual ticket displaying "reply failed" when no reply was ever attempted. |

---

## R3 — Contacts and card intake

| Req | Check performed | Level | Result |
|---|---|---|---|
| R3.1 | Multi-card photo; front/back merge | L1 | Two businesses in one photo stay two contacts; front+back of one card merge into one with details combined. |
| R3.3 | Never invent a detail | L1 | Null fields stay null; no email is synthesised from a name plus a domain. |
| R3.4 | Confidence and review queue | L1 | An over-confident model claim (0.99) on an unparseable email is downgraded to needs-review and the raw reading is kept for the human. |
| R3.5 | CSV preview matches commit | L1 | Preview writes nothing; **a real bug was caught here** — a row with an invalid email created an unreachable contact that was invisible to dedup and duplicated on every re-import. Preview and commit now share one rule. |
| R3.9 | Dedup | L1 | Exact email merges; same phone/different name queues for review; **colleagues at the same business stay separate** (a real bug: dedup originally compared business names, flagging every colleague as their coworker's duplicate). |
| R3.11 | Consent/opt-out survive import, merge, delete, re-import | L1 | Opt-out cannot be cleared by an import; a hard bounce cannot be downgraded to valid; suppression survives deletion and re-import. |
| R3.12 | Meeting vs group membership | L1 | The weaker claim never escalates to "we met". |
| R3.6 | Voice notes | — | **Gap G5** — text notes implemented, voice capture path unspecified. |

---

## R8 — Budget

| Req | Check performed | Level | Result |
|---|---|---|---|
| R8.1/8.8 | $50/week limit actually stops at $50 | L1 | Exactly ten $5 jobs allowed, eleventh refused with a plain-English reason; spend lands exactly on the cap, remaining is 0 not negative. |
| R8.4 | Concurrency safety | L1 | **25 workers racing a $10 allowance: exactly 10 granted.** Committed money never exceeded the cap. |
| R8.3 | Estimate vs actual | L1 | A $20 estimate is held while running; reconciling at $3.50 releases the hold, books the real cost, and returns the unused estimate. |
| R8.2 | Double-charge protection | L1 | Reconciling the same reservation twice is ignored — a retried worker cannot charge twice. |
| R8.5/8.6 | Essentials and conversation reserve | L1 | With a $1 cap an opt-out still processes and is recorded, while discretionary work is refused. Cold discovery can use only 80% of the allowance; a conversational job may use the reserve. |
| R8.7 | Uncappable charges | L1 | `uncappableNote()` is present in the status payload and states plainly what the app cannot cap. |

---

## Supervisor (tooling, not product)

| Check | Level | Result |
|---|---|---|
| Config validated against the **bundled official schema** shipped with Claude Code v2.1.281 | L3 | Event → matcher-group → inner `hooks` array; all handler fields recognised; **VALID**. The owner correctly identified that the first version was invalid. |
| 41 isolation checks, all synthetic fixtures | L1/L2 | Wrong session ignored · wrong project rejected · malformed input · duplicate events · lock contention · pause/disable/completed · cycle and runtime caps · no-progress stop · blocked-plan stop · reviewer failure · prompt injection into the event payload. |
| Independent model review reachable | **L3** | `claude -p` with the bundled binary returns structured JSON using the owner's existing login — no API key. Fed a deliberately false claim ("I finished the entire acquisition system"), it **correctly flagged the contradiction** against the measured evidence. Cost reported by the provider: $0.0233. |
| Session binding evidence | L2 | Session id confirmed by locating strings written minutes earlier in exactly one transcript. **A second live session exists in this same project**, so a project-local hook alone would not have been sufficient isolation. |

### Plan/spec reconciliation (R12.1, R12.8)

| Check performed | Level | Result |
|---|---|---|
| Every spec requirement appears in `BUILD_PLAN.md`; every plan task maps to a spec requirement | L1 | **119 of 119 present, 0 missing, 0 extra.** Run by script against both files, so "no requirement was silently dropped" is measured, not asserted. |
| Plan status marks counted mechanically rather than by hand | L1 | 30 verified · 10 built-unverified · 6 in progress · 4 externally blocked · 70 not started. **My hand tally was wrong by 3 and was replaced by the measured figures.** |
| `[b]` introduced to separate *built* from *verified* | L1 | 10 items previously readable as finished are now explicitly marked built-but-unverified. This **lowered** the apparent completion figure on purpose. |
| Suite total recomputed | L1 | 468, not 450. Correction noted at the top of this file. |

### Supervisor bugs found by its own tests
1. `import.meta.url` percent-encodes spaces in the project path → every file operation failed with ENOENT; the hook would have silently done nothing forever.
2. `process.exit()` skips `finally` → the lock was never released after a successful cycle; the supervisor would have gone dead for 10 minutes after its first continuation.
3. Suppressing on `stop_hook_active` would have allowed exactly **one** continuation ever, silently killing cycles 2 and 3.
4. Duplicate detection keyed on message *length* wrongly swallowed genuinely different turns of the same length.
5. **Caught the same day it was introduced:** reconciling the build plan into requirement tables broke the plan parser, which only understood `- [ ]` bullets. It read **zero open items** from an 86-item backlog and would have declared the entire build COMPLETE and switched itself off. Parser now reads both shapes, ignores the status-key legend and the tally table, treats `[b]`/`[~]` as open work, and reports BLOCKED rather than COMPLETE when only owner decisions remain. Locked down by isolation section 16 (7 new checks).

---

## Not yet verified (honest list)

Everything below is **unimplemented or unverified**. No claim is made about it.

- R2 (all) — dashboard reorganisation
- R4 (all) — discovery and qualification
- R5 (all) — campaign workflows
- R6 (all) — email/SMS infrastructure. R6.11 SMS is deliberately off by owner decision.
- R7 (all) — replies and bookings
- R9 (all) — controlled improvement
- R10 (all) — reporting
- R11 — partially inherited from existing infrastructure, not systematically verified for the new system
- R12.4–R12.8 — load testing, simulated and real soak, browser/mobile inspection

**No integration is production-ready.** No outreach has been sent. No provider account
has been purchased or activated.
