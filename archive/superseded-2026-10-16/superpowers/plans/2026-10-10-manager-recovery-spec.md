# Spec: One-Time Supervised Manager-Password Recovery (this device only)

## Status
DRAFT — awaiting owner review. No implementation until approved.

## Objective
Restore sign-in access for the single manager account (`ShopManager1`) on the
current shop device after the first-run password was lost. The device database,
the shop data, the existing audit log and the configured Pattern must be
preserved. After success: full re-setup (new owner-chosen password, new
Pattern, all old sessions revoked) and the recovery path is closed with no
permanent auth-bypass left behind.

Non-goals: permanent in-app recovery feature; recovering the old (lost)
password — it is unrecoverable by design (Argon2id one-way); any change to
Costing, inventory or catalog code.

## Background (facts, verified from code)
- `src-tauri/src/services/identity/bootstrap.rs`: no seeded account; the first
  manager is created interactively at first launch with an operator-chosen
  password. The device password is therefore not in the project.
- `src-tauri/src/services/identity/password.rs`: `change_own_password` needs a
  session + current password; `manager_reset_password` needs an authenticated
  manager session and refuses self-reset. With zero live sessions and one
  manager, both are unreachable.
- `src-tauri/src/commands/pattern.rs`: `reset_pattern` proves the *password* to
  clear a forgotten *Pattern* — wrong direction for this case. The Pattern
  grants no sign-in.
- `README.md` documents single-owner password loss as unrecoverable in
  practice. This spec designs the approved exception, not a silent bypass.

## Honest security statement
Any mechanism that sets a new password without the old one is a bypass by
construction. This spec does not pretend otherwise. It contains the bypass
with: (a) explicit owner approval as a mandatory gate, (b) technical controls
so the path is single-use, supervised and fails closed, (c) full audit
trail, (d) session revocation and credential rotation, (e) removal/closure of
the path afterwards. Mere possession of the DB file must never suffice alone.

## Tech Stack
Rust (Tauri 2 backend, existing identity modules), SQLite via SQLx, Argon2id
verifiers, Android Keystore session store. No new dependencies without
approval.

## Commands
- Unit + integration tests: `cargo test` (run inside `src-tauri/`)
- Focused identity tests: `cargo test -p mobile-shop-system identity`
- Frontend build: `npm run build` (repo root)
- Android APK: `.\scripts\android-build.ps1 -Apk` (repo root, Windows)

## Project Structure (touched only)
- `src-tauri/src/services/identity/password.rs` — reset use case (if design B)
- `src-tauri/src/commands/identity*.rs` — transport boundary only, no SQL
- `src-tauri/tests/integration/` — recovery tests
- `docs/decisions/` — ADR recording the exception and its closure

## Code Style
Follow the existing transport-boundary rule: commands take plain data, call a
service, map errors to stable codes (`spec:100`); no business rule or SQL in
`commands/`. Never return, log or audit a password or verifier (existing
`password.rs` header rule). User-facing text lives in frontend Arabic message
files (`spec:127`).

```rust
// New use-case errors must be stable codes, e.g.:
DomainError::RecoveryNotApproved
DomainError::RecoveryAlreadyUsed
```

## Testing Strategy
Integration tests (SQLite in-memory) must prove, before any device use:
1. Without a valid single-use approval record, reset fails closed
   (`RecoveryNotApproved`) and nothing is written.
2. With approval, exactly one reset commits: verifier replaced,
   `must_change_password` set, target sessions revoked, `PASSWORD_RESET`-class
   audit event appended with actor + reason.
3. Replaying the same approval fails (`RecoveryAlreadyUsed`).
4. Old password no longer verifies; only the new one does.
5. Lockout counters untouched except as the login path already defines.
6. Full suite green (`cargo test`) — no regressions in identity/costing.

## Boundaries
- Always: explicit owner approval recorded before execution; audit every step;
  verify new-password login on device; close the path after success; preserve
  shop data, audit log; revoke old sessions.
- Ask first: any new dependency; any schema/migration change; any change to
  lockout, session or Pattern semantics; touching costing/inventory code.
- Never: ship a permanent bypass; commit secrets or passwords; hand-edit the
  device database; guess passwords (1 failed attempt already recorded, no
  lockout — keep it that way); wipe or reinstall the app data; run stock
  movements as "tests".

## Candidate designs (decision pending owner approval)
- **Design A — supervised one-time command (recommended):** a single-use,
  approval-gated command executed under owner supervision on the device; the
  owner types the new password directly; code path removed (or build-excluded)
  immediately after verified success.
- **Design B — time-boxed recovery build:** separate signed build carrying the
  one-time flow, installed with `install -r`, then replaced by the clean build
  after success.
- **Design C — rejected:** reusing `manager_reset_password` via a synthetic
  session, or editing the DB offline. Both are silent bypasses with no
  technical gate. Not proposed.

Approval artifact (to be fixed in review): what constitutes the single-use
approval record (e.g. owner-signed statement with device id + date, consumed
transactionally with the reset).

## Success Criteria
1. Spec reviewed and explicitly approved by the owner (this gate).
2. Chosen design implemented behind the approved gate; all §Testing tests pass.
3. On-device: login with the new password succeeds; `TEST-MA-1` reads with
   zero balance and no `STOCK_COST_AUTHORITY_CONFLICT` (separate costing gate,
   unchanged).
4. Old sessions revoked; Pattern re-established; audit log shows the recovery
   chain; recovery path closed/removed; clean build reinstalled and verified.
5. `Costing` leaves `BLOCKED` only after criterion 3 is evidenced on device.

## Open Questions
1. Which candidate design (A or B), and the exact approval artifact format?
2. Who chooses the new password, and how is it delivered (owner types it —
   never transmitted or stored by the implementer)?
3. New Pattern value: owner chooses at the same session?
4. Device clock trust for single-use/time-box enforcement?
