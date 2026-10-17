//! Display choices (`ui.*` rows; DESIGN.md, plan items 1.6 and 1.13).
//!
//! The claims: they read before anyone signs in, with the approved defaults;
//! the light/dark switch is for every role while the rest is the owner's,
//! behind a fresh password; values outside the choices are refused; and a
//! stored display choice can never fail a sale, which reads the settings
//! snapshot inside its own transaction.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::{Role, Sensitivity};
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::sales::{self as sales, SaleLineInput};
use mobile_shop_system_lib::services::settings::{self as settings, appearance};
use sqlx::SqlitePool;

async fn signed_in_manager() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");
    (pool, tokens)
}

#[tokio::test]
async fn the_choices_read_before_sign_in_with_the_approved_defaults() {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let read = appearance::read(&pool).await.expect("readable with nobody signed in");
    assert_eq!(read.look, "plate");
    assert_eq!(read.theme, "light");
    assert_eq!(read.accent, "#1d4f91");
    assert_eq!(read.font, "auto");
    assert_eq!(read.scale, "normal");
    assert_eq!(read.digits, "latin");
}

#[tokio::test]
async fn the_owner_changes_the_look_with_a_fresh_password() {
    let (pool, tokens) = signed_in_manager().await;

    let refused = appearance::update(&pool, tokens.as_ref(), "ui.look", "box").await;
    assert_eq!(
        refused.err().map(|e| e.code()),
        Some("REAUTHENTICATION_REQUIRED"),
        "the owner's choices need the same fresh password as every setting"
    );

    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    let after = appearance::update(&pool, tokens.as_ref(), "ui.look", "box")
        .await
        .expect("change the look");
    assert_eq!(after.look, "box");
    let accent = appearance::update(&pool, tokens.as_ref(), "ui.accent", "#0F6E5A")
        .await
        .expect("change the shop colour");
    assert_eq!(accent.accent, "#0f6e5a", "stored lower case");
    assert_eq!(appearance::read(&pool).await.expect("read").look, "box");

    let audited: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = 'setting_changed' AND detail LIKE '%ui.%'",
    )
    .fetch_one(&pool)
    .await
    .expect("audit count");
    assert_eq!(audited, 2);
}

#[tokio::test]
async fn a_seller_may_switch_light_and_dark_but_nothing_else() {
    let (pool, tokens) = signed_in_manager().await;
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    let manager = session::resolve(&pool, tokens.as_ref()).await.expect("manager");
    let seller = users::create_user(&pool, &manager, "Youssef", "youssef", Role::Sales, PASSWORD)
        .await
        .expect("a seller");
    auth::login(&pool, tokens.as_ref(), seller, PASSWORD)
        .await
        .expect("login as the seller");

    let dark = appearance::update(&pool, tokens.as_ref(), "ui.theme", "dark")
        .await
        .expect("the rail switch is for everyone");
    assert_eq!(dark.theme, "dark");

    let refused = appearance::update(&pool, tokens.as_ref(), "ui.accent", "#b3261e").await;
    assert_eq!(refused.err().map(|e| e.code()), Some("PERMISSION_DENIED"));
    assert_eq!(appearance::read(&pool).await.expect("read").accent, "#1d4f91");
}

#[tokio::test]
async fn values_outside_the_choices_and_unknown_keys_are_refused() {
    let (pool, tokens) = signed_in_manager().await;
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");

    for (key, value, code) in [
        ("ui.look", "neon", "SETTING_VALUE_INVALID"),
        ("ui.accent", "blue", "SETTING_VALUE_INVALID"),
        ("ui.theme", "dim", "SETTING_VALUE_INVALID"),
        ("ui.wallpaper", "x", "SETTING_UNKNOWN_KEY"),
    ] {
        let refused = appearance::update(&pool, tokens.as_ref(), key, value).await;
        assert_eq!(refused.err().map(|e| e.code()), Some(code), "{key}={value}");
    }
    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM app_settings WHERE key LIKE 'ui.%'")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(stored, 0, "nothing refused was written");

    // The device settings path keeps refusing display keys: they have their own door.
    let through_settings = settings::update(&pool, tokens.as_ref(), "ui.look", "box").await;
    assert_eq!(through_settings.err().map(|e| e.code()), Some("SETTING_UNKNOWN_KEY"));
}

#[tokio::test]
async fn a_stored_display_choice_never_fails_a_sale_or_the_settings_read() {
    let (pool, tokens) = signed_in_manager().await;
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    appearance::update(&pool, tokens.as_ref(), "ui.look", "box")
        .await
        .expect("store a display choice");
    appearance::update(&pool, tokens.as_ref(), "ui.theme", "dark")
        .await
        .expect("and another");

    settings::read_snapshot(&pool, tokens.as_ref())
        .await
        .expect("the settings snapshot skips display rows");

    let ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let current = session::resolve(&pool, tokens.as_ref()).await.expect("session");
    let product = catalog::create(
        &ctx,
        &current,
        NewProduct {
            name: "Cable".to_string(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(5000),
            category: None,
        },
    )
    .await
    .expect("product");
    let id = product.id.as_str().to_string();
    inventory::receive(&pool, tokens.as_ref(), &id, 2, 3000, Sensitivity::Routine, None)
        .await
        .expect("receive");
    sales::record_sale(
        &pool,
        tokens.as_ref(),
        &[SaleLineInput {
            product_id: id,
            quantity: 1,
            warranty_start: None,
            warranty_end: None,
        }],
        Some(5000),
    )
    .await
    .expect("a sale reads the snapshot and is not disturbed by display rows");
}
