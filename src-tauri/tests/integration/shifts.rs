//! Plan item 1.9 (`ADR-024`): shifts (`shifts`), drawer expenses (`expenses`),
//! cash movements (`cash_movements`), expected vs counted cash reconciliation,
//! and seller shift-closing permission (`ui.seller_can_close_shift`).

use std::sync::Arc;

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::identity::audit;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::customer::{NewCustomer, NewCustomerPayment};
use mobile_shop_system_lib::domain::identity::{Role, Sensitivity, UserId};
use mobile_shop_system_lib::domain::sales::SalePaymentInput;
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::customer as customer_service;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, pin, session, users};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales, SaleLineWithUnitInput};
use mobile_shop_system_lib::services::settings::appearance;
use mobile_shop_system_lib::services::shift as shift_service;
use sqlx::SqlitePool;

const OWNER_PIN: &str = "2580";

async fn setup_shop() -> (
    SqlitePool,
    Arc<InMemoryTokenStore>,
    UserId,
    UserId,
    String,
) {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("bootstrap manager");
    let manager_uid = created.user_id;
    auth::login(&pool, tokens.as_ref(), manager_uid, PASSWORD)
        .await
        .expect("manager login");
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    let manager_session = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("resolve manager");
    pin::set_own_pin(&pool, &manager_session, None, OWNER_PIN)
        .await
        .expect("set owner pin");

    let seller_uid = users::create_user(
        &pool,
        &manager_session,
        "Youssef",
        "youssef",
        Role::Sales,
        PASSWORD,
    )
    .await
    .expect("create seller");

    let ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let cable = catalog::create(
        &ctx,
        &manager_session,
        NewProduct {
            name: "Anker Type-C Cable".to_owned(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(200_00),
            category: None,
        },
    )
    .await
    .expect("create product");
    let product_id = cable.id.as_str().to_string();

    inventory::receive(
        &pool,
        tokens.as_ref(),
        &product_id,
        30,
        120_00,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive stock");

    (pool, tokens, manager_uid, seller_uid, product_id)
}

#[tokio::test]
async fn migration_0023_creates_shift_expense_and_cash_movement_tables() {
    let (pool, _tokens) = fresh().await;
    for table in ["shifts", "expenses", "cash_movements"] {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .expect("table probe");
        assert_eq!(count, 1, "migration 0023 must create `{table}`");
    }

    let read = appearance::read(&pool).await.expect("appearance");
    assert_eq!(read.seller_can_close_shift, "off");
}

#[tokio::test]
async fn open_shift_tracks_sales_customer_cash_expenses_and_movements_with_exact_expected_drawer() {
    let (pool, tokens, _manager_uid, _seller_uid, product_id) = setup_shop().await;

    // Recording an expense before opening a shift is refused with `SHIFT_NOT_OPEN`.
    let no_shift_err =
        shift_service::record_expense(&pool, tokens.as_ref(), "شاي وضيافة", 50_00, None).await;
    assert_eq!(no_shift_err.err().map(|e| e.code()), Some("SHIFT_NOT_OPEN"));

    // Open Shift #1 with 1,000 EGP (100_000 minor).
    let opened = shift_service::open_shift(&pool, tokens.as_ref(), 100_000)
        .await
        .expect("open shift #1");
    assert_eq!(opened.shift.shift_number, 1);
    assert_eq!(opened.shift.status.as_str(), "open");
    assert_eq!(opened.totals.opening_cash_minor, 100_000);
    assert_eq!(opened.totals.expected_cash_minor, 100_000);

    // Opening a second shift while #1 is open is refused with `SHIFT_ALREADY_OPEN`.
    let dup = shift_service::open_shift(&pool, tokens.as_ref(), 50_000).await;
    assert_eq!(dup.err().map(|e| e.code()), Some("SHIFT_ALREADY_OPEN"));

    // 1. Cash sale: 2 units × 200 EGP = 400 EGP (40_000 minor), cost 240 EGP (24_000 minor).
    sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: product_id.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
            imei: None,
            color: None,
        }],
        &[SalePaymentInput {
            method: "cash".to_owned(),
            amount_minor: 40_000,
            reference: None,
        }],
        None,
        None,
    )
    .await
    .expect("cash sale");

    // 2. Split sale with credit customer: 3 units × 200 EGP = 600 EGP (60_000 minor)
    //    paid 200 EGP Vodafone Cash + 400 EGP credit (`آجل`).
    let cust = customer_service::create(
        &pool,
        tokens.as_ref(),
        NewCustomer::new("أحمد سمير", Some("01012345678")).expect("customer"),
    )
    .await
    .expect("create customer");

    sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: product_id.clone(),
            quantity: 3,
            warranty_start: None,
            warranty_end: None,
            imei: None,
            color: None,
        }],
        &[
            SalePaymentInput {
                method: "vf".to_owned(),
                amount_minor: 20_000,
                reference: Some("VF-900".to_owned()),
            },
            SalePaymentInput {
                method: "credit".to_owned(),
                amount_minor: 40_000,
                reference: None,
            },
        ],
        Some(cust.id.as_str()),
        None,
    )
    .await
    .expect("split vf + credit sale");

    // 3. Customer pays 150 EGP (15_000 minor) of their credit debt in cash.
    customer_service::record_payment(
        &pool,
        tokens.as_ref(),
        NewCustomerPayment::new(cust.id.as_str(), 15_000, "cash", Some("دفعة كاش"))
            .expect("valid payment"),
    )
    .await
    .expect("record customer cash payment");

    // 4. Record drawer expense: 50 EGP (5_000 minor) for `شاي وضيافة`.
    let after_exp = shift_service::record_expense(
        &pool,
        tokens.as_ref(),
        "شاي وضيافة",
        5_000,
        Some("ضيافة عملاء"),
    )
    .await
    .expect("record expense");
    assert_eq!(after_exp.expenses.len(), 1);
    assert_eq!(after_exp.totals.expenses_minor, 5_000);

    // 5. Record cash movements: +100 EGP (`cash_in`) and -250 EGP (`owner_draw`).
    shift_service::record_cash_movement(&pool, tokens.as_ref(), "cash_in", 10_000, "فكة للدرج")
        .await
        .expect("record cash_in");
    let summary = shift_service::record_cash_movement(
        &pool,
        tokens.as_ref(),
        "owner_draw",
        25_000,
        "سحب المالك",
    )
    .await
    .expect("record owner_draw");

    // Verify computed totals:
    // - opening: 100_000 (1,000 EGP)
    // - cash sales: 40_000 (400 EGP)
    // - vf sales: 20_000 (200 EGP)
    // - credit sales: 40_000 (400 EGP)
    // - total sales: 100_000 (1,000 EGP), total cost: 5 * 120 = 600 EGP (60_000 minor)
    // - customer cash in: 15_000 (150 EGP)
    // - cash_in movement: 10_000 (100 EGP)
    // - owner_draw movement: 25_000 (250 EGP)
    // - expenses: 5_000 (50 EGP)
    // - expected drawer cash = 100_000 + 40_000 + 15_000 + 10_000 - 5_000 - 25_000 = 135_000 (1,350 EGP)
    // - gross profit = 100_000 - 60_000 = 40_000 (400 EGP)
    // - net profit = 40_000 - 5_000 = 35_000 (350 EGP)
    assert_eq!(summary.totals.opening_cash_minor, 100_000);
    assert_eq!(summary.totals.cash_sales_minor, 40_000);
    assert_eq!(summary.totals.vf_sales_minor, 20_000);
    assert_eq!(summary.totals.credit_sales_minor, 40_000);
    assert_eq!(summary.totals.sales_total_minor, 100_000);
    assert_eq!(summary.totals.sales_cost_minor, 60_000);
    assert_eq!(summary.totals.sales_count, 2);
    assert_eq!(summary.totals.customer_cash_in_minor, 15_000);
    assert_eq!(summary.totals.cash_in_minor, 10_000);
    assert_eq!(summary.totals.owner_draw_minor, 25_000);
    assert_eq!(summary.totals.expenses_minor, 5_000);
    assert_eq!(summary.totals.expected_cash_minor, 135_000);
    assert_eq!(summary.totals.gross_profit_minor, 40_000);
    assert_eq!(summary.totals.net_profit_minor, 35_000);
}

#[tokio::test]
async fn seller_shift_close_permission_and_sequential_shift_lifecycle_work_end_to_end() {
    let (pool, tokens, manager_uid, seller_uid, _product_id) = setup_shop().await;

    // Seller logs in and opens Shift #1 with 1,000 EGP (100_000 minor).
    auth::login(&pool, tokens.as_ref(), seller_uid, PASSWORD)
        .await
        .expect("seller login");
    shift_service::open_shift(&pool, tokens.as_ref(), 100_000)
        .await
        .expect("seller opens shift #1");

    // By default (`ui.seller_can_close_shift == "off"`), seller cannot close the shift.
    let refused = shift_service::close_shift(&pool, tokens.as_ref(), 100_000, None).await;
    assert_eq!(
        refused.err().map(|e| e.code()),
        Some("SHIFT_CLOSE_FORBIDDEN_FOR_SELLER")
    );

    // Owner logs in and enables `ui.seller_can_close_shift = "on"`.
    auth::login(&pool, tokens.as_ref(), manager_uid, PASSWORD)
        .await
        .expect("manager login");
    appearance::update(&pool, tokens.as_ref(), "ui.seller_can_close_shift", "on")
        .await
        .expect("enable seller_can_close_shift");

    // Seller logs back in and closes Shift #1 with counted cash 990 EGP (99_000 minor -> -10 EGP shortage).
    auth::login(&pool, tokens.as_ref(), seller_uid, PASSWORD)
        .await
        .expect("seller login");
    let closed = shift_service::close_shift(
        &pool,
        tokens.as_ref(),
        99_000,
        Some("عجز 10 ج فكة"),
    )
    .await
    .expect("seller closes shift #1");

    assert_eq!(closed.shift.shift_number, 1);
    assert_eq!(closed.shift.status.as_str(), "closed");
    assert_eq!(closed.shift.expected_cash_minor, Some(100_000));
    assert_eq!(
        closed.shift.counted_cash.map(|c| c.as_minor()),
        Some(99_000)
    );
    assert_eq!(closed.shift.difference_minor, Some(-1_000));
    assert_eq!(
        closed.shift.close_note.as_ref().map(|n| n.as_str()),
        Some("عجز 10 ج فكة")
    );

    // Current shift state now shows `open_shift = None` and `last_closed_shift = Some(#1)`.
    let state = shift_service::current_shift_summary(&pool, tokens.as_ref())
        .await
        .expect("current_shift_summary after close");
    assert!(state.open_shift.is_none());
    assert_eq!(
        state
            .last_closed_shift
            .as_ref()
            .and_then(|s| s.counted_cash.map(|c| c.as_minor())),
        Some(99_000)
    );

    // Opening the next shift creates Shift #2.
    let shift2 = shift_service::open_shift(&pool, tokens.as_ref(), 99_000)
        .await
        .expect("open shift #2");
    assert_eq!(shift2.shift.shift_number, 2);

    // Audit trail recorded all events.
    let mut conn = pool.acquire().await.expect("conn");
    assert_eq!(
        audit::count_by_type(&mut conn, audit::event::SHIFT_OPENED)
            .await
            .expect("count shift_opened"),
        2
    );
    assert_eq!(
        audit::count_by_type(&mut conn, audit::event::SHIFT_CLOSED)
            .await
            .expect("count shift_closed"),
        1
    );
}
