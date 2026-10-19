//! Integration tests for the LAN companion server & mobile helper (`ADR-037`, Plan item 3.2).

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::companion::{parse_pair_payload, DEFAULT_COMPANION_PORT};
use mobile_shop_system_lib::domain::identity::Role;
use mobile_shop_system_lib::services::companion;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::settings;
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
async fn companion_overview_pairing_and_scan_queue_respect_roles_and_settings_snapshot() {
    let (pool, tokens) = signed_in_manager().await;

    let initial = companion::overview(&pool, tokens.as_ref())
        .await
        .expect("overview");
    assert_eq!(initial.port, DEFAULT_COMPANION_PORT);
    assert!(initial.running);
    assert_eq!(initial.paired_devices.len(), 2);
    let parsed = parse_pair_payload(&initial.pair_payload).expect("valid QR payload");
    assert_eq!(parsed.2, DEFAULT_COMPANION_PORT);

    // Owner pairs a third phone.
    let paired = companion::pair_device(&pool, tokens.as_ref(), "موبايل مينا", "Galaxy A55")
        .await
        .expect("owner pairs device");
    assert_eq!(paired.paired_devices.len(), 3);
    let added_id = paired
        .paired_devices
        .iter()
        .find(|d| d.name == "موبايل مينا")
        .expect("added device")
        .id
        .clone();

    // Create and sign in as a seller: seller can read overview and push/consume scans,
    // but cannot pair or unpair devices (`Permission::ManageCatalog`).
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate");
    let manager = session::resolve(&pool, tokens.as_ref())
        .await
        .expect("manager");
    let seller = users::create_user(&pool, &manager, "Youssef", "youssef", Role::Sales, PASSWORD)
        .await
        .expect("create seller");
    auth::login(&pool, tokens.as_ref(), seller, PASSWORD)
        .await
        .expect("seller login");

    let refused_pair =
        companion::pair_device(&pool, tokens.as_ref(), "موبايل خارجي", "Pixel").await;
    assert_eq!(
        refused_pair.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );
    let refused_unpair = companion::unpair_device(&pool, tokens.as_ref(), &added_id).await;
    assert_eq!(
        refused_unpair.err().map(|e| e.code()),
        Some("PERMISSION_DENIED")
    );

    // Seller pushes one scan to POS and one scan to Receive.
    let after_pos_scan = companion::push_scan(
        &pool,
        tokens.as_ref(),
        "pos",
        "356789104210348",
        Some("prod-1".to_string()),
        Some("Samsung Galaxy A55".to_string()),
        "موبايل يوسف",
    )
    .await
    .expect("seller pushes POS scan");
    assert_eq!(after_pos_scan.pending_scans.len(), 1);

    let after_recv_scan = companion::push_scan(
        &pool,
        tokens.as_ref(),
        "receive",
        "6221234560012",
        Some("prod-2".to_string()),
        Some("شاحن Anker 20W".to_string()),
        "موبايل يوسف",
    )
    .await
    .expect("seller pushes receive scan");
    assert_eq!(after_recv_scan.pending_scans.len(), 2);

    // Consuming POS scans leaves the receive scan intact.
    let pos_scans = companion::consume_scans(&pool, tokens.as_ref(), "pos")
        .await
        .expect("consume pos scans");
    assert_eq!(pos_scans.len(), 1);
    assert_eq!(pos_scans[0].code, "356789104210348");

    let recv_scans = companion::consume_scans(&pool, tokens.as_ref(), "receive")
        .await
        .expect("consume receive scans");
    assert_eq!(recv_scans.len(), 1);
    assert_eq!(recv_scans[0].code, "6221234560012");

    // Sign back in as manager to unpair the added phone and verify `settings::read_snapshot`.
    let manager_id = manager.user_id();
    auth::login(&pool, tokens.as_ref(), manager_id, PASSWORD)
        .await
        .expect("manager login");
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reauthenticate manager");

    let after_unpair = companion::unpair_device(&pool, tokens.as_ref(), &added_id)
        .await
        .expect("owner unpairs device");
    assert_eq!(after_unpair.paired_devices.len(), 2);

    settings::read_snapshot(&pool, tokens.as_ref())
        .await
        .expect("companion.* rows in app_settings do not disturb settings snapshot");
}
