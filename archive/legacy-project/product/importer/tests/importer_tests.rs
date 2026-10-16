//! Importer acceptance: fresh databases, rollback on block, idempotent reruns,
//! stable identities, and literal totals. The blocked fixture is the original
//! mixed export; the clean fixture migrates end to end with zero exclusions.

use mshop_importer::{import_from_str, ImportError};
use std::path::PathBuf;

fn temp_db(tag: &str) -> PathBuf {
    let mut path = std::env::temp_dir();
    path.push(format!("mshop_import_test_{tag}.db"));
    let _ = std::fs::remove_file(&path);
    path
}

fn clean_json() -> String {
    std::fs::read_to_string("tests/fixtures/clean.json").expect("clean fixture must exist")
}

fn mixed_json() -> String {
    std::fs::read_to_string("../../spikes/legacy-import/fixtures/legacy-export-mixed.json")
        .expect("mixed fixture must exist")
}

async fn count(pool: &sqlx::SqlitePool, table: &str) -> i64 {
    let sql = format!("SELECT COUNT(*) FROM {table}");
    sqlx::query_scalar::<_, i64>(&sql)
        .fetch_one(pool)
        .await
        .expect("count")
}

async fn open_db(path: &std::path::Path) -> sqlx::SqlitePool {
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;
    let url = format!("sqlite://{}", path.display().to_string().replace('\\', "/"));
    SqlitePoolOptions::new()
        .max_connections(1)
        .connect_with(
            SqliteConnectOptions::from_str(&url)
                .expect("url")
                .foreign_keys(true),
        )
        .await
        .expect("open")
}

#[tokio::test]
async fn clean_fixture_creates_a_v3_database() {
    let db = temp_db("v3");
    let report = import_from_str(&clean_json(), &db).await.expect("clean import");
    assert!(report.review.is_empty(), "nothing may need guessing: {:?}", report.review);

    let pool = open_db(&db).await;
    let version: String = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'schema_version'")
        .fetch_one(&pool)
        .await
        .expect("version");
    assert_eq!(version, "3");

    assert_eq!(count(&pool, "products").await, 2, "catalog item plus inventory phone");
    assert_eq!(count(&pool, "purchase_history").await, 1);
    assert_eq!(count(&pool, "invoices").await, 4, "acc, used, sw, phones");
    assert_eq!(count(&pool, "invoice_lines").await, 4);
    assert_eq!(count(&pool, "repairs").await, 1);
    assert_eq!(count(&pool, "repair_status_history").await, 1);
    assert_eq!(count(&pool, "wallet_movements").await, 2, "deposit plus opening");
    assert_eq!(count(&pool, "expenses").await, 1);
    assert_eq!(count(&pool, "repair_parts").await, 1);

    // The inventory phone carries NULL price: unknown, never zero.
    let price: Option<i64> =
        sqlx::query_scalar("SELECT price_minor FROM products WHERE sku = 'legacy:m9'")
            .fetch_one(&pool)
            .await
            .expect("price");
    assert_eq!(price, None);

    // The stagnant threshold rode along as a setting, overriding the default.
    let stagnant: String =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'stagnant_days'")
            .fetch_one(&pool)
            .await
            .expect("setting");
    assert_eq!(stagnant, "45");
    pool.close().await;
}

#[tokio::test]
async fn blocked_fixture_writes_nothing_at_all() {
    // The mixed fixture holds an unrepresentable service row. The import must
    // refuse with zero business rows: a half-written shop is worse than none.
    // The refusal happens before any database is even opened, so the proof is
    // stronger than empty tables: the file itself must not exist.
    let db = temp_db("blocked");
    let err = import_from_str(&mixed_json(), &db).await.expect_err("must refuse");
    assert!(
        matches!(err, ImportError::Blocked(_)),
        "refusal names the rows: {err}"
    );
    assert!(
        !db.exists(),
        "no database file may be created for a refused import"
    );
}

#[tokio::test]
async fn rerun_into_a_populated_destination_is_refused_not_merged() {
    // Idempotency used to mean "run twice into the same file and the second run
    // reuses every row". The freshness gate deliberately retired that meaning:
    // a destination that already holds shop rows is refused outright, because
    // merging a second history into one database is a different operation with
    // rules nobody has agreed to. What must still hold is that the refusal
    // changes nothing about the first run's data.
    let db = temp_db("idempotent");
    let first = import_from_str(&clean_json(), &db).await.expect("first run");
    assert!(first.inserted.products > 0, "the first run writes");

    let second = import_from_str(&clean_json(), &db)
        .await
        .expect_err("a populated destination is refused");
    assert!(
        matches!(second, ImportError::Destination(_)),
        "refused for being in use, not for the data: {second}"
    );

    let pool = open_db(&db).await;
    assert_eq!(count(&pool, "products").await, 2, "the first run's rows are intact");
    assert_eq!(count(&pool, "invoices").await, 4);
    assert_eq!(count(&pool, "repair_status_history").await, 1, "history is not doubled");
    pool.close().await;
}

#[tokio::test]
async fn identities_are_stable_across_independent_runs() {
    // Identity stability is still a real guarantee, but it now shows up where
    // it is meaningful: two separate fresh destinations built from the same
    // source must agree on every ref. Same source, same identities, regardless
    // of which file they land in.
let first_db = temp_db("identity_a");
    let second_db = temp_db("identity_b");
    import_from_str(&clean_json(), &first_db).await.expect("first run");
    import_from_str(&clean_json(), &second_db).await.expect("second run");

    let pool = open_db(&first_db).await;
    let first: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT origin, source_entity, origin_ref FROM products ORDER BY origin_ref",
    )
    .fetch_all(&pool)
    .await
    .expect("refs");
    pool.close().await;

    let pool = open_db(&second_db).await;
    let second: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT origin, source_entity, origin_ref FROM products ORDER BY origin_ref",
    )
    .fetch_all(&pool)
    .await
    .expect("refs");
    pool.close().await;

    assert_eq!(first, second, "identities do not drift between runs");
    assert!(first
        .iter()
        .all(|(o, e, r)| o == "legacy-import" && !e.is_empty() && !r.is_empty()));
}

#[tokio::test]
async fn clean_totals_match_literally_with_zero_exclusions() {
    let db = temp_db("totals");
    let report = import_from_str(&clean_json(), &db).await.expect("clean import");
    let raw: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string("tests/fixtures/clean.json").expect("fixture"),
    )
    .expect("json");
    let want = &raw["_expected"];
    let t = report.totals;
    for (field, value) in [
        ("aS", t.accessory_sell),
        ("aP", t.accessory_profit),
        ("uS", t.used_sell),
        ("uP", t.used_profit),
        ("cT", t.cash_total),
        ("sT", t.service_total),
        ("eT", t.expense_total),
        ("phS", t.phone_sell),
        ("phP", t.phone_profit),
        ("repS", t.repair_sell),
        ("repP", t.repair_profit),
        ("total", t.sales_total),
        ("profit", t.profit_total),
    ] {
        assert_eq!(
            value,
            want[field].as_i64().unwrap() * 100,
            "{field}: reconciled {value} != fixture"
        );
    }
}

