//! Price history against real SQLite.
//!
//! The catalogue's transactional claim (`plan` Task 10): a price edit and its
//! history row commit together or not at all, attribution comes from the
//! session, unset and set transitions keep NULL distinct from zero, and an
//! edit that never moved the price records nothing.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::domain::catalog::{Disposition, ProductStatus};
use mobile_shop_system_lib::domain::identity::Session;
use mobile_shop_system_lib::services::catalog::product::{self as use_cases, NewProduct, ProductPatch};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session};
use sqlx::SqlitePool;

/// A signed-in manager plus a catalogue context, as the commands build them.
async fn ctx_as_manager() -> (CatalogContext, Session) {
    let pool: SqlitePool = mobile_shop_system_lib::data::db::open_in_memory()
        .await
        .expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());

    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let ctx = CatalogContext::new(pool, tokens);
    let resolved = session::resolve(&ctx.pool, ctx.tokens.as_ref())
        .await
        .expect("resolve the session the way a command does");
    (ctx, resolved)
}

fn product(name: &str, sale_price_minor: Option<i64>) -> NewProduct {
    NewProduct {
        name: name.to_string(),
        disposition: Disposition::Quantity,
        barcode: None,
        sale_price_minor,
    }
}

async fn history_rows(ctx: &CatalogContext) -> Vec<(Option<i64>, Option<i64>)> {
    sqlx::query_as(
        "SELECT old_price_minor, new_price_minor FROM product_price_history ORDER BY rowid",
    )
    .fetch_all(&ctx.pool)
    .await
    .expect("history rows")
}

// ---------------------------------------------------------------------------
// The edit and its history commit together
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_price_change_writes_history_attributed_to_the_session() {
    let (ctx, resolved) = ctx_as_manager().await;
    let created = use_cases::create(&ctx, &resolved, product("Olive oil", Some(1000)))
        .await
        .expect("create");

    let updated = use_cases::update(
        &ctx,
        &resolved,
        created.id,
        ProductPatch {
            sale_price_minor: Some(Some(1200)),
            ..ProductPatch::default()
        },
    )
    .await
    .expect("price change");
    assert_eq!(
        updated.sale_price.as_ref().map(|price| price.as_minor()),
        Some(1200)
    );

    let (old_price, new_price, actor): (i64, i64, String) = sqlx::query_as(
        "SELECT old_price_minor, new_price_minor, actor_id FROM product_price_history",
    )
    .fetch_one(&ctx.pool)
    .await
    .expect("exactly one history row");
    assert_eq!(old_price, 1000, "the old side of the transition");
    assert_eq!(new_price, 1200, "the new side of the transition");
    assert_eq!(
        actor,
        resolved.user_id().as_str(),
        "attribution comes from the session, not from the caller"
    );

    // An edit that leaves the price alone has no transition to record.
    use_cases::update(
        &ctx,
        &resolved,
        created.id,
        ProductPatch {
            name: Some("Extra virgin".to_string()),
            ..ProductPatch::default()
        },
    )
    .await
    .expect("rename");
    assert_eq!(
        history_rows(&ctx).await.len(),
        1,
        "a rename is not a price transition"
    );
}

// ---------------------------------------------------------------------------
// Forced failure leaves neither side
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_forced_failure_leaves_neither_the_price_nor_the_history() {
    let (ctx, resolved) = ctx_as_manager().await;
    let created = use_cases::create(&ctx, &resolved, product("Sea salt", Some(1000)))
        .await
        .expect("create");

    // Fault injection: every history insert aborts, so the transaction can
    // never commit. If history lived outside the edit's transaction, the
    // price would move and the history would not — the exact split the plan
    // forbids.
    sqlx::query(
        "CREATE TRIGGER force_price_history_failure BEFORE INSERT ON product_price_history \
         BEGIN SELECT RAISE(ABORT, 'forced failure'); END",
    )
    .execute(&ctx.pool)
    .await
    .expect("install the fault-injection trigger");

    use_cases::update(
        &ctx,
        &resolved,
        created.id,
        ProductPatch {
            sale_price_minor: Some(Some(1200)),
            ..ProductPatch::default()
        },
    )
    .await
    .expect_err("the history write fails, so the whole edit must fail");

    let fetched = use_cases::get(&ctx, &resolved, created.id)
        .await
        .expect("read the product back");
    assert_eq!(
        fetched.sale_price.as_ref().map(|price| price.as_minor()),
        Some(1000),
        "the price must not move when its history cannot be written"
    );
    assert_eq!(
        history_rows(&ctx).await.len(),
        0,
        "and no history row may survive the failed edit"
    );
}

// ---------------------------------------------------------------------------
// NULL stays distinct from zero across both transitions
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unset_and_set_transitions_are_recorded_with_null_intact() {
    let (ctx, resolved) = ctx_as_manager().await;
    let created = use_cases::create(&ctx, &resolved, product("Unpriced", None))
        .await
        .expect("create with no price");

    // unset -> set
    use_cases::update(
        &ctx,
        &resolved,
        created.id,
        ProductPatch {
            sale_price_minor: Some(Some(500)),
            ..ProductPatch::default()
        },
    )
    .await
    .expect("first price");

    // set -> unset
    use_cases::update(
        &ctx,
        &resolved,
        created.id,
        ProductPatch {
            sale_price_minor: Some(None),
            ..ProductPatch::default()
        },
    )
    .await
    .expect("clear the price");

    let fetched = use_cases::get(&ctx, &resolved, created.id)
        .await
        .expect("read back");
    assert!(
        fetched.sale_price.is_none(),
        "cleared must read as never set, not as zero"
    );

    assert_eq!(
        history_rows(&ctx).await,
        vec![(None, Some(500)), (Some(500), None)],
        "both transitions must be recorded with NULL preserved on the unset side"
    );

    let archived = use_cases::list(&ctx, &resolved, ProductStatus::Active)
        .await
        .expect("list");
    assert_eq!(archived.len(), 1, "the product still exists");
}
