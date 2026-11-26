# Repository status and branch roles

Checked on 2026-11-26. This page records the repository state for PR #2; branch
names and commit references are snapshots and must be rechecked before later
promotion work.

## Branches

| Role | Branch | Commit | Meaning |
| --- | --- | --- | --- |
| GitHub default branch | `main` | `32f5c33df0732d4910ef0c11ae927c413b6cd3cc` | Repository default. It is not the behavioral baseline for this review. |
| Stable behavioral reference | `arena/03ca3ea8-system-sales` | `8946909f2cc55c8a2eb12836cdccd002a7ea624c` | The user-designated stable version used as the comparison base for PR #2. |
| Candidate under review | `arena/a4478358-system-sales` | Current head is shown by [PR #2](https://github.com/Petershaker3/system-sales/pull/2). | Candidate changes, including repair-cost accounting, awaiting review. |

PR #2 compares the candidate directly to the stable behavioral reference. The
candidate descends from that exact baseline. This makes the intended comparison
explicit; it does not establish that the candidate is a complete replacement
for every other branch or that the reference branch is the version installed
in the shop.

Do not infer production state from GitHub's default branch, an `arena/*` branch,
or this page. Confirm the installed application and its database separately
before any operational decision. Do not delete or rename other branches as
part of this review; their unique work has not been fully reconciled.

## Candidate review and readiness

- PR #2 is open and unmerged. Its base is `arena/03ca3ea8-system-sales`; its
  head is `arena/a4478358-system-sales`.
- Local verification recorded on the candidate commit: Rust workspace tests,
  frontend unit tests, and frontend build passed. The non-publishing GitHub
  Actions workflow passed on the same commit.
- These checks use test/demo data. The shop's installed application and current
  database were not inspected or exercised in this review.
- Financial reports can remain unresolved where historical cancellation cost
  or payment-source evidence is incomplete. This is deliberate protection
  against presenting guessed values as confirmed amounts.

**Readiness: candidate for review and isolated testing only. Production use is
not established by the available evidence.** Keep the PR unmerged until the
remaining branch reconciliation, representative isolated workflow checks, and
owner review are complete.

See [the recovery preparation audit](audits/2026-11-24-recovery-preparation.md)
for the earlier branch reconciliation and its known gaps.
