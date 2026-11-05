//! A selling price decided at the counter (`0035`, §6.1).
//!
//! Two answers, never a silent third one:
//!
//! * **the model's price** — the ordinary sale, no decision taken;
//! * **this invoice only** — a number typed by a session that may manage the
//!   catalogue, written on `sale_lines` and on nothing else.
//!
//! The claims this file proves against real SQLite:
//!
//! 1. a one-time price is used by that invoice and by no other one;
//! 2. it never writes the model's price — «this sale only» means exactly that;
//! 3. changing the model's price afterwards never rewrites an invoice already
//!    recorded, its cost, or its profit: `sale_lines` is the snapshot;
//! 4. a product with no price is refused until somebody decides, and the
//!    decision for one invoice does not become the next one's default.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::{Disposition, ProductId};
use mobile_shop_system_lib::domain::identity::{Sensitivity, UserId};
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct, ProductPatch};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{
    self as sales_service, SaleError, SaleLineInput, SaleLineWithUnitInput, SaleServiceError,
};
use sqlx::SqlitePool;

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
    owner: UserId,
}

/// A signed-in manager with a catalogue, and nothing else.
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
        owner: created.user_id,
    }
}

/// Create a product and put `on_hand` pieces of it on the shelf at `cost_minor`.
async fn stocked_product(
    shop: &Shop,
    name: &str,
    sale_price_minor: Option<i64>,
    on_hand: i64,
    cost_minor: i64,
) -> String {
    let ctx = CatalogContext::new(shop.pool.clone(), shop.tokens.clone());
    let current = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session");
    let created = catalog::create(
        &ctx,
        &current,
        NewProduct {
            name: name.to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor,
            category: None,
        },
    )
    .await
    .expect("create product");
    let id = created.id.as_str().to_string();
    if on_hand > 0 {
        inventory::receive(
            &shop.pool,
            shop.tokens.as_ref(),
            &id,
            on_hand,
            cost_minor,
            Sensitivity::Routine,
            None,
        )
        .await
        .expect("receive stock");
    }
    id
}

/// The model's own price: `None` is «not set», which is not zero.
async fn model_price(shop: &Shop, product_id: &str) -> Option<i64> {
    sqlx::query_scalar("SELECT sale_price_minor FROM products WHERE id = ?1")
        .bind(product_id)
        .fetch_one(&shop.pool)
        .await
        .expect("the model's price")
}

/// `(unit_selling_price_minor, unit_cost_minor, line_total_minor)` per line.
async fn invoice_lines(shop: &Shop, sale_id: &str) -> Vec<(i64, i64, i64)> {
    sqlx::query_as(
        "SELECT unit_selling_price_minor, unit_cost_minor, line_total_minor
           FROM sale_lines WHERE sale_id = ?1 ORDER BY line_total_minor DESC",
    )
    .bind(sale_id)
    .fetch_all(&shop.pool)
    .await
    .expect("invoice lines")
}

fn one_line(product_id: &str, quantity: i64) -> Vec<SaleLineWithUnitInput> {
    vec![SaleLineWithUnitInput {
        product_id: product_id.to_string(),
        quantity,
        warranty_start: None,
        warranty_end: None,
        imei: None,
    }]
}

async fn sell(
    shop: &Shop,
    product_id: &str,
    quantity: i64,
    override_minor: Option<i64>,
) -> Result<sales_service::SaleOutcome, SaleServiceError> {
    sales_service::record_sale_with_line_prices(
        &shop.pool,
        shop.tokens.as_ref(),
        &one_line(product_id, quantity),
        None,
        None,
        None,
        0,
        &[0],
        &[override_minor],
    )
    .await
}

#[tokio::test]
async fn a_price_typed_for_one_invoice_applies_to_that_invoice_and_no_other() {
    let shop = shop().await;
    let phone = stocked_product(&shop, "Galaxy A16", Some(100_000), 3, 60_000).await;

    // The shop sells one at 650,000 — a phone whose shelf price has not been
    // updated yet, priced in front of the customer.
    let first = sell(&shop, &phone, 1, Some(650_000))
        .await
        .expect("one-time price");
    assert_eq!(first.total_minor, 650_000);
    assert_eq!(first.cost_total_minor, 60_000);
    assert_eq!(
        invoice_lines(&shop, &first.sale_id).await,
        vec![(650_000, 60_000, 650_000)],
        "the invoice keeps the price that was typed on it"
    );
    assert_eq!(
        model_price(&shop, &phone).await,
        Some(100_000),
        "«this invoice only» writes nothing on the model"
    );

    // The next sale asks again; nobody's one-off became the default.
    let second = sell(&shop, &phone, 1, None)
        .await
        .expect("ordinary sale at the model price");
    assert_eq!(second.total_minor, 100_000);
    assert_eq!(invoice_lines(&shop, &second.sale_id).await, vec![(100_000, 60_000, 100_000)]);
}

#[tokio::test]
async fn changing_the_model_price_never_rewrites_an_invoice_already_recorded() {
    let shop = shop().await;
    let phone = stocked_product(&shop, "Galaxy A16", Some(100_000), 3, 60_000).await;

    let past = sell(&shop, &phone, 1, None).await.expect("sale at 100,000");
    assert_eq!(past.total_minor, 100_000);

    // The owner raises the model's price. Nothing about the recorded invoice may
    // move: its price, its cost and therefore its gross profit are history.
    let ctx = CatalogContext::new(shop.pool.clone(), shop.tokens.clone());
    let current = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session");
    catalog::update(
        &ctx,
        &current,
        ProductId::from_uuid(uuid::Uuid::parse_str(&phone).expect("uuid")),
        ProductPatch {
            sale_price_minor: Some(Some(250_000)),
            ..ProductPatch::default()
        },
    )
    .await
    .expect("raise the model price");

    assert_eq!(model_price(&shop, &phone).await, Some(250_000));
    assert_eq!(
        invoice_lines(&shop, &past.sale_id).await,
        vec![(100_000, 60_000, 100_000)],
        "the old invoice still holds 100,000 — a past sale is not repriced"
    );
    assert_eq!(
        past.total_minor - past.cost_total_minor,
        40_000,
        "the profit it made stays the profit it made"
    );

    // A new sale uses the new price, which is the only thing a price edit changes.
    let next = sell(&shop, &phone, 1, None).await.expect("sale at the new price");
    assert_eq!(next.total_minor, 250_000);

    // The price change is attributable, not silent: it lands in the price
    // history with the old and the new number (`0006`).
    let changes: Vec<(Option<i64>, Option<i64>)> = sqlx::query_as(
        "SELECT old_price_minor, new_price_minor FROM product_price_history
          WHERE product_id = ?1 ORDER BY occurred_at DESC, id DESC",
    )
    .bind(&phone)
    .fetch_all(&shop.pool)
    .await
    .expect("price history");
    assert_eq!(
        changes.first().copied(),
        Some((Some(100_000), Some(250_000))),
        "the history says what the price was and what it became"
    );
}

#[tokio::test]
async fn a_product_with_no_price_is_refused_until_somebody_decides() {
    let shop = shop().await;
    // Received without a selling price: `NULL`, not zero (`0035` §6.5).
    let phone = stocked_product(&shop, "Galaxy A34", None, 2, 500_000).await;
    assert_eq!(model_price(&shop, &phone).await, None);

    let refused = sell(&shop, &phone, 1, None).await;
    assert!(
        matches!(
            refused,
            Err(SaleServiceError::Sale(SaleError::PriceNotSet))
                | Err(SaleServiceError::Catalog(_))
        ),
        "a sale with no price anywhere must be refused, not given one"
    );
    assert_eq!(
        model_price(&shop, &phone).await,
        None,
        "a refused sale leaves the price unset"
    );

    // «This sale only» is a decision, and it is enough for one invoice.
    let sold = sell(&shop, &phone, 1, Some(600_000))
        .await
        .expect("priced at the counter");
    assert_eq!(sold.total_minor, 600_000);
    assert_eq!(
        model_price(&shop, &phone).await,
        None,
        "the one-off decision did not become the model's price"
    );

    // And the next sale still needs its own decision.
    assert!(sell(&shop, &phone, 1, None).await.is_err());
    let again = sell(&shop, &phone, 1, Some(610_000))
        .await
        .expect("a second decision");
    assert_eq!(again.total_minor, 610_000);
}

#[tokio::test]
async fn a_sale_confirmed_at_a_different_total_is_refused_rather_than_repriced() {
    let shop = shop().await;
    let phone = stocked_product(&shop, "Galaxy A16", Some(100_000), 2, 60_000).await;

    let lines = one_line(&phone, 1);
    let refused = sales_service::record_sale_with_line_prices(
        &shop.pool,
        shop.tokens.as_ref(),
        &lines,
        // The operator confirmed 99,000, but the invoice computes 100,000: the
        // sale is refused instead of quietly charging a price nobody agreed to.
        Some(99_000),
        None,
        None,
        0,
        &[0],
        &[None],
    )
    .await;
    assert!(refused.is_err(), "a confirmed total that disagrees is a refusal");

    let position: (i64,) =
        sqlx::query_as("SELECT quantity FROM stock_levels WHERE product_id = ?1")
            .bind(&phone)
            .fetch_one(&shop.pool)
            .await
            .expect("position");
    assert_eq!(position.0, 2, "the refusal consumed nothing");
}

#[tokio::test]
async fn a_plain_sale_line_input_still_takes_the_model_price() {
    let shop = shop().await;
    let phone = stocked_product(&shop, "Galaxy A16", Some(100_000), 2, 60_000).await;

    let sale = sales_service::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: phone.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
        }],
        Some(200_000),
    )
    .await
    .expect("two at the model price");
    assert_eq!(sale.total_minor, 200_000);
    assert_eq!(model_price(&shop, &phone).await, Some(100_000));
}
