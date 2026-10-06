# Release candidate — 2026-10-06

**Commit:** `HEAD` of `main`, 98 commits ahead of `origin/main`.
**Rollback target:** `30bf2d0` — the commit currently live in production.
**Status: NOT deployed.** The production hold stands and `outreach.active` is `false`.

**154 tracked requirements `[x]`, 0 open.**
**6197 checks across 100 test files, 0 failing, 0 crashed.**
**10 of 14 user journeys demonstrated end to end; 4 stop at a service that is not connected.**

---

## WHAT HAS NOT BEEN PROVEN

Read this before anything else.

Every check in this build is one of two kinds, and **neither proves the product
works with a real provider**:

* **Local browser checks.** A real Chrome, driving the real page, against
  `preview.mjs` — an in-memory store with invented data. They prove the screens
  render, forms submit, refusals appear and nothing throws.
* **Fixture provider checks.** The real modules driven to the exact HTTP request
  a provider would receive, with the provider replaced. They prove we would send
  the right request and would handle the documented response.

**Specifically unproven:**

| Not proven | What would prove it |
|---|---|
| A real Twilio **send** | A text arriving on a designated handset |
| A real **delivery callback** | That send moving `accepted` → `delivered` from Twilio's webhook |
| A real **inbound reply** | Texting back and seeing it in Conversations |
| A real **STOP** | Texting STOP and seeing the number suppressed |
| A real **Calendly booking** | Booking a slot and seeing a verified meeting |

No text has been sent. No outreach has gone out. Nothing has been deployed.
**This is not a live-ready system; it is a candidate that has passed local checks.**

---

## DEPLOYMENT PATH — VERIFIED, NOT ASSUMED

| Question | Answer | How it was established |
|---|---|---|
| Is the repository public? | **YES — public** | Unauthenticated `GET api.github.com/repos/Mondoesanai/AGENCY-DASHBOARD` → 200, `"private": false` |
| Does pushing trigger production? | **YES** | `.vercel/project.json` links `prj_WbIraHjIN…`; prior `vercel[bot]` deployment records on push to `main` |
| Does Preview share production KV? | **YES** | `vercel env ls`: `KV_URL`, `REDIS_URL`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN` all scoped **Production, Preview** |
| Is the admin surface open on Preview? | **No** | `CRON_SECRET` is **Production-only**, so Preview is `authMode() === 'locked'` and every admin request is refused |
| Could `auto-poke` run before auth? | **It could — now fixed** | It sits above the auth gate by design. Combined with shared KV that meant any preview deployment could run the real tick against **live data** and spend Preview-scoped `DATAFORSEO_*` credits. It now refuses unless `VERCEL_ENV === 'production'` |

**Still true and not fixable in code:** Preview writes to the production database
for anything that does reach the store. The durable fix is a separate Preview KV,
which is an owner action in Vercel.

---

## THE RELEASE SEQUENCE — DO NOT RUN THIS YET

Written to be followed exactly. Steps 1–3 are decisions, not commands.

1. **Decide the repository.** Pushing publishes 98 commits to a **public** repo.
   `tests/public-repo.test.mjs` now scans every fixture for a real address,
   number or credential shape, and this pass moved a real client's domain
   (`omtservices.com`) and several resolving domains to reserved ones. That scan
   is a floor, not a guarantee. **Either make the repo private first, or accept
   publication knowingly.**
2. **Decide the Preview environment.** Until Preview has its own KV, every
   preview deployment reads and writes production data. Either give Preview its
   own store or accept that previews touch live records.
3. **Confirm the hold.** `outreach.active` must still be `false` and automation
   unpaused-or-paused deliberately, not by accident.
4. **Tag the rollback point.** `git tag pre-r17 30bf2d0` so the target is named
   rather than remembered.
5. **Push.** `git push origin main`. This triggers a production deployment.
6. **Watch the deployment**, then check `/api/admin?do=automation-status` — it is
   public and reports the heartbeat without a secret.
7. **Verify auth is enforced, not locked.** `GET /api/admin?do=budget-status`
   with no secret must return 401 naming `CRON_SECRET`. With the secret it must
   return 200. If it names a missing `CRON_SECRET`, production has no secret and
   the dashboard is correctly locked — set it before anything else.
8. **Walk the five everyday screens** in a browser before touching any setting.
9. **Only then** begin the owner setup below.

### Rollback limits

`git revert` to `30bf2d0` restores the **code**. It does not restore data, and
three things written by this build are read differently by the old code:

| Written now | What `30bf2d0` does with it |
|---|---|
| `suppress:phone:<E.164>` | The old code reads a digits-only key for some paths — **a suppression could stop matching.** This is the one that can cause real harm |
| `budget:res:*` reservations | Unknown to it; harmless, but the ledger will diverge |
| `optin:pending:*`, new consent sources | Unknown; a pending opt-in would be invisible, and promotional consent recorded here reads as an ordinary consent entry |

**So a rollback is code-only and one-way in practice.** If it is ever needed,
do not also roll back the data, and re-check suppression behaviour immediately.

---

## OWNER SETUP — the shortest sequence that works

Each step: **who acts**, what stays disconnected until it is done, and the
**observable proof**. Nothing earlier depends on anything later.

| # | Step | Who acts | Disconnected until done | Observable proof |
|---|---|---|---|---|
| 1 | **Business identity + postal address** — Settings | Owner, in the dashboard | All email. The invitation path refuses to compose without a postal address (CAN-SPAM) | People screen stops showing "set both in Settings first"; invitations become sendable |
| 2 | **Spending limit** — Settings → Spending | Owner, in the dashboard | Nothing — but every later step spends | Panel says the limit is applied and shows it in the table |
| 3 | **`PUBLIC_BASE_URL`** — Vercel | Owner, in Vercel | Delivery receipts. The status-callback URL is attached at send time | Set. Read at send time; proof arrives at step 6 |
| 4 | **Email sending domain** — Resend: verify the domain, set `RESEND_API_KEY` + `REPORT_FROM` | Owner, at Resend + Vercel | Client reports and the preview invitation | Settings → "Is each service connected?" shows Email (Resend) set up; a report email arrives |
| 5 | **Search** — `BRAVE_SEARCH_API_KEY` | Owner, in Vercel | Asset research; it reports `needs-search` without it | Asset lookups stop returning `needs-search` |
| 6 | **SMS number + A2P campaign** — a **dedicated** outreach number, separate from owner alerts; `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`; then register brand + campaign | Owner at Twilio; **carriers decide**, takes days | All texting | Settings shows Text messages set up; the campaign shows approved |
| 7 | **Publish the opt-in** — put `/optin` behind a QR code; publish keyword `PREVIEW` with the terms wherever the call-to-action appears | Owner | Nothing technical — but it is the only lawful source of promotional consent | Scanning the code loads the page; a test number reaches "One more step" |
| 8 | **Designated-handset round trip** — the eight checks below | Owner, with a phone they control | **"SMS works" is not a true statement until this passes** | See below |
| 9 | **Calendly** — connect in Settings, `CALENDLY_WEBHOOK_KEY`, webhook → `/api/collect?hook=booking` | Owner at Calendly + Vercel | Meetings; the six-a-week target has no input | Booking a slot yourself appears as a **verified** meeting and the target moves |

### Step 8 in full — the round trip

With outreach still **off** for everyone else:

1. Text `PREVIEW` to the outreach number from the handset.
2. The dashboard records **promotional** consent with that message as evidence.
3. Turn outreach on. Compose and send one text to that handset.
4. The text **arrives**.
5. It moves `accepted` → `delivered` on the dashboard.
6. Reply from the handset; the reply appears and the conversation pauses.
7. Text `STOP`; the number is suppressed and a further send is refused.
8. Book a Calendly slot; it appears as a verified meeting.

**Only after all eight does "SMS works" become true.**

### Still disconnected, and by whom

| Item | Blocked by | Owner action? |
|---|---|---|
| Real send, delivery, inbound, STOP | Twilio account + 10DLC **carrier** approval | Owner starts it; carriers decide |
| Real bookings | Calendly connection | Owner |
| Phone line-type lookup | A paid provider — not authorised | Owner's decision; eligibility stays documented-consent-only without it |
| Deliverability figures | Having sent anything to measure | Follows from step 8 |
| A/B findings | Enough observed outcomes; the holdout rules refuse below the floor | Time |

---

## Preview

```bash
cd "client-dashboard"
node preview.mjs        # http://localhost:3190 — isolated data, no password
```
