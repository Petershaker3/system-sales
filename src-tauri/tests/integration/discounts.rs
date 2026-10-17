//! Plan item 1.6 (`ADR-021`): line & invoice discounts, configurable seller
//! discount limit (`ui.discount_limit_pct`), and owner PIN approval above limit.

use std::sync::Arc;

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::sales as sales_repo;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::{Role, Sensitivity, UserId};
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{
    approval, auth, bootstrap, pin, session, users,
};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales, SaleLineWithUnitInput};
use mobile_shop_system_lib::services::settings::appearance;
use sqlx::SqlitePool;

const OWNER_PIN: &str = "2580";

async fn setup_shop_with_seller() -> (
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
            sale_price_minor: Some(10_000),
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
        20,
        5_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive stock");

    auth::login(&pool, tokens.as_ref(), seller_uid, PASSWORD)
        .await
        .expect("login as seller");

    (pool, tokens, manager_uid, seller_uid, product_id)
}

#[tokio::test]
async fn seller_applies_line_and_invoice_discount_within_limit_without_approval() {
    let (pool, tokens, _manager_uid, seller_uid, product_id) = setup_shop_with_seller().await;

    // Gross = 2 * 10_000 = 20_000. Default limit = 5% (1_000 max discount).
    // Line discount = 400, invoice discount = 600 => total discount = 1_000 (exact 5%).
    let lines = [SaleLineWithUnitInput {
        product_id: product_id.clone(),
        quantity: 2,
        warranty_start: None,
        warranty_end: None,
        imei: None,
    }];
    let outcome = sales::record_sale_with_discounts(
        &pool,
        tokens.as_ref(),
        &lines,
        Some(19_000),
        None,
        None,
        600,
        &[400],
    )
    .await
    .expect("5% discount should not need owner approval");

    assert_eq!(outcome.total_minor, 19_000);

    let mut conn = pool.acquire().await.expect("acquire");
    let stored_sale = sales_repo::find_sale(&mut conn, &outcome.sale_id)
        .await
        .expect("find sale")
        .expect("sale exists");
    assert_eq!(stored_sale.sold_by, seller_uid.as_str());
    assert_eq!(stored_sale.total_minor, 19_000);
    assert_eq!(stored_sale.discount_minor, 1_000);
    assert_eq!(stored_sale.approved_by, None);

    let stored_lines = sales_repo::list_lines(&mut conn, &outcome.sale_id)
        .await
        .expect("list lines");
    assert_eq!(stored_lines.len(), 1);
    assert_eq!(stored_lines[0].discount_minor, 400);
    assert_eq!(stored_lines[0].line_total_minor, 19_600);
}

#[tokio::test]
async fn discount_above_limit_requires_owner_pin_approval_and_records_approved_by() {
    let (pool, tokens, manager_uid, _seller_uid, product_id) = setup_shop_with_seller().await;

    // Gross = 10_000. Discount = 600 (6% > 5% limit).
    let lines = [SaleLineWithUnitInput {
        product_id: product_id.clone(),
        quantity: 1,
        warranty_start: None,
        warranty_end: None,
        imei: None,
    }];

    let refused = sales::record_sale_with_discounts(
        &pool,
        tokens.as_ref(),
        &lines,
        Some(9_400),
        None,
        None,
        600,
        &[0],
    )
    .await
    .expect_err("6% discount without owner approval must be refused");
    assert_eq!(refused.code(), "OWNER_APPROVAL_REQUIRED");

    approval::approve_with_owner_pin(&pool, tokens.as_ref(), manager_uid, OWNER_PIN)
        .await
        .expect("owner grants PIN approval");

    let outcome = sales::record_sale_with_discounts(
        &pool,
        tokens.as_ref(),
        &lines,
        Some(9_400),
        None,
        None,
        600,
        &[0],
    )
    .await
    .expect("approved 6% discount succeeds");
    assert_eq!(outcome.total_minor, 9_400);

    let mut conn = pool.acquire().await.expect("acquire");
    let stored_sale = sales_repo::find_sale(&mut conn, &outcome.sale_id)
        .await
        .expect("find sale")
        .expect("sale exists");
    assert_eq!(stored_sale.discount_minor, 600);
    assert_eq!(
        stored_sale.approved_by.as_deref(),
        Some(manager_uid.as_str().as_str())
    );

    // The approval was single-use: a second above-limit sale without a fresh grant is refused.
    let second = sales::record_sale_with_discounts(
        &pool,
        tokens.as_ref(),
        &lines,
        Some(9_400),
        None,
        None,
        600,
        &[0],
    )
    .await
    .expect_err("consumed approval cannot be reused");
    assert_eq!(second.code(), "OWNER_APPROVAL_REQUIRED");
}

#[tokio::test]
async fn owner_changes_discount_limit_in_settings_and_invalid_values_are_refused() {
    let (pool, tokens, manager_uid, seller_uid, product_id) = setup_shop_with_seller().await;

    // Seller cannot change `ui.discount_limit_pct`.
    let seller_refused = appearance::update(&pool, tokens.as_ref(), "ui.discount_limit_pct", "15")
        .await
        .expect_err("seller cannot change discount limit");
    assert_eq!(seller_refused.code(), "PERMISSION_DENIED");

    // Sign in as owner and update to 20%.
    auth::login(&pool, tokens.as_ref(), manager_uid, PASSWORD)
        .await
        .expect("login manager");
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate manager");

    for bad in ["-1", "101", "5.5", "abc", ""] {
        let err = appearance::update(&pool, tokens.as_ref(), "ui.discount_limit_pct", bad)
            .await
            .expect_err("invalid discount limit must be refused");
        assert_eq!(err.code(), "SETTING_VALUE_INVALID", "bad={bad}");
    }

    let updated = appearance::update(&pool, tokens.as_ref(), "ui.discount_limit_pct", "20")
        .await
        .expect("set limit to 20%");
    assert_eq!(updated.discount_limit_pct, "20");
    assert_eq!(updated.discount_limit_pct_num(), 20);

    // Switch back to seller: 15% discount (1_500 on 10_000) now succeeds without approval.
    auth::login(&pool, tokens.as_ref(), seller_uid, PASSWORD)
        .await
        .expect("login seller");
    let lines = [SaleLineWithUnitInput {
        product_id: product_id.clone(),
        quantity: 1,
        warranty_start: None,
        warranty_end: None,
        imei: None,
    }];
    let outcome = sales::record_sale_with_discounts(
        &pool,
        tokens.as_ref(),
        &lines,
        Some(8_500),
        None,
        None,
        1_500,
        &[0],
    )
    .await
    .expect("15% discount within 20% limit succeeds");
    assert_eq!(outcome.total_minor, 8_500);
}

#[tokio::test]
async fn invalid_discounts_are_refused_and_cancelling_copies_discounts_to_reversal() {
    let (pool, tokens, manager_uid, _seller_uid, product_id) = setup_shop_with_seller().await;

    let lines = [SaleLineWithUnitInput {
        product_id: product_id.clone(),
        quantity: 1,
        warranty_start: None,
        warranty_end: None,
        imei: None,
    }];

    for (inv_disc, line_disc) in [(-1, 0), (0, -1), (0, 10_001), (9_601, 500)] {
        let err = sales::record_sale_with_discounts(
            &pool,
            tokens.as_ref(),
            &lines,
            None,
            None,
            None,
            inv_disc,
            &[line_disc],
        )
        .await
        .expect_err("invalid discount must fail");
        assert_eq!(err.code(), "SALE_DISCOUNT_INVALID");
    }

    // Record a valid discounted sale (line 200 + invoice 300 = 500) and cancel it as manager.
    let sale = sales::record_sale_with_discounts(
        &pool,
        tokens.as_ref(),
        &lines,
        Some(9_500),
        None,
        None,
        300,
        &[200],
    )
    .await
    .expect("record discounted sale");

    auth::login(&pool, tokens.as_ref(), manager_uid, PASSWORD)
        .await
        .expect("login manager");
    approval::approve_with_owner_pin(&pool, tokens.as_ref(), manager_uid, OWNER_PIN)
        .await
        .expect("grant cancel approval");

    let reversal =
        sales::cancel_sale(&pool, tokens.as_ref(), &sale.sale_id, "customer changed mind")
            .await
            .expect("cancel discounted sale");

    let mut conn = pool.acquire().await.expect("acquire");
    let rev_sale = sales_repo::find_sale(&mut conn, &reversal.sale_id)
        .await
        .expect("find reversal")
        .expect("reversal exists");
    assert_eq!(rev_sale.discount_minor, 500);
    assert_eq!(
        rev_sale.approved_by.as_deref(),
        Some(manager_uid.as_str().as_str())
    );

    let rev_lines = sales_repo::list_lines(&mut conn, &reversal.sale_id)
        .await
        .expect("list reversal lines");
    assert_eq!(rev_lines[0].discount_minor, 200);
    assert_eq!(rev_lines[0].line_total_minor, 9_800);
}
