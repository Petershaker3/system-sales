//! Plan item 1.5 (`ADR-020`): invoice payments (`sale_payments`), enabled
//! payment methods (`ui.pay_methods`), split payments, and customer credit
//! ledger (`customer_ledger` for آجل).

use std::sync::Arc;

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::sales as sales_repo;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::customer::{NewCustomer, NewCustomerPayment};
use mobile_shop_system_lib::domain::identity::{Role, Sensitivity};
use mobile_shop_system_lib::domain::sales::SalePaymentInput;
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::customer as customer_service;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{
    approval, auth, bootstrap, pin, session, users,
};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales, SaleLineWithUnitInput};
use mobile_shop_system_lib::services::settings::appearance;
use sqlx::SqlitePool;

const OWNER_PIN: &str = "2580";

async fn shop_with_stocked_item() -> (SqlitePool, Arc<InMemoryTokenStore>, String) {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");
    let catalog_ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let current = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session");
    pin::set_own_pin(&pool, &current, None, OWNER_PIN)
        .await
        .expect("set owner PIN");
    let product = catalog::create(
        &catalog_ctx,
        &current,
        NewProduct {
            name: "شاحن سامسونج 25W".to_string(),
            disposition: Disposition::Quantity,
            barcode: Some("6221000000105".to_string()),
            sale_price_minor: Some(450_00),
            category: None,
        },
    )
    .await
    .expect("create product");
    let product_id = product.id.as_str().to_string();

    inventory::receive(
        &pool,
        tokens.as_ref(),
        &product_id,
        10,
        300_00,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive stock");

    (pool, tokens, product_id)
}

#[tokio::test]
async fn migration_0021_creates_sale_payments_and_customer_ledger_tables() {
    let (pool, _tokens) = fresh().await;
    for table in ["sale_payments", "customer_ledger"] {
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        )
        .bind(table)
        .fetch_one(&pool)
        .await
        .expect("table probe");
        assert_eq!(count, 1, "migration 0021 must create `{table}`");
    }

    let read = appearance::read(&pool).await.expect("appearance");
    assert_eq!(read.pay_methods, "cash,vf,instapay,card,install,credit");
}

#[tokio::test]
async fn disabled_payment_method_is_refused_and_cash_cannot_be_disabled() {
    let (pool, tokens, product_id) = shop_with_stocked_item().await;

    // Cash cannot be disabled.
    let refuse_no_cash =
        appearance::update(&pool, tokens.as_ref(), "ui.pay_methods", "vf,instapay").await;
    assert_eq!(
        refuse_no_cash.err().map(|e| e.code()),
        Some("SETTING_VALUE_INVALID")
    );

    // Owner disables `card` and `install` (leaving `cash,vf,instapay,credit`).
    let updated = appearance::update(
        &pool,
        tokens.as_ref(),
        "ui.pay_methods",
        "cash,vf,instapay,credit",
    )
    .await
    .expect("disable card and install");
    assert_eq!(updated.pay_methods, "cash,vf,instapay,credit");

    // Paying with `card` is refused with `SALE_PAYMENT_METHOD_DISABLED`.
    let refused = sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        Some(450_00),
        Some(&[SalePaymentInput {
            method: "card".to_string(),
            amount_minor: 450_00,
            reference: None,
        }]),
        None,
    )
    .await;
    assert_eq!(
        refused.err().map(|e| e.code()),
        Some("SALE_PAYMENT_METHOD_DISABLED")
    );
}

#[tokio::test]
async fn split_sale_between_cash_and_wallet_reconciles_drawer_and_cancellation_reverses_both() {
    let (pool, tokens, product_id) = shop_with_stocked_item().await;

    // Sell 2 chargers (total 900 EGP): 500 EGP cash + 400 EGP Vodafone Cash.
    let outcome = sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: product_id.clone(),
            quantity: 2,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        Some(900_00),
        Some(&[
            SalePaymentInput {
                method: "cash".to_string(),
                amount_minor: 500_00,
                reference: None,
            },
            SalePaymentInput {
                method: "vf".to_string(),
                amount_minor: 400_00,
                reference: Some("VF-9988".to_string()),
            },
        ]),
        None,
    )
    .await
    .expect("split sale");

    assert_eq!(outcome.total_minor, 900_00);

    {
        let mut conn = pool.acquire().await.expect("conn");
        let payments = sales_repo::list_sale_payments(&mut conn, &outcome.sale_id)
            .await
            .expect("list payments");
        assert_eq!(payments.len(), 2);
        assert_eq!(payments[0].method, "cash");
        assert_eq!(payments[0].amount_minor, 500_00);
        assert_eq!(payments[1].method, "vf");
        assert_eq!(payments[1].amount_minor, 400_00);
        assert_eq!(payments[1].reference.as_deref(), Some("VF-9988"));

        let net = sales_repo::net_paid_by_method(&mut conn)
            .await
            .expect("net paid");
        assert_eq!(
            net,
            vec![
                ("cash".to_string(), 500_00),
                ("vf".to_string(), 400_00)
            ]
        );
    }

    // Cancel the split sale with owner PIN approval; both cash and vf net back to 0.
    let manager_id = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session")
        .user_id();
    approval::approve_with_owner_pin(&pool, tokens.as_ref(), manager_id, OWNER_PIN)
        .await
        .expect("approve cancel");
    sales::cancel_sale(&pool, tokens.as_ref(), &outcome.sale_id, "مرتجع")
        .await
        .expect("cancel split sale");

    let mut conn = pool.acquire().await.expect("conn");
    let net_after = sales_repo::net_paid_by_method(&mut conn)
        .await
        .expect("net after cancel");
    assert_eq!(
        net_after,
        vec![("cash".to_string(), 0), ("vf".to_string(), 0)]
    );
}

#[tokio::test]
async fn credit_sale_requires_customer_updates_customer_balance_and_accepts_repayment() {
    let (pool, tokens, product_id) = shop_with_stocked_item().await;

    // Credit sale without a customer is refused.
    let no_customer = sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        Some(450_00),
        Some(&[SalePaymentInput {
            method: "credit".to_string(),
            amount_minor: 450_00,
            reference: None,
        }]),
        None,
    )
    .await;
    assert_eq!(
        no_customer.err().map(|e| e.code()),
        Some("SALE_CREDIT_REQUIRES_CUSTOMER")
    );

    // Create a customer and record a split sale: 150 EGP cash + 300 EGP credit (آجل).
    let customer = customer_service::create(
        &pool,
        tokens.as_ref(),
        NewCustomer {
            name: "محمود عبد الرحمن".to_string(),
            contact: Some("01012345678".to_string()),
        },
    )
    .await
    .expect("create customer");

    let sale = sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        Some(450_00),
        Some(&[
            SalePaymentInput {
                method: "cash".to_string(),
                amount_minor: 150_00,
                reference: None,
            },
            SalePaymentInput {
                method: "credit".to_string(),
                amount_minor: 300_00,
                reference: None,
            },
        ]),
        Some(&customer.id),
    )
    .await
    .expect("credit split sale");

    // Customer's آجل balance is now 300 EGP.
    let with_bal = customer_service::get_with_balance(&pool, tokens.as_ref(), &customer.id)
        .await
        .expect("get with balance");
    assert_eq!(with_bal.balance_minor, 300_00);

    // Paying more than 300 EGP is refused.
    let overpay = customer_service::record_payment(
        &pool,
        tokens.as_ref(),
        NewCustomerPayment {
            customer_id: customer.id.clone(),
            amount_minor: 350_00,
            method: "cash".to_string(),
            note: None,
        },
    )
    .await;
    assert_eq!(
        overpay.err().map(|e| e.code()),
        Some("CUSTOMER_PAYMENT_EXCEEDS_BALANCE")
    );

    // Customer pays 200 EGP via InstaPay; remaining balance is 100 EGP.
    let after_pay = customer_service::record_payment(
        &pool,
        tokens.as_ref(),
        NewCustomerPayment {
            customer_id: customer.id.clone(),
            amount_minor: 200_00,
            method: "instapay".to_string(),
            note: Some("دفعة تحت الحساب".to_string()),
        },
    )
    .await
    .expect("record customer payment");
    assert_eq!(after_pay.balance_minor, 100_00);

    let ledger = customer_service::list_ledger(&pool, tokens.as_ref(), &customer.id)
        .await
        .expect("list ledger");
    assert_eq!(ledger.len(), 2);
    assert!(ledger.iter().any(|e| e.kind == "credit_sale"
        && e.amount_minor == 300_00
        && e.sale_id.as_deref() == Some(sale.sale_id.as_str())));
    assert!(ledger.iter().any(|e| e.kind == "payment"
        && e.amount_minor == -200_00
        && e.method.as_deref() == Some("instapay")));
}

#[tokio::test]
async fn cancelling_a_credit_sale_restores_customer_balance() {
    let (pool, tokens, product_id) = shop_with_stocked_item().await;
    let customer = customer_service::create(
        &pool,
        tokens.as_ref(),
        NewCustomer {
            name: "سامح فوزي".to_string(),
            contact: Some("01122334455".to_string()),
        },
    )
    .await
    .expect("create customer");

    let sale = sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id,
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        Some(450_00),
        Some(&[SalePaymentInput {
            method: "credit".to_string(),
            amount_minor: 450_00,
            reference: None,
        }]),
        Some(&customer.id),
    )
    .await
    .expect("credit sale");

    assert_eq!(
        customer_service::get_with_balance(&pool, tokens.as_ref(), &customer.id)
            .await
            .expect("balance before cancel")
            .balance_minor,
        450_00
    );

    let manager_id = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("session")
        .user_id();
    approval::approve_with_owner_pin(&pool, tokens.as_ref(), manager_id, OWNER_PIN)
        .await
        .expect("approve cancel");
    sales::cancel_sale(&pool, tokens.as_ref(), &sale.sale_id, "إلغاء فاتورة آجل")
        .await
        .expect("cancel credit sale");

    assert_eq!(
        customer_service::get_with_balance(&pool, tokens.as_ref(), &customer.id)
            .await
            .expect("balance after cancel")
            .balance_minor,
        0
    );
}

#[tokio::test]
async fn instalment_payment_requires_and_records_provider_reference() {
    let (pool, tokens, product_id) = shop_with_stocked_item().await;

    let missing_provider = sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id: product_id.clone(),
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        Some(450_00),
        Some(&[SalePaymentInput {
            method: "install".to_string(),
            amount_minor: 450_00,
            reference: None,
        }]),
        None,
    )
    .await;
    assert_eq!(
        missing_provider.err().map(|e| e.code()),
        Some("SALE_INSTALLMENT_PROVIDER_REQUIRED")
    );

    let ok = sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id,
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        Some(450_00),
        Some(&[SalePaymentInput {
            method: "install".to_string(),
            amount_minor: 450_00,
            reference: Some("valU".to_string()),
        }]),
        None,
    )
    .await
    .expect("instalment sale with valU");

    let mut conn = pool.acquire().await.expect("conn");
    let rows = sales_repo::list_sale_payments(&mut conn, &ok.sale_id)
        .await
        .expect("list payments");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].method, "install");
    assert_eq!(rows[0].reference.as_deref(), Some("valU"));
}

#[tokio::test]
async fn sales_role_can_list_customers_with_balances_and_record_credit_sale() {
    let (pool, tokens, product_id) = shop_with_stocked_item().await;
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauth");
    let manager = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("manager");
    let seller_id = users::create_user(&pool, &manager, "كريم", "karim", Role::Sales, PASSWORD)
        .await
        .expect("create seller");
    auth::login(&pool, tokens.as_ref(), seller_id, PASSWORD)
        .await
        .expect("seller login");

    let created = customer_service::create(
        &pool,
        tokens.as_ref(),
        NewCustomer {
            name: "عمرو حسن".to_string(),
            contact: Some("01200001111".to_string()),
        },
    )
    .await
    .expect("seller creates customer");

    sales::record_sale_with_payments(
        &pool,
        tokens.as_ref(),
        &[SaleLineWithUnitInput {
            product_id,
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
            imei: None,
        }],
        Some(450_00),
        Some(&[SalePaymentInput {
            method: "credit".to_string(),
            amount_minor: 450_00,
            reference: None,
        }]),
        Some(&created.id),
    )
    .await
    .expect("seller records credit sale");

    let listed = customer_service::list_with_balances(&pool, tokens.as_ref())
        .await
        .expect("seller lists customers with balances");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].customer.id, created.id);
    assert_eq!(listed[0].balance_minor, 450_00);
}
