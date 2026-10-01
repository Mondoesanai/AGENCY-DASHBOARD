# Acquisition System Build — persistent plan & status

**This file is the continuity anchor.** Every working session reads this first and updates it
before stopping. Never delete completed history — mark it DONE with a date.

Last updated: 2026-10-01

---

## Hard constraints discovered in inventory (do not design around these being false)

| Constraint | Detail | Consequence for this build |
|---|---|---|
| **Vercel Hobby = 12 serverless functions, all 12 used** | `api/` has exactly 12 `.js` files | **No new API files.** Every new endpoint routes through `api/admin.js` (`?do=` switch, existing pattern) or an existing public file (`api/collect.js` for unauthenticated webhooks). |
| **No SQL database** | Storage is Upstash Redis KV via `lib/store.js` | Contacts/campaigns/ledger use KV with explicit secondary-index sets (`sadd`/`smembers`), the pattern already used by `registry:slugs`. Scales fine to the "thousands of contacts" target; no joins. |
| **store.js has no `del`, no sorted-set range, no transactions** | Only get/set/sadd/smembers/mget/incr/zincr/ztop/pfadd/pfcount; `set` supports `{nx, ex}` | Must add `del` + atomic reserve helpers. `incr` is atomic (safe for budget counters); `set {nx}` is the lock primitive (already used by `revisions:lock`). |
| **No build step, no framework** | Vanilla single-file SPA `public/index.html` (2334 lines), plain ESM in `lib/` | No React/Tailwind. New UI extends the existing SPA + its CSS tokens. No bundler to add. |
| **Function timeout 60s (300s on `api/admin.js`)** | `vercel.json` | Long work must be chunked into bounded ticks, like the existing `lib/tick.js`. |
| **Cron: one daily Vercel cron + GitHub Actions + public rate-limited poke** | `vercel.json` crons, `.github/workflows` | Reuse `lib/tick.js` driver; do not invent a new scheduler. |
| **Email today = Resend (transactional)** | `lib/winsrecap.js`, `lib/revisions.js` | Resend's terms are for transactional/opt-in mail. **Cold prospecting needs separate infrastructure** — see Open Decisions. |
| **Deliverability ramp is calendar-time bound** | New sending domain has no reputation | Cold send volume must ramp over ~2–4 real weeks. Code cannot compress this. |

---

## Owner decisions already made

- **Twilio: OFF.** Build the SMS adapter + consent model fully, mark disconnected, never touch a live account. No A2P registration this round.
- **Full build, no phase-gating.** Don't stop to ask between parts; sequence is dictated by dependencies only.
- **Google Search Console: optional per site.** Not required for the build; owner decides per client.
- **Never claim guaranteed sales or "best in the world."** Measurable, improvable — that's the claim.

---

## Open decisions needing owner input (do NOT block other work on these)

1. **Cold-email sending infrastructure.** Resend is transactional/opt-in; using it for unsolicited prospecting violates its terms and risks the account that currently sends client reports. Needs a separate provider + separate sending domain (so a spam complaint can never poison `inspiringwebsites.org` client mail). Candidates to research + price before recommending. **Until chosen: build the provider adapter, ship it disconnected.**
2. **Discovery data source.** Must permit storage + outreach use under its terms. Adapter-first, fixtures for tests.
3. **Business settings** — build price, monthly maintenance fee, service area, industries. Editable settings, seeded with placeholders until owner sets them.

---

## Status key
`[ ]` not started · `[~]` in progress · `[x]` done + verified · `[!]` blocked (reason)

---

## PART 1 — Diagnose & repair existing app
- [x] **Inventory** of api/, lib/, public/, tests/, cron, KV key space — done 2026-10-01 (table above)
- [x] Revision bug #1: client replies in an existing thread silently dropped (`threadHasSentMessage` fired on thread history alone) — fixed + regression test, 2026-09-30
- [x] Revision bug #2: own outgoing notification mail re-ingested as a client request — fixed + test, 2026-09-30
- [x] Revision bug #3: manual ticket showed "reply failed — check it yourself" when no reply was ever attempted — fixed + test
- [x] Agent bug: legit title/description rewrites rejected as "keyword stuffing" (raw-markup word frequency) — fixed + test
- [x] Agent bug: transient GitHub timeouts failed whole cycle — bounded retry added
- [x] **Revision state machine** — `lib/revision-state.js`, 46 tests, wired into recordAttempt/resolve/done/cancel/retry — 2026-10-01 — formalize queued/validating/running/awaiting-review/succeeded/retryable-failure/blocked. Today's states are ad-hoc strings (`scheduled`/`needs attention`/`done`/`cancelled`) with retry logic scattered across `lib/revisions.js` + `lib/agent.js`
- [x] Classify failures permanent vs retryable; never retry permanent permission/config failures — 2026-10-01
- [x] Actionable recovery messages exposed on the ticket (`blockedBy.label/hint`) + `stateLabel` in revisionsStatus — UI rendering still to do in Part 2
- [ ] Repo-mapping audit: client→repo identity, owner/branch/permission checks, stale cached integration state
- [ ] Verify flows end-to-end: clients CRUD, site/repo association, analytics ranges + empty states, revisions, automations/scheduling, authn/authz, integration connect/disconnect, deploy status, settings persistence

## PART 2 — Dashboard information architecture
- [ ] Top-level nav: Overview / Clients / Acquisition / Automations / Settings
- [ ] Client workspace holds that client's analytics, sites, revisions
- [ ] Overview = what needs attention only
- [ ] Explicit loading / empty / error / disconnected / success states throughout
- [ ] Visible automation status + pause control
- [ ] Responsive, keyboard-navigable, accessible contrast, dark-green restrained accents

## PART 3 — Contacts & business-card intake
- [x] Contact data model + KV indexes (email/phone/domain normalized dedup) — `lib/contacts.js`, 54 tests — 2026-10-01
- [ ] Card OCR: multi-card photos, front/back, confidence per field, ambiguous-char flagging
- [ ] CSV import with column mapping + preview; manual entry; meeting notes
- [x] Consent model: scope, source, timestamp, wording version, withdrawal — append-only, withdrawal always wins — 2026-10-01
- [x] Merge review for uncertain duplicates (exact=merge, same-phone/same-person=review, same-business=separate) — 2026-10-01
- [x] "Met in person" vs "in my networking group" distinction (relationship rank, stronger claim wins on merge) — 2026-10-01

## PART 4 — Discovery & qualification
- [ ] Source adapter layer + at least one real adapter (disconnected until credentials)
- [ ] Identity resolution → real-website search → evidence matching → status (present/not-found/inaccessible/uncertain)
- [ ] Conservative crawl limits, SSRF protection, no form submission
- [ ] Evidence store: URLs, timestamps, confidence, objective findings vs hypotheses
- [ ] Fit + eligibility scoring; cross-source duplicate prevention

## PART 5 — Campaign workflows
- [ ] A: cold business email (intro + ≤2 follow-ups, editable within safe limits, stop on reply/opt-out/bounce/booking)
- [ ] B: networking/card follow-up (warmer, promised follow-up + ≤1 reminder, then pause)
- [ ] No auto-escalation from unanswered email into SMS
- [ ] Website-recheck → internal opportunity, with material-change threshold + contact cooldown

## PART 6 — Email & SMS integrations
- [ ] Email provider adapter, sender config, domain auth guidance, conservative limits, sending windows
- [ ] Delivery/bounce/complaint/unsubscribe handling; reply ingestion + thread matching; global suppression
- [ ] CAN-SPAM: accurate identity, postal address, working unsubscribe
- [ ] SMS adapter + consent model + number validation (built, left disconnected per owner)

## PART 7 — Reply handling & bookings
- [ ] Inbound reply pauses that contact's follow-ups immediately
- [ ] Classifier: interested / details / preview / call / not now / not interested / opt-out / auto-reply / bounce / ambiguous
- [ ] Approved knowledge base; booking link when appropriate; loop prevention (max turns, cooldown, dedup, escalation)
- [ ] Unified inbox, AI history, manual takeover, draft-only vs automatic modes, notifications
- [ ] Calendly/scheduler integration via verified webhooks; cancel/reschedule; attribution to contact/source/campaign/variant

## PART 8 — Budget controls
- [x] Cost ledger: 7 categories, append-only daily ledger + per-category monthly totals — `lib/budget.js`, 42 tests — 2026-10-01
- [ ] Estimated vs reserved vs reconciled actuals
- [x] Atomic pre-job reservation, concurrency-safe (25-worker race test), reconcile + release + crash-safe wrapper — 2026-10-01
- [x] Discretionary jobs stop at exhaustion; essentials (reply/opt-out/monitoring/webhook) bypass the cap but are still recorded; configurable conversation reserve (default 20%) — 2026-10-01
- [x] Period/spent/reserved/remaining/next-reset in `budgetStatus()`; weekly+monthly are two windows over the same money (not summed); rollover explicit, defaults off — UI still to render in Part 2
- [x] `uncappableNote()` — states plainly that subscriptions/in-flight usage/late-posting charges cannot be capped by the app — 2026-10-01

## PART 9 — Controlled experimentation
- [ ] Variant storage, assignment, outcomes; baseline/holdout
- [ ] Primary = qualified positive replies, bookings, attended calls, owner-recorded sales
- [ ] Sample-size + uncertainty gating; never call a winner off two replies
- [ ] Never auto-change consent rules, suppression, prices, promises, sender identity, budgets
- [ ] Full change log + rollback; auto-pause on deliverability/negative-response thresholds

## PART 10 — Reporting
- [ ] Real metrics with definitions; totals vs unique; unknown ≠ zero; incomplete tracking marked
- [ ] Filters: period, source, campaign, industry, geography, channel, version; funnel + attribution

## PART 11 — Reliability & security
- [ ] Durable jobs, idempotent sends, retry limits, dead-letter, worker leases, stale-job recovery
- [ ] Verified webhook signatures + replay protection; rate-limit handling
- [ ] Authorization on every endpoint; safe logging; retention/deletion; SSRF protection
- [ ] Scraped pages / card text / inbound messages treated as untrusted data, never instructions
- [ ] Structured AI output validated before action
- [ ] Provider-timeout reconciliation before retry (no duplicate sends)

## PART 12 — Verification
- [ ] Risk-based test matrix executed; failures fixed and rechecked
- [ ] Load test with synthetic data + mocked providers (thousands of contacts, concurrent jobs, webhook bursts)
- [ ] Browser checks desktop + mobile
- [ ] Never equate green build with functional verification

---

## Session log
- **2026-10-01** — Inventory done. Constraints table written.
- **2026-10-01** — ROOT CAUSE FOUND for the repeat-failure bug: `agentStatus()` returns a flat list of decline reasons mixing permanent config problems (no repo linked, no token, no permission) with self-resolving ones (pacing, monthly budget). `runAgentCycle` returned `{skipped:true}` for all of them and `recordAttempt` just logged "not eligible yet" — no failure counted, nothing blocked, no recovery shown. A ticket on a repo-less site was therefore retried on EVERY tick forever (seen live on Renewity). Fixed with an explicit state machine + reason classifier. 46 unit + 2 end-to-end regression tests.
- **2026-10-01** — Part 3 data model: `lib/contacts.js` (normalisation, confidence-tagged fields, append-only consent, eligibility gate, dedup/merge, opt-out suppression that survives deletion + re-import). Added `store.del/srem/reserve`; `reserve` is the concurrency-safe budget primitive for Part 8. Test caught a real bug: dedup compared BUSINESS names, which flags every colleague as their coworker — now compares person names.
- **2026-10-01** — Part 8 budget ledger: cents-based (no float drift), UTC period keys, reserve→run→reconcile with atomic INCR so 25 concurrent workers cannot overspend one allowance, double-reconcile guard for retried workers, crash-safe release, conversation reserve, essential bypass, pause.
- **2026-10-01** — Suite: revision-state 46, inbox 73, agent 101, platform 59, reports 31 — all green.
