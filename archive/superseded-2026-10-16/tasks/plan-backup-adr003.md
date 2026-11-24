# Implementation Plan: ADR-003 Encrypted Local Backup & Restore

## Overview

Implement the approved encrypted, versioned, self-contained backup envelope
(XChaCha20-Poly1305 + Argon2id) and a staged, crash-safe restore engine, as one
coherent Rust work package with tests and documentation.

No Tauri command layer and no UI are added by this plan: the authorized scope
(items 1-7) is the mechanism, its tests, dependency configuration and directly
relevant documentation. On-device interactive validation depends on a command/UI
entry point that this plan deliberately does not add, so it is reported as a
prerequisite, not claimed.

## Architecture Decisions

- **Envelope**: fixed 32-byte header + 32-byte salt + 24-byte nonce + AEAD
  ciphertext. `payload_len` counts the AEAD tag (exact trailing bytes). AAD is the
  full 88-byte prefix. Version = 1; any other version fails closed before
  allocation.
- **KDF**: Argon2id, params carried in the header, validated against hard bounds
  *before* Argon2 runs (anti-DoS). Backup side writes 64 MiB / t=3 / p=1 / 32-byte.
- **Payload**: length-prefixed manifest (JSON) + length-prefixed entries (path,
  bytes). No compression in v1. SHA-256 per component in the manifest.
- **DB snapshot**: `VACUUM INTO` a temp file for a consistent single-file snapshot
  (no WAL copy hazard). Falls back is not needed; verified by test.
- **Restore**: staging dir + rollback dir + durable JSON journal, all under the
  app data dir (same filesystem, so `rename` is atomic). Startup recovery is
  idempotent.
- **Placement**: pure format/manifest/path rules in `domain/backup`; crypto, file
  IO and the restore engine in `services/backup`.
- **Errors**: `domain::backup::BackupError` with stable codes; every code gets an
  Arabic message in `src/api/errors.ts` (architecture guard enforces this).

## Task List

### Phase 1: Foundation
- [x] Task 1: Add `chacha20poly1305` + `zeroize` deps; record resolved-tree licenses. (docs/backup-dependency-licenses.md)
- [x] Task 2: `domain/backup/error.rs` — `BackupError` + codes + Arabic messages.
- [x] Task 3: `domain/backup/format.rs` — header encode/decode, bounds, version policy.
- [x] Task 4: `domain/backup/manifest.rs` — manifest types + path safety rules.

### Checkpoint: Foundation
- [x] `cargo test` unit slice passes; lib compiles.

### Phase 2: Crypto & container
- [x] Task 5: `services/backup/crypto.rs` — Argon2id KDF + XChaCha20-Poly1305 + sha256 hex.
- [x] Task 6: `services/backup/container.rs` — plaintext pack/unpack (manifest+entries).

### Checkpoint: Crypto
- [x] Round-trip unit tests pass; wrong key / tampered byte fail closed.

### Phase 3: Backup creation
- [x] Task 7: `services/backup/create.rs` — consistent DB snapshot + images + envelope write.

### Checkpoint: Create
- [x] Integration test: created file has correct magic/version; re-imports.

### Phase 4: Restore engine
- [x] Task 8: `services/backup/journal.rs` — durable journal + idempotent startup recovery.
- [x] Task 9: `services/backup/restore.rs` — stage, validate, replace, rollback.

### Checkpoint: Restore
- [x] Integration tests: wrong password, corruption, truncation, unsupported
      version, bad KDF bounds, unsafe paths, missing/duplicate images, malformed
      manifest, interrupted restore + startup recovery, post-restore consistency.

### Phase 5: Documentation & handoff
- [x] Task 10: Finalize `ADR-003` with the exact format + params + bounds. (implementation section appended)
- [x] Task 11: `docs/backup-format-v1.md` and dependency-license evidence.
- [x] Task 12: Handoff report with Verified / Unverified distinctions. (HANDOFF_ADR003_BACKUP_20261014.md)

All tasks complete 2026-10-14. See `HANDOFF_ADR003_BACKUP_20261014.md` for evidence,
Verified/Unverified distinctions, coverage gaps and design concerns. Mechanism only;
no Tauri command/UI added (on-device interactive validation remains prerequisite-blocked).

## Risks and Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| Live WAL copy is inconsistent | High | `VACUUM INTO` snapshot; test asserts WAL-free output |
| Non-atomic multi-file replace | High | staging/rollback/journal on one filesystem; idempotent recovery |
| KDF memory DoS from crafted header | High | bound-check params before Argon2 |
| AEAD crate API/version drift | Med | fetch and read real API before coding |
| `cargo test` needs MSVC env | Med | source vcvars64 via cmd, `CARGO_TARGET_DIR=E:\Rust\targets` |

## Open Questions
- None blocking. Command/UI wiring and on-device interactive validation are a
  follow-on the PO can authorize.
