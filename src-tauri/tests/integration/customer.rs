//! Customer file core: record identity without merging.
//!
//! `spec:178` (no two similar names merged, explicit link only) and `spec:179`
//! (name + one optional contact). Service-layer permission split (sales may
//! create, only managers browse) and the sale-link command arrive in the next
//! slice; this file pins the storage and domain contract first.

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::customer as repo;
use mobile_shop_system_lib::domain::customer::{Customer, CustomerError, NewCustomer};
use mobile_shop_system_lib::domain::identity::{Timestamp, UserId};
use mobile_shop_system_lib::services::identity::{auth, bootstrap};

async fn manager_ctx(
    pool: &sqlx::SqlitePool,
    tokens: &std::sync::Arc<
        mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore,
    >,
) -> (UserId, Timestamp) {
    let created = bootstrap::create_first_manager(pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");
    let session =
        mobile_shop_system_lib::services::identity::session::resolve(pool, tokens.as_ref())
            .await
            .expect("session");
    (session.user_id(), Timestamp::now())
}

fn customer(id: &str, name: &str, by: UserId, at: Timestamp) -> Customer {
    Customer {
        id: id.to_string(),
        name: name.to_string(),
        contact: None,
        archived: false,
        created_by: by,
        created_at: at,
        updated_at: at,
    }
}

#[tokio::test]
async fn migration_0012_creates_customers_and_sale_link_columns() {
    let (pool, _tokens) = fresh().await;
    for table in ["customers"] {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .expect("table probe");
        assert_eq!(count, 1, "migration 0012 must create `{table}`");
    }
    let cols: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('sales')")
            .fetch_all(&pool)
            .await
            .expect("sales columns");
    for col in ["customer_id", "customer_name_snapshot"] {
        assert!(
            cols.iter().any(|c| c == col),
            "migration 0012 must add `sales.{col}`"
        );
    }
}

#[tokio::test]
async fn insert_and_find_round_trip() {
    let (pool, tokens) = fresh().await;
    let (by, at) = manager_ctx(&pool, &tokens).await;
    let mut conn = pool.acquire().await.expect("connection");
    let expected = customer(&uuid::Uuid::now_v7().to_string(), "Ahmed Hassan", by, at);
    repo::insert(&mut *conn, &expected).await.expect("insert");
    let found = repo::find_by_id(&mut *conn, &expected.id)
        .await
        .expect("find")
        .expect("row present");
    assert_eq!(found, expected);
}

#[tokio::test]
async fn similar_names_stay_separate_records() {
    let (pool, tokens) = fresh().await;
    let (by, at) = manager_ctx(&pool, &tokens).await;
    let mut conn = pool.acquire().await.expect("connection");
    for name in ["Ahmed Hassan", "Ahmed H."] {
        let row = customer(&uuid::Uuid::now_v7().to_string(), name, by, at);
        repo::insert(&mut *conn, &row).await.expect("insert");
    }
    let listed = repo::list_unarchived(&mut *conn).await.expect("list");
    assert_eq!(listed.len(), 2, "similar names must not merge");
    assert_ne!(listed[0].id, listed[1].id);
}

#[tokio::test]
async fn empty_name_is_refused_before_storage() {
    let bad = NewCustomer {
        name: "   ".to_string(),
        contact: None,
    };
    assert_eq!(bad.cleaned().unwrap_err(), CustomerError::NameInvalid);
}

// ---------------------------------------------------------------------------
// Explicit sale links (CUST-05, spec:178)
// ---------------------------------------------------------------------------

use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::Sensitivity;
use mobile_shop_system_lib::domain::sales::SaleError;
use mobile_shop_system_lib::services::catalog::{product as catalog, CatalogContext};
use mobile_shop_system_lib::services::customer as customer_service;
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{
    self as sales_service, SaleLineInput,
};

/// A shop with one priced quantity product holding stock, plus one recorded
/// one-unit sale. Returns pool, tokens, sale id.
async fn shop_with_sale() -> (
    sqlx::SqlitePool,
    std::sync::Arc<
        mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore,
    >,
    String,
) {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");
    let catalog_ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let session =
        mobile_shop_system_lib::services::identity::session::resolve(&pool, tokens.as_ref())
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
    let outcome = sales_service::record_sale(
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
    .expect("sale");
    (pool, tokens, outcome.sale_id)
}

async fn make_customer(
    pool: &sqlx::SqlitePool,
    tokens: &std::sync::Arc<
        mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore,
    >,
    name: &str,
) -> Customer {
    customer_service::create(
        pool,
        tokens.as_ref(),
        NewCustomer {
            name: name.to_string(),
            contact: None,
        },
    )
    .await
    .expect("customer")
}

#[tokio::test]
async fn a_sale_links_to_a_live_customer_exactly_once() {
    let (pool, tokens, sale_id) = shop_with_sale().await;
    let customer = make_customer(&pool, &tokens, "Laila Mostafa").await;
    sales_service::link_sale_customer(&pool, tokens.as_ref(), &sale_id, &customer.id)
        .await
        .expect("link");
    let linked: Option<String> =
        sqlx::query_scalar("SELECT customer_id FROM sales WHERE id = ?1")
            .bind(&sale_id)
            .fetch_one(&pool)
            .await
            .expect("link state");
    assert_eq!(linked.as_deref(), Some(customer.id.as_str()));
    let again =
        sales_service::link_sale_customer(&pool, tokens.as_ref(), &sale_id, &customer.id)
            .await;
    assert!(
        matches!(
            again,
            Err(
                mobile_shop_system_lib::services::sales::SaleServiceError::Sale(
                    SaleError::CustomerAlreadyLinked
                )
            )
        ),
        "a second link must be refused, not rewritten"
    );
}

#[tokio::test]
async fn a_snapshot_lives_only_on_an_unlinked_sale() {
    let (pool, tokens, sale_id) = shop_with_sale().await;
    sales_service::set_sale_customer_name(&pool, tokens.as_ref(), &sale_id, "Walk-in buyer")
        .await
        .expect("snapshot");
    let stored: Option<String> =
        sqlx::query_scalar("SELECT customer_name_snapshot FROM sales WHERE id = ?1")
            .bind(&sale_id)
            .fetch_one(&pool)
            .await
            .expect("snapshot state");
    assert_eq!(stored.as_deref(), Some("Walk-in buyer"));
    let customer = make_customer(&pool, &tokens, "Nadia Adel").await;
    sales_service::link_sale_customer(&pool, tokens.as_ref(), &sale_id, &customer.id)
        .await
        .expect("link after snapshot");
    let late = sales_service::set_sale_customer_name(
        &pool,
        tokens.as_ref(),
        &sale_id,
        "Someone else",
    )
    .await;
    assert!(
        matches!(
            late,
            Err(
                mobile_shop_system_lib::services::sales::SaleServiceError::Sale(
                    SaleError::CustomerAlreadyLinked
                )
            )
        ),
        "a linked sale keeps its relation; no shadowing snapshot"
    );
}

#[tokio::test]
async fn linking_an_unknown_or_archived_customer_fails_closed() {
    let (pool, tokens, sale_id) = shop_with_sale().await;
    let unknown = sales_service::link_sale_customer(
        &pool,
        tokens.as_ref(),
        &sale_id,
        &uuid::Uuid::now_v7().to_string(),
    )
    .await;
    assert!(
        matches!(
            unknown,
            Err(
                mobile_shop_system_lib::services::sales::SaleServiceError::Customer(
                    CustomerError::NotFound
                )
            )
        ),
        "unknown customer must fail closed"
    );
    let customer = make_customer(&pool, &tokens, "Omar Sherif").await;
    customer_service::archive(&pool, tokens.as_ref(), &customer.id)
        .await
        .expect("archive");
    let archived_link =
        sales_service::link_sale_customer(&pool, tokens.as_ref(), &sale_id, &customer.id)
            .await;
    assert!(
        matches!(
            archived_link,
            Err(
                mobile_shop_system_lib::services::sales::SaleServiceError::Customer(
                    CustomerError::IsArchived
                )
            )
        ),
        "archived customer must fail closed"
    );
    let still: Option<String> =
        sqlx::query_scalar("SELECT customer_id FROM sales WHERE id = ?1")
            .bind(&sale_id)
            .fetch_one(&pool)
            .await
            .expect("link state");
    assert_eq!(still, None, "refused links write nothing");
}
