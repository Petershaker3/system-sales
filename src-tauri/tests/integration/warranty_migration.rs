//! Migration `0013`: the warranty columns on `sale_lines`.
//!
//! Proves only what the migration claims, against real SQLite (`spec:138`).
//! Raw SQL is the correct tool here: the claim under test IS the schema, so
//! writing through the sales service would test the service instead and could
//! pass while the constraint it depends on was absent.
//!
//! The service-level behaviour (the operator's dates survive the round trip, a
//! cancellation mirrors them) lives in `sales.rs`, and the date grammar itself is
//! unit tested in `tests/unit`. What is left for this file is the guarantee that
//! holds even when a row is written by something other than this service.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::Sensitivity;
use mobile_shop_system_lib::services::catalog::{product as catalog, CatalogContext};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales_use_cases, SaleLineInput};
use sqlx::SqlitePool;

const PASSWORD: &str = "correct horse battery";

/// A migrated shop with one priced product holding stock, plus a recorded sale
/// so `sale_lines` has a row to constrain.
async fn shop_with_one_sale() -> (SqlitePool, Arc<InMemoryTokenStore>, String) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let catalog_ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let open_session = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    let product = catalog::create(
        &catalog_ctx,
        &open_session,
        catalog::NewProduct {
            name: "Test Widget".to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(150),
            category: None,
        },
    )
    .await
    .expect("product");

    inventory::receive(
        &pool,
        tokens.as_ref(),
        &product.id.as_str(),
        10,
        100,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receipt");

    sales_use_cases::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: product.id.as_str().to_string(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
        }],
        None,
    )
    .await
    .expect("a sale to hang the line off");

    (pool, tokens, product.id.as_str().to_string())
}

/// `(name, declared type, notnull)` for every column of `sale_lines`.
async fn sale_line_columns(pool: &SqlitePool) -> Vec<(String, String, i64)> {
    sqlx::query_as("SELECT name, type, \"notnull\" FROM pragma_table_info('sale_lines')")
        .fetch_all(pool)
        .await
        .expect("sale_lines columns")
}

#[tokio::test]
async fn migration_0013_adds_two_nullable_text_columns_to_sale_lines() {
    let (pool, _tokens, _product) = shop_with_one_sale().await;

    let columns = sale_line_columns(&pool).await;
    for name in ["warranty_start", "warranty_end"] {
        let column = columns
            .iter()
            .find(|(column, _, _)| column == name)
            .unwrap_or_else(|| panic!("0013 must add `{name}` to sale_lines"));
        assert_eq!(
            column.1, "TEXT",
            "{name} is a calendar day (D8), not epoch milliseconds"
        );
        assert_eq!(
            column.2, 0,
            "{name} is NULL when the operator gave no warranty"
        );
    }
}

#[tokio::test]
async fn a_sale_recorded_without_warranty_dates_leaves_both_columns_null() {
    // The ordinary sale: most lines have no warranty at all, and a column that
    // defaulted to a date would invent a warranty nobody sold.
    let (pool, _tokens, _product) = shop_with_one_sale().await;

    let stored: (Option<String>, Option<String>) =
        sqlx::query_as("SELECT warranty_start, warranty_end FROM sale_lines LIMIT 1")
            .fetch_one(&pool)
            .await
            .expect("the sale line");
    assert_eq!(stored, (None, None));
}

#[tokio::test]
async fn the_table_refuses_a_warranty_date_that_is_not_iso_shaped() {
    let (pool, _tokens, _product) = shop_with_one_sale().await;

    // Whatever wrote the row, not just this service. `2026-2-3` is the shape a
    // typist produces and the shape no reader can parse back unambiguously.
    for malformed in ["2026-2-3", "15-03-2026", "2026/03/15", "", "today", "2026-03-15 "]
    {
        let written = sqlx::query("UPDATE sale_lines SET warranty_start = ?1")
            .bind(malformed)
            .execute(&pool)
            .await;
        assert!(
            written.is_err(),
            "{malformed:?} must be refused by the table itself"
        );
    }
}

#[tokio::test]
async fn the_table_refuses_a_warranty_range_that_ends_before_it_starts() {
    let (pool, _tokens, _product) = shop_with_one_sale().await;

    let backwards = sqlx::query(
        "UPDATE sale_lines SET warranty_start = '2027-03-15', warranty_end = '2027-03-14'",
    )
    .execute(&pool)
    .await;
    assert!(
        backwards.is_err(),
        "a warranty that ended before it began must never be stored"
    );

    // And the same rule on the way in, not only on the way to an edit.
    let sale_id: String = sqlx::query_scalar("SELECT id FROM sales LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("a sale");
    let product_id: String = sqlx::query_scalar("SELECT product_id FROM sale_lines LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("a line");
    let inserted = sqlx::query(
        "INSERT INTO sale_lines
           (id, sale_id, line_no, product_id, product_name, disposition, quantity,
            unit_selling_price_minor, line_total_minor, line_cost_minor, cost_method,
            warranty_start, warranty_end)
         VALUES (?1, ?2, 99, ?3, 'Test Widget', 'quantity', 1, 150, 150, 100,
                 'moving_average', '2027-03-15', '2027-03-14')",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&sale_id)
    .bind(&product_id)
    .execute(&pool)
    .await;
    assert!(inserted.is_err(), "the range rule holds on insert too");
}

#[tokio::test]
async fn the_table_accepts_a_whole_range_and_either_open_end() {
    let (pool, _tokens, _product) = shop_with_one_sale().await;

    for (start, end) in [
        (Some("2026-10-12"), Some("2027-10-12")),
        (Some("2028-02-29"), Some("2028-03-01")), // a leap day
        (Some("2026-10-12"), Some("2026-10-12")), // a single day
        (Some("2026-10-12"), None),              // still covered
        (None, Some("2027-10-12")),              // started before this system knew
        (None, None),                            // no warranty at all
    ] {
        let written = sqlx::query(
            "UPDATE sale_lines SET warranty_start = ?1, warranty_end = ?2",
        )
        .bind(start)
        .bind(end)
        .execute(&pool)
        .await;
        assert!(
            written.is_ok(),
            "{start:?}..{end:?} is a legitimate range: {:?}",
            written.err()
        );
    }
}

#[tokio::test]
async fn the_warranty_range_rule_survives_a_leap_day_and_a_century() {
    // The lexicographic comparison the trigger relies on is only date order
    // because every value is ISO-shaped; these are the boundaries where a
    // sloppy shape would sort wrongly.
    let (pool, _tokens, _product) = shop_with_one_sale().await;

    for (start, end) in [
        ("2028-02-29", "2028-03-01"),
        ("2026-12-31", "2027-01-01"),
        ("2026-01-01", "2026-01-02"),
        ("1999-12-31", "2000-02-29"),
    ] {
        let written =
            sqlx::query("UPDATE sale_lines SET warranty_start = ?1, warranty_end = ?2")
                .bind(start)
                .bind(end)
                .execute(&pool)
                .await;
        assert!(written.is_ok(), "{start}..{end} must be accepted");
    }
}