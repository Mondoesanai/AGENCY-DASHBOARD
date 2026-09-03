# The one line to add to a client site

Paste this **once, right before `</body>`** on every page of a site you want
visitor data from. That's the whole job — nothing else to configure.

```html
<script defer src="https://YOUR-DASHBOARD.vercel.app/t.js"></script>
```

Replace `YOUR-DASHBOARD.vercel.app` with the real domain of this dashboard
once it's deployed.

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
- Conversions — it **auto-detects** clicks on `tel:` links, `mailto:` links,
  and booking links (Calendly / Cal.com / Acuity). For anything else, add
  `data-track` to the element:

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
