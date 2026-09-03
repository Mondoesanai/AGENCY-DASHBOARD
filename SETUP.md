# Portfolio Dashboard — setup

A private dashboard that pulls traffic, SEO and speed data from your published
client sites and drafts a monthly client report. Built to run on **free tiers**.

---

## What it costs

| Piece | Service | Cost |
|---|---|---|
| Hosting | Vercel | Free (Hobby) |
| Data store | Vercel KV (Upstash Redis) | Free tier (256 MB / 500k cmds/mo) |
| Visitor tracking | your own `/api/collect` | $0 |
| SEO + speed audit | Google PageSpeed Insights API | Free |
| Monthly emails | Resend | Free (3k/mo) — optional |
| AI polish on reports | Claude API | ~$1–3/mo total — optional |

Nothing here bills per API call except the Claude step, and that only runs
once a month. Skip the AI key and you still get solid rules-based reports.

---

## Deploy (about 10 minutes)

### 1. Push to GitHub + import to Vercel
```
cd client-dashboard
git init && git add -A && git commit -m "portfolio dashboard"
# create a repo, push, then "Add New Project" on vercel.com and import it
```
Framework preset: **Other**. No build command. Output dir: leave default.

### 2. Add the database — Upstash Redis (free)
Vercel dashboard → your project → **Storage → Create Database** →
**Upstash** → **Redis** → free plan → **Continue / Connect to Project**.

This auto-sets the connection env vars (`KV_REST_API_URL` + `KV_REST_API_TOKEN`,
or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` — the app reads either
pair). Then **redeploy** so the running functions pick them up.

Do **not** pick "Redis (Official Redis for Vercel)" — that gives a `redis://`
connection string, not the REST API this app uses. Upstash is the one.

(Until a database exists the app runs on an in-memory store that resets on every
deploy — fine for a first look, not for real data.)

### 3. Set a cron secret
Project → **Settings → Environment Variables**:
```
CRON_SECRET = <any long random string you make up>
```
This protects `/api/report` so only you (and the scheduled job) can run it.

### 4. Get a free PageSpeed API key (do this — scores won't load without it)
The keyless PageSpeed quota is tiny and shared globally, so SEO/speed scans
fail with "Quota exceeded" almost immediately. Fix:
1. Go to <https://developers.google.com/speed/docs/insights/v5/get-started> →
   **"Get a Key"** → pick/create any project → copy the key. No billing, free.
2. Vercel → Settings → Environment Variables:
   ```
   PAGESPEED_API_KEY = AIza...
   ```
3. Redeploy. Scores fill in within a few minutes (audits cache for ~20h).

### 5. Add your sites — two ways, both fine
- **Automatic:** once the tracker snippet (step 6) is live on a site, its first
  visit auto-adds it to the dashboard, tagged `auto`. Nothing to configure.
- **Nicer labels:** edit **`lib/sites.js`** to set a proper `name`, `client`
  first name and `email`. An entry here overrides the auto one. This is the
  only file you *might* touch when launching a new site.

### 6. Add the tracker to each site
See **`SNIPPET.md`**. One `<script>` line before `</body>`. Sites without it
still get the full SEO/speed audit — they just won't have visitor numbers.

### 7. (Optional) AI-drafted reports + auto-send email
Add environment variables, then redeploy:
```
ANTHROPIC_API_KEY = sk-ant-...            # from console.anthropic.com — enables AI summaries + email drafts
ANTHROPIC_MODEL   = claude-sonnet-5       # optional; default is claude-opus-5 (better, ~2x cost)
RESEND_API_KEY    = re_...                # only if you want /api/report&send=1 to actually send mail
REPORT_FROM       = reports@yourdomain.com   # a verified Resend sender
```
You do **not** need Resend for the "Open Gmail draft" button — that's built
client-side and works with no keys. Resend is only for the automated `send=1`
path.

---

## Using it

- **Dashboard**: open your Vercel URL. Overview strip + a card per site.
  Click a card for the full breakdown: metrics, Core Web Vitals, traffic
  sources, top pages, suggestions, the report, and the email tools.
- **New site shows up**: add the snippet, visit the site once — it appears on
  the dashboard automatically (tagged `auto`).
- **Generate reports**: **Generate reports** button (all sites) or
  **Generate for this site** inside a site's panel. Asks once for `CRON_SECRET`
  and remembers it for the session. Also works as a URL:
  `https://YOUR-DASHBOARD.vercel.app/api/report?secret=YOUR_SECRET` (`&slug=…`,
  `&send=1`).
- **Email a client**: open a site → **Email this client** → type their name +
  address → **Open Gmail draft**. Gmail opens in a new tab with the subject and
  body pre-filled (from the AI report if one exists, else a short update built
  from the numbers). You review and hit send. The address is remembered per
  site. **Copy email text** is the no-Gmail fallback.
- **Automatic**: `vercel.json` runs `/api/report` at 13:00 UTC on the 1st of
  each month (generates only — it does **not** auto-email). To auto-email too,
  change the cron `path` in `vercel.json` to `/api/report?send=1`.

---

## Local preview

```
npx vercel dev        # full thing: dashboard + working APIs on localhost:3000
```
or, just the UI with demo data:
```
node serve.mjs        # or double-click "START SERVER.bat"  → localhost:3200
```

---

## Endpoints

| Route | What it does |
|---|---|
| `/` | the dashboard |
| `/t.js` | the tracker script clients embed |
| `/api/collect` | receives tracker beacons (POST) |
| `/api/sites` | portfolio JSON the dashboard renders |
| `/api/audit?slug=…` | on-demand SEO/speed audit for one site |
| `/api/report?secret=…` | build monthly reports (`&slug=`, `&send=1`) |

---

## Notes / limits

- Vercel **Hobby** is officially non-commercial. At some point paid client work
  wants a Pro plan ($20/mo). Nothing here is blocked today.
- Unique-visitor counts are approximate (privacy-friendly, cookieless) — good
  for month-over-month trends, not forensic accuracy.
- Free KV tier is plenty for dozens of sites at a few thousand views/month
  each. If you outgrow it, swap `lib/store.js` for Postgres.
- Google Search Console (keywords, rankings) is a future add-on — see the note
  at the bottom of `SNIPPET.md`.
