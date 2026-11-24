//! XC-11 — no silent drop of a financial transaction (`spec:145`).
//!
//! The plan marks this PARTIAL: "atomicity engine + scenario A2 (injected
//! failure)". The engine exists, but the existing rollback test is **vacuous** —
//! its premise was that receiving into an archived product fails, and that is not
//! true (a receipt into an archived product succeeds, which is a deliberate
//! ruling), so its assertion never ran.
//!
//! These tests inject a real failure **late** in the transaction, after the money
//! and stock rows have already been written, and assert that nothing survives.
//! The injection is a trigger created in the test's own database, so no
//! production code carries a test hook.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::Sensitivity;
use mobile_shop_system_lib::services::catalog::{product as catalog, CatalogContext};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales, SaleLineInput};
use sqlx::SqlitePool;

const PASSWORD: &str = "correct horse battery";

/// A shop with one product holding ten units at a unit cost of 100.
async fn stocked_shop() -> (SqlitePool, Arc<InMemoryTokenStore>, String) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let open = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    let product = catalog::create(
        &ctx,
        &open,
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
    let id = product.id.as_str().to_string();

    inventory::receive(
        &pool,
        tokens.as_ref(),
        &id,
        10,
        100,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receipt");

    (pool, tokens, id)
}

/// Row counts, one literal query each.
///
/// Literals rather than a `format!`-built query: sqlx refuses dynamic SQL, and
/// the convention in this suite is that a table name is never spliced into text.
async fn count_sales(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sales")
        .fetch_one(pool)
        .await
        .expect("counting sales")
}

async fn count_sale_lines(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM sale_lines")
        .fetch_one(pool)
        .await
        .expect("counting sale_lines")
}

async fn count_movements(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM stock_movements")
        .fetch_one(pool)
        .await
        .expect("counting stock_movements")
}

async fn count_audit(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events")
        .fetch_one(pool)
        .await
        .expect("counting audit_events")
}

async fn on_hand(pool: &SqlitePool, product_id: &str) -> i64 {
    sqlx::query_scalar("SELECT quantity FROM stock_levels WHERE product_id = ?1")
        .bind(product_id)
        .fetch_one(pool)
        .await
        .expect("the stock position")
}

/// Refuse every audit row from now on, so the failure lands AFTER the business
/// rows have been written — which is the only point at which a rollback means
/// anything.
async fn inject_audit_failure(pool: &SqlitePool) {
    sqlx::query(
        "CREATE TRIGGER injected_audit_failure BEFORE INSERT ON audit_events
         BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END",
    )
    .execute(pool)
    .await
    .expect("install the injected failure");
}

#[tokio::test]
async fn a_receipt_that_fails_at_its_audit_row_leaves_no_stock_and_no_movement() {
    let (pool, tokens, product_id) = stocked_shop().await;

    let movements_before = count_movements(&pool).await;
    let audit_before = count_audit(&pool).await;
    let on_hand_before = on_hand(&pool, &product_id).await;

    inject_audit_failure(&pool).await;

    let refused = inventory::receive(
        &pool,
        tokens.as_ref(),
        &product_id,
        5,
        100,
        Sensitivity::Routine,
        None,
    )
    .await;
    assert!(refused.is_err(), "the injected failure must reach the caller");

    // Everything or nothing: the position, the ledger row and the audit row
    // agree, and they all agree on "nothing happened".
    assert_eq!(
        on_hand(&pool, &product_id).await,
        on_hand_before,
        "the stock write must roll back with the audit write"
    );
    assert_eq!(
        count_movements(&pool).await,
        movements_before,
        "a movement row must not survive a failed receipt"
    );
    assert_eq!(
        count_audit(&pool).await,
        audit_before,
        "nothing was audited, because nothing was received"
    );
}

#[tokio::test]
async fn a_sale_that_fails_at_its_audit_row_leaves_no_invoice_and_no_stock_movement() {
    let (pool, tokens, product_id) = stocked_shop().await;

    let sales_before = count_sales(&pool).await;
    let lines_before = count_sale_lines(&pool).await;
    let movements_before = count_movements(&pool).await;
    let on_hand_before = on_hand(&pool, &product_id).await;

    inject_audit_failure(&pool).await;

    let refused = sales::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: product_id.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
        }],
        None,
    )
    .await;
    assert!(refused.is_err(), "the injected failure must reach the caller");

    // A dropped sale is the exact failure XC-11 exists to prevent: stock gone,
    // no invoice, no audit. Any one of these four surviving would be the bug.
    assert_eq!(count_sales(&pool).await, sales_before, "no invoice survived");
    assert_eq!(count_sale_lines(&pool).await, lines_before, "no line survived");
    assert_eq!(
        count_movements(&pool).await,
        movements_before,
        "no stock movement survived"
    );
    assert_eq!(
        on_hand(&pool, &product_id).await,
        on_hand_before,
        "the stock deduction rolled back with the invoice"
    );
}

#[tokio::test]
async fn a_failure_partway_through_a_multi_line_sale_leaves_the_whole_sale_undone() {
    // The case that a per-line test cannot reach: the first line's stock is
    // already consumed when the second line fails. A sale is one document, so it
    // must be all of it or none of it.
    let (pool, tokens, product_id) = stocked_shop().await;

    let ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let open = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    let unstocked = catalog::create(
        &ctx,
        &open,
        catalog::NewProduct {
            name: "Never Stocked".to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(150),
            category: None,
        },
    )
    .await
    .expect("a product with no stock at all");

    let on_hand_before = on_hand(&pool, &product_id).await;
    let lines_before = count_sale_lines(&pool).await;

    let refused = sales::record_sale(
        &pool,
        tokens.as_ref(),
        &[
            SaleLineInput {
                product_id: product_id.clone(),
                quantity: 1,
                warranty_start: None,
                warranty_end: None,
            },
            SaleLineInput {
                product_id: unstocked.id.as_str().to_string(),
                quantity: 1,
                warranty_start: None,
                warranty_end: None,
            },
        ],
        None,
    )
    .await;
    assert!(refused.is_err(), "the second line cannot be sold");

    assert_eq!(
        on_hand(&pool, &product_id).await,
        on_hand_before,
        "the FIRST line's stock must be restored when the second line refuses"
    );
    assert_eq!(
        count_sale_lines(&pool).await,
        lines_before,
        "no half-written invoice"
    );
}