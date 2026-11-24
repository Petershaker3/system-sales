ADR-003 — Encrypted Local Backup & Recovery
===========================================
Handoff: 2026-10-14
Status: READY (approved ADR-003 scope only; mechanism implemented, tested, documented)
Authorized by: product owner (implementation of ADR-003 authorized this session)

Scope of this package
---------------------
The mechanism only, as enumerated in the approved scope:
  (1) crypto dependencies added;  (2) direct + resolved licences reviewed;
  (3) versioned encrypted envelope;  (4) DB + manifest + app-managed images, v1 no compression;
  (5) staged restore + validation + rollback + interruption recovery;
  (6) automated tests + docs.

Deliberately NOT in this package (out of the enumerated scope):
  - No Tauri command and no Vue UI were added. The slice is reachable from Rust
    (`services::backup::create_backup` / `restore_backup` / `recover_interrupted`),
    but there is no command/UI entry point yet. Consequence: on-device *interactive*
    validation is prerequisite-blocked and is reported Unverified below.


What was implemented (all new except the three edited files)
------------------------------------------------------------
Domain (pure: no sqlx, no Tauri, no filesystem):
  - src-tauri/src/domain/backup/error.rs     18 BackupError variants + stable BACKUP_* codes
  - src-tauri/src/domain/backup/format.rs    envelope v1 byte layout, Header, decode/validate, bounds
  - src-tauri/src/domain/backup/manifest.rs  Manifest/ComponentMeta, path policy, validation
  - src-tauri/src/domain/backup/mod.rs
Service (crypto, container, create, crash-safe restore):
  - src-tauri/src/services/backup/crypto.rs     Argon2id derive (Zeroizing key), XChaCha20-Poly1305 seal/open, SHA-256
  - src-tauri/src/services/backup/container.rs  plaintext container pack/unpack with strict bounds
  - src-tauri/src/services/backup/create.rs     create_backup, VACUUM INTO snapshot, image walk, atomic output write
  - src-tauri/src/services/backup/journal.rs    work layout, phases, startup recovery (crash-safety core)
  - src-tauri/src/services/backup/restore.rs    restore_backup, open_envelope, apply, validate_installed
  - src-tauri/src/services/backup/mod.rs        MIN_BACKUP_PASSWORD_LEN, check_password
Edited:
  - src-tauri/src/domain/mod.rs   (+ pub mod backup;)
  - src-tauri/src/services/mod.rs (+ pub mod backup;)
  - src/api/errors.ts             (+ 18 BACKUP_* codes and Arabic messages; bidirectional guard)
  - src-tauri/Cargo.toml          (+ chacha20poly1305 =0.11.0, zeroize =1.9.0, with rationale comments)
  - docs/decisions/ADR-003-encrypted-local-backups.md (appended "التنفيذ (v1)" section; accepted text untouched)
Tests:
  - src-tauri/tests/unit/backup.rs        (29 tests; registered in tests/unit/main.rs)
  - src-tauri/tests/integration/backup.rs (26 tests; registered in tests/integration/main.rs)
Docs:
  - docs/backup-format-v1.md              (normative byte layout, params, bounds, ADR-011 rationale)
  - docs/backup-dependency-licenses.md    (direct + resolved licence evidence)


Envelope v1 (frozen before use — see docs/backup-format-v1.md)
--------------------------------------------------------------
Fixed 32-byte header + 32-byte salt + 24-byte nonce + ciphertext; 88-byte prefix.
  magic "MSB1" | u16 version=1 | kdf_id=1 | aead_id=1 |
  u32 memory_kib | u32 iterations | u32 parallelism | salt_len=32 | nonce_len=24 |
  u16 flags=0 | u64 payload_len
- payload_len INCLUDES the 16-byte AEAD tag; file size = 88 + payload_len.
- AAD = the full 88-byte prefix, so every header/salt/nonce byte is authenticated.
- Unsupported version fails closed before any allocation; KDF params validated
  before Argon2 runs. Length mismatch rejects truncation and padding without a password.
- Wrong password / modified header / modified ciphertext / truncation all collapse to
  one code (BACKUP_DECRYPT_FAILED) — no oracle.
- Argon2id defaults 64 MiB / t=3 / p=1 / 32-byte key; read bounds 8–256 MiB, t=1–10,
  p=1–4, memory_kib >= 8*p.
- Payload: u32-prefixed manifest JSON + length-prefixed entries; per-component SHA-256;
  manifest and entries must describe exactly the same set.
- Caps: component 256 MiB, total 256 MiB, 10,000 components, path 512, manifest 4 MiB,
  payload 264 MiB + 16. Strict relative-path policy (no absolute, .., ., drive letter,
  :, backslash, control chars, trailing dot/space, Windows reserved device names).
- No compression in v1. No streaming in v1 (design concern below).


Crash-safe restore (the core invariant)
---------------------------------------
A sequence of renames is not a transaction, so the design does not treat it as one.
Before any live byte changes, the previous state is copied into `rollback.tmp` and
that directory is renamed atomically to `rollback/`. Therefore:
    rollback/ exists ONLY IF it is a complete snapshot of the pre-restore state.
Startup recovery (`recover_interrupted`, called before the DB is opened) decides from
that directory's presence, never from the journal — the journal is diagnostic only and
an unparseable journal is treated as absent. Phases: Prepared -> BackedUp -> Installed.
Revert removes every managed live target (shop.db, -wal, -shm, images) then rebuilds
them from the snapshot; a target absent from the snapshot is removed from live. Recovery
is idempotent. Commit (delete rollback + work) is best-effort, so a validated restore is
never reverted by a cleanup failure. restore_backup runs recovery on entry and on any
error, so there is exactly one recovery path, shared with the next startup.

ADR-011 alignment (checked, not a conflict)
-------------------------------------------
ADR-011 ("WAL-aware database snapshot") explicitly hands the WAL-aware/online backup
capability, and its WAL testing, to the local-backup slice / ADR-003, and requires this
work to reference it. The DB snapshot here is `VACUUM INTO ?1` on the live pool: online,
WAL-aware, writes nothing to the source, needs no external sqlite3, and leaves the pool
unchanged (as ADR-011 requires). It is NOT the alternative ADR-011 rejected
(`wal_checkpoint(TRUNCATE)` then copy shop.db). Restore removes shop.db-wal AND -shm, so a
stale WAL can never sit beside a restored database. The WAL-awareness is proven by
tests/integration/backup.rs::a_snapshot_captures_data_that_lives_only_in_the_wal.
No stop condition was triggered; ADR-011 imposes no constraint this design violates.


Tests executed this session (executed binaries; numbers are as observed)
-----------------------------------------------------------------------
Command (MSVC env; CARGO_TARGET_DIR=E:\Rust\targets):
  cargo test --test architecture                                -> 75 passed; 0 failed; 0 ignored
  cargo test --test unit                                        -> 123 passed; 0 failed; 0 ignored
  cargo test --lib                                              -> 27 passed; 0 failed; 0 ignored
  cargo test --test integration                                 -> 228 passed; 0 failed; 3 ignored
  cargo test --features recovery --test integration             -> 242 passed; 0 failed; 3 ignored
  cargo test --test integration backup                          -> 26 passed; 0 failed (backup slice)
  cargo test --test unit backup                                 -> 29 passed; 0 failed (backup slice)

Backup test coverage (55 tests): header round-trip; magic/version/algorithm/header/
length/KDF-bounds rejection; safe-path policy; manifest validation and code uniqueness;
successful round trip (DB + marker table + images); no-images round trip; reopen +
migrations; wrong password; modified ciphertext; modified authenticated header field;
truncation; future version; unknown algorithm; out-of-bounds KDF; unsafe path; duplicate
component; malformed manifest; missing database; hash disagreement; password policy;
WAL-only data captured by the snapshot; stale -wal/-shm removed; and 8 crash-recovery
state tests (crash before snapshot, during snapshot copy, after snapshot before journal
update, during replacement, after install before commit, after snapshot deleted,
recovery idempotence, recovery on a clean device).

Architecture guards: both drift guards pass. `the_frontend_declares_no_code_rust_cannot_emit`
passing is positive proof the scanner saw all 18 new Rust codes (otherwise the new frontend
codes would have failed it), and `every_rust_error_code_has_an_arabic_message` proves the
Arabic messages match. All existing architecture tests still pass (75).


Verified / Unverified / Coverage gaps / Design concerns
-------------------------------------------------------
VERIFIED (executed, observed):
  - Envelope encoding/decoding and all rejection paths (unit + integration).
  - Round-trip create -> restore with DB + images; no-images round trip; reopen + migrations.
  - Wrong password, tampered ciphertext, tampered authenticated header, truncation,
    unsupported version, unknown algorithm, out-of-bounds KDF, unsafe path, duplicate
    component, malformed manifest, missing database, hash disagreement: all refused.
  - Crash recovery at 6 distinct interruption points + idempotence + clean-device no-op.
  - WAL-only committed data is captured; stale -wal/-shm are not left behind.
  - Error-code parity Rust <-> src/api/errors.ts (architecture guards, 75 pass).
  - Whole dependency tree licence scan: 483/484 packages read; no copyleft-only licence;
    no GPL/AGPL/SSPL. See docs/backup-dependency-licenses.md.

UNVERIFIED (not executed / prerequisite-blocked):
  - On-device Android interactive create/restore on R3CMA016SEJ (com.mshop.taurispike).
    BLOCKED: no Tauri command / UI entry point exists in this package (out of scope).
    Compilation alone is NOT evidence of runtime success; no runtime claim is made.
  - Argon2id KDF cost on the target device (64 MiB / t=3 / p=1) has not been profiled.

COVERAGE GAPS (no test proves this):
  - No fault-injection test *inside* apply(): a failure between the live-remove loop and
    the install rename is exercised only indirectly, via recover_interrupted's revert path.
    The revert path itself is covered (8 crash-state tests), but not a mid-apply IO error.
  - No test forces `VACUUM INTO` itself to fail (e.g. disk full) mid-snapshot.

DESIGN CONCERNS (documented, not defects):
  - One-shot AEAD holds the whole plaintext and ciphertext in memory (peak a small multiple
    of MAX_PAYLOAD_LEN ~ 264 MiB). Streaming is a v2 change, not a constant edit.
  - Atomic rename assumes staging/rollback/work stay on one filesystem (they are all under
    the app data dir, which holds for Android and Windows app-local storage).


Preservation (verified by git status --porcelain)
-------------------------------------------------
  - The 12 intentionally-deleted tracked files are still deleted (count = 12).
  - No destructive git action taken: no add/commit/stash/checkout/reset/clean/restore.
    Branch and HEAD unchanged.
  - tasks/todo.md not overwritten. R1, checkpoint, and distribution files untouched.
  - Changes are confined to: src-tauri/src/domain/backup/, src-tauri/src/services/backup/,
    src-tauri/tests/{unit,integration}/backup.rs, the three registration edits
    (domain/mod.rs, services/mod.rs, tests/*/main.rs), src/api/errors.ts,
    src-tauri/Cargo.toml + Cargo.lock, docs/decisions/ADR-003-*.md,
    docs/backup-format-v1.md, docs/backup-dependency-licenses.md.

Pre-existing, NOT caused by this work (reported, not fixed — out of scope):
  - npm run typecheck reports one error, in the untracked Sales V1 file
    src/components/SalesPanel.vue:260 ("'showCancelReauth' is declared but its value is
    never read"). SalesPanel.vue is untracked and was not modified by this work (absent
    from HEAD). No error is reported in any file this work changed.
  - cargo warns: unused import DomainError in src/commands/sales.rs:16 (pre-existing).


Next steps (independent selection)
----------------------------------
  1. Add the Tauri command + Vue UI entry point for backup/restore, then run the on-device
     Android validation on R3CMA016SEJ (this is what makes the Unverified items verifiable).
  2. Optionally profile the KDF on the target device and record the result here.
  3. Attach recover_interrupted to app startup before the DB is opened (wiring, not design).

No scope expansion. No material architecture change. No stop condition triggered.
