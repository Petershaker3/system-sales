# Repository recovery preparation — 2026-11-24

Status: **incomplete; not a consolidation or full application audit**. This report records read-only investigation and tests of a candidate tree. The working session is restricted to `arena/a4478358-system-sales`: it cannot create or push another branch or update `main`. A maintainer-capable environment is required for those operations. No archive, main update, PR closure, branch deletion, or release operation was performed.

## Reference snapshot

Verified against `git ls-remote` on 2026-11-24 (recheck immediately before any operation):

| Ref | Commit | Relationship to candidate |
| --- | --- | --- |
| `main` | `32f5c33df0732d4910ef0c11ae927c413b6cd3cc` | ancestor, candidate ahead 254 commits |
| `arena/03ca3ea8-system-sales` | `8946909f2cc55c8a2eb12836cdccd002a7ea624c` | candidate |
| `arena/d6e5ae21-system-sales` | `19567025d4acab0f76ca9e598a0ec00ff7ac5a84` | ancestor, candidate ahead 5 |
| `arena/674ddf06-system-sales` | `a6d158041f696dfb34789e04beca21ff78293f33` | ancestor, candidate ahead 48 |
| `arena/cb36c89e-system-sales` | `3615091315aa7ca601ae8f0d78703e29b6410409` | divergent: candidate ahead 48, branch ahead 3, merge base `a6d158041f696dfb34789e04beca21ff78293f33` |
| `arena/0c9b90ed-system-sales` | `74ef183f1a47178841febcbfcd994dade1abc9af` | ancestor |
| `arena/332710ba-system-sales` | `71611b0e83e7b0671b2a1da32f46a60a6e393355` | ancestor |
| `review/r1-bundle` | `021f8d4b43a1ad58cdd81045ab1a8d108de20c8e` | ancestor |
| tag `v1.0.0-latest` | `8946909f2cc55c8a2eb12836cdccd002a7ea624c` | candidate; mutable release tag |

The local checkout was initially shallow. The relevant commit histories were fetched without creating or switching branches; it is no longer shallow. `git merge-base 32f5c33 8946909` returns `32f5c33df0732d4910ef0c11ae927c413b6cd3cc`. The earlier unrelated-history concern is not true for these current refs. The old main's history includes commits `4dd9c2638a47ab077b7e4cb8608f1af89137e94d`, `f195dc4`, and `987e629`.

**Unverified:** candidate is not yet established as the complete intended canonical version. It has a materially later application tree and migrations, but the divergent work below has not been fully reconciled. Retain all remote branches until unique work and collaborators' needs are accounted for.

## Divergent changes — preliminary semantic comparison

All three commits are distinct under `git log --cherry-mark`; none is patch-equivalent to a candidate commit. Changes remain remotely reachable through `arena/cb36c89e-system-sales`. Do not remove that ref.

* `e83f618aa8b330c43a7d6e41dcc917a328338b50`: adds an OS URL-opening command, camera changes, real pairing QR, expense pins, GSMArena support, and direct receiving during product creation. Candidate independently has a tested real QR (`src/screens/mobile/pair-qr.ts` and `.test.ts`), a barcode-reader fallback (`src/ui/scan.ts`), and a more narrowly scoped WhatsApp opener (`src-tauri/src/commands/shell.rs`, `src/ui/external.ts`). These are not proof of complete equivalence. Candidate lacks `src/ui/gsmarena.ts` and the divergent `src-tauri/src/commands/system.rs`. Candidate's creation screens intentionally direct receiving to the separate receiving flow. The candidate's later receiving document in migration `0035` must not be bypassed or replaced without examining its atomicity and intended behavior.
* `fea30c4750b5571632e6aa768b27abb7b1908347`: corrects JNI lifetimes in the divergent system command and adjusts an architecture guard. Candidate lacks that command, and `commands/shell.rs` reports mobile opening unsupported. Whether Android external-link behavior is a necessary feature and how to implement it safely remain unverified; copying this patch blindly would duplicate command paths.
* `3615091315aa7ca601ae8f0d78703e29b6410409`: changes Windows opening from `cmd` to `explorer`, adds recurring reminders and pinned expenses, and adds optional quantity/cost to phone creation. Candidate's Windows `commands/shell.rs` still uses `cmd`; the divergent commit describes a real-device failure for long percent-encoded links, but that failure has not been reproduced here. Candidate lacks `src/ui/reminders.ts` and `src/shell/RemindersModal.vue`; candidate has saved expense *reasons*, not the divergent fixed-expense implementation. Candidate phone creation directs to receiving. Compare the remaining changes and tests individually, preserve data/behavior, and run regression and physical-device tests before porting or rejecting any of them.

**Verified:** the divergent branch makes no changes to the migration directory relative to the common base. Candidate adds migrations 0034–0037 and modifies the migration registry relative to that base; the earlier SQL migration files are unchanged in this comparison. This is not a populated-database migration test.

## Pull request, release and CI

[PR #1](https://github.com/Petershaker3/system-sales/pull/1) is open and GitHub reports it mergeable: head `arena/674ddf06-system-sales` at `a6d158041f696dfb34789e04beca21ff78293f33`, base `arena/0c9b90ed-system-sales` at `74ef183f1a47178841febcbfcd994dade1abc9af`. Both heads are ancestors of the candidate. Keep the PR open until the owner/maintainer confirms how to represent its disposition; ancestry alone does not establish a GitHub merge or justify closing it.

Historical [CI run 42670217426](https://github.com/Petershaker3/system-sales/actions/runs/42670217426) reports success for frontend, Linux Rust, Windows, Android and publish on exact SHA `8946909f2cc55c8a2eb12836cdccd002a7ea624c`. This is not a fresh main-branch run or proof of production behavior. There is one active workflow, `.github/workflows/ci.yml`.

**High-risk workflow observation:** at the candidate, `workflow_dispatch` enables Windows and Android jobs and the release job then executes `git tag -f` and `git push origin -f v1.0.0-latest`, and replaces release assets. Even an innocuous manual verification can mutate the shared release/tag. This conflicts with the no-force safety boundary. Do not manually dispatch this workflow or assume a platform CI run is read-only. Design a non-publishing verification workflow or otherwise isolate release side effects first, and verify permissions/concurrency. That mitigation has not been implemented.

## Preliminary cleanup analysis

A SHA-256 scan of the candidate archive, excluding generated `node_modules`, `dist`, `.git`, and `target`, found 53 groups containing 107 nonempty byte-identical files. Many are licensed fonts duplicated between `docs/ui/mockup-v1/fonts/` and `src/assets/fonts/`; this does **not** establish that either copy is unused: the offline mockup and production application can have different packaging requirements. Investigate references and offline packaging before removal. No files have been removed. No `.exe`, `.apk`, `.db`, or `.zip` was found in that scan; this does not prove the absence of all generated or sensitive artifacts. Full dependency, documentation, dead-code and reference audits remain outstanding.

## Candidate observations for the later full audit

These are source observations, not proven root causes or a substitute for Phase 1:

* **Verified source / financial risk:** `src/screens/reports/ReportsScreen.vue:613–615,650–652` catches wallet, repair and expense source failures and returns `null`; other auxiliary loads at lines 673–678 use empty/default values. Trace downstream calculations and error presentation before concluding which figures are misleading. Add source-failure and reconciliation tests before changing behavior.
* **Verified source / performance hypothesis:** `src-tauri/src/data/repositories/repair.rs:486–492` calls `list_all_raw` for the overview. No timing or query plan was collected; ticket-creation latency and its root cause remain unverified.
* **Verified source / coverage question:** `list_recent_sales_for_return` exists in the sales command, service and repository. Trace the actual current UI, ordering, limits and search before concluding whether the historical 20-invoice defect still affects users.

## Executed checks

A clean file export made with `git archive` at **`8946909f2cc55c8a2eb12836cdccd002a7ea624c`** was used in a temporary directory; it was not a fresh Git clone. Node `v22.22.3`, npm `10.9.8`:

| Check | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | passed |
| `npm run typecheck` | passed |
| `npm run test:unit` | passed: 278 tests, 0 failed, 0 skipped |
| `npm run build` | passed; warning: ineffective dynamic import and chunk > 500 kB (largest JS 962.07 kB, gzip 277.28 kB) |
| Rust tests/build and migration execution | blocked locally: `cargo` and `rustc` absent; historical CI only |
| Windows / Android physical devices | not tested |
| Backup restoration, financial reconciliation, fresh clone, CI on new main | not tested |

No runtime, hardware, financial correctness or production-readiness claim follows from the frontend checks.

## Safe handoff sequence

1. In an authorized maintainer environment, fetch all refs and inspect each unique divergent change and candidate counterpart; finish the branch disposition and source/configuration/test review. Preserve every ref while unresolved.
2. Recheck remote `main`, candidate and archive-name absence. Create `refs/heads/archive/legacy-main-2026-11-24` at the exact original `32f5c33df0732d4910ef0c11ae927c413b6cd3cc` with a create-only operation that fails if the name exists. Verify the remote SHA. Do not rewrite or delete the archive.
3. Select the target only after reconciling the divergent work. Check that current main is still the recorded SHA and an ancestor of the target. Coordinate a write freeze or equivalent server-side expected-old-ref protection so the check and update cannot race another writer; use a normal fast-forward, never force push. If either ref moved, stop and reassess. A future reconciliation commit may change the intended target from the candidate recorded here.
4. Recovery: the archive retains the old main tree and history. If a rollback is required, avoid rewriting shared history; agree on an appropriate forward recovery with collaborators. An authorized maintainer can inspect or check out the archive independently. Never assume a local clone is the backup.
5. Clone afresh, verify main/archive hashes and required files and migrations, run all applicable checks, and obtain CI for the exact final main SHA without mutating the release tag. Record job links and physical-device/restore limitations. Audit and modernize the application only after consolidation is complete.

The report is preparatory; the exact remaining external operations are creation and remote verification of the archive ref and an authorized, safely coordinated main fast-forward. They have not been attempted because this session may operate only on its assigned branch.
