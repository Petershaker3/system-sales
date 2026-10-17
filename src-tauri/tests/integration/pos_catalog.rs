//! The sales screen's catalogue (`pos_catalog`, plan item 1.6).
//!
//! Before this read existed the screen loaded `list_products`, which needs
//! `ManageCatalog`, so a seller could not even see what to sell. These tests
//! hold the new read to its contract: a seller may read it, it carries stock
//! on hand and recent sales, it never carries a cost, and archived products
//! and departments stay out of it.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::{Role, Sensitivity};
use mobile_shop_system_lib::services::catalog::pos;
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales, SaleLineInput};
use sqlx::SqlitePool;

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
    manager: mobile_shop_system_lib::domain::identity::UserId,
}

async fn shop() -> Shop {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");
    Shop {
        pool,
        tokens,
        manager: created.user_id,
    }
}

async fn product(shop: &Shop, name: &str, price: Option<i64>) -> String {
    let ctx = CatalogContext::new(shop.pool.clone(), shop.tokens.clone());
    let session = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session");
    catalog::create(
        &ctx,
        &session,
        NewProduct {
            name: name.to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: price,
            category: None,
        },
    )
    .await
    .expect("product")
    .id
    .as_str()
    .to_string()
}

/// Sign in a seller on the same database, through the real services.
async fn sign_in_seller(shop: &Shop) {
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate the manager");
    let manager = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("manager session");
    let seller = users::create_user(&shop.pool, &manager, "Youssef", "youssef", Role::Sales, PASSWORD)
        .await
        .expect("a seller");
    auth::login(&shop.pool, shop.tokens.as_ref(), seller, PASSWORD)
        .await
        .expect("login as the seller");
}

#[tokio::test]
async fn a_seller_can_read_what_to_sell_with_stock_on_hand() {
    let shop = shop().await;
    let charger = product(&shop, "Charger", Some(15000)).await;
    let _cable = product(&shop, "Cable", Some(5000)).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &charger,
        7,
        9000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive");

    sign_in_seller(&shop).await;
    let read = pos::read(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("a seller may read the sales catalogue");

    let names: Vec<&str> = read.products.iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names, vec!["Cable", "Charger"], "alphabetical");
    let charger_row = read.products.iter().find(|p| p.id == charger).expect("charger");
    assert_eq!(charger_row.on_hand, 7);
    assert_eq!(charger_row.sale_price_minor, Some(15000));
    let cable_row = read.products.iter().find(|p| p.name == "Cable").expect("cable");
    assert_eq!(cable_row.on_hand, 0, "never received reads as zero");
}

#[tokio::test]
async fn the_catalogue_counts_recent_sales_for_ordering() {
    let shop = shop().await;
    let charger = product(&shop, "Charger", Some(15000)).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &charger,
        5,
        9000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive");
    sales::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: charger.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
        }],
        None,
    )
    .await
    .expect("sell two");

    let read = pos::read(&shop.pool, shop.tokens.as_ref()).await.expect("read");
    let row = read.products.iter().find(|p| p.id == charger).expect("charger");
    assert_eq!(row.sold_recently, 2);
    assert_eq!(row.on_hand, 3);
}

#[tokio::test]
async fn archived_products_and_departments_stay_out() {
    let shop = shop().await;
    let kept = product(&shop, "Kept", Some(100)).await;
    let gone = product(&shop, "Gone", Some(100)).await;
    sqlx::query("UPDATE products SET status = 'archived' WHERE id = ?1")
        .bind(&gone)
        .execute(&shop.pool)
        .await
        .expect("archive one product");
    for (name, status, order) in [("Phones", "active", 2i64), ("Old", "archived", 0), ("Cases", "active", 1)] {
        sqlx::query(
            "INSERT INTO departments
               (id, name, status, cost_method, vat_enabled, vat_rate_bp, vat_inclusive,
                sort_order, created_by, updated_by, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'moving_average', 0, NULL, 0, ?4, ?5, ?5, 0, 0)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(name)
        .bind(status)
        .bind(order)
        .bind(shop.manager.as_str())
        .execute(&shop.pool)
        .await
        .expect("a department");
    }

    let read = pos::read(&shop.pool, shop.tokens.as_ref()).await.expect("read");
    assert_eq!(read.products.len(), 1);
    assert_eq!(read.products[0].id, kept);
    let departments: Vec<&str> = read.categories.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(departments, vec!["Cases", "Phones"], "active only, in the owner's order");
}

#[tokio::test]
async fn reading_needs_a_signed_in_operator() {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = InMemoryTokenStore::new();
    let refused = pos::read(&pool, &tokens).await;
    assert!(refused.is_err(), "nobody is signed in, so nothing is read");
}
