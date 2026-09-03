# Inspiring Websites — Portfolio Dashboard

A private dashboard that pulls traffic, SEO, speed and uptime from every client
site you've published, tracks month-over-month growth, and drafts (or auto-sends)
a branded monthly report + email on each client's billing date.

Live: <https://agency-dashboard-omega-red.vercel.app>
Repo: <https://github.com/Mondoesanai/AGENCY-DASHBOARD>

---

## What it costs — still basically free

| Piece | Service | Cost |
|---|---|---|
| Hosting + cron | Vercel | Free (Hobby) |
| Database | Upstash Redis | Free tier |
| Visitor tracking | your own `/api/collect` | $0 |
| SEO / speed audit | Google PageSpeed API | Free (needs a free key) |
| Uptime + SSL checks | built-in | $0 |
| Report card image | `sharp` (bundled) | $0 |
| Monthly emails | Resend | Free (3k/mo) — optional |
| AI-written reports | Claude API | ~$1–3/mo — optional |

---

## Environment variables (Vercel → Settings → Environment Variables)

| Var | Needed for | Notes |
|---|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | everything | auto-set when you connect Upstash Redis |
| `CRON_SECRET` | managing sites, generating reports, the cron | any long random string you make up |
| `PAGESPEED_API_KEY` | SEO/speed scores | free, no billing — <https://developers.google.com/speed/docs/insights/v5/get-started> → "Get a Key". Then enable the API: <https://console.cloud.google.com/apis/library/pagespeedonline.googleapis.com> |
| `ANTHROPIC_API_KEY` | AI-written summaries + emails | optional; rules-based version works without it |
| `ANTHROPIC_MODEL` | — | optional, default `claude-opus-5`; set `claude-sonnet-5` for lower cost |
| `RESEND_API_KEY` | auto-sending email on billing day | optional |
| `REPORT_FROM` | — | a Resend-verified sender address |
| `REPORT_SIGNATURE` | — | email sign-off, default "Inspiring Websites" |
| `PUBLIC_BASE_URL` | — | optional; the dashboard derives it from the request otherwise |

After adding/changing any var: **redeploy**.

---

## Day-to-day

### Add a client site
Top-right **+ Add site** → paste the live URL, name, client email, phone,
$/month, billing day (1–28), and whether to auto-send. Saved to the database —
no code editing. (Sites also auto-appear the first time the tracker snippet
fires on them, tagged `auto`; open one and fill in the details.)

### Put the tracker on the site
One line before `</body>` — see `SNIPPET.md`:
```html
<script defer src="https://agency-dashboard-omega-red.vercel.app/t.js"></script>
```
Sites without it still get SEO/speed/uptime — just no visitor numbers.

### Each site's panel (click a card)
- Metrics, **visitors-by-month chart**, Core Web Vitals, traffic sources, top pages
- **Builder suggestions** — blunt technical to-dos, *you only*
- **Client suggestions** — benefit-framed, these go in the email
- **Monthly report** — headline, wins, the branded report-card image,
  **Open client report ↗** (shareable page), **Regenerate for this site**
- **Email this client** — name + email → **Open Gmail draft** (opens Gmail in a
  new tab with subject + body filled; you review and send) or **Copy email text**
- **Builder notes** — private free-text, auto-saves
- **What we did this month** — log lines that drop into the client email
- **⚙ Site settings** — edit everything, toggle auto-send, remove the site

### The admin key
Paste `CRON_SECRET` once in the **🔒 unlock bar** at the top. It's stored in
this browser's localStorage and never asked again on this device (until you hit
"lock").

### Reports & email
- **Generate all** button, or **Regenerate for this site** in a panel.
- Every generate **snapshots this month's numbers** so next month can show
  "SEO 74 → 89" and "+31 since launch".
- The client email **rotates tone** by how long the site's been live
  (first-month → momentum → milestone → behind-the-scenes → recap → …) so
  consecutive months never read the same.
- **Daily cron** (`/api/cron-daily`, 13:00 UTC): checks uptime + SSL for every
  site, snapshots numbers on the 1st, and **auto-sends** the report + PNG
  attachment for any site whose billing day is today *and* has auto-send on *and*
  has a client email *and* `RESEND_API_KEY` is set (deduped per month).

### Manual URLs
```
/api/report?secret=SECRET                 generate all
/api/report?secret=SECRET&slug=relax-tax  one site
/api/report?secret=SECRET&slug=…&send=1    also email it
/api/card?slug=relax-tax                   the report-card image
/api/audit?slug=relax-tax&fresh=1          force a fresh SEO/speed scan
/r/<slug>?t=<token>                        the shareable client report page
```

---

## Local preview
```
node serve.mjs      # UI with sample data on http://localhost:3200
npx vercel dev      # the real thing, needs the Vercel CLI
```

## Notes / limits
- Vercel **Hobby** is officially non-commercial — a paying agency eventually
  wants Pro ($20/mo). Nothing here is blocked today.
- Unique visitors are approximate (cookieless, no consent banner) — good for
  trends, not forensic counts.
- `maxDuration` is set to 60s (the Hobby ceiling) for the audit/report/cron
  functions.
- Google Search Console (keywords, rankings) is still a future add-on.
