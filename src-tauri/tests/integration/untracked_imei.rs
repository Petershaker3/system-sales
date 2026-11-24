//! Untracked stock and IMEI registration (`ADR-019`, `0035`).
//!
//! The one invariant this file exists for:
//!
//!     tracked + untracked == on hand        (for any serial-capable product)
//!     stock_levels.quantity == SUM(stock_movements.quantity_delta)
//!
//! Registering an IMEI is a **re-labelling** of one piece that is already on the
//! shelf, not a receipt: the tracked count goes up by one, the untracked count
//! goes down by one, and neither the quantity nor the inventory value moves. The
//! same rule holds the other way round — selling without an IMEI consumes an
//! untracked piece and never invents a serial number, and only when there is no
//! untracked piece left does the shop retire a registered device (the oldest),
//! which is a record of which serial left the shop, not a guess at the piece
//! that was sold.
//!
//! Everything here runs against real SQLite and reads the tables directly where
//! the claim is about the tables (`spec:138`): a service returning a nice number
//! is not evidence that the row agrees.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::data::repositories::identity::audit;
use mobile_shop_system_lib::domain::catalog::{DeviceType, Disposition, DEFAULT_BRANDS};
use mobile_shop_system_lib::domain::identity::{Sensitivity, UserId};
use mobile_shop_system_lib::domain::organisation::DEFAULT_CATEGORIES;
use mobile_shop_system_lib::domain::unit::UnitError;
use mobile_shop_system_lib::services::catalog::brands;
use mobile_shop_system_lib::services::catalog::phone::{self, NewPhone};
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{approval, auth, bootstrap, pin, session};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::organisation::categories;
use mobile_shop_system_lib::services::sales::{
    self as sales_service, SaleLineInput, SaleLineWithUnitInput, SaleServiceError,
};
use sqlx::SqlitePool;

const OWNER_PIN: &str = "2580";

// Valid 15-digit Luhn IMEIs (`PLAN.md` §7.2 tests the same rule the UI applies).
const IMEI_A: &str = "860000000000017";
const IMEI_B: &str = "860000000000025";
const IMEI_C: &str = "860000000000033";
const IMEI_D: &str = "860000000000041";
const IMEI_E: &str = "860000000000058";
const IMEI_F: &str = "860000000000066";

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
    owner: UserId,
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
    categories::add_default_categories(&pool)
        .await
        .expect("default categories");
    brands::add_default_brands(&pool)
        .await
        .expect("default brands");
    Shop {
        pool,
        tokens,
        owner: created.user_id,
    }
}

async fn create_phone_product(shop: &Shop, model: &str, price_minor: i64) -> String {
    let samsung = DEFAULT_BRANDS
        .iter()
        .find(|b| b.name == "Samsung")
        .map(|b| b.brand_id())
        .expect("Samsung brand");
    let phones_cat = DEFAULT_CATEGORIES
        .iter()
        .find(|c| c.name == "موبايلات جديدة")
        .map(|c| c.department_id())
        .expect("phones category");
    let registered = phone::create_phone(
        &shop.pool,
        shop.tokens.as_ref(),
        NewPhone {
            category: phones_cat,
            brand: samsung,
            model: model.to_string(),
            device_type: DeviceType::Touch,
            storage_gb: Some(128),
            ram_gb: Some(6),
            sale_price_minor: Some(price_minor),
        },
    )
    .await
    .expect("register phone");
    registered.product.id.as_str().to_string()
}

async fn create_counted_product(shop: &Shop, name: &str, price_minor: i64) -> String {
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
            sale_price_minor: Some(price_minor),
            category: None,
        },
    )
    .await
    .expect("create product");
    created.id.as_str().to_string()
}

async fn owner_approves(shop: &Shop) {
    let current = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session");
    let holders = pin::pin_holders(&shop.pool).await.expect("PIN holders");
    if !holders.contains(&shop.owner.as_str()) {
        pin::set_own_pin(&shop.pool, &current, None, OWNER_PIN)
            .await
            .expect("set owner PIN");
    }
    approval::approve_with_owner_pin(&shop.pool, shop.tokens.as_ref(), shop.owner, OWNER_PIN)
        .await
        .expect("approve with owner PIN");
}

// ---------------------------------------------------------------------------
// Reading the tables. The claim is about the database, so the assertion reads
// the database.
// ---------------------------------------------------------------------------

/// `(quantity, total_cost_minor)` from `stock_levels`.
async fn position(shop: &Shop, product_id: &str) -> (i64, i64) {
    // A product nobody has received has no row at all, and that is a position of
    // zero, not a missing fact.
    let row: (i64, i64) = sqlx::query_as(
        "SELECT COALESCE((SELECT quantity FROM stock_levels WHERE product_id = ?1), 0),
                COALESCE((SELECT total_cost_minor FROM stock_levels WHERE product_id = ?1), 0)",
    )
    .bind(product_id)
    .fetch_one(&shop.pool)
    .await
    .expect("a stock position");
    row
}

/// `(SUM(quantity_delta), SUM(cost_delta_minor))` — the ledger's own answer.
async fn ledger(shop: &Shop, product_id: &str) -> (i64, i64) {
    sqlx::query_as(
        "SELECT COALESCE(SUM(quantity_delta), 0), COALESCE(SUM(cost_delta_minor), 0)
           FROM stock_movements WHERE product_id = ?1",
    )
    .bind(product_id)
    .fetch_one(&shop.pool)
    .await
    .expect("the ledger sum")
}

/// IMEIs of the units still on the shelf, oldest first.
async fn tracked_imeis(shop: &Shop, product_id: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT imei FROM units WHERE product_id = ?1 AND status = 'in_stock'
          ORDER BY created_at, id",
    )
    .bind(product_id)
    .fetch_all(&shop.pool)
    .await
    .expect("in-stock units")
}

/// `(status, retired_reason)` for one IMEI.
async fn unit_state(shop: &Shop, imei: &str) -> (String, Option<String>) {
    let row: (String, Option<String>) =
        sqlx::query_as("SELECT status, retired_reason FROM units WHERE imei = ?1")
            .bind(imei)
            .fetch_one(&shop.pool)
            .await
            .expect("a unit row");
    row
}

/// The invariant, asserted in one place so every test states it the same way.
async fn assert_untracked_invariant(shop: &Shop, product_id: &str) {
    let (on_hand, total_cost) = position(shop, product_id).await;
    let (ledger_qty, ledger_cost) = ledger(shop, product_id).await;
    let tracked = tracked_imeis(shop, product_id).await.len() as i64;

    assert_eq!(
        ledger_qty, on_hand,
        "SUM(quantity_delta) must equal the position, or the ledger and the shelf disagree"
    );
    assert_eq!(
        ledger_cost, total_cost,
        "SUM(cost_delta_minor) must equal the position's total cost"
    );
    assert!(
        tracked <= on_hand,
        "tracked ({tracked}) can never exceed the pieces on hand ({on_hand}): \
         that would claim a device the shop does not have"
    );
    assert!(on_hand >= 0, "a negative balance is never a stock position");
}

// ---------------------------------------------------------------------------
// Registering an IMEI: relabelling, never receiving
// ---------------------------------------------------------------------------

#[tokio::test]
async fn registering_an_imei_turns_untracked_pieces_into_tracked_without_moving_stock() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;

    // Five phones arrive from a supplier with no IMEIs written down.
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        5,
        100_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive 5 phones without IMEI");

    assert_eq!(position(&shop, &phones).await, (5, 500_000));
    assert_eq!(tracked_imeis(&shop, &phones).await.len(), 0, "nothing tracked yet");
    assert_untracked_invariant(&shop, &phones).await;

    // One of them is opened and its IMEI is written down.
    let unit = inventory::register_stock_unit(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        IMEI_A,
        Some("أسود"),
    )
    .await
    .expect("register one IMEI");

    assert_eq!(unit.unit_cost_minor, 100_000, "the piece keeps the shelf's cost");
    assert_eq!(
        position(&shop, &phones).await,
        (5, 500_000),
        "registering a serial is a relabelling: 5 pieces at 5,000 EGP stay 5 pieces at 5,000 EGP"
    );
    assert_eq!(tracked_imeis(&shop, &phones).await, vec![IMEI_A.to_string()]);
    assert_eq!(
        5 - tracked_imeis(&shop, &phones).await.len() as i64,
        4,
        "tracked 1 + untracked 4 == on hand 5"
    );
    assert_eq!(
        ledger(&shop, &phones).await,
        (5, 500_000),
        "no movement is written: a serial number is not a second receipt"
    );
    assert_untracked_invariant(&shop, &phones).await;

    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = ?1",
    )
    .bind(audit::event::STOCK_RECEIVED)
    .fetch_one(&shop.pool)
    .await
    .expect("audit count");
    assert!(audited >= 2, "the receipt and the serial registration are both audited");
}

#[tokio::test]
async fn registering_every_untracked_piece_leaves_no_room_for_another() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        2,
        100_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive 2");

    inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &phones, IMEI_A, None)
        .await
        .expect("first serial");
    inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &phones, IMEI_B, None)
        .await
        .expect("second serial");

    // Both pieces are accounted for; a third serial would claim a phone the shop
    // does not have, and must be refused instead of growing the shelf.
    let refused = inventory::register_stock_unit(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        IMEI_C,
        None,
    )
    .await
    .expect_err("no untracked piece is left");
    assert!(matches!(
        refused,
        inventory::StockServiceError::Stock(inventory::StockError::NoUntrackedPieces)
    ));
    assert_eq!(position(&shop, &phones).await, (2, 200_000));
    assert_eq!(tracked_imeis(&shop, &phones).await.len(), 2);
    assert_untracked_invariant(&shop, &phones).await;
}

#[tokio::test]
async fn a_duplicate_imei_is_refused_and_writes_no_unit() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        3,
        100_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive 3");

    inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &phones, IMEI_A, None)
        .await
        .expect("first registration");

    let refused = inventory::register_stock_unit(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        IMEI_A,
        None,
    )
    .await
    .expect_err("the same number twice is the same phone twice");
    assert!(matches!(
        refused,
        inventory::StockServiceError::Unit(UnitError::ImeiAlreadyRegistered)
    ));
    assert_eq!(tracked_imeis(&shop, &phones).await, vec![IMEI_A.to_string()]);
    assert_eq!(position(&shop, &phones).await, (3, 300_000));
    assert_untracked_invariant(&shop, &phones).await;

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM units WHERE imei = ?1")
        .bind(IMEI_A)
        .fetch_one(&shop.pool)
        .await
        .expect("unit rows");
    assert_eq!(rows, 1, "a refused duplicate leaves exactly one row");
}

#[tokio::test]
async fn an_imei_on_another_product_cannot_be_borrowed() {
    let shop = shop().await;
    let first = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    let second = create_phone_product(&shop, "Galaxy A26", 1_399_000).await;
    for product in [&first, &second] {
        inventory::receive(
            &shop.pool,
            shop.tokens.as_ref(),
            product,
            2,
            100_000,
            Sensitivity::Routine,
            None,
        )
        .await
        .expect("receive 2");
    }

    inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &first, IMEI_A, None)
        .await
        .expect("registered against the first model");

    let refused = inventory::register_stock_unit(
        &shop.pool,
        shop.tokens.as_ref(),
        &second,
        IMEI_A,
        None,
    )
    .await
    .expect_err("one device cannot sit on two shelves");
    assert!(matches!(
        refused,
        inventory::StockServiceError::Unit(UnitError::ImeiAlreadyRegistered)
    ));
    assert_eq!(tracked_imeis(&shop, &second).await.len(), 0);
    assert_untracked_invariant(&shop, &second).await;
}

#[tokio::test]
async fn an_imei_cannot_be_registered_for_a_product_that_counted_nothing() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;

    let refused = inventory::register_stock_unit(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        IMEI_A,
        None,
    )
    .await
    .expect_err("zero on hand means zero pieces to label");
    assert!(matches!(
        refused,
        inventory::StockServiceError::Stock(inventory::StockError::NoUntrackedPieces)
    ));

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM units")
        .fetch_one(&shop.pool)
        .await
        .expect("unit rows");
    assert_eq!(rows, 0, "a refused registration writes nothing at all");
    assert_eq!(position(&shop, &phones).await, (0, 0));
}

#[tokio::test]
async fn a_counted_product_refuses_serial_numbers() {
    let shop = shop().await;
    let cable = create_counted_product(&shop, "Anker Cable", 20_000).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &cable,
        5,
        12_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive cables");

    let refused = inventory::register_stock_unit(
        &shop.pool,
        shop.tokens.as_ref(),
        &cable,
        IMEI_A,
        None,
    )
    .await
    .expect_err("a cable has no IMEI");
    assert!(matches!(
        refused,
        inventory::StockServiceError::Unit(UnitError::ProductNotSerialTracked)
    ));
    assert_eq!(position(&shop, &cable).await, (5, 60_000));
}

#[tokio::test]
async fn two_operators_registering_the_same_imei_at_once_get_one_unit() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        5,
        100_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive 5");

    let (first, second) = tokio::join!(
        inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &phones, IMEI_A, None),
        inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &phones, IMEI_A, None),
    );

    assert!(
        first.is_ok() ^ second.is_ok(),
        "exactly one of two simultaneous registrations may win"
    );
    // The loser is told the number is taken, not that the storage broke: the
    // transaction's read raced, and the table's UNIQUE constraint is the truth.
    let refused = if first.is_ok() { second } else { first };
    assert!(matches!(
        refused.expect_err("the loser refuses"),
        inventory::StockServiceError::Unit(UnitError::ImeiAlreadyRegistered)
    ));

    assert_eq!(tracked_imeis(&shop, &phones).await, vec![IMEI_A.to_string()]);
    assert_eq!(position(&shop, &phones).await, (5, 500_000));
    assert_untracked_invariant(&shop, &phones).await;
}

// ---------------------------------------------------------------------------
// Selling, cancelling and returning untracked phones (`PLAN.md` §7.3)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn selling_without_imei_consumes_untracked_pieces_before_any_tracked_one() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        5,
        100_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive 5 without IMEI");
    inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &phones, IMEI_A, None)
        .await
        .expect("one serial");
    inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &phones, IMEI_B, None)
        .await
        .expect("two serials");
    assert_untracked_invariant(&shop, &phones).await;

    // on hand 5, tracked 2, untracked 3. Selling one unlinked phone must spend an
    // untracked piece: no registered device is touched, and no IMEI is invented.
    let first = sales_service::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: phones.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
        }],
        Some(925_000),
    )
    .await
    .expect("sell one phone without an IMEI");
    assert_eq!(first.cost_total_minor, 100_000);
    assert_eq!(position(&shop, &phones).await, (4, 400_000));
    assert_eq!(
        tracked_imeis(&shop, &phones).await,
        vec![IMEI_A.to_string(), IMEI_B.to_string()],
        "both serials stay: the shop still holds the two devices it can name"
    );
    assert_eq!(
        unit_state(&shop, IMEI_A).await.0,
        "in_stock",
        "an unlinked sale never pins itself to a serial"
    );
    assert_untracked_invariant(&shop, &phones).await;

    // Two more unlinked sales empty the untracked pool exactly (3 → 0) without
    // retiring anything.
    for _ in 0..2 {
        sales_service::record_sale(
            &shop.pool,
            shop.tokens.as_ref(),
            &[SaleLineInput {
                product_id: phones.clone(),
                quantity: 1,
                warranty_start: None,
                warranty_end: None,
            }],
            Some(925_000),
        )
        .await
        .expect("sell another untracked phone");
    }
    assert_eq!(position(&shop, &phones).await, (2, 200_000));
    assert_eq!(tracked_imeis(&shop, &phones).await.len(), 2, "tracked == on hand");
    assert_untracked_invariant(&shop, &phones).await;

    // The next unlinked sale has no untracked piece to spend, so the oldest
    // registered device is the one recorded as gone.
    sales_service::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: phones.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
        }],
        Some(925_000),
    )
    .await
    .expect("sell past the untracked pool");
    assert_eq!(position(&shop, &phones).await, (1, 100_000));
    assert_eq!(tracked_imeis(&shop, &phones).await, vec![IMEI_B.to_string()]);
    let (status, reason) = unit_state(&shop, IMEI_A).await;
    assert_eq!(status, "retired");
    assert_eq!(reason.as_deref(), Some("untracked_sale_overflow"));
    assert_untracked_invariant(&shop, &phones).await;
}

#[tokio::test]
async fn five_untracked_phones_sold_two_then_cancelled_are_five_again() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        5,
        100_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive 5 without IMEI");

    let sale = sales_service::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: phones.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
        }],
        Some(1_850_000),
    )
    .await
    .expect("sell two untracked phones");
    assert_eq!(sale.cost_total_minor, 200_000);
    assert_eq!(position(&shop, &phones).await, (3, 300_000), "5 − 2 = 3");
    assert_untracked_invariant(&shop, &phones).await;

    owner_approves(&shop).await;
    let cancelled = sales_service::cancel_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &sale.sale_id,
        "العميل رجع الفاتورة",
    )
    .await
    .expect("cancel the sale");

    assert_eq!(position(&shop, &phones).await, (5, 500_000), "3 + 2 = 5 again");
    assert!(cancelled.total_minor > 0);
    assert_untracked_invariant(&shop, &phones).await;
    let cancelled_again = sales_service::cancel_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &sale.sale_id,
        "مرة تانية",
    )
    .await;
    assert!(cancelled_again.is_err(), "a cancelled sale cannot be reversed twice");
    assert_eq!(position(&shop, &phones).await, (5, 500_000), "and nothing moved");
}

#[tokio::test]
async fn a_partial_return_of_an_untracked_sale_adds_back_only_what_came_back() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        5,
        100_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive 5");

    let sale = sales_service::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: phones.clone(),
            quantity: 3,
            warranty_start: None,
            warranty_end: None,
        }],
        Some(2_775_000),
    )
    .await
    .expect("sell three untracked phones");
    assert_eq!(position(&shop, &phones).await, (2, 200_000));

    let info = sales_service::inspect_sale_for_return(
        &shop.pool,
        shop.tokens.as_ref(),
        &sale.reference,
    )
    .await
    .expect("inspect the sale");
    let line_id = info.lines[0].line_id.clone();

    owner_approves(&shop).await;
    let returned = sales_service::record_sale_return(
        &shop.pool,
        shop.tokens.as_ref(),
        &sale.sale_id,
        &[mobile_shop_system_lib::domain::sales::SaleReturnLineInput {
            sale_line_id: line_id,
            quantity: 1,
            condition: "intact".to_owned(),
        }],
        "جهاز واحد رجع سليم",
        None,
    )
    .await
    .expect("return one of the three");

    assert_eq!(returned.refund_minor, 925_000);
    assert_eq!(returned.cost_returned_minor, 100_000);
    assert_eq!(
        position(&shop, &phones).await,
        (3, 300_000),
        "2 on the shelf + 1 returned intact = 3; the other two stayed sold"
    );
    assert_untracked_invariant(&shop, &phones).await;

    // A damaged unit comes back physically but not to the sellable shelf.
    owner_approves(&shop).await;
    let damaged = sales_service::record_sale_return(
        &shop.pool,
        shop.tokens.as_ref(),
        &sale.sale_id,
        &[mobile_shop_system_lib::domain::sales::SaleReturnLineInput {
            sale_line_id: info.lines[0].line_id.clone(),
            quantity: 1,
            condition: "damaged".to_owned(),
        }],
        "الشاشة مكسورة",
        None,
    )
    .await
    .expect("return one damaged");
    assert_eq!(damaged.damaged_cost_minor, 100_000);
    assert_eq!(
        position(&shop, &phones).await,
        (3, 300_000),
        "a damaged return does not raise sellable stock"
    );
    assert_untracked_invariant(&shop, &phones).await;
}

#[tokio::test]
async fn an_imei_typed_at_the_counter_labels_an_untracked_piece_on_the_same_receipt() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        3,
        100_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive 3 untracked");

    // Selling by a number nobody registered yet registers it at that moment
    // (`PLAN.md` §7.2) — still out of the untracked pool, so the balance is 2.
    let sale = sales_service::record_sale_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: phones.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: Some(IMEI_C.to_string()),
        }],
        Some(925_000),
    )
    .await
    .expect("sell by a late IMEI");
    assert_eq!(sale.cost_total_minor, 100_000);
    assert_eq!(position(&shop, &phones).await, (2, 200_000));
    // The sold device is `sold`, so it is not "tracked in stock"; the two
    // remaining pieces stay untracked and the invariant still holds.
    assert_eq!(unit_state(&shop, IMEI_C).await.0, "sold");
    assert_untracked_invariant(&shop, &phones).await;

    // A number that was never on the shelf, typed against an emptied product,
    // is refused rather than invented.
    let emptied = create_phone_product(&shop, "Galaxy A34", 860_000).await;
    let refused: Result<_, SaleServiceError> = sales_service::record_sale_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: emptied.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: Some(IMEI_D.to_string()),
        }],
        Some(860_000),
    )
    .await;
    assert!(
        refused.is_err(),
        "selling a device the shop never had must be refused, never labelled into existence"
    );
    assert_eq!(position(&shop, &emptied).await, (0, 0));
    let invented: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM units WHERE imei = ?1")
        .bind(IMEI_D)
        .fetch_one(&shop.pool)
        .await
        .expect("unit rows");
    assert_eq!(invented, 0, "a refused sale leaves no unit behind");
}

#[tokio::test]
async fn tracked_untracked_and_damaged_reconcile_with_the_ledger_at_every_step() {
    let shop = shop().await;
    let phones = create_phone_product(&shop, "Galaxy A16", 925_000).await;

    // 5 in, two labelled, one sold unlinked, one returned damaged.
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &phones,
        5,
        100_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive 5");
    inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &phones, IMEI_E, None)
        .await
        .expect("label one");
    inventory::register_stock_unit(&shop.pool, shop.tokens.as_ref(), &phones, IMEI_F, None)
        .await
        .expect("label two");
    assert_untracked_invariant(&shop, &phones).await;

    let sale = sales_service::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: phones.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
        }],
        Some(1_850_000),
    )
    .await
    .expect("sell two unlinked");
    assert_untracked_invariant(&shop, &phones).await;

    let info = sales_service::inspect_sale_for_return(
        &shop.pool,
        shop.tokens.as_ref(),
        &sale.reference,
    )
    .await
    .expect("inspect");
    owner_approves(&shop).await;
    sales_service::record_sale_return(
        &shop.pool,
        shop.tokens.as_ref(),
        &sale.sale_id,
        &[mobile_shop_system_lib::domain::sales::SaleReturnLineInput {
            sale_line_id: info.lines[0].line_id.clone(),
            quantity: 1,
            condition: "damaged".to_owned(),
        }],
        "تالف",
        None,
    )
    .await
    .expect("damaged return");

    let (on_hand, total_cost) = position(&shop, &phones).await;
    let (ledger_qty, ledger_cost) = ledger(&shop, &phones).await;
    let tracked = tracked_imeis(&shop, &phones).await.len() as i64;
    let damaged: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity), 0) FROM damaged_stock WHERE product_id = ?1",
    )
    .bind(&phones)
    .fetch_one(&shop.pool)
    .await
    .expect("damaged pieces");

    assert_eq!(on_hand, 3, "5 received − 2 sold, and a damaged return sells nothing back");
    assert_eq!(ledger_qty, on_hand, "sellable balance equals the ledger");
    assert_eq!(ledger_cost, total_cost, "valuation equals the ledger");
    assert_eq!(tracked + (on_hand - tracked), on_hand, "tracked + untracked");
    assert_eq!(damaged, 1, "the damaged piece is held beside the sellable shelf");
    assert_eq!(
        on_hand + damaged,
        4,
        "every piece received is accounted for: 3 sellable + 1 damaged, and one sold and gone"
    );
    assert_untracked_invariant(&shop, &phones).await;
}
