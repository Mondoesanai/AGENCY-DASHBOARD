# Release candidate — 2026-10-06

**Commit:** `d069d52`
**Rollback target:** `30bf2d0` — the commit currently live in production.
**Status: NOT deployed.** 94 commits are local only. The production hold stands and
`outreach.active` is `false`.

**152 tracked requirements `[x]`, 0 open, 1 externally blocked.**
**6094 checks across 97 test files, 0 failing, 0 crashed.**
**10 of 14 user journeys demonstrated end to end; 4 stop at a service that is not connected.**

---

## WHAT HAS NOT BEEN PROVEN

Read this before anything else in this file.

Every check in this build is one of two kinds, and **neither of them proves the
product works with a real provider**:

* **Local browser checks.** A real Chrome, driving the real page, against
  `preview.mjs` — an in-memory store with invented data. They prove the screens
  render, the forms submit, the refusals appear and nothing throws. They prove
  nothing about Twilio, Calendly, Resend or Google.
* **Fixture provider checks.** The real modules driven to the exact HTTP request
  a provider would receive, with the provider replaced. They prove we would send
  the right request and would handle the documented response. They do not prove
  the provider accepts it.

**Specifically unproven, and not claimable until a designated handset and a real
account have done it:**

| Not proven | What would prove it |
|---|---|
| A real Twilio **send** | A text arriving on a designated handset |
| A real **delivery callback** | That send moving from `accepted` to `delivered` from Twilio's own webhook |
| A real **inbound reply** | Texting back from that handset and seeing it in Conversations |
| A real **STOP** | Texting STOP and seeing the number suppressed |
| A real **Calendly booking** | Booking a slot and seeing it appear as a verified meeting |

No text has been sent to anyone. No prospect outreach has gone out. Nothing has
been deployed.

---

## Preview

```bash
cd "client-dashboard"
node preview.mjs        # http://localhost:3190 — isolated data, no password
```

---

## THE SETUP LIST

**One list, in order.** Each step says what it unblocks and how you know it worked.
Nothing earlier depends on anything later.

### 1. Business identity — unblocks all email
In the dashboard: **Settings**.
Set the business name, the postal address, and the reply-to address.
*Why first:* CAN-SPAM requires a real postal address in commercial email, and the
invitation path refuses to compose anything without one. Four fixture contacts
currently show "cannot be invited yet" for exactly this reason.
**Done when:** the People screen stops saying "set both in Settings first".

### 2. Spending limit — unblocks nothing, but caps everything
In the dashboard: **Settings → Spending**.
Set a weekly and/or monthly limit. Blank means no limit; it is **not** the same as 0,
which would refuse every job.
*Why here:* every step below starts spending money. This is the only step that
costs nothing and prevents a surprise.
**Done when:** the panel says the limit is being applied and shows it in the table.

### 3. Anthropic key — unblocks reports, revisions, the SEO agent
In Vercel: `ANTHROPIC_API_KEY`.
**Done when:** Settings → "Is each service connected?" shows AI (Anthropic) as set up.

### 4. Resend — unblocks client reports and the preview invitation
In Vercel: `RESEND_API_KEY`, `REPORT_FROM`.
**Done when:** the same panel shows Email (Resend) as set up.

### 5. GitHub token — unblocks shipping changes to client sites
In Vercel: `GITHUB_TOKEN`.
**Done when:** the panel shows GitHub as set up, and Today stops listing sites with
no repository linked.

### 6. Public base URL — unblocks delivery receipts
In Vercel: `PUBLIC_BASE_URL` (e.g. `https://your-dashboard.vercel.app`).
*Why before Twilio:* the status-callback URL is attached to each outbound message
at send time. Without this, Twilio has nowhere to report to and "accepted" never
becomes "delivered" or "failed".
**Done when:** set. It is read at send time; there is nothing to click.

### 7. Twilio account + a dedicated outreach number
In Vercel: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`.
The outreach number must be **separate** from the number used for owner alerts, so
prospect traffic can never be sent from the number that reaches you.
**Done when:** Settings shows Text messages as set up.

### 8. A2P 10DLC registration — unblocks sending at all
Through Twilio. Register the brand and the campaign. The campaign's sample messages
and its call-to-action must match what the opt-in page actually says — the wording is
served at `/api/collect?hook=optin-terms` and is the same string recorded with every
consent.
*This takes days, not minutes, and is decided by the carriers, not by Twilio.*
**Done when:** the registration is approved. Record the decision and its carrier
reference in the dashboard.

### 9. Point the webhooks at the dashboard
In Twilio, for the outreach number:
* inbound messages → `https://<base>/api/collect?hook=sms`
* delivery status → set automatically from `PUBLIC_BASE_URL`; nothing to do here.
**Done when:** texting the number produces an entry in Conversations.

### 10. Publish the opt-in page and the keyword
The page is at `/optin`. Put it behind a QR code on cards, vehicles and counter
signage, and publish the keyword `PREVIEW` alongside the terms **wherever the
call-to-action appears** — the terms must be visible at the point somebody decides.
**Done when:** scanning the code loads the page and submitting enrols a test number.

### 11. Calendly — unblocks meetings
Connect Calendly in Settings and set `CALENDLY_WEBHOOK_KEY` in Vercel. Point the
webhook at `https://<base>/api/collect?hook=booking`.
**Done when:** booking a slot yourself shows up on the Meetings screen as a verified
booking, and the six-a-week target moves.

### 12. THE LIVE TEST — do this before any real prospect
With a designated handset you control, and outreach still **off** for everyone else:

1. Text `PREVIEW` to the outreach number from the handset.
2. Check the dashboard records promotional consent with your message as evidence.
3. Turn outreach on. Compose and send one text to that handset from Conversations.
4. Check the text **arrives**.
5. Check it moves from `accepted` to `delivered` on the dashboard.
6. Reply from the handset. Check the reply appears and the conversation pauses.
7. Text `STOP`. Check the number is suppressed and a further send is refused.
8. Book a slot through Calendly. Check it appears as a verified meeting.

**Only after all eight does "SMS works" become a true statement.** Until then this
document and the test suite describe intent and fixtures, not a working channel.

### 13. Then, and only then
Turn outreach on for real prospects. Start with a handful. The meetings target and
the no-show analysis both refuse to draw conclusions below 20 observations, which is
deliberate.

---

## Still blocked, and by whom

| Item | Blocked by | Not us |
|---|---|---|
| Real SMS send, delivery, inbound, STOP | Twilio account + 10DLC carrier approval | ✔ |
| Real bookings | Calendly connection | ✔ |
| Phone line-type lookup | A paid lookup provider — not authorised, so eligibility stays documented-consent-only | ✔ |
| Deliverability figures | Having sent anything to measure | ✔ |
| A/B findings | Enough observed outcomes; the holdout rules refuse below the floor | ✔ |

## Reverting

Reverting the application code to `30bf2d0` is a `git revert`. **Persisted data is
a separate question**: consent records, suppressions, reservations and conversation
threads written under this build remain in KV and are read by the old code, which
does not know about `suppress:phone` in E.164 form, spend reservations, or the new
consent sources. A revert should therefore be treated as code-only, with the data
left in place rather than rolled back.
