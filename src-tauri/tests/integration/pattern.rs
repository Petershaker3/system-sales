//! The Pattern lifecycle against real SQLite.
//!
//! Set, verify, epoch invalidation, reset and disable — plus the two
//! negative guarantees the plan calls out: the verifier and the pattern text
//! must never appear in `audit_events`, and the pattern key must only ever
//! move through this service's own transactions.

use std::sync::Arc;

use super::{count, fresh, PASSWORD};
use mobile_shop_system_lib::data::repositories::identity::audit;
use mobile_shop_system_lib::domain::identity::{
    DomainError, Role, Sensitivity, Timestamp, PATTERN_TTL_MS,
};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, session, users};
use mobile_shop_system_lib::services::pattern;
use sqlx::SqlitePool;

const PATTERN: &str = "open sesame";
const PATTERN_V2: &str = "changed secret";

/// The first manager, signed in and re-authenticated.
async fn reauthenticated_manager() -> (SqlitePool, Arc<InMemoryTokenStore>) {
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
    (pool, tokens)
}

// ---------------------------------------------------------------------------
// Set, verify, round-trip
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_pattern_is_set_verified_and_round_tripped_through_the_session_row() {
    let (pool, tokens) = fresh().await;
    let created = bootstrap::create_first_manager(&pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, PASSWORD)
        .await
        .expect("login");

    // Nothing configured yet.
    let status = pattern::status(&pool, tokens.as_ref()).await.expect("status");
    assert!(!status.enabled && !status.configured);

    // Setting the Pattern is a ManageSettings change: a fresh login is refused.
    let error = pattern::set(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect_err("a session that has not re-authenticated may not set the Pattern");
    assert_eq!(error, DomainError::ReauthenticationRequired);
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM manager_pattern").await, 0);

    session::reauthenticate(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("re-authenticate");
    pattern::set(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("set the pattern");

    let status = pattern::status(&pool, tokens.as_ref()).await.expect("status");
    assert!(status.enabled && status.configured);

    // The flag the settings panel reads, flipped inside the same transaction.
    let flag: Option<String> = sqlx::query_scalar(
        "SELECT value FROM app_settings WHERE key = 'pattern_required'",
    )
    .fetch_one(&pool)
    .await
    .expect("the flag row exists");
    assert_eq!(flag.as_deref(), Some("1"));

    // The stored material: an Argon2id verifier, never the pattern itself.
    let (verifier, epoch): (String, i64) =
        sqlx::query_as("SELECT verifier, epoch FROM manager_pattern")
            .fetch_one(&pool)
            .await
            .expect("the verifier row");
    assert!(verifier.starts_with("$argon2id$"), "got {verifier}");
    assert!(!verifier.contains(PATTERN), "the pattern must not be stored");
    assert_eq!(epoch, 1, "the first pattern opens epoch 1");

    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::PATTERN_SET)
                .await
                .expect("count"),
            1
        );
    }

    // A wrong pattern refuses; the right one approves.
    assert_eq!(
        pattern::verify(&pool, tokens.as_ref(), "not the pattern").await,
        Err(DomainError::InvalidCredentials)
    );
    pattern::verify(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("verify");

    // The approval round-trips through the real session row.
    let resolved = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    let approved_at = resolved.pattern_approved_at().expect("an approval");
    assert_eq!(resolved.pattern_epoch(), Some(1));

    let (stored_at, stored_epoch): (Option<i64>, i64) =
        sqlx::query_as("SELECT pattern_approved_at, pattern_epoch FROM sessions")
            .fetch_one(&pool)
            .await
            .expect("the session row");
    assert_eq!(
        stored_at,
        Some(approved_at.as_millis()),
        "the stored approval must match what the session reports"
    );
    assert_eq!(stored_epoch, 1);

    // Inside the TTL and under the current epoch: the sensitive axis opens.
    assert_eq!(
        resolved.require_sensitivity(Sensitivity::Sensitive, true, Some(1), Timestamp::now()),
        Ok(()),
        "a fresh approval must open the sensitive axis"
    );
}

// ---------------------------------------------------------------------------
// Epoch invalidation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn changing_the_pattern_invalidates_every_outstanding_approval() {
    let (pool, tokens) = reauthenticated_manager().await;
    pattern::set(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("set the first pattern");
    pattern::verify(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("approve under epoch 1");

    // Replace it: the epoch advances and every approval dies without a sweep.
    pattern::set(&pool, tokens.as_ref(), PATTERN_V2)
        .await
        .expect("replace the pattern");
    let epoch: i64 = sqlx::query_scalar("SELECT epoch FROM manager_pattern")
        .fetch_one(&pool)
        .await
        .expect("the verifier row");
    assert_eq!(epoch, 2);

    let resolved = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    assert_eq!(
        resolved.pattern_epoch(),
        Some(1),
        "the approval still names the epoch it was granted under"
    );
    let now = Timestamp::now();
    assert!(
        !resolved.pattern_approval_is_current(now, 2, PATTERN_TTL_MS),
        "an approval from epoch 1 must not read as current under epoch 2"
    );
    assert_eq!(
        resolved.require_sensitivity(Sensitivity::Sensitive, true, Some(2), now),
        Err(DomainError::PatternApprovalStale),
        "an approval granted under the old pattern must not open the new one"
    );

    // The old pattern no longer verifies; the new one does.
    assert_eq!(
        pattern::verify(&pool, tokens.as_ref(), PATTERN).await,
        Err(DomainError::InvalidCredentials),
        "the superseded pattern must stop working immediately"
    );
    pattern::verify(&pool, tokens.as_ref(), PATTERN_V2)
        .await
        .expect("verify under the new pattern");
    let resolved = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    assert_eq!(resolved.pattern_epoch(), Some(2));
    assert_eq!(
        resolved.require_sensitivity(Sensitivity::Sensitive, true, Some(2), Timestamp::now()),
        Ok(()),
        "approving under the new epoch must reopen the axis"
    );
}

// ---------------------------------------------------------------------------
// Reset: the manager password re-proves the recovery itself
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reset_re_proves_the_manager_password_and_removes_the_verifier() {
    let (pool, tokens) = reauthenticated_manager().await;
    pattern::set(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("set the pattern");
    pattern::verify(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("approve");

    // A wrong password changes nothing at all.
    assert_eq!(
        pattern::reset(&pool, tokens.as_ref(), "wrong password").await,
        Err(DomainError::InvalidCredentials)
    );
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM manager_pattern").await,
        1,
        "a failed reset must leave the verifier in place"
    );
    let status = pattern::status(&pool, tokens.as_ref()).await.expect("status");
    assert!(status.configured, "a failed reset must not deconfigure");
    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::PATTERN_RESET)
                .await
                .expect("count"),
            0,
            "nothing was reset, so nothing is audited"
        );
    }

    // The right password deletes the row rather than blanking it.
    pattern::reset(&pool, tokens.as_ref(), PASSWORD)
        .await
        .expect("reset with the manager password");
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM manager_pattern").await,
        0,
        "the verifier row must be gone"
    );
    let status = pattern::status(&pool, tokens.as_ref()).await.expect("status");
    assert!(status.enabled, "the enable flag is deliberately untouched");
    assert!(!status.configured, "with no verifier there is nothing configured");
    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::PATTERN_RESET)
                .await
                .expect("count"),
            1
        );
    }

    // Fail closed: with no verifier, verification reports the missing Pattern.
    assert_eq!(
        pattern::verify(&pool, tokens.as_ref(), PATTERN).await,
        Err(DomainError::PatternNotConfigured),
        "after a reset there is nothing to verify against"
    );
}

// ---------------------------------------------------------------------------
// Disable: the off switch keeps the Pattern
// ---------------------------------------------------------------------------

#[tokio::test]
async fn disabling_the_pattern_switches_protection_off_but_keeps_the_verifier() {
    let (pool, tokens) = reauthenticated_manager().await;
    pattern::set(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("set the pattern");

    pattern::disable(&pool, tokens.as_ref())
        .await
        .expect("disable");

    let status = pattern::status(&pool, tokens.as_ref()).await.expect("status");
    assert!(!status.enabled, "protection must be off");
    assert!(
        status.configured,
        "the verifier is kept so re-enabling needs no new Pattern"
    );

    let flag: Option<String> = sqlx::query_scalar(
        "SELECT value FROM app_settings WHERE key = 'pattern_required'",
    )
    .fetch_one(&pool)
    .await
    .expect("the flag row exists");
    assert_eq!(flag.as_deref(), Some("0"));
    assert_eq!(
        count(&pool, "SELECT COUNT(*) FROM manager_pattern").await,
        1,
        "disable must not erase the stored Pattern"
    );

    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::SETTING_CHANGED)
                .await
                .expect("count"),
            1,
            "flipping the flag is a settings change"
        );
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::PATTERN_SET)
                .await
                .expect("count"),
            1
        );
    }
}

// ---------------------------------------------------------------------------
// The audit log never sees the secret material
// ---------------------------------------------------------------------------

#[tokio::test]
async fn no_audit_row_ever_carries_the_pattern_or_its_verifier() {
    let (pool, tokens) = reauthenticated_manager().await;
    pattern::set(&pool, tokens.as_ref(), PATTERN).await.expect("set");
    pattern::verify(&pool, tokens.as_ref(), PATTERN).await.expect("verify");
    pattern::disable(&pool, tokens.as_ref()).await.expect("disable");
    pattern::set(&pool, tokens.as_ref(), PATTERN_V2).await.expect("set again");

    let details: Vec<String> = sqlx::query_scalar("SELECT COALESCE(detail, '') FROM audit_events")
        .fetch_all(&pool)
        .await
        .expect("every audit detail");
    assert!(
        !details.is_empty(),
        "precondition: the lifecycle above must have audited something"
    );
    for detail in &details {
        assert!(
            !detail.contains(PATTERN) && !detail.contains(PATTERN_V2),
            "an audit detail leaked the pattern: {detail}"
        );
        assert!(
            !detail.contains("$argon2"),
            "an audit detail leaked verifier material: {detail}"
        );
    }

    // Nothing in settings holds the secret either.
    let values: Vec<String> = sqlx::query_scalar("SELECT value FROM app_settings")
        .fetch_all(&pool)
        .await
        .expect("setting values");
    for value in &values {
        assert!(!value.contains(PATTERN) && !value.contains(PATTERN_V2));
    }

    // Every stored verifier is Argon2id and never the plaintext.
    let verifiers: Vec<String> = sqlx::query_scalar("SELECT verifier FROM manager_pattern")
        .fetch_all(&pool)
        .await
        .expect("verifiers");
    assert_eq!(verifiers.len(), 1, "precondition: a configured pattern");
    for verifier in &verifiers {
        assert!(verifier.starts_with("$argon2id$"));
        assert!(!verifier.contains(PATTERN) && !verifier.contains(PATTERN_V2));
    }

    // A successful verification is deliberately not an audit event.
    assert_eq!(
        count(
            &pool,
            "SELECT COUNT(*) FROM audit_events WHERE event_type = 'pattern_verified'"
        )
        .await,
        0,
        "PATTERN_VERIFIED must not exist as an event"
    );

    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::PATTERN_SET)
                .await
                .expect("count"),
            2,
            "two sets were audited"
        );
    }
}

// ---------------------------------------------------------------------------
// Role refusal
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_sales_user_is_refused_every_pattern_management_operation() {
    let (pool, tokens) = reauthenticated_manager().await;
    pattern::set(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("configure the pattern first");

    // Create the sales account while the manager session is still live, then
    // sign in as them: one device, one active credential.
    let manager = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    let sales_id = users::create_user(&pool, &manager, "Sara", "sara", Role::Sales, PASSWORD)
        .await
        .expect("create the sales account");
    auth::login(&pool, tokens.as_ref(), sales_id, PASSWORD)
        .await
        .expect("sign in as sales");

    let error = pattern::set(&pool, tokens.as_ref(), PATTERN_V2)
        .await
        .expect_err("sales may not set the Pattern");
    assert_eq!(error, DomainError::PermissionDenied);
    assert_eq!(
        pattern::reset(&pool, tokens.as_ref(), PASSWORD).await,
        Err(DomainError::PermissionDenied),
        "sales may not reset the Pattern"
    );
    assert_eq!(
        pattern::disable(&pool, tokens.as_ref()).await,
        Err(DomainError::PermissionDenied),
        "sales may not disable the Pattern"
    );

    // The refusals changed nothing.
    assert_eq!(count(&pool, "SELECT COUNT(*) FROM manager_pattern").await, 1);
    let flag: Option<String> = sqlx::query_scalar(
        "SELECT value FROM app_settings WHERE key = 'pattern_required'",
    )
    .fetch_one(&pool)
    .await
    .expect("the flag row");
    assert_eq!(flag.as_deref(), Some("1"));
    {
        let mut conn = pool.acquire().await.expect("connection");
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::PATTERN_SET)
                .await
                .expect("count"),
            1,
            "the refused set must not be audited"
        );
        assert_eq!(
            audit::count_by_type(&mut conn, audit::event::PATTERN_RESET)
                .await
                .expect("count"),
            0
        );
    }

    // Verification itself carries no permission: the prompt serves whoever is
    // operating, and the sensitivity gate is what the approval feeds.
    pattern::verify(&pool, tokens.as_ref(), PATTERN)
        .await
        .expect("a sales operator may prove the Pattern they are prompted for");
}
