# The preview-request and booking form

Written for: the owner, deciding what to turn on and what still needs a
decision. Nothing in here is live.

---

## What exists

One page, in our own software, at **`/request.html`**. Not a Calendly link, not
a mockup. It reads real availability from a real calendar, submits to our own
endpoint, and shows a confirmation only when a scheduling provider has
confirmed the time.

**"See what your business website could become"** — then the offer, stated
plainly: the preview is complimentary and without obligation; a completed
website has a build price and a monthly maintenance fee, both agreed first.

Six fields: name, business name, current website (optional), email, phone,
and a free-text note. Beside the phone field, at the point somebody types it:
*"We use this for the call and your record. Entering it does not sign you up
for texts."*

Then a day picker, then that day's real times, in the visitor's own timezone.

---

## The two checkboxes

Both unticked. Neither required. A booking goes through with both untouched —
verified in a browser, not assumed.

**1. Texts**

> ☐ **I agree to receive texts from Inspiring Websites**
> *See more* ▾

Opening "See more" reveals:

> About my requested website preview and appointment — confirmation, reminders,
> rescheduling information, a link to my preview when it is ready, and **a
> follow-up text after the appointment**. Up to **7** texts for this request.
> Message and data rates may apply. Reply **STOP** to opt out or **HELP** for
> help. Texts are optional and are not required to book. Terms · Privacy

Clicking "See more", or Terms, or Privacy, does not tick the box. Tapping the
sentence itself does — on a phone the whole line is the hit area.

**2. Attendance**

> ☐ I plan to attend this call. If I can't make it, I'll use the reschedule
> link.

Directly above it, the exact appointment it refers to: the day, the time, the
length, the timezone and the meeting method.

---

## The number 7 is not a figure on a page

It is the length of an enumerated plan, and the send path enforces it.
`claimRequestText` refuses the eighth text, refuses a second copy of any one
kind however many times a job retries, and refuses everything if the counter
cannot be read. The page reads the figure from the server, and a test fails if
the two ever disagree.

The seven: booking confirmation, 24-hour reminder, 1-hour reminder,
reschedule/cancel notice, preview-ready link, post-appointment follow-up,
no-show follow-up.

Five of those need a **confirmed appointment**. A request where the calendar
was disconnected gets none of them — reminding somebody about a meeting that
was never booked may make them clear the time for it.

**Nothing is sent twice.** Google Calendar already emails the invitation and
every change to it, so every notification in the lifecycle has exactly one
owner: the calendar sends appointment email, we send SMS and the preview
delivery email. Neither sends what the other does.

---

## What the form can and cannot do about permission

Ticking the SMS box creates a **pending** record and nothing more. Promotional
permission still requires the confirmation from the handset itself, exactly as
before. The form says so on the confirmation screen: *"to switch them on, text
PREVIEW from that phone. We will not text you until you do."*

Entering a phone number grants nothing. Ticking "I plan to attend" grants
nothing, and is recorded as an acknowledgment that is explicitly not evidence
anybody attended.

---

## Scheduling

**Google Calendar.** `vercel env ls` shows no `CALENDLY_*` variables of any
kind — no key, no plan, no account — so Calendly was not available to build on
and was not pretended to work. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`GOOGLE_REFRESH_TOKEN` already exist in Production, and `lib/google.js` was
already creating calendar events.

Both sit behind an adapter boundary (`lib/scheduling.js`), so Calendly can be
added later without touching the page, the form handler or the CRM.

**No slot is ever invented.** If free/busy cannot be read, nothing is offered —
"we could not ask" must never render as "the whole week is open". If no
calendar is connected at all the page says so, changes its button to *"Request
my preview call"*, and collects a request rather than showing an empty list
that reads as "fully booked".

**Two people cannot take the same slot.** The time is claimed atomically before
Google is called. If Google refuses, the claim is released. If Google never
answers, the claim is kept, the result is reported as uncertain, the button
stays disabled, and the visitor is told we will confirm by email — because a
retry that creates a second appointment is worse than a slot briefly held.

**A call sooner than the build takes is called an introductory call,** on the
slot, in the calendar event and in the confirmation. It is not described as a
preview walkthrough.

**A failed booking keeps the request.** If the calendar refuses or will not
answer, the contact, the consent choice and the preview task are all still
created — they have already typed everything we need, and the failure is ours.
What it does not become is a confirmed appointment: the page says the time is
not confirmed and that we will email them.

---

## Preview production

Six states: **requested → researching → building → review → ready**, plus
**blocked**.

"Ready" is what unlocks telling a real person their preview is ready, so it
requires a real URL *and* a review. The state machine only reaches it from
review, and the code checks the same fact independently in case that graph is
ever edited. A blocked task must say what it is blocked on, and sorts to the
top of the queue.

---

## Who we approach

Proactive outreach goes to **established businesses with a verified website of
their own**.

A Yelp page, a Facebook page, a Linktree or a `business.site` page loads
perfectly and names the business — the old check called that a verified
website. It is now classified as a listing profile and is explicitly *not*
verified, because "I had a look at your site" would be false in the first
sentence.

Somebody **without** a website who asks us for help is served. They are simply
not in the outbound segment, because they came to us. The same is true of
somebody with an excellent website who enquires: answering them must never
enrol them in a cold campaign.

---

## Measuring it

Ten events that are not each other: invitation, form visit, submitted request,
confirmed booking, preview built, preview delivered, reconfirmation, attended
call, cancellation, no-show. At `/api/admin?do=funnel`.

**A booking counts only when the provider confirmed it.** The recorder refuses
a booking with no provider reference, so a page view, a slot click and a form
submission cannot become one. Attendance needs a person who observed it; the
checkbox records a reconfirmation.

If the counters cannot be read, the report says so rather than showing zeros.
"Nobody came" and "I could not count" are different claims.

---

## What is NOT proven

Local tests and fixture providers do not prove any of this:

- a real Google Calendar free/busy query or event creation
- a real Twilio send, delivery receipt or inbound reply
- a real cold email send
- a real person completing the form

112 test files and 6,930 checks pass, and the page was driven in Chrome at
1280px and 390px with real mouse clicks against the real handlers. That is
evidence the code behaves as described. It is not evidence that the
integrations work.

---

## Release blockers — unchanged

These stand regardless of this work:

1. **The repository is public.** `"private": false`. Its history is exposed.
2. **Preview shares Production KV.** A preview deployment can write to live
   data.
3. **No permitted cold sender is selected.** Instantly is a recommendation, not
   a decision. Resend cannot be used — its acceptable-use policy prohibits
   unsolicited outreach, and it is the account that delivers paying clients
   their reports. The code now refuses to route cold email through it.

**This booking form working with fixtures does not make the product
live-ready.** Outreach is off and stays off.

---

## Decisions waiting on you

| | |
|---|---|
| **Cold sender** | Choose one whose terms permit cold outreach and open the account. Nothing cold can send until then. |
| **Repository** | Make it private, or accept the history exposure. |
| **Preview KV** | Separate it from Production, or keep Preview locked. |
| **Google Calendar** | Confirm the credentials are the calendar you want appointments on. |
| **Terms / Privacy** | `/optin-terms.html` and `/optin-privacy.html` are linked from the consent. Read them before anybody else does. |
