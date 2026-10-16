//! Single-use recovery approvals against real SQLite.
//!
//! Provision, atomic consume-if-unconsumed, and replay refusal. No password
//! logic appears here: this module proves the gate's single-use property, and
//! the reset itself is proved in the use-case tests.

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::identity::recovery;
use mobile_shop_system_lib::domain::identity::Timestamp;
use mobile_shop_system_lib::services::identity::bootstrap;

const DEVICE: &str = "R3CMA016SEJ";
const REASON: &str = "lost first-run password";

fn approval() -> recovery::Approval {
    let now = Timestamp::now().as_millis();
    recovery::Approval {
        reference: "R1-20261010-01".to_string(),
        device_id: DEVICE.to_string(),
        // Filled by the caller after creating the manager; a placeholder here
        // keeps the constructor honest about requiring a real target.
        target_user_id: String::new(),
        reason: REASON.to_string(),
        approved_at: now,
    }
}

#[tokio::test]
async fn approval_consumes_exactly_once_then_refuses_replay() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    let mut wanted = approval();
    wanted.target_user_id = created.user_id.as_str().to_string();

    let mut conn = pool.acquire().await.expect("connection");
    recovery::provision(&mut conn, &wanted)
        .await
        .expect("provision");

    let now = || Timestamp::now().as_millis();

    // First consume wins and returns the row.
    let consumed = recovery::consume_if_unconsumed(&mut conn, &wanted.reference, DEVICE, now())
        .await
        .expect("consume");
    assert!(consumed.is_some(), "an unconsumed approval must be consumed");
    assert_eq!(consumed.expect("row").reference, wanted.reference);

    // Replay, wrong device, and unknown reference all refuse without a row.
    let replay = recovery::consume_if_unconsumed(&mut conn, &wanted.reference, DEVICE, now())
        .await
        .expect("replay");
    assert!(replay.is_none(), "a consumed approval must never be consumed twice");
    let wrong_device =
        recovery::consume_if_unconsumed(&mut conn, &wanted.reference, "OTHER-DEVICE", now())
            .await
            .expect("wrong device");
    assert!(wrong_device.is_none());
    let unknown =
        recovery::consume_if_unconsumed(&mut conn, "R1-20261010-99", DEVICE, now())
            .await
            .expect("unknown");
    assert!(unknown.is_none());
}

#[tokio::test]
async fn duplicate_reference_is_rejected() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    let mut wanted = approval();
    wanted.target_user_id = created.user_id.as_str().to_string();

    let mut conn = pool.acquire().await.expect("connection");
    recovery::provision(&mut conn, &wanted)
        .await
        .expect("first provision");
    recovery::provision(&mut conn, &wanted)
        .await
        .expect_err("a reference must be single-use from the moment it exists");
}
