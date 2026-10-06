# Release candidate — 2026-10-06

**Commit:** `0e1f8b6` *(set by the commit that lands this file; see `git log -1`)*
**Rollback target:** `30bf2d0` — the commit currently live in production.
**Status: NOT deployed.** 79 commits are local only. The production hold stands.

**Every tracked requirement is now `[x]`: 132 done, 0 in progress, 1 externally
blocked (R6.4).** Four of the fourteen user journeys end at a service that is
not connected — each is driven to that boundary and the boundary is named.

---

## Preview

```bash
cd "client-dashboard"
node preview.mjs        # http://127.0.0.1:3190 — loopback only, isolated data, no password
```

## What you can do now that you could not before

1. **Use it on your phone.** Six sections on a bottom tab bar, the current one
   obvious. The tabs used to wrap onto two rows under a 2px underline and the
   header stacked into three.
2. **Read a client's 30-day trend on a phone.** It used to be `display:none`
   below 820px — dropped silently, which reads as "this client has no trend".
   Tap a reading, or step with the ‹ › buttons.
3. **Trust "it's live".** A revision is reported complete only when every thing
   the client asked for is accounted for — checked against the task list before
   work starts, and against their original email before closing.
4. **See a client being ignored.** The sweep watches the client's side, not just
   the machinery: unanswered requests, work waiting on a file nobody asked for,
   shipped-but-unconfirmed, anything open past two weeks.
5. **See which journeys actually work.** The Checks panel reports 10 of 14
   demonstrated end to end and names what would clear the other four.

## What was fixed overnight, and how each was checked

| Gap | Fix | Negative control |
|---|---|---|
| A dropped requirement read as "all done" | Request compared to the task list before execution and to the evidence before closing | 4-part email, extraction drops one: the item gate says FINISHED, the closing gate refuses |
| Asked the client for assets we could have found | Attachments → repo → brand store → researched official source → only then ask | Removing the wiring turns 2 red |
| The research could never run | `lib/search-adapter.js`; the sweep resolves it; `needs-search` when no key | Removing the wiring turns 2 red |
| A 10px chart band was the only way in | 44px ‹ ›, arrow keys, live readout; chart moved **out** of the card `<button>` | — |
| Deployment trigger asserted, not proven | Established from `vercel[bot]` records per commit SHA | — |
| Requests dropped by thread dedupe | Identity only: Gmail id scoped to mailbox + RFC822 Message-ID | Both old predicates kept and asserted to fail |
| The watchdog had no watchdog | Recovery is a monitored worker with history and staleness detection | Flag-only takeover turns 4 red |
| Delivery receipts had no caller | `?hook=sms-status`, Twilio-signed; `send()` supplies the callback | Disabling it turns 15 red |
| Real texts fell on the floor | Classified by the same classifier as email, pause first, into one queue | Old early-return turns 27 red |
| Two reporting figures missing | Cost per qualified conversation; owner response time | Flattering versions turn 7 red |
| "11 of 14 journeys" was unverifiable | The fourteen named; the count corrected **down** to 10 | Claiming 14/14 turns 6 red |

**Totals: 84 files, 5040 checks, 0 failing.** Plus 51 live browser checks at
360/390/430/820/1440 under touch emulation.

### Verification honesty

- **Live-verified:** the deployment trigger (GitHub + Vercel APIs); the two
  client-site fixes, fetched back from their real live URLs.
- **Browser-verified against fixtures:** all mobile and chart work — real
  Chrome, real taps, **emulation, not a physical device**. Real-glass feel, iOS
  Safari safe areas and real keyboard resize are untested.
- **Fixture-only:** SMS end to end, asset research against a live brand page,
  bookings — every path whose provider is not connected.
- **Untested:** rollback. `vercel promote` is documented, not exercised.

---

## Owner dependencies — the one list

Nothing below can be resolved from this side.

| # | What | Why it is blocked | Exact action |
|---|---|---|---|
| 1 | **Release approval** | Pushing `main` deploys production immediately; no staging step | Say go, then `git push origin main` from `client-dashboard` |
| 2 | **Sending domain** (R6.4) | No provider account + SPF/DKIM/DMARC | Create the sender account, add the DNS records, put the key in Vercel |
| 3 | **SMS provider** (journeys 10–12) | No account, so no live send, receipt or inbound reply has happened | Add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM` in Vercel; complete A2P 10DLC; point the inbound webhook at `/api/collect?hook=sms` |
| 4 | **Web search** (R14.2) | Research reports `needs-search` | Set `BRAVE_SEARCH_API_KEY` in Vercel, **or** paste a brand-resources URL on the client's card. The adapter is written and tested; only the key is missing |
| 5 | **Scheduler** (journey 14) | Bookings correctly says "no scheduler connected" | Connect Calendly in Settings; set `CALENDLY_WEBHOOK_KEY` |
| 6 | **Public repository** | `Mondoesanai/AGENCY-DASHBOARD` is public. No credentials are committed, but the source and fixture client names are readable | Decide whether that is intended |
| 7 | **`PUBLIC_BASE_URL`** | Without it, outgoing texts carry no delivery-callback URL | Set it to the production origin in Vercel |

## Release procedure

```bash
cd "client-dashboard"
node tests/run-all.mjs            # expect 5040 checks, 0 failing
node preview.mjs &                # sanity-check the preview
git push origin main              # THIS DEPLOYS. ~30s later it is live.
```

Confirm afterwards:

```bash
curl -s "https://agency-dashboard-omega-red.vercel.app/api/admin?do=auth-mode"
# a deployed build answers without a password; "bad password" means the old build
```

**Rollback:** `vercel ls agency-dashboard` → `vercel promote <url>` to return to
the deployment built from `30bf2d0`. Or `git revert <sha> && git push`, through
the same proven path. **Neither has been exercised.**

## Still open

| Req | State | What is missing |
|---|---|---|
| R6.4 | externally blocked | Owner dependency 2 |

Everything else is `[x]`. Four journeys remain at a provider boundary — that is
recorded in `lib/journeys.js`, shows in the Checks panel, and clears when
dependencies 3 and 5 are met.
