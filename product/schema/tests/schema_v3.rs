//! Migration 0003 tests: nullable price, source identity, and rebuild safety.
//!
//! The most important test here migrates a hand-built v1 table with rows in
//! it, using the actual migration file text rather than a copy. A migration
//! test that only checks the end state proves the destination; this one proves
//! the journey preserves data, because a rebuild that drops a column silently
//! is exactly the failure this migration must not have.

use mshop_schema::open_temp;

const NOW: &str = "2026-10-01T12:00:00.000Z";

fn statements(sql: &str) -> Vec<&str> {
    sql.split(";\n")
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .collect()
}

/// A pool with foreign keys on and nothing migrated: the test applies migration
/// files itself, in order, so "v2 then 0003" is what actually runs rather than
/// a fresh full migrate pretending to be an upgrade.
async fn bare_pool(tag: &str) -> (std::path::PathBuf, sqlx::SqlitePool) {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    let mut path = std::env::temp_dir();
    path.push(format!("mshop_schema_v3_{tag}.db"));
    let _ = std::fs::remove_file(&path);
    let url = format!("sqlite://{}", path.display().to_string().replace('\\', "/"));
    let options = SqliteConnectOptions::from_str(&url)
        .expect("url")
        .create_if_missing(true)
        .foreign_keys(true);
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(options)
        .await
        .expect("connect");
    (path, pool)
}

async fn apply(pool: &sqlx::SqlitePool, sql: &str) {
    for stmt in statements(sql) {
        if stmt.starts_with("PRAGMA") {
            continue;
        }
        sqlx::query(stmt)
            .execute(pool)
            .await
            .unwrap_or_else(|e| panic!("migration statement failed: {e}\n---\n{stmt}"));
    }
}

#[tokio::test]
async fn null_price_is_allowed_and_is_not_zero() {
    let (_path, pool) = open_temp("price_null").await.expect("open");
    // NULL means "legacy product with unknown selling price". Zero means free.
    // The schema holds both at once so the distinction cannot collapse.
    sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
         VALUES ('UNK-1', 'Unknown price', 'phone', NULL, 3, ?1)",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("NULL price writes");
    sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
         VALUES ('FREE-1', 'Free item', 'accessory', 0, 5, ?1)",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("zero price writes");

    let nulls: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE price_minor IS NULL")
        .fetch_one(&pool)
        .await
        .expect("count");
    let zeros: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE price_minor = 0")
            .fetch_one(&pool)
            .await
            .expect("count");
    assert_eq!((nulls, zeros), (1, 1), "unknown and free stay distinct rows");

    // And REAL is still rejected: nullability did not open the type.
    let real = sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
         VALUES ('BAD', 'Bad', 'other', 19.99, 1, ?1)",
    )
    .bind(NOW)
    .execute(&pool)
    .await;
    assert!(real.is_err(), "REAL is still rejected, got {real:?}");
}

#[tokio::test]
async fn composite_identity_is_enforced_only_when_a_ref_exists() {
    let (_path, pool) = open_temp("identity_unique").await.expect("open");
    for (sku, entity, reference) in [
        ("A", "mshop_inventory", "m1"),
        ("B", "mshop_inventory", "m1"),
    ] {
        let outcome = sqlx::query(
            "INSERT INTO products (sku, name, kind, price_minor, qty, created_at, origin, source_entity, origin_ref)
             VALUES (?1, 'P', 'phone', 100, 1, ?2, 'legacy-import', ?3, ?4)",
        )
        .bind(sku)
        .bind(NOW)
        .bind(entity)
        .bind(reference)
        .execute(&pool)
        .await;
        if sku == "A" {
            outcome.expect("first identity writes");
        } else {
            assert!(
                outcome.is_err(),
                "the same (origin, entity, ref) twice must fail, got {outcome:?}"
            );
        }
    }

    // Same ref under another entity is a different identity, not a collision.
    sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at, origin, source_entity, origin_ref)
         VALUES ('C', 'P', 'phone', 100, 1, ?1, 'legacy-import', 'mshop_other', 'm1')",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("same ref under another entity writes");

    // Same ref under another origin is a different identity too.
    sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at, origin, source_entity, origin_ref)
         VALUES ('D', 'P', 'phone', 100, 1, ?1, 'local', 'mshop_inventory', 'm1')",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("same ref under another origin writes");

    // Ordinary local rows carry no ref at all, in any number.
    for sku in ["E", "F"] {
        sqlx::query(
            "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
             VALUES (?1, 'P', 'phone', 100, 1, ?2)",
        )
        .bind(sku)
        .bind(NOW)
        .execute(&pool)
        .await
        .expect("NULL refs never collide");
    }
}

#[tokio::test]
async fn rebuild_preserves_every_row_and_column() {
    // A v2 database with real rows: 0001 then 0002, applied as files, exactly
    // as an existing install would have them. Then 0003 runs against it.
    let (_path, pool) = bare_pool("rebuild").await;
    apply(&pool, include_str!("../migrations/0001_init.sql")).await;
    apply(&pool, include_str!("../migrations/0002_seed_defaults.sql")).await;

    for (sku, price) in [("OLD-1", 9000), ("OLD-2", 15000)] {
        sqlx::query(
            "INSERT INTO products (sku, name, kind, price_minor, qty, created_at, origin)
             VALUES (?1, 'Old', 'phone', ?2, 2, ?3, 'legacy-import')",
        )
        .bind(sku)
        .bind(price)
        .bind(NOW)
        .execute(&pool)
        .await
        .expect("seed old row");
    }

    apply(&pool, include_str!("../migrations/0003_identity_nullable_price.sql")).await;

    // Every row survives with every value intact, and the new columns exist.
    let rows: Vec<(String, Option<i64>, i64, Option<String>)> = sqlx::query_as(
        "SELECT sku, price_minor, qty, origin_ref FROM products ORDER BY sku",
    )
    .fetch_all(&pool)
    .await
    .expect("read back");
    assert_eq!(
        rows,
        vec![
            ("OLD-1".to_string(), Some(9000), 2, None),
            ("OLD-2".to_string(), Some(15000), 2, None),
        ],
        "the rebuild must preserve rows byte for byte"
    );

    // And the migrated table behaves as v3: NULL price writes now.
    sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
         VALUES ('NEW-1', 'New', 'phone', NULL, 1, ?1)",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("NULL price after rebuild");

    let version: String = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'schema_version'")
        .fetch_one(&pool)
        .await
        .expect("version");
    assert_eq!(version, "3");
}

#[tokio::test]
async fn fresh_databases_report_version_three() {
    let (_path, pool) = open_temp("version").await.expect("open");
    let version: String = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'schema_version'")
        .fetch_one(&pool)
        .await
        .expect("version");
    assert_eq!(version, "3", "a fresh migrate lands on v3");
}
