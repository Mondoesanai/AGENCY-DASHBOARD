# Seven-day staging soak — the procedure (R12.6)

**This is the one check in the plan that cannot be accelerated.** Seven days
means seven **real days**. R12.5 simulates a week on a controlled clock and
says so in its own output; that is a different claim and must never be written
down as this one. The soak script refuses to report a window as complete until
the wall clock says seven days have passed, and there is deliberately no flag,
argument or environment variable that shortens it.

## What a soak is for

Not correctness — the suite covers that, and it runs in minutes. A soak exists
for the faults that only appear over real elapsed time, none of which raise an
error at the moment they happen:

* a scheduler that quietly stops firing at 3am and is never noticed, because
  nothing *fails*, work simply stops happening;
* a lease, token or signature that expires on day six;
* a cron that fires twice, or not at all, across a daylight-saving boundary;
* memory or key growth that is invisible in a five-minute run;
* a provider quota that is per-day or per-month rather than per-request;
* a retry backoff that looks fine until the fourth or fifth attempt, days later.

## Before starting

1. Deploy the branch to **staging**, not production.
2. Confirm the staging deployment has its own storage. A soak that shares a
   store with production is not a staging soak.
3. **Outreach stays off.** The soak observes the machinery; it does not send
   anything to anyone. Nothing in this procedure switches sending on.
4. Record the deployed commit — a soak is of a specific build, and a deploy
   part-way through ends the window.

## Running it

```sh
export SOAK_ORIGIN=https://<the staging deployment>
node tests/soak.mjs start      # once, at the beginning
node tests/soak.mjs check      # once a day, every day
node tests/soak.mjs status     # where it stands, at any time
```

`start` refuses to overwrite a window that is already running, because
restarting the clock is the one thing this script exists to prevent.

## What the daily check looks at

* the health endpoint answers at all;
* **every worker's last real check-in** — the single most valuable signal,
  because a scheduler that stops does not produce an error, it produces
  silence;
* whether anything has landed in the dead-letter queue.

An observation that could not reach the deployment is recorded as a **problem**,
not as a clean row. A run with no `SOAK_ORIGIN` records that nothing was
observed rather than quietly passing.

## What counts as a pass

All three, together:

1. **Seven real days elapsed.** Computed from the wall clock.
2. **Every day observed.** Seven days of nobody looking is a delay, not a soak,
   and the status output names any day with no observation.
3. **No problems recorded.** A soak with known faults is not a pass: fix them
   and start a new window.

## What counts as an abort

Start again from day one if any of these happen:

* the deployment is redeployed or reconfigured mid-window — the soak is of a
  specific build;
* a worker is found stalled or never-run, once the cause is fixed;
* a day passes with no observation;
* storage is cleared, migrated or swapped.

## Recording the result

Only after the script reports `ELAPSED` **and** full coverage **and** no
problems may R12.6 be marked done, and the entry must give the window's start
and end dates and the commit that was deployed. Until then the plan says it is
not done, which is the honest state and the one this procedure is built to
protect.
