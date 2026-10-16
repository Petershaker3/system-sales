# Implementation Plan: One-Time Manager Recovery (R1)

## Overview
Implement the approved recovery Spec
(`docs/superpowers/plans/2026-10-10-manager-recovery-spec.md`) as a
single-use, owner-supervised path that resets the `ShopManager1` password on
the shop device, preserves data + audit, rotates credentials/sessions/Pattern,
then closes the path. Production builds must never ship the bypass.

## Architecture Decisions
- **Recommended: Design B (recovery-gated build).** New `recovery` cargo
  feature gates the command + use case; production APKs build without it, so
  the bypass cannot exist in shipped code. Rationale over Design A (command
  added then removed): removal is verified by build graph, not by remembering
  to delete code; the architecture test already enumerates commands per
  module and will pin the gate.
- **Approval artifact:** single-use row in a new `recovery_approval` table
  (migration `0009`), consumed transactionally with the reset. Provisioned
  only during the supervised session, from the owner's explicit go-ahead
  (exact provisioning handshake fixed at plan approval — see Open Questions).
- **Audit:** new `RECOVERY_APPROVED` + `RECOVERY_EXECUTED` events; existing
  `PASSWORD_RESET` reused for the verifier change with target + sessions
  revoked, per `password.rs` convention. Never log passwords/verifiers.
- **Post-reset state:** `must_change_password = true` so the owner sets the
  final password through the normal forced-change screen; all sessions
  revoked; Pattern re-established by the owner afterwards.

## Dependency Graph
```
domain errors (codes)
    └── migration 0009 + repo fns
            └── recovery use case (fail-closed, single-use, audited)
                    ├── command boundary (+ lib.rs gate + arch test)
                    └── frontend minimal screen + Arabic messages
                            └── integration tests (all six spec cases)
                                    └── recovery APK → supervised device run
                                            └── verify → close path → clean build → ADR
```

## Task List

### Phase 1: Fail-closed foundation
- [ ] R1-T1: Domain errors `RecoveryNotApproved`, `RecoveryAlreadyUsed` with
  stable codes + unit tests.
- [ ] R1-T2: Migration `0009_recovery_approval.sql` + repository fns
  (provision/consume-if-unconsumed) + tests.
### Checkpoint: Foundation
- [ ] `cargo test -p mobile-shop-system identity` green; nothing callable yet.
### Phase 2: Use case + boundary (vertical slice, no UI)
- [ ] R1-T3: Recovery use case (approval consumed transactionally with
  verifier replace + `must_change_password=true` + sessions revoked + audit)
  with fail-closed, replay, and wrong-approval tests.
- [ ] R1-T4: `recovery` feature gate + Tauri command + `lib.rs` registration
  + architecture-test pin + Arabic error codes on frontend.
### Checkpoint: Slice complete
- [ ] Full `cargo test` green; command absent without the feature flag.
- [ ] Human review before any device build.
### Phase 3: Supervised device run (owner present)
- [ ] R1-T5: Build recovery APK, install `-r`, supervised execution, verify
  new-password login.
- [ ] R1-T6: Owner sets final password via forced-change screen,
  re-establishes Pattern, reads `TEST-MA-1` (separate costing gate).
### Checkpoint: Access restored
- [ ] Login evidenced; `TEST-MA-1` result recorded; audit chain inspected.
### Phase 4: Closure
- [ ] R1-T7: Remove/close path, clean production build, reinstall, verify
  recovery command absent, record ADR.
### Checkpoint: Complete
- [ ] All spec success criteria evidenced; `Costing` gate revisited separately.

## Risks and Mitigations
| Risk | Impact | Mitigation |
|---|---|---|
| Failed logins lock the account (5 max, 15 min) | Med | No further guesses; recovery path does not go through `login` |
| Keystore session leftovers across `-r` reinstall | Med | Revoke all sessions in the reset tx; verify `whoami=None` before run |
| Approval row replay | High | Consume-if-unconsumed in the same tx as the verifier write |
| Recovery build leaks beyond this device | High | Single-use approval bound to device id + date; path closed + clean build after |
| Scope creep into costing/inventory | Med | Recovery touches identity tables only; tests assert no stock writes |

## Open Questions (for plan approval)
1. Design B confirmed, or Design A instead?
2. Approval provisioning handshake: owner reads aloud a statement (device id +
   date + reason) that the supervisor inserts via the recovery screen, then it
   is consumed — acceptable?
3. New Pattern value chosen in the same supervised session?

## Task list target
Tasks mirrored in `tasks/todo.md` under "R1 Recovery". This file is the
authoritative plan.
