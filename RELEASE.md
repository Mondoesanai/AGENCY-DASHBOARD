# Release and rollback

## How this project actually deploys

Verified 2026-10-05 against the live Vercel project, not assumed:

* The Vercel project `agency-dashboard` has **no git-triggered deployment**.
  Every deployment on record — eleven of them — was created from the CLI by
  `mondoesanai`, all targeting Production. There has never been a preview
  deployment.
* Therefore **`git push` does not deploy.** Pushing `main` to GitHub is safe.
* **`vercel --prod` from this directory is what releases.** So is
  `npm run deploy`, which is the same command.
* `.vercel/` is gitignored and holds only the project link, no secrets.

## Why there is no preview deployment

`KV_REST_API_URL`, `KV_REST_API_TOKEN`, `KV_URL` and `REDIS_URL` are scoped to
**Production and Preview**. A preview would share the live database. And
`/api/admin?do=auto-poke` is handled *before* the password gate, so a preview
could run the real automation against real client data.

Two things make a Vercel preview safe, and neither is done:

1. Give the Preview environment its own KV instance.
2. Either move `auto-poke` behind the gate, or set a Preview-only flag that
   disables it.

Until then, previews run locally: `node preview.mjs`.

## Release

In this order. Do not skip step 2.

1. **Push.** `git push origin main`. Nothing deploys. This gets the work off
   one machine, which is worth doing on its own.
2. **Run the preflight gate.** `node tests/preflight.mjs`. Parse, imports,
   project rules, the whole suite, and the real page in Chrome at desktop and
   mobile. It must report 0 failed.
3. **Note the current production deployment URL** from
   `npx vercel ls agency-dashboard`. That is your rollback target. Write it
   down before you deploy, not after.
4. **Deploy.** `npx vercel --prod` from `client-dashboard/`.
5. **Check within two minutes:**
   * `curl https://<prod>/api/admin?do=system-health` → 200
   * `curl https://<prod>/api/admin?do=automation-status` → `ok: true`, with
     worker check-ins that are not stale
   * open the dashboard, unlock, and look at Overview and Follow-ups
6. **Watch the first scheduled tick.** The GitHub Actions workflow runs every
   ten minutes and hits production directly. If it starts failing, that is your
   signal.

## Rollback

Vercel keeps every deployment. Rolling back is promoting the previous one:

```sh
npx vercel ls agency-dashboard            # find the last known-good URL
npx vercel promote <that-deployment-url>  # instant, no rebuild
```

It takes seconds and does not rebuild, so it is always the first move when
something looks wrong. Diagnose afterwards.

**What rollback does NOT undo:** anything already written to KV. Storage is
shared across deployments, so a bad release that wrote bad data leaves that
data behind. If a release has written something wrong:

1. Roll back the code first, to stop it writing more.
2. Then repair the data, using the admin routes or directly.

This is the main reason to run the staging soak before a release that changes
how anything is stored.

## What makes a release risky, in order

| | |
|---|---|
| Highest | anything that changes what is written to KV — a bad write survives rollback |
| | anything touching the send gate, consent, or suppression — the blast radius is a real person |
| | anything touching the job queue — in flight work can be lost or duplicated |
| Lowest | front-end only changes — rollback is complete and instant |

## Before the first release that can send

None of this is reachable until `OWNER_SETUP.md` items 1–5 are done, and
`LIVE_TEST_PLAN.md` has been run against designated recipients. Outreach stays
off until then, and the gate refuses every message, which is the intended
state and not a fault to work around.
