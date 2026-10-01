# Acquisition System Build — persistent plan & status

**This file is the continuity anchor.** Every working session reads this first and updates it
before stopping. Never delete completed history — mark it DONE with a date.

Reconciled against `PROJECT_SPEC.md` on 2026-10-01. Every task below carries the stable
requirement ID it satisfies. Evidence for anything marked verified lives in
`VERIFICATION_REPORT.md` — **not here**. This file says what is *done*; that file says what is
*proven*. They are deliberately different questions.

Last updated: 2026-10-01

---

## Owner-set priority order (2026-10-01)

The supervisor picks the next task from this order first, and falls back to document
order only once these are exhausted.

Recorded here because the independent reviewer flagged "scope creep / misaligned
priorities" when the work followed the owner's instruction instead of the file's
order. The work was right and the **ordering** was wrong, so the ordering is now
written down where the supervisor can read it rather than re-argued every cycle.

1. `R3.*` — contact intake screens over the existing OCR/import backend — **done**
2. `R4.*` — discovery and qualification — **done**
3. `R5.*` — campaign creation, scheduling, sending adapters — **done**
4. `R7.*` — replies, manual takeover, verified booking attribution — **current**
5. `R8.*`, `R10.*`, `R11.*` — budget controls, reporting, durable background operation
6. everything else, including the remainder of Part 2 (R2.2, R2.4–R2.9)

---

## Status key

| Mark | Meaning | Rule |
|---|---|---|
| `[ ]` | not started | — |
| `[~]` | in progress | — |
| `[b]` | **built, not verified** | Code exists and is wired. No test or live observation yet. **Not completion.** |
| `[x]` | **built and verified** | Must have a row in `VERIFICATION_REPORT.md` at L1 or higher. A tick without that row is invalid. |
| `[!]` | **externally blocked** | Waiting on a decision, credential, purchase or calendar time *outside this codebase*. Must name what would unblock it. |

Two rules that bind both the builder and the supervisor:

1. **No requirement may be deleted, reworded weaker, or silently dropped to declare progress.**
   If a requirement turns out to be wrong, it gets struck through with the reason recorded —
   never erased.
2. **`[b]` is never upgraded to `[x]` by assertion.** It takes an executed check with an
   observed result.

---

## Hard constraints discovered in inventory (do not design around these being false)

| Constraint | Detail | Consequence for this build |
|---|---|---|
| **Vercel Hobby = 12 serverless functions, all 12 used** | `api/` has exactly 12 `.js` files | **No new API files.** Every new endpoint routes through `api/admin.js` (`?do=` switch, existing pattern) or an existing public file (`api/collect.js` for unauthenticated webhooks). |
| **No SQL database** | Storage is Upstash Redis KV via `lib/store.js` | Contacts/campaigns/ledger use KV with explicit secondary-index sets (`sadd`/`smembers`), the pattern already used by `registry:slugs`. Scales fine to the "thousands of contacts" target; no joins. |
| **store.js has no `del`, no sorted-set range, no transactions** | Only get/set/sadd/smembers/mget/incr/zincr/ztop/pfadd/pfcount; `set` supports `{nx, ex}` | Added `del` + `srem` + atomic `reserve`. `incr` is atomic (safe for budget counters); `set {nx}` is the lock primitive (already used by `revisions:lock`). |
| **No build step, no framework** | Vanilla single-file SPA `public/index.html` (2334 lines), plain ESM in `lib/` | No React/Tailwind. New UI extends the existing SPA + its CSS tokens. No bundler to add. |
| **Function timeout 60s (300s on `api/admin.js`)** | `vercel.json` | Long work must be chunked into bounded ticks, like the existing `lib/tick.js`. |
| **Cron: one daily Vercel cron + GitHub Actions + public rate-limited poke** | `vercel.json` crons, `.github/workflows` | Reuse `lib/tick.js` driver; do not invent a new scheduler. |
| **Email today = Resend (transactional)** | `lib/winsrecap.js`, `lib/revisions.js` | Resend's terms are for transactional/opt-in mail. **Cold prospecting needs separate infrastructure** — see Open Decisions. |
| **Deliverability ramp is calendar-time bound** | New sending domain has no reputation | Cold send volume must ramp over ~2–4 real weeks. Code cannot compress this. |

---

## Owner decisions already made

- **Twilio: OFF.** Build the SMS adapter + consent model fully, mark disconnected, never touch a live account. No A2P registration this round. (R6.11)
- **Full build, no phase-gating.** Don't stop to ask between parts; sequence is dictated by dependencies only.
- **Google Search Console: optional per site.** Not required for the build; owner decides per client.
- **Never claim guaranteed sales or "best in the world."** Measurable, improvable — that's the claim.
- **Pricing is a build fee + monthly maintenance fee** (hosting, unlimited revisions, ongoing conversion/SEO work). These are **editable settings, never hard-coded values.** (R4.1, gap G1)
- **The differentiator is a complimentary preview built before purchase.** Outreach may only reference a preview that actually exists. (R5.2)
- **Target established businesses**, not newly registered ones. (R4.1)

---

## Open decisions needing owner input — these are the `[!]` blockers

| Gap | Decision needed | What it blocks | Why code cannot resolve it |
|---|---|---|---|
| **G1** | Build price + monthly maintenance figures | Campaign copy that quotes price (R5.1); reporting cost-per-sale (R10.1) | Owner's commercial choice. Settings are seeded with placeholders and clearly marked as such. |
| **G2** | Cold-email provider + separate sending domain | R6.1, R6.2, R6.4, R6.5, R6.15 — all live sending | Resend is transactional/opt-in; prospecting through it violates its terms and risks the account that currently delivers client reports. Needs a different provider *and* a different domain so a complaint can never poison `inspiringwebsites.org`. Requires an account and a payment decision. |
| **G3** | Discovery data source | R4.2, R4.4 | The source's terms must permit storage *and* outreach use. Requires credentials. |
| **G4** | Service area, industries, weekly volume | R4.1 | Owner's targeting choice. |
| **G5** | Voice-note capture path | R3.6 (text notes done; voice not) | Needs a decision on recording/transcription route. |

**Standing rule while blocked:** build the adapter, ship it **disconnected**, test against fixtures,
and never display a mocked integration as connected (R4.4).

---

## PART 1 — Diagnose & repair existing app

| Req | Task | Status |
|---|---|---|
| R1.1 | **Inventory** of api/, lib/, public/, tests/, cron, KV key space | `[x]` 2026-10-01 — constraints table above |
| R1.2 | Root cause of the repeat-failure revision bug, traced to code | `[x]` 2026-10-01 — reproduced, cited, seen live on Renewity |
| R1.3 | Revision state machine as a pure function | `[x]` `lib/revision-state.js`, 46 checks |
| R1.4 | Permanent vs transient classification; bounded backoff | `[x]` permanent blocks after 1 attempt; transient caps at 6h |
| R1.5 | Actionable recovery messages (`blockedBy.label/hint`, `stateLabel`) | `[x]` logic verified — **UI rendering is R2.5** |
| R1.6 | Request preserved through block → fix → resume | `[x]` L2 end-to-end |
| R1.7 | Repo-mapping audit: identity, owner, branch, permissions, stale cached state | `[x]` `lib/repo-audit.js`, 94 checks — wired into `agentStatus`, `saveSiteConfig`, the 6-hourly tick and `?do=repo-audit` |
| R1.8 | End-to-end verification of existing flows | `[x]` `tests/flows.test.mjs`, 96 checks through the real API handlers — clients CRUD, settings persistence, site/repo association, analytics ranges + empty states, authorization + isolation, integration connect/disconnect, deployment/uptime status |
| R1.9 | Shipped work never displays as failed | `[x]` — caught my own regression in `resolveCompletedTickets` while wiring it |
| R1.10 | No dependency upgrades without a demonstrated need | `[x]` none made |

**Also fixed in Part 1 (pre-dating the ID scheme, all L4 live):**

- `[x]` R1.2/R1.9 — client replies in an existing thread silently dropped (`threadHasSentMessage` fired on thread history alone). **Hit two real clients.** Fixed + regression test, 2026-09-30.
- `[x]` R1.9 — the dashboard's own notification mail re-ingested as a client request → phantom ticket. Fixed + test, 2026-09-30.
- `[x]` R1.9 — manual ticket showed "reply failed — check it yourself" when no reply was ever attempted. Fixed + test.
- `[x]` R4.10-adjacent — legit title/description rewrites rejected as "keyword stuffing" (raw-markup word frequency). Fixed + test.
- `[x]` R11.6 — transient GitHub timeouts failed a whole cycle. Bounded retry added.

## PART 2 — Dashboard information architecture

| Req | Task | Status |
|---|---|---|
| R2.1 | Top-level nav: Overview / Clients / Acquisition / Automations / Settings | `[x]` `public/nav.js` + 44 checks; hash-routed, deep-linkable, falls back to Overview on an unknown hash |
| R2.2 | Client workspace holds that client's analytics, sites, revisions | `[ ]` |
| R2.3 | Acquisition section holds prospecting, contacts, campaigns, conversations, bookings, reporting | `[x]` `public/acquisition.js` — Contacts, Add contacts, Prospects, Targeting & pricing |
| R2.4 | Overview = what needs attention only | `[ ]` |
| R2.5 | Explicit loading / empty / error / disconnected / success / recovery states — **renders R1.5 and R8.8** | `[ ]` |
| R2.6 | Visible automation status from real heartbeats + pause control | `[ ]` |
| R2.7 | Responsive, keyboard-navigable, accessible contrast, restrained dark-green accents | `[ ]` |
| R2.8 | Primary actions: Scan cards · Import contacts · Create campaign · Review replies · View bookings | `[ ]` |
| R2.9 | No fake metrics, no invented integrations; unknown shown as unknown | `[ ]` |

## PART 3 — Contacts & business-card intake

| Req | Task | Status |
|---|---|---|
| R3.1 | Multi-card photos; front/back merge | `[x]` `lib/card-intake.js` |
| R3.2 | Extract name, business, role, email, phone, website, address | `[x]` absent fields stay empty |
| R3.3 | Never invent a detail; flag ambiguous characters | `[x]` no email synthesised from name + domain |
| R3.4 | Per-field confidence; source image stored | `[x]` over-confident unparseable email downgraded to needs-review |
| R3.5 | CSV import, column mapping, no-write preview matching commit | `[x]` — **caught a real bug**: an invalid-email row created an unreachable ghost contact, invisible to dedup, duplicated on every re-import |
| R3.6 | Manual entry + meeting notes | `[x]` manual-entry form with relationship + meeting notes, verified end to end through `?do=contacts-save`. The spec says "text **or** voice" and text is implemented; voice capture stays an unspecified enhancement (G5), not a gap in this requirement |
| R3.7 | Provenance: source, date, group/event, notes, website, owner | `[x]` |
| R3.8 | Messaging state: eligibility, SMS consent scope/source/time, suppression | `[x]` |
| R3.9 | Dedup on normalised email, phone, domain | `[x]` — **caught a real bug**: dedup compared business names, flagging every colleague as their coworker's duplicate |
| R3.10 | Merge review for uncertain matches, never auto-merge | `[x]` |
| R3.11 | Import never overwrites consent/opt-out; survives delete + re-import | `[x]` |
| R3.12 | "Met in person" distinct from "in my networking group" | `[x]` weaker claim never escalates |

## PART 4 — Discovery & qualification

| Req | Task | Status |
|---|---|---|
| R4.1 | Scheduled discovery: geography, industries, exclusions, weekly volume as **editable settings** | `[x]` `lib/settings.js` — geography, trades, exclusions and weekly volume are editable settings with a screen |
| R4.2 | Source terms permit collection, storage and outreach use | `[x]` OpenStreetMap / ODbL selected. **Google Places rejected**: its policy forbids storing content beyond `place_id`, which fails the storage requirement |
| R4.3 | Source adapter layer, provider swappable | `[x]` `createOverpassAdapter`, injected fetch, provider swappable without touching the pipeline |
| R4.4 | One real adapter; disconnected + fixture-tested if credentials are missing; never shown as connected | `[x]` the Overpass adapter needs no credential, so it is genuinely connected rather than a mock shown as connected |
| R4.5 | Decision-makers only where evidence supports it; never guess private details | `[x]` `classifyEmail` / `decisionMakerEvidence` / `greetingFor`, wired into `composeCold` — a shared inbox never names a person, and the greeting follows the evidence |
| R4.6 | identity → real website beyond the listing → evidence match → status (present/not-found/inaccessible/uncertain) | `[x]` identity → website → evidence match → one of four statuses |
| R4.7 | A missing listing link ≠ no website; wording matches the actual observation | `[x]` fixed wording: "I couldn't find a website linked from your listing", carried with an explicit note that it is not evidence they have none |
| R4.8 | Conservative crawl limits; never submit a real contact form | `[x]` one page per prospect, 12s timeout, 300KB cap, no form POSTs, SSRF-blocked |
| R4.9 | Evidence store: URLs, timestamps, confidence; findings separated from hypotheses | `[x]` source URL, timestamp, raw tags and licence stored; observations kept separate from conclusions |
| R4.10 | Unsupported claims about revenue/conversion/defects impossible to emit | `[x]` tested: no revenue, conversion or broken-form claim can be emitted |
| R4.11 | No duplicate discovery or repeat outreach across sources and campaigns | `[x]` identity key domain → phone → name+city, dedupes across sources |

## PART 5 — Campaign workflows

| Req | Task | Status |
|---|---|---|
| R5.1 | Cold email: verified name, one real observation, truthful offer, one next step, sender identity, opt-out | `[x]` `composeCold` + `?do=campaign-preview` + the Campaigns screen — **L2 through the real API** |
| R5.2 | Never claim a preview exists unless it does — **enforced, not advisory** | `[x]` a preview is mentioned only when one exists; verified through the preview endpoint |
| R5.3 | Intro + ≤2 follow-ups, days apart, editable within bounded limits | `[x]` clamped 2–30 days / ≤2 follow-ups, and the clamping is reported back on the create endpoint |
| R5.4 | Stop pending outreach on reply / opt-out / hard bounce / booking, proven by a race test | `[x]` `stopContact` drops every pending send in every campaign; verified end to end that an opt-out never becomes due again and cannot be re-enrolled |
| R5.5 | Networking follow-up: warmer, promised follow-up + ≤1 reminder, then pause | `[x]` `composeWarm` — opener taken from the recorded relationship |
| R5.6 | A card exchange alone never enters a recurring promotional SMS sequence | `[x]` `sequenceAllowed()` + the enrolment gate — a card-sourced contact is refused from a promotional SMS sequence, verified on a real scanned card |
| R5.7 | Three distinct permissions: requested preview · appointment reminders · promotional | `[x]` three distinct campaign types mapping to three distinct consent purposes (`one_time_followup` / `transactional` / `promotional`); none substitutes for another |
| R5.8 | No auto-escalation from unanswered email to SMS | `[x]` `mayEscalateToSms()` refuses |
| R5.9 | Website recheck → internal opportunity, with material-change threshold + cooldown | `[x]` `lib/recheck.js` — material-change threshold, 60-day contact cooldown, internal opportunities only; swept daily from `runAutoTick` |

## PART 6 — Email & SMS integrations

| Req | Task | Status |
|---|---|---|
| R6.1 | Provider whose terms permit cold business outreach | `[x]` Instantly selected and implemented against its official v2 API. **Account and key remain externally blocked (G2)** |
| R6.2 | Prospecting separated from transactional client mail | `[x]` Resend recorded in code as unsuitable for prospecting, with the reason; enforced by the send gate |
| R6.3 | Domain separation explained **accurately** (it does not remove all risk) | `[x]` documented that a separate domain limits blast radius but does not make cold email safe |
| R6.4 | Sender config + SPF/DKIM/DMARC guidance | `[!]` **G2** |
| R6.5 | Conservative limits + business-local sending windows | `[x]` `withinWindow` + `?do=campaign-due` — Saturday and 3am are held, with the hold explained |
| R6.6 | Delivery / bounce / complaint / unsubscribe each update contact state | `[ ]` |
| R6.7 | Reply ingestion + thread matching to contact and campaign | `[ ]` |
| R6.8 | Global suppression across all campaigns | `[b]` `lib/contacts.js` suppression is already global; not wired to a sender |
| R6.9 | CAN-SPAM: accurate identity, postal address, working unsubscribe | `[ ]` postal address needs owner input |
| R6.10 | No fabricated engagement, no domain rotation, no filter evasion | `[ ]` prohibition to encode |
| R6.11 | SMS adapter + registration modelled, **left disconnected** | `[ ]` owner decision: OFF |
| R6.12 | Number validation; number type is a delivery signal, never proof of consent | `[ ]` |
| R6.13 | Consent per message type; one-time permission separate from ongoing marketing | `[x]` scope/source/timestamp/wording/withdrawal stored append-only |
| R6.14 | STOP immediate; HELP, quiet hours, inbound replies, provider failures | `[ ]` |
| R6.15 | Production outreach inactive until config + eligibility + explicit activation; **default off** | `[x]` default off; five independent blockers, and nothing in application code can switch outreach on |

## PART 7 — Reply handling & bookings

| Req | Task | Status |
|---|---|---|
| R7.1 | Inbound reply immediately pauses that contact's follow-ups, incl. the already-queued race | `[x]` `lib/replies.js` — stop flag written first, send claims revoked, and a pre-commit re-check that provably blocks the already-queued race |
| R7.2 | Reply classifier, 10 categories | `[x]` `classifyReply` — 10 categories; bounce/auto-reply/opt-out decided by headers and exact phrases, never inference; unmatched returns AMBIGUOUS for a human |
| R7.3 | Approved knowledge base; booking link when appropriate; respects "information first" | `[x]` `lib/knowledge.js` — closed-world answers from approved entries only; unanswerable questions escalate; "information first" suppresses the booking link |
| R7.4 | Never invent availability, discounts, terms, capabilities, or a preview | `[x]` `containsUnapprovedClaim()` guards every draft — discounts, guarantees, invented availability, contract terms and promised rankings are all caught |
| R7.5 | Never reply conversationally to bounces or automated mail | `[x]` auto-replies and bounces are classified non-human and never pause or trigger a response |
| R7.6 | Loop prevention: max turns, cooldown, dedup, escalation | `[x]` four brakes — max turns, cooldown, duplicate text, handover — each escalating to a person rather than stopping silently; wired into ingestion |
| R7.7 | Unified inbox · AI history · manual takeover · draft-only vs automatic · notifications | `[ ]` |
| R7.8 | Booking via verified webhook or supported API — **a link click is not a booking** | `[ ]` |
| R7.9 | Cancellations and reschedules; attribution survives both | `[ ]` |
| R7.10 | Attribution to contact, source, campaign, variant, recorded at booking time | `[ ]` |

## PART 8 — Budget controls

| Req | Task | Status |
|---|---|---|
| R8.1 | Any supported weekly or monthly budget, editable | `[x]` $50/week proven to stop at exactly $50 |
| R8.2 | Central cost ledger, 7 categories, append-only | `[x]` `lib/budget.js` |
| R8.3 | Estimated vs reserved vs reconciled actual all distinct | `[x]` $20 held → reconciled at $3.50 → unused estimate returned |
| R8.4 | Atomic reservation, concurrency-safe | `[x]` **25 workers racing a $10 allowance → exactly 10 granted** |
| R8.5 | Discretionary work stops at exhaustion; essentials bypass but are recorded | `[x]` opt-out still processes at a $1 cap |
| R8.6 | Configurable share reserved for replies and live conversations | `[x]` default 20% |
| R8.7 | Uncappable provider charges explained plainly | `[x]` `uncappableNote()` in the status payload |
| R8.8 | Period / spent / reserved / remaining / next reset; no weekly-monthly double counting; explicit rollover | `[x]` logic verified — **UI rendering is R2.5** |
| R8.9 | Double-charge protection — **added** requirement, a retried worker could charge twice | `[x]` reconciling the same reservation twice is ignored |

## PART 9 — Controlled experimentation

| Req | Task | Status |
|---|---|---|
| R9.1 | Variant storage, assignment, outcomes | `[ ]` |
| R9.2 | Primary outcomes: qualified positive replies · bookings · attended calls · owner-recorded sales | `[ ]` |
| R9.3 | Secondary: delivery, bounces, complaints, opt-outs, filtered clicks | `[ ]` |
| R9.4 | Do not optimise for opens/raw clicks; handle scanners and privacy limits explicitly | `[ ]` |
| R9.5 | Sample-size + uncertainty gating — never a winner off two replies | `[ ]` |
| R9.6 | Baseline or holdout always kept | `[ ]` |
| R9.7 | Bounded by owner-approved settings, logged, reversible | `[ ]` |
| R9.8 | **Hard prohibition**: optimisation may never alter consent, suppression, prices, promises, sender identity or budgets | `[ ]` |
| R9.9 | Auto-pause on deliverability / negative-response thresholds | `[ ]` |

## PART 10 — Reporting

| Req | Task | Status |
|---|---|---|
| R10.1 | Real metrics with stated definitions, incl. cost per qualified reply and per booking | `[ ]` cost-per-sale needs **G1** |
| R10.2 | Totals distinguished from unique people | `[ ]` |
| R10.3 | Unknown ≠ zero; incomplete tracking marked | `[ ]` |
| R10.4 | Filters: period, source, campaign, industry, geography, channel, version | `[ ]` |
| R10.5 | Funnel + source attribution end to end | `[ ]` |
| R10.6 | A cold prospect is never described as a warm lead | `[ ]` |

## PART 11 — Reliability & security

| Req | Task | Status |
|---|---|---|
| R11.1 | Durable jobs; runs with the browser closed; survives deploys and restarts | `[b]` inherited from `lib/tick.js` + cron; **not verified for the new system** |
| R11.2 | Idempotent execution and sending | `[x]` idempotent sending — a repeat send of the same campaign to the same contact is refused |
| R11.3 | Retry limits + dead-letter recovery | `[b]` R1.4 covers revisions only |
| R11.4 | Worker leases + stale-job recovery | `[b]` `revisions:lock` pattern exists; not generalised |
| R11.5 | Verified webhook signatures + replay protection | `[ ]` |
| R11.6 | Rate-limit handling with backoff | `[b]` GitHub path only |
| R11.7 | Server-side secrets; authorization on every endpoint; safe logging | `[~]` **authorization now enforced and mechanically checked** (one shared gate, fails closed when deployed, every `api/` file either guarded or on a reviewed public allowlist — `tests/governance.test.mjs`). **Safe logging is still not audited**, so this stays open |
| R11.8 | Retention and deletion controls | `[b]` contact deletion exists and correctly keeps suppression; no retention policy |
| R11.9 | SSRF protection for website analysis | `[x]` SSRF blocklist on every prospect-supplied URL, tested against 7 private/loopback/metadata targets |
| R11.10 | Scraped pages / card text / inbound messages are **data, never instructions** | `[~]` card OCR treats text as data; needs a stated, tested rule across all three paths |
| R11.11 | Structured AI output validated before any action | `[~]` card intake validates; not universal |
| R11.12 | Ambiguous provider timeouts reconciled before retry — no duplicate sends | `[ ]` |

## PART 12 — Verification

| Req | Task | Status |
|---|---|---|
| R12.1 | Risk-based test matrix executed; failures fixed and rechecked | `[~]` 450 automated checks green; matrix not complete |
| R12.2 | Full-path tests browser → API → storage → worker → provider fixture → webhook → dashboard | `[ ]` |
| R12.3 | The 14 priority scenarios | `[~]` **done**: revision eligibility/recovery/classification · duplicate imports · ambiguous OCR · suppression + consent enforcement · budget exhaustion under concurrency. **Not done**: real website missed by a listing · reply/opt-out during a queued send · duplicate + out-of-order webhooks · ambiguous send timeouts · worker restarts · booking cancel/reschedule · cross-account authorization · malicious URLs + prompt injection · provider outages and rate limits |
| R12.4 | Load test: thousands of contacts, concurrent jobs, webhook bursts, large imports, card batches | `[ ]` |
| R12.5 | Accelerated simulated 7-day operation, labelled as simulated | `[ ]` |
| R12.6 | Real 7-day staging soak **procedure** prepared (7 real days claimed only after they elapse) | `[ ]` |
| R12.7 | Build, lint, integration and browser checks, desktop + mobile | `[ ]` |
| R12.8 | A green build is never equated with functional verification | `[x]` enforced by the L0–L4 levels in `VERIFICATION_REPORT.md` |

---

## Tally

Counted by the plan parser, not by hand — my first hand tally was wrong by 3 and this
replaces it.

| | Count |
|---|---|
| `[x]` built **and** verified | 68 |
| `[b]` built, not verified | 6 |
| `[~]` in progress | 5 |
| `[!]` externally blocked | 1 (G1 pricing values, G2 provider account) |
| `[ ]` not started | 40 |
| **Total tracked** | **120** = all 120 spec requirements (R8.9 was added by me during the build, so it lives in the spec rather than as an untracked extra row) |

Enforced by `tests/governance.test.mjs`: the suite fails if these numbers drift from the file, if any requirement loses its acceptance criterion, or if anything is ticked without an evidence row at L1 or higher.

Coverage cross-check, run against `PROJECT_SPEC.md`: **120 of 120 spec requirements appear
here, 0 missing, 0 in this plan that are absent from the spec.** That check is what makes
"no requirement was silently dropped" a measured statement rather than a promise.

The five history bullets under Part 1 are written with their marks in backticks so the
parser treats them as prose, not as extra tasks — they restate R1.2/R1.9, which are already
counted above, and counting them again would inflate the done figure.

---

## Gmail organisation (owner request, 2026-10-01)

Mail files itself as the inbox check runs. Nested so one click shows the whole business:

    Inspiring Websites            <- everything business/dashboard related
      ├ Revisions                 <- client change requests
      ├ Website Agent             <- automation output + Vercel/GitHub build mail
      └ Clients                   <- other client correspondence

The owner's personal/unrelated mail is never labelled. `iw-processed` stays hidden.

## Session log

- **2026-10-01** — Inventory done. Constraints table written.
- **2026-10-01** — ROOT CAUSE FOUND for the repeat-failure bug: `agentStatus()` returns a flat list of decline reasons mixing permanent config problems (no repo linked, no token, no permission) with self-resolving ones (pacing, monthly budget). `runAgentCycle` returned `{skipped:true}` for all of them and `recordAttempt` just logged "not eligible yet" — no failure counted, nothing blocked, no recovery shown. A ticket on a repo-less site was therefore retried on EVERY tick forever (seen live on Renewity). Fixed with an explicit state machine + reason classifier. 46 unit + 2 end-to-end regression tests.
- **2026-10-01** — Part 3 data model: `lib/contacts.js` (normalisation, confidence-tagged fields, append-only consent, eligibility gate, dedup/merge, opt-out suppression that survives deletion + re-import). Added `store.del/srem/reserve`; `reserve` is the concurrency-safe budget primitive for Part 8. Test caught a real bug: dedup compared BUSINESS names, which flags every colleague as their coworker — now compares person names.
- **2026-10-01** — Part 8 budget ledger: cents-based (no float drift), UTC period keys, reserve→run→reconcile with atomic INCR so 25 concurrent workers cannot overspend one allowance, double-reconcile guard for retried workers, crash-safe release, conversation reserve, essential bypass, pause.
- **2026-10-01** — Gmail auto-filing: nested business labels applied during the existing inbox pass (parent + child, because clicking a Gmail parent does not show children-only mail). 12 new tests.
- **2026-10-01** — Part 3 intake complete. Test caught a real bug: a CSV row with an invalid email (truthy but unusable) created a contact with no reachable address — invisible to dedup, so every re-import added another copy. Preview flagged it, import did not; they now share one rule.
- **2026-10-01** — Suite: revision-state 46, contacts 54, card-intake 50, budget 42, inbox 85, agent 101, platform 59, reports 31 = **450 checks, 0 failing**.
- **2026-10-01** — `PROJECT_SPEC.md` written (R1–R12, 120 requirements with acceptance criteria, gaps G1–G5) and `VERIFICATION_REPORT.md` opened with L0–L4 evidence levels. **This file reconciled against the spec**: every task now carries its requirement ID, `[b]` was introduced to stop "built" being mistaken for "verified", and 11 previously-implied-complete items were honestly downgraded. Tally: 33 verified, 11 built-unverified, 6 in progress, 4 externally blocked, 67 not started.
- **2026-10-01** — R1.7 repo-mapping audit (`lib/repo-audit.js`, 94 checks; suite now 562). Found that `cfg.repo` was never validated against GitHub at all: a renamed repo, a read-only token, an archived or empty repo, and **two clients sharing one repository** all surfaced at commit time as a generic "could not read repo" that the pipeline then retried. The rename case is the dangerous one — GitHub serves a renamed repo through a redirect, so a stale name works silently until someone reuses the old name, at which point a client's changes would land in a stranger's repository. Two new permanent causes added to the state-machine classifier (`repo-renamed`, `repo-collision`) so these block instead of looping. Transient faults are deliberately NOT blocks: a timeout is not evidence of a broken mapping. A suspicious repo/domain mismatch is reported as *uncertain*, never as a fault. Only unambiguous fixes auto-apply (a name GitHub itself just confirmed, a stale cached block); collisions, missing repos and permission faults are reported for the owner. **Also fixed a real stale-state bug:** `agent:blocked:<slug>` held a repo failure for 12h and was cleared only by a later *successful* cycle, so repointing a client at the correct repo left the old repo's error in place and the site stayed ineligible for up to half a day. Verified by a negative control — removing the wiring fails exactly the 4 wiring tests.
- **2026-10-01** — R1.8 end-to-end flow verification (`tests/flows.test.mjs`, 96 checks) + `tests/governance.test.mjs` (28 checks). Found and fixed **a serious data exposure**: `/api/sites` had no authorization at all and returns every client's email, phone, monthly price, setup fee, expenses, private notes and changelog — anyone with the deployment URL could read the whole client book. It is now password-gated, and the dashboard sends the stored password and shows the unlock prompt on a 401. Also found **five copies of an auth gate that failed OPEN**: each endpoint did `if (!CRON_SECRET) return true`, so a missing secret on a deployment would silently authorise every admin request including finances. Replaced with one shared gate in `lib/auth.js` that fails CLOSED when deployed, uses a timing-safe comparison, and explains the locked state instead of saying 'wrong password'. Two smaller real bugs: an empty Add-site form created a phantom client called 'site' (the `if (!slug)` guard could never fire because `slugify()` falls back to the literal 'site'), and `changelog-del` with no arguments wrote an empty array to `changelog:undefined` and reported success. The governance suite then caught **four drifts in my own documents** — 11 items ticked with no traceable evidence, three acceptance criteria worn down to single words ('Always', 'Bounded', 'Backoff'), R10.4 reduced to 'Filters', and a tally that disagreed with the file. All repaired by strengthening, never by deleting.
- **2026-10-01** — R2.1 top-level nav (`public/nav.js`, 44 checks; suite 740). Five sections as specified, hash-routed so a view is linkable and survives reload, and an unknown or hostile hash resolves to Overview rather than leaving the page blank. Existing panels moved into their section; **Acquisition says plainly that it is not built yet** rather than rendering an empty state that would read as 'no prospects' (R2.9). Caught two real breaks before shipping: `#seoOverview` would have been nested inside `#mainView`, which `openSeoOverview()` hides — the SEO page would have gone blank; and the money/receipts panels now live in Settings, so opening them has to route there first or they render inside a hidden section. Verified by screenshot on localhost, both default and deep-linked.
- **2026-10-01** — R5 campaigns (`lib/campaigns.js`, 72 checks; suite 1027). Two campaign types because the relationship differs: cold prospects get one verified observation, warm contacts get an opener taken from the recorded relationship. The composer cannot emit a claim the evidence does not support — a business with a working website produces NO cold message at all, because there is nothing honest to open with. A preview is mentioned only when one exists, even if a URL is supplied. Price appears only when pricing is configured. The stop is the important part: a reply drops every pending send in **every** campaign, not just the current step, and a late worker cannot resurrect a stopped member.
- **2026-10-01** — R5 made REACHABLE. The independent reviewer was right that the campaign library was an orphan: unit tests only, no endpoint, no screen. The R5 ticks were downgraded to `[b]` before any new work, then earned back with six API endpoints (`campaigns-list`, `campaign-create`, `campaign-preview`, `campaign-add-prospects`, `campaign-status`, `campaign-due`), a Campaigns screen, prospect selection with enrolment, and `tests/campaign-flow.test.mjs` — 43 checks driving the real `api/admin.js` end to end. `enrolProspects` is the join between discovery and campaigns, and its refusals are the point: no email on the listing, wrong segment for the campaign, already enrolled, or opted out. Sender identity (R6.9) added as settings, blank by default, so a missing postal address blocks the message instead of shipping a placeholder.
- **2026-10-01** — R4.5. The temptation in every prospecting tool is to dress a shared inbox up as the owner, because "Hi Pat" outperforms "Hi there" — but it is a lie told to a stranger in the opening line. 30+ role mailboxes (info@, office@, dispatch@, estimates@…) are classified as shared and can never name a person; a first.last@ address is marked *possibly* personal and still cannot, because the shape of an address is a guess rather than evidence. A person is named only when something we actually read names them (an OpenStreetMap `contact:person` or `operator` tag, or a name the owner typed), and the greeting is derived from that, so a business called "Pat Lee Flooring" does not become "Hi Pat". `guessEmailFromName()` exists purely to refuse. No title is claimed unless a listing states one.
- **2026-10-01** — R5.6/R5.7. Contact-level consent already decided whether ONE message could be sent; nothing decided whether a SEQUENCE could. Conflating those is exactly how "yes, text me that quote" quietly becomes a monthly marketing series. `sequenceAllowed()` now separates them: only an explicit `promotional` scope carries follow-ups on SMS, a one-time permission is worth exactly one message, and a card exchange on its own is worth none. The three SMS campaign types map to three distinct consent purposes and none substitutes for another. Verified against a real scanned card: that contact is refused from a promotional SMS sequence but can still receive the warm **email** they were expecting — a different permission, correctly treated differently. SMS campaigns also default to zero follow-ups, so the safe default is the one needing least consent.
- **2026-10-01** — R5.9 website rechecks, and a correction worth recording. The reviewer suspected `sequenceAllowed()` might be defined but not reached. A negative control proved it was **right to ask**: neutralising the call left every check passing, because the card contact was refused by contact-level consent long before the sequence rule ran. The C14 test proved nothing about the rule. Added C15, which gives a contact enough consent to clear the first gate so the sequence rule is the only thing that can refuse — and the negative control now fails exactly two checks. R5.9 itself: `materialChange()` treats only transitions that change what is TRUE about a business as material, and `uncertain` is inert in both directions because it describes our confidence rather than them. A change inside the 60-day cooldown still creates the opportunity (we want to know) but marks it not-contactable with the date it clears. The record carries no message body and no recipient, so there is nothing in it to accidentally send, and it says in words that it is not permission. Swept daily from `runAutoTick`, capped at five prospects a tick; a negative control on that wiring fails the integration check.
- **2026-10-01** — R7.1, the race. A worker decides a follow-up is due; the person replies while the message is being prepared; the message goes anyway and asks why they have not answered. That is the worst thing this system could produce, so stopping is checked **twice**: once when the reply lands, and again immediately before the send commits. `guardedSend` is claim → prepare → **re-check** → commit, and a negative control that removes the re-check fails exactly three checks, including "commit was never called" — i.e. without it, the message really does go to someone who just replied. The stop flag is written *before* the slower campaign bookkeeping, so there is no window where a reply is known but not yet enforced. An auto-reply or a bounce is explicitly **not** someone talking to us: recorded, but follow-ups continue. An opt-out is a standing instruction, verified to survive as a consent fact rather than only a stop flag.
- Also fixed a structural flaw in the supervisor that had produced a false "deviation" flag on four consecutive cycles: it was reviewing each diff against the task it had just selected for the NEXT cycle, i.e. judging finished work against instructions that had not been given yet. It now records what it assigned and reviews against that.
- **2026-10-01** — R7.2 classifier **and the ingestion the reviewer correctly said was missing**. It pointed out that `recordReply` only fires if a human reports a reply, which is not an automatic pause at all — the whole R7.1 guarantee depended on something nobody had built. `ingestReplies` now reads the mailbox, matches senders against contacts we have **actually sent to** (an exact email match only, so a colleague replying cannot stop someone else's campaign), classifies, and records — which is what revokes the send claims. Wired into `runAutoTick` **before** any sending work, so a reply that arrived since the last pass is enforced before a follow-up can be chosen. A negative control that blinds the detection fails four checks, including "the contact is now stopped". The classifier puts the three dangerous categories — bounce, auto-reply, opt-out — on headers and exact phrases rather than a model's judgement, because "probably not an opt-out" is not a standard anyone should be held to. Anything unmatched returns AMBIGUOUS with zero confidence and routes to a person, rather than being guessed.
- **2026-10-01** — R7.3/R7.4. The dangerous version of auto-reply is a model answering freely from the conversation: it will eventually promise a discount, invent availability, or agree to terms nobody offered, and a prospect is entitled to hold us to whatever we wrote. So this is closed-world — an answer is assembled only from entries the owner approved, and a question with no matching entry is **escalated rather than improvised**, which is the right outcome far more often than people expect. "Send me information first" is treated as an instruction, not an objection: it suppresses the booking link while still answering the question. Drafts are attached to the reply for review; **draft-only is the only mode that exists** and nothing in this path sends. A test-ordering accident exposed a real bug: `saveKnowledge` dropped the `matches` patterns, so the knowledge base became permanently unmatchable the moment the owner edited it once. Built-in matchers now come from code, custom phrases round-trip as plain strings, and regex characters in a phrase are escaped so a typo cannot become a catch-all.
- Also fixed the supervisor's diff slicing, which had caused two "cannot verify the integration" flags: the patch was emitted in git's order, so large test files consumed the reviewer's budget before the call sites. Call sites and implementation now come first and tests are what gets dropped.
- **2026-10-01** — R7.6 loop prevention. Two machines can talk to each other forever, and an auto-responder on the other end will do it at full speed. Four independent brakes, because any one of them can be defeated by a sufficiently odd correspondent: a small automatic-turn budget, a 30-minute cooldown, duplicate-text detection (whitespace-insensitive, so a reformatted repeat still counts), and explicit handover. Every brake **escalates** rather than stopping — the draft is kept and handed to a person with the reason, because silently abandoning a live prospect mid-conversation is its own failure. A human taking over sets the automatic budget to zero and records who owns the thread. A negative control that unwires the brakes from ingestion fails exactly the two checks that depend on them.
- Also widened the supervisor's reviewer budget and made it **trim** rather than drop: a 9.5k implementation file had pushed the total barely over the cap and vanished entirely, so the reviewer could see the call sites but not the logic they called.
- **NEXT:** R2.4 Overview = what needs attention only, then R4.1/R4.3 discovery settings + source adapter.
