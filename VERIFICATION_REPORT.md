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

Last updated: 2026-10-01 · Suite totals at this date: **1675 automated checks, 0 failing**
(revision-state 46 · contacts 54 · card-intake 50 · budget 42 · inbox 85 · agent 101 ·
platform 59 · reports 31 · repo-audit 94 · flows 103 · governance 31 · nav 44 · discovery 151 ·
outreach 46 · acquisition-ui 128 · inbox-ui 41 · bookings 57 · reporting 62 · jobs 65 · webhooks 50 · campaigns 97 · recheck 47 · replies 74 · knowledge 83 · campaign-flow 52) plus **71 supervisor
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
- R2.2–R2.9 — the rest of the dashboard reorganisation (R2.1 nav is done)
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

---

## R2 — Dashboard organisation

| Req | Check performed | Level | Result |
|---|---|---|---|
| R2.1 | Task-based top-level navigation | **L1+L2** | `public/nav.js`, 44 checks in `tests/nav.test.mjs`. Five sections in the specified order. Routing is a pure function, so it is tested without a browser: `#clients`, `clients`, `#/clients`, `#clients?from=email` and `#Clients` all resolve; an empty, missing, unknown or hostile hash resolves to Overview rather than hiding every section. Exactly one section is visible at any time, `aria-current` follows the active tab, a deep link opens its section on load, and a page without the nav host returns null instead of throwing. L2: rendered on localhost and screenshotted in both the default and deep-linked states. |
**On R2.9** (no fake metrics, unknown never shown as zero): the Acquisition section states
"Not built yet", names what exists underneath without a screen, and names the two owner
decisions blocking it, rather than rendering a zeroed dashboard that would read as "no
prospects yet". That is **one section honouring R2.9, not R2.9 satisfied** — the requirement
covers every screen, so it stays open and unticked until the rest of Part 2 is built.

### Breaks caught before shipping
1. `#seoOverview` was nested inside `#mainView`, which `openSeoOverview()` hides — the SEO overview page would have gone blank. Moved back out as a full-page takeover.
2. The money and receipts panels moved into Settings, so opening them from the header had to route there first; otherwise they rendered inside a hidden section and the button appeared to do nothing.

**Not verified:** no cross-browser or real-mobile check has been run (R12.7). Only a desktop viewport was inspected.

---

## R4 — Discovery and qualification (G3)

Suite: `tests/discovery.test.mjs`, 107 checks.

| Req | Check performed | Level | Result |
|---|---|---|---|
| R4.2 | The source's terms permit collection, **storage** and outreach use | **L3** | Official policy read, not assumed. Google Places states "You must not pre-fetch, cache, or store Places API content beyond the allowed exceptions", with place ID the only field storable indefinitely — it therefore **fails the storage requirement and is not used**. OpenStreetMap via Overpass is used instead: ODbL 1.0 permits storage, adaptation and commercial use with attribution, and imposes no field-of-use restriction. Attribution is carried on every stored prospect and shown in the UI. |
| R4.1 | Geography, industries, exclusions and weekly volume are editable | L1+L2 | `lib/settings.js` + a Targeting screen. Verified that a Chicago business and an untargeted trade both fall outside the configured targeting. |
| R4.3 | Source adapter layer, provider swappable | L1 | `createOverpassAdapter` takes an injected fetch, so all 107 checks run against fixtures. It needs no credential, so it is genuinely connected rather than a mock displayed as connected. |
| R4.4 | A real adapter, never a mock shown as connected | L1 | The Overpass adapter requires no credential, so it reports itself connected truthfully; the disconnected path is modelled separately and refuses every call. |
| R4.6 | identity → real website → evidence → status | L1 | Four states: verified-present · not-linked-in-listing · inaccessible · uncertain. A page that loads but mentions nothing about the business is **uncertain**, not present. |
| R4.7 | A missing listing link is not "no website" | **L1** | The wording is fixed in code: *"I couldn't find a website linked from your OpenStreetMap listing"*, carried with an explicit note that it is **NOT evidence the business has none**. A test asserts the phrase "has no website" cannot appear. |
| R4.8 | Conservative crawling, no form submission | L1 | One page per prospect, 12s timeout, 300KB cap, no POSTs. |
| R4.9 | Evidence stored, findings separate from hypotheses | L1 | Source URL, timestamp, raw OSM tags and licence stored per prospect; the observation string is kept apart from the derived segment. |
| R4.10 | No unsupported performance claims | **L1** | Asserted that no output can contain a lost-revenue, conversion-rate or broken-form claim. |
| R4.11 | No duplicate discovery | L1 | Identity key resolves domain → phone → name+city; the same business from two different sources collides deliberately. |
| R11.9 | SSRF protection | L1 | localhost, 127.x, 10.x, 192.168.x, 172.16-31.x, 169.254.169.254, `file://` and non-standard ports all blocked before any fetch. |
| R4.5 | Decision-makers only where evidence supports | — | Implemented later the same day — see the R4.5 row at the end of this file. |

## R6 — Cold email (G2)

Suite: `tests/outreach.test.mjs`, 46 checks.

| Req | Check performed | Level | Result |
|---|---|---|---|
| R6.1 | A provider whose terms permit cold outreach | **L3** | Instantly selected, documented against its official v2 API (`https://api.instantly.ai/api/v2`, bearer auth, `POST /campaigns`, `POST /leads/bulk` max 1000/request, `PATCH /campaigns/:id/activate`, `GET /emails` at 20 req/min). **Account and API key remain externally blocked (G2).** |
| R6.2 | Prospecting separated from transactional client mail | L1 | Resend is recorded **in code** as unsuitable for prospecting, with the reason (a complaint would endanger the account that delivers client reports). A test asserts that record stays. |
| R6.3 | Domain separation explained accurately | L1 | Documented that a separate sending domain limits blast radius but does **not** make cold email safe or prevent account termination. |
| R6.13 | Consent scopes honoured by the send gate | L1 | An opted-out contact is refused even when the provider, domain, pricing, targeting and owner switch are all correctly set — consent is checked first. |
| R11.2 | Idempotent sending | L1 | A second send of the same campaign to the same contact is refused as already-sent; a different campaign is still allowed. |
| R6.15 | Production outreach inactive by default | **L1** | Five independent blockers (credentials, sending domain, pricing, confirmed targeting, owner activation). Nothing in application code can set `outreach.active`; the test has to write storage directly to simulate the owner's switch, and it puts it back to off. |
| — | Documented rate limits respected | L1 | 2,300 leads are split into 3 requests within the documented 1000 limit — **all 2,300 sent, none truncated**. A 429 is reported as transient, never as success. |

## R2.3 / R2.9 — the Acquisition section

Suite: `tests/acquisition-ui.test.mjs`, 62 checks, plus a real browser run.

| Check | Level | Result |
|---|---|---|
| R2.3 | Four working screens over existing backends | L1 | Contacts · Add contacts (card OCR, CSV, manual) · Prospects · Targeting & pricing. The card-OCR and CSV backends existed and were tested but had **no way in** until now. |
| Empty is never a confident zero | L1 | "No contacts yet" names where contacts come from; "Nothing searched yet" states explicitly that it is *not the same as there being no businesses to find*. |
| Low-confidence OCR cannot become a contact silently | L1 | Flagged fields are marked, the scan says nothing is saved yet, and saving is a separate action that submits the human's corrections rather than the raw OCR. |
| A disconnected provider never reads as connected | L1 | Three distinct states: not connected · connected, not activated · ready. |
| Pricing unset renders as unset | L1 | A "not set" placeholder, never `0`. |
| **Browser verification, desktop (1440) and mobile (390)** | **L2** | 5 nav buttons render; every tab shows exactly **one** section; **no horizontal overflow at either width**; **no JavaScript console errors** (only expected 404s where no local API exists). Screenshots captured for both. |

### Found by the browser run, not by the test suite
1. **Overview rendered zero characters when the feed failed.** The error message only ever landed in the Clients list, so Overview looked like a silent success. Fixed — it now shows the same message (R2.5).
2. "Targeting & pricing" was clipped off the right edge at 390px. The tab row now wraps.

**Still not verified:** no real device, no cross-browser run (Chrome only), and no screen reader pass.

---

## R5 — Campaigns

Suite: `tests/campaigns.test.mjs`, 72 checks.

| Req | Check performed | Level | Result |
|---|---|---|---|
| R5.1 | Cold email: verified name, one real observation, truthful offer, sender identity, opt-out | **L1** | The composer assembles from fixed fragments chosen by the prospect's verified web status, so the only free text is the business name and the owner's own details. Asserted that it cannot emit: invented familiarity ("good to meet you", "as we discussed"), urgency ("act now", "limited time"), testimonials or percentage results, or any claim about lost revenue, conversion rate, broken forms or rankings. CAN-SPAM essentials are present and an incomplete sender identity **blocks the message entirely**. |
| — | A business with a working website produces **no cold message at all** | **L1** | `observationFor()` returns null for `verified-present` and for `uncertain`, and `composeCold` then refuses with the status named. There is nothing honest to open with, so nothing is written. |
| R5.2 | Never claim a preview exists unless one does | **L1** | A preview is mentioned only when `exists` is true. Passing `{exists:false, url:'…'}` produces a message with no mention of it and `mentionsPreview === false` — a URL alone is not permission to claim one. |
| R5.3 | Restrained, editable, bounded cadence | L1 | Intro + ≤2 follow-ups cold, ≤1 reminder warm; gap clamped to 2–30 days. Clamping is **explained** (`cadenceNotes`), not silent, and garbage input falls back to the default rather than NaN. |
| R5.4 | Stop on reply / opt-out / bounce / booking | **L1** | `stopContact` drops every pending send across **every** campaign the contact is in, not just the current one — a queued follow-up firing after someone replies is the worst thing this system could do. Verified: a stopped member is not due a month later, and `markStepSent` cannot resurrect them. An opted-out contact cannot be added to a campaign at all. |
| R5.5 | Warm follow-up based on recorded context | L1 | The opener comes from the stored relationship. |
| R3.12 (again, in campaign copy) | "Met in person" vs "same networking group" | **L1** | A shared-group contact gets *"I don't think we've actually met"*, and the phrase "good to meet you" is asserted absent. A contact with no recorded relationship produces **no warm message**. |
| R5.8 | No escalation from unanswered email to SMS | L1 | `mayEscalateToSms()` exists and refuses, so the prohibition is testable rather than merely absent. |
| R6.5 | Business-local sending window | L1 | 2pm Wednesday sends; 3am and all day Saturday are **held**, with the hold explained. A draft campaign has nothing due and says why. |
| G1 in copy | Price quoted only when configured | L1 | Unset pricing yields no price sentence and no stray `$undefined`/`$0`. |

**Not done in R5:** R5.9 (periodic website recheck creating an internal opportunity) and the
campaign-side halves of R5.6/R5.7 — the consent scopes they depend on exist and are tested in
`lib/contacts.js`, but no SMS sequence exists to be prevented from running yet.

---

## R5 reachable — the orphan correction

The independent reviewer flagged that `lib/campaigns.js` was tested in isolation with
"no user-facing screens, API endpoints, or end-to-end workflows". It was right, and it
was the rule I had written myself: *code that is never called from anywhere is not
implemented*. The R5 ticks were **downgraded to `[b]` before any new work was started**,
then earned back.

Suite: `tests/campaign-flow.test.mjs`, 43 checks, all driving the real `api/admin.js`.

| Check performed | Level | Result |
|---|---|---|
| Every campaign endpoint is password-gated | **L2** | All six return 401 unauthenticated. |
| A campaign is created through the API as a **draft** | **L2** | Never running on creation. An unsafe cadence (0 days, 50 follow-ups) is clamped and the clamping is **reported back to the operator**, not applied silently. An unknown type is a 400. |
| Preview shows the exact words and sends nothing | **L2** | `W.emails.length === 0` asserted after every preview. With no sender identity the API refuses and names CAN-SPAM; with it set, the message carries the postal address and quotes the configured price. |
| A business with a verified website produces **no message**, through the API | **L2** | The endpoint returns `ok:false` with the status named. The screen presents this as the system working, not as an error. |
| Enrolment refuses what it should | **L2** | Four distinct refusals, each with a reason an operator can read: no email on the listing ("we do not guess one from the domain"), wrong segment for the campaign type, already enrolled, prospect not found. |
| A draft has nothing due; starting it makes work due | **L2** | And an invalid status is a 400. |
| An opt-out is permanent | **L2** | Pending sends cancelled, never due again, and **cannot be re-enrolled** afterwards. |
| The screen leads with whether anything can be sent | L1 | Blockers listed at the top, with "composing is safe, sending is what is gated" so the operator is not left guessing. |
| Browser, desktop + mobile | **L2** | Five tabs, one section visible per tab, no horizontal overflow, no JS console errors. |

**R6.9 sender identity** was added as part of this: stored as settings, blank by default,
so a missing postal address blocks the message rather than shipping a placeholder into
real mail.

| R3.6 | Manual entry with meeting notes | **L2** | `tests/campaign-flow.test.mjs` E7, through `?do=contacts-save`: notes and relationship are stored against the contact and are what `composeWarm` actually draws on. **An invented relationship value ("we definitely had lunch") is rejected and stored as `none`**, after which no warm message can be written at all. Notes without a relationship keep the note but still record `none`, so a note can never imply a meeting. The spec says "text **or** voice"; text is implemented, voice capture remains an unspecified enhancement (G5). |

| R4.5 | Decision-makers only where evidence supports it; private details never guessed | **L1+L2** | `tests/discovery.test.mjs` S11–S15, 31 checks. **30+ role mailboxes** (`info@`, `office@`, `dispatch@`, `estimates@`, `bookings@`…) classify as shared and can never name a person — including `INFO@` in capitals and `info+quotes@`. A `first.last@` address is marked *possibly* personal and **still cannot name anyone**, with the note stating the shape is a guess, not evidence. A person is named only from something actually read: an OSM `contact:person`/`operator` tag or a name the owner typed, and the evidence cites which. `greetingFor` is wired into `composeCold`, so **a business called "Pat Lee Flooring" is greeted "Hi," not "Hi Pat"**, and the composed message carries `addressedByName` plus the basis for the operator to check. `guessEmailFromName()` exists only to refuse. No job title is claimed unless a listing states one. |


| R5.6 | A card exchange alone never enters a recurring promotional SMS sequence | **L1+L2** | `tests/campaigns.test.mjs` C13–C14. Contact-level consent decides whether ONE message may be sent; `sequenceAllowed()` decides whether a SERIES may, which is a different question. No SMS consent refuses even a single message, with the reason *"holding someone's business card is not permission to text them"*. A `one_time_followup` scope allows exactly one message and is refused a series, with the refusal counting out the messages it blocked. **Verified against a real scanned card**: that contact cannot join a promotional SMS sequence, but can still receive the warm **email** they were expecting — a different permission, treated differently. |
| R5.7 | Three separate permissions, never one "SMS" bucket | **L1** | Three campaign types map to three distinct consent purposes (`one_time_followup`, `transactional`, `promotional`), asserted genuinely distinct. None substitutes for another: a one-time permission does not authorise promotional texts, and neither does appointment permission. SMS campaigns default to **zero** follow-ups, so the default is the option needing least consent. |


| R5.9 | Website recheck → internal opportunity, with material-change threshold and cooldown | **L1+L2** | `tests/recheck.test.mjs`, 47 checks. **Material change**: only transitions that change what is true about a business count — built a site, site went down, came back, disappeared. `uncertain` is inert in **both** directions, because it describes our confidence rather than them, so a flaky read cannot manufacture work. **Cooldown**: a change inside 60 days of last contact still creates the opportunity (we want to know) but marks it `contactable: false` with the date it clears and how long ago they were contacted. **Permission**: the record carries no message body and no recipient — asserted by inspecting its keys — and states in words that it is not permission; consent is still decided at send time. A premise-invalidating change (they built a site) is flagged, so a "couldn't find a website" approach cannot continue against someone who now has one. **L2**: driven through `runAutoTick`, capped at five prospects per tick and gated to once a day; a negative control that unwires the sweep fails the integration check. Zero emails and zero texts asserted after every recheck and sweep. |
| R5.6 (re-verified) | The sequence rule is **reached**, not shadowed | **L1** | **Correction.** The reviewer suspected `sequenceAllowed()` was defined but not invoked. A negative control proved the concern justified: neutralising the call left all checks passing, because the card contact was refused by contact-level consent before the sequence rule ran — so the original test proved nothing about it. The new C15 gives a contact one-time SMS consent (which *clears* the contact-level gate, asserted), then shows the same consent is accepted for a single message and refused for a series, with the refusal text coming from the sequence rule. The negative control now fails exactly those two checks. |


## R7 — Replies

| Req | Check performed | Level | Result |
|---|---|---|---|
| R7.1 | An inbound reply immediately pauses that contact's follow-ups, **including the already-queued race** | **L1+L2** | `tests/replies.test.mjs`, 36 checks. The race is driven directly: a worker takes a send claim, the contact replies *during* preparation, and the pre-commit re-check refuses with *"a reply arrived while this message was being prepared"*. **Negative control**: removing that re-check fails three checks including "commit was never called" — so without it the follow-up genuinely does reach someone who just replied. A worker cannot even claim a send for a contact who has already replied (refused at the claim stage, `prepare` never runs). A clean send still completes, and a refused composition stops at `prepare` carrying the composer's reason, so the guard is not a blanket refusal. The stop flag is written **before** the campaign bookkeeping, leaving no window where a reply is known but unenforced. Two months later the contact is still not due. |
| R7.2 | Reply classifier, ten categories | **L1** | All ten exist. The three where a wrong answer does real damage are decided by **rules, not judgement**: delivery failure from `X-Failed-Recipients`/mailer-daemon/subject, auto-reply from RFC 3834 `Auto-Submitted` and the vendor headers (and `Auto-Submitted: no` is correctly *not* an auto-reply), and opt-out from explicit phrases. Precedence verified: a bounce containing "not interested" is still a bounce, and an opt-out inside a polite message still wins. Unmatched text returns **AMBIGUOUS with zero confidence** and the basis *"a person should read this"* — a real outcome that routes to a human rather than a guess. |
| R7.5 | Never reply conversationally to a bounce or automated mail | **L1** | Auto-replies and bounces classify as non-human, are recorded without pausing follow-ups, and leave campaign membership untouched — an out-of-office must not look like interest. |
| R7.7 (partial) | Owner tools — unified inbox | L1 | Replies are listed newest-first, filterable to unhandled, and markable as handled. **No screen yet**, and no AI history, takeover or draft-only mode. |
| — | An opt-out is a standing instruction, not just a stop | L1 | After an opt-out reply, re-reading the contact shows the consent gate refuses them — the opt-out survives as a consent fact, not only as a stop flag. |


| R7.1 (ingestion) | Replies are **detected**, not reported by hand | **L1+L2** | **Gap found by the reviewer**, and it was the right question: `recordReply` alone only fires if a human tells the system a reply arrived, so the automatic pause did not exist. `ingestReplies` reads the mailbox, matches senders against contacts with a recorded **send** (exact email match only — a colleague replying must not stop someone else's campaign), classifies and records. Verified: a real reply is ingested, classified and the contact stopped **without being told**; a stranger is ignored; a contact we never wrote to is not treated as a campaign reply; a mailbox failure is reported as transient rather than swallowed. Wired into `runAutoTick` **before** any sending work. **Negative control**: blinding the detection fails four checks including "the contact is now stopped". |


| R7.3 | Approved knowledge base; booking link when appropriate; respects "information first" | **L1+L2** | `tests/knowledge.test.mjs`, 57 checks. **Closed-world**: an answer is assembled only from owner-approved entries, and an unmatched question returns `escalate: true` with the reason *"rather than being improvised"*. An **unapproved** entry is never used even when it matches. Pricing answers are assembled from settings, so with pricing unset the question **escalates instead of guessing** and no currency symbol appears anywhere. **"Information first"** is honoured: the question is still answered, the booking link is suppressed, and the draft records `respectedInformationFirst`. A booking link is only ever offered for "wants a call" or "interested", never for "not now". |
| R7.4 | Never invent availability, discounts, contract terms, capabilities or a preview | **L1** | `containsUnapprovedClaim()` catches discounts, guarantees, invented availability ("I'm free on Tuesday"), stated contract terms and promised rankings — and does **not** fire on the approved text we actually send. The one legitimate "free" (a complimentary preview) passes while "free hosting forever" does not. Applied to every draft on ingestion: a draft that trips the guard is **withheld** with the findings recorded rather than shown. |
| R7.7 (superseded by the row below) | Draft-only mode | **L2** | Ingestion attaches a draft to the reply record with status `awaiting-review`, `needs-a-person` or `withheld`. **Draft-only is the only mode that exists** — there is no send path from here, asserted by zero emails after every ingestion. The unified inbox **screen**, AI history and manual takeover are still not built. |
| — | A knowledge base that survives being edited | **L1** | **Real bug, found by test ordering.** `saveKnowledge` dropped the `matches` patterns, so the base became permanently unmatchable after the owner's first edit. Built-in matchers now come from code; custom entries round-trip as plain phrases; and regex metacharacters in a phrase are escaped, so `.*` matches the literal text rather than everything. |


| R7.6 | Loop prevention: max turns, cooldown, dedup, escalation | **L1+L2** | `tests/knowledge.test.mjs` B9–B10, 26 checks. **Four independent brakes.** Max turns: a small automatic budget, then *"a person should take it from here"*. Cooldown: a second automatic reply inside 30 minutes is refused with how long ago the last one went and when it could retry. Duplicate: the same text is refused even past the cooldown, and **whitespace/case differences still count as duplicates**, so a reformatted repeat does not slip through. Handover: a human taking over sets the budget to zero and records who owns the thread. **Every brake escalates rather than stopping** — the draft is kept and handed over with the reason, because silently abandoning a live prospect is its own failure. **L2**: wired into ingestion, where a contact with a spent budget gets a draft marked `needs-a-person` with the brake named; a negative control that unwires it fails exactly those two checks. |


| R7.7 | Unified inbox · AI history · manual takeover · draft-only vs automatic | **L1+L2** | `tests/inbox-ui.test.mjs` (41) + `acquisition-ui` A12 (20). **Draft-only is the default**; an unapproved draft does not send and says a person must approve it. Automatic mode sends without a reader but still re-checks every guard. A conversation view returns the thread oldest-first with each message's classification and draft history. Takeover zeroes the automatic budget and records the owner. The screen leads with the mode, counts the replies worth the owner's time (an auto-reply is **not** counted), shows the prospect's own words, surfaces "they asked for information first", and says why a draft was withheld. Browser-verified desktop and mobile: six tabs, one section visible, no overflow, no console errors. |
| R7.6 (completed) | The loop brakes now have something to count | **L1+L2** | **Gap found by the reviewer**, and it was precise: `recordAutoReply()` existed but no production path called it, so the turn counter would stay at zero and max-turns and cooldown could never fire. No send path existed yet. `sendDraft` is now the single exit and records the turn there. **Negative control**: removing that one line fails five checks including *"a second send straight after is stopped by the cooldown"* — the exact silent failure predicted. A send that the transport **refuses** does not count a turn. |
| R7.4 (at send time) | The claims guard runs again before sending, not only at drafting | **L1** | A person can edit a draft between drafting and sending. An edited draft offering a discount is refused **even in automatic mode**, with the finding named. |


| R7.8 | Booking via verified webhook or supported API — **a link click is not a booking** | **L1+L2** | `tests/bookings.test.mjs`, 57 checks. A click returns `isBooking: false` with the reason in words, accumulates separately, and **creates no booking** — two clicks still leave zero bookings. An unverified webhook is refused and creates nothing. Signature verification is HMAC-SHA256 over `timestamp.rawBody`, timing-safe: a wrong key, a tampered body, a missing header and a malformed header all fail, an hour-old signature is refused as **replay**, and with **no signing key configured nothing is trusted at all**. Mounted on `api/collect.js?hook=booking` — the public function, because Calendly cannot authenticate, which is exactly why the signature is the only gate. |
| R7.9 | Cancellations and reschedules; attribution survives both | **L1** | A cancellation keeps the original attribution. A reschedule carries contact, campaign **and message variant** to the new booking, records what it moved from, and marks the old one moved rather than deleting it. A cancellation for a booking never seen is still recorded — otherwise a late creation would resurrect it. |
| R7.10 | Attribution recorded at booking time | **L1** | Contact, campaign and message variant are captured when the booking is created, not reconstructed later when the campaign may have changed. |
| R11.5 (bookings) | Duplicate and out-of-order webhooks | **L1** | The same event id is ignored as a duplicate. A **late, older** creation event does not resurrect a cancelled booking — the booking stays cancelled and keeps its attribution. |
| R7.7 (notifications) | Interested and uncertain replies are **delivered**, not just displayed | **L1** | **Gap found by the reviewer**: notifications existed only as a count on a screen, which does nothing if nobody is looking. Interested, wants-call, wants-preview, wants-details and ambiguous replies now go through the owner's existing notify path (text, falling back to email). Not-interested, opt-outs, bounces and auto-replies stay silent on purpose — being pinged for those teaches you to ignore the pings. A notification failure never loses the reply or the pause. |


## R10 — Reporting

Suite: `tests/reporting.test.mjs`, 59 checks.

| Req | Check performed | Level | Result |
|---|---|---|---|
| R10.3 | **Unknown is never zero** | **L1** | Every metric is `{value, measured, why}`. With nothing sent, `messagesAttempted` returns `null` with *"nothing has been sent yet"* — not 0. Delivery and complaints return null with *"no sending provider is connected, so this is not reported to us"*. The report publishes a `notMeasured` list with a reason per metric and a completeness fraction whose note states that unknown is never shown as zero. |
| R10.1 | Real metrics with stated definitions | **L1** | 20 definitions, each a full sentence. Acceptance is explicitly distinguished from delivery; a qualified lead is defined as explicitly **not** just a reply; bookings are defined as excluding link clicks. **Cost per qualified reply and per booking are undefined — not zero — with no denominator**, and the definition says so. |
| R10.2 | Totals distinguished from unique people | **L1** | **Real bug found here.** The send log is a KV set, and without a unique id per entry two genuine attempts to the same contact in the same millisecond collapsed into one — so a retry, exactly what this metric counts, disappeared. Fixed and locked down: five retries in one millisecond now report **5 attempts to 1 unique person**. |
| R10.4 | Filters | **L1** | Period, campaign and industry. A filtered report's definitions are byte-identical to the unfiltered one, so narrowing data cannot silently change what a number means. A future period measures no sends and still does not claim zero. |
| R10.5 | Funnel | **L1** | discovered → contacted → replied → positive → qualified → booked, each stage carrying whether it was measured. |
| R10.6 | A cold prospect is never a warm lead | **L1** | `isOverstated()` rejects "warm lead" or "new lead" for a discovered or contacted business, with the reason *"a business we found or wrote to has not shown interest"*. No funnel stage before "qualified" carries the word "lead". |
| — | Clicks never enter the booking totals | **L1** | Two clicks and zero bookings report as exactly that; **zero bookings is measured**, because we looked and there are none — which is different from not having looked. |


## R11 — Durable background operation

Suite: `tests/jobs.test.mjs`, 65 checks.

| Req | Check performed | Level | Result |
|---|---|---|---|
| R11.1 | Durable jobs; survives deploys and worker restarts | **L1+L2** | Work is a KV record, not process state. The death of a worker is simulated by claiming a job and never completing it: a second worker **cannot** steal the live lease, and once the lease expires it reclaims the job with the attempt count carried over and the reclaim in its history. **L2**: drained from the real `runAutoTick`, bounded to five per tick so one invocation cannot exceed the function limit. |
| R11.2 | Idempotent execution and sending | **L1** | The same idempotency key cannot create a second job. The done-mark is written **before** completion, so the dangerous crash — after the side effect, before the record — does not repeat it: a job whose side effect already happened is skipped and marked done, with the side-effect counter asserted to stay at one. |
| R11.3 | Retry limits and dead-letter recovery | **L1** | Exponential backoff, capped, with the attempt number reported. On exhaustion the job becomes `dead` with the reason and last error kept, leaves the live queue, and appears in a dead letter a person can inspect. A **permanent** failure dies on the first attempt. `replayDead` puts it back deliberately, resets attempts, clears the idempotency mark (the owner is asserting the side effect did not happen) and records who replayed it. |
| R11.4 | Worker leases and stale-job recovery | **L1** | `queueHealth` reports stale leases separately from dead jobs, with the note *"nothing is lost"*. |
| — | **Bug: replies lost in a burst** | **L1** | `recordReply` built its id from `contactId-timestamp`, so replies in the same millisecond overwrote each other — a batch of mail silently lost replies. Six in one millisecond now store as six, all with distinct ids. Found while fixing the human-reply metric to count by classification rather than by the `pausedFollowUps` side-effect, as its definition states. |
| — | **Bug: one bad job type froze the queue** | **L1** | `drain()` read a no-handler job's `ran: false` as "nothing due" and broke its loop, so a single unregistered job type would silently stop every job behind it from running. Now a claimed-and-failed job is `handled` and the sweep continues; a regression test queues work behind a bad job and asserts it still runs. |


| R11.5 | Verified webhook signatures + replay protection | **L1+L2** | `tests/webhooks.test.mjs`, 50 checks. Four independent properties in one call. **Signed**: wrong key, tampered body and missing header all fail; **no configured key fails CLOSED** and says so. **Fresh**: an hour-old signature is refused as replay, with the reason explaining that a valid signature replayed later is still valid. **Unique**: the same event id is applied once; an event with no id is refused rather than risking a double apply; scopes do not collide. **Ordered**: a watermark per subject means an older event is ignored and cannot undo a newer one. A duplicate or out-of-order event answers **200, not an error**, because a provider that sees a failure retries the duplicate forever. **L2**: driven through the real `api/collect.js` — unsigned rejected with no suppression, signed accepted and applied, replayed not applied twice, and refused entirely when no key is configured. |
| R6.6 | Delivery, bounce, complaint and unsubscribe update contact state | **L1** | A delivery is counted and changes nothing. An **open is counted but means nothing on its own** — it is not consent and not interest. A **soft** bounce deliberately does not suppress, because it is a temporary condition. A hard bounce or complaint suppresses, opts the contact out, and stops their pending sends. |
| R6.8 | Global suppression across all campaigns | **L1** | Suppression is written before anything else, then the contact is opted out and stopped in **every** campaign — the person did not complain about a campaign, they complained about us. Verified by re-reading the contact and confirming the consent gate refuses them. |
