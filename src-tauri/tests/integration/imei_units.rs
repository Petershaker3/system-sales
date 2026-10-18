//! Plan item 1.4 (`ADR-019`, `docs/PLAN.md` §7 & §11): optional IMEI units,
//! opening-balance vs supplier receiving, phone unit sales, late IMEI
//! registration at the counter, automatic retirement of the oldest registered
//! unit on unlinked sales overflow, and `ui.imei_mode = required`.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::{DeviceType, Disposition, DEFAULT_BRANDS};
use mobile_shop_system_lib::domain::identity::{Sensitivity, UserId};
use mobile_shop_system_lib::domain::organisation::DEFAULT_CATEGORIES;
use mobile_shop_system_lib::domain::supplier::SupplierName;
use mobile_shop_system_lib::domain::unit::ReceiptKind;
use mobile_shop_system_lib::services::catalog::brands;
use mobile_shop_system_lib::services::catalog::phone::{self, NewPhone, NewUsedPhone};
use mobile_shop_system_lib::services::catalog::pos;
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{approval, auth, bootstrap, pin, session};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::organisation::categories;
use mobile_shop_system_lib::services::sales::{
    self as sales_service, SaleLineInput, SaleLineWithUnitInput,
};
use mobile_shop_system_lib::services::settings::appearance;
use sqlx::SqlitePool;

const OWNER_PIN: &str = "2580";

// Valid 15-digit Luhn IMEIs for testing.
const IMEI_1: &str = "356938035643809";
const IMEI_2: &str = "490154203237518";
const IMEI_3: &str = "353918051234561";

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

async fn create_accessory_product(shop: &Shop, name: &str, price_minor: i64) -> String {
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
    .expect("create accessory");
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

#[tokio::test]
async fn registering_a_phone_marks_it_serial_optional_and_exposes_units_in_pos_catalog() {
    let shop = shop().await;
    let phone_id = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    let accessory_id = create_accessory_product(&shop, "جراب شفاف", 15_000).await;

    let read = pos::read(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("pos catalog");
    let phone_row = read.products.iter().find(|p| p.id == phone_id).expect("phone");
    let acc_row = read
        .products
        .iter()
        .find(|p| p.id == accessory_id)
        .expect("accessory");

    assert_eq!(phone_row.tracking, "serial_optional");
    assert_eq!(acc_row.tracking, "none");
    assert!(read.units.is_empty());
}

#[tokio::test]
async fn receiving_phones_by_imei_validates_luhn_and_refuses_duplicates() {
    let shop = shop().await;
    let phone_id = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    let accessory_id = create_accessory_product(&shop, "شاحن أصلي", 45_000).await;

    // 1. Non-serial-tracked product refuses IMEIs.
    let not_serial = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &accessory_id,
        1,
        30_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[IMEI_1.to_string()],
    )
    .await;
    assert_eq!(
        not_serial.err().map(|e| e.code()),
        Some("IMEI_PRODUCT_NOT_SERIAL_TRACKED")
    );

    // 2. Bad length or bad Luhn check digit is refused.
    let bad_len = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        780_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &["12345678901234".to_string()],
    )
    .await;
    assert_eq!(bad_len.err().map(|e| e.code()), Some("IMEI_LENGTH_INVALID"));

    let bad_luhn = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        780_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &["356938035643800".to_string()],
    )
    .await;
    assert_eq!(
        bad_luhn.err().map(|e| e.code()),
        Some("IMEI_CHECK_DIGIT_INVALID")
    );

    // 3. More IMEIs than quantity is refused.
    let too_many = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        780_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[IMEI_1.to_string(), IMEI_2.to_string()],
    )
    .await;
    assert_eq!(
        too_many.err().map(|e| e.code()),
        Some("IMEI_COUNT_EXCEEDS_QUANTITY")
    );

    // 4. Valid mixed receipt: 2 units received, 1 with IMEI_1 and 1 by count.
    let outcome = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        2,
        780_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        Some(SupplierName::parse("الشركة الهندسية").expect("supplier")),
        &[IMEI_1.to_string()],
    )
    .await
    .expect("mixed receipt");
    assert_eq!(outcome.quantity, 2);

    let units = inventory::list_units_in_stock(&shop.pool, shop.tokens.as_ref(), &phone_id)
        .await
        .expect("units in stock");
    assert_eq!(units.len(), 1);
    assert_eq!(units[0].imei, IMEI_1);
    assert_eq!(units[0].unit_cost_minor, 780_000);

    // 5. Receiving the same IMEI again is refused (`IMEI_ALREADY_REGISTERED`).
    let dup_in_shop = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        790_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[IMEI_1.to_string()],
    )
    .await;
    assert_eq!(
        dup_in_shop.err().map(|e| e.code()),
        Some("IMEI_ALREADY_REGISTERED")
    );
}

#[tokio::test]
async fn opening_stock_receipt_spends_owner_approval_and_forbids_supplier() {
    let shop = shop().await;
    let phone_id = create_phone_product(&shop, "Galaxy A55", 1_850_000).await;

    // Without owner approval, opening stock is refused.
    let unapproved = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        1_600_000,
        ReceiptKind::Opening,
        Sensitivity::Sensitive,
        None,
        &[IMEI_1.to_string()],
    )
    .await;
    assert_eq!(
        unapproved.err().map(|e| e.code()),
        Some("OWNER_APPROVAL_REQUIRED")
    );

    // Opening stock with a supplier name is refused before touching the approval.
    owner_approves(&shop).await;
    let with_supplier = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        1_600_000,
        ReceiptKind::Opening,
        Sensitivity::Sensitive,
        Some(SupplierName::parse("مورد").expect("supplier")),
        &[IMEI_1.to_string()],
    )
    .await;
    assert_eq!(
        with_supplier.err().map(|e| e.code()),
        Some("RECEIPT_OPENING_HAS_SUPPLIER")
    );

    // Now receive opening stock properly: approval is spent and `receipt_kind = 'opening'`.
    let outcome = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        1_600_000,
        ReceiptKind::Opening,
        Sensitivity::Sensitive,
        None,
        &[IMEI_1.to_string()],
    )
    .await
    .expect("opening stock receipt");
    assert_eq!(outcome.quantity, 1);

    let kind: Option<String> = sqlx::query_scalar(
        "SELECT receipt_kind FROM stock_movements WHERE product_id = ?1 AND kind = 'receipt'",
    )
    .bind(&phone_id)
    .fetch_one(&shop.pool)
    .await
    .expect("movement row");
    assert_eq!(kind.as_deref(), Some("opening"));
}

#[tokio::test]
async fn selling_by_registered_imei_uses_the_units_exact_cost_and_marks_it_sold() {
    let shop = shop().await;
    let phone_id = create_phone_product(&shop, "Galaxy A16", 925_000).await;

    // Receive IMEI_1 at 750,000 and IMEI_2 at 810,000.
    inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        750_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[IMEI_1.to_string()],
    )
    .await
    .expect("receive IMEI_1");
    inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        810_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[IMEI_2.to_string()],
    )
    .await
    .expect("receive IMEI_2");

    // Sell IMEI_2 specifically: must consume 810,000 (not the 780,000 average!).
    let sale = sales_service::record_sale_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: phone_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: Some(IMEI_2.to_string()),
        }],
        Some(925_000),
    )
    .await
    .expect("sell IMEI_2");
    assert_eq!(sale.total_minor, 925_000);
    assert_eq!(sale.cost_total_minor, 810_000);

    // Remaining in stock: only IMEI_1, and stock_levels holds quantity=1, total_cost=750,000.
    let remaining_units =
        inventory::list_units_in_stock(&shop.pool, shop.tokens.as_ref(), &phone_id)
            .await
            .expect("units in stock");
    assert_eq!(remaining_units.len(), 1);
    assert_eq!(remaining_units[0].imei, IMEI_1);

    let (qty, total_cost): (i64, i64) = sqlx::query_as(
        "SELECT quantity, total_cost_minor FROM stock_levels WHERE product_id = ?1",
    )
    .bind(&phone_id)
    .fetch_one(&shop.pool)
    .await
    .expect("stock_levels");
    assert_eq!((qty, total_cost), (1, 750_000));

    // Selling IMEI_2 again is refused (`IMEI_UNIT_NOT_AVAILABLE`).
    let again = sales_service::record_sale_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: phone_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: Some(IMEI_2.to_string()),
        }],
        Some(925_000),
    )
    .await;
    assert_eq!(
        again.err().map(|e| e.code()),
        Some("IMEI_UNIT_NOT_AVAILABLE")
    );
}

#[tokio::test]
async fn late_imei_registration_at_sale_time_works_when_unregistered_stock_exists() {
    let shop = shop().await;
    let phone_id = create_phone_product(&shop, "Galaxy A16", 925_000).await;

    // Receive 2 phones: 1 registered (IMEI_1 at 750,000) and 1 by count (at 790,000).
    inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        750_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[IMEI_1.to_string()],
    )
    .await
    .expect("receive IMEI_1");
    inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        790_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[],
    )
    .await
    .expect("receive 1 by count");

    // At the counter, seller scans IMEI_3 (new box not registered at receiving):
    // consumes the 1 unregistered unit at 790,000 and leaves IMEI_1 in stock!
    let sale = sales_service::record_sale_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: phone_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: Some(IMEI_3.to_string()),
        }],
        Some(925_000),
    )
    .await
    .expect("late-register and sell IMEI_3");
    assert_eq!(sale.cost_total_minor, 790_000);

    // Now on_hand == 1 and in_stock_units == 1 (IMEI_1). Trying to late-register
    // another unknown IMEI (IMEI_2) is refused because no unregistered stock remains.
    let refused = sales_service::record_sale_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: phone_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: Some(IMEI_2.to_string()),
        }],
        Some(925_000),
    )
    .await;
    assert_eq!(
        refused.err().map(|e| e.code()),
        Some("IMEI_NO_UNREGISTERED_STOCK")
    );
}

#[tokio::test]
async fn selling_without_imei_retires_oldest_registered_unit_on_overflow_and_cancel_restores_it() {
    let shop = shop().await;
    let phone_id = create_phone_product(&shop, "Galaxy A16", 925_000).await;

    // Receive IMEI_1 (oldest, at 740,000) then IMEI_2 (newer, at 800,000).
    inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        740_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[IMEI_1.to_string()],
    )
    .await
    .expect("receive IMEI_1");
    inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        800_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[IMEI_2.to_string()],
    )
    .await
    .expect("receive IMEI_2");

    // Sell 1 phone WITHOUT an IMEI (`PLAN.md` §7.3):
    // remaining_on_hand becomes 1, which is less than the 2 registered units,
    // so the oldest unit (IMEI_1, cost 740,000) is automatically retired!
    let sale = sales_service::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: phone_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
        }],
        Some(925_000),
    )
    .await
    .expect("unlinked phone sale");
    assert_eq!(sale.cost_total_minor, 740_000);

    let in_stock = inventory::list_units_in_stock(&shop.pool, shop.tokens.as_ref(), &phone_id)
        .await
        .expect("in stock");
    assert_eq!(in_stock.len(), 1);
    assert_eq!(in_stock[0].imei, IMEI_2, "newest stays in stock, oldest was retired");

    let (status_1, reason_1): (String, Option<String>) = sqlx::query_as(
        "SELECT status, retired_reason FROM units WHERE imei = ?1",
    )
    .bind(IMEI_1)
    .fetch_one(&shop.pool)
    .await
    .expect("IMEI_1 row");
    assert_eq!(status_1, "retired");
    assert_eq!(reason_1.as_deref(), Some("untracked_sale_overflow"));

    // Cancelling the sale restores IMEI_1 back to `in_stock`!
    owner_approves(&shop).await;
    sales_service::cancel_sale(&shop.pool, shop.tokens.as_ref(), &sale.sale_id, "رجوع")
        .await
        .expect("cancel sale");

    let restored = inventory::list_units_in_stock(&shop.pool, shop.tokens.as_ref(), &phone_id)
        .await
        .expect("in stock after cancel");
    assert_eq!(restored.len(), 2);
    assert_eq!(restored[0].imei, IMEI_1);
    assert_eq!(restored[1].imei, IMEI_2);
}

#[tokio::test]
async fn required_imei_mode_enforces_imei_on_phone_receiving_and_selling() {
    let shop = shop().await;
    let phone_id = create_phone_product(&shop, "Galaxy A16", 925_000).await;
    let accessory_id = create_accessory_product(&shop, "اسكرينة زجاج", 10_000).await;

    // Owner enables required IMEI mode (`ui.imei_mode = required`).
    appearance::update(&shop.pool, shop.tokens.as_ref(), "ui.imei_mode", "required")
        .await
        .expect("set imei_mode to required");

    // 1. Receiving a phone without IMEIs is now refused!
    let refused_receive = inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        780_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[],
    )
    .await;
    assert_eq!(
        refused_receive.err().map(|e| e.code()),
        Some("IMEI_REQUIRED_FOR_ALL_UNITS")
    );

    // 2. Receiving with matching IMEI count succeeds.
    inventory::receive_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &phone_id,
        1,
        780_000,
        ReceiptKind::Supplier,
        Sensitivity::Routine,
        None,
        &[IMEI_1.to_string()],
    )
    .await
    .expect("receive phone with IMEI");

    // 3. Selling a phone without an IMEI is refused in required mode.
    let refused_sale = sales_service::record_sale(
        &shop.pool,
        shop.tokens.as_ref(),
        &[SaleLineInput {
            product_id: phone_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
        }],
        Some(925_000),
    )
    .await;
    assert_eq!(
        refused_sale.err().map(|e| e.code()),
        Some("IMEI_REQUIRED_FOR_ALL_UNITS")
    );

    // 4. Selling the phone with its IMEI succeeds, and accessories still sell by count.
    inventory::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &accessory_id,
        5,
        4_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive accessory");

    sales_service::record_sale_with_units(
        &shop.pool,
        shop.tokens.as_ref(),
        &[
            SaleLineWithUnitInput {
                product_id: phone_id.clone(),
                quantity: 1,
                warranty_start: None,
                warranty_end: None,
                imei: Some(IMEI_1.to_string()),
            },
            SaleLineWithUnitInput {
                product_id: accessory_id.clone(),
                quantity: 2,
                warranty_start: None,
                warranty_end: None,
                imei: None,
            },
        ],
        Some(945_000),
    )
    .await
    .expect("sell phone with IMEI + accessory by count");
}

#[tokio::test]
async fn used_phone_registration_opening_stock_and_imei_check_work_end_to_end() {
    let shop = shop().await;
    pin::set_own_pin(&shop.pool, shop.tokens.as_ref(), PASSWORD, OWNER_PIN)
        .await
        .expect("set owner PIN");

    let samsung = DEFAULT_BRANDS
        .iter()
        .find(|b| b.name == "Samsung")
        .map(|b| b.brand_id())
        .expect("Samsung brand");
    let used_cat = DEFAULT_CATEGORIES
        .iter()
        .find(|c| c.name == "موبايلات مستعملة")
        .map(|c| c.department_id())
        .expect("used phones category");

    // 1. Validation: secondary IMEI matching primary is refused.
    let same_imei = phone::create_used_phone(
        &shop.pool,
        shop.tokens.as_ref(),
        NewUsedPhone {
            category: used_cat,
            brand: samsung,
            model: "Galaxy A54".to_string(),
            device_type: DeviceType::Touch,
            storage_gb: Some(128),
            ram_gb: Some(8),
            color: Some("أسود".to_string()),
            imei: IMEI_1.to_string(),
            imei2: Some(IMEI_1.to_string()),
            condition_grade: "A".to_string(),
            battery_health_pct: Some(91),
            accessories: Some("علبة، شاحن".to_string()),
            intake_note: Some("حالة ممتازة".to_string()),
            cost_minor: 950_000,
            sale_price_minor: 1_150_000,
            seller_name: Some("أحمد سمير".to_string()),
            seller_phone: Some("01012345678".to_string()),
            seller_national_id: Some("29501011234567".to_string()),
            is_opening_stock: false,
            payout_from_drawer: false,
        },
    )
    .await;
    assert_eq!(
        same_imei.err().map(|e| e.code()),
        Some("IMEI_SECONDARY_MATCHES_PRIMARY")
    );

    // 2. Register a customer-purchased used phone (Grade A, 91% battery).
    let used_a = phone::create_used_phone(
        &shop.pool,
        shop.tokens.as_ref(),
        NewUsedPhone {
            category: used_cat,
            brand: samsung,
            model: "Galaxy A54".to_string(),
            device_type: DeviceType::Touch,
            storage_gb: Some(128),
            ram_gb: Some(8),
            color: Some("أسود".to_string()),
            imei: IMEI_1.to_string(),
            imei2: Some(IMEI_2.to_string()),
            condition_grade: "A".to_string(),
            battery_health_pct: Some(91),
            accessories: Some("علبة، شاحن".to_string()),
            intake_note: Some("حالة ممتازة".to_string()),
            cost_minor: 950_000,
            sale_price_minor: 1_150_000,
            seller_name: Some("أحمد سمير".to_string()),
            seller_phone: Some("01012345678".to_string()),
            seller_national_id: Some("29501011234567".to_string()),
            is_opening_stock: false,
            payout_from_drawer: false,
        },
    )
    .await
    .expect("register used phone");

    assert_eq!(
        used_a.product.name.as_str(),
        "Samsung Galaxy A54 128GB مستعمل فئة A"
    );
    assert_eq!(used_a.on_hand, 1);

    // 3. Opening-stock used phone requires owner PIN approval.
    let without_approval = phone::create_used_phone(
        &shop.pool,
        shop.tokens.as_ref(),
        NewUsedPhone {
            category: used_cat,
            brand: samsung,
            model: "Galaxy A54".to_string(),
            device_type: DeviceType::Touch,
            storage_gb: Some(128),
            ram_gb: Some(8),
            color: Some("أبيض".to_string()),
            imei: IMEI_3.to_string(),
            imei2: None,
            condition_grade: "A".to_string(),
            battery_health_pct: Some(86),
            accessories: Some("شاحن".to_string()),
            intake_note: None,
            cost_minor: 900_000,
            sale_price_minor: 1_150_000,
            seller_name: None,
            seller_phone: None,
            seller_national_id: None,
            is_opening_stock: true,
            payout_from_drawer: false,
        },
    )
    .await;
    assert_eq!(
        without_approval.err().map(|e| e.code()),
        Some("OWNER_APPROVAL_REQUIRED")
    );

    let session_id = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session")
        .id();
    approval::grant(&shop.pool, session_id, shop.owner, OWNER_PIN)
        .await
        .expect("grant owner PIN approval");

    let opening_used = phone::create_used_phone(
        &shop.pool,
        shop.tokens.as_ref(),
        NewUsedPhone {
            category: used_cat,
            brand: samsung,
            model: "Galaxy A54".to_string(),
            device_type: DeviceType::Touch,
            storage_gb: Some(128),
            ram_gb: Some(8),
            color: Some("أبيض".to_string()),
            imei: IMEI_3.to_string(),
            imei2: None,
            condition_grade: "A".to_string(),
            battery_health_pct: Some(86),
            accessories: Some("شاحن".to_string()),
            intake_note: None,
            cost_minor: 900_000,
            sale_price_minor: 1_150_000,
            seller_name: None,
            seller_phone: None,
            seller_national_id: None,
            is_opening_stock: true,
            payout_from_drawer: false,
        },
    )
    .await
    .expect("opening stock used phone");
    assert_eq!(opening_used.product.id, used_a.product.id);
    assert_eq!(opening_used.on_hand, 2);

    // 4. IMEI check finds the unit by secondary IMEI too and validates Luhn + TAC.
    let report = phone::check_imei(&shop.pool, shop.tokens.as_ref(), IMEI_2)
        .await
        .expect("check IMEI");
    assert!(report.format_valid);
    assert!(report.luhn_valid);
    assert_eq!(report.tac.as_deref(), Some("49015420"));
    let matched = report.local_unit.expect("local unit match");
    assert_eq!(matched.imei, IMEI_1);
    assert_eq!(matched.condition_grade.as_deref(), Some("A"));
    assert_eq!(matched.battery_health_pct, Some(91));
    assert_eq!(matched.seller_name.as_deref(), Some("أحمد سمير"));
    assert_eq!(matched.unit_cost_minor, Some(950_000));
}

