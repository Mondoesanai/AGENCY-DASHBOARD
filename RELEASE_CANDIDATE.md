# Release candidate — 2026-10-06

**Rollback target:** `30bf2d0` — the commit currently live in production.
**Status: NOT deployed.** All work is local. `outreach.active` is `false`.

**162 tracked requirements, 0 open · 6501 checks across 106 test files, 0 failing.**

---

# THE FOUR GATES

These are separate questions. Passing the first does not advance the others, and
**no combination of the first two makes the system live.**

## GATE 1 — Code verified locally ✅ PASSED

What was actually exercised, and how.

| Area | Evidence | Kind |
|---|---|---|
| Six owner journeys end to end | `owner-journeys.test.mjs` — real `api/` over a socket, each with a negative control | API |
| Public opt-in under every ordering | `optin-ordering.test.mjs`, `optin-confirm.test.mjs` | API + browser |
| Release gate on the real entry points | `release-gate.test.mjs` — auth in all three deployment modes, webhook forgery/tamper/replay, suppression in both key formats, duplicate events, budget refusal before the provider is called, lease recovery | API |
| Preview isolation | `preview-guard.test.mjs` — every handler guarded, verified in production / preview / local | API |
| Worker health and the answering view | `worker-health.test.mjs` | API + browser |
| Public-repository exposure | `secret-scan.test.mjs`, plus real `git commit` controls | git |
| Rollback compatibility | `rollback-safety.test.mjs` — reads `30bf2d0` out of git and compares | git |
| Screens at 1440×900 and 390×844 | opt-in page, Settings, Today, automation answer panel | real Chrome |

**What this gate does NOT cover:** any real provider. See Gate 3.

## GATE 2 — Configuration pending ⬜ NOT STARTED

Each is an owner action. Nothing in code can complete them.

| # | Item | Unblocks | Observable proof |
|---|---|---|---|
| 1 | Business identity + postal address | all email; the invitation refuses to compose without it | People screen stops saying "set both in Settings first" |
| 2 | Spending limit | nothing — but every later step spends | panel says the limit is applied |
| 3 | **Isolated Preview KV** + `PREVIEW_KV_ISOLATED=1` | any use of a preview deployment | a preview URL answers instead of 503 |
| 4 | **Repository visibility decision** | nothing technical; it is a disclosure decision | see `REPO_EXPOSURE.md` |
| 5 | `PUBLIC_BASE_URL` | delivery receipts | set; proven at Gate 3 |
| 6 | Sender domain (Resend) | client reports, the preview invitation | Settings shows Email connected; a report arrives |
| 7 | Twilio number + **A2P 10DLC campaign** | all texting | Settings shows Text connected; campaign approved |
| 8 | Calendly + `CALENDLY_WEBHOOK_KEY` | meetings; the weekly target has no input without it | a slot you book appears as **verified** |
| 9 | Search credentials | asset research stops reporting `needs-search` | lookups return results |

## GATE 3 — Live proof pending ⬜ NOT STARTED

**This gate is why nothing above may be called working.** Every provider check in
this build is a fixture: the real modules driven to the exact HTTP request a
provider would receive, with the provider replaced.

With a designated handset you control, outreach still off for everyone else:

1. Text `PREVIEW` to the outreach number from the handset.
2. The dashboard records **promotional** consent, citing that message.
3. Turn outreach on. Send one text to that handset.
4. **It arrives.**
5. It moves `accepted` → `delivered` from Twilio's own callback.
6. Reply from the handset; the reply appears and the conversation pauses.
7. Text `STOP`; the number is suppressed and a further send is refused.
8. Book a Calendly slot; it appears as a verified meeting. Cancel it; the result changes.

**Not proven until all eight pass:** a real Twilio send, a real delivery callback,
a real inbound reply, a real STOP, a real booking, a real cancellation.
**No text has been sent to anyone.**

## GATE 4 — Production activation pending ⬜ NOT STARTED

Owner review, after Gate 3:

* the metrics and what each one counts (`?do=metric-definitions`)
* the spending limit, and the caps that only warn
* the exact message samples that would go out
* the pause control, tested once
* a **narrow first campaign** — a handful of people, not a list

---

# ROLLBACK — reviewed against the records, not assumed

`rollback-safety.test.mjs` reads `30bf2d0` out of git on every run, so this stays
true as the code moves rather than freezing today's answer into prose.

| Record | Written now | What `30bf2d0` does | Risk |
|---|---|---|---|
| `suppress:phone:<E.164>` | yes | **reads it with a byte-identical `normPhone`** | **none** |
| `suppress:email:<norm>` | yes | identical | none |
| `consentLog` entries | new sources, wording versions | **byte-identical `effectiveConsent`, same four scopes**; unknown fields ignored | none — scope and withdrawals honoured |
| `optin:pending:*` | yes | unknown to it | none — it grants nothing, so ignoring it contacts nobody |
| `budget:res:*`, `spend:job:*` | yes | unknown; it has no spend cap at all | ledger diverges, nothing unsafe |
| `recovery:escalated:all` | yes | unknown | an alert is not shown; no suppression is lost |

**The revert removes rather than loosens.** `lib/phone.js`, `sms-outreach.js`,
`sms-send.js`, `optin.js` and `optin-public.js` **do not exist** at `30bf2d0`, so
a revert removes the ability to text at all.

### The one real caveat

**Revert to the named target, not to "something older".** `f05673c` is a middle
commit where the inbound SMS webhook had no signature check — reverting there
would reintroduce a fixed hole. The test asserts that commit really is in that
state, so this is not a hypothetical.

### A code-only revert is not a full rollback

The code goes back; the data stays. Consent records, suppressions, reservations
and pending opt-ins written under this build remain in KV. The analysis above
says that is safe for `30bf2d0` specifically — **do not also roll back the data**,
and re-check suppression behaviour immediately after.

### If a revert is not safe enough — emergency stop, forward fix

Faster than a revert and it loses nothing:

1. **Pause automation** — `?do=automation-pause`. Stops new site work and
   outreach sending; replies, opt-outs, client reports and billing continue.
2. **Switch outreach off** — `outreach.active = false`. Nothing composes or sends.
3. **Unset `TWILIO_AUTH_TOKEN`** in Vercel if the inbound path is implicated: the
   webhook then fails closed and refuses every inbound message.
4. Fix forward on a branch, verify locally, deploy.

Steps 1–3 take effect on the next request, need no deployment, and leave every
consent record and suppression intact.

---

## Preview

```bash
cd "client-dashboard"
node preview.mjs        # http://localhost:3190 — isolated data, no password
```
