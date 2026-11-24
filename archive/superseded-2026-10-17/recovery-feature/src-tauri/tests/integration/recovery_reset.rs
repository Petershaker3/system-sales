//! Single-use manager-password recovery against real SQLite.
//!
//! Fail-closed without approval, exactly-once execution, replay refusal and
//! wrong-device refusal. Runs only with the `recovery` feature: production
//! builds never contain this path.

#![cfg(feature = "recovery")]

use super::{fresh, PASSWORD};
use mobile_shop_system_lib::domain::identity::DomainError;
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, recovery, session};
use mobile_shop_system_lib::services::pattern;
use sqlx::SqlitePool;
use std::sync::Arc;

const DEVICE: &str = "R3CMA016SEJ";
const REFERENCE: &str = "R1-20261010-01";
const REASON: &str = "lost first-run password";
const APPROVED_BY: &str = "owner";
const TEMPORARY: &str = "temporary rescue phrase";
/// The device Pattern, configured exactly as the owner configured it on the
/// device. Verdict fix F1 stages only behind this secret.
const PATTERN: &str = "open sesame";

/// First manager, signed in, re-authenticated, Pattern configured — the
/// in-test analogue of the device state (verdict fix F1).
async fn manager_with_pattern() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");
    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate");
    pattern::set(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("set pattern");
    (pool, tokens)
}

#[tokio::test]
async fn staging_refuses_a_wrong_pattern_and_writes_nothing() {
    // Verdict fix F1 acceptance: no approval row and no RECOVERY_APPROVED
    // event when the current Pattern check fails.
    let (pool, _tokens) = manager_with_pattern().await;
    let target = super::manager_of(&pool).await;

    let refused = recovery::stage_approval(
        &pool, REFERENCE, DEVICE, target, REASON, APPROVED_BY, "wrong pattern",
    )
    .await
    .expect_err("wrong Pattern must refuse staging");
    assert_eq!(refused, DomainError::InvalidCredentials);

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_approval")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(rows, 0, "refused staging writes no approval row");
    assert_eq!(audit_count(&pool, "recovery_approved").await, 0);
}

#[tokio::test]
async fn staging_refuses_when_no_pattern_is_configured() {
    let (pool, _tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let refused = recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created.user_id, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect_err("no Pattern configured must fail closed");
    assert_eq!(refused, DomainError::PatternNotConfigured);
}

async fn audit_count(pool: &SqlitePool, event: &str) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE event_type = ?1")
        .bind(event)
        .fetch_one(pool)
        .await
        .expect("audit count")
}

#[tokio::test]
async fn without_approval_nothing_is_written() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");

    let refused = recovery::recover_manager_password(
        &pool,
        "R1-20261010-99",
        DEVICE,
        TEMPORARY,
    )
    .await
    .expect_err("no approval row, no reset");
    assert_eq!(refused, DomainError::RecoveryNotApproved);

    // The old password still works: the verifier was not touched.
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("verifier untouched");
    assert_eq!(audit_count(&pool, "password_reset").await, 0);
    assert_eq!(audit_count(&pool, "recovery_executed").await, 0);
}

#[tokio::test]
async fn staged_approval_executes_exactly_once() {
    let (pool, tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created,
        REASON,
        APPROVED_BY,
        PATTERN,
    )
    .await
    .expect("stage");
    assert_eq!(audit_count(&pool, "recovery_approved").await, 1);

    let target = recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute");
    assert_eq!(target, created);

    // Old password dead, temporary works, forced change flagged.
    auth::login(&pool, tokens.as_ref(), created, PASSWORD)
        .await
        .expect_err("old password must stop working");
    auth::login(&pool, tokens.as_ref(), created, TEMPORARY)
        .await
        .expect("temporary password works");
    let must_change: i64 =
        sqlx::query_scalar("SELECT must_change_password FROM user_credentials WHERE user_id = ?1")
            .bind(created.as_str())
            .fetch_one(&pool)
            .await
            .expect("credentials row");
    assert_eq!(must_change, 1);
    assert_eq!(audit_count(&pool, "password_reset").await, 1);
    assert_eq!(audit_count(&pool, "recovery_executed").await, 1);

    // Replay with the same reference refuses and changes nothing.
    let replay = recovery::recover_manager_password(&pool, REFERENCE, DEVICE, "another rescue phrase")
        .await
        .expect_err("single use");
    assert_eq!(replay, DomainError::RecoveryAlreadyUsed);
    auth::login(&pool, tokens.as_ref(), created, TEMPORARY)
        .await
        .expect("temporary still the password after refused replay");
    assert_eq!(audit_count(&pool, "recovery_executed").await, 1);
}

#[tokio::test]
async fn wrong_device_and_conflicting_stage_refuse() {
    let (pool, _tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created,
        REASON,
        APPROVED_BY,
        PATTERN,
    )
    .await
    .expect("stage");

    let wrong_device =
        recovery::recover_manager_password(&pool, REFERENCE, "OTHER-DEVICE", TEMPORARY)
            .await
            .expect_err("device binding");
    assert_eq!(wrong_device, DomainError::RecoveryNotApproved);

    let conflict = recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created,
        "a different reason",
        APPROVED_BY,
        PATTERN,
    )
    .await
    .expect_err("conflicting re-stage");
    assert_eq!(conflict, DomainError::RecoveryNotApproved);

    // Nothing consumed by the refusals: the real execution still works.
    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute after refusals");
}

#[tokio::test]
async fn identical_restage_is_a_silent_noop() {
    // Verdict fix F3: retrying the same approval must not create a second row
    // nor a misleading second approval event. `approved_at` differs between
    // attempts and must not participate in the identity comparison.
    let (pool, _tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect("first stage");
    recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect("identical re-stage is a no-op, not a conflict");

    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_approval")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(rows, 1, "one approval row, not two");
    assert_eq!(audit_count(&pool, "recovery_approved").await, 1);

    // And the single approval still executes exactly once.
    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute after restage");
}

#[tokio::test]
async fn consumed_approval_cannot_be_restaged() {
    let (pool, _tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect("stage");
    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute");

    let revived = recovery::stage_approval(
        &pool, REFERENCE, DEVICE, created, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect_err("a consumed approval cannot be revived");
    assert_eq!(revived, DomainError::RecoveryAlreadyUsed);
}

#[tokio::test]
async fn weak_temporary_password_does_not_consume_the_approval() {
    let (pool, tokens) = manager_with_pattern().await;
    let created = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool,
        REFERENCE,
        DEVICE,
        created,
        REASON,
        APPROVED_BY,
        PATTERN,
    )
    .await
    .expect("stage");

    let weak = recovery::recover_manager_password(&pool, REFERENCE, DEVICE, "short")
        .await
        .expect_err("policy first");
    assert_eq!(weak, DomainError::WeakPassword);

    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("approval survived the weak attempt");
    auth::login(&pool, tokens.as_ref(), created, TEMPORARY)
        .await
        .expect("temporary works");
}

// ---------------------------------------------------------------------------
// B1 - staging is throttled, atomically, before any hashing happens
// ---------------------------------------------------------------------------

/// The stored counter row for a device, or `None` when the device has no row.
async fn attempt_state(pool: &SqlitePool) -> Option<(i64, Option<i64>)> {
    sqlx::query_as::<_, (i64, Option<i64>)>(
        "SELECT failed_attempts, last_attempt_at FROM recovery_attempt WHERE device_id = ?1",
    )
    .bind(DEVICE)
    .fetch_optional(pool)
    .await
    .expect("attempt state")
}

/// Rewind the reservation clock so a cooldown can be tested without sleeping.
async fn age_attempt_clock(pool: &SqlitePool) {
    sqlx::query("UPDATE recovery_attempt SET last_attempt_at = 1 WHERE device_id = ?1")
        .bind(DEVICE)
        .execute(pool)
        .await
.expect("rewind attempt clock");
}

#[tokio::test]
async fn the_first_wrong_pattern_is_refused_and_recorded() {
    let (pool, _tokens) = manager_with_pattern().await;
    let target = super::manager_of(&pool).await;

    let refused = recovery::stage_approval(
        &pool, "R1-A", DEVICE, target, REASON, APPROVED_BY, "wrong pattern",
    )
    .await
    .expect_err("wrong Pattern");
    assert_eq!(refused.code(), "INVALID_CREDENTIALS");

    let (failed, at) = attempt_state(&pool).await.expect("a counter row is recorded");
    assert_eq!(failed, 1, "the failed attempt must be counted");
    assert!(at.is_some(), "the attempt must be stamped");
    assert_eq!(audit_count(&pool, "recovery_approved").await, 0);
}

#[tokio::test]
async fn an_immediate_second_attempt_is_throttled_before_any_hashing() {
    // The decisive property: the delay is enforced BEFORE Argon2 runs, so a
    // rapid re-invocation is refused as RECOVERY_RATE_LIMITED rather than
    // reaching the credential check.
    let (pool, _tokens) = manager_with_pattern().await;
    let target = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool, "R1-A", DEVICE, target, REASON, APPROVED_BY, "wrong pattern",
    )
    .await
    .expect_err("first wrong Pattern");

    let throttled = recovery::stage_approval(
        &pool, "R1-B", DEVICE, target, REASON, APPROVED_BY, "wrong pattern",
    )
    .await
    .expect_err("second attempt inside the cooldown");
    assert_eq!(throttled.code(), "RECOVERY_RATE_LIMITED");

    // A refused-by-throttle attempt is not itself counted, and writes nothing.
    assert_eq!(attempt_state(&pool).await.expect("row").0, 1);
    assert_eq!(audit_count(&pool, "recovery_approved").await, 0);
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_approval")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(rows, 0, "no approval row from refused attempts");
}

#[tokio::test]
async fn a_correct_pattern_succeeds_once_the_window_has_elapsed() {
    // No permanent lockout: the throttle is time-based only, so the owner is
    // never permanently barred from legitimate recovery.
    let (pool, _tokens) = manager_with_pattern().await;
    let target = super::manager_of(&pool).await;

    recovery::stage_approval(
        &pool, "R1-A", DEVICE, target, REASON, APPROVED_BY, "wrong pattern",
    )
    .await
    .expect_err("first wrong Pattern");
    age_attempt_clock(&pool).await;

    recovery::stage_approval(
        &pool, REFERENCE, DEVICE, target, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect("correct Pattern after the window elapsed");

    // Success clears the counter, so a later mistake starts from zero.
    assert_eq!(attempt_state(&pool).await, None);
    assert_eq!(audit_count(&pool, "recovery_approved").await, 1);
    recovery::recover_manager_password(&pool, REFERENCE, DEVICE, TEMPORARY)
        .await
        .expect("execute");
}

#[tokio::test]
async fn two_concurrent_attempts_proceed_at_most_one_at_a_time() {
    // The reservation is a compare-and-swap: two simultaneous callers cannot
    // both read the same counter and both write the same increment, and cannot
    // both slip past the cooldown.
    let (pool, _tokens) = manager_with_pattern().await;
    let target = super::manager_of(&pool).await;

    let (first, second) = tokio::join!(
        recovery::stage_approval(
            &pool, "R1-A", DEVICE, target, REASON, APPROVED_BY, "wrong pattern",
        ),
        recovery::stage_approval(
            &pool, "R1-B", DEVICE, target, REASON, APPROVED_BY, "wrong pattern",
        ),
    );

    let codes = [
        first.err().expect("refused").code(),
        second.err().expect("refused").code(),
    ];
    let checked = codes.iter().filter(|c| **c == "INVALID_CREDENTIALS").count();
    let throttled = codes.iter().filter(|c| **c == "RECOVERY_RATE_LIMITED").count();
    assert_eq!(
        checked, 1,
        "exactly one attempt may reach the credential check, got {codes:?}"
    );
    assert_eq!(
        throttled, 1,
        "the concurrent twin must be throttled, got {codes:?}"
    );
    // Exactly one failure was recorded, not two.
    assert_eq!(attempt_state(&pool).await.expect("row").0, 1);
}

// ---------------------------------------------------------------------------
// B2 - audit payloads stay valid JSON under hostile input
// ---------------------------------------------------------------------------

/// Stored detail for the newest event of a type.
async fn latest_detail(pool: &SqlitePool, event_type: &str) -> String {
    sqlx::query_scalar(
        "SELECT detail FROM audit_events WHERE event_type = ?1 ORDER BY rowid DESC LIMIT 1",
    )
    .bind(event_type)
    .fetch_one(pool)
    .await
    .expect("an audit detail")
}

#[tokio::test]
async fn hostile_approval_text_still_stores_valid_auditable_json() {
    let (pool, _tokens) = manager_with_pattern().await;
    let target = super::manager_of(&pool).await;

    // Quotes, backslashes, a newline, a tab, and an attempt to forge a field.
    let reference = "R1-\"ref\"\\slash\nnew\ttab";
    let reason = "reason with \" quote and \\ backslash";
    let approver = "ow\"ner\",\"role\":\"shopkeeper\",\"x\":\"";

    recovery::stage_approval(
        &pool, reference, DEVICE, target, reason, approver, PATTERN,
    )
    .await
    .expect("stage");

let detail: serde_json::Value =
        serde_json::from_str(&latest_detail(&pool, "recovery_approved").await)
            .expect("stored audit detail must parse as JSON");
    assert_eq!(detail["reference"], reference);
    assert_eq!(detail["approved_by"], approver);
    assert_eq!(detail["device_id"], DEVICE);
    // The forged field must NOT have become a real field.
    assert!(
        detail.get("role").is_none(),
        "injected text must not become a top-level field"
    );
    assert_eq!(detail.as_object().map(|o| o.len()), Some(3));

    // `reason` lives in the approval row rather than the audit detail; the
    // hostile text must survive that round trip unchanged, so re-staging the
    // same approval is still recognised as identical.
    let stored_reason: String =
        sqlx::query_scalar("SELECT reason FROM recovery_approval WHERE reference = ?1")
            .bind(reference)
            .fetch_one(&pool)
            .await
            .expect("approval row");
    assert_eq!(stored_reason, reason);
    recovery::stage_approval(
        &pool, reference, DEVICE, target, reason, approver, PATTERN,
    )
    .await
    .expect("identical re-stage with hostile text is still a no-op, not a conflict");
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM recovery_approval")
        .fetch_one(&pool)
        .await
        .expect("count");
    assert_eq!(rows, 1);
    assert_eq!(audit_count(&pool, "recovery_approved").await, 1);
}

#[tokio::test]
async fn hostile_execution_text_still_stores_valid_auditable_json() {
    let (pool, _tokens) = manager_with_pattern().await;
    let target = super::manager_of(&pool).await;

    let reference = "R1-\"x\"\\y";
    let device = "DE\"V\\ICE";

    recovery::stage_approval(
        &pool, reference, device, target, REASON, APPROVED_BY, PATTERN,
    )
    .await
    .expect("stage");
    recovery::recover_manager_password(&pool, reference, device, TEMPORARY)
        .await
        .expect("execute");

    let executed: serde_json::Value =
        serde_json::from_str(&latest_detail(&pool, "recovery_executed").await)
            .expect("recovery_executed detail must parse as JSON");
    assert_eq!(executed["reference"], reference);
    assert_eq!(executed["device_id"], device);

    let reset: serde_json::Value =
        serde_json::from_str(&latest_detail(&pool, "password_reset").await)
            .expect("password_reset detail must parse as JSON");
    assert_eq!(reset["target"], target.as_str());
    assert_eq!(reset["via"], "recovery");
}