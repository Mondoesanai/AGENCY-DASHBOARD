# Live integration test plan

Everything in this file requires a real third party and **cannot** be run until
the matching item in `OWNER_SETUP.md` is done. Until then every one of these is
**unverified**, and the system says so rather than assuming it works.

## Rules that apply to every test here

1. **Designated recipients only.** Addresses and numbers *you own* — your own
   phone, a second phone you control, a mailbox you can read. They are listed
   once, in settings, and nothing else may be used.
2. **Prospect campaigns stay inactive throughout.** `outreach.active` stays
   off. Each test sends one message deliberately, by hand, to a designated
   recipient. No campaign is started.
3. **Never test on a prospect.** Not one message to anyone who did not agree to
   be a test recipient. This is the rule that does not bend for convenience.
4. **One test at a time**, and write down what happened. A test you did not
   record is a test you will redo.
5. If a test fails, **stop**. Do not continue to the next one. They build on
   each other and a failure upstream makes everything below it meaningless.

---

## A. Cold email — needs item 4

| # | Test | What must happen | How you know |
|---|---|---|---|
| A1 | Send one message to your own address through the real provider | It arrives | You read it |
| A2 | Inspect the headers | `List-Unsubscribe` **and** `List-Unsubscribe-Post` present; SPF, DKIM and DMARC all pass | View original / show headers in your mail client |
| A3 | Click the unsubscribe link | Confirmation page; the address is suppressed | Settings → that contact shows opted out |
| A4 | Try to send to that address again | **Refused** | The gate says the address opted out |
| A5 | Reply to the message | The reply appears in the inbox, attributed to the right contact | Follow-ups → Conversations |
| A6 | Check that reply paused the sequence | The contact's follow-ups stop | The conversation shows "paused — they replied" |
| A7 | Send to a deliberately invalid address on your own domain | A bounce arrives, is recorded, and suppresses that address | The delivery webhook fires; the contact shows bounced |

**A2 is the one that decides whether you can send at volume.** A DKIM failure
here means stop and fix DNS before anything else.

---

## B. SMS — needs item 5, *after* A2P approval

| # | Test | What must happen | How you know |
|---|---|---|---|
| B1 | Record consent for your own number through the opt-in flow | Consent stored with its wording and source | The contact shows an SMS consent record |
| B2 | Compose a text in the dashboard | Segment count and cost estimate shown **before** sending | The composer shows both |
| B3 | Send it to your own phone | It arrives from the dedicated number | You read it |
| B4 | Watch the delivery state | Moves `accepted` → `delivered`, not straight to delivered | The thread shows both, in order |
| B5 | Reply from your phone | The inbound lands in the **same** conversation | One thread, both directions |
| B6 | Check it cancelled a scheduled follow-up | The queued message does not send | The conversation shows paused |
| B7 | Queue an automatic reply, then press **Take over** | The queued reply is **cancelled**, not merely superseded | The confirmation names how many were cancelled; the job shows `cancelled` |
| B8 | Reply `STOP` | Opt-out recorded; confirmation sent; nothing further can go out | The number shows suppressed |
| B9 | Try to text that number again | **Refused** | The gate says they opted out |
| B10 | Reply `HELP` from a second number | The HELP reply names the business and how to stop | You read it |
| B11 | Send to a landline you control | Flagged as not SMS-capable **before** sending, or recorded as a failure | The line-type check or the delivery receipt |
| B12 | Send at 7am local to the recipient | **Held**, not sent, until quiet hours end | The message stays scheduled |
| B13 | Deliver the same provider callback twice | Applied **once** | The thread shows one state change, not two |

**B7 is the one most likely to be wrong in a real system**, because it is a
race. Queue the reply, then take over quickly.

---

## C. Bookings — needs item 6

| # | Test | What must happen | How you know |
|---|---|---|---|
| C1 | Book a slot through your own Calendly link | The booking appears with attribution to the right contact | Acquisition → Bookings |
| C2 | Cancel it | Recorded as cancelled; attribution survives | The booking shows cancelled, contact still attached |
| C3 | Reschedule it | The new time replaces the old; no duplicate | One booking, new time |
| C4 | Replay the same webhook payload | Ignored as a duplicate | No second booking |
| C5 | Send an unsigned payload | **Refused** | 401, nothing recorded |

---

## D. Workers and budget — needs nothing new

These can be run against staging today.

| # | Test | What must happen |
|---|---|---|
| D1 | Let the GitHub Actions tick run | A worker check-in timestamp updates |
| D2 | Kill a worker mid-job | The lease expires and the job is reclaimed, not lost |
| D3 | Exhaust the budget, then try a discretionary send | **Refused**; essential work still runs |
| D4 | Pause automation | New work stops; replies and opt-outs still honoured |
| D5 | Point the provider at a URL that 503s | Jobs defer rather than dying, up to the cap |

---

## E. The preview promise — needs item 4 or 5

| # | Test | What must happen |
|---|---|---|
| E1 | Scan a card from a real event, mark "asked for a preview" | A preview task appears as `requested` |
| E2 | Try to send "your preview is ready" | **Refused** — nothing exists yet |
| E3 | Mark it ready with no link | **Refused** |
| E4 | Build something, paste the link, mark ready | Allowed |
| E5 | Send the message | The link in it opens the thing you built |

---

## What "launch-ready" means

All of A, B, C and E pass against real services, **and** the seven-day staging
soak in `SOAK.md` has actually elapsed with every day observed.

Until then the honest description is: *built, fixture-tested, and not yet
proven against a real provider.* That is a different sentence from "ready", and
the difference is the whole point of this file.
