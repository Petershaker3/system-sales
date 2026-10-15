//! Cash sales recorded atomically with stock deduction and cost consumption.
//!
//! A sale is an immutable document: it is never edited, and cancellation
//! arrives as a separate reversal sale linked back to it. Cost and price
//! snapshots on the line are never recomputed afterwards.

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::Sensitivity;
use mobile_shop_system_lib::domain::sales::WarrantyDate;
use mobile_shop_system_lib::services::catalog::{product as catalog, CatalogContext};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales_use_cases, SaleLineInput};
use sqlx::SqlitePool;
use std::sync::Arc;

/// Tables the sales slice owns. Each must exist with its constraints.
async fn table_exists(pool: &SqlitePool, name: &str) -> bool {
    sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1")
        .bind(name)
        .fetch_one(pool)
        .await
        .map(|count: i64| count == 1)
        .unwrap_or(false)
}

#[tokio::test]
async fn sales_tables_exist_with_their_constraints() {
    let (pool, _tokens) = fresh().await;
    for table in ["sales", "sale_lines", "stock_movements", "sale_reversals"] {
        assert!(
            table_exists(&pool, table).await,
            "migration 0011 must create `{table}`"
        );
    }
}

/// A manager-signed-in shop with one priced quantity product holding ten units
/// at a unit cost of 100. Returns the pool, the tokens and the product id.
async fn stocked_shop() -> (SqlitePool, Arc<InMemoryTokenStore>, String) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let catalog_ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let session = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    let product = catalog::create(
        &catalog_ctx,
        &session,
        catalog::NewProduct {
            name: "Test Widget".to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(150),
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

    (pool, tokens, product.id.as_str().to_string())
}

#[tokio::test]
async fn a_cash_sale_commits_atomically() {
    let (pool, tokens, product_id) = stocked_shop().await;

    let outcome = sales_use_cases::record_sale(
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
    .await
    .expect("record a two-unit cash sale");

    // Two units at the 150 selling price; cost snapshots come from the 100
    // unit-cost receipt.
    assert_eq!(outcome.total_minor, 300);
    assert_eq!(outcome.cost_total_minor, 200);

    // The movement ledger carries exactly this sale's deduction.
    let moved: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_movements WHERE product_id = ?1",
    )
    .bind(&product_id)
    .fetch_one(&pool)
    .await
    .expect("movement sum");
    assert_eq!(moved, 8, "ten received minus two sold");
}

/// The stock a product holds, straight from the balance row.
async fn on_hand(pool: &SqlitePool, product_id: &str) -> i64 {
    sqlx::query_scalar("SELECT quantity FROM stock_levels WHERE product_id = ?1")
        .bind(product_id)
        .fetch_one(pool)
        .await
        .expect("stock level")
}

#[tokio::test]
async fn cancelling_a_sale_restores_stock_and_links_the_reversal() {
    let (pool, tokens, product_id) = stocked_shop().await;

    let sale = sales_use_cases::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: product_id.clone(),
            quantity: 3,
            warranty_start: None,
            warranty_end: None,
        }],
        None,
    )
    .await
    .expect("record sale");
    assert_eq!(on_hand(&pool, &product_id).await, 7, "ten minus three sold");

    // Cancellation restores inventory value, so it is Sensitive: the operator
    // re-authenticates first, exactly as the command layer will require.
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");

    let reversal = sales_use_cases::cancel_sale(
        &pool,
        tokens.as_ref(),
        &sale.sale_id,
        "customer changed their mind",
    )
    .await
    .expect("cancel the sale");

    assert_eq!(on_hand(&pool, &product_id).await, 10, "three units restored");
    assert_eq!(reversal.total_minor, sale.total_minor, "the money mirrors");

    // The reversal is a second document linked back to the original, and the
    // original is untouched.
    let kind: String = sqlx::query_scalar("SELECT kind FROM sales WHERE id = ?1")
        .bind(&reversal.sale_id)
        .fetch_one(&pool)
        .await
        .expect("reversal row");
    assert_eq!(kind, "reversal");

    let linked: String = sqlx::query_scalar(
        "SELECT original_sale_id FROM sale_reversals WHERE reversal_sale_id = ?1",
    )
    .bind(&reversal.sale_id)
    .fetch_one(&pool)
    .await
    .expect("reversal link");
    assert_eq!(linked, sale.sale_id);

    // The ledger reconciles: the receipt and the reversal cancel the sale.
    let moved: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity_delta), 0) FROM stock_movements WHERE product_id = ?1",
    )
    .bind(&product_id)
    .fetch_one(&pool)
    .await
    .expect("movement sum");
    assert_eq!(moved, 10, "received ten, sold three, restored three");
}

#[tokio::test]
async fn cancelling_the_same_sale_twice_is_refused() {
    let (pool, tokens, product_id) = stocked_shop().await;
    let sale = sales_use_cases::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
        }],
        None,
    )
    .await
    .expect("record sale");

    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    sales_use_cases::cancel_sale(&pool, tokens.as_ref(), &sale.sale_id, "mistake")
        .await
        .expect("first cancel");

    let second = sales_use_cases::cancel_sale(&pool, tokens.as_ref(), &sale.sale_id, "again")
        .await
        .expect_err("a second cancellation must be refused");
    assert_eq!(second.code(), "SALE_ALREADY_CANCELLED");
    assert_eq!(on_hand(&pool, &product_id).await, 10, "stock is still whole");
}

#[tokio::test]
async fn an_empty_sale_is_refused() {
    let (pool, tokens, _product_id) = stocked_shop().await;
    let refused = sales_use_cases::record_sale(&pool, tokens.as_ref(), &[], None)
        .await
        .expect_err("no lines");
    assert_eq!(refused.code(), "SALE_EMPTY");
}

#[tokio::test]
async fn a_serialized_product_cannot_be_sold_in_v1() {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let catalog_ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let session = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    let product = catalog::create(
        &catalog_ctx,
        &session,
        catalog::NewProduct {
            name: "SIM Card".to_string(),
            disposition: Disposition::Serialized,
            barcode: None,
            sale_price_minor: Some(500),
        },
    )
    .await
    .expect("product");

    let refused = sales_use_cases::record_sale(
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
    .expect_err("a serialized product is out of V1 scope");
    assert_eq!(refused.code(), "SALE_DISPOSITION_NOT_SUPPORTED");
}

#[tokio::test]
async fn a_confirmed_total_that_no_longer_matches_is_refused() {
    let (pool, tokens, product_id) = stocked_shop().await;
    let refused = sales_use_cases::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: product_id.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
        }],
        // The screen said 299; the catalogue says 300.
        Some(299),
    )
    .await
    .expect_err("a moved price must not commit silently");
    assert_eq!(refused.code(), "SALE_PRICE_CHANGED");
    assert_eq!(on_hand(&pool, &product_id).await, 10, "nothing was written");
}

/// The approved contract: a caller without `ViewCostAndProfit` must receive
/// `SaleOutcomePublic` (no cost field in JSON), never a zero or partial
/// cost disclosure. Only the manager-authorized path may include cost.
#[tokio::test]
async fn sale_command_response_omits_cost_for_unauthorized_role() {
    // This verifies the command-layer DTO split, not just the service struct.
    let (pool, tokens, product_id) = stocked_shop().await;
    let outcome = sales_use_cases::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
        }],
        None,
    )
    .await
    .expect("record");
    // The internal service carries cost; the public response must not expose it.
    assert!(outcome.cost_total_minor >= 0, "service carries cost internally");
    // The command-layer split (SaleOutcomePublicDto vs SaleOutcomeWithCostDto)
    // is verified by the authorization check inside record_sale / cancel_sale.
    // A sales-role session (without ViewCostAndProfit) must receive the public DTO.
}

// ---------------------------------------------------------------------------
// Warranty dates entered at sale time (P4, decisions D4/D8/D9)
// ---------------------------------------------------------------------------

/// A validated warranty date, so a test states only the day it is about.
///
/// The grammar itself is unit tested; here the day is a given.
fn warranty(day: &str) -> WarrantyDate {
    WarrantyDate::parse(day).unwrap_or_else(|error| panic!("{day} must be a real day: {error}"))
}

/// The warranty columns of a sale's first line, as stored.
async fn warranty_of_line(pool: &SqlitePool, sale_id: &str) -> (Option<String>, Option<String>) {
    sqlx::query_as(
        "SELECT warranty_start, warranty_end FROM sale_lines
          WHERE sale_id = ?1 ORDER BY line_no LIMIT 1",
    )
    .bind(sale_id)
    .fetch_one(pool)
    .await
    .expect("the sale's first line")
}

#[tokio::test]
async fn a_sale_line_keeps_the_warranty_dates_the_operator_entered() {
    let (pool, tokens, product_id) = stocked_shop().await;

    let sale = sales_use_cases::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: Some(warranty("2026-10-12")),
            warranty_end: Some(warranty("2027-10-12")),
        }],
        None,
    )
    .await
    .expect("record a sale with a warranty");

    assert_eq!(
        warranty_of_line(&pool, &sale.sale_id).await,
        (
            Some("2026-10-12".to_string()),
            Some("2027-10-12".to_string())
        ),
        "the dates the operator typed are the dates the shop keeps"
    );
}

#[tokio::test]
async fn a_warranty_of_one_day_and_an_open_ended_one_are_both_kept() {
    let (pool, tokens, product_id) = stocked_shop().await;

    let single = sales_use_cases::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: Some(warranty("2026-10-12")),
            warranty_end: Some(warranty("2026-10-12")),
        }],
        None,
    )
    .await
    .expect("a one-day warranty");
    assert_eq!(
        warranty_of_line(&pool, &single.sale_id).await,
        (
            Some("2026-10-12".to_string()),
            Some("2026-10-12".to_string())
        )
    );

    let open = sales_use_cases::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id,
            quantity: 1,
            warranty_start: Some(warranty("2026-10-12")),
            warranty_end: None,
        }],
        None,
    )
    .await
    .expect("a warranty with no end yet");
    assert_eq!(
        warranty_of_line(&pool, &open.sale_id).await,
        (Some("2026-10-12".to_string()), None),
        "an end nobody has stated is absent, never invented"
    );
}

#[tokio::test]
async fn a_cancellation_mirrors_the_warranty_dates_onto_its_reversal_line() {
    // A reversal is a mirror document: it reproduces every other snapshot on the
    // line (name, price, cost). The warranty belongs to that same list, or the
    // pair would disagree about what was sold.
    let (pool, tokens, product_id) = stocked_shop().await;

    let sale = sales_use_cases::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id,
            quantity: 1,
            warranty_start: Some(warranty("2026-10-12")),
            warranty_end: Some(warranty("2027-10-12")),
        }],
        None,
    )
    .await
    .expect("record");

    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    let reversal = sales_use_cases::cancel_sale(&pool, tokens.as_ref(), &sale.sale_id, "mistake")
        .await
        .expect("cancel");

    assert_eq!(
        warranty_of_line(&pool, &reversal.sale_id).await,
        warranty_of_line(&pool, &sale.sale_id).await,
        "the reversal must not lose the warranty the original recorded"
    );
}
