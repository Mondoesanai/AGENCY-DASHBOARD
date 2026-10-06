# Public repository exposure — findings and the decision to make

**Audited:** 2026-10-06, 226 commits, 1768 text objects, every blob reachable from
every ref. **No history was rewritten and nothing was force-pushed.**

Run it yourself: `node tools/audit-history.mjs`

## The headline

**No live credential is in reachable history.**

Every credential-shaped string the scanner found is a deliberate fixture inside a
redaction test — the tests whose whole job is proving the redactor masks them.
They were classified structurally (placeholder-shaped bodies: repeated runs,
spelled words, too few distinct characters) **without any value being printed,
logged or written anywhere.**

| Severity | Category | Occurrences | Objects | Paths | Verdict |
|---|---|---|---|---|---|
| critical | Anthropic API key shape | 2 | 2 | 1 | **Fixture** — redaction test |
| critical | Resend API key shape | 2 | 2 | 1 | **Fixture** — redaction test |
| critical | GitHub token shape | 10 | 2 | 1 | **Fixture** — redaction test |
| high | Bearer token shape | 4 | 2 | 1 | **Fixture** — same string as above |
| medium | Address on a domain somebody could own | 421 | 131 | 14 | **Real exposure** |
| medium | Phone number outside the 555 range | 13 | 4 | 3 | **Real exposure** |

**No rotation is required.** If that ever changes, the action would be: rotate the
key in the provider's own dashboard, update the Vercel environment variable, and
redeploy — never paste the old value anywhere while doing it.

## What IS exposed

The medium findings are real and permanent. They include **a real client's
business domain** (One More Thing), which an earlier pass replaced in the working
tree — but the working tree is not the history. Roughly 421 address occurrences
across 131 objects and 14 paths, and 13 phone-shaped numbers across 3 paths, are
public and will stay public.

Most are invented businesses on `.com` domains that nobody owns. The client one
is the one that matters, and it is a business domain already on the open web
rather than a private detail. **Severity: real but low harm.** Nobody's password,
nobody's home address, nobody's private number.

## What local cleanup does NOT do

Worth stating plainly, because it is the most common misunderstanding:

* Fixing the working tree **does not** remove anything from history. Every old
  commit is still fetchable by sha.
* Anyone who has already cloned, forked, or is mirroring has it regardless.
* GitHub caches and third-party mirrors keep copies independently.
* **The only thing that can still help is stopping new exposure** — which is
  what `.githooks/pre-commit` now does.

## The decision — yours to make

### Option A — keep it public, with remediation

Reasonable, because no credential is exposed and the worst finding is a business
domain that is already public information.

1. Enable the hook in every clone: `git config core.hooksPath .githooks`
2. Leave history alone. Rewriting it would break every clone and achieve little,
   since the content is already distributed.
3. Accept that the client domain stays in history, and do not add more.

### Option B — make it private

Stronger, and reversible. **Check these before flipping it**, because private
repositories change who can reach what:

1. **Collaborators.** Anyone currently reading it through public access loses
   access unless they are added as a collaborator.
2. **Vercel.** The project deploys from this repo. Confirm the Vercel GitHub
   integration still has access after the change — if the connection was made
   under a different account, deployments can start failing silently.
3. **Forks.** Existing forks of a public repo **stay public and stay readable**.
   Going private does not retract them.
4. **GitHub Actions.** `.github/workflows/` runs on this repo; private repos have
   different minute allowances.

### What I recommend

**Option B, after checking Vercel access** — not because of what was found, but
because of what a dashboard holding client financials, contact records and
consent evidence will accumulate next. The findings today are mild. The reason to
go private is the next hundred commits, not the last two hundred.

This is an owner decision and nothing has been changed either way.

## Stopping new exposure — in place now

`.githooks/pre-commit` → `tools/pre-commit-scan.mjs`, sharing one pattern library
with the history audit (`tools/secret-scan.mjs`).

* Scans **staged content only**, so `.env` files and Vercel environment variables
  are never read. The rule is "do not commit it", not "do not have it" — a check
  that fought real configuration would just be bypassed.
* Blocks on credentials, contactable addresses and real phone numbers.
* **Never prints the match** — a hook that echoed the secret into a terminal
  would have copied it somewhere new.
* `git commit --no-verify` overrides it deliberately, and says so.

Enable once per clone: `git config core.hooksPath .githooks`

**Verified by real commits, not by tests alone:** a staged fake GitHub token was
refused and the commit did not happen; clean content committed normally. The
first version of the hook silently did nothing, because it assumed the repository
root was the parent directory — it is `client-dashboard`.
