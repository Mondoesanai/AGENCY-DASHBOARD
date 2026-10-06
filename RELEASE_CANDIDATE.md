# Release candidate — 2026-10-06

**Commit:** `0ea8764`
**Rollback target:** `30bf2d0` — the commit currently live in production.
**Status: NOT deployed.** 72 commits are local only. The production hold stands.

---

## What you can do now that you could not before

Open the preview, then:

1. **Use it on your phone.** Six sections on a bottom tab bar, the current one
   obvious. Previously the tabs wrapped onto two rows under a 2px underline and
   the header stacked into three, so the first real content started most of a
   screen down.
2. **Read a client's 30-day trend on a phone.** It used to be `display:none`
   below 820px — the chart was dropped silently, which reads as "this client has
   no trend". Tap a reading, or step with the ‹ › buttons, and the value and
   date appear under the chart.
3. **Trust "it's live".** A revision is only reported complete when every thing
   the client asked for is accounted for — checked twice, once against the
   extracted task list and once against their original email.
4. **See a client who is being ignored.** The sweep now looks at the client's
   side, not just the machinery: unanswered requests, work waiting on a file
   nobody asked for, shipped-but-unconfirmed, anything open past two weeks.

## What was fixed, and how it was checked

| Gap | Fix | Evidence |
|---|---|---|
| A dropped requirement read as "all done" | Request compared to the task list before execution and to the evidence before closing; every ask gets one disposition | `tests/coverage.test.mjs` 48 — including the asked-for case: 4-part email, extraction drops one, the item gate says FINISHED and the closing gate refuses |
| Asking the client for an asset we could have found | Attachments → repo → brand store → researched official source → only then ask | `tests/asset-search.test.mjs` 52, `tests/asset-research.test.mjs` 56 |
| A 10px chart band was the only way in | 44px ‹ ›, arrow keys, live readout; chart moved **out** of the card `<button>` | `tests/mobile-browser.mjs` M5/M5b (live), `tests/trend.test.mjs` 30 |
| Deployment trigger asserted, not proven | Established from `vercel[bot]` deployment records per commit SHA | `RELEASE_TRIGGER.md` |
| A request dropped by thread-level dedupe | Dedupe on Gmail id scoped to mailbox + RFC822 Message-ID; resemblance removed entirely | `tests/dropped-requests.test.mjs` 30 |
| The watchdog had no watchdog | Recovery is a monitored worker with persisted history and staleness detection | `tests/sweep-health.test.mjs` 38 |

**Totals: 79 files, 4837 checks, 0 failing.** Plus 51 live browser checks at
360/390/430/820/1440 under touch emulation.

### Verification honesty

- **Live-verified:** the deployment trigger (GitHub/Vercel APIs); the two client
  site fixes (fetched from the real live URLs).
- **Browser-verified against fixtures:** everything in the mobile and chart
  work — real Chrome, real taps, **emulation not a physical device**. Real-glass
  feel, iOS Safari safe areas and real keyboard resize are untested.
- **Fixture-only:** SMS end to end, asset research against a live brand page,
  and any path needing a provider that is not connected.
- **Untested:** rollback. `vercel promote` is the documented mechanism; it has
  not been exercised here.

---

## Owner dependencies — the one list

Nothing below can be resolved from this side.

| # | What | Why it is blocked | Exact action |
|---|---|---|---|
| 1 | **Release approval** | Pushing `main` deploys production immediately; no staging step | Say go, and `git push origin main` from `client-dashboard` |
| 2 | **Sending domain** (R6.4, G2) | No provider account + SPF/DKIM/DMARC | Create the sender account, add the DNS records, put the key in Vercel |
| 3 | **SMS provider** (R13.4/13.6/13.9) | No account connected, so no real send, delivery receipt or inbound reply has ever happened | Connect Twilio (or chosen provider) and add credentials to Vercel |
| 4 | **Web-search provider** (R14.2) | Asset research cannot look anything up; returns `needs-search` | Configure a search provider, **or** paste an organisation's brand-resources URL on the client's card |
| 5 | **Scheduler** | Bookings shows "no scheduler connected" — correctly, it is not connected | Connect Calendly in Settings |
| 6 | **Public repository** | `Mondoesanai/AGENCY-DASHBOARD` is public. No credentials are committed, but the source and fixture client names are readable | Decide whether that is intended; make it private if not |

## Release procedure

```bash
cd "client-dashboard"
node tests/run-all.mjs            # expect 4837 checks, 0 failing
node preview.mjs &                # sanity-check the preview
git push origin main              # THIS DEPLOYS. ~30s later it is live.
```

Confirm afterwards:

```bash
curl -s "https://agency-dashboard-omega-red.vercel.app/api/admin?do=auth-mode"
# a deployed build answers without a password; "bad password" means the old build
```

**Rollback:** `vercel ls agency-dashboard` → `vercel promote <url>` to return to
the deployment built from `30bf2d0`. Or `git revert <sha> && git push`, which
goes out through the same proven path. Neither has been exercised.

## Still open

| Req | State | What is missing |
|---|---|---|
| R6.4 | blocked | Owner dependency 2 |
| R13.4, R13.6, R13.9 | in progress | Owner dependency 3 — built and fixture-tested; no live send has occurred |
| R13.8 | in progress | Cost per qualified conversation and owner response time are not computed |
| R14.2 | in progress | Owner dependency 4 — logic complete and fixture-verified; never run against a live brand page |
