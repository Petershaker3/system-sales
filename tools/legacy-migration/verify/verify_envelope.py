#!/usr/bin/env python3
"""Check a `.msb1` file against the app's own rules, not the tool's.

`verify_backup.py` proves the *contents* are right (money, checksums, stock).
This script proves the *envelope* is the one `src-tauri/src/domain/backup/`
accepts, by re-implementing `format.rs`, `container.rs` and `manifest.rs` field by
field — same offsets, same bounds, same reserved values, same path policy.

It exists because the app said «تعذّر الاستيراد» while every check we had said the
file was fine. A file can be cryptographically perfect and still be refused for a
byte in the header, so that byte is what this script looks at.

    python3 verify/verify_envelope.py file.msb1 'password'
"""

import json
import struct
import sys

MAGIC = b"MSB1"
FORMAT_VERSION = 1
KDF_ARGON2ID = 1
AEAD_XCHACHA20 = 1
HEADER_LEN = 32
SALT_LEN = 32
NONCE_LEN = 24
TAG_LEN = 16
AAD_LEN = HEADER_LEN + SALT_LEN + NONCE_LEN
KEY_LEN = 32
MIN_MEMORY_KIB, MAX_MEMORY_KIB = 8 * 1024, 256 * 1024
MIN_ITERATIONS, MAX_ITERATIONS = 1, 10
MIN_PARALLELISM, MAX_PARALLELISM = 1, 4
MAX_COMPONENT_LEN = 256 * 1024 * 1024
MAX_TOTAL_UNCOMPRESSED = 256 * 1024 * 1024
MAX_COMPONENT_COUNT = 10_000
MAX_COMPONENT_PATH_LEN = 512
MAX_MANIFEST_LEN = 4 * 1024 * 1024
MAX_CONTAINER_OVERHEAD = 8 * 1024 * 1024
MAX_PAYLOAD_LEN = MAX_TOTAL_UNCOMPRESSED + MAX_CONTAINER_OVERHEAD + TAG_LEN
WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *[f"com{i}" for i in range(1, 10)],
    *[f"lpt{i}" for i in range(1, 10)],
}

failures = []


def check(condition, label, detail=""):
    if condition:
        print(f"ok    {label}")
    else:
        failures.append(f"{label} — {detail}" if detail else label)
        print(f"FAIL  {label}" + (f" — {detail}" if detail else ""))


def validate_component_path(path):
    """`manifest.rs::validate_component_path`, clause for clause."""
    if not path or len(path.encode()) > MAX_COMPONENT_PATH_LEN:
        return "UnsafePath: empty or too long"
    if path.startswith("/") or path.startswith("\\") or "\\" in path:
        return "UnsafePath: absolute or backslash"
    for segment in path.split("/"):
        if segment in ("", ".", ".."):
            return f"UnsafePath: bad segment «{segment}»"
        if segment.endswith(".") or segment.endswith(" "):
            return f"UnsafePath: segment ends with '.' or space («{segment}»)"
        if ":" in segment:
            return "UnsafePath: ':' in a segment"
        if any(ord(ch) < 32 for ch in segment):
            return "UnsafePath: control character"
        stem = segment.split(".")[0]
        if stem.lower() in WINDOWS_RESERVED:
            return f"UnsafePath: reserved device name «{stem}»"
    return None


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    path, password = sys.argv[1], sys.argv[2]
    with open(path, "rb") as handle:
        data = handle.read()

    print(f"file: {path} ({len(data)} bytes)")

    # ── format.rs::decode_header ──────────────────────────────────────────
    check(len(data) >= HEADER_LEN, "at least one header")
    check(data[0:4] == MAGIC, "magic is «MSB1»", repr(data[0:4]))
    version = struct.unpack_from("<H", data, 4)[0]
    check(version == FORMAT_VERSION, "format_version == 1", f"got {version}")
    check(data[6] == KDF_ARGON2ID, "kdf_algorithm == 1 (Argon2id)", f"got {data[6]}")
    check(data[7] == AEAD_XCHACHA20, "aead_algorithm == 1 (XChaCha20-Poly1305)", f"got {data[7]}")
    memory_kib, iterations, parallelism = struct.unpack_from("<III", data, 8)
    check(MIN_MEMORY_KIB <= memory_kib <= MAX_MEMORY_KIB,
          f"kdf_memory_kib inside bounds ({memory_kib})", "8 MiB – 256 MiB")
    check(MIN_ITERATIONS <= iterations <= MAX_ITERATIONS,
          f"kdf_iterations inside bounds ({iterations})", "1 – 10")
    check(MIN_PARALLELISM <= parallelism <= MAX_PARALLELISM,
          f"kdf_parallelism inside bounds ({parallelism})", "1 – 4")
    check(data[20] == SALT_LEN, "salt_len == 32", f"got {data[20]}")
    check(data[21] == NONCE_LEN, "nonce_len == 24", f"got {data[21]}")
    flags = struct.unpack_from("<H", data, 22)[0]
    check(flags == 0, "flags == 0", f"got {flags}")
    payload_len = struct.unpack_from("<Q", data, 24)[0]
    check(TAG_LEN <= payload_len <= MAX_PAYLOAD_LEN,
          f"payload_len inside bounds ({payload_len})", "includes the 16-byte tag")

    # ── format.rs::check_file_len ─────────────────────────────────────────
    expected = AAD_LEN + payload_len
    check(len(data) == expected, "file length == 88 + payload_len",
          f"expected {expected}, got {len(data)}")

    # ── crypto: the envelope must open with this password ─────────────────
    import nacl.bindings as bindings
    import nacl.exceptions as nacl_errors
    import hashlib

    salt = data[HEADER_LEN:HEADER_LEN + SALT_LEN]
    nonce = data[HEADER_LEN + SALT_LEN:AAD_LEN]
    aad = data[:AAD_LEN]
    ciphertext = data[AAD_LEN:]
    key = hashlib.blake2b(password.encode(), digest_size=KEY_LEN).digest()  # placeholder
    try:
        from argon2.low_level import hash_secret_raw, Type
        key = hash_secret_raw(
            secret=password.encode(),
            salt=salt,
            time_cost=iterations,
            memory_cost=memory_kib,
            parallelism=parallelism,
            hash_len=KEY_LEN,
            type=Type.ID,
        )
    except Exception as error:  # pragma: no cover
        check(False, "argon2id key derivation", str(error))
        return 1

    try:
        plaintext = bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
            ciphertext, aad, nonce, key
        )
    except nacl_errors.CryptoError as error:
        check(False, "envelope opens with the password", str(error))
        return 1
    check(True, "envelope opens with the password")

    # ── container.rs::unpack ──────────────────────────────────────────────
    position = 0

    def take(count):
        nonlocal position
        if position + count > len(plaintext):
            raise ValueError("container truncated")
        chunk = plaintext[position:position + count]
        position += count
        return chunk

    manifest_len = struct.unpack("<I", take(4))[0]
    check(0 < manifest_len <= MAX_MANIFEST_LEN, f"manifest_len sane ({manifest_len})")
    manifest = json.loads(take(manifest_len).decode("utf-8"))

    required = ["format_version", "created_at_unix_ms", "database", "images", "uncompressed_len"]
    check(list(manifest.keys()) == required or set(manifest.keys()) == set(required),
          "manifest has exactly the five fields the app deserialises",
          f"got {sorted(manifest.keys())}")
    check(manifest["format_version"] == 1, "manifest.format_version == 1")
    check(isinstance(manifest["created_at_unix_ms"], int) and manifest["created_at_unix_ms"] > 0,
          "manifest.created_at_unix_ms is a positive integer")

    def validate_meta(meta, kind):
        problem = validate_component_path(meta["path"])
        check(problem is None, f"path is safe: {meta['path']}", problem or "")
        if kind == "db":
            check(meta["path"] == "shop.db", "database path is exactly «shop.db»", meta["path"])
        else:
            check(meta["path"].startswith("images/"), "image lives under «images/»", meta["path"])
        check(0 < meta["len"] <= MAX_COMPONENT_LEN, f"len sane for {meta['path']} ({meta['len']})")
        check(len(meta["sha256"]) == 64 and all(c in "0123456789abcdef" for c in meta["sha256"]),
              f"sha256 is lowercase hex for {meta['path']}", meta["sha256"])

    validate_meta(manifest["database"], "db")
    check(len(manifest["images"]) <= MAX_COMPONENT_COUNT,
          f"image count within bounds ({len(manifest['images'])})")

    total = manifest["database"]["len"]
    seen = {manifest["database"]["path"]}
    for image in manifest["images"]:
        validate_meta(image, "image")
        check(image["path"] not in seen, f"no duplicate component {image['path']}")
        seen.add(image["path"])
        total += image["len"]
    check(total <= MAX_TOTAL_UNCOMPRESSED, f"total uncompressed within bounds ({total})")
    check(total == manifest["uncompressed_len"],
          "uncompressed_len equals the sum of components",
          f"{manifest['uncompressed_len']} vs {total}")

    # ── components must agree with the manifest, byte for byte ────────────
    import hashlib as hl
    components = {}
    while position < len(plaintext):
        path_len = struct.unpack("<H", take(2))[0]
        name = take(path_len).decode("utf-8")
        data_len = struct.unpack("<Q", take(8))[0]
        blob = take(data_len)
        check(name not in components, f"component appears once: {name}")
        check(len(blob) == data_len and data_len > 0, f"component has bytes: {name}")
        check(hl.sha256(blob).hexdigest() == (manifest["database"]["sha256"]
              if name == "shop.db" else next((i["sha256"] for i in manifest["images"] if i["path"] == name), "")),
              f"sha256 matches the manifest for {name}")
        problem = validate_component_path(name)
        check(problem is None, f"component path admitted by the format: {name}", problem or "")
        check(name == "shop.db" or name.startswith("images/"), f"component kind known: {name}")
        components[name] = blob
    check(position == len(plaintext), "no trailing bytes after the components")
    check(set(components) == seen, "manifest and components name the same set",
          f"{sorted(set(components) ^ seen)}")

    # ── the database is SQLite the app can open ──────────────────────────
    db = components.get("shop.db", b"")
    check(db[:16] == b"SQLite format 3\x00", "database is a SQLite 3 file", repr(db[:16]))
    page_size = struct.unpack(">H", db[16:18])[0] or 65536
    check(page_size in (512, 1024, 2048, 4096, 8192, 16384, 32768, 65536),
          f"page size is a power of two the engine accepts ({page_size})")
    check(b"\x00" * 4 != db[-4:], "database ends cleanly")

    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for failure in failures:
            print(f"  - {failure}")
        return 1
    print("the envelope is exactly what the app accepts")
    return 0


if __name__ == "__main__":
    sys.exit(main())
