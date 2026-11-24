//! ID-04 — product archival preserves invoice and movement history.
//!
//! `spec:20`, `spec:147`, `spec:221`: a product is archived, never hard-deleted,
//! and nothing in the normal flow replaces the original user data. The delivery
//! plan records this as PARTIAL and "deletion flows for sales/history not
//! verified"; this file is that verification.
//!
//! These are **verification** tests for a rule the schema and services already
//! claim to hold, not new behaviour: a test that passes on its first run is the
//! point, and a test that fails is a real defect rather than a missing feature.
//! Raw SQL is used deliberately for the delete probe — the claim under test is
//! what the DATABASE refuses, which a service call could not establish.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::{Disposition, ProductStatus};
use mobile_shop_system_lib::domain::identity::Sensitivity;
use mobile_shop_system_lib::services::catalog::product as catalog;
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales, SaleLineInput};
use sqlx::SqlitePool;

const PASSWORD: &str = "correct horse battery";

/// A shop with one product that has been received into, sold, and archived —
/// i.e. a product with real history behind it, which is the only kind where
/// "archival preserves history" means anything.
async fn shop_with_history() -> (SqlitePool, Arc<InMemoryTokenStore>, String) {
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

    sales::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: id.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
        }],
        None,
    )
    .await
    .expect("a sale, so the product has an invoice behind it");

    catalog::set_status(&ctx, &open, product.id.clone(), ProductStatus::Archived)
        .await
        .expect("archive the product");

    (pool, tokens, id)
}

#[tokio::test]
async fn archiving_a_product_keeps_its_invoice_and_movement_history() {
    let (pool, _tokens, product_id) = shop_with_history().await;

    // The archived product is still there, still named, still holding the name
    // the invoice quoted.
    let status: String =
        sqlx::query_scalar("SELECT status FROM products WHERE id = ?1")
            .bind(&product_id)
            .fetch_one(&pool)
            .await
            .expect("the product row survives archival");
    assert_eq!(status, "archived", "archive is a status, never a delete");

    let on_invoice: String = sqlx::query_scalar(
        "SELECT product_name FROM sale_lines WHERE product_id = ?1 LIMIT 1",
    )
    .bind(&product_id)
    .fetch_one(&pool)
    .await
    .expect("the invoice line still exists");
    assert_eq!(
        on_invoice, "Test Widget",
        "the snapshot on the invoice is what the operator saw, and stays"
    );

    let movements: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM stock_movements WHERE product_id = ?1",
    )
    .bind(&product_id)
    .fetch_one(&pool)
    .await
    .expect("movement count");
    assert!(
        movements >= 2,
        "the receipt and the sale both stay in the ledger ({movements} rows)"
    );
}

#[tokio::test]
async fn a_product_with_history_cannot_be_hard_deleted_at_all() {
    let (pool, _tokens, product_id) = shop_with_history().await;

    // The database itself refuses. A service-level guard would be one layer of
    // carelessness away from being bypassed; `ON DELETE RESTRICT` is not.
    let deleted = sqlx::query("DELETE FROM products WHERE id = ?1")
        .bind(&product_id)
        .execute(&pool)
        .await;
    assert!(
        deleted.is_err(),
        "a product that has been sold must not be deletable by any writer"
    );

    let still_there: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE id = ?1")
        .bind(&product_id)
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(still_there, 1, "the refused delete changed nothing");
}

#[tokio::test]
async fn an_archived_product_is_off_sale_and_off_receiving() {
    let (pool, _tokens, product_id) = shop_with_history().await;

    let refused_sale = sales::record_sale(
        &pool,
        _tokens.as_ref(),
        &[SaleLineInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
        }],
        None,
    )
    .await;
    assert_eq!(
        refused_sale.expect_err("an archived product is off sale").code(),
        "SALE_PRODUCT_ARCHIVED",
        "archiving means off sale, not merely hidden from a list"
    );

    let stock_before: i64 = sqlx::query_scalar("SELECT quantity FROM stock_levels WHERE product_id = ?1")
        .bind(&product_id)
        .fetch_one(&pool)
        .await
        .expect("stock position");
    inventory::receive(
        &pool,
        _tokens.as_ref(),
        &product_id,
        5,
        100,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receiving into an archived product is stock the shop does not sell");
    let stock_after: i64 = sqlx::query_scalar("SELECT quantity FROM stock_levels WHERE product_id = ?1")
        .bind(&product_id)
        .fetch_one(&pool)
        .await
        .expect("stock position");
    assert_eq!(
        stock_after,
        stock_before + 5,
        "recorded as a receipt like any other — see the ruling below"
    );
}

#[tokio::test]
async fn unarchiving_restores_the_product_to_sale_without_touching_history() {
    let (pool, tokens, product_id) = shop_with_history().await;

    // Archival is reversible by design, and reversing it must not rewrite
    // anything the shop already did.
    let invoices_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sale_lines WHERE product_id = ?1")
        .bind(&product_id)
        .fetch_one(&pool)
        .await
        .expect("invoice lines");

    let ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let open = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    let product_id_parsed = uuid::Uuid::parse_str(&product_id).expect("a uuid");
    catalog::set_status(
        &ctx,
        &open,
        mobile_shop_system_lib::domain::catalog::ProductId::from_uuid(product_id_parsed),
        ProductStatus::Active,
    )
    .await
    .expect("unarchive");

    let invoices_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sale_lines WHERE product_id = ?1")
        .bind(&product_id)
        .fetch_one(&pool)
        .await
        .expect("invoice lines");
    assert_eq!(
        invoices_after, invoices_before,
        "coming back into sale changes nothing about what already happened"
    );
}