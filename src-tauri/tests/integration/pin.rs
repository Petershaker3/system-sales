//! The daily PIN (ADR-017 §1–2, plan item 1.1): its shape, setting it, signing
//! in with it, and the lockout it shares with the password.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::identity::{
    pin_is_acceptable, DomainError, Role, UserId, MAX_FAILED_ATTEMPTS,
};
use mobile_shop_system_lib::services::identity::secure_store::InMemoryTokenStore;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, pin, session, users};
use sqlx::SqlitePool;

const PASSWORD: &str = "correct horse battery";
const SELLER_PASSWORD: &str = "seller password 1";

async fn fresh() -> (SqlitePool, Arc<InMemoryTokenStore>) {
    let pool = db::open_in_memory().await.expect("in-memory database");
    (pool, Arc::new(InMemoryTokenStore::new()))
}

/// A shop whose owner is signed in with the password (normal assurance).
async fn owner_signed_in(pool: &SqlitePool, tokens: &InMemoryTokenStore) -> UserId {
    let created = bootstrap::create_first_manager(pool, "Peter", PASSWORD)
        .await
        .expect("first manager");
    auth::login(pool, tokens, created.user_id, PASSWORD)
        .await
        .expect("the owner signs in");
    created.user_id
}

/// The owner, re-authenticated, creates a seller. The owner stays signed in.
async fn with_seller(pool: &SqlitePool, tokens: &InMemoryTokenStore) -> UserId {
    session::reauthenticate(pool, tokens, PASSWORD)
        .await
        .expect("the owner re-authenticates");
    let owner = session::resolve(pool, tokens).await.expect("owner session");
    users::create_user(pool, &owner, "Youssef", "youssef", Role::Sales, SELLER_PASSWORD)
        .await
        .expect("the owner creates a seller")
}

async fn stored_pin_verifier(pool: &SqlitePool, user: UserId) -> Option<String> {
    sqlx::query_scalar("SELECT pin_verifier FROM user_credentials WHERE user_id = ?1")
        .bind(user.as_str())
        .fetch_one(pool)
        .await
        .expect("credentials row")
}

async fn failed_attempts(pool: &SqlitePool, user: UserId) -> i64 {
    sqlx::query_scalar("SELECT failed_attempts FROM users WHERE id = ?1")
        .bind(user.as_str())
        .fetch_one(pool)
        .await
        .expect("user row")
}

async fn audit_count(pool: &SqlitePool, event: &str, detail_like: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = ?1 AND COALESCE(detail, '') LIKE ?2",
    )
    .bind(event)
    .bind(detail_like)
    .fetch_one(pool)
    .await
    .expect("audit count")
}

#[test]
fn the_pin_rule_is_four_to_six_ascii_digits() {
    for good in ["1234", "12345", "123456", "0000", "1111"] {
        assert!(pin_is_acceptable(good), "{good:?} must be accepted");
    }
    for bad in ["", "123", "1234567", "12a4", "١٢٣٤", " 1234", "12 34", "1234\n", "12.4"] {
        assert!(!pin_is_acceptable(bad), "{bad:?} must be refused");
    }
}

#[tokio::test]
async fn a_first_pin_needs_only_the_session_and_is_stored_as_a_verifier() {
    let (pool, tokens) = fresh().await;
    let owner = owner_signed_in(&pool, &tokens).await;
    let current = session::resolve(&pool, tokens.as_ref()).await.expect("session");

    pin::set_own_pin(&pool, &current, None, "2580").await.expect("first PIN");

    let stored = stored_pin_verifier(&pool, owner).await.expect("a verifier is stored");
    assert!(stored.starts_with("$argon2id$"), "an Argon2id verifier, got {stored}");
    assert!(!stored.contains("2580"), "the PIN itself must never be stored");
    assert_eq!(audit_count(&pool, "pin_set", r#"%"first":true%"#).await, 1);
    assert_eq!(
        audit_count(&pool, "pin_set", "%2580%").await,
        0,
        "no audit detail may carry the PIN"
    );
}

#[tokio::test]
async fn signing_in_with_the_pin_opens_the_same_kind_of_session() {
    let (pool, tokens) = fresh().await;
    let owner = owner_signed_in(&pool, &tokens).await;
    let current = session::resolve(&pool, tokens.as_ref()).await.expect("session");
    pin::set_own_pin(&pool, &current, None, "2580").await.expect("first PIN");

    let signed_in = auth::login_with_pin(&pool, tokens.as_ref(), owner, "2580")
        .await
        .expect("PIN sign-in");
    assert_eq!(signed_in.user_id, owner);
    assert_eq!(signed_in.role, Role::Manager);

    let resolved = session::resolve(&pool, tokens.as_ref()).await.expect("resolve");
    assert_eq!(resolved.user_id(), owner);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&pool)
        .await
        .expect("count sessions");
    assert_eq!(sessions, 1, "one session on the device, as with the password");
    assert_eq!(audit_count(&pool, "login_succeeded", r#"%"method":"pin"%"#).await, 1);
}

#[tokio::test]
async fn a_wrong_pin_counts_in_the_lockout_it_shares_with_the_password() {
    let (pool, tokens) = fresh().await;
    let owner = owner_signed_in(&pool, &tokens).await;
    let current = session::resolve(&pool, tokens.as_ref()).await.expect("session");
    pin::set_own_pin(&pool, &current, None, "2580").await.expect("first PIN");

    for attempt in 1..=MAX_FAILED_ATTEMPTS {
        assert_eq!(
            auth::login_with_pin(&pool, tokens.as_ref(), owner, "9999").await,
            Err(DomainError::InvalidCredentials),
            "wrong PIN, attempt {attempt}"
        );
    }

    assert_eq!(
        auth::login_with_pin(&pool, tokens.as_ref(), owner, "2580").await,
        Err(DomainError::AccountLocked),
        "the right PIN is refused while the account is locked"
    );
    assert_eq!(
        auth::login(&pool, tokens.as_ref(), owner, PASSWORD).await,
        Err(DomainError::AccountLocked),
        "a lock is a lock: the password is refused too"
    );
    assert_eq!(
        audit_count(&pool, "login_failed", r#"%"reason":"bad_pin"%"#).await,
        i64::from(MAX_FAILED_ATTEMPTS)
    );
    assert_eq!(audit_count(&pool, "account_locked", "%").await, 1);
}

#[tokio::test]
async fn an_account_without_a_pin_is_told_so_and_nothing_is_counted() {
    let (pool, tokens) = fresh().await;
    let owner = owner_signed_in(&pool, &tokens).await;

    assert_eq!(
        auth::login_with_pin(&pool, tokens.as_ref(), owner, "1234").await,
        Err(DomainError::PinNotSet)
    );
    assert_eq!(failed_attempts(&pool, owner).await, 0, "no PIN is not a wrong PIN");
    assert_eq!(audit_count(&pool, "login_failed", r#"%"reason":"no_pin"%"#).await, 1);
}

#[tokio::test]
async fn changing_a_pin_needs_the_current_password() {
    let (pool, tokens) = fresh().await;
    let owner = owner_signed_in(&pool, &tokens).await;
    let current = session::resolve(&pool, tokens.as_ref()).await.expect("session");
    pin::set_own_pin(&pool, &current, None, "2580").await.expect("first PIN");

    assert_eq!(
        pin::set_own_pin(&pool, &current, None, "1470").await,
        Err(DomainError::InvalidCredentials),
        "no password, no change"
    );
    assert_eq!(
        pin::set_own_pin(&pool, &current, Some("not the password"), "1470").await,
        Err(DomainError::InvalidCredentials),
        "a wrong password, no change"
    );
    pin::set_own_pin(&pool, &current, Some(PASSWORD), "1470")
        .await
        .expect("the password allows the change");

    assert_eq!(
        auth::login_with_pin(&pool, tokens.as_ref(), owner, "2580").await,
        Err(DomainError::InvalidCredentials),
        "the old PIN no longer works"
    );
    auth::login_with_pin(&pool, tokens.as_ref(), owner, "1470")
        .await
        .expect("the new PIN works");
    assert_eq!(audit_count(&pool, "pin_set", r#"%"first":false%"#).await, 1);
}

#[tokio::test]
async fn a_malformed_pin_is_refused_before_anything_is_stored() {
    let (pool, tokens) = fresh().await;
    let owner = owner_signed_in(&pool, &tokens).await;
    let current = session::resolve(&pool, tokens.as_ref()).await.expect("session");

    for bad in ["12", "1234567", "12ab"] {
        assert_eq!(
            pin::set_own_pin(&pool, &current, None, bad).await,
            Err(DomainError::WeakPin),
            "{bad:?}"
        );
    }
    assert_eq!(stored_pin_verifier(&pool, owner).await, None);
    assert_eq!(audit_count(&pool, "pin_set", "%").await, 0);
}

#[tokio::test]
async fn the_owner_sets_a_sellers_pin_and_the_seller_signs_in_with_it() {
    let (pool, tokens) = fresh().await;
    owner_signed_in(&pool, &tokens).await;
    let seller = with_seller(&pool, &tokens).await;
    let owner_session = session::resolve(&pool, tokens.as_ref()).await.expect("owner session");

    pin::manager_set_pin(&pool, &owner_session, seller, "3690")
        .await
        .expect("the owner sets the seller's PIN");

    let signed_in = auth::login_with_pin(&pool, tokens.as_ref(), seller, "3690")
        .await
        .expect("the seller signs in with it");
    assert_eq!(signed_in.user_id, seller);
    assert_eq!(signed_in.role, Role::Sales);
    assert_eq!(
        audit_count(
            &pool,
            "pin_set_by_manager",
            &format!(r#"%"target":"{}"%"#, seller.as_str())
        )
        .await,
        1
    );
}

#[tokio::test]
async fn setting_another_accounts_pin_needs_the_owner_and_a_fresh_password() {
    let (pool, tokens) = fresh().await;
    let owner = owner_signed_in(&pool, &tokens).await;
    let seller = with_seller(&pool, &tokens).await;

    // The owner again, but at normal assurance: `ManageUsers` wants the password.
    auth::login(&pool, tokens.as_ref(), owner, PASSWORD).await.expect("owner");
    let normal = session::resolve(&pool, tokens.as_ref()).await.expect("session");
    assert_eq!(
        pin::manager_set_pin(&pool, &normal, seller, "3690").await,
        Err(DomainError::ReauthenticationRequired)
    );

    // A seller may never set someone else's PIN.
    auth::login(&pool, tokens.as_ref(), seller, SELLER_PASSWORD)
        .await
        .expect("seller");
    let seller_session = session::resolve(&pool, tokens.as_ref()).await.expect("session");
    assert_eq!(
        pin::manager_set_pin(&pool, &seller_session, owner, "3690").await,
        Err(DomainError::PermissionDenied)
    );
    assert_eq!(stored_pin_verifier(&pool, owner).await, None);
    assert_eq!(stored_pin_verifier(&pool, seller).await, None);
}

#[tokio::test]
async fn the_picker_learns_who_has_a_pin_and_nothing_more() {
    let (pool, tokens) = fresh().await;
    let owner = owner_signed_in(&pool, &tokens).await;
    let seller = with_seller(&pool, &tokens).await;
    let current = session::resolve(&pool, tokens.as_ref()).await.expect("session");
    pin::set_own_pin(&pool, &current, None, "2580").await.expect("first PIN");

    let holders = pin::pin_holders(&pool).await.expect("holders");
    assert!(holders.contains(&owner.as_str()));
    assert!(!holders.contains(&seller.as_str()));
    let rendered = format!("{holders:?}");
    assert!(!rendered.contains("argon2"), "only ids leave: {rendered}");
}

#[tokio::test]
async fn a_disabled_account_cannot_sign_in_with_its_pin() {
    let (pool, tokens) = fresh().await;
    owner_signed_in(&pool, &tokens).await;
    let seller = with_seller(&pool, &tokens).await;
    let owner_session = session::resolve(&pool, tokens.as_ref()).await.expect("owner session");
    pin::manager_set_pin(&pool, &owner_session, seller, "3690")
        .await
        .expect("seller PIN");
    users::disable_user(&pool, &owner_session, seller)
        .await
        .expect("the owner disables the seller");

    assert_eq!(
        auth::login_with_pin(&pool, tokens.as_ref(), seller, "3690").await,
        Err(DomainError::AccountDisabled)
    );
}
