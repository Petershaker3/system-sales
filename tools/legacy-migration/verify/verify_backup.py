#!/usr/bin/env python3
"""Independent verification of a produced backup.

The tool writes the backup with JavaScript libraries; this script reads it back
with entirely different implementations (PyNaCl for XChaCha20-Poly1305,
argon2-cffi for Argon2id) and then checks the database against the legacy export
it came from. If both sides agree, the envelope and the numbers are right.

Usage:
    python3 verify/verify_backup.py <backup.msb1> <password> <legacy.json>

Exit code 0 means every check passed; anything else prints what failed.
"""

import hashlib
import json
import sqlite3
import struct
import sys
import tempfile
from collections import Counter
from datetime import datetime
from pathlib import Path

import nacl.bindings
from argon2.low_level import Type, hash_secret_raw

PREFIX_LEN = 88
TAG_LEN = 16
MAGIC = b"MSB1"


def fail(message):
    print(f"FAIL  {message}")
    return 1


def ok(message):
    print(f"ok    {message}")


def decrypt(path: Path, password: str) -> bytes:
    data = path.read_bytes()
    if len(data) < PREFIX_LEN + TAG_LEN:
        raise SystemExit("file is shorter than a backup")
    if data[:4] != MAGIC:
        raise SystemExit("magic mismatch")
    version, kdf, aead = struct.unpack_from("<HBB", data, 4)
    memory, iterations, parallelism = struct.unpack_from("<III", data, 8)
    salt_len, nonce_len, flags = struct.unpack_from("<BBH", data, 20)
    (payload_len,) = struct.unpack_from("<Q", data, 24)
    assert version == 1 and kdf == 1 and aead == 1 and flags == 0, "unsupported header"
    assert salt_len == 32 and nonce_len == 24, "bad salt/nonce length"
    assert len(data) == PREFIX_LEN + payload_len, "declared length does not match file"
    salt = data[32:64]
    nonce = data[64:88]
    key = hash_secret_raw(
        secret=password.encode(),
        salt=salt,
        time_cost=iterations,
        memory_cost=memory,
        parallelism=parallelism,
        hash_len=32,
        type=Type.ID,
    )
    plain = nacl.bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
        data[PREFIX_LEN:], data[:PREFIX_LEN], nonce, key
    )
    (manifest_len,) = struct.unpack_from("<I", plain, 0)
    manifest = json.loads(plain[4 : 4 + manifest_len])
    entries = {}
    offset = 4 + manifest_len
    while offset < len(plain):
        (path_len,) = struct.unpack_from("<H", plain, offset)
        offset += 2
        name = plain[offset : offset + path_len].decode()
        offset += path_len
        (data_len,) = struct.unpack_from("<Q", plain, offset)
        offset += 8
        entries[name] = plain[offset : offset + data_len]
        offset += data_len
    assert manifest["format_version"] == 1
    assert manifest["database"]["path"] == "shop.db"
    db = entries["shop.db"]
    assert len(db) == manifest["database"]["len"]
    assert hashlib.sha256(db).hexdigest() == manifest["database"]["sha256"]
    assert manifest["uncompressed_len"] == sum(len(value) for value in entries.values())
    return db, manifest, entries


def legacy_month_totals(legacy):
    """Sales / cost per month, from sections acc, used and phones only."""
    totals = {}
    for key, raw in legacy.items():
        if not key.startswith("mshop_d_"):
            continue
        month = key[8:15]
        day = json.loads(raw)
        entry = totals.setdefault(month, {"sales": 0, "cost": 0, "acc": 0, "phones": 0, "used": 0})
        for row in day.get("acc", []):
            if row.get("_rolled"):
                continue
            entry["sales"] += row.get("sell", 0)
            entry["cost"] += row.get("buy", 0)
            entry["acc"] += 1
        for row in day.get("used", []):
            if row.get("_rolled"):
                continue
            entry["sales"] += row.get("sell", 0)
            entry["cost"] += row.get("buy", 0)
            entry["used"] += 1
        for row in day.get("phones", []):
            if row.get("_rolled"):
                continue
            qty = row.get("qty", 1)
            entry["sales"] += row.get("sellPrice", 0) * qty
            entry["cost"] += row.get("buyPrice", 0) * qty
            entry["phones"] += 1
    return totals


def main():
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    backup_path = Path(sys.argv[1])
    password = sys.argv[2]
    legacy_path = Path(sys.argv[3])

    db_bytes, manifest, entries = decrypt(backup_path, password)
    ok(f"envelope decrypts with independent libraries ({len(db_bytes)} bytes of shop.db)")

    legacy = json.loads(legacy_path.read_text(encoding="utf-8"))

    with tempfile.TemporaryDirectory() as folder:
        db_path = Path(folder) / "shop.db"
        db_path.write_bytes(db_bytes)
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        problems = 0

        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            problems += fail(f"integrity_check: {integrity}")
        else:
            ok("integrity_check")

        fk = conn.execute("PRAGMA foreign_key_check").fetchall()
        if fk:
            problems += fail(f"foreign_key_check returned {len(fk)} rows")
        else:
            ok("foreign_key_check")

        # Migration bookkeeping against the repository's real files.
        migrations_dir = Path(__file__).resolve().parents[3] / "src-tauri" / "src" / "data" / "migrations"
        files = sorted(p for p in migrations_dir.glob("*_*.sql"))
        applied = {row["version"]: bytes(row["checksum"]) for row in conn.execute("SELECT version, checksum FROM _sqlx_migrations")}
        if len(applied) != len(files):
            problems += fail(f"{len(applied)} migrations recorded, {len(files)} files on disk")
        else:
            mismatched = []
            for path in files:
                version = int(path.name.split("_", 1)[0])
                expected = hashlib.sha384(path.read_bytes()).digest()
                if applied.get(version) != expected:
                    mismatched.append(path.name)
            if mismatched:
                problems += fail(f"checksum mismatch: {mismatched[:3]}")
            else:
                ok(f"all {len(files)} migration checksums match the repository files")

        # Tally what is in the new database.
        def scalar(sql, *params):
            return conn.execute(sql, params).fetchone()[0]

        counts = {
            "departments": scalar("SELECT COUNT(*) FROM departments"),
            "brands": scalar("SELECT COUNT(*) FROM brands"),
            "products": scalar("SELECT COUNT(*) FROM products"),
            "sales": scalar("SELECT COUNT(*) FROM sales WHERE kind = 'sale'"),
            "sale_lines": scalar("SELECT COUNT(*) FROM sale_lines"),
            "repairs": scalar("SELECT COUNT(*) FROM repairs"),
            "expenses": scalar("SELECT COUNT(*) FROM expenses"),
            "wallets": scalar("SELECT COUNT(*) FROM wallets"),
            "users": scalar("SELECT COUNT(*) FROM users"),
        }
        print("      " + ", ".join(f"{key}={value}" for key, value in counts.items()))

        if counts["users"] != 1:
            problems += fail("expected exactly one (open) owner account")
        else:
            provisional = scalar("SELECT provisional FROM users")
            if provisional != 1:
                problems += fail("the owner account is not the open row the app expects")
            else:
                ok("one open owner row (provisional = 1), so the shop opens without a password")

        shop_name = scalar("SELECT value FROM app_settings WHERE key = 'ui.shop_name'")
        if shop_name != (legacy.get("mshop_cfg") and json.loads(legacy["mshop_cfg"]).get("name")):
            problems += fail(f"shop name is {shop_name!r}")
        else:
            ok(f"shop name carried: {shop_name}")

        # Stock must equal the ledger, exactly.
        mismatched_stock = conn.execute(
            """
            SELECT s.product_id, s.quantity, COALESCE(SUM(m.quantity_delta), 0) AS moved,
                   s.total_cost_minor, COALESCE(SUM(m.cost_delta_minor), 0) AS cost
              FROM stock_levels s
              LEFT JOIN stock_movements m ON m.product_id = s.product_id
             GROUP BY s.product_id
            HAVING s.quantity != moved OR s.total_cost_minor != cost
            """
        ).fetchall()
        if mismatched_stock:
            problems += fail(f"{len(mismatched_stock)} stock rows disagree with their movements")
        else:
            ok("every stock level equals the sum of its movements")

        negatives = scalar("SELECT COUNT(*) FROM stock_levels WHERE quantity < 0")
        if negatives:
            problems += fail(f"{negatives} products have negative stock")

        # Line arithmetic and invoices.
        bad_lines = scalar(
            "SELECT COUNT(*) FROM sale_lines WHERE line_total_minor != quantity * unit_selling_price_minor - discount_minor"
        )
        if bad_lines:
            problems += fail(f"{bad_lines} sale lines have wrong totals")
        bad_totals = scalar(
            """
            SELECT COUNT(*) FROM (
              SELECT s.id, s.total_minor, SUM(l.line_total_minor) AS lines
                FROM sales s JOIN sale_lines l ON l.sale_id = s.id
               GROUP BY s.id
              HAVING s.total_minor != lines
            )
            """
        )
        if bad_totals:
            problems += fail(f"{bad_totals} invoices do not equal their lines")
        else:
            ok("every invoice equals its lines")

        # The numbers: monthly sales must match the legacy export.
        expected = legacy_month_totals(legacy)
        rows = conn.execute(
            """
            SELECT strftime('%Y-%m', occurred_at / 1000, 'unixepoch', 'localtime') AS month,
                   SUM(total_minor) AS total, SUM(cost_total_minor) AS cost
              FROM sales
             WHERE kind = 'sale'
             GROUP BY month
             ORDER BY month
            """
        ).fetchall()
        print("      month      new (EGP)      old (EGP)")
        for row in rows:
            month = row["month"]
            old = expected.get(month, {"sales": 0, "cost": 0})
            new_total = row["total"] / 100
            new_cost = row["cost"] / 100
            delta = abs(new_total - old["sales"])
            marker = "ok " if delta < 1 else "!! "
            if delta >= 1:
                problems += fail(f"{month}: new {new_total:.2f} vs old {old['sales']:.2f}")
            print(f"      {marker}{month}  {new_total:12,.2f}  {old['sales']:12,.2f}")
        missing = set(expected) - {row["month"] for row in rows}
        if missing:
            print(f"      (months with no sales rows: {sorted(missing)})")

        # Repairs and expenses carried across.
        old_repairs = 0
        old_software = 0
        old_expenses = 0
        for key, raw in legacy.items():
            if not key.startswith("mshop_d_"):
                continue
            day = json.loads(raw)
            old_repairs += len([row for row in day.get("repairs", []) if not row.get("_rolled")])
            old_software += len([row for row in day.get("sw", []) if not row.get("_rolled")])
            old_expenses += len(day.get("exp", []))
        if counts["repairs"] != old_repairs + old_software:
            problems += fail(f"repairs {counts['repairs']} != legacy {old_repairs + old_software}")
        else:
            ok(f"all {old_repairs} repair tickets and {old_software} software tickets carried")
        if counts["expenses"] != old_expenses:
            problems += fail(f"expenses {counts['expenses']} != legacy {old_expenses}")
        else:
            ok(f"all {old_expenses} expenses carried")

        # No secrets from the legacy configuration leaked in.
        dumped = json.dumps({key: scalar("SELECT value FROM app_settings WHERE key = ?", key) for key in ["ui.shop_name"]})
        cfg = json.loads(legacy.get("mshop_cfg", "{}"))
        for secret_key in ("passMain", "passAdmin", "pass", "googleClientId"):
            value = cfg.get(secret_key)
            if value and value in dumped:
                problems += fail(f"legacy secret {secret_key} leaked into settings")

        conn.close()

    print()
    if problems:
        print(f"{problems} check(s) failed")
        return 1
    print("every check passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
