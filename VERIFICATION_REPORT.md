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

Last updated: 2026-10-01 · Suite totals at this date: **686 automated checks, 0 failing**
(revision-state 46 · contacts 54 · card-intake 50 · budget 42 · inbox 85 · agent 101 ·
platform 59 · reports 31 · repo-audit 94 · flows 96 · governance 28) plus **48 supervisor
isolation checks, 0 failing**.

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
| R1.7 | Repo-mapping audit: identity, owner, branch, permissions, stale cached state | **L1+L2** | `lib/repo-audit.js`, 94 checks in `tests/repo-audit.test.mjs`. Detects: unusable repo strings (a bare name with no owner is **rejected, never guessed** at an owner), 404 vs 401 vs 403 as distinct causes, **rename via GitHub's redirect**, read-only token, archived repo, empty repo, and **two clients mapped to one repository**. Each fault maps to a cause the state machine classifies as permanent, proven by driving `transition()` four times and asserting BLOCKED + `isDue() === false`. L2: driven through the real registry, store and `agentStatus` against the faked GitHub — a stale name blocks the cycle, applying the safe fix repoints the client and unblocks it. |
| R1.7a | A transient fault is not treated as a broken mapping | L1 | A thrown socket error, a 502, and a missing GitHub connection are all warnings marked `transient`/`unchecked` and produce **no** block reason — treating a blip as "repo missing" would block a healthy client. |
| R1.7b | A suspicious repo↔domain match is uncertain, not a fault | L1 | Reported as a warning flagged `uncertain`, with wording that admits it is a guess from the name. A matching repo `homepage` clears it. |
| R1.7c | Auto-fix is limited to the unambiguous | L1 | Only a name GitHub itself just confirmed, a case difference, and a stale cached block auto-apply. Collisions, missing repos, permission faults and suspicious matches are reported for the owner; a 403 audit provably does **not** repoint the client. |
| R1.7d | Stale cached integration state | **L1+L2** | **Real bug found and fixed.** `agent:blocked:<slug>` held a repo failure for 12h and was cleared only by a later *successful* cycle, so repointing a client at the correct repo left the old repo's error in place — the site stayed ineligible for up to half a day after the problem was gone. `saveSiteConfig` now drops it when the repo changes; the audit's own verdict key carries no TTL, so it cannot lie in either direction. |
| R1.7e | The module is actually wired in, not an orphan | **L2** | Negative control: removing the two wiring edits fails exactly the 4 wiring tests (`agentStatus` refusing the cycle, the reason naming the fault, the block clearing on repoint, the site no longer held back) and nothing else. Consumers: `agentStatus`, `saveSiteConfig`, `runAutoTick` (6-hourly), `api/admin.js?do=repo-audit`. |
| R1.8 | Existing flow verification | partial | Revisions, automations/scheduling, agent cycles and reporting are covered by the existing suites. Clients CRUD, analytics ranges/empty states, authz isolation, integration connect/disconnect and settings persistence are **not yet systematically verified**. |
| R1.10 | Dependencies upgraded only for a demonstrated need | L2 | `package.json` is unchanged across every commit in this build: still three dependencies (`@anthropic-ai/sdk`, `@vercel/kv`, `resend`). Its last change predates this work and removed a dependency that was breaking the Vercel build. No upgrade has been made and none was needed. |
| R1.8 | End-to-end verification of the existing flows | **L2** | `tests/flows.test.mjs`, 96 checks driving the real API handlers (`api/site.js`, `api/sites.js`, `api/admin.js`, `api/finances.js`) through the real registry and store against faked providers. Covers clients create/read/update/delete, duplicate-host reuse, settings round-trip incl. clamping of out-of-range values, site/repo association, analytics ranges (7/30/90/0/-1/abc/99999 all handled), empty states, authorization and cross-client isolation, integration connect/disconnect reporting, and deployment/uptime status. **Found four real bugs — see the R11.7 rows below.** |
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
| R3.2 | Extract name, business, role, email, phone, website, address | L1 | `tests/card-intake.test.mjs`: a sparse card leaves `email` and `phone` as null rather than filling them — absent fields stay absent. |
| R3.7 | Provenance and relationship stored | L1 | `tests/contacts.test.mjs`: the meeting context is stored as given (`relationship`, `event`, `meetingNotes`) and never inferred; on a merge the stronger relationship claim wins. |
| R3.8 | Messaging state: eligibility, consent scope, suppression | L1 | `tests/contacts.test.mjs`: no consent refuses both promotional and one-time SMS; a one-time permission allows only the promised follow-up; a landline is refused even with consent; the latest grant is effective and a later withdrawal revokes it. |
| R3.10 | Merge review, never auto-merge | L1 | `tests/contacts.test.mjs`: same phone with a different person is held for review, the uncertain record stores what it might match, and nothing is merged automatically. |
| R6.13 | Consent per message type; one-time kept separate from ongoing marketing | L1 | Scope, source, timestamp, wording version and withdrawal are stored append-only; `one_time_followup`, `transactional` and `promotional` are non-interchangeable, proven by the refusals above. **Only the consent MODEL is verified — no SMS has been sent and Twilio is off by owner decision (R6.11).** |
| R3.6 | Voice notes | — | **Gap G5** — text notes implemented, voice capture path unspecified. |

---

## R8 — Budget

| Req | Check performed | Level | Result |
|---|---|---|---|
| R8.1 | $50/week limit actually stops at $50 | L1 | Exactly ten $5 jobs allowed, eleventh refused with a plain-English reason; spend lands exactly on the cap, remaining is 0 not negative. |
| R8.4 | Concurrency safety | L1 | **25 workers racing a $10 allowance: exactly 10 granted.** Committed money never exceeded the cap. |
| R8.3 | Estimate vs actual | L1 | A $20 estimate is held while running; reconciling at $3.50 releases the hold, books the real cost, and returns the unused estimate. |
| R8.2 | Central cost ledger across the seven spend categories | L1 | `lib/budget.js`: append-only daily ledger plus per-category monthly totals, held in cents so repeated additions cannot drift the way floats do; UTC period keys so a reset cannot land twice or be skipped. |
| R8.9 | Double-charge protection | L1 | Reconciling the same reservation twice is ignored — a retried worker cannot charge twice. |
| R8.5 | Essentials and conversation reserve | L1 | With a $1 cap an opt-out still processes and is recorded, while discretionary work is refused. Cold discovery can use only 80% of the allowance; a conversational job may use the reserve. |
| R8.8 | Period/spent/reserved/remaining/next reset; no weekly-monthly double counting | L1 | Weekly and monthly are proven to be two windows over the same money rather than two separate allowances, so spending is never counted twice; rollover is explicit and defaults to off. |
| R8.6 | Configurable conversation reserve | L1 | Cold discovery can draw only 80% of the allowance by default; a conversational job may use the reserved share. |
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

- R1.7 UI: the audit report is exposed at `?do=repo-audit` and persisted, but **nothing renders it in the dashboard yet** — that is R2.5
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

---

## R12 — Verification discipline

| Req | Check performed | Level | Result |
|---|---|---|---|
| R12.8 | A green build is never equated with functional verification | **L1** | Enforced by `tests/governance.test.mjs`, not by good intentions: the suite fails if any requirement is ticked without an evidence row at L1 or higher, if a requirement loses its acceptance criterion, if the plan's own tally disagrees with the measured counts, or if this report drops its honesty clauses. Four real drifts were caught the first time it ran — see below. |

### What the governance check caught on its first run

1. **Eleven requirements were ticked with no traceable evidence** (R1.10, R3.2, R3.7, R3.8, R3.10, R6.13, R8.1, R8.5, R8.6, R8.8, R12.8). Most were a formatting fault — two rows keyed `R8.1/8.8` and `R8.5/8.6` were untraceable per requirement, now split — but five genuinely had no row and have been given one citing the specific checks that cover them.
2. **Three acceptance criteria were too thin to fail against**: R9.6 read "Always", R11.3 "Bounded", R11.6 "Backoff". Strengthened, not removed.
3. **One requirement had been reduced to a single word**: R10.4 read "Filters". Restored to a testable statement.
4. **The plan's stated tally disagreed with the measured counts.** Corrected.

This is the mechanism the owner asked for: neither the builder nor the supervisor can now weaken a
requirement or drop evidence to declare completion, because the suite fails.

---

## R11.7 — Authorization (security findings from R1.8)

These were found by writing the flow tests, not by reading the code. All are fixed, with
regression checks that fail if the fix is reverted.

| Finding | Severity | Evidence | Status |
|---|---|---|---|
| **`/api/sites` had no authorization at all.** It returns every client's name, email, phone, monthly price, setup fee, expenses, private notes and changelog. Anyone who knew the deployment URL could read the entire client book. | **Critical** | L2 — an unauthenticated call now returns 401 with no `sites` array; an authenticated one still returns the dashboard's data. Checked in `tests/flows.test.mjs` F5/F8. | Fixed. Gated, and the dashboard now sends the stored password and shows the unlock prompt on a 401 instead of a generic "could not reach the API". |
| **Five copies of an auth gate that failed OPEN.** Each endpoint carried `if (!CRON_SECRET) return true`, so a missing secret — a typo, a new Vercel environment, a preview deployment, a bad rotation — would silently authorise *every* admin request, including `/api/finances`. | **Critical** | L1 — `authMode()` returns `locked` and `authed()` returns false whenever the app is deployed with no secret, verified for both `VERCEL` and `VERCEL_ENV`. Replaced by one gate in `lib/auth.js`. | Fixed, fails closed. |
| Secret comparison was a plain `===`, and a prefix of the real secret was never explicitly tested. | Low | L1 — comparison is now timing-safe; a prefix, an empty string and a missing credential are each refused. | Fixed. |
| A 401 said "bad password" even when the real cause was a deployment with no secret configured. | Low | L1 — `authError()` now names the actual cause. | Fixed. |
| An empty Add-site form created a phantom client called **"site"** at `https://site`. The `if (!slug)` guard could never fire, because `slugify()` falls back to the literal string `'site'`. | Medium | L2 — the handler now validates the input rather than the derived slug; an empty save returns 400. | Fixed. |
| `changelog-del` with no arguments wrote an empty array to the key `changelog:undefined` and reported success. A bad index reported a deletion that never happened. | Medium | L2 — both now return 400. | Fixed. |

**Mechanical guard:** `tests/governance.test.mjs` now fails if any file in `api/` neither checks
authorization nor appears on an explicit public allowlist with a stated reason, if any endpoint
defines its own competing auth gate again, or if the shared gate stops failing closed.

**Still not verified for R11.7:** safe logging has not been audited, so R11.7 stays open. No claim
is made that logs are free of credentials.
