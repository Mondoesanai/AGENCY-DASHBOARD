# Integration readiness

> **The setup list lives in [RELEASE_CANDIDATE.md](RELEASE_CANDIDATE.md).**
> That is the one ordered list, and it is the one to follow. This file is the per-integration readiness detail,
> kept for reference — if the two ever disagree, RELEASE_CANDIDATE.md is right.


Checked 2026-10-05 by asking each module what it reports and by listing the
real project's environment variable **names** (never values) from Vercel.

**The sending domain is not the only thing standing between here and launch.**
Seven separate integrations are unconfigured, and three of them block things
the sending domain does not touch.

Status words mean exactly this:

| | |
|---|---|
| **implemented** | the code exists and is wired into a caller |
| **fixture-tested** | exercised end to end against a fixture transport, in the suite |
| **configured** | credentials present in the real deployment |
| **real-service-tested** | a real request has reached the real third party and been verified |
| **blocked** | cannot progress without the owner |

---

| # | Integration | Implemented | Fixture-tested | Configured | Real-service-tested | Exact missing owner action |
|---|---|---|---|---|---|---|
| 1 | **Discovery source** — OpenStreetMap Overpass | yes | yes | **n/a — keyless** | **no** | None technical. Overpass needs no account. The owner decision outstanding is whether its terms permit *outreach* use for this purpose (R4.2); the adapter is built and injected with `fetchImpl` so it has never been called live. |
| 2 | **Contact enrichment & email verification** | **no — deliberately absent** | n/a | no | no | Decide whether to add one. There is no enrichment or email-verification provider, by design: `lib/discovery.js` refuses to guess an address from a name and a domain, so an unverified address is never invented. If you want verification before sending, that is a new provider and a new decision. |
| 3 | **Cold-email sending & reply ingestion** | yes | yes | **no** | **no** | Create a cold-outreach provider account (not Resend — see below), then set `INSTANTLY_API_KEY` and `OUTREACH_FROM_DOMAIN`. Reply ingestion also needs `OUTREACH_WEBHOOK_KEY` set and the provider's webhook pointed at `/api/collect?hook=delivery`. |
| 4 | **Sending-domain authentication** (SPF/DKIM/DMARC) | guidance only | n/a | **no** | **no** | Register a domain for prospecting that is **not** `inspiringwebsites.org`, publish SPF, DKIM and DMARC on it, and warm it. R6.4 cannot be verified at all until a domain exists. |
| 5 | **SMS** | yes | yes | **no** | **no** | Four separate things: (a) a provider account; (b) A2P 10DLC brand + campaign registration — the dashboard reports this as `not-started`; (c) a dedicated number, set as `TWILIO_SMS_FROM`, which must differ from `TWILIO_FROM` (owner alerts) or one complaint takes both down; (d) `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN`. Inbound needs the carrier webhook pointed at `/api/collect?hook=sms`. |
| 6 | **Booking integration** (Calendly) | yes | yes | **no** | **no** | Create the Calendly webhook subscription and set `CALENDLY_WEBHOOK_KEY`. Without it `verifyCalendlySignature` refuses every payload, which is the correct fail-closed behaviour — but it means **no booking has ever arrived**. |
| 7 | **Background scheduling** (GitHub Actions + Vercel cron + public poke) | yes | yes | **yes** | **yes — in production** | None. Three independent triggers are live and hitting the production deployment today. |
| 8 | **Persistent storage** (Upstash KV) | yes | yes | **yes** | **yes — in production** | One change, and it matters: `KV_REST_API_*`, `KV_URL` and `REDIS_URL` are scoped to **Production *and* Preview**, so any preview deployment reads and writes the live database. Give Preview its own store, or leave previews disabled. |
| 9 | **AI analysis & replies** (Anthropic) | yes | yes | **yes** | **yes — in production** | None. `ANTHROPIC_API_KEY` is set and in use. |
| 10 | **Rank tracking** (DataForSEO) | yes | yes | **yes** | unverified | Set in both Production and Preview. Listed because it is configured and therefore live, not because it blocks anything. |
| 11 | **Unsubscribe link** | yes | yes | **no** | **no** | Set `PUBLIC_BASE_URL` and `UNSUBSCRIBE_SECRET`. Without them the one-click link has nowhere to point and no key to sign with, and the send gate refuses — which is why this is a launch blocker and not a detail. |

---

## What that means in one line each

* **Working in production today:** scheduling, storage, AI, rank tracking.
* **Built and fixture-tested, never configured:** cold email, SMS, bookings,
  unsubscribe, sending-domain auth.
* **Deliberately absent:** contact enrichment and email verification.
* **Needs a decision, not a key:** whether Overpass's terms suit outreach.

## The claim this document exists to prevent

"Only the sending domain is left" is **false**. Even with a domain and SPF/DKIM
/DMARC published, these would still block a first message going out:

1. `PUBLIC_BASE_URL` and `UNSUBSCRIBE_SECRET` — the gate refuses without them.
2. Build price and monthly fee — the gate refuses with `no-pricing`.
3. Sender name and postal address — CAN-SPAM, refused at composition.
4. Targeting confirmation — currently a draft assumption, refused as
   `targeting-draft`.
5. The owner switching outreach on, which nothing in the system can do.

And SMS additionally needs A2P registration approval, which is a carrier
process measured in days, not minutes.
