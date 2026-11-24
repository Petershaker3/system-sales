//! Plan item 1.15 (`ADR-030`): manual and system-suggested shortages (`النواقص`),
//! duplicate merging, creator-or-owner deletion rule, and auto-resolution on stock receipt.

use std::sync::Arc;

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::domain::catalog::Disposition;
use mobile_shop_system_lib::domain::identity::{Role, Sensitivity, UserId};
use mobile_shop_system_lib::domain::shortage::ShortageError;
use mobile_shop_system_lib::services::catalog::product::{self as catalog, NewProduct};
use mobile_shop_system_lib::services::catalog::CatalogContext;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::inventory::stock as inventory;
use mobile_shop_system_lib::services::shortage::{
    self as shortage_service, AddShortageInput, ShortageServiceError,
};
use sqlx::SqlitePool;

async fn setup_shop_for_shortages() -> (
    SqlitePool,
    Arc<InMemoryTokenStore>,
    UserId,
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

    let seller1_uid = users::create_user(
        &pool,
        &manager_session,
        "Youssef",
        "youssef",
        Role::Sales,
        PASSWORD,
    )
    .await
    .expect("create seller 1");

    let seller2_uid = users::create_user(
        &pool,
        &manager_session,
        "Marina",
        "marina",
        Role::Sales,
        PASSWORD,
    )
    .await
    .expect("create seller 2");

    let ctx = CatalogContext::new(pool.clone(), tokens.clone());
    let cable = catalog::create(
        &ctx,
        &manager_session,
        NewProduct {
            name: "كابل لايتنينج للآيفون".to_owned(),
            disposition: Disposition::Quantity,
            barcode: None,
            sale_price_minor: Some(22_000),
            category: None,
        },
    )
    .await
    .expect("create cable");
    let cable_id = cable.id.as_str().to_string();

    // Receive 3 units of cable (below min_qty = 5, so suggested_qty = 2*5 - 3 = 7)
    inventory::receive(
        &pool,
        tokens.as_ref(),
        &cable_id,
        3,
        9_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive cable");

    (pool, tokens, manager_uid, seller1_uid, seller2_uid, cable_id)
}

#[tokio::test]
async fn shortages_merge_duplicates_enforce_creator_or_owner_delete_and_resolve_on_receive() {
    let (pool, tokens, manager_uid, seller1_uid, seller2_uid, cable_id) =
        setup_shop_for_shortages().await;

    // 1. System suggestions include the low-stock cable (on_hand = 3, min = 5, suggested = 7)
    let ov0 = shortage_service::shortages_overview(&pool, tokens.as_ref())
        .await
        .expect("initial overview");
    assert!(ov0.items.is_empty());
    let cable_sug = ov0
        .suggestions
        .iter()
        .find(|s| s.product_id == cable_id)
        .expect("cable in suggestions");
    assert_eq!(cable_sug.on_hand, 3);
    assert_eq!(cable_sug.min_qty, 5);
    assert_eq!(cable_sug.suggested_qty, 7);

    // 2. Seller 1 (Youssef) logs in and adds a free-text shortage with waiting customer
    auth::login(&pool, tokens.as_ref(), seller1_uid, PASSWORD)
        .await
        .expect("seller1 login");

    let added_free = shortage_service::add_shortage(
        &pool,
        tokens.as_ref(),
        AddShortageInput {
            product_id: None,
            name: Some("شاحن 65 وات تايب سي".to_owned()),
            qty: 2,
            note: Some("مطلوب سريع".to_owned()),
            customer_name: Some("كريم مصطفى".to_owned()),
            customer_phone: Some("01011122233".to_owned()),
        },
    )
    .await
    .expect("add free-text shortage");
    assert!(!added_free.merged);
    assert_eq!(added_free.entry.qty, 2);
    assert_eq!(added_free.entry.created_by, seller1_uid.as_str());

    // Adding the same free-text shortage again merges and increments qty to 5
    let merged_free = shortage_service::add_shortage(
        &pool,
        tokens.as_ref(),
        AddShortageInput {
            product_id: None,
            name: Some("  شاحن ٦٥ وات تايب سى ".to_owned()),
            qty: 3,
            note: None,
            customer_name: None,
            customer_phone: None,
        },
    )
    .await
    .expect("merge free-text shortage");
    assert!(merged_free.merged);
    assert_eq!(merged_free.entry.id, added_free.entry.id);
    assert_eq!(merged_free.entry.qty, 5);

    // 3. Seller 1 adds the cable product to shortages; it leaves system suggestions
    let added_prod = shortage_service::add_shortage(
        &pool,
        tokens.as_ref(),
        AddShortageInput {
            product_id: Some(cable_id.clone()),
            name: None,
            qty: 7,
            note: None,
            customer_name: None,
            customer_phone: None,
        },
    )
    .await
    .expect("add product shortage");
    assert!(!added_prod.merged);
    assert_eq!(added_prod.entry.product_id.as_deref(), Some(cable_id.as_str()));

    let ov1 = shortage_service::shortages_overview(&pool, tokens.as_ref())
        .await
        .expect("overview after product shortage");
    assert_eq!(ov1.items.len(), 2);
    assert!(!ov1.suggestions.iter().any(|s| s.product_id == cable_id));

    // 4. Seller 2 (Marina) logs in: can update status to 'ordered', but CANNOT delete Seller 1's shortage
    auth::login(&pool, tokens.as_ref(), seller2_uid, PASSWORD)
        .await
        .expect("seller2 login");

    let updated_st = shortage_service::set_shortage_status(
        &pool,
        tokens.as_ref(),
        &added_free.entry.id,
        "ordered",
    )
    .await
    .expect("seller2 updates status");
    assert_eq!(updated_st.status, "ordered");

    let del_err = shortage_service::delete_shortage(&pool, tokens.as_ref(), &added_free.entry.id)
        .await
        .expect_err("seller2 cannot delete seller1 shortage");
    assert_eq!(
        del_err,
        ShortageServiceError::Shortage(ShortageError::DeleteForbidden)
    );

    // 5. Manager (Peter) logs in: CAN delete Seller 1's free-text shortage, and receiving stock for cable resolves its shortage automatically!
    auth::login(&pool, tokens.as_ref(), manager_uid, PASSWORD)
        .await
        .expect("manager login");

    shortage_service::delete_shortage(&pool, tokens.as_ref(), &added_free.entry.id)
        .await
        .expect("manager deletes seller1 shortage");

    inventory::receive(
        &pool,
        tokens.as_ref(),
        &cable_id,
        7,
        9_000,
        Sensitivity::Routine,
        None,
    )
    .await
    .expect("receive cable stock");

    let ov_after_receive = shortage_service::shortages_overview(&pool, tokens.as_ref())
        .await
        .expect("overview after receiving cable");
    assert!(
        ov_after_receive.items.is_empty(),
        "receiving stock for a product must resolve its active shortage"
    );
}
