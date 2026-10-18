//! Plan item 2.1 (`ADR-031`): Repairs & Software (`الصيانة والسوفت وير`) +
//! customer credit repayment wallet balance sync.

use std::sync::Arc;

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::customer::{NewCustomer, NewCustomerPayment};
use mobile_shop_system_lib::domain::identity::{Role, Sensitivity, UserId};
use mobile_shop_system_lib::domain::sales::SalePaymentInput;
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::customer as customer_service;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::repair::{
    self as repair_service, CreateRepairInput, DeliverRepairInput, UpdateRepairStatusInput,
};
use mobile_shop_system_lib::services::sales::{self as sales, SaleLineWithUnitInput};
use mobile_shop_system_lib::services::shift as shift_service;
use mobile_shop_system_lib::services::wallet::{self as wallet_service, UpdateWalletInput};
use sqlx::SqlitePool;

async fn setup_shop_for_repairs() -> (
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
    let item = catalog::create(
        &ctx,
        &manager_session,
        NewProduct {
            name: "Samsung A15 Screen".to_owned(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(900_00),
            category: None,
        },
    )
    .await
    .expect("create product");
    let product_id = item.id.as_str().to_string();

    inventory::receive(
        &pool,
        tokens.as_ref(),
        &product_id,
        10,
        500_00,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive stock");

    (pool, tokens, manager_uid, seller_uid, product_id)
}

#[tokio::test]
async fn hardware_and_software_repairs_track_kanban_stages_and_separate_money_buckets() {
    let (pool, tokens, manager_uid, seller_uid, _product_id) = setup_shop_for_repairs().await;

    // 1. Hardware ticket #1: Samsung A54 screen replacement with 500 EGP cash deposit
    //    assigned to hardware technician "م. حسن".
    let hw1 = repair_service::create_repair(
        &pool,
        tokens.as_ref(),
        CreateRepairInput {
            service_kind: "hardware".to_owned(),
            customer_name: "أحمد عبد العزيز".to_owned(),
            customer_phone: "01012345678".to_owned(),
            device_name: "سامسونج A54".to_owned(),
            imei: Some("356789012345678".to_owned()),
            device_lock: Some("رمز 2580".to_owned()),
            issue: "تغيير شاشة أصلية".to_owned(),
            accessories: Some("جراب + شريحة".to_owned()),
            due_label: Some("النهارده".to_owned()),
            estimated_price_minor: 3200_00,
            parts_cost_minor: Some(2100_00),
            deposit_minor: 500_00,
            pay_method: Some("cash".to_owned()),
            technician_name: Some("م. حسن".to_owned()),
            warranty_days: Some(30),
            note: Some("العميل مستعجل".to_owned()),
            deliver_now: false,
        },
    )
    .await
    .expect("create hardware ticket");

    assert_eq!(hw1.ticket_no, "R-1001");
    assert_eq!(hw1.service_kind, "hardware");
    assert_eq!(hw1.status, "received");
    assert_eq!(hw1.collected_minor, 500_00);
    assert_eq!(hw1.remaining_minor, 2700_00);

    // Move hardware ticket across Kanban stages: received -> diagnosing -> waiting -> ready
    for stage in ["diagnosing", "waiting", "ready"] {
        let moved = repair_service::update_repair_status(
            &pool,
            tokens.as_ref(),
            UpdateRepairStatusInput {
                id: hw1.id.clone(),
                status: stage.to_owned(),
                technician_name: None,
                estimated_price_minor: None,
                parts_cost_minor: None,
                note: None,
            },
        )
        .await
        .expect("update status");
        assert_eq!(moved.status, stage);
    }

    // Deliver hardware ticket: final price 3,200 EGP, parts cost 2,100 EGP, remaining 2,700 EGP paid in cash.
    let hw1_deliv = repair_service::deliver_repair(
        &pool,
        tokens.as_ref(),
        DeliverRepairInput {
            id: hw1.id.clone(),
            final_price_minor: 3200_00,
            parts_cost_minor: Some(2100_00),
            pay_method: "cash".to_owned(),
            technician_name: Some("م. حسن".to_owned()),
            warranty_days: Some(30),
            note: Some("تم التسليم وتجربة الشاشة".to_owned()),
        },
    )
    .await
    .expect("deliver hardware ticket");
    assert_eq!(hw1_deliv.status, "delivered");
    assert_eq!(hw1_deliv.collected_minor, 3200_00);
    assert_eq!(hw1_deliv.remaining_minor, 0);
    assert_eq!(hw1_deliv.parts_cost_minor, Some(2100_00));
    assert_eq!(hw1_deliv.net_profit_minor, Some(1100_00));

    // 2. Software ticket #2: FRP unlock & full flash delivered immediately (`deliver_now = true`)
    //    for 250 EGP (cost 0 EGP) by software specialist "يوسف".
    let sw1 = repair_service::create_repair(
        &pool,
        tokens.as_ref(),
        CreateRepairInput {
            service_kind: "software".to_owned(),
            customer_name: "كريم سامي".to_owned(),
            customer_phone: "01122334455".to_owned(),
            device_name: "شاومي ريدمي نوت 13".to_owned(),
            imei: None,
            device_lock: None,
            issue: "تخطي حساب جوجل FRP وتفليش".to_owned(),
            accessories: None,
            due_label: Some("النهارده".to_owned()),
            estimated_price_minor: 250_00,
            parts_cost_minor: Some(0),
            deposit_minor: 0,
            pay_method: Some("cash".to_owned()),
            technician_name: Some("يوسف".to_owned()),
            warranty_days: Some(0),
            note: None,
            deliver_now: true,
        },
    )
    .await
    .expect("create immediate software ticket");
    assert_eq!(sw1.ticket_no, "R-1002");
    assert_eq!(sw1.service_kind, "software");
    assert_eq!(sw1.status, "delivered");
    assert_eq!(sw1.collected_minor, 250_00);
    assert_eq!(sw1.net_profit_minor, Some(250_00));

    // 3. Software ticket #3: iCloud / iOS restore left in Kanban (`received`) with 100 EGP deposit.
    let sw2 = repair_service::create_repair(
        &pool,
        tokens.as_ref(),
        CreateRepairInput {
            service_kind: "software".to_owned(),
            customer_name: "سارة محمود".to_owned(),
            customer_phone: "01288990011".to_owned(),
            device_name: "آيفون 13".to_owned(),
            imei: None,
            device_lock: None,
            issue: "سوفت كامل ونقل بيانات".to_owned(),
            accessories: Some("شاحن".to_owned()),
            due_label: Some("بكره".to_owned()),
            estimated_price_minor: 400_00,
            parts_cost_minor: Some(50_00),
            deposit_minor: 100_00,
            pay_method: Some("cash".to_owned()),
            technician_name: Some("يوسف".to_owned()),
            warranty_days: Some(0),
            note: None,
            deliver_now: false,
        },
    )
    .await
    .expect("create open software ticket");
    assert_eq!(sw2.ticket_no, "R-1003");
    assert_eq!(sw2.status, "received");

    // 4. Owner overview shows hardware money and software money completely separated!
    let owner_overview = repair_service::repairs_overview(&pool, tokens.as_ref(), None, None)
        .await
        .expect("owner overview");
    assert_eq!(owner_overview.tickets.len(), 3);

    // Hardware bucket: 1 ticket, 1 delivered, 3,200 EGP revenue, 2,100 EGP parts cost, 1,100 EGP net profit.
    assert_eq!(owner_overview.hardware.tickets_count, 1);
    assert_eq!(owner_overview.hardware.delivered_count, 1);
    assert_eq!(owner_overview.hardware.total_revenue_minor, 3200_00);
    assert_eq!(owner_overview.hardware.parts_cost_minor, Some(2100_00));
    assert_eq!(owner_overview.hardware.net_profit_minor, Some(1100_00));

    // Software bucket: 2 tickets (1 delivered + 1 open), 250 + 100 deposit = 350 EGP revenue, 50 EGP cost, 300 EGP net profit.
    assert_eq!(owner_overview.software.tickets_count, 2);
    assert_eq!(owner_overview.software.open_count, 1);
    assert_eq!(owner_overview.software.delivered_count, 1);
    assert_eq!(owner_overview.software.total_revenue_minor, 350_00);
    assert_eq!(owner_overview.software.parts_cost_minor, Some(50_00));
    assert_eq!(owner_overview.software.net_profit_minor, Some(300_00));

    // Combined bucket: 3 tickets, 3,550 EGP total revenue, 2,150 EGP cost, 1,400 EGP net profit.
    assert_eq!(owner_overview.combined.tickets_count, 3);
    assert_eq!(owner_overview.combined.total_revenue_minor, 3550_00);
    assert_eq!(owner_overview.combined.parts_cost_minor, Some(2150_00));
    assert_eq!(owner_overview.combined.net_profit_minor, Some(1400_00));

    // Technician breakdown separates "م. حسن" (hardware) and "يوسف" (software).
    assert_eq!(owner_overview.technicians.len(), 2);
    assert_eq!(owner_overview.technicians[0].technician_name, "م. حسن");
    assert_eq!(owner_overview.technicians[0].hardware_revenue_minor, 3200_00);
    assert_eq!(owner_overview.technicians[1].technician_name, "يوسف");
    assert_eq!(owner_overview.technicians[1].software_revenue_minor, 350_00);

    // 5. Seller view keeps revenue visible (so seller can count collected money)
    //    but redacts parts cost and net profit when `ui.seller_can_view_cost` is off.
    auth::login(&pool, tokens.as_ref(), seller_uid, PASSWORD)
        .await
        .expect("seller login");
    let seller_overview = repair_service::repairs_overview(&pool, tokens.as_ref(), None, None)
        .await
        .expect("seller overview");
    assert_eq!(seller_overview.hardware.total_revenue_minor, 3200_00);
    assert_eq!(seller_overview.software.total_revenue_minor, 350_00);
    assert_eq!(seller_overview.hardware.parts_cost_minor, None);
    assert_eq!(seller_overview.hardware.net_profit_minor, None);
    assert_eq!(seller_overview.software.parts_cost_minor, None);
    assert_eq!(seller_overview.software.net_profit_minor, None);

    // Switch back to manager for cleanup check
    auth::login(&pool, tokens.as_ref(), manager_uid, PASSWORD)
        .await
        .expect("manager login");
}

#[tokio::test]
async fn repair_collections_and_customer_credit_wallet_repayments_sync_with_shift_and_wallets() {
    let (pool, tokens, _manager_uid, _seller_uid, product_id) = setup_shop_for_repairs().await;

    // 1. Configure Vodafone Cash wallet with 10,000 EGP opening balance.
    wallet_service::update_wallet(
        &pool,
        tokens.as_ref(),
        UpdateWalletInput {
            wallet_id: "vf".to_owned(),
            name: "فودافون كاش".to_owned(),
            number: "01001234567".to_owned(),
            color: "#e60000".to_owned(),
            opening_balance_minor: 10_000_00,
            min_alert_minor: 1_000_00,
            max_limit_minor: 90_000_00,
            daily_limit_minor: 60_000_00,
            pay_method: Some("vf".to_owned()),
            sort: 1,
            hidden: false,
        },
    )
    .await
    .expect("update vf wallet");

    // 2. Open shift with 1,000 EGP opening cash.
    shift_service::open_shift(&pool, tokens.as_ref(), 1_000_00)
        .await
        .expect("open shift");

    // 3. Create a customer, sell a 900 EGP screen on credit (آجل), then customer repays
    //    400 EGP via Vodafone Cash (`vf`).
    let cust = customer_service::create(
        &pool,
        tokens.as_ref(),
        NewCustomer {
            name: "هاني عادل".to_owned(),
            contact: Some("01055667788".to_owned()),
        },
    )
    .await
    .expect("create customer");

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
        Some(900_00),
        Some(&[SalePaymentInput {
            method: "credit".to_owned(),
            amount_minor: 900_00,
            reference: None,
        }]),
        Some(&cust.id),
    )
    .await
    .expect("record credit sale");

    customer_service::record_payment(
        &pool,
        tokens.as_ref(),
        NewCustomerPayment {
            customer_id: cust.id.clone(),
            amount_minor: 400_00,
            method: "vf".to_owned(),
            note: Some("سداد جزء من الآجل فودافون كاش".to_owned()),
        },
    )
    .await
    .expect("record vf credit payment");

    // 4. Create a hardware repair with 200 EGP cash deposit, then deliver it for 800 EGP
    //    with the remaining 600 EGP paid on Vodafone Cash (`vf`).
    let rep = repair_service::create_repair(
        &pool,
        tokens.as_ref(),
        CreateRepairInput {
            service_kind: "hardware".to_owned(),
            customer_name: "تامر نبيل".to_owned(),
            customer_phone: "01099887766".to_owned(),
            device_name: "أوبو رينو 11".to_owned(),
            imei: None,
            device_lock: None,
            issue: "تغيير بطارية".to_owned(),
            accessories: None,
            due_label: Some("النهارده".to_owned()),
            estimated_price_minor: 800_00,
            parts_cost_minor: Some(450_00),
            deposit_minor: 200_00,
            pay_method: Some("cash".to_owned()),
            technician_name: Some("م. حسن".to_owned()),
            warranty_days: Some(14),
            note: None,
            deliver_now: false,
        },
    )
    .await
    .expect("create repair");

    repair_service::deliver_repair(
        &pool,
        tokens.as_ref(),
        DeliverRepairInput {
            id: rep.id,
            final_price_minor: 800_00,
            parts_cost_minor: Some(450_00),
            pay_method: "vf".to_owned(),
            technician_name: Some("م. حسن".to_owned()),
            warranty_days: Some(14),
            note: None,
        },
    )
    .await
    .expect("deliver repair on vf");

    // 5. Verify Vodafone Cash wallet balance = 10,000 (opening) + 400 (credit repayment) + 600 (repair delivery) = 11,000 EGP!
    let wallets = wallet_service::wallets_overview(&pool, tokens.as_ref(), 0, 0, i64::MAX, None, 50)
        .await
        .expect("wallets overview");
    let vf = wallets
        .wallets
        .iter()
        .find(|w| w.wallet.id.as_str() == "vf")
        .expect("vf wallet");
    assert_eq!(vf.balance_minor, 11_000_00);
    assert_eq!(vf.period.sales_in_minor, 1_000_00);

    // 6. Verify Shift Drawer:
    //    - expected_cash_minor = 1,000 (opening) + 200 (repair cash deposit) = 1,200 EGP
    //    - vf_sales_minor includes the 600 EGP repair delivery paid via `vf`
    //    - services_fee_minor includes the 350 EGP net repair profit (800 - 450)
    let shift_summary = shift_service::current_shift_summary(&pool, tokens.as_ref())
        .await
        .expect("shift summary")
        .open_shift
        .expect("active shift");
    assert_eq!(shift_summary.totals.expected_cash_minor, 1_200_00);
    assert_eq!(shift_summary.totals.services_cash_in_minor, 200_00);
    assert_eq!(shift_summary.totals.vf_sales_minor, 600_00);
    assert_eq!(shift_summary.totals.services_fee_minor, 350_00);
}
