//! Schema constraint tests, version 1.
//!
//! Each test proves one load-bearing property of the schema against a real
//! SQLite database. The pattern is the same throughout: do the forbidden thing,
//! and assert the database itself refuses it. Application code is not involved,
//! because the point is that the schema holds even when the application is
//! wrong.

use mshop_schema::open_temp;

const NOW: &str = "2026-10-01T12:00:00.000Z";

async fn product(pool: &sqlx::SqlitePool) -> i64 {
    sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
         VALUES ('PH-1', 'Phone', 'phone', 199900, 10, ?1)",
    )
    .bind(NOW)
    .execute(pool)
    .await
    .expect("seed product")
    .last_insert_rowid()
}

#[tokio::test]
async fn money_columns_reject_real_values() {
    let (_path, pool) = open_temp("money_real").await.expect("open");
    // A float smuggled into a minor-units column must die at the database, not
    // in a code review. The typeof CHECK is what kills it.
    let outcome = sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
         VALUES ('X', 'X', 'other', 19.99, 1, ?1)",
    )
    .bind(NOW)
    .execute(&pool)
    .await;
    assert!(outcome.is_err(), "REAL into price_minor must fail, got {outcome:?}");
}

#[tokio::test]
async fn invoice_line_profit_must_match_price_minus_cost_times_qty() {
    let (_path, pool) = open_temp("profit_check").await.expect("open");
    let invoice: i64 = sqlx::query("INSERT INTO invoices (total_minor, created_at) VALUES (18000, ?1)")
        .bind(NOW)
        .execute(&pool)
        .await
        .expect("invoice")
        .last_insert_rowid();

    // Correct: (20000 - 12000) * 1 = 8000.
    sqlx::query(
        "INSERT INTO invoice_lines (invoice_id, snapshot_name, qty, unit_price_minor, unit_cost_minor, profit_minor)
         VALUES (?1, 'Charger', 1, 20000, 12000, 8000)",
    )
    .bind(invoice)
    .execute(&pool)
    .await
    .expect("consistent snapshot writes");

    // Wrong by one piastre: the database refuses, so history cannot drift.
    let outcome = sqlx::query(
        "INSERT INTO invoice_lines (invoice_id, snapshot_name, qty, unit_price_minor, unit_cost_minor, profit_minor)
         VALUES (?1, 'Charger', 1, 20000, 12000, 8001)",
    )
    .bind(invoice)
    .execute(&pool)
    .await;
    assert!(outcome.is_err(), "inconsistent profit must fail, got {outcome:?}");
}

#[tokio::test]
async fn free_name_lines_need_no_product() {
    // Accessory and used-item sales carry a name with no fixed product. The
    // schema holds them with product_id NULL rather than demanding an invented
    // product, which is the rule the legacy data requires.
    let (_path, pool) = open_temp("free_name").await.expect("open");
    let invoice: i64 = sqlx::query("INSERT INTO invoices (total_minor, created_at) VALUES (5000, ?1)")
        .bind(NOW)
        .execute(&pool)
        .await
        .expect("invoice")
        .last_insert_rowid();

    sqlx::query(
        "INSERT INTO invoice_lines (invoice_id, product_id, snapshot_name, qty, unit_price_minor, unit_cost_minor, profit_minor)
         VALUES (?1, NULL, 'Used Note 9', 1, 5000, 3500, 1500)",
    )
    .bind(invoice)
    .execute(&pool)
    .await
    .expect("a free-name line must write without a product");

    // But a line that names a missing product is a broken reference, not freedom.
    let outcome = sqlx::query(
        "INSERT INTO invoice_lines (invoice_id, product_id, snapshot_name, qty, unit_price_minor, unit_cost_minor, profit_minor)
         VALUES (?1, 999424, 'Ghost', 1, 5000, 3500, 1500)",
    )
    .bind(invoice)
    .execute(&pool)
    .await;
    assert!(outcome.is_err(), "a dangling product_id must fail, got {outcome:?}");
}

#[tokio::test]
async fn imei_is_unique_across_products() {
    let (_path, pool) = open_temp("imei_unique").await.expect("open");
    let first = product(&pool).await;
    let second: i64 = sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
         VALUES ('PH-2', 'Phone 2', 'phone', 99900, 5, ?1)",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("second product")
    .last_insert_rowid();

    sqlx::query(
        "INSERT INTO product_units (product_id, imei_serial, cost_minor, created_at)
         VALUES (?1, '356938035643809', 150000, ?2)",
    )
    .bind(first)
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("first registration");

    // Same physical device under another product: rejected. One device is one
    // row, and a duplicate is a data error to surface, never to merge.
    let outcome = sqlx::query(
        "INSERT INTO product_units (product_id, imei_serial, cost_minor, created_at)
         VALUES (?1, '356938035643809', 150000, ?2)",
    )
    .bind(second)
    .bind(NOW)
    .execute(&pool)
    .await;
    assert!(outcome.is_err(), "a duplicate IMEI must fail, got {outcome:?}");
}

#[tokio::test]
async fn legacy_rows_carry_origin_and_null_user() {
    let (_path, pool) = open_temp("legacy_marks").await.expect("open");
    let id: i64 = sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at, origin, created_by)
         VALUES ('LEG-1', 'Legacy phone', 'phone', 100000, 2, ?1, 'legacy-import', NULL)",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("legacy row")
    .last_insert_rowid();

    let (origin, created_by): (String, Option<String>) =
        sqlx::query_as("SELECT origin, created_by FROM products WHERE id = ?1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .expect("read back");
    assert_eq!(origin, "legacy-import");
    assert_eq!(created_by, None, "no user is ever invented for a legacy row");

    // And the default for new rows is local, so normal writes say nothing.
    let plain: i64 = sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
         VALUES ('NEW-1', 'New', 'other', 100, 1, ?1)",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("plain row")
    .last_insert_rowid();
    let origin: String = sqlx::query_scalar("SELECT origin FROM products WHERE id = ?1")
        .bind(plain)
        .fetch_one(&pool)
        .await
        .expect("read back");
    assert_eq!(origin, "local");
}

#[tokio::test]
async fn stock_and_reception_totals_are_checked() {
    let (_path, pool) = open_temp("stock_checks").await.expect("open");

    let negative = sqlx::query(
        "INSERT INTO products (sku, name, kind, price_minor, qty, created_at)
         VALUES ('NEG', 'Negative', 'other', 100, -1, ?1)",
    )
    .bind(NOW)
    .execute(&pool)
    .await;
    assert!(negative.is_err(), "negative stock must fail, got {negative:?}");

    let id = product(&pool).await;
    let bad_total = sqlx::query(
        "INSERT INTO purchase_history (product_id, qty, unit_cost_minor, total_minor, received_at)
         VALUES (?1, 4, 10000, 39999, ?2)",
    )
    .bind(id)
    .bind(NOW)
    .execute(&pool)
    .await;
    assert!(bad_total.is_err(), "qty * unit must equal total, got {bad_total:?}");

    sqlx::query(
        "INSERT INTO purchase_history (product_id, qty, unit_cost_minor, total_minor, received_at)
         VALUES (?1, 4, 10000, 40000, ?2)",
    )
    .bind(id)
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("consistent reception writes");
}

#[tokio::test]
async fn photo_dedup_is_a_schema_property() {
    // The model is carried over from Task 1.3 unchanged: the same picture for
    // the same product collapses by partial unique index, and removing the
    // reference reopens the slot without touching any file.
    let (_path, pool) = open_temp("photo_dedup").await.expect("open");
    let id = product(&pool).await;

    sqlx::query(
        "INSERT INTO product_photos (product_id, relative_path, sha256, format, bytes, created_at)
         VALUES (?1, 'files/photos/abc.jpg', 'abc', 'jpeg', 100, ?2)",
    )
    .bind(id)
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("first reference");

    let dupe = sqlx::query(
        "INSERT INTO product_photos (product_id, relative_path, sha256, format, bytes, created_at)
         VALUES (?1, 'files/photos/abc.jpg', 'abc', 'jpeg', 100, ?2)",
    )
    .bind(id)
    .bind(NOW)
    .execute(&pool)
    .await;
    assert!(dupe.is_err(), "a live duplicate reference must fail, got {dupe:?}");

    sqlx::query("UPDATE product_photos SET removed_at = ?1 WHERE product_id = ?2")
        .bind(NOW)
        .bind(id)
        .execute(&pool)
        .await
        .expect("soft remove");

    sqlx::query(
        "INSERT INTO product_photos (product_id, relative_path, sha256, format, bytes, created_at)
         VALUES (?1, 'files/photos/abc.jpg', 'abc', 'jpeg', 100, ?2)",
    )
    .bind(id)
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("re-adding after removal must work");
}

#[tokio::test]
async fn wallets_sum_movements_and_expenses_stay_nonnegative() {
    let (_path, pool) = open_temp("money_rules").await.expect("open");
    let wallet: i64 = sqlx::query("INSERT INTO wallets (name, created_at) VALUES ('Cash', ?1)")
        .bind(NOW)
        .execute(&pool)
        .await
        .expect("wallet")
        .last_insert_rowid();

    for amount in [50000, -20000] {
        sqlx::query(
            "INSERT INTO wallet_movements (wallet_id, amount_minor, created_at, origin)
             VALUES (?1, ?2, ?3, 'legacy-import')",
        )
        .bind(wallet)
        .bind(amount)
        .bind(NOW)
        .execute(&pool)
        .await
        .expect("signed movements write");
    }
    let balance: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(amount_minor), 0) FROM wallet_movements WHERE wallet_id = ?1")
            .bind(wallet)
            .fetch_one(&pool)
            .await
            .expect("sum");
    assert_eq!(balance, 30000, "the balance is the sum, never a stored value");

    let negative_expense = sqlx::query(
        "INSERT INTO expenses (category, amount_minor, created_at) VALUES ('rent', -1, ?1)",
    )
    .bind(NOW)
    .execute(&pool)
    .await;
    assert!(negative_expense.is_err(), "a negative expense must fail, got {negative_expense:?}");
}

#[tokio::test]
async fn cancelled_repairs_stay_in_the_record() {
    let (_path, pool) = open_temp("repair_cancel").await.expect("open");
    let id: i64 = sqlx::query(
        "INSERT INTO repairs (client_name, device_model, status, service_price_minor, profit_minor, cancelled, created_at, origin)
         VALUES ('Ahmed', 'Note 9', 'cancelled', 30000, NULL, 1, ?1, 'legacy-import')",
    )
    .bind(NOW)
    .execute(&pool)
    .await
    .expect("cancelled repair")
    .last_insert_rowid();

    let live_profit: Option<i64> = sqlx::query_scalar(
        "SELECT SUM(profit_minor) FROM repairs WHERE cancelled = 0",
    )
    .fetch_one(&pool)
    .await
    .expect("sum");
    assert_eq!(live_profit, None, "cancelled repairs leave the profit sums");

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM repairs WHERE id = ?1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(count, 1, "but the record itself remains");
}

#[tokio::test]
async fn seed_defaults_are_present() {
    let (_path, pool) = open_temp("seeds").await.expect("open");
    let version: String = sqlx::query_scalar("SELECT value FROM meta WHERE key = 'schema_version'")
        .fetch_one(&pool)
        .await
        .expect("schema version");
    // Version 3: 0003 runs in the same chain, so a fresh database lands there.
    // The seed rows themselves are what this test owns; the version asserts
    // the chain is complete.
    assert_eq!(version, "3");

    let stagnant: String = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'stagnant_days'")
        .fetch_one(&pool)
        .await
        .expect("stagnant days");
    assert_eq!(stagnant, "30", "the legacy warning horizon carries over as the default");

    let faults: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fault_types")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert!(faults >= 1, "reference vocabularies start non-empty");
}
