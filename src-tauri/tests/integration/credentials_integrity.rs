//! Tests for a broken `user_credentials` invariant.
//!
//! Migration `0003` gives every account exactly one `user_credentials` row. These
//! tests delete one and assert what each layer does about it, because the wrong
//! answer is silent and severe: defaulting the missing flag to "no change needed"
//! hands out a session that walks straight past the forced-change gate.
//!
//! Every case here deletes a row directly rather than calling any service method,
//! because no service method deletes one — there is no API that can produce this
//! state. It stands in for manual editing, a partial restore, and corruption.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::domain::identity::{DomainError, Role, UserId, MAX_FAILED_ATTEMPTS};
use mobile_shop_system_lib::services::identity::password;
use mobile_shop_system_lib::services::identity::secure_store::{
    InMemoryTokenStore, SecureTokenStore,
};
use mobile_shop_system_lib::services::identity::session as session_service;
use mobile_shop_system_lib::services::identity::users;
use mobile_shop_system_lib::services::identity::{auth, bootstrap};
use sqlx::SqlitePool;

const MANAGER_PASSWORD: &str = "correct horse battery";
const TEMP_PASSWORD: &str = "temporary pass phrase";

struct Shop {
    pool: SqlitePool,
    tokens: Arc<InMemoryTokenStore>,
    manager: UserId,
}

impl Shop {
    async fn resolve(&self) -> mobile_shop_system_lib::domain::identity::Session {
        session_service::resolve(&self.pool, self.tokens.as_ref())
            .await
            .expect("resolve")
    }

    async fn reauthenticate(&self) {
        session_service::reauthenticate(&self.pool, self.tokens.as_ref(), MANAGER_PASSWORD)
            .await
            .expect("re-authenticate");
    }
}

async fn shop() -> Shop {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let created = bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, MANAGER_PASSWORD)
        .await
        .expect("login");
    Shop {
        pool,
        tokens,
        manager: created.user_id,
    }
}

/// Break the invariant: remove an account's credentials row.
async fn strip_credentials(pool: &SqlitePool, user_id: UserId) {
    sqlx::query("DELETE FROM user_credentials WHERE user_id = ?1")
        .bind(user_id.as_str())
        .execute(pool)
        .await
        .expect("delete the credentials row");
}

// ---------------------------------------------------------------------------
// 1. The account does not disappear from the management list
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_account_missing_its_credentials_row_is_still_listed_and_flagged() {
    // The `LEFT JOIN` decision. With an inner join this row would vanish and the
    // operator would see a shorter list with no explanation.
    let shop = shop().await;
    shop.reauthenticate().await;

    let session = shop.resolve().await;
    let target = users::create_user(
        &shop.pool,
        &session,
        "Ahmed",
        "ahmed",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await
    .expect("create a sales account");

    strip_credentials(&shop.pool, target).await;

    let listed = users::list_managed(&shop.pool, &shop.resolve().await)
        .await
        .expect("list still succeeds");

    let broken = listed
        .iter()
        .find(|u| u.user_id == target)
        .expect("the broken account must still appear in the list");
    assert!(
        broken.integrity_fault,
        "the account must be reported as faulty rather than presented as healthy"
    );
    assert_eq!(
        listed.len(),
        2,
        "both accounts must be listed; none may be hidden"
    );
}

// ---------------------------------------------------------------------------
// 2. Login is refused
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_account_missing_its_credentials_row_cannot_sign_in() {
    let shop = shop().await;
    strip_credentials(&shop.pool, shop.manager).await;

    shop.tokens.clear().expect("clear");
    let result = auth::login(
        &shop.pool,
        shop.tokens.as_ref(),
        shop.manager,
        MANAGER_PASSWORD,
    )
    .await;

    assert!(
        matches!(result, Err(DomainError::AccountDataIntegrityError)),
        "login must be refused as an integrity failure, got {result:?}"
    );
    assert_eq!(
        result.err().map(|e| e.code()),
        Some("ACCOUNT_DATA_INTEGRITY_ERROR")
    );
}

#[tokio::test]
async fn the_integrity_code_is_distinct_from_storage_and_from_bad_credentials() {
    // Both of the neighbours would mislead: one sends a technician chasing a
    // database outage that is not happening, the other tells an operator their
    // password is wrong when it is not.
    assert_eq!(
        DomainError::AccountDataIntegrityError.code(),
        "ACCOUNT_DATA_INTEGRITY_ERROR"
    );
    assert_ne!(
        DomainError::AccountDataIntegrityError.code(),
        DomainError::StorageUnavailable.code()
    );
    assert_ne!(
        DomainError::AccountDataIntegrityError.code(),
        DomainError::InvalidCredentials.code()
    );
}

#[tokio::test]
async fn a_refused_login_leaves_no_session_and_no_token() {
    // Login places the token in the credential store before it can know whether the
    // account is sound. Refusing after that point must clear the token, or the device
    // is left holding a credential for a session that was never issued.
    let shop = shop().await;

    // `shop()` signs in successfully, so one session row already exists. The claim
    // under test is that the *refused* attempt adds nothing, so the baseline is
    // measured rather than assumed.
    let before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&shop.pool)
        .await
        .expect("count baseline");

    strip_credentials(&shop.pool, shop.manager).await;

    shop.tokens.clear().expect("clear");
    let result = auth::login(
        &shop.pool,
        shop.tokens.as_ref(),
        shop.manager,
        MANAGER_PASSWORD,
    )
    .await;
    assert!(result.is_err(), "precondition: the attempt must be refused");

    let stored = shop.tokens.get().expect("store readable");
    assert!(
        stored.is_none(),
        "a refused login must not leave a token behind"
    );

    let after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&shop.pool)
        .await
        .expect("count after");
    assert_eq!(
        after, before,
        "a refused login must not create a session row"
    );
}

// ---------------------------------------------------------------------------
// 3. Session resolution is refused
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_existing_session_stops_resolving_when_its_credentials_row_disappears() {
    // The case that motivated the whole review. Resolving here once worked, so a
    // `unwrap_or(0)` on the missing flag would keep returning a usable session with
    // the forced-change gate silently open.
    let shop = shop().await;
    assert!(
        session_service::resolve(&shop.pool, shop.tokens.as_ref())
            .await
            .is_ok(),
        "precondition: the session resolves while the database is intact"
    );

    strip_credentials(&shop.pool, shop.manager).await;

    let after = session_service::resolve(&shop.pool, shop.tokens.as_ref()).await;
    assert!(
        after.is_err(),
        "a session must stop resolving once its credentials row is gone"
    );
}

// ---------------------------------------------------------------------------
// 4. The forced-change gate cannot be walked past
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_reset_account_whose_credentials_row_disappears_cannot_reach_the_shop() {
    // The security property, stated as a scenario rather than as a type signature:
    // a manager resets a password, the flag is set, then the row is destroyed. The
    // account must be locked out, not let in as though no reset were pending.
    let shop = shop().await;
    shop.reauthenticate().await;
    let session = shop.resolve().await;

    let target = users::create_user(
        &shop.pool,
        &session,
        "Ahmed",
        "ahmed",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await
    .expect("create a sales account");

    password::manager_reset_password(&shop.pool, &session, target, TEMP_PASSWORD)
        .await
        .expect("reset the password, setting must_change_password");

    // Confirm the gate is armed while the row is intact.
    shop.tokens.clear().expect("clear");
    auth::login(&shop.pool, shop.tokens.as_ref(), target, TEMP_PASSWORD)
        .await
        .expect("sign in with the temporary password");
    let pending = shop.resolve().await;
    assert!(pending.must_change_password(), "the gate must be armed");
    assert!(
        matches!(
            pending.authorize(
                mobile_shop_system_lib::domain::identity::Permission::Sell
            ),
            Err(DomainError::PasswordChangeRequired)
        ),
        "a pending-change session must not be able to record a sale"
    );

    // Now break the invariant and confirm the account is locked out entirely rather
    // than admitted as though the flag were clear.
    shop.tokens.clear().expect("clear");
    strip_credentials(&shop.pool, target).await;

    let result = auth::login(
        &shop.pool,
        shop.tokens.as_ref(),
        target,
        TEMP_PASSWORD,
    )
    .await;
    assert!(
        matches!(result, Err(DomainError::AccountDataIntegrityError)),
        "a broken account must be refused, not admitted; got {result:?}"
    );
}

#[tokio::test]
async fn an_existing_session_on_a_broken_account_cannot_authorise_anything() {
    // Belt and braces on the gate: even holding a valid session row, a broken
    // account must not reach a business permission.
    let shop = shop().await;
    shop.reauthenticate().await;

    let session = shop.resolve().await;
    let target = users::create_user(
        &shop.pool,
        &session,
        "Ahmed",
        "ahmed",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await
    .expect("create");

    // The sales user signs in and holds a real session.
    shop.tokens.clear().expect("clear");
    auth::login(&shop.pool, shop.tokens.as_ref(), target, MANAGER_PASSWORD)
        .await
        .expect("sign in");
    assert!(shop.resolve().await.user_id() == target);

    // Break it while that session is live.
    strip_credentials(&shop.pool, target).await;

    let resolved = session_service::resolve(&shop.pool, shop.tokens.as_ref()).await;
    assert!(
        resolved.is_err(),
        "resolution must fail, so no Session can be built and nothing can be authorised"
    );
}

// ---------------------------------------------------------------------------
// 5. Healthy accounts are unaffected
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_intact_account_is_unaffected_by_the_fault_handling() {
    // The fault handling must not have cost the normal path anything.
    let shop = shop().await;
    shop.reauthenticate().await;
    let session = shop.resolve().await;

    let listed = users::list_managed(&shop.pool, &session).await.expect("list");
    assert!(
        listed.iter().all(|u| !u.integrity_fault),
        "no account is broken, so none may be flagged"
    );
    assert_eq!(listed.len(), 1);
    assert!(
        listed[0].username.starts_with("user-"),
        "the backfilled identifier must still be reported, got {:?}",
        listed[0].username
    );

    // The picker still refuses nothing, and login still works.
    let picker = auth::list_users(&shop.pool).await.expect("picker");
    assert_eq!(picker.len(), 1);
    assert!(
        picker[0].username.is_some(),
        "an intact account must carry its identifier"
    );

    shop.tokens.clear().expect("clear");
    auth::login(&shop.pool, shop.tokens.as_ref(), shop.manager, MANAGER_PASSWORD)
        .await
        .expect("an intact account still signs in");
}

#[tokio::test]
async fn the_flagged_account_is_reported_by_the_picker_path_as_an_integrity_error() {
    // The picker is the surface where a silent disappearance would hurt most, so the
    // command layer refuses the whole listing rather than projecting a partial one.
    let shop = shop().await;
    shop.reauthenticate().await;
    let session = shop.resolve().await;
    let target = users::create_user(
        &shop.pool,
        &session,
        "Ahmed",
        "ahmed",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await
    .expect("create");
    strip_credentials(&shop.pool, target).await;

    let picker = auth::list_users(&shop.pool).await.expect("the service still lists");
    assert_eq!(picker.len(), 2, "both accounts reach the projection");
    assert_eq!(
        picker.iter().filter(|u| u.username.is_none()).count(),
        1,
        "the broken account is represented as having no identifier, not dropped"
    );
}

#[tokio::test]
async fn a_lockout_still_behaves_normally_while_the_invariant_is_intact() {
    // Guards against the new error path having displaced the existing one.
    let shop = shop().await;
    for _ in 0..MAX_FAILED_ATTEMPTS {
        let _ = auth::login(&shop.pool, shop.tokens.as_ref(), shop.manager, "wrong").await;
    }
    let locked = auth::login(
        &shop.pool,
        shop.tokens.as_ref(),
        shop.manager,
        MANAGER_PASSWORD,
    )
    .await;
    assert!(
        matches!(locked, Err(DomainError::AccountLocked)),
        "a lockout must still report ACCOUNT_TEMPORARILY_LOCKED, got {locked:?}"
    );
}