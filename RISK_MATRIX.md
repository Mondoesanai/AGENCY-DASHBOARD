# Risk-based test matrix (R12.1)

Risks ranked by **harm first, likelihood second** — because the point of
ranking is to decide what must not be got wrong, and a rare catastrophe
outranks a frequent annoyance. Each row names the test file that covers it.
`tests/riskmatrix.test.mjs` checks that every file named here exists and is
actually run by the suite, so a row cannot claim coverage that does not exist.

**Harm** is read from the person who suffers it:

| | |
|---|---|
| **severe** | a real person is harmed: contacted after saying stop, their data exposed or lost, a false claim made to them, or money taken wrongly |
| **high** | the business is damaged: the sending domain burned, a paying client's work stopped, the owner misled into a bad decision |
| **moderate** | work is lost or repeated, or a number is wrong in a way that is visible |
| **low** | an annoyance, visible and recoverable |

---

## Severe — a person is harmed

| # | Risk | Covered by | Control bites |
|---|---|---|---|
| S1 | Someone is contacted **after** opting out, because consent was only checked when the message was queued | `sendrace`, `contacts` | yes |
| S2 | An opt-out is lost because the record update failed after the suppression | `fullpath`, `sendrace` | yes |
| S3 | A scanner or mail client fetching a link opts someone out without their knowledge | `sendrace`, `unsubscribe` | yes |
| S4 | Anyone can opt anyone else out with a forged token | `sendrace`, `unsubscribe` | yes |
| S5 | One client's report link opens another client's data | `crossaccount` **(single)** | yes |
| S6 | Client data is served to an unauthenticated request because the secret is missing | `fullpath`, `crossaccount`, `security` | yes |
| S7 | An erased person can be reconstructed from what was kept | `retention` **(single)** | yes |
| S8 | A message makes a claim that is not true — a lost-revenue figure, a guarantee, "you have no website" | `campaigns`, `discovery`, `prohibition`, `honesty` | yes |
| S9 | A price or offer is varied between comparable prospects | `prohibition`, `experiments` | yes |
| S10 | A text message is sent outside quiet hours, or to someone who never consented to SMS | `sms-inbound`, `sms-outreach`, `phone` | yes |
| S11 | The same prospect is sent the same message repeatedly because workers raced | `load`, `jobs` | yes |
| S12 | A prompt-injected website or reply makes the system act on an attacker's instruction | `injection`, `knowledge` | yes |

## High — the business is damaged

| # | Risk | Covered by | Control bites |
|---|---|---|---|
| H1 | The sending domain is burned by bounces or complaints nobody was watching | `deliverability` | yes |
| H2 | Sending resumes after a deliverability stop without a person deciding | `deliverability`, `sevenday` | yes |
| H3 | A paying client's site work is stopped by a prospecting problem | `deliverability`, `sevenday` | yes |
| H4 | A spam complaint is applied fifty times because a provider retried in a burst | `load`, `webhooks` | yes |
| H5 | A provider outage retires queued work permanently | `outage` | yes |
| H6 | A rate limit is counted as the job failing | `jobs`, `outage` | yes |
| H7 | The dashboard says "fine" when it could not read the thing it is reporting on | `honesty`, `states`, `attention`, `optimisation-ui` | yes |
| H8 | The dashboard says an integration is connected on the strength of an environment variable | `integrity`, `outreach` | yes |
| H9 | Automation widens its own limits, or changes an experiment nobody approved | `optimisation-log`, `prohibition` | yes |
| H10 | An experiment declares a winner on six sends | `significance`, `experiments`, `ranking` | yes |
| H11 | Spend exceeds the owner's budget under concurrency | `budget` | yes |
| H12 | A credential is committed, logged or shown | `security` | yes |

## Moderate — work is lost, or a number is wrong

| # | Risk | Covered by | Control bites |
|---|---|---|---|
| M1 | A worker dies mid-job and the work is stranded or repeated | `jobs` | yes |
| M2 | A send times out and nobody knows whether it went | `timeout` | yes |
| M3 | Duplicate or out-of-order webhooks corrupt a booking or a contact | `webhooks`, `bookings` | yes |
| M4 | A client's change request gets stuck with no visible cause | `revision-state`, `client-workspace`, `recheck` | yes |
| M5 | A duplicate import creates a second record for one person | `contacts`, `card-intake` | yes |
| M6 | A large import becomes quadratic and never finishes | `load` | yes |
| M7 | An experiment's results are corrupted by reassigning people mid-flight | `experiments`, `holdout` | yes |
| M8 | A monthly report is wrong, or sent to the wrong client | `reporting`, `reports` | yes |
| M9 | A module is written, tested, and never actually called | `wiring`, `governance` | yes |
| M10 | A button is rendered with no handler behind it | `client-workspace`, `optimisation-ui`, `actions` | yes |

## Low — visible and recoverable

| # | Risk | Covered by | Control bites |
|---|---|---|---|
| L1 | The interface is unreadable — contrast, focus order, a modal that traps nobody | `contrast`, `focus`, `nav` | yes |
| L2 | A page scrolls sideways on a phone | `preflight` (browser) | yes |
| L3 | Plain words are replaced by jargon or a raw identifier | `states`, `optimisation-ui` | yes |

---

## Gaps — stated rather than hidden

* **R12.2's send leg** is exercised only in the refusal direction, because
  outreach is deliberately inactive. The path from a permitted send to a
  provider has never run end to end, and cannot until the owner switches
  sending on.
* **R12.6's soak has not been run.** The procedure and its refusal exist; seven
  real days have not elapsed, and there is no staging deployment yet.
* **R6.4** (SPF/DKIM/DMARC) is blocked on owner action G2 and is unverifiable
  until a sending domain exists.
* **Two severe risks rest on a single test file**, marked **(single)** above: S5
  (cross-account authorization) and S7 (an erased person reconstructed). Nothing
  else independently covers either, so weakening one file would make that harm
  invisible. Recorded rather than papered over by citing loosely-related files.
* Every "control bites" above means a negative control was run against that
  area and produced a specific failure. Where a first control did **not** bite,
  that is recorded in `VERIFICATION_REPORT.md` against the requirement, along
  with whether the cause was a weak test or a malformed control — several were
  the latter.
