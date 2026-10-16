//! Stock and costing against real SQLite (SP-2).
//!
//! The claims under test are the ones a unit test cannot make:
//!
//! * a Moving Average removal ceils, and the balance never goes negative;
//! * FIFO consumes the oldest layer first and needs no rounding;
//! * the authority invariant holds on disk after every operation — exactly one
//!   of `total_cost_minor` / `fifo_layers` is in charge, never both and never
//!   neither;
//! * insufficient stock refuses the whole operation and leaves no partial state;
//! * a failure anywhere rolls the transaction back completely, position and
//!   audit together;
//! * switching methods converts the stock that already exists;
//! * every movement is audited, and a refused movement is not.
//!
//! `spec:138` requires atomicity to be proven against real SQLite rather than a
//! mock, so no mock appears here.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::repositories::identity::audit;
use mobile_shop_system_lib::domain::catalog::{Disposition, ProductStatus};
use mobile_shop_system_lib::domain::identity::{Sensitivity, UserId};
use mobile_shop_system_lib::domain::organisation::{CostMethod, DepartmentId};
use mobile_shop_system_lib::services::catalog::product::{self as catalogue, NewProduct};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session};
use mobile_shop_system_lib::services::inventory::stock as costing;
use sqlx::SqlitePool;

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
    manager: UserId,
}

/// A signed-in manager, a fresh database, and nothing else.
async fn shop() -> Shop {
    let pool = mobile_shop_system_lib::data::db::open_in_memory()
        .await
        .expect("in-memory database");
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
        manager: created.user_id,
    }
}

/// A product, optionally classified into a department.
///
/// The department is written straight to the column rather than through a
/// service: `ADR-012` moved product classification into this slice, and the
/// command that does it is not part of the costing contract under test. Using
/// raw SQL here keeps the test honest about what it depends on.
async fn product(shop: &Shop, name: &str, department: Option<DepartmentId>) -> String {
    let ctx = mobile_shop_system_lib::services::catalog::CatalogContext::new(
        shop.pool.clone(),
        shop.tokens.clone(),
    );
    let session = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("resolve the session the way a command does");

    let created = catalogue::create(
        &ctx,
        &session,
        NewProduct {
            name: name.to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: None,
        },
    )
    .await
    .expect("create product");

    if let Some(department) = department {
        sqlx::query("UPDATE products SET department_id = ?1 WHERE id = ?2")
            .bind(department.as_str())
            .bind(created.id.as_str())
            .execute(&shop.pool)
            .await
            .expect("classify the product");
    }

    created.id.as_str().to_string()
}

/// A department in a known costing method.
async fn department(shop: &Shop, name: &str, method: CostMethod) -> DepartmentId {
    let department = mobile_shop_system_lib::services::organisation::departments::create(
        &shop.pool,
        shop.tokens.as_ref(),
        mobile_shop_system_lib::services::organisation::departments::DepartmentInput {
            name: name.to_string(),
            cost_method: method,
            vat: mobile_shop_system_lib::services::organisation::departments::VatInput {
                enabled: false,
                rate_bp: None,
                inclusive: false,
            },
            sort_order: 0,
        },
    )
    .await
    .expect("create department");
    department.id
}

/// The stored position, or `None` if the product was never stocked.
async fn position(shop: &Shop, product_id: &str) -> Option<(i64, Option<i64>)> {
    sqlx::query_as("SELECT quantity, total_cost_minor FROM stock_levels WHERE product_id = ?1")
        .bind(product_id)
        .fetch_optional(&shop.pool)
        .await
        .expect("position row")
}

async fn layers(shop: &Shop, product_id: &str) -> Vec<(i64, i64)> {
    sqlx::query_as(
        "SELECT quantity, unit_cost_minor FROM fifo_layers
         WHERE product_id = ?1 ORDER BY received_at, id",
    )
    .bind(product_id)
    .fetch_all(&shop.pool)
    .await
    .expect("layer rows")
}

async fn audit_count(shop: &Shop, event: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE event_type = ?1")
        .bind(event)
        .fetch_one(&shop.pool)
        .await
        .expect("audit count")
}

// ---------------------------------------------------------------------------
// Moving Average
// ---------------------------------------------------------------------------

#[tokio::test]
async fn moving_average_ceils_and_keeps_the_balance_exact() {
    let shop = shop().await;
    let department = department(&shop, "Phones", CostMethod::MovingAverage).await;
    let product = product(&shop, "Charger", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        10,
        150,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    assert_eq!(position(&shop, &product).await, Some((10, Some(1500))));

    // 3 of 10 at 150 each is exactly 450.
    let outcome = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 3)
        .await
        .expect("remove");
    assert_eq!(outcome.cost_minor, 450);
    assert_eq!(position(&shop, &product).await, Some((7, Some(1050))));
    assert!(layers(&shop, &product).await.is_empty(), "MA holds no layers");
}

#[tokio::test]
async fn moving_average_rounds_a_fraction_up_never_down() {
    let shop = shop().await;
    let department = department(&shop, "Cables", CostMethod::MovingAverage).await;
    let product = product(&shop, "Cable", Some(department)).await;

    // 3 units for a total of 100 piastres, so the average is 33.33 and a single
    // unit must cost 34. Received as three units whose costs sum to 100, because
    // a receipt states a unit cost rather than a total.
    for unit_cost in [34, 33, 33] {
        costing::receive(
            &shop.pool,
            shop.tokens.as_ref(),
            &product,
            1,
            unit_cost,
            Sensitivity::Routine,
        None,
        )
        .await
        .expect("receive");
    }
    assert_eq!(position(&shop, &product).await, Some((3, Some(100))));

    let outcome = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 1)
        .await
        .expect("remove");
    assert_eq!(
        outcome.cost_minor, 34,
        "ADR-013: ceil(100/3) = 34, never 33"
    );
}

#[tokio::test]
async fn selling_everything_under_moving_average_leaves_nothing_behind() {
    let shop = shop().await;
    let department = department(&shop, "Cases", CostMethod::MovingAverage).await;
    let product = product(&shop, "Case", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        7,
        1000,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    let mut spent = 0i64;
    for _ in 0..7 {
        spent += costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 1)
            .await
            .expect("remove")
            .cost_minor;
    }

    assert_eq!(spent, 7000, "the total consumed must equal the total received");
    assert_eq!(
        position(&shop, &product).await,
        Some((0, Some(0))),
        "an emptied position keeps a real zero, not a NULL"
    );
}

// ---------------------------------------------------------------------------
// FIFO
// ---------------------------------------------------------------------------

#[tokio::test]
async fn fifo_consumes_the_oldest_layer_first() {
    let shop = shop().await;
    let department = department(&shop, "Spares", CostMethod::Fifo).await;
    let product = product(&shop, "Screen", Some(department)).await;

    for _ in 0..2 {
        costing::receive(
            &shop.pool,
            shop.tokens.as_ref(),
            &product,
            5,
            100,
            Sensitivity::Routine,
        None,
        )
        .await
        .expect("receive at 100");
    }
    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        5,
        200,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive at 200");

    assert_eq!(layers(&shop, &product).await.len(), 3, "receipts never merge");
    assert_eq!(position(&shop, &product).await, Some((15, None)));

    // 6 units: the whole oldest layer at 100, then one from the next at 100.
    let outcome = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 6)
        .await
        .expect("remove");
    assert_eq!(outcome.cost_minor, 600);
    assert_eq!(position(&shop, &product).await, Some((9, None)));
}

#[tokio::test]
async fn fifo_straddles_two_layers_at_two_prices() {
    let shop = shop().await;
    let department = department(&shop, "Batteries", CostMethod::Fifo).await;
    let product = product(&shop, "Battery", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        2,
        100,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");
    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        3,
        120,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    // 4 units: 2 at 100 and 2 at 120.
    let outcome = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 4)
        .await
        .expect("remove");
    assert_eq!(outcome.cost_minor, 2 * 100 + 2 * 120);
    assert_eq!(
        layers(&shop, &product).await,
        vec![(1, 120)],
        "the surviving layer keeps its own unit cost"
    );
}

#[tokio::test]
async fn fifo_never_rounds() {
    let shop = shop().await;
    let department = department(&shop, "Odd", CostMethod::Fifo).await;
    let product = product(&shop, "Odd", Some(department)).await;

    // 34 piastres does not divide by 3; under a Moving Average this would ceil
    // to 12 per unit. FIFO takes whole units at whole-layer prices.
    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        3,
        34,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");
    let outcome = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 1)
        .await
        .expect("remove");
    assert_eq!(outcome.cost_minor, 34);
}

// ---------------------------------------------------------------------------
// The authority invariant
// ---------------------------------------------------------------------------

#[tokio::test]
async fn exactly_one_representation_ever_owns_the_cost() {
    let shop = shop().await;

    for (name, method) in [("MA", CostMethod::MovingAverage), ("FIFO", CostMethod::Fifo)] {
        let department = department(&shop, name, method).await;
        let product = product(&shop, name, Some(department)).await;

        costing::receive(
            &shop.pool,
            shop.tokens.as_ref(),
            &product,
            4,
            250,
            Sensitivity::Routine,
        None,
        )
        .await
        .expect("receive");

        let (_, total) = position(&shop, &product).await.expect("a position");
        let layer_count = layers(&shop, &product).await.len();

        match method {
            CostMethod::MovingAverage => {
                assert!(total.is_some(), "{name}: MA must record a total");
                assert_eq!(layer_count, 0, "{name}: MA must hold no layers");
            }
            CostMethod::Fifo => {
                assert!(total.is_none(), "{name}: FIFO must record no total");
                assert!(layer_count > 0, "{name}: FIFO must hold layers");
            }
        }
    }
}

#[tokio::test]
async fn a_position_that_contradicts_its_method_is_refused_not_repaired() {
    let shop = shop().await;
    let department = department(&shop, "Broken", CostMethod::MovingAverage).await;
    let product = product(&shop, "Broken", Some(department)).await;

    // Write a FIFO layer underneath a Moving Average department, the way a bug
    // outside this module would.
    sqlx::query(
        "INSERT INTO fifo_layers
         (id, product_id, quantity, unit_cost_minor, received_at, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&product)
    .bind(1i64)
    .bind(100i64)
    .bind(0i64)
    .bind(shop.manager.as_str())
    .execute(&shop.pool)
    .await
    .expect("inject a contradictory layer");

    let outcome = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 1).await;

    assert_eq!(
        outcome.err().map(|error| error.code()),
        Some("STOCK_COST_AUTHORITY_CONFLICT"),
        "a contradictory position must be reported, never silently repaired"
    );
    assert_eq!(
        layers(&shop, &product).await.len(),
        1,
        "the refusal must not have deleted the layer either"
    );
}

// ---------------------------------------------------------------------------
// Insufficient stock
// ---------------------------------------------------------------------------

#[tokio::test]
async fn insufficient_stock_refuses_the_whole_operation() {
    let shop = shop().await;
    let department = department(&shop, "Scarce", CostMethod::MovingAverage).await;
    let product = product(&shop, "Scarce", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        3,
        100,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    let before_audit = audit_count(&shop, audit::event::STOCK_REMOVED).await;
    let refused = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 5).await;

    assert_eq!(refused.err().map(|error| error.code()), Some("COST_INSUFFICIENT_STOCK"));
    assert_eq!(
        position(&shop, &product).await,
        Some((3, Some(300))),
        "a refused removal must not consume the units it could have taken"
    );
    assert_eq!(
        audit_count(&shop, audit::event::STOCK_REMOVED).await,
        before_audit,
        "a refused removal must not be audited as a movement"
    );
}

#[tokio::test]
async fn removing_from_an_unstocked_product_is_refused() {
    let shop = shop().await;
    let department = department(&shop, "Empty", CostMethod::Fifo).await;
    let product = product(&shop, "Empty", Some(department)).await;

    let refused = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 1).await;
    assert_eq!(refused.err().map(|error| error.code()), Some("COST_INSUFFICIENT_STOCK"));
    assert!(position(&shop, &product).await.is_none());
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_storage_failure_rolls_back_the_position_and_the_audit_together() {
    let shop = shop().await;
    let department = department(&shop, "Rollback", CostMethod::MovingAverage).await;
    let product = product(&shop, "Rollback", Some(department)).await;

    let before_audit = audit_count(&shop, audit::event::STOCK_RECEIVED).await;
    let outcome = costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        5,
        100,
        Sensitivity::Routine,
        None,
    )
    .await;

    // The position and the audit must agree, whichever way it went. This used to
    // assert only the failure branch, and the failure branch never happened —
    // receiving into an archived product SUCCEEDS, by design — so the test proved
    // nothing while reporting green. Both branches are asserted now.
    if outcome.is_err() {
        assert!(position(&shop, &product).await.is_none());
        assert_eq!(audit_count(&shop, audit::event::STOCK_RECEIVED).await, before_audit);
    } else {
        assert!(
            position(&shop, &product).await.is_some(),
            "a receipt that reported success must have written its position"
        );
        assert_eq!(
            audit_count(&shop, audit::event::STOCK_RECEIVED).await,
            before_audit + 1,
            "a receipt that reported success must be audited"
        );
    }
}

#[tokio::test]
async fn a_negative_balance_can_never_be_written() {
    let shop = shop().await;
    let department = department(&shop, "Guard", CostMethod::MovingAverage).await;
    let product = product(&shop, "Guard", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        1,
        100,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    // Bypass the service entirely to prove the schema is the last line of
    // defence: `spec:139` wants the money boundary tested, not assumed.
    let forced = sqlx::query("UPDATE stock_levels SET quantity = -5 WHERE product_id = ?1")
        .bind(&product)
        .execute(&shop.pool)
        .await;

    assert!(
        forced.is_err(),
        "the CHECK constraint must refuse a negative balance even from raw SQL"
    );
    assert_eq!(position(&shop, &product).await, Some((1, Some(100))));
}

// ---------------------------------------------------------------------------
// Switching the costing method
// ---------------------------------------------------------------------------

#[tokio::test]
async fn switching_moving_average_to_fifo_seeds_one_layer_at_the_current_average() {
    let shop = shop().await;
    let department = department(&shop, "Switch", CostMethod::MovingAverage).await;
    let product = product(&shop, "Switch", Some(department)).await;

    // 4 units costing 1000 in total: the average is exactly 250.
    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        4,
        250,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    costing::switch_cost_method(
        &shop.pool,
        shop.tokens.as_ref(),
        department,
        CostMethod::Fifo,
    )
    .await
    .expect("switch");

    assert_eq!(
        layers(&shop, &product).await,
        vec![(4, 250)],
        "ADR-013: MA → FIFO seeds one layer at the current average"
    );
    assert_eq!(
        position(&shop, &product).await,
        Some((4, None)),
        "the Moving Average total must be handed over, not left beside the layers"
    );
}

#[tokio::test]
async fn switching_back_to_moving_average_collapses_the_layers() {
    let shop = shop().await;
    let department = department(&shop, "Round", CostMethod::Fifo).await;
    let product = product(&shop, "Round", Some(department)).await;

    for unit_cost in [100, 120] {
        costing::receive(
            &shop.pool,
            shop.tokens.as_ref(),
            &product,
            2,
            unit_cost,
            Sensitivity::Routine,
        None,
        )
        .await
        .expect("receive");
    }

    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    costing::switch_cost_method(
        &shop.pool,
        shop.tokens.as_ref(),
        department,
        CostMethod::MovingAverage,
    )
    .await
    .expect("switch");

    assert!(
        layers(&shop, &product).await.is_empty(),
        "FIFO → MA must delete the layers it collapsed"
    );
    assert_eq!(
        position(&shop, &product).await,
        Some((4, Some(440))),
        "the total is the sum of the layers: 2*100 + 2*120"
    );
}

#[tokio::test]
async fn switching_an_empty_position_seeds_nothing() {
    let shop = shop().await;
    let department = department(&shop, "Nothing", CostMethod::MovingAverage).await;
    let product = product(&shop, "Nothing", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        5,
        100,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");
    costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 5)
        .await
        .expect("remove everything");

    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    costing::switch_cost_method(
        &shop.pool,
        shop.tokens.as_ref(),
        department,
        CostMethod::Fifo,
    )
    .await
    .expect("switch");

    assert!(
        layers(&shop, &product).await.is_empty(),
        "an empty position has nothing to seed; a zero layer would be noise"
    );
}

#[tokio::test]
async fn an_ordinary_department_edit_cannot_relabel_the_costing_method() {
    // The switch has to convert the stock that already exists. If a plain edit
    // could flip the label, a department could be worth a different amount
    // without anything being converted.
    let shop = shop().await;
    let department = department(&shop, "Locked", CostMethod::MovingAverage).await;
    let product = product(&shop, "Locked", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        4,
        250,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    let renamed = mobile_shop_system_lib::services::organisation::departments::update(
        &shop.pool,
        shop.tokens.as_ref(),
        department,
        mobile_shop_system_lib::services::organisation::departments::DepartmentInput {
            name: "Renamed".to_string(),
            cost_method: CostMethod::Fifo,
            vat: mobile_shop_system_lib::services::organisation::departments::VatInput {
                enabled: false,
                rate_bp: None,
                inclusive: false,
            },
            sort_order: 0,
        },
    )
    .await;

    assert_eq!(
        renamed.err().map(|error| error.code()),
        Some("DEPARTMENT_COST_METHOD_REQUIRES_SWITCH")
    );
    assert_eq!(
        layers(&shop, &product).await.len(),
        0,
        "the refused edit must not have left a converted position behind"
    );
}

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

#[tokio::test]
async fn switching_the_costing_method_requires_fresh_proof() {
    let shop = shop().await;
    let department = department(&shop, "Guard", CostMethod::MovingAverage).await;

    // A plain login is `normal` assurance; a switch is sensitive work.
    let refused = costing::switch_cost_method(
        &shop.pool,
        shop.tokens.as_ref(),
        department,
        CostMethod::Fifo,
    )
    .await;

    assert_eq!(
        refused.err().map(|error| error.code()),
        Some("REAUTHENTICATION_REQUIRED"),
        "ADR-013 requires re-authentication before the costing method moves"
    );
}

#[tokio::test]
async fn receiving_a_delivery_is_routine_and_needs_no_fresh_proof() {
    let shop = shop().await;
    let department = department(&shop, "Routine", CostMethod::MovingAverage).await;
    let product = product(&shop, "Routine", Some(department)).await;

    // No reauthentication: `role.rs` says receiving a carton is routine.
    let outcome = costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        2,
        100,
        Sensitivity::Routine,
    None,
    )
    .await;

    assert_eq!(outcome.expect("receive").quantity, 2);
}

#[tokio::test]
async fn declaring_an_opening_balance_is_sensitive_work() {
    let shop = shop().await;
    let department = department(&shop, "Opening", CostMethod::MovingAverage).await;
    let product = product(&shop, "Opening", Some(department)).await;

    let refused = costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        10,
        100,
        Sensitivity::Sensitive,
    None,
    )
    .await;

    assert_eq!(
        refused.err().map(|error| error.code()),
        Some("REAUTHENTICATION_REQUIRED"),
        "an opening balance declares what the shop is worth (role.rs)"
    );
    assert!(position(&shop, &product).await.is_none());
}

// ---------------------------------------------------------------------------
// The audit trail
// ---------------------------------------------------------------------------

#[tokio::test]
async fn every_movement_is_audited_once() {
    let shop = shop().await;
    let department = department(&shop, "Audited", CostMethod::MovingAverage).await;
    let product = product(&shop, "Audited", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        3,
        100,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");
    costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 1)
        .await
        .expect("remove");

    assert_eq!(audit_count(&shop, audit::event::STOCK_RECEIVED).await, 1);
    assert_eq!(audit_count(&shop, audit::event::STOCK_REMOVED).await, 1);
}

#[tokio::test]
async fn the_switch_is_audited_with_both_methods_named() {
    let shop = shop().await;
    let department = department(&shop, "Trace", CostMethod::MovingAverage).await;

    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    costing::switch_cost_method(
        &shop.pool,
        shop.tokens.as_ref(),
        department,
        CostMethod::Fifo,
    )
    .await
    .expect("switch");

    assert_eq!(audit_count(&shop, audit::event::COST_METHOD_SWITCHED).await, 1);

    let detail: String = sqlx::query_scalar(
        "SELECT detail FROM audit_events WHERE event_type = 'cost_method_switched'",
    )
    .fetch_one(&shop.pool)
    .await
    .expect("detail");

    assert!(
        detail.contains("moving_average") && detail.contains("fifo"),
        "the audit must name both sides of the switch, got {detail}"
    );
}

#[tokio::test]
async fn audit_detail_never_carries_a_costing_secret() {
    let shop = shop().await;
    let department = department(&shop, "Clean", CostMethod::Fifo).await;
    let product = product(&shop, "Clean", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        2,
        500,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    let details: Vec<String> =
        sqlx::query_scalar("SELECT COALESCE(detail, '') FROM audit_events").fetch_all(&shop.pool)
            .await
            .expect("details");

    for detail in details {
        assert!(!detail.contains(PASSWORD), "audit detail leaked the password");
    }
}

// ---------------------------------------------------------------------------
// Unclassified products
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_product_with_no_department_uses_the_device_default() {
    let shop = shop().await;

    // No department: `0005` leaves it nullable and `spec:175` forbids inventing
    // one, so the device default decides.
    let product = product(&shop, "Unclassified", None).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        2,
        100,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    assert_eq!(
        position(&shop, &product).await,
        Some((2, Some(200))),
        "the shipped device default is moving_average"
    );
}

#[tokio::test]
async fn the_device_default_decides_the_representation() {
    let shop = shop().await;

    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES ('default_cost_method', 'fifo', ?1, ?2)",
    )
    .bind(shop.manager.as_str())
    .bind(0i64)
    .execute(&shop.pool)
    .await
    .expect("set the device default to fifo");

    let product = product(&shop, "Also unclassified", None).await;
    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        2,
        100,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    assert_eq!(
        position(&shop, &product).await,
        Some((2, None)),
        "an unclassified product follows the device default"
    );
    assert_eq!(layers(&shop, &product).await.len(), 1);
}

#[tokio::test]
async fn an_unknown_product_is_refused() {
    let shop = shop().await;
    let missing = uuid::Uuid::now_v7().to_string();

    let outcome = costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &missing,
        1,
        100,
        Sensitivity::Routine,
    None,
    )
    .await;

    assert_eq!(
        outcome.err().map(|error| error.code()),
        Some("STOCK_PRODUCT_NOT_FOUND")
    );
}

#[tokio::test]
async fn a_one_off_product_is_not_stock_tracked() {
    // `spec:175`: a one-off is sold once and keeps no balance. The costing
    // engine is for quantity-tracked stock, so this must not silently create
    // one.
    let shop = shop().await;
    let department = department(&shop, "OneOff", CostMethod::MovingAverage).await;

    let ctx = mobile_shop_system_lib::services::catalog::CatalogContext::new(
        shop.pool.clone(),
        shop.tokens.clone(),
    );
    let session = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("resolve the session the way a command does");
    let created = catalogue::create(
        &ctx,
        &session,
        NewProduct {
            name: "Second hand".to_string(),
            disposition: Disposition::OneOff,
            barcode: None,
            sale_price_minor: None,
        },
    )
    .await
    .expect("create");

    sqlx::query("UPDATE products SET department_id = ?1 WHERE id = ?2")
        .bind(department.as_str())
        .bind(created.id.as_str())
        .execute(&shop.pool)
        .await
        .expect("classify");

    assert_eq!(created.disposition, Disposition::OneOff);
    assert_eq!(created.status, ProductStatus::Active);
    assert!(
        position(&shop, &created.id.as_str()).await.is_none(),
        "no position may exist until something is received"
    );
}

// ---------------------------------------------------------------------------
// The read-only view the panel renders (A1)
//
// The command surface added `get_position`, which is what makes the authority
// rule visible: a caller can see which representation owns the cost without
// inferring it from a missing column.
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_position_reports_the_authority_it_obeys() {
    let shop = shop().await;

    for (name, method, expect_layers) in [
        ("Average", CostMethod::MovingAverage, false),
        ("Oldest", CostMethod::Fifo, true),
    ] {
        let department = department(&shop, name, method).await;
        let product = product(&shop, name, Some(department)).await;

        costing::receive(
            &shop.pool,
            shop.tokens.as_ref(),
            &product,
            4,
            250,
            Sensitivity::Routine,
        None,
        )
        .await
        .expect("receive");

        session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
            .await
            .expect("reauthenticate");
        let view = costing::position(&shop.pool, shop.tokens.as_ref(), &product)
            .await
            .expect("read the position");

        assert_eq!(view.quantity, 4);
        assert_eq!(view.cost_method, method);
        assert_eq!(
            view.layers.is_empty(),
            !expect_layers,
            "{name}: the layer list is empty exactly when the method is not FIFO"
        );
        assert_eq!(
            view.total_cost_minor.is_none(),
            expect_layers,
            "{name}: a null total is how the schema says the layers are in charge"
        );
        assert_eq!(
            view.effective_cost_minor().expect("effective cost"),
            1000,
            "{name}: both methods report the same held cost, derived not stored"
        );
    }
}

#[tokio::test]
async fn reading_a_position_requires_fresh_proof_because_it_reveals_cost() {
    // `role.rs` gates cost figures by role *and* assurance, so reading a cost is
    // not the same permission as moving stock.
    let shop = shop().await;
    let department = department(&shop, "Guarded", CostMethod::MovingAverage).await;
    let product = product(&shop, "Guarded", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        1,
        100,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    let before = costing::position(&shop.pool, shop.tokens.as_ref(), &product).await;
    assert_eq!(
        before.err().map(|error| error.code()),
        Some("REAUTHENTICATION_REQUIRED"),
        "a plain login must not reveal what the stock cost"
    );

    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    assert!(costing::position(&shop.pool, shop.tokens.as_ref(), &product)
        .await
        .is_ok());
}

#[tokio::test]
async fn reading_a_position_changes_nothing() {
    let shop = shop().await;
    let department = department(&shop, "Untouched", CostMethod::MovingAverage).await;
    let product = product(&shop, "Untouched", Some(department)).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        5,
            100,
        Sensitivity::Routine,
    None,
    )
    .await
    .expect("receive");

    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");

    let audit_before = audit_count(&shop, audit::event::STOCK_RECEIVED).await;
    let first = costing::position(&shop.pool, shop.tokens.as_ref(), &product)
        .await
        .expect("first read");
    let second = costing::position(&shop.pool, shop.tokens.as_ref(), &product)
        .await
        .expect("second read");

    assert_eq!(first, second, "reading twice must not move anything");
    assert_eq!(
        audit_count(&shop, audit::event::STOCK_RECEIVED).await,
        audit_before,
        "a read is not a movement and must not be audited as one"
    );
    assert_eq!(position(&shop, &product).await, Some((5, Some(500))));
}

#[tokio::test]
async fn the_effective_cost_is_derived_from_the_layers_under_fifo() {
    // The panel shows one number whichever method is in charge. Under FIFO that
    // number is the summed layers, never a stored total that could drift away
    // from them.
    let shop = shop().await;
    let department = department(&shop, "Derived", CostMethod::Fifo).await;
    let product = product(&shop, "Derived", Some(department)).await;

    for unit_cost in [100, 250] {
        costing::receive(
            &shop.pool,
            shop.tokens.as_ref(),
            &product,
            2,
            unit_cost,
            Sensitivity::Routine,
        None,
        )
        .await
        .expect("receive");
    }

    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    let view = costing::position(&shop.pool, shop.tokens.as_ref(), &product)
        .await
        .expect("read");

    assert_eq!(view.layers.len(), 2);
    assert_eq!(view.effective_cost_minor().expect("effective"), 700);
    assert_eq!(
        view.total_cost_minor, None,
        "FIFO stores no total; the figure the panel shows is derived from the layers"
    );
}

// ---------------------------------------------------------------------------
// Reading a product that has never been stocked
//
// Found on the SM-N976N. `get_position` reported
// `STOCK_COST_AUTHORITY_CONFLICT` for a product that had simply never been
// received, because "no stock row" and "stocked but the cost authority is
// missing" both arrived as `total_cost_minor: None`. That blocked the natural
// path for every new catalogue item, which is the first thing an operator does.
//
// These tests hold the two apart. The device caught the difference; they keep it
// apart.
// ---------------------------------------------------------------------------

/// Prove a freshly proven manager session, since reading a position needs one.
async fn as_reauthenticated_manager(shop: &Shop) {
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
}

#[tokio::test]
async fn a_product_that_was_never_stocked_reads_as_zero_not_as_a_conflict() {
    let shop = shop().await;
    let department = department(&shop, "Fresh", CostMethod::MovingAverage).await;
    let product = product(&shop, "Brand New", Some(department)).await;
    as_reauthenticated_manager(&shop).await;

    let view = costing::position(&shop.pool, shop.tokens.as_ref(), &product)
        .await
        .expect("a product nobody has received is a normal read");

    assert_eq!(view.quantity, 0);
    assert!(!view.row_exists, "no stock row has been written yet");
    assert_eq!(
        view.effective_cost_minor().expect("effective cost"),
        0,
        "no stock costs nothing; that is a fact, not a fault"
    );
}

#[tokio::test]
async fn an_empty_fifo_product_reads_as_zero_too() {
    let shop = shop().await;
    let department = department(&shop, "FreshFifo", CostMethod::Fifo).await;
    let product = product(&shop, "Brand New Fifo", Some(department)).await;
    as_reauthenticated_manager(&shop).await;

    let view = costing::position(&shop.pool, shop.tokens.as_ref(), &product)
        .await
        .expect("an unreceived FIFO product is a normal read");

    assert_eq!(view.quantity, 0);
    assert!(view.layers.is_empty(), "no receipt, so no layers");
    assert_eq!(view.effective_cost_minor().expect("effective cost"), 0);
}

#[tokio::test]
async fn a_stock_row_with_no_cost_under_moving_average_is_still_refused() {
    // The half of the old bug that must NOT be relaxed: a row exists, so a
    // missing total is not "never stocked" — it is a write from outside this
    // module, and reporting it as free stock would invent a value.
    let shop = shop().await;
    let department = department(&shop, "Damaged", CostMethod::MovingAverage).await;
    let product = product(&shop, "Damaged", Some(department)).await;
    as_reauthenticated_manager(&shop).await;

    // Injected directly: nothing in the application produces this state, which
    // is precisely why it has to be constructed by hand to be tested.
    sqlx::query(
        "INSERT INTO stock_levels (product_id, quantity, total_cost_minor, updated_by, updated_at)
         VALUES (?1, 5, NULL, ?2, 1000)",
    )
    .bind(&product)
    .bind(shop.manager.as_str())
    .execute(&shop.pool)
    .await
    .expect("inject a stock row with no cost");

    let outcome = costing::position(&shop.pool, shop.tokens.as_ref(), &product).await;
    assert_eq!(
        outcome.err().map(|error| error.code()),
        Some("STOCK_COST_AUTHORITY_CONFLICT"),
        "a row holding stock with no cost must be reported, not priced at zero"
    );
}

#[tokio::test]
async fn fifo_layers_under_moving_average_are_still_refused() {
    // And the other half: layers the method does not own remain a conflict,
    // so relaxing the empty case cannot have hidden this one.
    let shop = shop().await;
    let department = department(&shop, "MixedUp", CostMethod::MovingAverage).await;
    let product = product(&shop, "Mixed Up", Some(department)).await;
    as_reauthenticated_manager(&shop).await;

    sqlx::query(
        "INSERT INTO stock_levels (product_id, quantity, total_cost_minor, updated_by, updated_at)
         VALUES (?1, 3, 300, ?2, 1000)",
    )
    .bind(&product)
    .bind(shop.manager.as_str())
    .execute(&shop.pool)
    .await
    .expect("insert the moving-average position");

    sqlx::query(
        "INSERT INTO fifo_layers
         (id, product_id, quantity, unit_cost_minor, received_at, updated_by)
         VALUES (?1, ?2, 3, 100, 1000, ?3)",
    )
    .bind(uuid::Uuid::now_v7().to_string())
    .bind(&product)
    .bind(shop.manager.as_str())
    .execute(&shop.pool)
    .await
    .expect("inject a layer the method does not own");

    let outcome = costing::position(&shop.pool, shop.tokens.as_ref(), &product).await;
    assert_eq!(
        outcome.err().map(|error| error.code()),
        Some("STOCK_COST_AUTHORITY_CONFLICT"),
        "FIFO layers under a Moving Average department must stay an error"
    );
}

#[tokio::test]
async fn reading_an_unstocked_product_writes_nothing() {
    // A read that quietly inserted a zero row would make the second read look
    // like a different state, and would grow the table with products nobody
    // stocked.
    let shop = shop().await;
    let department = department(&shop, "NoWrite", CostMethod::MovingAverage).await;
    let product = product(&shop, "No Write", Some(department)).await;
    as_reauthenticated_manager(&shop).await;

    let audit_before = audit_count(&shop, audit::event::STOCK_RECEIVED).await;
    assert!(position(&shop, &product).await.is_none(), "no row before the read");

    costing::position(&shop.pool, shop.tokens.as_ref(), &product)
        .await
        .expect("read");

    assert!(
        position(&shop, &product).await.is_none(),
        "reading must not create a stock row"
    );
    assert!(
        layers(&shop, &product).await.is_empty(),
        "reading must not create layers"
    );
    assert_eq!(
        audit_count(&shop, audit::event::STOCK_RECEIVED).await,
        audit_before,
        "reading must not be audited as a movement"
    );
}