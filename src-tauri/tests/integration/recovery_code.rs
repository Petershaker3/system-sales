//! The owner's recovery code (ADR-017 §4, plan item 1.1), against real SQLite.
//!
//! The claims under test:
//!
//! * a code is made by a manager with the current password, comes back once in
//!   five groups of four from the alphabet without 0, O, 1, I and L, and only
//!   its verifier is kept; a new code makes the old one worthless;
//! * the code replaces a forgotten password without a session: the old
//!   password stops working, every session ends, and the code burns — a new
//!   one comes back in its place;
//! * typing is forgiven (case, spaces, dashes), a wrong code counts against the
//!   shared lockout, and a locked owner can still use the code to get out;
//! * a weak new password costs no attempt; an account with no code is told so;
//! * no audit row carries the code or the password.

use std::sync::Arc;

use super::PASSWORD;
use mobile_shop_system_lib::domain::identity::{
    normalize_recovery_code, Role, UserId, MAX_FAILED_ATTEMPTS, RECOVERY_CODE_ALPHABET,
};
use mobile_shop_system_lib::services::identity::secure_store::{
    InMemoryTokenStore, SecureTokenStore,
};
use mobile_shop_system_lib::services::identity::{auth, bootstrap, recovery_code, session, users};
use sqlx::SqlitePool;

const NEW_PASSWORD: &str = "a brand new password";
const SELLER_PASSWORD: &str = "seller password 1";

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
    owner: UserId,
}

/// A fresh shop whose owner is signed in with the password.
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
        .expect("the owner signs in");
    Shop {
        pool,
        tokens,
        owner: created.user_id,
    }
}

/// The signed-in operator makes a recovery code with `password`.
async fn make_code(shop: &Shop, password: &str) -> Result<String, &'static str> {
    let current = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session");
    recovery_code::create_recovery_code(&shop.pool, &current, password)
        .await
        .map_err(|error| error.code())
}

async fn recover(shop: &Shop, user: UserId, code: &str, new_password: &str) -> Result<String, &'static str> {
    recovery_code::recover_password_with_code(
        &shop.pool,
        shop.tokens.as_ref(),
        user,
        code,
        new_password,
    )
    .await
    .map_err(|error| error.code())
}

async fn status(shop: &Shop) -> Option<i64> {
    let current = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("session");
    recovery_code::recovery_code_status(&shop.pool, &current)
        .await
        .expect("status")
        .map(|at| at.as_millis())
}

async fn stored_verifier(shop: &Shop) -> Option<String> {
    sqlx::query_scalar("SELECT recovery_verifier FROM user_credentials WHERE user_id = ?1")
        .bind(shop.owner.as_str())
        .fetch_one(&shop.pool)
        .await
        .expect("credentials row")
}

async fn failed_attempts(shop: &Shop) -> i64 {
    sqlx::query_scalar("SELECT failed_attempts FROM users WHERE id = ?1")
        .bind(shop.owner.as_str())
        .fetch_one(&shop.pool)
        .await
        .expect("user row")
}

async fn count(shop: &Shop, sql: &str) -> i64 {
    sqlx::query_scalar(sql)
        .fetch_one(&shop.pool)
        .await
        .expect("count")
}

async fn audit_count(shop: &Shop, event: &str, detail_like: &str) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM audit_events WHERE event_type = ?1 AND COALESCE(detail, '') LIKE ?2",
    )
    .bind(event)
    .bind(detail_like)
    .fetch_one(&shop.pool)
    .await
    .expect("audit count")
}

/// Five groups of four, from the alphabet without the misread characters.
fn assert_shape(code: &str) {
    let groups: Vec<&str> = code.split('-').collect();
    assert_eq!(groups.len(), 5, "five groups: {code}");
    for group in groups {
        assert_eq!(group.len(), 4, "groups of four: {code}");
        assert!(
            group.chars().all(|ch| RECOVERY_CODE_ALPHABET.contains(ch)),
            "only the recovery alphabet: {code}"
        );
    }
    for misread in ['0', 'O', '1', 'I', 'L'] {
        assert!(!code.contains(misread), "`{misread}` is misread on paper: {code}");
    }
}

// ---------------------------------------------------------------------------
// Making a code
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_code_is_made_with_the_password_and_only_its_verifier_is_kept() {
    let shop = shop().await;
    assert_eq!(status(&shop).await, None, "a new shop has no code yet");

    assert_eq!(
        make_code(&shop, "not the password").await,
        Err("INVALID_CREDENTIALS"),
        "an open session alone does not mint the way back in"
    );
    assert_eq!(stored_verifier(&shop).await, None);
    assert_eq!(
        audit_count(&shop, "login_failed", r#"%"for":"recovery_code"%"#).await,
        1
    );
    assert_eq!(failed_attempts(&shop).await, 0, "an in-session re-proof is not a sign-in");

    let code = make_code(&shop, PASSWORD).await.expect("the owner makes a code");
    assert_shape(&code);
    assert!(status(&shop).await.is_some(), "the settings can say when it was made");

    let verifier = stored_verifier(&shop).await.expect("a verifier is stored");
    let plain = normalize_recovery_code(&code).expect("the code reads back");
    assert!(verifier.starts_with("$argon2id$"), "an Argon2id verifier: {verifier}");
    assert!(!verifier.contains(&plain), "never the code itself");
    assert_eq!(
        audit_count(&shop, "recovery_code_created", r#"{"first":true}"#).await,
        1
    );
}

#[tokio::test]
async fn a_new_code_makes_the_old_one_worthless() {
    let shop = shop().await;
    let old = make_code(&shop, PASSWORD).await.expect("first code");
    let new = make_code(&shop, PASSWORD).await.expect("second code");
    assert_ne!(old, new);
    assert_eq!(
        audit_count(&shop, "recovery_code_created", r#"{"first":false}"#).await,
        1
    );

    assert_eq!(
        recover(&shop, shop.owner, &old, NEW_PASSWORD).await,
        Err("INVALID_CREDENTIALS"),
        "the replaced code opens nothing"
    );
    recover(&shop, shop.owner, &new, NEW_PASSWORD)
        .await
        .expect("the current code works");
}

#[tokio::test]
async fn only_a_manager_holds_a_code() {
    let shop = shop().await;
    session::reauthenticate(&shop.pool, shop.tokens.as_ref(), PASSWORD)
        .await
        .expect("the owner re-authenticates");
    let owner = session::resolve(&shop.pool, shop.tokens.as_ref())
        .await
        .expect("owner session");
    let seller = users::create_user(&shop.pool, &owner, "Youssef", "youssef", Role::Sales, SELLER_PASSWORD)
        .await
        .expect("a seller");
    auth::login(&shop.pool, shop.tokens.as_ref(), seller, SELLER_PASSWORD)
        .await
        .expect("the seller signs in");

    assert_eq!(make_code(&shop, SELLER_PASSWORD).await, Err("PERMISSION_DENIED"));
}

// ---------------------------------------------------------------------------
// Using it
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_code_replaces_a_forgotten_password_and_burns_itself() {
    let shop = shop().await;
    let code = make_code(&shop, PASSWORD).await.expect("a code");

    let next = recover(&shop, shop.owner, &code, NEW_PASSWORD)
        .await
        .expect("the code replaces the password");
    assert_shape(&next);
    assert_ne!(next, code, "a new code takes the burnt one's place");

    assert_eq!(count(&shop, "SELECT COUNT(*) FROM sessions").await, 0, "every session ended");
    assert!(
        matches!(shop.tokens.get(), Ok(None)),
        "the device keeps no token for a session that is gone"
    );
    assert_eq!(
        audit_count(&shop, "password_recovered_with_code", "%").await,
        1
    );

    let old_password = auth::login(&shop.pool, shop.tokens.as_ref(), shop.owner, PASSWORD)
        .await
        .expect_err("the forgotten password is gone");
    assert_eq!(old_password.code(), "INVALID_CREDENTIALS");
    auth::login(&shop.pool, shop.tokens.as_ref(), shop.owner, NEW_PASSWORD)
        .await
        .expect("the new password signs in");

    assert_eq!(
        recover(&shop, shop.owner, &code, "another new password").await,
        Err("INVALID_CREDENTIALS"),
        "a used code is burnt"
    );
    recover(&shop, shop.owner, &next, "another new password")
        .await
        .expect("the new code works once in turn");
}

#[tokio::test]
async fn typing_is_forgiven_but_not_a_misread_character() {
    let shop = shop().await;
    let code = make_code(&shop, PASSWORD).await.expect("a code");

    let sloppy = code.to_lowercase().replace('-', " ");
    let next = recover(&shop, shop.owner, &sloppy, NEW_PASSWORD)
        .await
        .expect("lower case and spaces are forgiven");

    // An O cannot be in a code at all: it is a wrong code, and counted.
    let misread = format!("O{}", &normalize_recovery_code(&next).expect("reads back")[1..]);
    assert_eq!(
        recover(&shop, shop.owner, &misread, "another new password").await,
        Err("INVALID_CREDENTIALS")
    );
    assert_eq!(failed_attempts(&shop).await, 1);
}

#[tokio::test]
async fn a_wrong_code_counts_against_the_lockout_and_a_right_one_is_the_way_out() {
    let shop = shop().await;
    let code = make_code(&shop, PASSWORD).await.expect("a code");
    let wrong = "2222-3333-4444-5555-6666";

    for attempt in 1..=MAX_FAILED_ATTEMPTS {
        assert_eq!(
            recover(&shop, shop.owner, wrong, NEW_PASSWORD).await,
            Err("INVALID_CREDENTIALS"),
            "attempt {attempt}"
        );
    }
    assert_eq!(
        audit_count(&shop, "recovery_code_failed", r#"%"reason":"bad_code"%"#).await,
        i64::from(MAX_FAILED_ATTEMPTS)
    );
    let signing_in = auth::login(&shop.pool, shop.tokens.as_ref(), shop.owner, PASSWORD)
        .await
        .expect_err("the shared lockout holds");
    assert_eq!(signing_in.code(), "ACCOUNT_TEMPORARILY_LOCKED");

    recover(&shop, shop.owner, &code, NEW_PASSWORD)
        .await
        .expect("the code still works on a locked account");
    assert_eq!(failed_attempts(&shop).await, 0, "and clears the lock");
    auth::login(&shop.pool, shop.tokens.as_ref(), shop.owner, NEW_PASSWORD)
        .await
        .expect("the owner is back in at once");
}

#[tokio::test]
async fn a_weak_new_password_costs_no_attempt_and_keeps_the_code() {
    let shop = shop().await;
    let code = make_code(&shop, PASSWORD).await.expect("a code");

    assert_eq!(
        recover(&shop, shop.owner, &code, "short").await,
        Err("PASSWORD_DOES_NOT_MEET_POLICY")
    );
    assert_eq!(failed_attempts(&shop).await, 0);
    recover(&shop, shop.owner, &code, NEW_PASSWORD)
        .await
        .expect("the code was not spent on the refusal");
}

#[tokio::test]
async fn an_account_with_no_code_is_told_so() {
    let shop = shop().await;
    assert_eq!(
        recover(&shop, shop.owner, "2222-3333-4444-5555-6666", NEW_PASSWORD).await,
        Err("RECOVERY_CODE_NOT_SET")
    );
    assert_eq!(failed_attempts(&shop).await, 0, "nothing was guessed");
    assert_eq!(
        recover(&shop, UserId::generate(), "2222-3333-4444-5555-6666", NEW_PASSWORD).await,
        Err("INVALID_CREDENTIALS"),
        "an id that names nobody is answered like a wrong code"
    );
}

#[tokio::test]
async fn no_audit_row_carries_the_code_or_the_password() {
    let shop = shop().await;
    let code = make_code(&shop, PASSWORD).await.expect("a code");
    let _ = recover(&shop, shop.owner, "2222-3333-4444-5555-6666", NEW_PASSWORD).await;
    let next = recover(&shop, shop.owner, &code, NEW_PASSWORD)
        .await
        .expect("recovered");

    for secret in [
        normalize_recovery_code(&code).expect("reads back"),
        normalize_recovery_code(&next).expect("reads back"),
        code.clone(),
        next.clone(),
        NEW_PASSWORD.to_string(),
        PASSWORD.to_string(),
    ] {
        let carrying: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM audit_events WHERE detail LIKE ?1")
                .bind(format!("%{secret}%"))
                .fetch_one(&shop.pool)
                .await
                .expect("audit scan");
        assert_eq!(carrying, 0, "an audit row carries `{secret}`");
    }
}
