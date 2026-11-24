# Phase 4 — Repository Cleanup Audit (READ-ONLY)

Date (UTC): 2026-09-26. Phase 3 security remediation is CLOSED and untouched by
this audit. NOTHING was deleted, moved, renamed, or modified — the sole change
in this phase is this report. Historical artifacts were not altered.
Notation: retired credential appears only as `[GAS_URL_REDACTED]`; no values.

## 1. Executive Summary

- Canonical source is `dev_extracted/dev/` (27 JS incl. Phase 3 `app_config.js`,
  `index.html`, CSS, `build.py`, docs, 18 tests). Sole build script, sole test
  suite, sole distribution pipeline. No competing active source found.
- `phase24_recovered/` (8 files) is a **pre-ADR-003/pre-Phase-3 snapshot**: 4 files
  byte-identical to canonical, 4 superseded (canonical is a strict functional
  superset; the few phase24-only lines are older variants, exhaustively listed
  in §4). Zero references from code/build/tests/docs.verdict: **ARCHIVE**.
- `node_modules/` (7.5 MB, entire `@supabase/supabase-js` tree): proven unused —
  zero imports in any source/test, SDK never loaded, `build.py` is pure Python,
  `package.json` has no scripts. Lockfile is consistent, so removal is
  reversible via `npm ci`. Verdict: **DELETE-CANDIDATE** (directory only).
- Diagnostic HTMLs: active Issue-2 tooling containing the retired endpoint —
  **KEEP (conditional)**, do-not-distribute; reclassify after Issue 2 + rotation.
- `dev_extracted/dist/index.html`: fresh, generated, reproducible, free of the
  retired endpoint. **KEEP** in working tree; propose ignoring in future git.
- ZIPs + manifest: historical release evidence containing the retired endpoint.
  **KEEP**, never distribute.
- Temp/OS/editor artifacts: **none found**. Docs: handoff files carry stale
  absolute paths to other machines (historical, keep); my `AUDIT_REPORT.md` §2
  "no dist/" line is stale post-Phase-3 (flagged for a one-line doc fix).

## 2. Repository Inventory

| Path | Type | Size | Role | Generated? | Required for build/test/deploy/recovery? |
|---|---|---|---|---|---|
| `dev_extracted/dev/` | source tree (27 js, index, css, build.py, docs, 18 tests) | ~685 KB | CANONICAL SOURCE | No | build YES / test YES / deploy YES (via dist) / recovery YES |
| `dev_extracted/dist/index.html` | build output | 515,453 B | distributable product | YES (`build.py`) | build NO (output) / test incidental / deploy YES / recovery NO (regenerable) |
| `phase24_recovered/` (8 js) | snapshot, pre-ADR-003 | ~198 KB | historical snapshot | No | NO / NO / NO / NO (superseded; ZIPs cover recovery) |
| `dev.zip` | baseline source archive (2026-07-28) | 173,367 B | HISTORICAL (retired credential inside) | No | recovery YES (independent copy) |
| `dev_phase24_rc_closed_2026-08-18.zip` + `_manifest.txt` | RC release package + manifest | 199,333 + 5,532 B | HISTORICAL RELEASE (retired credential inside) | No | recovery YES |
| `mshop-diag.html` / `mshop-regression-test.html` | inlined diagnostic builds | 479,383 / 465,948 B | active troubleshooting tools (retired credential inside) | YES (build + overlay) | test-tool YES / recovery NO |
| `PROJECT_HANDOFF.md` / `HANDOFF_INDEX.md` | prior-session handoff | 33,498 / 7,618 B | historical documentation | No | recovery NO (informational) |
| `backup_inspect_result.txt` | backup stats (aggregate, no PII) | 308 B | inspection evidence | YES (tool output) | NO (informational; unreferenced) |
| `package.json` / `package-lock.json` | dep manifest / lockfile | 68 / 4,116 B | reproducibility record | No | build NO / test NO / deploy NO / recovery YES (for npm tree) |
| `node_modules/` | installed npm tree (9 pkgs) | ~7.5 MB | unused dependency install | YES (`npm install`) | NO / NO / NO / NO (reinstallable from lock) |
| `.claude/` (launch.json, settings.local.json) | tool config | <2 KB | AI-tooling state | Partially | NO (recreatable; stale paths) |
| `.freebuff/project-id` | tooling UUID | 37 B | AI-tooling state | YES (generated id) | NO |
| `docs/` (4 reports) + `AUDIT_REPORT.md` | audit/security trail | ~60 KB | documentation | No | NO (informational) |
| 4× `*.SECURITY-RETIRED-DO-NOT-DISTRIBUTE.txt` | Phase-3 markers | 868 B each | safety markers | No | NO (protective) |

Ages (mtime): handoff/ZIP/diag files 2026-07-27/28; RC + phase24 2026-08-18;
`package.json`/lock/`node_modules` 2026-08-13; audit trail + `dev_extracted`
2026-09-26 (Phase 3).

## 3. Canonical Source Determination

Authoritative: `dev_extracted/dev/`. Evidence: only `index.html` with a script
order; only `build.py` consuming it; only test suite loading it; manifest's
file list matches it (+ approved Phase-3 additions `app_config.js`,
`gas_config_boundary_test.js`). No other directory contains active source:
`phase24_recovered/` is unreferenced (see §4), root HTMLs are frozen builds,
ZIPs are archives. The `dev_extracted/` wrapper holds a single child `dev/` —
harmless; renaming is churn with zero value (KEEP as-is).

## 4. phase24_recovered Analysis

SHA256 vs canonical (`dev_extracted/dev/js/`):

| File | Bytes (phase24 vs canonical) | Verdict | Explanation |
|---|---|---|---|
| `entity_mappers.js` | 28,156 vs 28,156 | IDENTICAL | — |
| `storage.js` | 14,075 vs 14,075 | IDENTICAL | — |
| `sync_provider_supabase.js` | 14,405 vs 14,405 | IDENTICAL | — |
| `sync_supabase_config.js` | 393 vs 393 | IDENTICAL | — |
| `db_integration.js` | 34,620 (660 ln) vs 50,314 (1184 ln) | DIFFERENT — HISTORICAL | 10 phase24-only lines are pre-8.7 variants (`update` without `mergedDb`/options, plain `delete(id)`, single-line repo subclasses); canonical adds 534 lines (full ADR-003 8.3–8.7 repositories). No forward fix. |
| `phones.js` | 48,583 (670 ln) vs 65,807 (979 ln) | DIFFERENT — HISTORICAL | 2 phase24-only lines are the pre-8.5 direct-mutation `confirmSell` (`data.phones.push…` + `save()`); canonical uses `phoneTransactionRepo.create()` + RC date fix. No forward fix. |
| `sync.js` | 54,009 (795 ln) vs 54,730 (806 ln) | DIFFERENT — HISTORICAL | 2 phase24-only lines are exactly the unguarded `GAS_URL` call sites replaced by Phase 3 guards. No forward fix. |
| `sync_auth.js` | 4,614 (98 ln) vs 4,651 (99 ln) | DIFFERENT — trivial | Single whitespace-only line difference; content equivalent. |

Safety check: NO unique code/fixes/config/tests/docs/data in phase24; NO
credential literal (only `GAS_URL` variable references; the publishable
Supabase key duplicate is public-by-design and dormant); references to the
directory exist ONLY in audit-report prose (zero code/build/test/doc refs).
Final classification: **ARCHIVE** (out-of-tree move on approval; historical
value as pre-migration snapshot; never silent-delete).

## 5. node_modules Analysis

1. Manager: npm (lockfile v3; no yarn/pnpm artifacts). 2. Lockfile
   authoritative: YES (committed, internally consistent with `package.json`).
3. Required by any documented workflow: NO. 4. Required by tests: NO — all 18
   tests `require()` only node core (`vm`/`fs`/`path`) + `./dom-stub` (verified
   exhaustively). 5. Required by `build.py`: NO (stdlib `re`/`os`/`json` only).
6. Any import from it: ZERO hits for `supabase`/`iceberg`/`tslib` across dev
   source+tests. 7. `@supabase/supabase-js` required: NO (SDK never loaded;
   §4 Supabase Assessment stands). 8. Unrelated packages: none — all 9 pkgs are
   exactly the supabase-js tree; the TREE as a whole is project-unrelated.
9. `package.json` scripts: none exist. 10. Reproducibility: `package-lock.json`
   retained ⇒ `npm ci` restores bit-identically; deleting the directory loses
   nothing. ⇒ **DELETE-CANDIDATE** (directory only; KEEP manifest + lock).
   Confidence HIGH, risk LOW.

## 6. Diagnostic HTML Analysis

| File | Purpose | Live-data? | Credential? | Distributable? | Verdict |
|---|---|---|---|---|---|
| `mshop-diag.html` (V2) | Active Issue-2 encrypted-restore instrument (NOT yet run by user) | YES by design (reads/writes the operator's localStorage) | YES — retired endpoint inlined (marked) | NO | **KEEP** until Issue 2 closed + rotation verified; then DELETE-CANDIDATE |
| `mshop-regression-test.html` | Post-ADR-003 regression build | YES if opened (same mechanism) | YES — retired endpoint inlined (marked) | NO | **KEEP** alongside diag (paired evidence); then DELETE-CANDIDATE |

Referenced by `PROJECT_HANDOFF.md` (§Diagnostics, Next Step) and handoff index;
not referenced by source (correct — nothing should import a diagnostic overlay).
They duplicate node tests only superficially (interactive vs scripted).

## 7. Build Output Analysis

`dev_extracted/dist/index.html`: generated YES; reproducible YES (`python
build.py`, deterministic concat in tag order); expected distributable YES (the
product IS the single file); retired credential: ABSENT (verified Phase 3:
0 fragments, placeholder only, boundary precedes first use); stale: NO (built
post-Phase-3, matches source incl. `app_config.js` first tag). Remain in repo:
YES in working tree (it is the shippable artifact); future-git: propose
SHOULD-IGNORE with explicit release builds (see §14). Do NOT rebuild/replace
without approval.

## 8. Release / ZIP Artifact Analysis

- `dev.zip` (2026-07-28): pre-RC baseline source backup. Contains retired URL
  (`dev/js/app.js`). Not reproducible from current source (predates RC+Phase 3)
  ⇒ independent recovery value. **KEEP — HISTORICAL ARTIFACT.**
- `dev_phase24_rc_closed_2026-08-18.zip` + manifest: RC-1/2/3 closure release
  (E2E explicitly not executed). Contains retired URL. Superseded as source but
  is the only sealed release record. **KEEP — HISTORICAL ARTIFACT.**
- No duplicate archives of each other (different content/generation); no other
  archives found. Deleting either would destroy an independent recovery copy.
  Never distribute; contents frozen.

## 9. Documentation Analysis (report-only, no rewrites)

- `PROJECT_HANDOFF.md` / `HANDOFF_INDEX.md`: heavy absolute-path references to
  other machines (`…\.gemini\antigravity\scratch\ai-studio-import\…`,
  `Documents\سيستم\…`) — stale as location pointers, VALID as session history.
  KEEP unchanged; a future one-line header noting "paths refer to the July
  environment, not this folder" would suffice.
- `AUDIT_REPORT.md` §2 "Absent: No dist/…" is stale post-Phase-3 (dist now
  exists) — flagged for a one-line correction in Phase 5.
- `docs/` (proposal, Phase-3 report, runbook): current; no contradictions found.
- Manifest: accurate for its ZIP; E2E-not-executed disclaimer intact — KEEP.
- No README exists (acceptable: handoff + docs cover it; propose one only if
  git adoption happens).
- 14 legacy tests embed dead `/home/claude/…` paths (pre-existing, env-only
  failure) — test-code staleness, NOT doc staleness; fixing is a separate
  testing task, out of cleanup scope.

## 10. .claude / .freebuff Analysis

- `.claude/launch.json`: debug config serving a NONEXISTENT external path
  (stale `…\.gemini\…\dev`, port 8762) — tooling state, not project source.
- `.claude/settings.local.json`: allow-list of past shell commands incl. stale
  paths — tooling state, no secrets.
- `.freebuff/project-id`: opaque UUID — benign, regenerable.
- None contain secrets/source/customer data; none required to build/test/run.
  Future git: SHOULD-IGNORE (environment-specific). Classification:
  **MANUAL-REVIEW** (owner decides; tools recreate them; do not hand-edit).

## 11. Generated / Temporary Files

Full-tree sweep (excl. `node_modules`) for `__pycache__`, `*.pyc`, `.DS_Store`,
`Thumbs.db`, `*.bak/.old/.tmp/.orig/.copy`, swap files, `*.log`, caches:
**ZERO hits.** Nothing to classify; propose preventive `MUST-IGNORE` rules (§14).

## 12. Duplicate Detection (SHA256, excl. node_modules/ZIPs/dist/HTML)

- 4× identical sidecar markers (intentional, protective — not clutter).
- 4× `phase24_recovered` ↔ canonical identical pairs (§4 table).
- NO other content duplicates: no doubled JS under different names, no doubled
  docs, no doubled tests. (`dev_extracted/` wrapper is nesting, not duplication.)

## 13. Unused / Unreferenced Files

| File(s) | References found | Assessment | Confidence |
|---|---|---|---|
| `sync_auth.js`, `sync_provider_supabase.js`, `sync_supabase_config.js` | No `<script>` tag; referenced only by each other + audit prose + provider header | Dormant BY DESIGN (declared reference-only); NOT accidental dead code — keep until Supabase decision | HIGH |
| `db_foundation.js` | Loaded first + covered by phase-5 test | Used (schema/constants at runtime until proven otherwise) — keep | MEDIUM-HIGH |
| `backup_inspect_result.txt` | None (except audit prose) | 308 B inspection evidence; negligible, informative — keep | HIGH |
| `backup.js` legacy `importBackup` path | Loaded, UI-wired | Used — keep | HIGH |
| Legacy tests w/ dead paths | Referenced by nothing runnable here | Broken-by-environment, not unused; repair is testing work, not cleanup | HIGH |

No file qualifies as "unused" on textual evidence alone without a non-cleanup
role (reference, history, tooling) — hence zero additional DELETE-CANDIDATEs.

## 14. Future Git Hygiene Proposal (DO NOT create yet)

- MUST IGNORE: `.env*`, `*.pem/*.key`, `node_modules/`, `__pycache__/`,
  `*.pyc`, `.DS_Store`, `Thumbs.db`, `*.log`, `*.tmp/*.bak`, `.claude/`,
  `.freebuff/`, `mshop-*.html` (local endpoint-bearing builds), `*.mshop`,
  `*.zip` (release archives — publish via releases, not tree).
- SHOULD IGNORE: `dev_extracted/dist/` (regenerable; build on release),
  editor dirs (`.vscode/`, `.idea/`).
- OPTIONAL: keep `dev_extracted/dist/index.html` tracked ONLY if the repo is
  chosen as the distribution channel (with a rebuild-and-verify gate).
- Retired-credential ZIPs/HTMLs must NEVER enter a public remote in any form.

## 15. Security Recheck (candidates only)

- `node_modules/`: official registry tree, lockfile integrity hashes present; no
  local secrets, no customer data, no private endpoints. Clean on usage grounds.
- `phase24_recovered/`: no credential literal (host/path-fragment scan
  negative), no customer data (source only), dormant public key only. Safe to
  archive.
- `dev_extracted/dist/`: no retired credential, no customer data (code-only
  bundle). Safe.
- Diag HTMLs / ZIPs: CONTAIN retired credential ⇒ excluded from every
  delete/archive-in-place proposal; handled as marked historical artifacts.
- No NEW critical issue found: Phase 3 stays closed.

## 16. Cleanup Classification

| Path | Classification | Reason | Evidence | Confidence | Risk |
|---|---|---|---|---|---|
| `node_modules/` | DELETE-CANDIDATE | Proven unused; reinstallable | §5 (10 answers); zero imports; core-only test requires | HIGH | LOW |
| `phase24_recovered/` | ARCHIVE | Superseded snapshot w/ historical value; move out-of-tree | §4 hashes + line-level diffs; zero refs | HIGH | LOW |
| `mshop-diag.html` | KEEP (conditional) | Active Issue-2 tool; contains retired credential → do-not-distribute | §6; handoff refs; marked | HIGH | MEDIUM if distributed |
| `mshop-regression-test.html` | KEEP (conditional) | Paired regression evidence; same constraint | §6; marked | HIGH | MEDIUM if distributed |
| `dev.zip` / RC zip + manifest | KEEP | Independent recovery copies; sealed release record | §8; sidecar-marked | HIGH | LOW (kept, not shared) |
| `dev_extracted/dist/index.html` | KEEP | Fresh distributable; regenerable | §7; Phase-3 validation | HIGH | LOW |
| `package.json` + `package-lock.json` | KEEP | Reproducibility record | §5 | HIGH | LOW |
| handoff docs / manifest / backup stats / reports | KEEP | History + audit trail | §9 | HIGH | LOW |
| `.claude/` / `.freebuff/` | MANUAL-REVIEW | Tooling-owned; stale paths; owner decides | §10 | MEDIUM | LOW |
| `AUDIT_REPORT.md` §2 dist line | Doc-fix (1 line) in Phase 5 | Stale post-Phase-3 | §9 | HIGH | NONE |

No KEEP item above may be deleted in Phase 5. No DELETE (without -CANDIDATE)
is proposed for anything.

## 17. Proposed Phase 5 Cleanup (approval-gated ONLY)

A. Safe cleanup: remove `node_modules/` directory ONLY (keep manifest+lock);
   one-line `AUDIT_REPORT.md` dist correction.
B. Archive: relocate `phase24_recovered/` out-of-tree (e.g. beside the RC zip
   as `phase24_recovered_ARCHIVED_2026-09-26/`) with a moved-here note; verify
   hashes before+after.
C. Manual review: `.claude/` + `.freebuff/` disposition (keep vs ignore vs
   regenerate); legacy-test dead-path repair (separate testing task, NOT
   cleanup); handoff header note about stale paths.
D. Security-sensitive: NOTHING in this phase — diag HTMLs/ZIPs stay marked and
   in place until Issue 2 closure + GAS rotation verification.

## 18. Items Explicitly NOT Recommended for Deletion

Source tree, tests, docs, build script, `dist`, ZIPs, manifest, diag HTMLs,
`package.json`/lock, markers, handoff files, backup stats: each is either
canonical, evidence, recovery capacity, or an active tool. Deleting any of
them destroys information or capability with zero hygiene gain. In particular:
archives are the only independent recovery copies predating current source,
and the diag HTML is the only instrument for the open data-loss issue.

## 19. Validation Plan After Cleanup

1. Re-run `gas_config_boundary_test.js` (7/7), `rc_closure` (11/11),
   `phone_date_roundtrip` (4/4). 2. Rebuild via `build.py`; confirm dist has 0
   endpoint fragments. 3. Re-hash archived `phase24_recovered` (equality with
   pre-move hashes). 4. Confirm `node` suites behave identically with
   `node_modules/` absent. 5. Final tree scan for secrets + temp artifacts.
