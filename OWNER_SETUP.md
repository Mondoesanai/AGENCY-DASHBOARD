# What only you can do

Everything that could be built and verified without you is done. This is the
consolidated list of what is left, in the order that unblocks the most.

Each item says **why it needs you**, **what to do**, and **what it unblocks**.
Nothing here has been done on your behalf, and nothing is sending.

---

## 1. Decide the two prices — 5 minutes

**Why you:** it is a commercial choice, not a technical one.

**Do:** open the dashboard → Settings → pricing, and set the build price and the
monthly fee. They are stored as settings and editable at any time; nothing is
hard-coded anywhere.

**Unblocks:** any message that answers "how much" (R5.1), and cost-per-sale in
reporting (R10.1). Until they are set, the send gate refuses with
`no-pricing` — a message that cannot answer the first question a prospect asks
is not worth sending.

---

## 2. A postal address, and two values in Vercel — 15 minutes

**Why you:** CAN-SPAM requires a real physical address in every commercial
message, and a placeholder is precisely what that law is about. The unsubscribe
link needs somewhere to point and a secret to sign with, or it is forgeable.

**Do:**
* Settings → sender: your name, the business name, and **a postal address that
  actually receives post** (a mailbox service is fine; a made-up one is not).
* In Vercel, set `PUBLIC_BASE_URL` to the dashboard's public URL, and
  `UNSUBSCRIBE_SECRET` to a long random string. Keep the secret — changing it
  invalidates unsubscribe links already in the wild.

**Unblocks:** R6.9. The gate currently lists all three as blockers and refuses.

---

## 3. A cold-email provider and a separate sending domain — ~1 hour, costs money

**Why you:** it needs an account and a payment decision, and the choice of
domain protects something you already have.

**Do:**
* Choose a provider built for cold outreach. **Resend is not one** — it is
  transactional and opt-in, prospecting through it breaks its terms, and the
  account at risk is the one that currently delivers your client reports.
* Register a **separate** domain for prospecting. Not a subdomain of
  `inspiringwebsites.org`: the point is that a spam complaint can never reach
  the domain your paying clients' reports come from.
* Set up SPF, DKIM and DMARC on that new domain, then set
  `INSTANTLY_API_KEY` (or the chosen provider's key) and
  `OUTREACH_FROM_DOMAIN` in Vercel.
* Warm the domain before sending volume. The provider will tell you how.

**Unblocks:** R6.1, R6.2, R6.4, R6.5, R6.15 — all live sending. This is the
largest blocker and the only one that costs money.

---

## 4. Confirm the targeting — 10 minutes

**Why you:** it is your choice of who to approach.

**Do:** Settings → targeting. The current values are a **draft assumption**
written during development and marked as such in the data: Dallas–Fort Worth,
eight home-service trades, businesses trading two years or more, 25 a week.
Confirm or change them.

**Unblocks:** R4.1, and removes the `targeting-draft` blocker from the gate.

---

## 5. A discovery data source — ~30 minutes

**Why you:** it needs credentials, and the terms matter.

**Do:** choose a source whose terms permit **both** storing the data and using
it for outreach. Several popular ones permit the first and not the second. Add
its credentials to Vercel.

**Unblocks:** R4.2 and R4.4.

---

## 6. Voice notes — optional

**Why you:** it needs a decision about where recording and transcription
happen.

**Do:** decide the route, or leave it. Text notes already work; voice is the
only part of R3.6 outstanding.

---

## Then, and only then

1. **Deploy to staging** and run the seven-day soak: `SOAK.md` has the
   procedure. It takes seven real days and the script refuses to report it
   complete before then.
2. **Switch outreach on** — a deliberate, separate action. Nothing in the
   system can do it, and until it happens the send gate refuses every message.
3. Two verification gaps close only after those: the send path from a permitted
   send to a provider (R12.2) has never run end to end, and SPF/DKIM/DMARC
   (R6.4) cannot be checked without a sending domain. Both are recorded as open
   in `RISK_MATRIX.md`.

---

## What is waiting on the shelf

**58 commits are unpushed.** Pushing triggers a production deployment, and the
instruction was to hold deployment pending, so they are sitting in the local
branch. Nothing is lost; say the word and they go.

**Outreach has never been active.** No message has been sent to anyone, no
prospect has been contacted, and the only "sends" in the test suite go to a
fixture that records them and throws them away.
