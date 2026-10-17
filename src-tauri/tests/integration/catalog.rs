//! Product catalogue integration tests against real SQLite.
//!
//! These prove the claims that unit tests cannot: that NULL and zero stay
//! distinguishable in a real column, that the UNIQUE index on a nullable
//! barcode permits many products without one, that archive is not delete, and
//! that attribution is written from the session rather than from the caller.
//!
//! The credential store is the same in-memory double the identity tests use; no
//! test touches the developer's real OS keyring.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::{CatalogError, Disposition, ProductId, ProductStatus};
use mobile_shop_system_lib::domain::identity::{Permission, Role, Session};
use mobile_shop_system_lib::services::catalog::product::{
    self as use_cases, NewProduct, ProductPatch,
};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::users;
use mobile_shop_system_lib::services::identity::{
    auth, bootstrap, session as session_service, IdentityContext,
};
use sqlx::SqlitePool;

const PASSWORD: &str = "correct horse battery";

/// A signed-in manager plus a catalogue context.
///
/// The session is obtained by really logging in rather than by constructing one,
/// so the token/digest pairing is the real thing. Tests that need a role other
/// than Manager build their own user and log in as them.
async fn ctx_as_manager() -> (CatalogContext, Session) {
    let pool: SqlitePool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());

    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    let ctx = CatalogContext::new(pool, tokens);
    // Resolved exactly as a command resolves it: read the token from the store,
    // find its digest, rebuild the session. Going through `resolve` rather than
    // reusing `login`'s return value keeps these tests on the real command path.
    let session = session_service::resolve(&ctx.pool, ctx.tokens.as_ref())
        .await
        .expect("resolve the session the way a command does");
    (ctx, session)
}

/// A second, non-manager user, signed in on the same database.
///
/// Created through the real `users::create_user` service rather than by writing the
/// `users` row by hand. The identity slice used to have no staff-creation use case,
/// so this harness inserted the row directly - which is exactly what broke once
/// migration `0003` added `user_credentials`: an account without a credentials row
/// is refused at login, correctly, because that is a broken invariant.
///
/// Using the real service keeps the test honest: the account is created, given a
/// username, audited and signed in through the same paths a manager would use.
async fn sign_in_seller(ctx: &CatalogContext, name: &str) -> Session {
    let mut conn = ctx.pool.acquire().await.expect("connection");
    let manager_id: String = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&mut *conn)
        .await
        .expect("a user exists");
    drop(conn);

    let identity = IdentityContext::new(ctx.pool.clone(), Arc::new(InMemoryTokenStore::new()));
    session_service::reauthenticate(&ctx.pool, ctx.tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate the manager");
    let manager = session_service::resolve(&ctx.pool, ctx.tokens.as_ref())
        .await
        .expect("manager session after re-authentication");
    assert_eq!(manager.user_id().as_str(), manager_id, "precondition: the manager");

    let id = users::create_user(
        &identity.pool,
        &manager,
        name,
        &format!("seller-{}", &manager_id[..8]),
        Role::Sales,
        PASSWORD,
    )
    .await
    .expect("create the sales user through the real service");

    auth::login(&ctx.pool, ctx.tokens.as_ref(), id, PASSWORD)
        .await
        .expect("login as sales user");

    session_service::resolve(&ctx.pool, ctx.tokens.as_ref())
        .await
        .expect("resolve the sales session")
}

fn new_product(name: &str) -> NewProduct {
    NewProduct {
        name: name.to_string(),
        disposition: Disposition::Quantity,
        barcode: None,
        sale_price_minor: None,
        category: None,
    }
}

// ---------------------------------------------------------------------------
// NULL versus zero
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unset_sale_price_stays_null_through_a_real_column() {
    let (ctx, session) = ctx_as_manager().await;
    let created = use_cases::create(&ctx, &session, new_product("بدون سعر"))
        .await
        .expect("create");
    assert!(
        created.sale_price.is_none(),
        "a product created without a price must have no price"
    );

    // Read it back through the repository rather than trusting the return value.
    let raw: Option<i64> = sqlx::query_scalar("SELECT sale_price_minor FROM products WHERE id = ?1")
        .bind(created.id.as_str())
        .fetch_one(&ctx.pool)
        .await
        .expect("row");
    assert!(raw.is_none(), "the column must hold SQL NULL, not 0");

    let reloaded = use_cases::get(&ctx, &session, created.id).await.expect("get");
    assert!(reloaded.sale_price.is_none(), "NULL must survive the round trip");
}

#[tokio::test]
async fn a_zero_sale_price_is_a_free_product_and_not_an_unset_one() {
    let (ctx, session) = ctx_as_manager().await;
    let input = NewProduct {
        sale_price_minor: Some(0),
        ..new_product("مجاني")
    };
    let created = use_cases::create(&ctx, &session, input).await.expect("create");

    let reloaded = use_cases::get(&ctx, &session, created.id).await.expect("get");
    assert_eq!(
        reloaded.sale_price.map(|p| p.as_minor()),
        Some(0),
        "0 means free and must not read back as unset"
    );
}

#[tokio::test]
async fn an_unset_price_can_be_set_later_and_cleared_again() {
    let (ctx, session) = ctx_as_manager().await;
    let created = use_cases::create(&ctx, &session, new_product("مؤجل"))
        .await
        .expect("create");

    let priced = use_cases::update(
        &ctx,
        &session,
        created.id,
        ProductPatch {
            sale_price_minor: Some(Some(10_050)),
            ..Default::default()
        },
    )
    .await
    .expect("set price");
    assert_eq!(priced.sale_price.map(|p| p.as_minor()), Some(10_050));

    // `Some(None)` clears it; an absent field would have left it alone.
    let cleared = use_cases::update(
        &ctx,
        &session,
        created.id,
        ProductPatch {
            sale_price_minor: Some(None),
            ..Default::default()
        },
    )
    .await
    .expect("clear price");
    assert!(
        cleared.sale_price.is_none(),
        "clearing must return the product to unset, not to free"
    );
}

#[tokio::test]
async fn a_negative_price_is_refused() {
    let (ctx, session) = ctx_as_manager().await;
    let input = NewProduct {
        sale_price_minor: Some(-1),
        ..new_product("سالب")
    };
    let result = use_cases::create(&ctx, &session, input).await;
    assert!(
        matches!(result, Err(CatalogError::PriceNegative)),
        "a negative price must be refused, got {result:?}"
    );
}

// ---------------------------------------------------------------------------
// Barcode
// ---------------------------------------------------------------------------

#[tokio::test]
async fn many_products_may_have_no_barcode_at_all() {
    // A UNIQUE index on a nullable column must not be read as "one product".
    let (ctx, session) = ctx_as_manager().await;
    for name in ["أ", "ب", "ج"] {
        use_cases::create(&ctx, &session, new_product(name))
            .await
            .expect("create without a barcode");
    }
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products WHERE barcode IS NULL")
        .fetch_one(&ctx.pool)
        .await
        .expect("count");
    assert_eq!(rows, 3, "all three must be stored with a NULL barcode");
}

#[tokio::test]
async fn a_duplicate_barcode_is_refused_by_the_index() {
    let (ctx, session) = ctx_as_manager().await;
    let input = NewProduct {
        barcode: Some("6221031492039".to_string()),
        ..new_product("أول")
    };
    use_cases::create(&ctx, &session, input).await.expect("first");

    let clash = NewProduct {
        barcode: Some("6221031492039".to_string()),
        ..new_product("ثاني")
    };
    let result = use_cases::create(&ctx, &session, clash).await;
    assert!(
        matches!(result, Err(CatalogError::BarcodeAlreadyExists)),
        "a duplicate barcode must be reported as such, got {result:?}"
    );
}

#[tokio::test]
async fn barcode_lookup_is_case_insensitive_and_needs_no_scanner() {
    let (ctx, session) = ctx_as_manager().await;
    let input = NewProduct {
        barcode: Some("AbC-123".to_string()),
        ..new_product("باركود")
    };
    let created = use_cases::create(&ctx, &session, input).await.expect("create");

    // Typed or pasted, in any case.
    let found = use_cases::find_by_barcode(&ctx, &session, "abc-123")
        .await
        .expect("case-insensitive match");
    assert_eq!(found.id, created.id);

    assert!(
        matches!(
            use_cases::find_by_barcode(&ctx, &session, "nope").await,
            Err(CatalogError::NoProductWithThisId)
        ),
        "an unknown barcode must report not found"
    );
}

// ---------------------------------------------------------------------------
// Archive, not delete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn archiving_keeps_the_row_and_hides_it_from_the_active_list() {
    let (ctx, session) = ctx_as_manager().await;
    let created = use_cases::create(&ctx, &session, new_product("مؤرشف"))
        .await
        .expect("create");

    use_cases::set_status(&ctx, &session, created.id, ProductStatus::Archived)
        .await
        .expect("archive");

    let active = use_cases::list(&ctx, &session, ProductStatus::Active)
        .await
        .expect("list active");
    assert!(active.is_empty(), "an archived product must not appear as active");

    let archived = use_cases::list(&ctx, &session, ProductStatus::Archived)
        .await
        .expect("list archived");
    assert_eq!(archived.len(), 1, "it must still be listed when asked for");

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
        .fetch_one(&ctx.pool)
        .await
        .expect("count");
    assert_eq!(rows, 1, "archiving must not remove the row");
}

#[tokio::test]
async fn an_archived_product_refuses_ordinary_edits() {
    let (ctx, session) = ctx_as_manager().await;
    let created = use_cases::create(&ctx, &session, new_product("مقفل"))
        .await
        .expect("create");
    use_cases::set_status(&ctx, &session, created.id, ProductStatus::Archived)
        .await
        .expect("archive");

    let result = use_cases::update(
        &ctx,
        &session,
        created.id,
        ProductPatch {
            name: Some("اسم جديد".to_string()),
            ..Default::default()
        },
    )
    .await;
    assert!(
        matches!(result, Err(CatalogError::ProductArchived)),
        "an archived product must refuse edits, got {result:?}"
    );
}

#[tokio::test]
async fn an_archived_product_can_be_reactivated() {
    let (ctx, session) = ctx_as_manager().await;
    let created = use_cases::create(&ctx, &session, new_product("يعود"))
        .await
        .expect("create");
    use_cases::set_status(&ctx, &session, created.id, ProductStatus::Archived)
        .await
        .expect("archive");
    let restored = use_cases::set_status(&ctx, &session, created.id, ProductStatus::Active)
        .await
        .expect("reactivate");
    assert_eq!(restored.status, ProductStatus::Active);
}

// ---------------------------------------------------------------------------
// Attribution and authorization
// ---------------------------------------------------------------------------

#[tokio::test]
async fn attribution_comes_from_the_session_on_both_write_and_edit() {
    let (ctx, session) = ctx_as_manager().await;
    let manager = session.user_id();
    let created = use_cases::create(&ctx, &session, new_product("منسوب"))
        .await
        .expect("create");
    assert_eq!(created.created_by, manager, "created_by must be the session user");
    assert_eq!(created.updated_by, manager);

    let renamed = use_cases::update(
        &ctx,
        &session,
        created.id,
        ProductPatch {
            name: Some("منسوب معدّل".to_string()),
            ..Default::default()
        },
    )
    .await
    .expect("update");
    assert_eq!(
        renamed.updated_by, manager,
        "updated_by must come from the session"
    );
    // Monotonic, not strictly increasing. `Timestamp` is milliseconds since the
    // epoch, so a create and an edit issued inside the same millisecond are
    // indistinguishable at this resolution. Asserting `!=` here was a latent flake:
    // it failed roughly one run in three, depending on scheduling. The meaningful
    // guarantee is that the edit never moves the timestamp backwards.
    assert!(
        renamed.updated_at >= created.updated_at,
        "an edit must not move updated_at backwards ({} -> {})",
        created.updated_at,
        renamed.updated_at
    );
    assert_ne!(
        renamed.name.as_str(),
        created.name.as_str(),
        "the edit must have been persisted"
    );
}

#[tokio::test]
async fn a_user_without_catalogue_permission_is_refused() {
    let (ctx, _) = ctx_as_manager().await;
    let seller = sign_in_seller(&ctx, "مندوب").await;

    assert!(
        !seller.authorize(Permission::ManageCatalog).is_ok(),
        "precondition: a seller must not hold ManageCatalog"
    );
    let result = use_cases::list(&ctx, &seller, ProductStatus::Active).await;
    assert!(
        matches!(result, Err(CatalogError::PermissionDenied)),
        "a denial must be reported as a denial, not as an empty list or a \\
         missing product; got {result:?}"
    );
}

#[tokio::test]
async fn a_refused_write_leaves_no_row_behind() {
    let (ctx, _) = ctx_as_manager().await;
    let seller = sign_in_seller(&ctx, "مندوب آخر").await;

    let result = use_cases::create(&ctx, &seller, new_product("ممنوع")).await;
    assert!(matches!(result, Err(CatalogError::PermissionDenied)));

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM products")
        .fetch_one(&ctx.pool)
        .await
        .expect("count");
    assert_eq!(rows, 0, "a refused create must not insert anything");
}

#[tokio::test]
async fn an_empty_name_is_refused() {
    let (ctx, session) = ctx_as_manager().await;
    let result = use_cases::create(&ctx, &session, new_product("   ")).await;
    assert!(
        matches!(result, Err(CatalogError::NameRequired)),
        "a blank name must be refused, got {result:?}"
    );
}

#[tokio::test]
async fn two_products_may_share_a_name() {
    // D8: names are not unique. The database must allow the pair.
    let (ctx, session) = ctx_as_manager().await;
    use_cases::create(&ctx, &session, new_product("مكرر")).await.expect("first");
    use_cases::create(&ctx, &session, new_product("مكرر")).await.expect("second");

    let listed = use_cases::list(&ctx, &session, ProductStatus::Active)
        .await
        .expect("list");
    assert_eq!(listed.len(), 2, "a duplicate name is allowed");
}

#[tokio::test]
async fn the_serialized_disposition_is_storable_without_inventory() {
    // D1/D2: the disposition is recorded now; nothing tracks units yet.
    let (ctx, session) = ctx_as_manager().await;
    let input = NewProduct {
        disposition: Disposition::Serialized,
        ..new_product("ساعة")
    };
    let created = use_cases::create(&ctx, &session, input).await.expect("create");
    assert_eq!(created.disposition, Disposition::Serialized);

    let reloaded = use_cases::get(&ctx, &session, created.id).await.expect("get");
    assert_eq!(reloaded.disposition, Disposition::Serialized);
}

#[tokio::test]
async fn a_missing_product_reports_not_found_rather_than_failing_opaquely() {
    let (ctx, session) = ctx_as_manager().await;
    let absent = ProductId::generate();
    assert!(matches!(
        use_cases::get(&ctx, &session, absent).await,
        Err(CatalogError::NoProductWithThisId)
    ));
}

// ---------------------------------------------------------------------------
// The shop's own barcode (ADR-018 §3, PLAN §6)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_next_shop_code_reads_the_codes_already_stored() {
    let (ctx, session) = ctx_as_manager().await;
    let first = NewProduct {
        barcode: Some("2000000000015".to_string()),
        ..new_product("جراب")
    };
    use_cases::create(&ctx, &session, first).await.expect("create");

    // A manufacturer's barcode, and a short code that merely starts with 2,
    // must not move the shop's numbering.
    for barcode in ["4006381333931", "2123"] {
        let input = NewProduct {
            barcode: Some(barcode.to_string()),
            ..new_product("صنف")
        };
        use_cases::create(&ctx, &session, input).await.expect("create");
    }

    assert_eq!(
        use_cases::next_shop_code(&ctx, &session).await.expect("next"),
        "2000000000022"
    );
}

#[tokio::test]
async fn a_generated_code_can_be_stored_and_the_next_one_moves_on() {
    let (ctx, session) = ctx_as_manager().await;
    let first = use_cases::next_shop_code(&ctx, &session).await.expect("first");
    assert_eq!(first, "2000000000015");

    let input = NewProduct {
        barcode: Some(first),
        ..new_product("جراب")
    };
    use_cases::create(&ctx, &session, input).await.expect("create");

    assert_eq!(
        use_cases::next_shop_code(&ctx, &session).await.expect("second"),
        "2000000000022"
    );
}

#[tokio::test]
async fn a_seller_may_not_ask_for_a_shop_code() {
    let (ctx, _) = ctx_as_manager().await;
    let seller = sign_in_seller(&ctx, "مندوب").await;
    let result = use_cases::next_shop_code(&ctx, &seller).await;
    assert!(
        matches!(result, Err(CatalogError::PermissionDenied)),
        "got {result:?}"
    );
}
