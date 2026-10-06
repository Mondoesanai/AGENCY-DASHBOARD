# What the others actually do, and the few things we do differently

Read 2026-10-06 from current official sources. Every capability below is cited
to the vendor's own page. Where this document says we are *better*, it says so
as a **hypothesis** — nothing here has been measured against a competitor, and
with no live sending yet there is nothing to measure with.

## The agency's actual process

Everything below is judged against the five steps this business really runs:

1. find an established local business
2. make an **evidence-based observation** about their web presence
3. offer a **complimentary preview** — built first, then shown
4. answer their questions honestly
5. book a **qualified call** that someone attends

## What each competitor offers

| | What it is for | Relevant strengths (per their own docs) | Relevant gaps for this process |
|---|---|---|---|
| **Apollo** | All-in-one GTM | 240M+ people / 30M+ companies; multi-channel sequences (email, calls, tasks); built-in dialer with recording and transcription; **Meeting Scheduler**; CRM/CSV/API enrichment with "Data Health" for stale records and duplicates | Optimised for volume and personalisation tokens. Nothing models "we built them something" as an object |
| **Clay** | Data layer | 200+ data/AI vendors under one contract; **waterfall enrichment** across providers; AI research agents ("Claygents"); job-change and hiring signals | Explicitly **does not** send, manage an inbox, or handle bookings. Its page states **no accuracy methodology or verification guarantee** — the testimonials quote outcomes, not method |
| **HighLevel** | Agency all-in-one | CRM, inbound SMS and social DMs, email broadcasts, paid calendars, Conversation AI and Voice AI, reputation/review requests, funnels, white-label rebilling | Its marketing surface **does not mention consent, opt-in, TCPA or any regulatory framework** for SMS. For an agency whose number is its channel, that omission is the risk |
| **Instantly** | Cold email at scale | Inbox management and warmup, deliverability control "at scale" (one customer runs 17k mailboxes), B2B lead database, unified inbox | **Email only** — no SMS, no bookings |
| **HubSpot** | Smart CRM | Free tier: 1,000 contacts, 2,000 marketing emails/month, 2 users, meeting scheduling, live chat, email tracking; up to 15M *non-marketing* contacts stored free | Free marketing limits bite quickly; the meetings tool counts bookings, not attendance |

## The rule everything here is built around

Twilio's Messaging Policy, as updated April 2026:

> consent must be **freely given by each recipient to each sender for each
> message subject**, informed and unambiguous, with the option to withdraw at
> any time

and, explicitly:

> You are **prohibited** from using Twilio Messaging Services if you buy, sell,
> rent, or **transfer consent** to or from your affiliates or any other party.

Marketing or promotional messages require **prior express *written* consent**.

Two consequences, both load-bearing in this codebase:

- **A blanket owner assertion is not consent.** "They all gave me permission"
  is one party asserting consent on behalf of others for an unspecified
  subject. That is the transfer the policy names. It is why `attestConsent`
  stores an *attestation* — who, when, on what basis — and never writes to the
  consent log.
- **The invitation cannot be the text.** Asking 400 discovered numbers whether
  they want marketing *is* 400 marketing messages. Consent would arrive after
  the act it authorises. So the invitation goes by email, and the YES is the
  per-recipient, per-subject, written record the policy describes.

## The three to five things we do differently

Each is a **product hypothesis** about this agency's process. None is a
measured claim, and the evidence column says exactly what would settle it.

### 1. The preview is the offer, and it has to exist before it is mentioned

No competitor models the deliverable as an object. Apollo and Instantly
optimise the *message*; Clay optimises the *data*. This process leads with
something built.

`composeInvitation` **refuses to compose** when no preview URL exists — "we
built you a website" has to be true at the moment it is sent. `lib/previews.js`
will not mark a preview READY without a reachable URL, so "your preview is
ready" is unsayable before one is.

*Hypothesis:* a first contact that points at a real artefact earns more replies
than a personalised observation alone.
*Would settle it:* reply rate on invitations with a preview vs without, once
sending is live. **Not measured. Not currently measurable — nothing has sent.**

### 2. Consent provenance, stored per person, in their own words

Clay publishes no accuracy methodology. HighLevel's surface does not mention
consent at all. Here, a YES stores the versioned wording the person answered
*and their actual reply* as evidence.

*Hypothesis:* this is worth more than the contacts it costs — a smaller list
that cannot get the number blocked beats a larger one that can.
*Would settle it:* complaint rate and carrier filtering over a few hundred
sends. **Not measured.** The policy citation above is fact; the trade-off is
the hypothesis.

### 3. Attended meetings, not booked ones, as the unit of success

Apollo ships a Meeting Scheduler; HubSpot ships a meetings tool. Both count
**bookings**. Nothing found counts **attendance**, and attendance is where the
money is.

The Meetings screen keeps three facts apart — a link click is not a booking, a
booking is not an attendance, and a past booking nobody has answered for is
*neither*. It asks about unanswered ones first.

*Hypothesis:* making the owner answer "did they come?" changes what gets
optimised, because an un-instrumented no-show is invisible.
*Would settle it:* attendance rate over 20+ settled meetings. **Not measured —
zero meetings exist.**

### 4. A discovery source whose terms permit what we do with the data

Apollo and Clay sell large databases. Google Places — the obvious source — has
the best coverage of small US businesses and its policy forbids storing the
content. This system uses **OpenStreetMap via Overpass** under ODbL 1.0, which
permits copying, storage, adaptation and commercial use with attribution, and
carries no field-of-use restriction. Attribution is preserved on every record.

The honest cost is coverage: OSM's record of small US service businesses is
patchy, so a quiet result means *OSM does not know about them*, never *they do
not exist*. This is a **stated trade-off, not an advantage** — Apollo's
database is larger and that is simply true.

### 5. "We could not find out" is never shown as "there is nothing"

The distinction that keeps recurring across this build. A prospect with no
website *tag* is not a business with no website. A failed read is not an empty
result. No competitor surface examined makes this distinction visible.

**This is the one being extended now (below).**

## What is being built this cycle

Step 2 of the process — the evidence-based observation — is computed in
`observationFor()` and has never been **shown to the owner**. So the person
deciding whether to contact a business cannot see the one true thing we could
say to them, or that there is nothing honest to say at all.

That last case matters most: when the observation is null, **no honest cold
message can be built**, and the right action is to leave that business alone
rather than reach for a weaker reason.

## Deliberately not copied

- **Inbox fleets and warmup at scale** (Instantly). A deliverability strategy
  built on many mailboxes is a way to outrun a reputation rather than earn one,
  and R6.10 already refuses domain rotation by name.
- **Waterfall enrichment across 200+ vendors** (Clay). Buying the same phone
  number from five sources raises confidence in the *number*, not in the
  *permission*, and permission is the binding constraint here.
- **Conversation AI that answers for you** (HighLevel). Nothing auto-replies
  over SMS here, which is a stricter bound than a turn budget.

---

Sources: [Twilio Messaging Policy](https://www.twilio.com/en-us/legal/messaging-policy) ·
[Twilio A2P 10DLC](https://www.twilio.com/docs/messaging/compliance/a2p-10dlc) ·
[Apollo Sales Engagement](https://www.apollo.io/product/sales-engagement) ·
[Clay](https://www.clay.com/) ·
[HighLevel](https://www.gohighlevel.com/) ·
[Instantly](https://instantly.ai/) ·
[HubSpot free CRM pricing](https://www.hubspot.com/pricing/crm)
