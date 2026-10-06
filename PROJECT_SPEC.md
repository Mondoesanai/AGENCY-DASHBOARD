# Inspiring Websites — Product Specification

**This file is the durable source of truth for WHAT we are building and why.**
`BUILD_PLAN.md` tracks *how far along* each requirement is. `VERIFICATION_REPORT.md`
records *the evidence* that something actually works.

Requirements are consolidated from the owner's instructions in this engagement.
Neither the builder nor the supervisor may silently delete a requirement or weaken
an acceptance criterion in order to declare something finished. New owner requests
are recorded here first.

Last updated: 2026-10-01

---

## 0. Business context (owner-supplied; editable settings, not hard-coded)

| | |
|---|---|
| Business | Inspiring Websites LLC — https://inspiringwebsites.org |
| Brand | Dark green and black |
| Product | Custom business websites |
| Differentiator | A prospect can see a **website preview before deciding to buy** |
| Pricing model | A **build price** + a **monthly maintenance fee**. The monthly fee covers hosting, unlimited revisions, and ongoing improvement to conversion and SEO. |
| **Pricing values** | **Editable business settings. No figure is hard-coded anywhere.** An earlier draft contained specific numbers; the owner's later instruction replaced them with editable settings, and that later instruction wins. |
| Honesty rule | The preview is **complimentary and without obligation**. A paid website is **never** described as free. |
| Targeting | **Established** businesses whose decision-makers would benefit from a better website. Explicitly **not** newly-registered companies. |
| Open question to test, not assume | Established businesses **with no findable website** vs **with a weak website** — which converts better is an experiment, not an assumption. |
| Networking contacts | The owner collects business cards at networking meetings. These people get a **separate, gentler workflow** that respects an existing relationship. |
| Claim discipline | Never claim the system guarantees sales, or that it is "the best in the world." The claim is: it is reliable, measurable and improvable. |

---

## Requirement IDs

Stable IDs. Referenced by `BUILD_PLAN.md` tasks and `VERIFICATION_REPORT.md` evidence.
Status vocabulary: **implemented** (code exists and is wired in) · **verified** (evidence
in the verification report) · **blocked** (needs something external) · **open**.

---

## R1 — Repair the existing dashboard

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R1.1 | Inventory of real screens, workflows, jobs, integrations and data | A written inventory exists naming actual files, cron drivers, storage keys and limits |
| R1.2 | Find the real cause of the revision bug from code/logs/stored job results, not guesswork | The documented cause is reproducible and cited to specific code |
| R1.3 | Documented revision state machine | States at least: queued, validating, running, awaiting review, succeeded, retryable failure, blocked. Transitions are a pure, tested function |
| R1.4 | Bounded retries with backoff; never retry a permanent permission/config failure indefinitely | A permanent cause blocks after 1 attempt; a transient one backs off exponentially and stops at a cap |
| R1.5 | Precise recovery actions | A blocked revision names the action (reconnect integration / pick repo / fix config) in words the owner can act on |
| R1.6 | The revision request and its history are preserved through failure | After blocking and recovery, the original request text still exists and can be worked |
| R1.7 | Client↔repository mapping audit: identity, owner, branch, permissions, stale cached state | Mismatches are detected and reported rather than retried |
| R1.8 | Verify existing flows end to end | Clients CRUD; site/repo association; analytics ranges + empty states; revisions; automations/scheduling; authn/authz and account isolation; integration connect/disconnect; deployment status; settings persistence |
| R1.9 | Completed work must never display as failed | A shipped-and-verified revision reads as done in the dashboard |
| R1.10 | Dependencies upgraded only for a demonstrated need | No unrelated rewrites |

## R2 — Dashboard organisation

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R2.1 | Task-based top-level navigation | Overview · Clients · Acquisition · Automations · Settings (adapt only with a stated reason) |
| R2.2 | Client workspace holds that client's analytics, sites and revisions | Per-client context is not scattered across global screens |
| R2.3 | Acquisition holds prospecting, contacts, campaigns, conversations, bookings, reporting | One place for the acquisition system |
| R2.4 | Overview summarises what needs attention | It is not a dump of every chart and setting |
| R2.5 | Explicit states everywhere | Loading, empty, error, disconnected, success, recovery |
| R2.6 | Visible automation status and a pause control | Status reflects real heartbeats, not a hard-coded label |
| R2.7 | Design quality | Clear hierarchy, restrained dark-green accents, consistent type, comfortable tables/filters, responsive, accessible contrast, keyboard navigation, progressive disclosure |
| R2.8 | Clear primary actions | Scan cards · Import contacts · Create campaign · Review replies · View bookings |
| R2.9 | No fake metrics, no invented integrations, no credentials or jargon in normal flows | Unknown is shown as unknown, never as zero |

## R3 — Contacts and business-card intake

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R3.1 | Card photos: one or many cards per photo, front and back | Multiple distinct cards in one image become distinct contacts; front/back of one card merge into one |
| R3.2 | Extract name, business, role, email, phone, website, address | Fields absent from the card stay empty |
| R3.3 | Never invent a contact detail | No value is fabricated or "corrected" into existence; ambiguous characters are flagged |
| R3.4 | Per-field confidence; source image stored securely | Low-confidence fields are correctable by a human before use |
| R3.5 | CSV import with column mapping and preview | Preview writes nothing and its stated outcome matches what commit actually does |
| R3.6 | Manual entry; optional meeting notes (text or voice) | Notes are stored against the contact |
| R3.7 | Store provenance and relationship | Source, collection date, networking group/event, meeting notes, website, verified identity, owner |
| R3.8 | Store messaging state | Email eligibility; SMS consent scope/source/timestamp/record; suppression and opt-out |
| R3.9 | Deduplicate on normalised email, phone and business domain | Two colleagues at one business remain two contacts |
| R3.10 | Merge review for uncertain matches | Uncertain matches are queued for a human, never auto-merged |
| R3.11 | An import never overwrites consent or opt-out history | Opt-out survives import, merge, deletion and re-import |
| R3.12 | "Met in person" is distinct from "belongs to my networking group" | A meeting is never claimed if it did not happen |

## R4 — Discovery and qualification

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R4.1 | Scheduled discovery with configurable geography, industries, exclusions, weekly volume | Settings are editable, not constants |
| R4.2 | Data sources whose terms permit this collection, storage and outreach use | The chosen source's terms are checked and recorded |
| R4.3 | Source adapter layer | A provider can be swapped without rewriting the pipeline |
| R4.4 | At least one real adapter; if credentials are missing, finish the adapter + setup screen + fixture tests and show it as disconnected | A mocked integration is never displayed as connected |
| R4.5 | Prefer owners/decision-makers only where evidence supports it | A generic inbox is never labelled a verified CEO address; private contact details are not guessed |
| R4.6 | Per prospect: resolve identity → find the real website beyond the listing → match evidence → classify status | Status is one of: verified present · not found after checks · inaccessible · uncertain |
| R4.7 | A missing website link in a listing does not mean there is no website | Language used is "I couldn't find a website linked from your listing" when that is the actual observation |
| R4.8 | Conservative crawl limits; never submit a real contact form | Crawl budget enforced; no form POSTs |
| R4.9 | Store evidence URLs, timestamps, confidence, observations | Objective findings are separated from hypotheses |
| R4.10 | Never claim lost revenue, poor conversion, broken forms or specific performance problems without evidence | Unsupported claims are impossible to emit |
| R4.11 | Prevent duplicate discovery and repeat outreach across sources and campaigns | The same business is not contacted twice |

## R5 — Campaigns

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R5.1 | Cold business email: verified business name, one relevant observation, a truthful offer, one simple next step, clear sender identity, opt-out | No invented familiarity, testimonials, results, urgency or website defects |
| R5.2 | Never claim a preview exists unless one does | Enforced, not advisory |
| R5.3 | Restrained default cadence: intro + up to two follow-ups, several business days apart, editable within safe limits | Timing is configurable but bounded |
| R5.4 | Stop pending outreach on reply, opt-out, hard bounce or booking | Verified by a race test |
| R5.5 | Networking/card follow-up: warmer, lower pressure, based on recorded context | Default is the promised follow-up plus at most one gentle reminder, then pause |
| R5.6 | A card exchange alone never enters someone into a recurring promotional SMS sequence | Enforced by consent scope |
| R5.7 | Separate: requested-preview follow-up, permissioned appointment reminders, separately consented promotional messages | Three distinct permissions |
| R5.8 | No automatic escalation from an unanswered email to a text | Enforced |
| R5.9 | Periodic website rechecks create an internal opportunity, not a message | Material-change threshold, contact cooldown and permission rules defined |

## R6 — Email and SMS infrastructure

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R6.1 | Email provider whose terms permit cold business outreach | Transactional/opt-in-only services are not used for prospecting |
| R6.2 | Prospecting is separated from transactional client mail | A spam complaint against outreach cannot poison client report delivery |
| R6.3 | Outreach-domain separation explained accurately | Do not claim a separate domain removes all reputation or account risk |
| R6.4 | Sender configuration and domain authentication guidance | SPF/DKIM/DMARC steps given |
| R6.5 | Conservative sending limits and business-local sending windows | Enforced by the sender |
| R6.6 | Delivery, bounce, complaint and unsubscribe handling | Each updates contact state |
| R6.7 | Reply ingestion and thread matching | Replies attach to the right contact and campaign |
| R6.8 | Global suppression across all campaigns | One opt-out suppresses everywhere |
| R6.9 | Accurate sender identity, required postal address, working unsubscribe | CAN-SPAM compliant |
| R6.10 | No fabricated engagement, no domain rotation to evade filters, no filter-evasion tactics | Prohibited by design |
| R6.11 | SMS provider support (e.g. Twilio) with business/campaign registration modelled | **Owner decision 2026-10-01: Twilio is OFF.** Build the adapter and consent model, mark disconnected, touch no live account |
| R6.12 | Number validation incl. mobile/landline/VoIP where supported | Number type is a delivery signal, never proof of consent |
| R6.13 | Documented consent appropriate to message type; one-time permission kept separate from ongoing marketing | Scope, wording, version, date, source and withdrawal stored |
| R6.14 | STOP honoured immediately; HELP, quiet hours, inbound replies, provider failures handled | Consent is never inferred from the absence of STOP |
| R6.15 | Production outreach stays inactive until sender configuration, eligibility checks and explicit owner activation | Default is off |

## R7 — Replies and bookings

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R7.1 | An inbound reply immediately pauses that contact's scheduled follow-ups | Verified including the race where a send is already queued |
| R7.2 | Classify replies | interested · wants details/pricing · wants preview · wants a call · not now · not interested · opt-out · auto-reply/OOO · delivery failure · ambiguous |
| R7.3 | Approved knowledge base answers straightforward questions and offers the booking link when appropriate | Respects "send me information first" |
| R7.4 | Never invent availability, discounts, contract terms, capabilities, or a preview that does not exist | Enforced |
| R7.5 | Never reply conversationally to bounces or automated mail | Enforced |
| R7.6 | Loop prevention | Max automatic turns, cooldown, duplicate detection, escalation |
| R7.7 | Owner tools | Unified inbox · AI response history · manual takeover · draft-only and automatic modes · notifications for interested and uncertain replies |
| R7.8 | Booking integration with the real scheduler (Calendly or existing) | Tracked via verified webhook or supported API sync — **a link click is not a booking** |
| R7.9 | Cancellations and reschedules handled | Attribution survives both |
| R7.10 | Bookings attributed to contact, source, campaign and message variant | Recorded at booking time |

## R8 — Budget controls

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R8.1 | Owner sets any supported weekly or monthly budget (e.g. $50/week, $100/month) | Editable |
| R8.2 | Central cost ledger | Discovery, enrichment, verification, AI, lookup, messaging, infrastructure allocation |
| R8.3 | Estimated vs reserved vs reconciled actual are distinct | All three visible |
| R8.4 | Atomic pre-job reservation; concurrency-safe; reconciled after completion | Concurrent workers cannot overspend one allowance |
| R8.5 | Discretionary paid work stops when exhausted; reply ingestion, opt-outs and monitoring keep working | Essentials bypass the cap and are still recorded |
| R8.6 | Part of the budget reserved for replies and live conversations | Configurable share |
| R8.7 | Provider charges the app cannot cap are explained plainly | No guaranteed hard total is advertised; provider-side limits recommended |
| R8.8 | Show period, spent, reserved, remaining, next reset; no weekly/monthly double counting; explicit rollover | Weekly and monthly are two windows over the same money |
| R8.9 | A retried worker cannot charge the same reservation twice | **Added 2026-10-01, not in the owner's original list.** Found while building R8.4: a worker that crashes after reconciling and is retried would book the cost again. Reconciling the same reservation id a second time is ignored. |

## R9 — Controlled campaign improvement

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R9.1 | A small number of variants across comparable eligible groups | Versions, assignments and outcomes stored |
| R9.2 | Primary outcomes | Qualified positive replies · qualified bookings · attended calls · owner-recorded sales |
| R9.3 | Secondary outcomes | Delivery, bounces, complaints, opt-outs, filtered clicks |
| R9.4 | Do not optimise primarily for opens or raw clicks | Scanner activity and privacy-related tracking limits handled explicitly |
| R9.5 | Adequate sample size and stated uncertainty | A winner is never declared from two replies |
| R9.6 | Keep a baseline or holdout | A holdout group is always retained, is never reassigned to a variant mid-experiment, and its results are reported alongside every variant |
| R9.7 | Changes are bounded by owner-approved settings, logged, and reversible | Full change log and rollback |
| R9.8 | Optimisation may never alter consent rules, suppression, prices, contractual promises, sender identity or budget limits | Hard prohibition |
| R9.9 | Auto-pause when deliverability or negative-response indicators exceed configurable thresholds | Thresholds editable |

## R10 — Reporting

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R10.1 | Real metrics with clear definitions | Contacts discovered/imported · qualified and eligible · emails attempted/accepted/delivered/bounced · SMS attempted/delivered · unique contacts reached · human replies · positive replies · qualified leads · verified bookings/cancellations/attended · opt-outs and complaints · spend · cost per qualified reply and per booking |
| R10.2 | Totals distinguished from unique people | Both shown where they differ |
| R10.3 | Unknown is distinguished from zero; incomplete tracking is marked | Never silently rounded to 0 |
| R10.4 | Every report can be filtered without losing its definitions | Filters for period, source, campaign, industry, geography, channel and message version; a filtered view states the same metric definitions as the unfiltered one, and an empty filter result reads as empty rather than zero |
| R10.5 | Funnel reporting and source attribution | End to end |
| R10.6 | An unqualified cold prospect is never described as a warm lead | Language enforced |

## R11 — Reliability, security, unattended operation

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R11.1 | Durable jobs and persisted state; scheduled work runs with the browser closed and survives deploys and worker restarts | Demonstrated |
| R11.2 | Idempotent execution and sending | No duplicate sends |
| R11.3 | Retry limits and dead-letter recovery | Every job type has a maximum attempt count; a job that exhausts it moves to a dead-letter list that is visible in the dashboard and replayable, never silently dropped |
| R11.4 | Worker leases and stale-job recovery | A dead worker's job is reclaimed safely |
| R11.5 | Verified webhook signatures and replay protection | Duplicate and out-of-order webhooks handled |
| R11.6 | Rate-limit handling | A 429 or provider rate-limit response backs off exponentially, respects a Retry-After header when one is given, and never counts against the job's failure budget |
| R11.7 | Server-side secrets; authorization on every client/contact/job endpoint; safe logging | No credential leaks in logs |
| R11.8 | Retention and deletion controls | Right to be forgotten supported |
| R11.9 | SSRF protection for website analysis | Malicious URLs cannot reach internal services |
| R11.10 | Scraped pages, card text and inbound messages are DATA, never instructions to the model | Prompt-injection resistant |
| R11.11 | Structured AI output validated before any action | Schema-checked |
| R11.12 | Ambiguous provider timeouts reconciled before retry | A send that may have succeeded is not blindly repeated |

## R12 — Verification

| ID | Requirement | Acceptance criteria |
|---|---|---|
| R12.1 | Risk-based test matrix executed, failures fixed, affected checks rerun | Recorded in VERIFICATION_REPORT.md |
| R12.2 | Full-path tests: browser → API → storage → worker → provider fixture → webhook → dashboard | At least the critical paths |
| R12.3 | Priority scenarios | Revision eligibility/blocked recovery/retry classification · duplicate imports · ambiguous OCR · real website missed by a listing · suppression and consent enforcement · reply or opt-out during a queued send · duplicate and out-of-order webhooks · ambiguous send timeouts · budget exhaustion under concurrency · worker restarts · booking cancel/reschedule · cross-account authorization · malicious URLs and prompt injection · provider outages and rate limits |
| R12.4 | Load testing with synthetic data and mocked providers | Thousands of contacts, concurrent jobs, webhook bursts, large imports, card batches; environment and limits stated |
| R12.5 | Accelerated simulated seven-day operation, clearly labelled as simulated | Scheduling boundaries, budget resets, inbound events, outages, restarts |
| R12.6 | A real seven-day staging soak procedure prepared | Seven real days are only claimed after seven days have actually elapsed |
| R12.7 | Build, lint, migration, integration and browser checks; desktop and mobile inspected | Run and recorded |
| R12.8 | A green build is never equated with functional verification; an unconfigured integration is never called production-ready | Stated in every report |

---

## Gaps I could not recover from this conversation

Recorded honestly rather than guessed:

- **G1 — Pricing values.** The owner replaced specific figures with "editable business settings". The actual numbers to seed those settings were never restated, so they remain unset and must be entered by the owner.
- **G2 — Chosen cold-email provider.** Researched recommendation still owed; the owner has not chosen one. Blocks R6.1–R6.5 activation only.
- **G3 — Chosen discovery data source.** Not selected. Blocks R4.4 activation only.
- **G4 — Service area / industries / weekly volume.** Not specified. Needed to seed R4.1 defaults.
- **G5 — Voice notes (R3.6).** The owner asked for "short text or voice notes". Text is specified; the voice capture path (recording UI vs upload) was never detailed.

## Part 13 — Business-card relationships and SMS as a product (owner addendum, 2026-10-05)

Added after the original 120 were complete. The owner's words: *"I want to
photograph business cards after a networking meeting and have the system
organize the contacts, remember the relationship, identify the appropriate
opportunity, and handle eligible follow-up intelligently"*, and *"SMS must be a
first-class channel controlled through our agency dashboard... A phone-number
field and a 'send text' button do not satisfy this requirement."*

One point in the addendum contradicts itself and is resolved here in favour of
the detailed version. Its body states: *"A published number, business card,
mobile-number lookup, or failure to reply STOP does not establish SMS
permission."* A closing line says contacts handed over "have already opted in".
The body is what is implemented: **adding** contacts from cards is instant and
unrestricted; **marketing SMS** requires its own recorded consent, which is
what the law requires and what the rest of the addendum assumes. The addendum's
own remedy — a short disclosed opt-in or QR flow — is the supported path.

| Req | What it means | Notes |
|---|---|---|
| R13.1 | A batch of cards becomes contacts with field-level confidence, correction, and duplicate matching that never merges two people at one company | Existing `card-intake` extraction and review reused; batch context (event, group, date, owner) already existed |
| R13.2 | Each card is routed to a relationship path, with the reason, the next action and the date shown and editable | Seven paths. A contact on any of them can never enter a cold sequence |
| R13.3 | A requested preview becomes a tracked production task; "your preview is ready" is impossible before one exists | No automatic website production exists and none is claimed; this creates an owner task |
| R13.4 | SMS is a complete workflow: composition, preview, scheduling, delivery state, two-way conversation, ownership, takeover, quiet hours, cost | Delivery is a provider's job; the workflow and interface are ours |
| R13.5 | Messages are specific, natural and easy to answer, and may not overclaim | The R9.8 prohibitions apply to texts exactly as to email |
| R13.6 | Replies are answered on their merits, with bounded automatic turns and immediate manual takeover | Takeover cancels queued automatic replies rather than flagging them |
| R13.7 | Email and SMS share one history and never overlap; an unanswered cold email never becomes a text | Opt-out scope is honoured across channels |
| R13.8 | Relationship and SMS results are reported separately from cold discovery | Delivery is not interest; a scanned card is not a qualified lead |
| R13.9 | The real user journeys are demonstrated, with fixtures until services are configured and live checks labelled separately | Nothing is sent to prospects as a test |

### Part 14 — Review gaps before release (owner addendum, 2026-10-05)

The four blockers from the latest review. Each is a hole that the previous
round's fix moved rather than closed.

| Req | What it means | Notes |
|---|---|---|
| R14.1 | A requested outcome can never be silently omitted: the request is compared against the extracted task list before execution, and against the completion evidence before closing, with an explicit disposition for every ask | A second review is a safeguard, not a guarantee. "Could not tell" must behave as "no" at a gate whose failure mode is lying to a client |
| R14.2 | When no source URL is on file, the organisation's official site and brand/usage terms are researched and identity verified before an asset is selected | Public availability is not permission. Ambiguity about identity, eligibility or rights is a question for the client, not a judgement call |
| R14.3 | A dense chart on a phone is operable without hitting a 10px band, and its controls are not nested inside another control | `stopPropagation` hides a semantic nesting problem rather than fixing it |
| R14.4 | The release trigger is established from the repository-to-host configuration itself | Version drift and stale responses establish difference, not cause |
