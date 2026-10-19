//! Backward-compatible migration: a database an *earlier build* created must
//! still accept the current chain, with its data intact.
//!
//! # Why this file exists
//!
//! Every other integration test opens a **fresh** database, so each migration is
//! only ever proven to apply to nothing. That is a real gap, and the device
//! found it: an APK built before the SP-1 baseline created a `shop.db` whose
//! recorded checksum for `0005` matches no file in the repository, and the next
//! launch refused to open it —
//!
//! ```text
//! Failed to setup app: could not open the local database:
//! migration 5 was previously applied but has been modified
//! ```
//!
//! Three hundred and sixty-three green tests did not catch that, and could not
//! have: nothing in the suite ever presented a pre-existing ledger.
//!
//! # The checksum is SQLx's, not merely the same algorithm
//!
//! The fixture records, for each of `0001`–`0007`, the checksum SQLx would have
//! recorded. That algorithm was read out of the **installed `sqlx-core-0.9.0`**
//! rather than assumed:
//!
//! - `migration::checksum(sql) == Sha384::digest(sql).to_vec()`
//!   (`sqlx-core-0.9.0/src/migrate/migration.rs:86`);
//! - `ResolveConfig::new()` sets `ignored_chars` to an **empty** set
//!   (`…/migrate/source.rs:96`), so `checksum_with` takes the plain-digest branch
//!   (`…/migrate/source.rs:256-259`) rather than the whitespace-stripping one;
//! - `db::open` embeds migrations with `sqlx::migrate!` and no `ignore_changes`,
//!   so it is exactly that plain path.
//!
//! `checksum_of` below therefore reproduces SQLx's computation over the same
//! bytes, and `db::open` accepting the fixture in `test 1` — applying only `0008`
//! and refusing nothing — is the empirical confirmation. Had the digests differed,
//! SQLx would have rejected the fixture exactly as it rejected the device.
//!
//! # What this file proves, and what it does not
//!
//! **Proves:** the current chain (`0001`–`0008`, the real files) applies cleanly
//! on top of a **populated** database built from the real `0001`–`0007`, preserving
//! manager, department and setting rows, with `integrity_check` and
//! `foreign_key_check` clean before and after, and surviving a second open; and
//! separately, that a tampered checksum is **detected** and left unrepaired.
//!
//! **Does not prove:** compatibility with the *specific* historical build that
//! created the SM-N976N's database. That build predates the SP-1 baseline
//! (`32e7515`); its `0005` is not in the repository or its single-commit history,
//! and only its SHA-384 survives, so those bytes cannot be reproduced. The device
//! database is the sole specimen of that history. These tests are therefore a
//! standing regression guard for the general class, **not** a substitute for
//! recovering that file or designing an approved restore path — the only two
//! routes to re-verifying the real device.

use sha2::{Digest, Sha384};
use sqlx::SqlitePool;

use mobile_shop_system_lib::data::db;

/// Migrations up to and including the Pattern slice, applied in order.
const PRIOR_CHAIN: [(&str, &str); 7] = [
    ("1", mobile_shop_system_lib::data::migrations::IDENTITY),
    ("2", mobile_shop_system_lib::data::migrations::CATALOG),
    ("3", mobile_shop_system_lib::data::migrations::IDENTITY_LIFECYCLE),
    ("4", mobile_shop_system_lib::data::migrations::DEPARTMENTS),
    ("5", mobile_shop_system_lib::data::migrations::PRODUCTS_INVENTORY_PROFILE),
    ("6", mobile_shop_system_lib::data::migrations::SETTINGS_AND_PRICE_HISTORY),
    ("7", mobile_shop_system_lib::data::migrations::PATTERN),
];

/// The ledger table sqlx maintains, created here because sqlx owns it rather
/// than any migration. Same shape, so the later chain reads it exactly as it
/// would a real one.
const MIGRATION_TABLE: &str = "CREATE TABLE IF NOT EXISTS _sqlx_migrations (
        version BIGINT PRIMARY KEY,
        description TEXT NOT NULL,
        installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        success BOOLEAN NOT NULL,
        checksum BLOB NOT NULL,
        execution_time BIGINT NOT NULL
    )";

/// The checksum SQLx 0.9.0 would have recorded for a migration.
///
/// Reproduces `migration::checksum` from `sqlx-core-0.9.0` — `Sha384::digest`
/// over the migration text with **no** characters ignored, because
/// `ResolveConfig::new()` starts with an empty ignore set and `migrate!` never
/// adds one. See the module documentation for the line references.
///
/// This matters more than it looks: a ledger carrying a placeholder digest would
/// be rejected by `db::open` for the very reason this file exists, so the test
/// would prove nothing. Computing it exactly as SQLx does is what makes the
/// fixture a faithful stand-in for a database an earlier build wrote.
fn checksum_of(sql: &str) -> Vec<u8> {
    Sha384::digest(sql.as_bytes()).to_vec()
}

async fn ledger(pool: &SqlitePool) -> Vec<i64> {
    sqlx::query_scalar("SELECT version FROM _sqlx_migrations ORDER BY version")
        .fetch_all(pool)
        .await
        .expect("migration ledger")
}

/// Build the database an earlier build would have left behind: the prior chain
/// applied, then real rows written through the real schema.
async fn at_prior_release(dir: &std::path::Path) -> SqlitePool {
    let path = dir.join("shop.db");

    let pool = SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true),
    )
    .await
    .expect("open the prior-release database");

    sqlx::raw_sql(MIGRATION_TABLE)
        .execute(&pool)
        .await
        .expect("create the ledger");

    for (version, sql) in PRIOR_CHAIN {
        sqlx::raw_sql(sql)
            .execute(&pool)
            .await
            .unwrap_or_else(|e| panic!("prior migration {version} must apply: {e}"));
        // Record it the way sqlx would, checksum included. `MIGRATION_TYPE` 1 is
        // "applied".
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, installed_on, success, checksum, execution_time)
             VALUES (?1, ?2, ?3, 1, ?4, 0)",
        )
        .bind(version.parse::<i64>().expect("version"))
        .bind(version)
        .bind(0i64)
        .bind(checksum_of(sql))
        .execute(&pool)
        .await
        .expect("record the prior migration");
    }

    pool
}

/// Representative rows: an account, a department and a stored setting.
///
/// Written as literals against the real post-`0007` schema. `username` and
/// `must_change_password` live in `user_credentials`, not `users` — the split
/// `0003` introduced — so the seed follows the schema rather than a guess at it.
async fn seed(pool: &SqlitePool) {
    sqlx::query(
        "INSERT INTO users
         (id, display_name, role, verifier, failed_attempts, locked_until,
          created_at, updated_at, disabled_at, disabled_by)
         VALUES ('u-1', 'Prior Manager', 'manager', '$argon2id$v=19$m=1,t=1,p=1$x$y',
                 0, NULL, 1000, 1000, NULL, NULL)",
    )
    .execute(pool)
    .await
    .expect("seed the prior account");

    sqlx::query(
        "INSERT INTO user_credentials (user_id, username, must_change_password)
         VALUES ('u-1', 'prior', 0)",
    )
    .execute(pool)
    .await
    .expect("seed the prior credential");

    sqlx::query(
        "INSERT INTO departments
         (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
          sort_order, created_by, updated_by, created_at, updated_at, archived_at)
         VALUES ('d-1', 'Prior Department', 'active', 'moving_average', 0, NULL, 0,
                 0, 'u-1', 'u-1', 1000, 1000, NULL)",
    )
    .execute(pool)
    .await
    .expect("seed the prior department");

    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES ('invoice_prefix', 'INV-', 'u-1', 1000)",
    )
    .execute(pool)
    .await
    .expect("seed the prior setting");
}

async fn assert_intact(pool: &SqlitePool, stage: &str) {
    let integrity: String = sqlx::query_scalar("PRAGMA integrity_check")
        .fetch_one(pool)
        .await
        .expect("integrity_check");
    assert_eq!(integrity, "ok", "{stage}: integrity_check must be clean");

    let fk: Vec<String> = sqlx::query_scalar("PRAGMA foreign_key_check")
        .fetch_all(pool)
        .await
        .expect("foreign_key_check");
    assert!(fk.is_empty(), "{stage}: foreign_key_check must be clean, got {fk:?}");

    let users: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await
        .expect("count users");
    assert_eq!(users, 1, "{stage}: the prior account must survive");

    let name: String = sqlx::query_scalar("SELECT display_name FROM users WHERE id = 'u-1'")
        .fetch_one(pool)
        .await
        .expect("read the prior account");
    assert_eq!(name, "Prior Manager", "{stage}: the row must be unchanged");

    let dept: String = sqlx::query_scalar("SELECT name FROM departments WHERE id = 'd-1'")
        .fetch_one(pool)
        .await
        .expect("read the prior department");
    assert_eq!(dept, "Prior Department", "{stage}: the department must survive");

    let prefix: String =
        sqlx::query_scalar("SELECT value FROM app_settings WHERE key = 'invoice_prefix'")
            .fetch_one(pool)
            .await
            .expect("read the prior setting");
    assert_eq!(prefix, "INV-", "{stage}: the setting must survive");
}

#[tokio::test]
async fn the_current_chain_applies_on_top_of_a_populated_earlier_database() {
    let dir = tempfile::tempdir().expect("temp dir");
    let pool = at_prior_release(dir.path()).await;
    seed(&pool).await;

    assert_eq!(ledger(&pool).await, vec![1, 2, 3, 4, 5, 6, 7]);
    assert_intact(&pool, "before").await;

    // The real application entry point: open the existing file and let the
    // embedded chain run. `0008` through `0013` are the ones pending.
    let pool = db::open(&dir.path().join("shop.db")).await.expect("reopen");

    assert_eq!(
        ledger(&pool).await,
        vec![
            1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
            26, 27, 28, 29, 30,
        ],
        "the pending migrations must be applied, not the whole chain re-run"
    );


    assert_intact(&pool, "after").await;

    // And the tables the new migration added exist and are empty rather than
    // invented with rows. Literals, not a formatted table name: sqlx refuses to
    // audit a dynamic string, and the convention here is the same.
    let stock: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stock_levels")
        .fetch_one(&pool)
        .await
        .expect("stock_levels must exist after 0008");
    let layers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fifo_layers")
        .fetch_one(&pool)
        .await
        .expect("fifo_layers must exist after 0008");
    assert_eq!(stock, 0, "stock_levels must start empty: `spec:175` invents no stock");
    assert_eq!(layers, 0, "fifo_layers must start empty: `spec:175` invents no stock");
    let approvals: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_approval")
        .fetch_one(&pool)
        .await
        .expect("recovery_approval must exist after 0009");
    assert_eq!(approvals, 0, "no recovery is approved by migration alone");
    let customers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM customers")
        .fetch_one(&pool)
        .await
        .expect("customers must exist after 0012");
    assert_eq!(customers, 0, "no customer is invented by migration alone");
    // A sale line that predates 0013 keeps NULL warranties: the columns are
    // added, not backfilled, because a shop that never recorded a warranty did
    // not sell one.
    let dated: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sale_lines
          WHERE warranty_start IS NOT NULL OR warranty_end IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .expect("the warranty columns must exist after 0013");
    assert_eq!(dated, 0, "no warranty is invented by migration alone");
}

#[tokio::test]
async fn a_prior_release_database_survives_being_opened_twice() {
    // Opening is not a one-shot: the device launches, closes, and launches
    // again. A migration that only worked once would pass the test above.
    let dir = tempfile::tempdir().expect("temp dir");
    let pool = at_prior_release(dir.path()).await;
    seed(&pool).await;
    drop(pool);

    for round in 1..=2 {
        let pool = db::open(&dir.path().join("shop.db")).await.expect("reopen");
        assert_eq!(ledger(&pool).await.len(), 30, "round {round}: ledger complete");
        assert_intact(&pool, &format!("round {round}")).await;
    }


}

#[tokio::test]
async fn editing_an_applied_migration_is_detected_rather_than_tolerated() {
    // The device failure, pinned as a test.
    //
    // `0005` is applied, and then the *recorded checksum no longer matches the
    // file*. SQLx refuses, which is the correct outcome: proceeding would mean
    // running a chain whose history does not describe the data. The proof is
    // that the refusal happens — not that it is worked around, and not that the
    // recorded checksum is edited to agree.
    let dir = tempfile::tempdir().expect("temp dir");
    let path = dir.path().join("shop.db");

    let pool = SqlitePool::connect_with(
        sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true),
    )
    .await
    .expect("open");

    sqlx::raw_sql(MIGRATION_TABLE)
        .execute(&pool)
        .await
        .expect("create the ledger");

    for (version, sql) in PRIOR_CHAIN {
        sqlx::raw_sql(sql).execute(&pool).await.expect("apply");
        sqlx::query(
            "INSERT INTO _sqlx_migrations
             (version, description, installed_on, success, checksum, execution_time)
             VALUES (?1, ?2, ?3, 1, ?4, 0)",
        )
        .bind(version.parse::<i64>().expect("version"))
        .bind(version)
        .bind(0i64)
        .bind(checksum_of(sql))
        .execute(&pool)
        .await
        .expect("record");
    }
    drop(pool);

    // Corrupt the ledger the way an edited migration would: the recorded
    // checksum no longer describes the file that is about to run.
    let pool = SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
        .await
        .expect("reopen");
    sqlx::query("UPDATE _sqlx_migrations SET checksum = ?1 WHERE version = 5")
        .bind([9u8; 48].as_slice())
        .execute(&pool)
        .await
        .expect("tamper");
    drop(pool);

    let outcome = db::open(&path).await;

    assert!(
        outcome.is_err(),
        "a database whose recorded history disagrees with the migration files must \
         be refused, not opened"
    );

    // And the refusal must not have quietly repaired the ledger, because
    // agreeing with itself is exactly what the check exists to prevent.
    let pool = SqlitePool::connect_with(sqlx::sqlite::SqliteConnectOptions::new().filename(&path))
        .await
        .expect("reopen for inspection");
    let tampered: Vec<u8> = sqlx::query_scalar("SELECT checksum FROM _sqlx_migrations WHERE version = 5")
        .fetch_one(&pool)
        .await
        .expect("row");
    assert_eq!(
        tampered,
        vec![9u8; 48],
        "the recorded checksum must be left alone: editing it to agree would hide \
         the mismatch instead of reporting it"
    );
    let applied: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(applied, 7, "a refused open must not append migration 8");
}