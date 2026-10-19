//! Plan item 1.10 (`ADR-025`): shop wallets (`wallets`), wallet & services
//! ledger (`wallet_ops`), live wallet balances including invoice sales paid by
//! wallet, owner wallet movements/reconciliation/voiding, and shift drawer
//! reconciliation integration.

use std::sync::Arc;

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::identity::audit;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::{Role, Sensitivity, UserId};
use mobile_shop_system_lib::domain::sales::SalePaymentInput;
use mobile_shop_system_lib::domain::wallet::{WalletPayMethod, MAX_WALLET_COMPANY_CHARS};
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, pin, session, users};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales, SaleLineWithUnitInput};
use mobile_shop_system_lib::services::shift as shift_service;
use mobile_shop_system_lib::services::wallet::{self as wallet_service, UpdateWalletInput};
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
async fn wallet_balance_and_shift_drawer_reflect_deposits_withdrawals_bills_software_and_sales() {
    let (pool, tokens, _manager_uid, _seller_uid, product_id) = setup_shop().await;

    // 1. Seeded 5 shop wallets exist (`vf`, `et`, `or`, `we`, `ip`).
    let initial = wallet_service::wallets_overview(&pool, tokens.as_ref(), 0, 0, i64::MAX, None, 50)
        .await
        .expect("initial wallets overview");
    assert_eq!(initial.wallets.len(), 5);

    // 2. Owner sets Vodafone Cash opening balance to 15,000 EGP (1_500_000 minor).
    wallet_service::update_wallet(
        &pool,
        tokens.as_ref(),
        UpdateWalletInput {
            wallet_id: "vf".to_owned(),
            name: "فودافون كاش".to_owned(),
            number: "01001234567".to_owned(),
            color: "#e60000".to_owned(),
            opening_balance_minor: 1_500_000,
            min_alert_minor: 300_000,
            max_limit_minor: 9_000_000,
            daily_limit_minor: 6_000_000,
            pay_method: Some("vf".to_owned()),
            company: None,
            sort: 1,
            hidden: false,
        },
    )
    .await
    .expect("update vf wallet");

    // 3. Open shift #1 with 1,000 EGP (100_000 minor).
    shift_service::open_shift(&pool, tokens.as_ref(), 100_000)
        .await
        .expect("open shift");

    // 4. Customer deposit of 1,000 EGP on `vf` with 10 EGP commission (no customer phone required):
    //    `vf` balance: 15,000 - 1,000 = 14,000 EGP; drawer: +1,010 EGP.
    wallet_service::record_wallet_op(
        &pool,
        tokens.as_ref(),
        "vf",
        "deposit",
        100_000,
        1_000,
        Some("تحويل سريع"),
    )
    .await
    .expect("record deposit");

    // 5. Deposit exceeding wallet balance is refused (`WALLET_INSUFFICIENT_BALANCE`).
    let over = wallet_service::record_wallet_op(
        &pool,
        tokens.as_ref(),
        "vf",
        "deposit",
        2_000_000,
        500,
        None,
    )
    .await
    .expect_err("deposit exceeding balance must fail");
    assert_eq!(over.code(), "WALLET_INSUFFICIENT_BALANCE");

    // 6. Customer withdrawal of 500 EGP on `vf` with 5 EGP commission:
    //    `vf` balance: 14,000 + 500 = 14,500 EGP; drawer: -495 EGP.
    let wit_op = wallet_service::record_wallet_op(
        &pool,
        tokens.as_ref(),
        "vf",
        "withdraw",
        50_000,
        500,
        None,
    )
    .await
    .expect("record withdrawal");

    // 7. Bill payment (200 EGP + 5 EGP fee) and software service (150 EGP fee):
    //    drawer: +205 EGP + 150 EGP = +355 EGP; service fees: +155 EGP.
    wallet_service::record_service_op(
        &pool,
        tokens.as_ref(),
        "bill",
        "net",
        Some("0223456789"),
        20_000,
        500,
        None,
    )
    .await
    .expect("record bill");

    wallet_service::record_service_op(
        &pool,
        tokens.as_ref(),
        "software",
        "فورمات وتحديث",
        None,
        0,
        15_000,
        None,
    )
    .await
    .expect("record software");

    // 8. Owner tops up `et` from drawer by 300 EGP:
    //    `et` balance: +300 EGP; drawer: -300 EGP.
    wallet_service::record_wallet_movement(
        &pool,
        tokens.as_ref(),
        "topup",
        "et",
        None,
        Some("drawer"),
        30_000,
        Some("شحن اتصالات"),
    )
    .await
    .expect("topup et from drawer");

    // 9. Sale paid via Vodafone Cash (`vf`, 200 EGP) automatically increases `vf` wallet balance!
    sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        None,
        Some(&[SalePaymentInput {
            method: "vf".to_owned(),
            amount_minor: 20_000,
            reference: None,
        }]),
        None,
    )
    .await
    .expect("sale paid by vf");

    let overview = wallet_service::wallets_overview(&pool, tokens.as_ref(), 0, 0, i64::MAX, None, 50)
        .await
        .expect("overview after ops");
    let vf = overview
        .wallets
        .iter()
        .find(|w| w.wallet.id.as_str() == "vf")
        .expect("vf wallet");
    // vf = 15,000 - 1,000 + 500 + 200 (sale) = 14,700 EGP (1_470_000 minor)
    assert_eq!(vf.balance_minor, 1_470_000);
    assert_eq!(vf.period.sales_in_minor, 20_000);

    // 10. Shift summary reflects services & wallet drawer movements:
    //     opening (1,000) + services_in (1,010 + 205 + 150 = 1,365) - services_out (495)
    //     + wallet_drawer (-300) = 1,570 EGP (157_000 minor).
    //     Services fees = 10 + 5 + 5 + 150 = 170 EGP (17_000 minor).
    let shift_state = shift_service::current_shift_summary(&pool, tokens.as_ref())
        .await
        .expect("shift summary");
    let totals = &shift_state.open_shift.as_ref().unwrap().totals;
    assert_eq!(totals.services_count, 4);
    assert_eq!(totals.services_fee_minor, 17_000);
    assert_eq!(totals.services_cash_in_minor, 136_500);
    assert_eq!(totals.services_cash_out_minor, 49_500);
    assert_eq!(totals.wallet_drawer_net_minor, -30_000);
    assert_eq!(totals.expected_cash_minor, 157_000);

    // 11. Voiding the 500 EGP withdrawal reverses its effect on `vf` balance and drawer while keeping the row!
    let voided = wallet_service::void_wallet_op(
        &pool,
        tokens.as_ref(),
        wit_op.id.as_str(),
        "اتسجّلت بالغلط",
    )
    .await
    .expect("void withdrawal");
    assert!(voided.is_voided());
    assert_eq!(voided.void_reason.as_deref(), Some("اتسجّلت بالغلط"));

    let overview_after_void =
        wallet_service::wallets_overview(&pool, tokens.as_ref(), 0, 0, i64::MAX, None, 50)
            .await
            .expect("overview after void");
    let vf_after = overview_after_void
        .wallets
        .iter()
        .find(|w| w.wallet.id.as_str() == "vf")
        .unwrap();
    // 14,700 - 500 = 14,200 EGP (1_420_000 minor)
    assert_eq!(vf_after.balance_minor, 1_420_000);

    let mut conn = pool.acquire().await.expect("acquire");
    assert_eq!(
        audit::count_by_type(&mut conn, audit::event::WALLET_OP_VOIDED)
            .await
            .unwrap(),
        1
    );
}

#[tokio::test]
async fn wallet_reconciliation_custom_wallet_lifecycle_and_immutability_triggers() {
    let (pool, tokens, _manager_uid, seller_uid, _product_id) = setup_shop().await;

    // 1. Owner creates a custom wallet, reconciles it, and verifies deletion rules.
    let custom = wallet_service::create_wallet(
        &pool,
        tokens.as_ref(),
        "حساب بنك مصر",
        "#1d4f91",
        Some("BM-100"),
    )
    .await
    .expect("create custom wallet");
    assert!(custom.is_custom);

    // Unused custom wallet can be deleted; default wallet (`vf`) cannot.
    let del_default = wallet_service::delete_wallet(&pool, tokens.as_ref(), "vf")
        .await
        .expect_err("default wallet cannot be deleted");
    assert_eq!(del_default.code(), "WALLET_DELETE_FORBIDDEN");

    // Reconcile `et` from 0 to 1,250 EGP -> records `adjust` op (+125_000 minor).
    let adj = wallet_service::reconcile_wallet(
        &pool,
        tokens.as_ref(),
        "et",
        125_000,
        "عملية ماتسجّلتش",
        Some("مراجعة التطبيق"),
    )
    .await
    .expect("reconcile et")
    .expect("adjustment op created");
    assert_eq!(adj.amount_minor, 125_000);

    // Seller cannot run owner-only wallet movements or void operations.
    auth::login(&pool, tokens.as_ref(), seller_uid, PASSWORD)
        .await
        .expect("seller login");
    let seller_void = wallet_service::void_wallet_op(&pool, tokens.as_ref(), adj.id.as_str(), "سبب")
        .await
        .expect_err("seller cannot void wallet op");
    assert_eq!(seller_void.code(), "PERMISSION_DENIED");

    // Database triggers forbid deleting `wallet_ops` rows directly.
    let del_op = sqlx::query("DELETE FROM wallet_ops WHERE id = ?1")
        .bind(adj.id.as_str())
        .execute(&pool)
        .await;
    assert!(del_op.is_err(), "wallet_ops must be append-only");
}

/// `ADR-040`: one company, two numbers. The second must not take the payment method away from
/// the first, and the money of a sale must land on exactly one of them.
#[tokio::test]
async fn two_numbers_of_one_company_keep_their_own_money() {
    let (pool, tokens, _manager_uid, _seller_uid, product_id) = setup_shop().await;

    let second = wallet_service::create_wallet(
        &pool,
        tokens.as_ref(),
        "فودافون كاش ٢",
        "#e60000",
        Some("01009999999"),
        Some("  فودافون كاش  "),
    )
    .await
    .expect("a second number of the same company");
    assert_eq!(
        second.company.as_deref(),
        Some("فودافون كاش"),
        "the company label is trimmed as it is stored"
    );

    let overview = wallet_service::wallets_overview(&pool, tokens.as_ref(), 0, 0, i64::MAX, None, 50)
        .await
        .expect("overview");
    let vf = overview
        .wallets
        .iter()
        .find(|s| s.wallet.id.as_str() == "vf")
        .expect("the seeded Vodafone wallet");
    assert_eq!(
        vf.wallet.pay_method,
        Some(WalletPayMethod::Vf),
        "creating another number of the same company must leave the first one linked"
    );

    sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        None,
        Some(&[SalePaymentInput {
            method: "vf".to_owned(),
            amount_minor: 20_000,
            reference: None,
        }]),
        None,
    )
    .await
    .expect("a sale paid to Vodafone Cash");

    let after = wallet_service::wallets_overview(&pool, tokens.as_ref(), 0, 0, i64::MAX, None, 50)
        .await
        .expect("overview after the sale");
    let first_now = after
        .wallets
        .iter()
        .find(|s| s.wallet.id.as_str() == "vf")
        .expect("the seeded Vodafone wallet");
    let second_now = after
        .wallets
        .iter()
        .find(|s| s.wallet.id.as_str() == second.id.as_str())
        .expect("the second number");
    assert_eq!(
        first_now.balance_minor - vf.balance_minor,
        20_000,
        "the primary number of the method is where the sale's money went"
    );
    assert_eq!(
        second_now.balance_minor, 0,
        "the other number took none of it — nothing is counted twice"
    );

    let named: String = sqlx::query_scalar(
        "SELECT sp.wallet_id
         FROM sale_payments sp
         INNER JOIN sales s ON s.id = sp.sale_id
         LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .expect("the payment row must name a wallet");
    assert_eq!(named, "vf", "the payment records the wallet that collected it");

    let candidates = wallet_service::payment_wallet_candidates(&pool, tokens.as_ref(), "vf")
        .await
        .expect("the numbers that receive vf sales");
    assert_eq!(candidates.len(), 2, "both numbers receive this method");
    assert_eq!(
        candidates.first().map(|w| w.id.as_str()),
        Some("vf"),
        "the shop's own listing order decides the default"
    );

    // A group nobody can name is worse than no group: blank clears, and the field has a ceiling.
    let too_long = "ش".repeat(MAX_WALLET_COMPANY_CHARS + 1);
    assert!(
        wallet_service::create_wallet(&pool, tokens.as_ref(), "محفظة طويلة", "#0d7377", None, Some(&too_long))
            .await
            .is_err(),
        "a company label past the ceiling is refused, not truncated"
    );
}
