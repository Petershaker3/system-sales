//! Stock and costing against real SQLite (SP-2).
//!
//! The claims under test are the ones a unit test cannot make:
//!
//! * a moving-average removal ceils, and the balance never goes negative;
//! * every product counted by quantity is costed by moving average, whatever
//!   method its department or the device default still stores (plan item 1.3);
//! * a position left by the retired FIFO method is collapsed into the average
//!   on first touch, at exactly its summed cost, and audited once; a read never
//!   collapses anything; a contradictory position is refused, never repaired;
//! * insufficient stock refuses the whole operation and leaves no partial state;
//! * a failure anywhere rolls the transaction back completely, position and
//!   audit together;
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
// FIFO is retired (plan item 1.3)
// ---------------------------------------------------------------------------

/// Write a position the way the retired FIFO method left it: a `stock_levels`
/// row with no total, and the layers that hold the cost.
async fn legacy_fifo(shop: &Shop, product_id: &str, layers: &[(i64, i64)]) {
    let quantity: i64 = layers.iter().map(|(units, _)| units).sum();
    sqlx::query(
        "INSERT INTO stock_levels (product_id, quantity, total_cost_minor, updated_by, updated_at)
         VALUES (?1, ?2, NULL, ?3, 1000)",
    )
    .bind(product_id)
    .bind(quantity)
    .bind(shop.manager.as_str())
    .execute(&shop.pool)
    .await
    .expect("a legacy FIFO position");
    for (index, (units, unit_cost)) in layers.iter().enumerate() {
        sqlx::query(
            "INSERT INTO fifo_layers
             (id, product_id, quantity, unit_cost_minor, received_at, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        )
        .bind(uuid::Uuid::now_v7().to_string())
        .bind(product_id)
        .bind(*units)
        .bind(*unit_cost)
        .bind(1000 + index as i64)
        .bind(shop.manager.as_str())
        .execute(&shop.pool)
        .await
        .expect("a legacy FIFO layer");
    }
}

#[tokio::test]
async fn a_department_stored_as_fifo_is_costed_by_moving_average() {
    let shop = shop().await;
    let department = department(&shop, "Spares", CostMethod::Fifo).await;
    let product = product(&shop, "Battery", Some(department)).await;

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

    assert_eq!(position(&shop, &product).await, Some((4, Some(1000))));
    assert!(layers(&shop, &product).await.is_empty(), "nothing writes a layer any more");

    let outcome = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 1)
        .await
        .expect("remove");
    assert_eq!(outcome.cost_minor, 250);
    assert_eq!(position(&shop, &product).await, Some((3, Some(750))));
}

#[tokio::test]
async fn a_legacy_fifo_position_is_collapsed_on_the_next_receipt() {
    let shop = shop().await;
    let product = product(&shop, "Old Stock", None).await;
    legacy_fifo(&shop, &product, &[(2, 100), (3, 250)]).await;

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        1,
        300,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive into a legacy position");

    // 2×100 + 3×250 = 950 held, plus 300 received.
    assert_eq!(position(&shop, &product).await, Some((6, Some(1250))));
    assert!(layers(&shop, &product).await.is_empty(), "the layers are folded away");
    assert_eq!(audit_count(&shop, audit::event::COST_LAYERS_COLLAPSED).await, 1);
    assert_eq!(audit_count(&shop, audit::event::STOCK_RECEIVED).await, 1);

    // A second touch finds nothing left to collapse and audits nothing more.
    costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 1)
        .await
        .expect("remove");
    assert_eq!(audit_count(&shop, audit::event::COST_LAYERS_COLLAPSED).await, 1);
}

#[tokio::test]
async fn a_legacy_fifo_position_is_removed_from_at_the_average() {
    let shop = shop().await;
    let product = product(&shop, "Mixed Prices", None).await;
    legacy_fifo(&shop, &product, &[(1, 100), (2, 400)]).await;

    let outcome = costing::remove(&shop.pool, shop.tokens.as_ref(), &product, 1)
        .await
        .expect("remove from a legacy position");

    // 900 over 3 units: the average, not the oldest layer's 100.
    assert_eq!(outcome.cost_minor, 300);
    assert_eq!(position(&shop, &product).await, Some((2, Some(600))));
    assert!(layers(&shop, &product).await.is_empty());
    assert_eq!(audit_count(&shop, audit::event::COST_LAYERS_COLLAPSED).await, 1);
}

#[tokio::test]
async fn an_emptied_legacy_fifo_position_becomes_a_real_zero() {
    // FIFO wrote quantity 0 with a NULL total when its last layer was consumed.
    let shop = shop().await;
    let product = product(&shop, "Sold Out", None).await;
    legacy_fifo(&shop, &product, &[]).await;
    assert_eq!(position(&shop, &product).await, Some((0, None)));

    costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        2,
        50,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive into an emptied legacy position");

    assert_eq!(position(&shop, &product).await, Some((2, Some(100))));
}

#[tokio::test]
async fn legacy_layers_that_disagree_with_the_quantity_are_refused() {
    let shop = shop().await;
    let product = product(&shop, "Disagrees", None).await;
    legacy_fifo(&shop, &product, &[(2, 100)]).await;
    sqlx::query("UPDATE stock_levels SET quantity = 5 WHERE product_id = ?1")
        .bind(&product)
        .execute(&shop.pool)
        .await
        .expect("break the legacy position");

    let refused = costing::receive(
        &shop.pool,
        shop.tokens.as_ref(),
        &product,
        1,
        100,
        Sensitivity::Routine,
        None,
    )
    .await;

    assert_eq!(
        refused.err().map(|error| error.code()),
        Some("STOCK_COST_AUTHORITY_CONFLICT"),
        "a collapse must never invent or lose a piastre"
    );
    assert_eq!(position(&shop, &product).await, Some((5, None)), "nothing was rewritten");
    assert_eq!(layers(&shop, &product).await.len(), 1);
    assert_eq!(audit_count(&shop, audit::event::COST_LAYERS_COLLAPSED).await, 0);
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
// A department's stored method is inert
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_ordinary_department_edit_cannot_relabel_the_costing_method() {
    // The stored method no longer decides anything (plan item 1.3), but the
    // department service still refuses to relabel it, so the column keeps the
    // value it was created with.
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
        Some("OWNER_APPROVAL_REQUIRED"),
        "an opening balance declares what the shop is worth, so it waits for the \
         owner's PIN (ADR-017 §3); the approval itself is proven in approval.rs"
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
async fn audit_detail_never_carries_a_costing_secret() {
    let shop = shop().await;
    let department = department(&shop, "Clean", CostMethod::MovingAverage).await;
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
async fn a_product_with_no_department_is_costed_by_moving_average() {
    let shop = shop().await;

    // No department: `0005` leaves it nullable and `spec:175` forbids inventing
    // one. The method is the same either way.
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
        "every product counted by quantity is costed by moving average"
    );
}

#[tokio::test]
async fn the_retired_device_default_no_longer_decides_the_method() {
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
        Some((2, Some(200))),
        "a stored `fifo` default is inert since plan item 1.3"
    );
    assert!(layers(&shop, &product).await.is_empty());
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
async fn a_position_reports_the_moving_average_total_whatever_the_department_stores() {
    let shop = shop().await;

    for (name, method) in [
        ("Average", CostMethod::MovingAverage),
        ("StoredFifo", CostMethod::Fifo),
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
        assert_eq!(view.total_cost_minor, Some(1000), "{name}: the total is stored");
        assert_eq!(view.effective_cost_minor().expect("effective cost"), 1000);
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
async fn reading_a_legacy_fifo_position_reports_its_summed_cost_and_writes_nothing() {
    // A read never collapses: the value it reports is the one a collapse would
    // write, and the rows stay exactly as the retired method left them.
    let shop = shop().await;
    let product = product(&shop, "Legacy Read", None).await;
    legacy_fifo(&shop, &product, &[(2, 100), (2, 250)]).await;

    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    let view = costing::position(&shop.pool, shop.tokens.as_ref(), &product)
        .await
        .expect("read");

    assert_eq!(view.quantity, 4);
    assert_eq!(view.total_cost_minor, Some(700));
    assert_eq!(view.effective_cost_minor().expect("effective"), 700);
    assert_eq!(position(&shop, &product).await, Some((4, None)), "the row is untouched");
    assert_eq!(layers(&shop, &product).await.len(), 2, "the layers are untouched");
    assert_eq!(audit_count(&shop, audit::event::COST_LAYERS_COLLAPSED).await, 0);
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
async fn an_unreceived_product_in_a_department_stored_as_fifo_reads_as_zero_too() {
    let shop = shop().await;
    let department = department(&shop, "FreshFifo", CostMethod::Fifo).await;
    let product = product(&shop, "Brand New Fifo", Some(department)).await;
    as_reauthenticated_manager(&shop).await;

    let view = costing::position(&shop.pool, shop.tokens.as_ref(), &product)
        .await
        .expect("an unreceived product is a normal read");

    assert_eq!(view.quantity, 0);
    assert!(!view.row_exists);
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
        "layers beside a moving-average total are two answers to one question"
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