# Re-authorising Google (restores online booking)

**One capability is missing, and one scope fixes it.**

The saved grant holds `calendar.events` and `gmail.modify`. Creating, changing
and cancelling appointments works. Reading **free/busy** does not, and that is
what the booking form needs to offer a real time — so it offers none and tells
every visitor that online booking is unavailable. That is the form behaving
correctly: it refuses to show a slot it could not verify.

Confirmed against the live credential (token exchange returns 200; the grant's
own scope list contains exactly those two).

## The scope to add

```
https://www.googleapis.com/auth/calendar.freebusy
```

Keep the two you already have. The complete set becomes:

| Scope | What it is for |
|---|---|
| `calendar.freebusy` | **add this** — read availability, so the form can offer real times |
| `calendar.events` | create, change and cancel the appointment |
| `gmail.modify` | the revision inbox: read, label, reply |

### Why `calendar.freebusy` and not `calendar.readonly`

`freebusy.query` accepts four scopes. Checked against Google's own discovery
document (`/discovery/v1/apis/calendar/v3/rest`), which publishes the accepted
scopes per method:

| Scope | Methods it unlocks across the whole API |
|---|---|
| `calendar.freebusy` | **1** — `freebusy.query`, and nothing else |
| `calendar.events.freebusy` | 7 — also reads event titles, times and details |
| `calendar.readonly` | 15 — every calendar, every event, and the sharing rules |
| `calendar` | everything, including deleting calendars |

All four would work. `calendar.freebusy` is the only one that grants nothing
beyond what the form actually does. An earlier draft of this document said
`calendar.readonly`; that would have handed a live system read access to every
event on the calendar to use a one-method capability.

Recorded in code as `GOOGLE_CAPABILITIES` in `lib/google.js`, so the scopes and
the reasons stay attached to the calls that need them.

## The account steps

1. **Google Cloud Console → APIs & Services → Credentials.** Open the **existing**
   OAuth client. Do not create a new one: a new client id brings a new secret,
   and you would be replacing three variables instead of one.
2. Confirm **Google Calendar API** and **Gmail API** are both enabled under
   *Enabled APIs & services*.
3. **OAuth consent screen → Data access → Add or remove scopes.** Add
   `https://www.googleapis.com/auth/calendar.freebusy`. Leave the existing two
   alone — removing either breaks the revision inbox or appointment creation.
   Save.
4. **Mint a new refresh token** against that same client id and secret, with all
   three scopes. Either route works:
   - *OAuth 2.0 Playground* — gear icon → tick "Use your own OAuth credentials"
     → paste the client id and secret → select the three scopes → Authorize →
     "Exchange authorization code for tokens". Its redirect URI
     (`https://developers.google.com/oauthplayground`) must be listed on the
     client first.
   - *A one-off local script*, same client id and secret, with
     `access_type=offline` **and** `prompt=consent`. `prompt=consent` matters:
     without it Google usually returns no refresh token at all on a re-grant,
     and you end up thinking it failed.
5. **Replace `GOOGLE_REFRESH_TOKEN` in Vercel** — project *agency-dashboard* →
   Settings → Environment Variables → `GOOGLE_REFRESH_TOKEN`, **Production**
   scope. Edit the value, save, then **redeploy** so running functions pick it
   up. `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` do not change.
6. **Revoke the old grant** at <https://myaccount.google.com/permissions> once
   the new one works, so the narrower token stops being valid.

The token goes from wherever you mint it straight into Vercel. It never belongs
in a chat, a commit, or a file in this repository.

## Checking it worked

Two ways, neither of which needs the token:

```
GET /api/admin?do=google-scopes&secret=<CRON_SECRET>
```

returns `complete: true` and an empty `missing` list. It reports capabilities in
words ("read free/busy, to offer real booking times"), not just URLs.

```
GET /api/collect?hook=slots
```

changes from `"the calendar could not be read (google 403: Request had
insufficient authentication scopes)"` to real times with `connected: true`.

The ten-minute recovery sweep also stops reporting `google-scopes-missing` by
itself. It raises that finding **at most once every 24 hours** even while the
problem persists — proven in `tests/calendar-health-dedupe.test.mjs`, which runs
144 consecutive sweeps and asserts exactly one notification.

## Then: the designated booking test

Blocked until step 5 is done. Use one designated test identity, never a real
prospect, and run each as a separate result:

1. **Displayed slot** — open `/request.html`, note the exact time and timezone shown.
2. **Submit** with the SMS box untouched.
3. **One Calendar event** at that instant, in the right timezone, invitee attached.
4. **Guest notification** actually sent (the event is created with `sendUpdates=all`).
5. **One CRM booking** at `?do=bookings` with `source: provider-confirmed` and the
   provider's event id.
6. **Owner notification** received.
7. **Vanished slot** — book the same time from a second browser; expect "that time
   was taken", and no second event.
8. **Reschedule / cancel** via the link in the confirmation, and confirm the CRM
   record follows.
9. **Clean up** — delete the test event, erase the test contact.

Steps 5 and 8 are only possible because of `recordProviderBooking`; before that,
a confirmed booking never reached the ledger at all.

**Until step 3 and step 5 both pass, the public form keeps saying booking is
unavailable and keeps collecting call requests.** That is the current state and
it is the correct one.
