# Backup envelope, version 1

**Status:** implemented — 2026-10-14.
**Decision:** `docs/decisions/ADR-003-encrypted-local-backups.md`.
**Snapshot rule:** `docs/decisions/ADR-011-wal-aware-database-snapshot.md`.

This is the normative byte layout of an encrypted local backup. The code that
writes it is `src-tauri/src/domain/backup/format.rs` (the header) and
`src-tauri/src/services/backup/container.rs` (the plaintext container). If this
document and the code disagree, the code is authoritative and this document is a
bug.

The format was frozen **before** anything depended on it, as `ADR-003:17`
requires. There is no released backup to remain compatible with, because v1 is
the first version; the format is versioned so that a future reader can tell this
one apart from whatever comes next.

---

## 1. File layout

All integers are **little-endian**. A file is a fixed 88-byte authenticated
prefix followed by the AEAD ciphertext.

```text
offset  size  field
     0     4  magic             = "MSB1"
     4     2  format_version    = 1
     6     1  kdf_algorithm     = 1   (Argon2id)
     7     1  aead_algorithm    = 1   (XChaCha20-Poly1305)
     8     4  kdf_memory_kib    (u32, 1 KiB blocks)
    12     4  kdf_iterations    (u32)
    16     4  kdf_parallelism   (u32)
    20     1  salt_len          = 32
    21     1  nonce_len         = 24
    22     2  flags             = 0   (reserved; must be zero)
    24     8  payload_len       (u64)
    32    32  salt
    64    24  nonce
    88     n  ciphertext        (payload_len bytes; Poly1305 tag appended)
```

- `HEADER_LEN = 32`, `SALT_LEN = 32`, `NONCE_LEN = 24`, `TAG_LEN = 16`,
  `AAD_LEN = 88`.
- Exact total file length is `88 + payload_len`, and nothing else.
- **`payload_len` includes the 16-byte AEAD tag.** This is the one choice that
  is easy to get wrong later, so it is stated twice: the ciphertext field is
  `payload_len` bytes long and its last 16 bytes are the tag. A reader therefore
  never has to subtract or add a tag length to compute the expected file size.

## 2. What is authenticated

The AEAD is XChaCha20-Poly1305. Associated data (AAD) is the **entire 88-byte
prefix** — the 32-byte header, the 32-byte salt and the 24-byte nonce.
Ciphertext is the plaintext container of section 3.

Consequences, all relied on by tests:

- Changing any header byte (version, an algorithm id, a KDF parameter, a
  declared length, the reserved field) invalidates the tag even though those
  bytes are not encrypted.
- Changing the salt or the nonce invalidates the tag.
- Changing or truncating the ciphertext invalidates the tag.

A reader validates in this order, and rejects as early as possible:

1. file shorter than `88 + 16` → `BACKUP_FILE_TRUNCATED`;
2. magic mismatch → `BACKUP_NOT_A_BACKUP_FILE`;
3. `format_version != 1` → `BACKUP_UNSUPPORTED_VERSION` (before any allocation);
4. unknown KDF or AEAD id → `BACKUP_UNSUPPORTED_ALGORITHM`;
5. reserved field non-zero, or `salt_len`/`nonce_len` not the constants →
   `BACKUP_HEADER_INVALID`;
6. KDF parameters out of bounds → `BACKUP_KDF_PARAMS_INVALID` (before Argon2);
7. `payload_len < 16` or `> MAX_PAYLOAD_LEN` → `BACKUP_PAYLOAD_TOO_LARGE`;
8. actual file length ≠ `88 + payload_len` → `BACKUP_FILE_TRUNCATED` (short) or
   `BACKUP_CONTENT_INVALID` (long: trailing bytes are not silently ignored);
9. AEAD failure → `BACKUP_DECRYPT_FAILED`;
10. container/manifest failure → `BACKUP_MANIFEST_INVALID`,
    `BACKUP_CONTENT_INVALID`, `BACKUP_UNSAFE_PATH`,
    `BACKUP_DUPLICATE_COMPONENT` or `BACKUP_MISSING_DATABASE`.

Steps 1–8 need no password. A hostile file costs a 32-byte read.

## 3. Plaintext container

The decrypted payload (before the tag is removed) is:

```text
u32   manifest_len
      manifest_json            (manifest_len bytes, UTF-8 JSON)
repeat until end of buffer:
  u16 path_len
      path                     (path_len bytes, UTF-8, forward slashes)
  u64 data_len
      data                     (data_len bytes)
```

- No compression in v1 (`ADR-003` decision).
- There is no component count: the reader consumes entries until the buffer is
  exhausted. Every length is checked against the bytes that remain **and**
  against the format bounds before it is used.
- The manifest and the entries must describe exactly the same set. A component
  named by neither, or named twice, is rejected; a manifest entry with no bytes
  is rejected; the two halves must agree on every path and length.

### 3.1 Manifest (JSON)

```json
{
  "format_version": 1,
  "created_at_unix_ms": 0,
  "database": { "path": "shop.db", "len": 0, "sha256": "<64 lowercase hex>" },
  "images": [ { "path": "images/...", "len": 0, "sha256": "<64 lowercase hex>" } ],
  "uncompressed_len": 0
}
```

Validated invariants (`Manifest::validate`):

- `format_version == 1`, else `BACKUP_MANIFEST_INVALID`;
- the database component exists and its path is exactly `shop.db`, else
  `BACKUP_MISSING_DATABASE`;
- every component path is safe (section 4) and is either `shop.db` or begins
  with `images/`;
- every `len` is `1 ..= MAX_COMPONENT_LEN`; every `sha256` is 64 lowercase hex;
- at most `MAX_COMPONENT_COUNT` image components; no duplicate paths;
- `uncompressed_len` equals the sum of all component lengths exactly, and that
  sum is `<= MAX_TOTAL_UNCOMPRESSED`.

SHA-256 is recomputed and compared for every component after extraction, and
again against the installed files after replacement.

## 4. Component path policy

Because one device's backup is restored on another (Windows ↔ Android), a path
must be the intersection of what both accept safely. Rejected outright
(`BACKUP_UNSAFE_PATH`):

- empty, or longer than `MAX_COMPONENT_PATH_LEN`;
- absolute, or a leading `/` or `\`, or containing `\` anywhere;
- any `.` or `..` segment, or an empty segment (`//`);
- a segment ending in `.` or a space (Windows strips those, so two names could
  collide);
- any `:` (blocks `C:` and NTFS alternate data streams);
- any control character;
- a Windows reserved device name as the segment stem (`CON`, `con.txt`, `NUL`,
  `COM1`… `LPT9`), compared case-insensitively.

Non-ASCII is allowed: an image a shop named in Arabic is legitimate, and
refusing it would fail the backup for a reason the operator cannot act on.
Symlinks are never followed and never stored.

## 5. Key derivation

Argon2id, version `0x13`, 32-byte key, 32-byte random salt.

| Parameter | Written by default | Accepted on read |
|---|---|---|
| memory | 64 MiB (`65536` KiB) | 8 MiB … 256 MiB |
| iterations `t` | 3 | 1 … 10 |
| parallelism `p` | 1 | 1 … 4 |
| additional | — | `memory_kib >= 8 * p` |

Parameters are recorded in every header, so raising the write-time cost later
does not strand existing backups. A reader validates the parameters **before**
constructing Argon2, so a crafted header cannot ask the device to allocate
gigabytes for one derivation.

## 6. Bounds

| Constant | Value | Meaning |
|---|---|---|
| `MAX_COMPONENT_LEN` | 256 MiB | one component (database or one image) |
| `MAX_TOTAL_UNCOMPRESSED` | 256 MiB | sum of all components |
| `MAX_COMPONENT_COUNT` | 10,000 | image components |
| `MAX_COMPONENT_PATH_LEN` | 512 | one component path |
| `MAX_MANIFEST_LEN` | 4 MiB | manifest JSON |
| `MAX_CONTAINER_OVERHEAD` | 8 MiB | framing + paths |
| `MAX_PAYLOAD_LEN` | 264 MiB + 16 | declared payload, before the body is read |
| `MIN_BACKUP_PASSWORD_LEN` | 8 | matches identity `MIN_PASSWORD_LEN` |

## 7. Why the snapshot is `VACUUM INTO`, not a file copy

`ADR-011` records that the live database runs in WAL mode, so `shop.db` alone is
not the whole database: recent commits may live in `shop.db-wal`. It hands the
"WAL-aware / online backup" capability, and its WAL testing, to this slice, and
requires any future backup/restore procedure to reference it.

This format carries **one self-contained database, with no WAL**, produced by
`VACUUM INTO ?1` on the live pool. That is the capability `ADR-011` asks for:

- It is **not** the alternative `ADR-011` rejected (`PRAGMA
  wal_checkpoint(TRUNCATE)` then copy `shop.db`). `VACUUM INTO` does not write
  to the source database at all, does not require an external `sqlite3`, and the
  connection pool is left exactly as `ADR-011` requires ("do not change the pool
  now").
- Because the stored database is standalone, a restore removes any existing
  `shop.db-wal` **and** `shop.db-shm` as part of the replacement. A stale WAL
  beside a restored database is the hazard `ADR-011` names; this format makes it
  impossible to leave one behind.

The WAL-awareness of the snapshot is proven by
`tests/integration/backup.rs::a_snapshot_captures_data_that_lives_only_in_the_wal`,
which commits rows with automatic checkpointing disabled, asserts the WAL is
non-empty, then backs up and restores and confirms the rows survived.

## 8. Known limits (v1)

- **No streaming.** The one-shot AEAD holds the whole plaintext and the whole
  ciphertext in memory, so peak memory is a small multiple of
  `MAX_PAYLOAD_LEN`. Streaming is a v2 change, not a constant edit.
- **No compression.**
- **Images are currently an empty set.** No product-image pipeline exists yet
  (an architecture test forbids an `image` column in the catalogue schema). The
  format and the tests tolerate an absent/empty image directory; the component
  type is exercised with synthetic image files.
- **KDF cost is unmeasured on the target hardware.** 64 MiB / t=3 / p=1 is the
  write-time default; it has not been profiled on `R3CMA016SEJ`.
