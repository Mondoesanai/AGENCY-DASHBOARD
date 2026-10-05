# Setup handoff

Everything that could be built and verified without you is done. This is what
is left, in the order that unblocks the most.

**No secrets appear in this document.** Where a value is needed it names the
variable, never the value.

---

## Before anything: two facts that change what you do first

**1. A preview deployment would write to your live database.**
`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL` and `REDIS_URL` are scoped to
**Production *and* Preview** in Vercel. Any preview deployment therefore shares
production storage, and `/api/admin?do=auto-poke` runs *before* the password
gate — so a preview could run the real automation against real data. Until
Preview has its own store, there should be no preview deployment. The preview
you can use today runs locally instead (see the end of this file).

**2. The sending domain is not the only blocker.** Five other things each
independently stop the first message. They are items 1, 2 and 3 below, plus
A2P registration for SMS. `INTEGRATION_READINESS.md` has the full table.

---

## 1. Decide the two prices — 5 minutes, free

**Why you:** it is a commercial decision.

**Do:** Dashboard → Settings → pricing. Set the build price and the monthly fee.

**Where it lives:** stored as settings in KV. Nothing is hard-coded, and both
are editable at any time.

**Verify:** the send gate stops reporting `no-pricing`, and the pricing line
reads back what you entered.

---

## 2. Sender identity and two Vercel values — 15 minutes, free

**Why you:** CAN-SPAM requires a real physical address in every commercial
message, and a placeholder is exactly what that law is about. The unsubscribe
link needs somewhere to point and a key to sign with.

**Do:**
* Settings → sender: your name, business name, and **a postal address that
  receives post**. A mailbox service is fine; an invented one is not.
* Vercel → Project → Settings → Environment Variables → **Production**:
  * `PUBLIC_BASE_URL` — the dashboard's public URL
  * `UNSUBSCRIBE_SECRET` — a long random string. Keep it: changing it
    invalidates unsubscribe links already sitting in people's inboxes.

**Verify:** `?do=outreach-readiness` stops listing `identity-name`,
`identity-postalAddress`, `no-public-url` and `no-unsub-secret`.

---

## 3. Confirm the targeting — 10 minutes, free

**Why you:** it is your choice of who to approach.

**Do:** Settings → targeting. The current values are a **draft assumption**
written during development and marked as such in the data: Dallas–Fort Worth,
eight home-service trades, two years or more in business, 25 a week.

**Verify:** the `targeting-draft` blocker disappears.

---

## 4. Cold email: provider + separate sending domain — ~1 hour, **costs money**

**Why you:** it needs an account, a payment decision, and a domain purchase.

**Recommended:** a provider built for cold outreach — Instantly or Smartlead
are the two the adapter was written against; Instantly is what
`INSTANTLY_API_KEY` names. **Not Resend.** Resend is transactional and opt-in,
prospecting through it breaks its terms, and the account at risk is the one
delivering your client reports today.

**Documented cost:** the code records no price for this, because none was ever
quoted to it. Instantly's published entry tier is around **$30–40/month**, plus
a domain at roughly **$10–15/year**. Treat both as figures to confirm at
purchase, not as something this system verified.

**Do:**
1. Create the provider account.
2. Register a **separate** domain for prospecting — not a subdomain of
   `inspiringwebsites.org`. The entire point is that a spam complaint can never
   reach the domain your paying clients' reports come from.
3. Publish **SPF, DKIM and DMARC** on the new domain, per the provider.
4. Warm the domain before any volume. The provider will say how long.
5. Vercel → Production: `INSTANTLY_API_KEY`, `OUTREACH_FROM_DOMAIN`.
6. For replies and bounces: set `OUTREACH_WEBHOOK_KEY` and point the provider's
   webhook at `https://<your-domain>/api/collect?hook=delivery`.

**Verify:** Settings → integrations shows the provider as **proven**, not
merely configured — that status only appears after a real exchange, never from
the presence of a key.

---

## 5. SMS: provider, registration, number — days, **costs money**

**Why you:** A2P registration is a carrier process with a real review queue.
Start it early; it is the long pole.

**Recommended:** Twilio. Both the SMS adapter and the number-lookup adapter are
written against it.

**Documented cost:** Twilio's published US A2P price is about **$0.0079 per
message segment** — that is the default the estimator uses, and it is editable.
A number is about **$1.15/month**; A2P brand and campaign registration carry
one-off and monthly fees roughly in the **$4–55** range depending on brand type.
Confirm all of these at signup: the system treats every cost figure as an
**estimate** until real provider billing is reconciled.

**Do, in this order:**
1. Create the Twilio account.
2. **Start A2P 10DLC brand + campaign registration.** The dashboard reports
   this as `not-started` today. Approval takes days.
3. Buy a **dedicated** number for outreach. It must differ from the owner-alert
   number (`TWILIO_FROM`) — the readiness gate refuses a shared number by name,
   because one complaint would take your alerting down with your outreach.
4. Vercel → Production: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_SMS_FROM`.
5. Point Twilio's inbound webhook at
   `https://<your-domain>/api/collect?hook=sms`.
6. **Consent capture.** A business card is not SMS permission. Set up the short
   disclosed opt-in — a form or QR code at events — with wording that names the
   business, says what will be sent and how to stop. It is recorded against the
   contact at intake.

**Verify:** the SMS readiness panel moves off `registration-not-approved`, then
run the designated-recipient test in `LIVE_TEST_PLAN.md`.

---

## 6. Bookings: Calendly webhook — 20 minutes, free on your existing plan

**Do:** create a Calendly webhook subscription pointing at
`https://<your-domain>/api/collect?hook=booking`, then set
`CALENDLY_WEBHOOK_KEY` in Vercel → Production.

**Verify:** book a slot yourself; it should appear in Bookings with its
attribution. Until the key is set **every** booking payload is refused — which
is correct, and means no booking has ever been recorded.

---

## 7. Discovery source — a decision, not a key

Discovery uses **OpenStreetMap Overpass**: no account, no credentials, no cost.
What is outstanding is your decision that its terms suit outreach use for this
purpose. Nothing technical is blocking it.

---

## 8. Voice notes — optional

Text notes work. Voice capture needs a decision about where recording and
transcription happen. Leave it if you do not want it.

---

## Where configuration lives

| What | Where |
|---|---|
| Prices, sender identity, targeting, outreach on/off | Dashboard → Settings (stored in KV) |
| Provider keys, secrets, base URL | Vercel → Project → Settings → Environment Variables → **Production** |
| A2P registration state | Dashboard → Acquisition → SMS readiness |
| Per-segment SMS cost used for estimates | KV key `sms:segmentCostCents`, editable |

---

## Then, and only then

1. **Give Preview its own storage** (or leave previews off).
2. **Deploy to staging** and run the seven-day soak — `SOAK.md`. Seven real
   days; the script refuses to call it complete sooner.
3. **Run the live-integration tests** — `LIVE_TEST_PLAN.md` — against your own
   designated test recipients.
4. **Switch outreach on.** A deliberate, separate action. Nothing in the system
   can do it, and until it happens the send gate refuses every message.

## What is waiting

**Unpushed commits.** Pushing to `main` does **not** itself deploy: the Vercel
project has no git-triggered deployment configured — every deployment on record
was made from the CLI. `vercel --prod` from this directory is what releases.

**Nothing has ever been sent to anyone.** Outreach has never been active, no
prospect has been contacted, and every "send" in the test suite goes to a
fixture that records it and throws it away.

## Trying it now, without deploying anything

```sh
cd client-dashboard
node tests/harness/local-api.mjs    # or: node serve.mjs
```

The local preview runs the real API handlers and the real page against an
in-memory store. Nothing it does can touch production, and nothing can be sent.
