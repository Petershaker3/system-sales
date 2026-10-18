//! Plan item 1.11 (`ADR-026`): partial & full line returns at original line cost,
//! damaged stock bucket (`damaged_stock`), exchanges (`record_sale_exchange`),
//! and default refund allocation across drawer, wallets, and customer credit.

use std::sync::Arc;

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::inventory::stock as stock_repo;
use mobile_shop_system_lib::data::repositories::sales as sales_repo;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::{DomainError, Role, Sensitivity, UserId};
use mobile_shop_system_lib::domain::sales::{SalePaymentInput, SaleReturnLineInput};
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{
    approval, auth, bootstrap, pin, session, users,
};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{
    self as sales, SaleLineWithUnitInput, SaleServiceError,
};
use mobile_shop_system_lib::services::shift;
use sqlx::SqlitePool;

const OWNER_PIN: &str = "2580";

async fn setup_shop_for_returns() -> (
    SqlitePool,
    Arc<InMemoryTokenStore>,
    UserId,
    UserId,
    String,
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
            sale_price_minor: Some(20_000), // 200 EGP
            category: None,
        },
    )
    .await
    .expect("create cable");
    let cable_id = cable.id.as_str().to_string();

    let charger = catalog::create(
        &ctx,
        &manager_session,
        NewProduct {
            name: "Samsung 25W Charger".to_owned(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(35_000), // 350 EGP
            category: None,
        },
    )
    .await
    .expect("create charger");
    let charger_id = charger.id.as_str().to_string();

    inventory::receive(
        &pool,
        tokens.as_ref(),
        &cable_id,
        10,
        12_000, // 120 EGP cost
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive cable stock");

    inventory::receive(
        &pool,
        tokens.as_ref(),
        &charger_id,
        10,
        22_000, // 220 EGP cost
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive charger stock");

    auth::login(&pool, tokens.as_ref(), seller_uid, PASSWORD)
        .await
        .expect("login as seller");

    (pool, tokens, manager_uid, seller_uid, cable_id, charger_id)
}

#[tokio::test]
async fn partial_return_requires_owner_pin_and_restores_intact_stock_at_original_cost() {
    let (pool, tokens, manager_uid, _seller_uid, cable_id, _charger_id) =
        setup_shop_for_returns().await;

    shift::open_shift(&pool, tokens.as_ref(), 100_000)
        .await
        .expect("open shift");

    let sale_lines = [SaleLineWithUnitInput {
        product_id: cable_id.clone(),
        quantity: 3,
        warranty_start: None,
        warranty_end: None,
        imei: None,
    }];
    let sale = sales::record_sale_with_discounts(
        &pool,
        tokens.as_ref(),
        &sale_lines,
        Some(60_000),
        None,
        None,
        0,
        &[0],
    )
    .await
    .expect("record sale of 3 cables");

    let info = sales::inspect_sale_for_return(&pool, tokens.as_ref(), &sale.reference)
        .await
        .expect("inspect sale");
    assert_eq!(info.lines.len(), 1);
    assert_eq!(info.lines[0].remaining_qty, 3);
    // Seller must not see wholesale cost in inspection!
    assert_eq!(info.lines[0].unit_cost_minor, None);
    let line_id = info.lines[0].line_id.clone();

    // Without owner PIN approval, return is refused with OwnerApprovalRequired.
    let err = sales::record_sale_return(
        &pool,
        tokens.as_ref(),
        &sale.sale_id,
        &[SaleReturnLineInput {
            sale_line_id: line_id.clone(),
            quantity: 1,
            condition: "intact".to_owned(),
        }],
        "رغبة العميل",
        None,
    )
    .await
    .expect_err("must require owner approval");
    assert!(matches!(
        err,
        SaleServiceError::Identity(DomainError::OwnerApprovalRequired)
    ));

    // Grant owner PIN approval and return 1 intact cable.
    approval::approve_with_owner_pin(&pool, tokens.as_ref(), manager_uid, OWNER_PIN)
        .await
        .expect("owner approves return");

    let ret1 = sales::record_sale_return(
        &pool,
        tokens.as_ref(),
        &sale.sale_id,
        &[SaleReturnLineInput {
            sale_line_id: line_id.clone(),
            quantity: 1,
            condition: "intact".to_owned(),
        }],
        "رغبة العميل",
        None,
    )
    .await
    .expect("record partial return of 1 cable");

    assert_eq!(ret1.refund_minor, 20_000);
    assert_eq!(ret1.cost_returned_minor, 12_000);
    assert_eq!(ret1.damaged_cost_minor, 0);

    // Check stock position: 10 received - 3 sold + 1 returned intact = 8 in stock @ 96,000 minor.
    let mut conn = pool.acquire().await.expect("conn");
    let pos = stock_repo::find_position(&mut conn, &cable_id)
        .await
        .expect("find pos")
        .expect("pos exists");
    assert_eq!(pos.quantity, 8);
    assert_eq!(pos.total_cost_minor, Some(96_000));
    let sum_delta = sales_repo::sum_quantity_delta(&mut conn, &cable_id)
        .await
        .expect("sum delta");
    assert_eq!(sum_delta, 8);
    drop(conn);

    // Check shift drawer cash: 1,000 opening + 600 sale - 200 refund = 1,400 EGP (140_000 minor).
    let shift_summary = shift::current_shift_summary(&pool, tokens.as_ref())
        .await
        .expect("shift summary");
    let open = shift_summary.open_shift.expect("open shift");
    assert_eq!(open.totals.cash_sales_minor, 40_000);
    assert_eq!(open.totals.expected_cash_minor, 140_000);
}

#[tokio::test]
async fn damaged_return_routes_to_damaged_stock_and_does_not_restore_sellable_stock() {
    let (pool, tokens, manager_uid, _seller_uid, cable_id, _charger_id) =
        setup_shop_for_returns().await;

    let sale_lines = [SaleLineWithUnitInput {
        product_id: cable_id.clone(),
        quantity: 2,
        warranty_start: None,
        warranty_end: None,
        imei: None,
    }];
    let sale = sales::record_sale_with_discounts(
        &pool,
        tokens.as_ref(),
        &sale_lines,
        Some(40_000),
        None,
        None,
        0,
        &[0],
    )
    .await
    .expect("record sale of 2 cables");

    let info = sales::inspect_sale_for_return(&pool, tokens.as_ref(), &sale.sale_id)
        .await
        .expect("inspect sale");
    let line_id = info.lines[0].line_id.clone();

    approval::approve_with_owner_pin(&pool, tokens.as_ref(), manager_uid, OWNER_PIN)
        .await
        .expect("owner approves damaged return");

    let ret = sales::record_sale_return(
        &pool,
        tokens.as_ref(),
        &sale.sale_id,
        &[SaleReturnLineInput {
            sale_line_id: line_id.clone(),
            quantity: 1,
            condition: "damaged".to_owned(),
        }],
        "سلك مقطوع - عيب صناعة",
        None,
    )
    .await
    .expect("record damaged return");

    assert_eq!(ret.refund_minor, 20_000);
    assert_eq!(ret.cost_returned_minor, 0);
    assert_eq!(ret.damaged_cost_minor, 12_000);

    // Sellable stock must remain at 8 (10 received - 2 sold; damaged item does NOT return to stock_levels).
    let mut conn = pool.acquire().await.expect("conn");
    let pos = stock_repo::find_position(&mut conn, &cable_id)
        .await
        .expect("find pos")
        .expect("pos exists");
    assert_eq!(pos.quantity, 8);
    assert_eq!(pos.total_cost_minor, Some(96_000));
    drop(conn);

    // Seller calling list_damaged_stock sees quantity & reason, but cost is masked to 0.
    let seller_damaged = sales::list_damaged_stock(&pool, tokens.as_ref(), None)
        .await
        .expect("seller list damaged");
    assert_eq!(seller_damaged.len(), 1);
    assert_eq!(seller_damaged[0].quantity, 1);
    assert_eq!(seller_damaged[0].total_cost_minor, 0);

    // Owner sees actual original cost in damaged_stock.
    auth::login(&pool, tokens.as_ref(), manager_uid, PASSWORD)
        .await
        .expect("login as manager");
    let owner_damaged = sales::list_damaged_stock(&pool, tokens.as_ref(), None)
        .await
        .expect("owner list damaged");
    assert_eq!(owner_damaged.len(), 1);
    assert_eq!(owner_damaged[0].total_cost_minor, 12_000);
}

#[tokio::test]
async fn exchange_executes_return_and_replacement_sale_in_one_atomic_operation() {
    let (pool, tokens, manager_uid, _seller_uid, cable_id, charger_id) =
        setup_shop_for_returns().await;

    let sale_lines = [SaleLineWithUnitInput {
        product_id: cable_id.clone(),
        quantity: 1,
        warranty_start: None,
        warranty_end: None,
        imei: None,
    }];
    let sale = sales::record_sale_with_discounts(
        &pool,
        tokens.as_ref(),
        &sale_lines,
        Some(20_000),
        None,
        None,
        0,
        &[0],
    )
    .await
    .expect("record sale of 1 cable");

    let info = sales::inspect_sale_for_return(&pool, tokens.as_ref(), &sale.sale_id)
        .await
        .expect("inspect sale");
    let line_id = info.lines[0].line_id.clone();

    approval::approve_with_owner_pin(&pool, tokens.as_ref(), manager_uid, OWNER_PIN)
        .await
        .expect("owner approves exchange");

    let new_lines = [SaleLineWithUnitInput {
        product_id: charger_id.clone(),
        quantity: 1,
        warranty_start: None,
        warranty_end: None,
        imei: None,
    }];
    let exchange = sales::record_sale_exchange(
        &pool,
        tokens.as_ref(),
        &sale.sale_id,
        &[SaleReturnLineInput {
            sale_line_id: line_id,
            quantity: 1,
            condition: "intact".to_owned(),
        }],
        "استبدال بشاحن 25W",
        None,
        &new_lines,
        &[0],
        0,
        Some(&[SalePaymentInput {
            method: "cash".to_owned(),
            amount_minor: 35_000,
            reference: None,
        }]),
        None,
    )
    .await
    .expect("record exchange");

    assert_eq!(exchange.return_outcome.refund_minor, 20_000);
    assert_eq!(exchange.sale_outcome.total_minor, 35_000);
    // Customer pays 150 EGP difference (350 - 200).
    assert_eq!(exchange.net_difference_minor, 15_000);

    // Cable stock restored to 10; Charger stock reduced to 9.
    let mut conn = pool.acquire().await.expect("conn");
    let cable_pos = stock_repo::find_position(&mut conn, &cable_id)
        .await
        .expect("cable pos")
        .expect("exists");
    let charger_pos = stock_repo::find_position(&mut conn, &charger_id)
        .await
        .expect("charger pos")
        .expect("exists");
    assert_eq!(cable_pos.quantity, 10);
    assert_eq!(charger_pos.quantity, 9);
}
