# What actually deploys, per repository

**Corrected 2026-10-06.** An earlier version of this file reached the right
conclusion from the wrong evidence. It argued from version drift — 68 unpushed
commits and a stale response from the live site — which establishes that the
deployment differs from local, **not what causes a deployment**. That reasoning
was rejected in review and the rejection was correct.

This version is established from the integration itself.

## The evidence

GitHub's deployments API for `Mondoesanai/AGENCY-DASHBOARD` returns Production
deployment records created by **`vercel[bot]`** — the Vercel GitHub App — each
tied to a specific commit on `main`:

```
2026-10-01T19:29:25Z  env: Production  by: vercel[bot]  ref: 30bf2d07deea8bc6...
2026-10-01T18:13:39Z  env: Production  by: vercel[bot]  ref: b8e8bd83b496fbd0...
2026-10-01T18:08:29Z  env: Production  by: vercel[bot]  ref: 376f9c55371e36ca...
2026-10-01T18:05:54Z  env: Production  by: vercel[bot]  ref: 596402f356620...
2026-10-01T18:05:03Z  env: Production  by: vercel[bot]  ref: b9b12475f448f...
```

The repository reports `pushed_at: 2026-10-01T19:28:55Z`, and `vercel[bot]`
created the Production deployment for that exact SHA **30 seconds later**. The
GitHub App only creates these records for a repository it is installed on with
the Git integration connected. That is the trigger, stated by the integration
rather than inferred from an outcome.

Corroborating, but secondary: the live deployment carries the alias
`agency-dashboard-git-main-mondoesanais-projects.vercel.app`. Vercel provisions
a `git-<branch>` alias only for a project connected to a Git repository.

| Repository | Live URL | Push to `main` deploys? | Established by |
|---|---|---|---|
| `Mondoesanai/AGENCY-DASHBOARD` | agency-dashboard-omega-red.vercel.app | **Yes** | `vercel[bot]` Production deployments per commit SHA, 30s after push |
| `Mondoesanai/apostellodetailing` | apostellodetailing.com | **Yes** | Observed: pushed `e74d346`, live `book.html` carried the change ~60s later with no CLI involvement |
| `Mondoesanai/TheLoDownWithIshaLo` | the-lo-down-with-isha-lo.vercel.app | **Yes** | Observed: pushed `ce73a13`, live `programs.html` then referenced `images/cpd-accredited.png` and contained zero redrawn seals |

The two client sites are stated honestly as **observed behaviour**, not as
configuration. Their GitHub App installation was not queried; the deployment
followed the push both times with nothing else run.

## What this means for the release

**`git push origin main` on the dashboard repository releases to production.**
There is no staging step and no manual promotion. The hold is therefore real and
is doing something: **73 local commits are not live.**

The production deployment is also reachable by `vercel --prod` from the CLI,
which is how at least one deployment was made (`dpl_E5JDjDg1sFmR4eLP28T1JMct2hGE`
carries no git source). Both routes reach the same production alias.

## Rollback

Vercel keeps every previous deployment and a prior one can be promoted:

```
vercel ls agency-dashboard                 # find the target deployment URL
vercel promote <deployment-url>            # make it production again
```

**Not exercised.** This is the documented mechanism, not a verified capability —
no rollback has been performed here, so treat it as expected rather than proven.
The git-side equivalent (`git revert <sha> && git push`) triggers a fresh
deployment through the same path proven above.

## Worth the owner's attention

`Mondoesanai/AGENCY-DASHBOARD` is a **public** repository. No credentials are
committed — `.env` and `.env*.local` are ignored, and the only matches for key
patterns are the redaction regex in `lib/recovery.js` and obviously-fake
fixtures in `tests/security.test.mjs` — but the full source, including client
names in fixture data, is publicly readable. That is a choice, not a defect, and
it should be a deliberate one.

## What is still NOT established

- Whether pushing a **non-`main` branch** creates a preview deployment. Not
  tested. Do not assume a branch push is safe.
- Whether the two client repositories use the GitHub App or a deploy hook. The
  observable result was the same; the mechanism was not inspected.
- Rollback, as above.
