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
use mobile_shop_system_lib::domain::shift::PaidFrom;
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
        }],
        Some(40_000),
        Some(&[SalePaymentInput {
            method: "cash".to_owned(),
            amount_minor: 40_000,
            reference: None,
            wallet_id: None,
        }]),
        None,
    )
    .await
    .expect("cash sale");

    // 2. Split sale with credit customer: 3 units × 200 EGP = 600 EGP (60_000 minor)
    //    paid 200 EGP Vodafone Cash + 400 EGP credit (`آجل`).
    let cust = customer_service::create(
        &pool,
        tokens.as_ref(),
        NewCustomer {
            name: "أحمد سمير".to_owned(),
            contact: Some("01012345678".to_owned()),
        },
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
        }],
        Some(60_000),
        Some(&[
            SalePaymentInput {
                method: "vf".to_owned(),
                amount_minor: 20_000,
                reference: Some("VF-900".to_owned()),
                wallet_id: Some("vf".to_owned()),
            },
            SalePaymentInput {
                method: "credit".to_owned(),
                amount_minor: 40_000,
                reference: None,
                wallet_id: None,
            },
        ]),
        Some(&cust.id),
    )
    .await
    .expect("split vf + credit sale");

    // 3. Customer pays 150 EGP (15_000 minor) of their credit debt in cash.
    customer_service::record_payment(
        &pool,
        tokens.as_ref(),
        NewCustomerPayment {
            customer_id: cust.id.clone(),
            amount_minor: 15_000,
            method: "cash".to_owned(),
            note: Some("دفعة كاش".to_owned()),
            wallet_id: None,
        },
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
async fn seller_permission_and_unreconciled_close_are_enforced() {
    let (pool, tokens, manager_uid, seller_uid, _product_id) = setup_shop().await;

    // Seller logs in and opens Shift #1 with 1,000 EGP (100_000 minor).
    auth::login(&pool, tokens.as_ref(), seller_uid, PASSWORD)
        .await
        .expect("seller login");
    let opened = shift_service::open_shift(&pool, tokens.as_ref(), 100_000)
        .await
        .expect("seller opens shift #1");
    let first_id = opened.shift.id.as_str().to_owned();

    // By default (`ui.seller_can_close_shift == "off"`), seller cannot close the shift.
    let refused = shift_service::close_shift(&pool, tokens.as_ref(), &first_id, 100_000, None).await;
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

    // Even an authorized operator and a documented difference cannot turn an
    // unverified time-window estimate into a reconciled drawer close.
    auth::login(&pool, tokens.as_ref(), seller_uid, PASSWORD).await.expect("seller login");
    let invalid = shift_service::close_shift(&pool, tokens.as_ref(), &first_id, -1, None).await.expect_err("negative count refused");
    assert_eq!(invalid.code(), "SHIFT_COUNTED_CASH_INVALID");
    let count = shift_service::record_shift_cash_count(&pool, tokens.as_ref(), 99_000).await.expect("record count");
    assert_eq!(count.amount_minor, 99_000);
    let latest = shift_service::latest_shift_cash_count(&pool, tokens.as_ref()).await.expect("read count").expect("exists");
    assert_eq!(latest.id, count.id);
    let closed = shift_service::close_shift(&pool, tokens.as_ref(), &first_id, 99_000, Some("عجز 10 ج فكة")).await.expect("operational close");
    assert_eq!(closed.shift.status.as_str(), "closed");
    assert_eq!(closed.shift.counted_cash.unwrap().as_minor(), 99_000);
    let dto: mobile_shop_system_lib::commands::shift::ShiftRecordDto = closed.shift.into();
    assert!(!dto.cash_reconciled);
    assert!(dto.expected_cash_minor.is_none() && dto.difference_minor.is_none());
    let next = shift_service::open_shift(&pool, tokens.as_ref(), 98_000).await.expect("fresh opening count");
    assert_eq!(next.shift.shift_number, 2);
    let retry = shift_service::close_shift(&pool, tokens.as_ref(), &first_id, 99_000, None).await.expect_err("stale retry cannot close the next shift");
    assert_eq!(retry.code(), "SHIFT_CHANGED");
    let mut conn = pool.acquire().await.expect("conn");
    let handover: (i64, i64, i64, String) = sqlx::query_as("SELECT opening_minor, previous_count_minor, handover_difference_minor, reconciliation_status FROM shift_opening_observations WHERE shift_id = ?")
        .bind(next.shift.id.as_str()).fetch_one(&mut *conn).await.expect("handover");
    assert_eq!(handover, (98_000, 99_000, -1_000, "unreconciled".to_owned()));
    assert_eq!(audit::count_by_type(&mut conn, audit::event::SHIFT_CASH_COUNTED).await.expect("count audit"), 2);
    assert_eq!(audit::count_by_type(&mut conn, audit::event::SHIFT_CLOSED).await.expect("close audit"), 1);


}

/// One list of expenses, two sources (`ADR-043`).
///
/// The rent is paid whether or not a shift is open, and it must not move a pound of
/// the drawer somebody is about to count. A drawer expense keeps its old rules: it
/// needs an open shift, and it reduces expected cash. Both appear in the section's
/// window, with the totals telling them apart.
#[tokio::test]
async fn an_outside_expense_needs_no_shift_and_never_moves_expected_cash() {
    let (pool, tokens, _manager_uid, _seller_uid, _product_id) = setup_shop().await;
    let tokens = tokens.as_ref();

    // No shift has been opened. The rent still happened, and it is recorded.
    let rent = shift_service::record_shop_expense(
        &pool,
        tokens,
        "إيجار",
        500_000,
        Some("إيجار شهر أكتوبر"),
        "outside",
    )
    .await
    .expect("an outside expense needs no shift");
    assert_eq!(
        rent.shift_id, None,
        "money that never left the drawer must not name one (`ADR-043`)"
    );
    assert_eq!(rent.paid_from, PaidFrom::Outside);
    assert_eq!(rent.amount.as_minor(), 500_000);

    // A drawer expense still needs a till somebody opened.
    let drawer_without_shift =
        shift_service::record_shop_expense(&pool, tokens, "ضيافة", 5_000, None, "drawer").await;
    assert!(
        drawer_without_shift.is_err(),
        "a drawer expense without an open shift would have nothing to subtract from"
    );

    // And the source cannot be left to a default: neither an empty answer nor an
    // invented word is accepted.
    for source in ["", "cash", "الدرج"] {
        let refused =
            shift_service::record_shop_expense(&pool, tokens, "ضاءة", 1_000, None, source).await;
        assert!(
            refused.is_err(),
            "`{source}` must be refused: the source decides whose money this was"
        );
    }

    // Open a drawer with 1,000 EGP and take 50 EGP out of it.
    let opened = shift_service::open_shift(&pool, tokens, 100_000)
        .await
        .expect("open shift");
    assert_eq!(opened.totals.expected_cash_minor, 100_000);
    let drawer = shift_service::record_shop_expense(
        &pool,
        tokens,
        "شاي وضيافة",
        5_000,
        None,
        "drawer",
    )
    .await
    .expect("drawer expense with a shift open");
    assert_eq!(
        drawer.shift_id.as_ref().map(|id| id.as_str()),
        Some(opened.shift.id.as_str())
    );
    assert_eq!(drawer.paid_from, PaidFrom::Drawer);

    let summary = shift_service::current_shift_summary(&pool, tokens)
        .await
        .expect("current shift")
        .open_shift
        .expect("a shift is open");
    assert_eq!(
        summary.totals.expenses_minor, 5_000,
        "only the drawer's own expenses reduce the drawer"
    );
    assert_eq!(
        summary.totals.expected_cash_minor, 95_000,
        "1,000 EGP opening minus the 50 EGP taken out of the till"
    );
    assert_eq!(
        summary.expenses.len(),
        1,
        "the outside expense is not a row of this shift"
    );

    // The section sees both, and its three totals do not mix them.
    let overview = shift_service::expenses_overview(&pool, tokens, None, None)
        .await
        .expect("expenses overview");
    assert_eq!(overview.count, 2);
    assert_eq!(overview.total_minor, 505_000);
    assert_eq!(overview.drawer_minor, 5_000);
    assert_eq!(overview.outside_minor, 500_000);
    assert_eq!(
        overview.by_category.iter().map(|c| c.total_minor).max(),
        Some(500_000),
        "the biggest category is the rent, not the tea"
    );
    assert_eq!(
        overview.rows[0].created_by_name, "Peter",
        "the section says who recorded each expense"
    );
    assert_eq!(overview.open_shift_id, Some(opened.shift.id.as_str().to_owned()));

    // A window that has already passed holds nothing, and a window that is still
    // open holds both — the bounds are inclusive, and `None` means «الكل».
    let future = shift_service::expenses_overview(&pool, tokens, None, Some(0))
        .await
        .expect("empty window");
    assert_eq!(future.count, 0);
    assert_eq!(future.total_minor, 0);
}

#[tokio::test]
async fn shift_transport_explicitly_marks_legacy_cash_total_unreconciled() {
    let (pool, tokens, _, _, _) = setup_shop().await;
    let summary = shift_service::open_shift(&pool, tokens.as_ref(), 1000).await.expect("open shift");
    let dto = mobile_shop_system_lib::commands::shift::ShiftTotalsDto::from(summary.totals);
    let encoded = serde_json::to_value(dto).expect("serialize totals");
    assert_eq!(encoded["cashReconciled"], false);
}

#[tokio::test]
async fn failed_count_audit_rolls_back_the_physical_observation() {
    let (pool, tokens, _, _, _) = setup_shop().await;
    shift_service::open_shift(&pool, tokens.as_ref(), 0).await.expect("open shift");
    sqlx::raw_sql("CREATE TRIGGER fail_shift_count_audit BEFORE INSERT ON audit_events WHEN NEW.event_type='shift_cash_counted' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;")
        .execute(&pool).await.expect("failure injection");
    assert!(shift_service::record_shift_cash_count(&pool, tokens.as_ref(), 500).await.is_err());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shift_cash_counts").fetch_one(&pool).await.expect("count rows");
    assert_eq!(n, 0, "count and audit must commit together");
}

#[tokio::test]
async fn failed_close_audit_rolls_back_count_and_operational_close() {
    let (pool, tokens, _, _, _) = setup_shop().await;
    let opened = shift_service::open_shift(&pool, tokens.as_ref(), 100).await.expect("open shift");
    sqlx::raw_sql("CREATE TRIGGER fail_shift_close_audit BEFORE INSERT ON audit_events WHEN NEW.event_type='shift_closed' BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;")
        .execute(&pool).await.expect("failure injection");
    assert!(shift_service::close_shift(&pool, tokens.as_ref(), opened.shift.id.as_str(), 101, None).await.is_err());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shift_cash_counts").fetch_one(&pool).await.expect("counts");
    assert_eq!(n, 0);
    let state = shift_service::current_shift_summary(&pool, tokens.as_ref()).await.expect("state");
    assert!(state.open_shift.is_some());
    assert!(state.last_closed_shift.is_none());
}

#[tokio::test]
async fn concurrent_close_requests_cannot_close_twice() {
    let dir = tempfile::tempdir().expect("temp dir");
    let pool = mobile_shop_system_lib::data::db::open(&dir.path().join("close.db")).await.expect("db");
    let tokens = InMemoryTokenStore::new();
    let owner = bootstrap::create_first_manager(&pool, "Peter", PASSWORD).await.expect("owner").user_id;
    auth::login(&pool, &tokens, owner, PASSWORD).await.expect("login");
    let opened = shift_service::open_shift(&pool, &tokens, 100).await.expect("open");
    let id = opened.shift.id.as_str().to_owned();
    let (a, b) = tokio::join!(
        shift_service::close_shift(&pool, &tokens, &id, 100, None),
        shift_service::close_shift(&pool, &tokens, &id, 100, None)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM shift_cash_counts WHERE shift_id=?")
        .bind(&id).fetch_one(&pool).await.expect("counts");
    assert_eq!(n, 1, "close retries do not create duplicate count observations");
}

#[tokio::test]
async fn legacy_close_value_is_not_promoted_to_a_proven_physical_count() {
    let (pool, tokens, owner, _, _) = setup_shop().await;
    sqlx::query("INSERT INTO shifts(id,shift_number,status,opening_cash_minor,expected_cash_minor,counted_cash_minor,difference_minor,opened_by,opened_at,closed_by,closed_at) VALUES('legacy',1,'closed',100,100,100,0,?1,1,?1,2)")
        .bind(owner.as_str()).execute(&pool).await.expect("legacy close");
    let opened = shift_service::open_shift(&pool, tokens.as_ref(), 75).await.expect("fresh count");
    let row: (Option<String>, Option<i64>, Option<i64>, String) = sqlx::query_as("SELECT previous_shift_id, previous_count_minor, handover_difference_minor, reconciliation_status FROM shift_opening_observations WHERE shift_id=?")
        .bind(opened.shift.id.as_str()).fetch_one(&pool).await.expect("handover");
    assert_eq!(row, (Some("legacy".to_owned()), None, None, "unreconciled".to_owned()));
}

#[tokio::test]
async fn configured_shift_captures_source_linked_cash_without_claiming_reconciliation() {
    let (pool, tokens, manager, seller, product) = setup_shop().await;
    let lines = [SaleLineWithUnitInput { product_id: product, quantity: 1, warranty_start: None, warranty_end: None, imei: None }];
    // Before configuration and without a shift, never invent a drawer.
    let before = sales::record_sale_with_discounts(&pool, tokens.as_ref(), &lines, Some(20_000), None, None, 0, &[0]).await.expect("sale before shift");
    let unassigned: Option<String> = sqlx::query_scalar("SELECT p.drawer_id FROM cash_source_postings p JOIN sale_payments sp ON sp.id=p.source_id WHERE sp.sale_id=?1").bind(&before.sale_id).fetch_one(&pool).await.expect("posting");
    assert!(unassigned.is_none());
    auth::login(&pool, tokens.as_ref(), seller, PASSWORD).await.expect("seller");
    assert_eq!(shift_service::configure_drawer(&pool, tokens.as_ref(), "till", "Till", "req").await.expect_err("seller denied").code(), "PERMISSION_DENIED");
    auth::login(&pool, tokens.as_ref(), manager, PASSWORD).await.expect("manager");
    shift_service::configure_drawer(&pool, tokens.as_ref(), "till", "Till", "req").await.expect("configure");
    shift_service::configure_drawer(&pool, tokens.as_ref(), "till", "Till", "req").await.expect("retry");
    assert!(shift_service::configure_drawer(&pool, tokens.as_ref(), "till", "Changed", "req").await.is_err());
    let opened = shift_service::open_shift(&pool, tokens.as_ref(), 10_000).await.expect("open");
    assert!(shift_service::configure_drawer(&pool, tokens.as_ref(), "other", "Other", "req2").await.is_err());
    sales::record_sale_with_discounts(&pool, tokens.as_ref(), &lines, Some(20_000), None, None, 0, &[0]).await.expect("sale");
    shift_service::record_expense(&pool, tokens.as_ref(), "tea", 1000, None).await.expect("drawer expense");
    shift_service::record_shift_cash_count(&pool, tokens.as_ref(), 12_345).await.expect("count");
    let preview = shift_service::cash_posting_preview(&pool, tokens.as_ref()).await.expect("preview");
    assert!(!preview.complete);
    assert_eq!(preview.drawers.len(), 1);
    let assigned: Vec<_> = preview.recent_postings.iter().filter(|p| p.drawer_id.as_deref()==Some("till")).collect();
    assert_eq!(assigned.len(), 2);
    assert!(assigned.iter().any(|p| p.source_kind=="sale_payment" && p.signed_minor==20_000));
    assert!(assigned.iter().any(|p| p.source_kind=="expense" && p.signed_minor == -1000));
    assert!(assigned.iter().all(|p| p.shift_id.as_deref()==Some(opened.shift.id.as_str())));
    assert_eq!(preview.recent_postings.len(), 3, "opening and physical count never post money");
    sqlx::query("CREATE TRIGGER reject_sale_audit BEFORE INSERT ON audit_events WHEN NEW.event_type='sale_recorded' BEGIN SELECT RAISE(ABORT,'test'); END;").execute(&pool).await.expect("failure injection");
    assert!(sales::record_sale_with_discounts(&pool, tokens.as_ref(), &lines, Some(20_000), None, None, 0, &[0]).await.is_err());
    let posted: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM cash_source_postings").fetch_one(&pool).await.expect("posting count");
    assert_eq!(posted, 3, "failed source and its posting roll back together");
    sqlx::query("DROP TRIGGER reject_sale_audit").execute(&pool).await.expect("cleanup");
    assert!(sqlx::query("UPDATE cash_source_postings SET signed_minor=1").execute(&pool).await.is_err());
    assert!(sqlx::query("DELETE FROM cash_source_postings").execute(&pool).await.is_err());
}
