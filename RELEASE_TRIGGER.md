# What actually deploys, per repository

Written 2026-10-05 to settle a contradiction in earlier reports: one said
`git push` does not deploy, a later one said it does. **The later one is
correct for all three repositories below.** This is established from observed
behaviour, not from configuration files alone — a Vercel Git connection lives
in Vercel's dashboard, not in the repo, so the repo cannot be read to prove it.

## The answer

| Repository | Live URL | Does `git push origin main` deploy? | How this was established |
|---|---|---|---|
| `Mondoesanai/apostellodetailing` | apostellodetailing.com | **Yes** | Pushed `e74d346` at 16:4x, fetched the live `book.html` ~60s later and the change was present. No CLI deploy was run. |
| `Mondoesanai/TheLoDownWithIshaLo` | the-lo-down-with-isha-lo.vercel.app | **Yes** | Pushed `ce73a13`, then fetched the live `programs.html`: it referenced `images/cpd-accredited.png` twice and contained zero `textPath` seals. No CLI deploy was run. |
| `Mondoesanai/AGENCY-DASHBOARD` | agency-dashboard-omega-red.vercel.app | **Yes — so the production hold is real** | See below. |

## Why the dashboard answer is "yes", in evidence

- `origin/main` is at `30bf2d0` (2026-10-01). There are **68 unpushed local commits**.
- `GET /api/admin?do=auth-mode` on the live site returns `{"ok":false,"error":"bad password"}`.
- Locally, `api/admin.js:64` handles `auth-mode` **before** the auth check, so a
  deployment containing that code would answer without a password.
- The live site therefore runs code from before that change — i.e. it matches
  the last **pushed** commit, not the last **local** one.

That is the whole mechanism: what is on GitHub `main` is what is live. Nothing
local reaches production until it is pushed, and anything pushed to `main` goes
to production without a further step.

`.vercel/project.json` exists (`projectName: agency-dashboard`) which allows
CLI deploys as well, but the observed deployments above all followed pushes
with no CLI involvement.

## Consequence for the current work

**The production hold is in force and is doing something.** The dashboard's
68 local commits — including the revision-pipeline fixes, the requirements
model, and the scheduled recovery sweep — are **not live**. The live dashboard
still has:

- the thread-based dedupe that dropped Angie's request
- completion inferred from "the agent shipped something"
- `recover()` with no scheduled caller

Releasing is one command, `git push origin main`, and it is deliberately not
being run. It needs explicit authorization because it goes straight to
production with no staging step.

## What is NOT established

- Whether a push to a **non-`main` branch** creates a preview deployment. Not
  tested; do not assume a branch is safe to push.
- Whether Vercel's Git integration is configured per-repo in the same way, or
  whether any of these use a deploy hook instead. The observable result is the
  same; the mechanism behind it was not inspected in Vercel's dashboard.
- Rollback behaviour was not exercised. Vercel keeps previous deployments and
  supports promoting one, but that was not tested here, so "we can roll back"
  is an expectation rather than a verified capability.
