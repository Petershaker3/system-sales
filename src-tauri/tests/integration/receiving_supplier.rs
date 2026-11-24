//! Migration `0014` and receiving with a supplier (P4b, decision D1).
//!
//! Raw SQL for the schema claims — the claim under test IS the schema, so
//! writing through the service would test the service instead. The receiving
//! service tests live at the bottom of this file, where they can prove the
//! operator's name actually reaches the ledger row.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::Sensitivity;
use mobile_shop_system_lib::domain::supplier::SupplierName;
use mobile_shop_system_lib::services::catalog::{product as catalog, CatalogContext};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use sqlx::SqlitePool;

const PASSWORD: &str = "correct horse battery";

/// A shop with one priced, quantity-tracked product.
async fn shop() -> (SqlitePool, Arc<InMemoryTokenStore>, String) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let catalog_ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let open = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    let product = catalog::create(
        &catalog_ctx,
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

    (pool, tokens, product.id.as_str().to_string())
}

/// The supplier on the most recent receipt for this product.
async fn last_receipt_supplier(pool: &SqlitePool, product_id: &str) -> Option<String> {
    sqlx::query_scalar(
        "SELECT supplier_name FROM stock_movements
          WHERE product_id = ?1 AND kind = 'receipt'
          ORDER BY occurred_at DESC, id DESC LIMIT 1",
    )
    .bind(product_id)
    .fetch_one(pool)
    .await
    .expect("a receipt movement")
}

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------

#[tokio::test]
async fn migration_0014_adds_one_nullable_supplier_column_to_stock_movements() {
    let (pool, _tokens, _product) = shop().await;

    let columns: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT name, type, [notnull] FROM pragma_table_info('stock_movements')")
            .fetch_all(&pool)
            .await
            .expect("stock_movements columns");
    let supplier = columns
        .iter()
        .find(|(name, _, _)| name == "supplier_name")
        .expect("0014 must add supplier_name to stock_movements");
    assert_eq!(supplier.1, "TEXT", "a supplier is a label the operator typed");
    assert_eq!(supplier.2, 0, "no supplier is NULL, never an empty string");
}

#[tokio::test]
async fn a_movement_that_is_not_a_receipt_may_not_name_a_supplier() {
    let (pool, tokens, product_id) = shop().await;
    inventory::receive(&pool, tokens.as_ref(), &product_id, 5, 100, Sensitivity::Routine, None)
        .await
        .expect("a receipt to adjust against");

    // An adjustment corrects something already counted. It is not a purchase,
    // so a supplier on it would claim a trade that did not happen.
    let actor: String = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("a user");
    let labelled = sqlx::query(
        "INSERT INTO stock_movements
           (id, product_id, kind, quantity_delta, unit_cost_minor, cost_delta_minor,
            occurred_at, actor_id, supplier_name)
         VALUES (?1, ?2, 'adjustment', 1, 100, 100, 1000, ?3, 'Vodafone')",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&product_id)
    .bind(&actor)
    .execute(&pool)
    .await;
    assert!(
        labelled.is_err(),
        "only a receipt may name a supplier; the table must refuse the rest"
    );
}

#[tokio::test]
async fn the_table_refuses_a_supplier_that_is_empty_or_untrimmed() {
    let (pool, tokens, product_id) = shop().await;
    inventory::receive(&pool, tokens.as_ref(), &product_id, 5, 100, Sensitivity::Routine, None)
        .await
        .expect("a receipt");

    for bad in ["", "   ", "  Vodafone  "] {
        let written = sqlx::query("UPDATE stock_movements SET supplier_name = ?1 WHERE kind = 'receipt'")
            .bind(bad)
            .execute(&pool)
            .await;
        assert!(
            written.is_err(),
            "{bad:?} must be refused: 'no supplier' has exactly one spelling (NULL)"
        );
    }
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_receipt_records_the_supplier_the_operator_typed() {
    let (pool, tokens, product_id) = shop().await;

    inventory::receive(
        &pool,
        tokens.as_ref(),
        &product_id,
        10,
        100,
        Sensitivity::Routine,
        Some(SupplierName::parse("  Vodafone Egypt ").expect("a real supplier")),
    )
    .await
    .expect("receive from a named supplier");

    assert_eq!(
        last_receipt_supplier(&pool, &product_id).await,
        Some("Vodafone Egypt".to_string()),
        "the name the operator typed is the name the ledger keeps, trimmed"
    );
}

#[tokio::test]
async fn a_receipt_without_a_supplier_stores_null_not_an_empty_string() {
    let (pool, tokens, product_id) = shop().await;

    inventory::receive(&pool, tokens.as_ref(), &product_id, 4, 100, Sensitivity::Routine, None)
        .await
        .expect("receive from a supplier nobody named");

    assert_eq!(
        last_receipt_supplier(&pool, &product_id).await,
        None,
        "'no supplier' is NULL, so the derived supplier list never shows a blank"
    );
}

#[tokio::test]
async fn the_supplier_list_is_derived_from_history_rather_than_stored_twice() {
    // D1's shape: no `suppliers` table. The list the shop wants is the distinct
    // names already in the ledger, which is why the column can be a plain label.
    let (pool, tokens, product_id) = shop().await;
    for supplier in ["Vodafone", "Vodafone", "Etisalat"] {
        inventory::receive(
            &pool,
            tokens.as_ref(),
            &product_id,
            1,
            100,
            Sensitivity::Routine,
            Some(SupplierName::parse(supplier).expect("a real supplier")),
        )
        .await
        .expect("receive");
    }

    let distinct: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT supplier_name FROM stock_movements
          WHERE kind = 'receipt' AND supplier_name IS NOT NULL ORDER BY supplier_name",
    )
    .fetch_all(&pool)
    .await
    .expect("the derived supplier list");

    assert_eq!(
        distinct,
        vec!["Etisalat".to_string(), "Vodafone".to_string()],
        "two deliveries from one supplier are one supplier"
    );
    let has_table: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'suppliers'",
    )
    .fetch_one(&pool)
    .await
    .expect("sqlite_master");
    assert_eq!(has_table, 0, "V1 has no counterparty entity (`spec:29`)");
}