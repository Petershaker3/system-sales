# Mobile Shop System — Task Index

- [x] Archive legacy handoff, reports, and ADRs without deleting legacy source.
- [x] Draft the system specification, capability map, and initiative-level implementation plan.
- [ ] Review and approve the draft specification and capability boundaries.
- [~] SUPERSEDED FOR V1 — single-POS-owner was approved 2026-09-28 (ADR-001) and is **cancelled for V1** by ADR-008 (2026-10-02): Android and Windows are both full POS, no automatic sync in V1. Original rationale preserved in the ADR; revisit in the future Sync phase.
- [x] Approve weighted-average costing for quantity stock and per-unit cost for IMEI/Serial devices (ADR-002).
- [x] Approve simplified receiving in v1 (supplier, items, quantity, unit cost); defer purchase orders/payables.
- [x] Approve a minimal customer file (name + one contact, optional links to sale/repair/IMEI; no credit/installments) and date-range warranty tracking without claims workflow.
- [x] Require encrypted portable backup bundles with manager password and fail-closed import (ADR-003).
- [~] BLOCKED — barcode architecture remains **BLOCKED**. Windows USB reader + Android camera remain the intended paths, but no component is selected. Requires the physical SM-N976N device and real shop barcode samples. Evidence in ADR-004; scope in ADR-008.
- [x] SP-1 verified + source baselined + device verified (with documented Pattern-save timeout exception)
- [x] SP-2 — **READY FOR HANDOFF (approved by Product Owner 2026-10-08)**
      `SP-2 = IMPLEMENTATION VERIFIED BY REPORTED TESTS / DEVICE UNVERIFIED / DOCUMENTATION COMPLETE`
      Evidence: 352 Rust tests green (25 lib + 62 architecture + 180 integration + 85 unit,
      3 ignored, 0 failures, 0 warnings); frontend build exit 0; `ADR-015` records the
      SP-2 decisions; stale `0007` ledger references in `0005:21` and `ADR-012:71` corrected.
      The PO approved this **on the implementer's report** and recorded explicitly that
      the repository and the device were not independently inspected by the approver.
- [x] SP-2 device gate — **STEP 1 (Pattern save): PASS.** Re-verified from the pulled device snapshot
      (`shop.db`, sha256 d2ce4e0c…), not from any status text: `manager_pattern` holds exactly one
      row, `epoch = 1`, `created_at == updated_at`, `updated_by` cross-checks to a real
      `ShopManager1`/manager, `verifier` is a genuine `$argon2id$v=19$m=19456,t=2,p=1$…` PHC string,
      the plaintext `Pattern123` appears nowhere in the row, and `audit_events` holds
      `(11, 'pattern_set', <manager>, '{"epoch":1}')` with `pattern_required = 1`.
      **Not proven:** the `verify_pattern` round trip (accept the right Pattern, reject a wrong one)
      was never completed — the device disconnected. That step remains **NOT RUN**.
- [x] **A1 — IPC and UI surface built** (approved 2026-10-08): `commands/inventory.rs`
      (`receive_stock`, `remove_stock`, `get_position`, `switch_cost_method`), registered in
      `lib.rs` with no new `app.manage`; `src/api/inventory.ts`; `StockPanel.vue`; the dead-end
      costing-method `<select>` in `DepartmentsPanel.vue` replaced by a read-only display; Arabic
      messages added for the two `STOCK_*` codes that had none. 363 tests green.
- [x] **A1 step 1 — APK build: PASS.** `app-universal-debug.apk`, 299.43 MB, built 2026-10-09
      19:12:33 from the current source. Evidence: `Compiling mobile-shop-system v0.1.0` for
      `aarch64-linux-android`, minSdk 24 (Gate C D-2), NDK `aarch64-linux-android24-clang.cmd`,
      `link.exe` present, frontend rebuilt inside Gradle. Package read back off the artifact with
      `aapt2`: `com.mshop.system`, versionCode 1000, versionName 0.1.0, minSdk 24, targetSdk 37.
- [ ] A1 device gate — **BLOCKED: checksum mismatch on migration `0005`.** Not a build problem.
      The device refuses to open the database:
      `could not open the local database: migration 5 was previously applied but has been modified`
      Proven by checksum, not by inference — the device's ledger and the repository agree on every
      migration except one:

      | version | device records | repo file |
      |---|---|---|
      | 1,2,3,4,6,7 | matches | matches |
      | **5** | `d167c2d5c7459a0093dafb265967866b` | `eff17a8087b29f3d36e3af39f57ee2d4` |

      So the device database was created by a build **older than the SP-1 baseline `32e7515`**. Its
      `0005` bytes are unrecoverable — only the checksum survives, matching nothing in the repository
      or its single-commit history.
      - [x] `0005` restored to its applied state (`git checkout`); the stale `0007` reference stays,
            because **an applied migration is immutable** and the correction lives in `ADR-015`.
      - [x] APK rebuilt after the revert (20:13:31) and reinstalled with `-r`; the refusal persisted,
            confirming the revert restored repository state but did not resolve the history mismatch.
      - [x] Device data **not** touched: no uninstall, no ledger edit, no data reset.
      - [x] Evidence preserved under `%TEMP%\opencode\sp2-device-evidence\` — pulled `shop.db`,
            both build logs, the crash buffer, and the checksum/probe scripts.
      - [ ] Device database itself remains **healthy**: `integrity_check = ok`,
            `foreign_key_check` clean, 1 user, 1 department, 1 setting, 1 `manager_pattern`,
            11 audit events.
      - **Not authorised:** wiping app data to force a clean install, or editing `_sqlx_migrations`
            to make the checksum agree. Both were refused, and both remain refused.
- [x] **Test gap closed — backward-compatible migration (3 tests).** Found by the device, not by the
      fresh-database suite: all 363 tests opened an *empty* database, so no test ever presented a
      pre-existing ledger. New `tests/integration/migration_backward_compat.rs`:
      1. the current chain applies on top of a **populated** database built from the real
         `0001`–`0007` files (never a hand-written copy of the schema), with SHA-384 checksums
         recorded the way sqlx records them, and manager/department/setting rows surviving it
      2. that database survives being opened twice — a device launches repeatedly
      3. **tampering with an applied migration's recorded checksum is detected, and the tamper is
         left in place** rather than quietly repaired
      Plus `integrity_check` and `foreign_key_check` asserted before and after.
      Honest limit: this proves the *general* claim, not the specific stale build. That build's
      `0005` bytes do not exist anywhere; the device database is the only specimen of that history.
- [ ] Commit B — DEFERRED by Product Owner decision; untouched by SP-2
- [ ] SP-3 or the next slice — not started; no Product decision on scope

## Checkpoint: SP-2 Cohesive Block
- [ ] All 8 SP-2 tasks completed sequentially
- [ ] Trade-off/contract decision: none needed (ADR-013 / §10 is the binding authority)
- [ ] Pattern DB evidence (`manager_pattern`, `audit_events` PATTERN_SET) confirmed on device before closing SP-2
- [ ] Capture legacy shapes: financial report formulas, catalog/transaction schemas, and safe synthetic fixtures (test baseline recorded 2026-09-28: rc_closure 11/11, phone_date_roundtrip 4/4, gas_config_boundary 7/7).
- [x] Prove read-only legacy import on a synthetic mixed-shape export: `node spikes/legacy-import/import_probe.mjs` → PASS (2026-09-28). **Historical only** — legacy import is OUT OF SCOPE per ADR-007; findings retained as audit record.
- [ ] Re-run the probe against a real shop export (owner-provided) and confirm the export file format.
- [ ] Run an isolated Tauri 2 + Rust/SQLx/SQLite Windows/Android spike; reject raw SQL IPC and verify true transaction rollback.
- [~] Partially done — platform, IPC/access-control, local-data and money architecture are recorded (spec 2026-09-28 + ADR-008). Sync architecture is DEFERRED out of V1.
- [ ] Implement versioned local data, auth roles, Rust command gateway, and recoverable database migrations.
- [ ] Implement catalog, new barcode enrollment/label print, optional serial tracking, and local product image.
- [ ] Implement stock ledger, approved opening counts for accessories/used devices, ADR-002 costing, and approved procurement workflows.
- [ ] Implement Windows offline POS with immutable cost/price snapshots and atomic inventory updates.
- [ ] Implement cash shifts/reconciliation, plus approved expenses, repairs, and the approved minimal customer/warranty links.
- [~] DEFERRED OUT OF V1 — sync and Android online operations are outside V1 (ADR-008). Future Sync architecture opens as a separate phase after the local-first POS is validated.
- [~] SPLIT — local backup/restore bundles with photos remain in scope (ADR-003, ADR-008). The "verified legacy-data importer" is OUT OF SCOPE per ADR-007.
- [ ] Complete cross-platform, regression, security, migration, and device acceptance checks.

## Checkpoint: Architecture approval

- [ ] User approves spec and capability boundaries.
- [x] POS concurrency policy is explicit in ADR-001 and has cross-device acceptance criteria.
- [ ] Tauri spike passes on actual Windows and Android targets.
- [ ] No raw SQL execution/query command is exposed to the WebView; role checks run in Rust.
- [ ] Rust command test proves invoice + stock update rollback together on injected failure.
- [~] DEFERRED — no backend in V1 (ADR-008). Opens with the future Sync phase.

## Checkpoint: Data migration readiness

- [ ] Legacy data stays recoverable and untouched.
- [ ] Confirmed export fixture imports without relying on the old restore flow or mutating the original.
- [ ] Legacy sales without user ids remain marked as imported/unknown, not falsely attributed.
- [ ] No accessory/used-device quantities are inferred from the old name-only catalogs.
- [ ] Synthetic backup round-trip and per-entity count reconciliation pass.
- [ ] Legacy report totals match under the documented legacy formulas, or owner-approved new metrics are explicitly versioned.


## Checkpoint: Gate B — V1 architecture baseline

- [x] V1 scope recorded: both Android and Windows are full POS, per-device local SQLite, no automatic sync, no server, no cloud database (ADR-008).
- [x] Rust layer structure recorded: `src-tauri/src/{domain,services,data/{repositories,migrations},commands,lib.rs}` (ADR-008).
- [x] Version baseline recorded: Tauri 2.12.0, SQLx 0.9.0, Rust stable, no automatic major/minor upgrades, Cargo.lock committed once the project exists (ADR-008).
- [x] Supabase recorded as an existing dependency, NOT an approved backend (ADR-008).
- [x] Spike path recorded as `D:\_spikes\tauri-spike`, evidence/reference only (ADR-008).
- [ ] Recovery policy details — snapshot trigger, retention, restore validation, integrity checks, recovery UX (OPEN, ADR-008).
- [ ] Report/KPI definitions — `Total Sales`, `Net Profit`, cash semantics (OPEN product decision).
- [ ] Payment methods, printer model, warranty terms, currency rounding (OPEN).
- [ ] Exact Rust toolchain pin — deferred until real scaffold/dependency resolution (ADR-008).
- [ ] `product/` disposition (OPEN — must not become the product base).
- [ ] Barcode architecture (BLOCKED — needs SM-N976N + real shop barcode samples).

## R1 Recovery — one-time supervised manager-password recovery (plan: tasks/plan-recovery.md)

- [x] R1-T1: Domain errors RecoveryNotApproved/RecoveryAlreadyUsed + unit tests
  - Acceptance: stable codes asserted; unknown code rejected
  - Verify: cargo test -p mobile-shop-system identity
  - Files: src-tauri/src/domain/identity/error.rs
- [x] R1-T2: Migration 0009_recovery_approval.sql + repo fns + tests
  - Acceptance: provision + consume-if-unconsumed atomic; replay refused
  - Verify: cargo test -p mobile-shop-system identity
  - Files: src-tauri/src/data/migrations/0009_recovery_approval.sql, identity repo
- [x] R1-T3: Recovery use case + fail-closed/replay tests
  - Acceptance: no approval = no write; one approval = exactly one reset + audit + sessions revoked
  - Verify: cargo test
  - Files: src-tauri/src/services/identity/ (+ new recovery.rs)
- [x] R1-T4: recovery feature gate + command + arch-test pin + Arabic codes
  - Acceptance: command absent without flag; stable codes only across IPC
  - Verify: cargo test; build with/without --features recovery
  - Files: src-tauri/src/commands/, src-tauri/src/lib.rs, src/api/

## Checkpoint: R1 slice complete (human review before any device build)

- [ ] Full suite green; recovery unreachable in production build
- [ ] Plan questions Q1–Q3 answered (design, approval handshake, Pattern)

- [ ] R1-T5: Recovery APK + supervised device run + new-password login
- [ ] R1-T6: Forced-change final password + Pattern re-setup + TEST-MA-1 read
- [ ] R1-T7: Close path + clean build + reinstall + verify absence + ADR

## Verdict fixes (reviewer gate 2026-10-10, R1-T5 NOT approved until re-review)

- [x] F1: stage_approval requires current device Pattern (same check as
  pattern verify: repo find + argon2, codes InvalidCredentials /
  PatternNotConfigured; no row, no RECOVERY_APPROVED on refusal)
- [x] F2: execution device_id compared against the Pattern-authenticated
  staged row; documented as consistency + procedural (no hardware attestation
  claimed; no serial-number plumbing)
- [x] F3: Approval identity excludes approved_at (same_stable_fields);
  identical re-stage is a silent no-op; consumed re-stage refused
- [x] F4: binary proof — recovery symbols absent from prod rlib, present in
  recovery rlib (evidence: src-tauri/build-proof-evidence.txt)