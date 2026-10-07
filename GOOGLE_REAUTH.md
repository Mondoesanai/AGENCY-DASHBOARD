# Re-authorising Google (restores online booking)

**Why:** the saved grant holds `calendar.events` and `gmail.modify` and nothing
else. `freeBusy.query` needs `calendar` or `calendar.readonly`, so the booking
form cannot read a single free slot and tells every visitor that online booking
is unavailable. That is the form behaving correctly — it refuses to offer a time
it could not verify. One scope is missing. Nothing else is wrong.

Confirmed against the live credential: token exchange returns 200, and the
grant's own scope list contains exactly the two scopes above.

## The scopes to request

```
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/calendar.readonly
https://www.googleapis.com/auth/gmail.modify
```

`calendar.readonly` is the only addition. Keep the other two or the revision
inbox and calendar invites stop working. Do **not** substitute
`https://www.googleapis.com/auth/calendar` unless you want to: it also grants
deleting and sharing calendars, which this app never does.

These are recorded in code as `REQUIRED_SCOPES` in `lib/google.js`, derived from
the actual API calls, so they cannot drift from what the product needs.

## Shortest safe procedure

1. **Google Cloud Console → APIs & Services → Credentials.** Open the existing
   OAuth client. Do not create a new one — a new client id means a new client
   secret, and you would have to replace three variables instead of one.
2. Confirm **Google Calendar API** and **Gmail API** are both enabled under
   *Enabled APIs & services*.
3. **OAuth consent screen → Data access.** Add `calendar.readonly` to the
   scope list and save. Leave the existing scopes alone.
4. **Mint a new refresh token** with all three scopes, using that same client
   id and secret. Two usual routes:
   - *OAuth 2.0 Playground* — gear icon, tick "Use your own OAuth credentials",
     paste the client id and secret, select the three scopes, authorise, then
     exchange the code for tokens. Its redirect URI
     (`https://developers.google.com/oauthplayground`) must be listed on the
     client.
   - *A one-off local script* using the same client id and secret with
     `access_type=offline` and `prompt=consent`. `prompt=consent` matters:
     without it Google often returns no refresh token at all on a re-grant.
5. **Replace `GOOGLE_REFRESH_TOKEN` in Vercel** — Project *agency-dashboard* →
   Settings → Environment Variables → `GOOGLE_REFRESH_TOKEN`, Production scope.
   Edit the value, save, and **redeploy** so running functions pick it up.
   `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` do not change.
6. **Revoke the old grant** at <https://myaccount.google.com/permissions> once
   the new one works, so the narrower token stops being valid.

Never paste the token into a chat, a commit, or a file in this repository. It
goes from the place that minted it straight into Vercel.

## Confirming it worked

The system now checks this itself every ten minutes. After the redeploy, the
recovery sweep stops reporting `google-scopes-missing`, and:

```
GET /api/collect?hook=slots
```

changes from `"the calendar could not be read (google 403: Request had
insufficient authentication scopes)"` to a list of real times with
`connected: true`.

## Then, and only then: the end-to-end booking test

Still outstanding, and it needs the scope first. Use one designated test
identity, not a real prospect:

1. Open `/request.html`, pick a slot the page actually displays.
2. Submit with the SMS box untouched.
3. Confirm **one** Calendar event exists at that time, in the right timezone,
   with the invitee on it and the invitation sent.
4. Confirm **one** booking in the ledger (`?do=bookings`) with
   `source: provider-confirmed` and the provider's event id.
5. Re-submit the same slot from a second browser → expect "that time was taken",
   no second event.
6. Delete the test event and erase the test contact.

Steps 3 and 4 are what this audit's `recordProviderBooking` change makes
possible; before it, a confirmed booking never reached the ledger at all.
