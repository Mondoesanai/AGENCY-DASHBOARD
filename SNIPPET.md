# The one line to add to a client site

Paste this on every page of a site you want visitor data from — in `<head>` or
right before `</body>`, either is fine. That's the whole job.

```html
<script defer src="https://agency-dashboard-omega-red.vercel.app/t.js"></script>
```

The `/api/collect` endpoint is **baked into the script**, so it works no matter
where you put the tag or how the site loads it.

## Troubleshooting "no beacon received"

1. Open `https://agency-dashboard-omega-red.vercel.app/api/collect` — should say
   *"Tracker endpoint is reachable."*
2. On the client site: **F12 → Network → reload** and look for a request to
   `/api/collect`.
   - **Missing entirely** → the `<script>` URL is wrong, or an ad-blocker is
     blocking it (test with the blocker off).
   - **Red / blocked / "CSP"** → the site has a Content-Security-Policy. Add
     `agency-dashboard-omega-red.vercel.app` to its `script-src` **and**
     `connect-src`.
3. Add `?iwdebug` to the src (`.../t.js?iwdebug`) to log every beacon to the
   browser console.

---

## What if I forget to add it?

Nothing breaks. That site just shows **SEO score, performance, Core Web
Vitals and a full technical audit** (those come straight from the public URL —
no snippet needed). You only lose visitor counts, traffic sources and
conversions for that site until the line is added.

## What it tracks

- Page views + unique visitors (cookieless, no consent banner needed)
- Where visitors came from (Google, social, direct, referring sites)
- Which pages they land on
- Conversions — it **auto-detects** clicks on phone, text, email, WhatsApp,
  booking (Calendly / Cal.com / Acuity / Square), "leave a review" and
  directions links, plus any form submit. For anything else, add `data-track`
  to the element:

```html
<a href="/quote" data-track="quote-request">Get a quote</a>
<form data-track="contact-form"> ... </form>
```

## Message to hand another builder / AI

> Add this line right before `</body>` on every page:
> `<script defer src="https://YOUR-DASHBOARD.vercel.app/t.js"></script>`
> Then add `data-track="..."` to the main call-to-action buttons and forms
> (phone, email and Calendly links are picked up automatically). Don't change
> anything else.

---

## Optional (future add-on): Google Search Console data — keywords, rankings

Not wired into this version — everything works without it. When you want
per-keyword / ranking data added to the reports, this is the one-time step
per site:

1. In this project on Vercel, note the service-account email (shown in
   `SETUP.md` step 6).
2. Google Search Console → the client's property → **Settings → Users and
   permissions → Add user** → paste that email → permission **Full**.

Skip this and everything still works — you just won't get per-keyword data.
