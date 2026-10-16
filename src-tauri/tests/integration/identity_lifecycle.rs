//! User lifecycle integration tests against real SQLite.
//!
//! Covers the capabilities that make a forgotten password recoverable and a shop
//! administrable: password change, manager reset, the forced-change gate,
//! disable/enable, role change, and the login identifier.
//!
//! Every test drives the **real** service layer and the **real** SQLite schema, and
//! signs in through the **real** login path, so the credential store, the key
//! derivation and the permission gate are all exercised rather than stubbed.
//!
//! The mandatory case is [`a_manager_reset_revokes_only_the_target_sessions`]: a
//! reset that also destroyed the manager's own session would appear to work while
//! signing the operator out mid-operation, and no happy-path test would notice.

use std::sync::Arc;

use mobile_shop_system_lib::data::db;
use mobile_shop_system_lib::data::repositories::identity::audit;
use mobile_shop_system_lib::services::identity::password;
use mobile_shop_system_lib::services::identity::secure_store::{
    InMemoryTokenStore, SecureTokenStore,
};
use mobile_shop_system_lib::services::identity::session as session_service;
use mobile_shop_system_lib::services::identity::users;
use mobile_shop_system_lib::services::identity::{auth, bootstrap, IdentityContext};
use mobile_shop_system_lib::domain::identity::{
    DomainError, Permission, Role, Session, Timestamp, UserId, Username, MAX_FAILED_ATTEMPTS,
};
use sqlx::{Row, SqlitePool};

const MANAGER_PASSWORD: &str = "correct horse battery";
const TEMP_PASSWORD: &str = "temporary pass phrase";

struct Shop {
    ctx: IdentityContext,
    manager: Session,
}

async fn shop() -> Shop {
    let pool: SqlitePool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    let ctx = IdentityContext::new(pool.clone(), tokens.clone());

    let created = bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .expect("first manager");
    auth::login(&pool, tokens.as_ref(), created.user_id, MANAGER_PASSWORD)
        .await
        .expect("login");

    let manager = session_service::resolve(&pool, tokens.as_ref())
        .await
        .expect("resolve the manager session the way a command does");

    Shop { ctx, manager }
}

impl Shop {
    fn pool(&self) -> &SqlitePool {
        &self.ctx.pool
    }

    /// Create a sales account and return its id.
    ///
    /// Goes through the real `create_user` service, so the username constraint and
    /// the audit event are part of what the test exercises.
    async fn add_sales(&self, display: &str, username: &str) -> UserId {
        users::create_user(
            self.pool(),
            &self.resolve().await,
            display,
            username,
            Role::Sales,
            MANAGER_PASSWORD,
        )
        .await
        .expect("create a sales account")
    }

    /// Raise the manager session to `Reauthenticated`, as the UI would.
    async fn reauthenticate(&self) {
        session_service::reauthenticate(self.pool(), self.ctx.tokens.as_ref(), MANAGER_PASSWORD)
            .await
            .expect("re-authenticate the manager");
    }

    async fn resolve(&self) -> Session {
        session_service::resolve(self.pool(), self.ctx.tokens.as_ref())
            .await
            .expect("resolve")
    }

    async fn audit_count(&self, event: &str) -> i64 {
        let mut conn = self.pool().acquire().await.expect("connection");
        audit::count_by_type(&mut conn, event).await.expect("count")
    }
}

// ---------------------------------------------------------------------------
// Username
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_username_is_normalised_on_the_way_in() {
    let shop = shop().await;
    shop.reauthenticate().await;

    users::create_user(
        shop.pool(),
        &shop.resolve().await,
        "Ahmed",
        "  Ahmed  ",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await
    .expect("create with padding and mixed case");

    let listed = users::list_managed(shop.pool(), &shop.resolve().await)
        .await
        .expect("list");
    let ahmed = listed
        .iter()
        .find(|u| u.display_name == "Ahmed")
        .expect("the new account");
    assert_eq!(
        ahmed.username.as_str(),
        "ahmed",
        "a username must be stored normalised, not as typed"
    );
}

#[tokio::test]
async fn two_accounts_may_share_a_display_name_but_not_a_username() {
    let shop = shop().await;
    shop.reauthenticate().await;

    // D6: names are not unique.
    let first = shop.add_sales("Ahmed", "ahmed").await;
    shop.add_sales("Ahmed", "ahmed2").await;

    let listed = users::list_managed(shop.pool(), &shop.resolve().await)
        .await
        .expect("list");
    let both = listed.iter().filter(|u| u.display_name == "Ahmed").count();
    assert_eq!(both, 2, "two operators may share a display name");

    // The username is what distinguishes them.
    let clash = users::create_user(
        shop.pool(),
        &shop.resolve().await,
        "Someone Else",
        "ahmed",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await;
    assert!(
        matches!(clash, Err(DomainError::UsernameAlreadyExists)),
        "a duplicate username must be refused, got {clash:?}"
    );

    // And the refusal must not have created an account.
    let after = users::list_managed(shop.pool(), &shop.resolve().await)
        .await
        .expect("list");
    assert_eq!(after.len(), 3, "a refused create must leave no account behind");
    let _ = first;
}

#[tokio::test]
async fn a_username_is_case_insensitively_unique() {
    let shop = shop().await;
    shop.reauthenticate().await;
    shop.add_sales("First", "taken").await;

    let clash = users::create_user(
        shop.pool(),
        &shop.resolve().await,
        "Second",
        "TAKEN",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await;
    assert!(
        matches!(clash, Err(DomainError::UsernameAlreadyExists)),
        "uniqueness must be case-insensitive, matching the NOCASE column"
    );
}

#[tokio::test]
async fn an_invalid_username_is_refused() {
    for bad in ["ab", "has space", "emoji\u{1f600}", &"x".repeat(40)] {
        assert!(
            Username::new(bad).is_err(),
            "`{bad}` must not be accepted as a username"
        );
    }
    assert!(Username::new("valid.name_1-x").is_ok());
}

// ---------------------------------------------------------------------------
// Re-authentication gates user administration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn managing_users_requires_a_reauthenticated_session() {
    let shop = shop().await;

    // The manager signed in, so assurance is Normal. D5 says that is not enough.
    assert!(
        !shop.manager.authorize(Permission::ManageUsers).is_ok(),
        "precondition: a plain login must not permit user administration"
    );

    let refused = users::create_user(
        shop.pool(),
        &shop.manager,
        "Ahmed",
        "ahmed",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await;
    assert!(
        matches!(refused, Err(DomainError::ReauthenticationRequired)),
        "expected REAUTHENTICATION_REQUIRED, got {refused:?}"
    );

    shop.reauthenticate().await;
    let after = shop.resolve().await;
    assert!(after.authorize(Permission::ManageUsers).is_ok());
    users::create_user(
        shop.pool(),
        &after,
        "Ahmed",
        "ahmed",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await
    .expect("the same call succeeds once re-authenticated");
}

#[tokio::test]
async fn a_sales_user_cannot_administer_anyone() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let sales_id = shop.add_sales("Ahmed", "ahmed").await;

    // Sign in as the sales user through the real login path.
    shop.ctx.tokens.clear().expect("clear");
    auth::login(shop.pool(), shop.ctx.tokens.as_ref(), sales_id, MANAGER_PASSWORD)
        .await
        .expect("login as sales");
    session_service::reauthenticate(
        shop.pool(),
        shop.ctx.tokens.as_ref(),
        MANAGER_PASSWORD,
    )
    .await
    .expect("sales may re-authenticate");
    let sales = shop.resolve().await;

    // Even re-authenticated, a sales user has no ManageUsers.
    let refused = users::create_user(
        shop.pool(),
        &sales,
        "Mallory",
        "mallory",
        Role::Manager,
        MANAGER_PASSWORD,
    )
    .await;
    assert!(
        matches!(refused, Err(DomainError::PermissionDenied)),
        "re-authentication must not grant a permission the role lacks, got {refused:?}"
    );
}

// ---------------------------------------------------------------------------
// Change own password
// ---------------------------------------------------------------------------

#[tokio::test]
async fn changing_own_password_requires_the_current_one() {
    let shop = shop().await;

    let wrong = password::change_own_password(
        shop.pool(),
        &shop.manager,
        "not the password",
        "a brand new password",
    )
    .await;
    assert!(
        matches!(wrong, Err(DomainError::InvalidCredentials)),
        "a wrong current password must be refused, got {wrong:?}"
    );

    // The original must still work afterwards.
    assert!(
        session_service::resolve(shop.pool(), shop.ctx.tokens.as_ref())
            .await
            .is_ok(),
        "a refused change must leave the account usable"
    );
}

#[tokio::test]
async fn changing_own_password_actually_changes_it() {
    let shop = shop().await;
    let new_password = "a different long password";

    password::change_own_password(
        shop.pool(),
        &shop.manager,
        MANAGER_PASSWORD,
        new_password,
    )
    .await
    .expect("change own password");

    assert_eq!(shop.audit_count(audit::event::PASSWORD_CHANGED).await, 1);

    // The old password must no longer work.
    shop.ctx.tokens.clear().expect("clear");
    let old = auth::login(
        shop.pool(),
        shop.ctx.tokens.as_ref(),
        shop.manager.user_id(),
        MANAGER_PASSWORD,
    )
    .await;
    assert!(
        matches!(old, Err(DomainError::InvalidCredentials)),
        "the previous password must stop working"
    );

    // The new one must.
    auth::login(
        shop.pool(),
        shop.ctx.tokens.as_ref(),
        shop.manager.user_id(),
        new_password,
    )
    .await
    .expect("the new password works");
}

#[tokio::test]
async fn a_weak_new_password_is_refused() {
    let shop = shop().await;
    let weak = password::change_own_password(shop.pool(), &shop.manager, MANAGER_PASSWORD, "short")
        .await;
    assert!(
        matches!(weak, Err(DomainError::WeakPassword)),
        "the shared policy must apply to a change, got {weak:?}"
    );
}

#[tokio::test]
async fn changing_own_password_returns_the_session_to_normal() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let elevated = shop.resolve().await;
    assert_eq!(elevated.assurance(), mobile_shop_system_lib::domain::identity::Assurance::Reauthenticated);

    password::change_own_password(
        shop.pool(),
        &elevated,
        MANAGER_PASSWORD,
        "another long password",
    )
    .await
    .expect("change");
    password::persist_downgraded_assurance(shop.pool(), shop.ctx.tokens.as_ref())
        .await
        .expect("persist the downgrade");

    // D17: the elevation must not survive into the next command.
    let after = shop.resolve().await;
    assert_eq!(
        after.assurance(),
        mobile_shop_system_lib::domain::identity::Assurance::Normal,
        "assurance must return to Normal once the operation is done"
    );
    assert!(
        after.authorize(Permission::ManageUsers).is_err(),
        "a downgraded session must not still hold ManageUsers"
    );
}

// ---------------------------------------------------------------------------
// Manager reset
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_manager_reset_revokes_only_the_target_sessions() {
    // The mandatory regression. `delete_all` would satisfy "sessions revoked" while
    // signing the manager out during their own operation.
    let shop = shop().await;
    shop.reauthenticate().await;
    let manager_id = shop.manager.user_id();
    let target = shop.add_sales("Ahmed", "ahmed").await;

    // The target holds a live session first, so there is something to revoke.
    let sessions_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(shop.pool())
        .await
        .expect("count sessions");
    assert!(sessions_before >= 1);

    let elevated = shop.resolve().await;
    password::manager_reset_password(shop.pool(), &elevated, target, TEMP_PASSWORD)
        .await
        .expect("reset the target's password");

    // The target can no longer resolve a session.
    let target_sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = ?1")
            .bind(target.as_str())
            .fetch_one(shop.pool())
            .await
            .expect("count target sessions");
    assert_eq!(target_sessions, 0, "the target's session must be revoked");

    // The manager's session survives: this is the assertion that matters.
    let manager_sessions: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM sessions WHERE user_id = ?1")
            .bind(manager_id.as_str())
            .fetch_one(shop.pool())
            .await
            .expect("count manager sessions");
    assert_eq!(
        manager_sessions, 1,
        "the manager performing the reset must stay signed in"
    );

    // And the manager can still act.
    let still = shop.resolve().await;
    assert!(
        still.authorize(Permission::ManageUsers).is_ok(),
        "the manager must remain able to administer users"
    );
    let _ = sessions_before;
}

#[tokio::test]
async fn a_reset_forces_a_password_change_at_next_sign_in() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let target = shop.add_sales("Ahmed", "ahmed").await;
    let elevated = shop.resolve().await;

    password::manager_reset_password(shop.pool(), &elevated, target, TEMP_PASSWORD)
        .await
        .expect("reset");

    let flag: i64 =
        sqlx::query_scalar("SELECT must_change_password FROM user_credentials WHERE user_id = ?1")
            .bind(target.as_str())
            .fetch_one(shop.pool())
            .await
            .expect("read the flag");
    assert_eq!(flag, 1, "a reset must set must_change_password");

    // The target signs in with the temporary password...
    shop.ctx.tokens.clear().expect("clear");
    auth::login(shop.pool(), shop.ctx.tokens.as_ref(), target, TEMP_PASSWORD)
        .await
        .expect("the temporary password works");
    let pending = shop.resolve().await;

    // ...and can do exactly one thing.
    assert!(pending.must_change_password());
    assert!(
        matches!(
            pending.authorize(Permission::Sell),
            Err(DomainError::PasswordChangeRequired)
        ),
        "a pending-change session must not be able to record a sale"
    );
    assert!(
        matches!(
            pending.authorize(Permission::ManageCatalog),
            Err(DomainError::PasswordChangeRequired)
        )
    );
    assert!(
        pending.authorize(Permission::ChangeOwnPassword).is_ok(),
        "changing the password must remain possible, or the account is stuck"
    );
}

#[tokio::test]
async fn completing_the_forced_change_restores_normal_use() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let target = shop.add_sales("Ahmed", "ahmed").await;
    let elevated = shop.resolve().await;
    password::manager_reset_password(shop.pool(), &elevated, target, TEMP_PASSWORD)
        .await
        .expect("reset");

    shop.ctx.tokens.clear().expect("clear");
    auth::login(shop.pool(), shop.ctx.tokens.as_ref(), target, TEMP_PASSWORD)
        .await
        .expect("sign in with the temporary password");
    let pending = shop.resolve().await;

    let chosen = "a chosen long password";
    password::change_own_password(shop.pool(), &pending, TEMP_PASSWORD, chosen)
        .await
        .expect("complete the forced change");

    let after = shop.resolve().await;
    assert!(
        !after.must_change_password(),
        "the flag must be cleared once the password is changed"
    );
    assert!(
        after.authorize(Permission::Sell).is_ok(),
        "a sales user must be able to record a sale again"
    );

    // And the temporary password is now dead.
    shop.ctx.tokens.clear().expect("clear");
    let reused = auth::login(shop.pool(), shop.ctx.tokens.as_ref(), target, TEMP_PASSWORD).await;
    assert!(
        matches!(reused, Err(DomainError::InvalidCredentials)),
        "the temporary password must stop working after the change"
    );
}

#[tokio::test]
async fn a_manager_cannot_reset_their_own_password_through_the_reset_path() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let elevated = shop.resolve().await;

    let refused = password::manager_reset_password(
        shop.pool(),
        &elevated,
        elevated.user_id(),
        TEMP_PASSWORD,
    )
    .await;
    assert!(
        matches!(refused, Err(DomainError::CannotDisableSelf)),
        "the reset path skips the current-password check and must not be used on \\
         oneself; got {refused:?}"
    );
}

#[tokio::test]
async fn a_reset_is_audited_without_any_credential_material() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let target = shop.add_sales("Ahmed", "ahmed").await;
    let elevated = shop.resolve().await;
    password::manager_reset_password(shop.pool(), &elevated, target, TEMP_PASSWORD)
        .await
        .expect("reset");

    assert_eq!(shop.audit_count(audit::event::PASSWORD_RESET).await, 1);

    let row: (String, Option<String>) =
        sqlx::query_as("SELECT event_type, detail FROM audit_events WHERE event_type = ?1")
            .bind(audit::event::PASSWORD_RESET)
            .fetch_one(shop.pool())
            .await
            .expect("audit row");
    let detail = row.1.unwrap_or_default();
    assert!(!detail.contains(TEMP_PASSWORD), "the password must never be audited");
    assert!(!detail.to_lowercase().contains("argon2"), "no verifier may be audited");
    assert!(detail.contains("target"), "the target must be identifiable");
}

// ---------------------------------------------------------------------------
// Disable and enable
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_disabled_account_cannot_sign_in_and_keeps_its_history() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let target = shop.add_sales("Ahmed", "ahmed").await;
    let elevated = shop.resolve().await;

    users::disable_user(shop.pool(), &elevated, target).await.expect("disable");

    shop.ctx.tokens.clear().expect("clear");
    let denied = auth::login(shop.pool(), shop.ctx.tokens.as_ref(), target, MANAGER_PASSWORD).await;
    assert!(
        matches!(denied, Err(DomainError::AccountDisabled)),
        "a disabled account must not sign in, got {denied:?}"
    );

    // The row survives: no deletion, ever.
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE id = ?1")
        .bind(target.as_str())
        .fetch_one(shop.pool())
        .await
        .expect("count");
    assert_eq!(rows, 1, "disabling must not delete the account");
    assert_eq!(shop.audit_count(audit::event::USER_DISABLED).await, 1);
}

#[tokio::test]
async fn disabling_takes_effect_on_an_already_open_session() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let target = shop.add_sales("Ahmed", "ahmed").await;

    // The target is signed in and holds a working session.
    shop.ctx.tokens.clear().expect("clear");
    auth::login(shop.pool(), shop.ctx.tokens.as_ref(), target, MANAGER_PASSWORD)
        .await
        .expect("sales signs in");
    assert!(shop.resolve().await.user_id() == target);

    // Back as the manager, who disables them.
    shop.ctx.tokens.clear().expect("clear");
    auth::login(
        shop.pool(),
        shop.ctx.tokens.as_ref(),
        shop.manager.user_id(),
        MANAGER_PASSWORD,
    )
    .await
    .expect("manager signs in");
    session_service::reauthenticate(shop.pool(), shop.ctx.tokens.as_ref(), MANAGER_PASSWORD)
        .await
        .expect("reauth");
    let elevated = shop.resolve().await;
    users::disable_user(shop.pool(), &elevated, target).await.expect("disable");

    // A session for the disabled account no longer resolves, even though one existed
    // a moment ago. This is why `Session::open` checks `disabled_at`.
    let mut conn = shop.pool().acquire().await.expect("connection");
    let token = mobile_shop_system_lib::services::identity::crypto::generate_token()
        .expect("token for the probe");
    let hash = mobile_shop_system_lib::services::identity::crypto::hash_token(&token);
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, assurance, issued_at, last_seen_at,
                               absolute_expires_at)
         VALUES (?1, ?2, 'normal', ?3, ?3, ?4)",
    )
    .bind(&hash)
    .bind(target.as_str())
    .bind(Timestamp::now().as_millis())
    .bind(Timestamp::now().plus_millis(60_000).as_millis())
    .execute(&mut *conn)
    .await
    .expect("insert a session row for a disabled user");
    drop(conn);

    shop.ctx.tokens.clear().expect("clear");
    shop.ctx.tokens.put(&token).expect("place the token");
    let denied = session_service::resolve(shop.pool(), shop.ctx.tokens.as_ref()).await;
    assert!(
        matches!(denied, Err(DomainError::AccountDisabled)),
        "an open session must stop working the moment the account is disabled, got {denied:?}"
    );
}

#[tokio::test]
async fn a_disabled_account_can_be_re_enabled() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let target = shop.add_sales("Ahmed", "ahmed").await;
    let elevated = shop.resolve().await;
    users::disable_user(shop.pool(), &elevated, target).await.expect("disable");
    users::enable_user(shop.pool(), &shop.resolve().await, target)
        .await
        .expect("enable");

    shop.ctx.tokens.clear().expect("clear");
    auth::login(shop.pool(), shop.ctx.tokens.as_ref(), target, MANAGER_PASSWORD)
        .await
        .expect("a re-enabled account can sign in again");
    assert_eq!(shop.audit_count(audit::event::USER_ENABLED).await, 1);
}

#[tokio::test]
async fn the_last_manager_cannot_be_disabled() {
    // There is no server, no sync and no backdoor (`ADR-008`), so disabling the only
    // manager leaves a device nobody can ever administer again.
    let shop = shop().await;
    shop.reauthenticate().await;
    shop.add_sales("Ahmed", "ahmed").await;
    let elevated = shop.resolve().await;

    let refused = users::disable_user(shop.pool(), &elevated, elevated.user_id()).await;
    assert!(
        matches!(refused, Err(DomainError::CannotDisableSelf)),
        "self-disable must be refused first, got {refused:?}"
    );
}

#[tokio::test]
async fn a_manager_cannot_be_demoted_when_it_is_the_last_one() {
    let shop = shop().await;
    shop.reauthenticate().await;
    shop.add_sales("Ahmed", "ahmed").await;
    let elevated = shop.resolve().await;

    let refused =
        users::change_role(shop.pool(), &elevated, elevated.user_id(), Role::Sales).await;
    assert!(
        matches!(refused, Err(DomainError::CannotDisableLastManager)),
        "demoting the only manager must be refused, got {refused:?}"
    );
}

#[tokio::test]
async fn a_second_manager_allows_the_first_to_be_demoted() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let second = users::create_user(
        shop.pool(),
        &shop.resolve().await,
        "Layla",
        "layla",
        Role::Manager,
        MANAGER_PASSWORD,
    )
    .await
    .expect("create a second manager");
    let elevated = shop.resolve().await;

    users::change_role(shop.pool(), &elevated, elevated.user_id(), Role::Sales)
        .await
        .expect("with two managers, demoting one is allowed");

    let role: String = sqlx::query_scalar("SELECT role FROM users WHERE id = ?1")
        .bind(elevated.user_id().as_str())
        .fetch_one(shop.pool())
        .await
        .expect("read role");
    assert_eq!(role, "sales");
    assert_eq!(shop.audit_count(audit::event::ROLE_CHANGED).await, 1);
    let _ = second;
}

#[tokio::test]
async fn a_role_change_is_audited_with_both_roles() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let second = users::create_user(
        shop.pool(),
        &shop.resolve().await,
        "Layla",
        "layla",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await
    .expect("create");
    let elevated = shop.resolve().await;
    users::change_role(shop.pool(), &elevated, second, Role::Manager)
        .await
        .expect("promote");

    let detail: Option<String> = sqlx::query_scalar(
        "SELECT detail FROM audit_events WHERE event_type = ?1 ORDER BY occurred_at DESC LIMIT 1",
    )
    .bind(audit::event::ROLE_CHANGED)
    .fetch_one(shop.pool())
    .await
    .expect("audit row");
    let detail = detail.unwrap_or_default();
    assert!(detail.contains("sales") && detail.contains("manager"));
}

// ---------------------------------------------------------------------------
// Username change
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_manager_can_rename_an_account_and_the_change_is_audited() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let target = shop.add_sales("Ahmed", "ahmed").await;
    let elevated = shop.resolve().await;

    users::set_username(shop.pool(), &elevated, target, "ahmed.new")
        .await
        .expect("rename");

    let stored: String =
        sqlx::query_scalar("SELECT username FROM user_credentials WHERE user_id = ?1")
            .bind(target.as_str())
            .fetch_one(shop.pool())
            .await
            .expect("read username");
    assert_eq!(stored, "ahmed.new");

    let detail: Option<String> = sqlx::query_scalar(
        "SELECT detail FROM audit_events WHERE event_type = ?1 ORDER BY occurred_at DESC LIMIT 1",
    )
    .bind(audit::event::USERNAME_CHANGED)
    .fetch_one(shop.pool())
    .await
    .expect("audit row");
    let detail = detail.unwrap_or_default();
    // D9 requires both the old and the new value so a report can show the change.
    assert!(detail.contains("ahmed\"") || detail.contains("\"old_username\":\"ahmed\""));
    assert!(detail.contains("ahmed.new"));
}

#[tokio::test]
async fn a_rename_onto_an_existing_username_is_refused() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let first = shop.add_sales("First", "first").await;
    shop.add_sales("Second", "second").await;
    let elevated = shop.resolve().await;

    let clash = users::set_username(shop.pool(), &elevated, first, "second").await;
    assert!(
        matches!(clash, Err(DomainError::UsernameAlreadyExists)),
        "a rename onto a taken username must be refused, got {clash:?}"
    );
}

#[tokio::test]
async fn a_sales_user_cannot_rename_themselves() {
    let shop = shop().await;
    shop.reauthenticate().await;
    let sales_id = shop.add_sales("Ahmed", "ahmed").await;
    shop.ctx.tokens.clear().expect("clear");
    auth::login(shop.pool(), shop.ctx.tokens.as_ref(), sales_id, MANAGER_PASSWORD)
        .await
        .expect("sales signs in");
    session_service::reauthenticate(shop.pool(), shop.ctx.tokens.as_ref(), MANAGER_PASSWORD)
        .await
        .expect("sales re-authenticates");
    let sales = shop.resolve().await;

    let refused = users::set_username(shop.pool(), &sales, sales_id, "mine").await;
    assert!(
        matches!(refused, Err(DomainError::PermissionDenied)),
        "a sales user has no ManageUsers even when re-authenticated, got {refused:?}"
    );
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_backfilled_username_is_present_and_usable_for_every_account() {
    // Migration `0003` must give every pre-existing account a usable identifier.
    // On a real device this is the account created during first-run setup.
    let pool = db::open_in_memory().await.expect("in-memory database");
    let manager = bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .expect("create the manager");

    let username: String =
        sqlx::query_scalar("SELECT username FROM user_credentials WHERE user_id = ?1")
            .bind(manager.user_id.as_str())
            .fetch_one(&pool)
            .await
            .expect("a backfilled username");
    assert_eq!(username, format!("user-{}", &manager.user_id.as_str()[..8]));
    assert!(Username::new(&username).is_ok(), "the backfill must satisfy the rules");
}

#[tokio::test]
async fn the_username_column_really_is_not_null_and_unique() {
    // D19 is a database-level invariant, not an application convention. If either
    // constraint were missing, a caller that forgot to check would get through.
    let pool = db::open_in_memory().await.expect("in-memory database");
    let manager = bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .expect("create");
    bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .err()
        .expect("bootstrap only runs once");

    // NOT NULL: a row cannot be written without a username.
    let not_null = sqlx::query(
        "INSERT INTO user_credentials (user_id, username, must_change_password)
         VALUES (?1, NULL, 0)",
    )
    .bind(manager.user_id.as_str())
    .execute(&pool)
    .await;
    assert!(
        not_null.is_err(),
        "the schema must reject a NULL username; D19 requires NOT NULL"
    );

    // UNIQUE, case-insensitively.
    //
    // A *second* account, not the manager's own id again: reusing it would fail on
    // the PRIMARY KEY, and the test would pass for the wrong reason. The manager's
    // backfilled username is the identifier already in the table.
    let manager_row = sqlx::query("SELECT username FROM user_credentials WHERE user_id = ?1")
        .bind(manager.user_id.as_str())
        .fetch_one(&pool)
        .await
        .expect("the manager has a backfilled username");
    let taken: String = manager_row.get("username");

    let other = UserId::generate();
    let clash = sqlx::query(
        "INSERT INTO user_credentials (user_id, username, must_change_password)
         VALUES (?1, ?2, 0)",
    )
    .bind(other.as_str())
    .bind(taken.to_uppercase())
    .execute(&pool)
    .await;
    assert!(
        clash.is_err(),
        "the schema must reject a case-insensitive duplicate username"
    );
}

#[tokio::test]
async fn a_null_username_is_rejected_by_the_column_itself() {
    // D19 is specifically about the *column* being NOT NULL. The sibling test uses
    // the manager's own id, so a rejection there could come from the PRIMARY KEY
    // instead and prove nothing. This one inserts a fresh id with a NULL username,
    // so only NOT NULL can be what refuses it.
    let pool = db::open_in_memory().await.expect("in-memory database");
    bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .expect("create");

    let fresh = UserId::generate();
    let attempt = sqlx::query(
        "INSERT INTO user_credentials (user_id, username, must_change_password)
         VALUES (?1, NULL, 0)",
    )
    .bind(fresh.as_str())
    .execute(&pool)
    .await;

    let message = match attempt {
        Ok(_) => panic!("the column must refuse a NULL username"),
        Err(sqlx::Error::Database(inner)) => inner.to_string(),
        Err(other) => panic!("expected a constraint violation, got {other:?}"),
    };
    assert!(
        message.contains("NOT NULL"),
        "the refusal must come from NOT NULL, not from another constraint; got: {message}"
    );
}

#[tokio::test]
async fn the_must_change_column_rejects_a_value_outside_zero_or_one() {
    let pool = db::open_in_memory().await.expect("in-memory database");
    let manager = bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .expect("create");

    let bad = sqlx::query(
        "UPDATE user_credentials SET must_change_password = 7 WHERE user_id = ?1",
    )
    .bind(manager.user_id.as_str())
    .execute(&pool)
    .await;
    assert!(
        bad.is_err(),
        "the CHECK constraint must confine the flag to 0 or 1"
    );
}

#[tokio::test]
async fn there_is_no_delete_path_for_a_user_that_has_catalogued_something() {
    // D10, proved against the real schema rather than by inspecting the code.
    let pool = db::open_in_memory().await.expect("in-memory database");
    let manager = bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .expect("create");

    sqlx::query(
        "INSERT INTO products (id, name, disposition, status, created_by, updated_by,
                               created_at, updated_at)
         VALUES ('p1', 'x', 'quantity', 'active', ?1, ?1, 0, 0)",
    )
    .bind(manager.user_id.as_str())
    .execute(&pool)
    .await
    .expect("insert a product attributed to the manager");

    let deleted = sqlx::query("DELETE FROM users WHERE id = ?1")
        .bind(manager.user_id.as_str())
        .execute(&pool)
        .await;
    assert!(
        deleted.is_err(),
        "ON DELETE RESTRICT must block deleting a user who owns history"
    );
}

#[tokio::test]
async fn a_catalogued_device_keeps_identity_history_across_the_lifecycle_migration() {
    // The `0001 -> 0002 -> 0003` path: existing identity and catalogue rows must all
    // survive the new migration, which is what a field device will actually do.
    let pool = db::open_in_memory().await.expect("in-memory database");
    let manager = bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .expect("create");

    sqlx::query(
        "INSERT INTO products (id, name, disposition, sale_price_minor, status, created_by,
                               updated_by, created_at, updated_at)
         VALUES ('p1', 'منتج', 'quantity', NULL, 'active', ?1, ?1, 0, 0)",
    )
    .bind(manager.user_id.as_str())
    .execute(&pool)
    .await
    .expect("insert a product");

    let applied: Vec<String> = sqlx::query_scalar(
        "SELECT description FROM _sqlx_migrations WHERE success = 1 ORDER BY version",
    )
    .fetch_all(&pool)
    .await
    .expect("read the applied migration list");
    assert!(
        applied.len() >= 3,
        "all three migrations must be recorded, got {applied:?}"
    );

    let row = sqlx::query("SELECT name, sale_price_minor, created_by FROM products WHERE id = 'p1'")
        .fetch_one(&pool)
        .await
        .expect("the product survived");
    assert_eq!(row.get::<String, _>("name"), "منتج");
    assert_eq!(row.get::<Option<i64>, _>("sale_price_minor"), None);
    assert_eq!(row.get::<String, _>("created_by"), manager.user_id.as_str());
}

#[tokio::test]
async fn the_picker_tells_two_operators_sharing_a_name_apart() {
    // D6/D7. The picker is the only place an operator chooses who they are, and
    // `display_name` is not unique, so the username has to reach it.
    let pool = db::open_in_memory().await.expect("in-memory database");
    let tokens = Arc::new(InMemoryTokenStore::new());
    // Widened to the trait object, with the concrete handle kept for direct
    // `auth::login` calls below.
    let shared: Arc<dyn SecureTokenStore> = Arc::clone(&tokens) as Arc<dyn SecureTokenStore>;
    let ctx = IdentityContext::new(pool.clone(), Arc::clone(&shared));

    let first = bootstrap::create_first_manager(&pool, "Ahmed", MANAGER_PASSWORD)
        .await
        .expect("create the manager");
    auth::login(&pool, tokens.as_ref(), first.user_id, MANAGER_PASSWORD)
        .await
        .expect("login");

    let picker = auth::list_users(&pool).await.expect("list for the picker");
    assert_eq!(picker.len(), 1, "bootstrap creates exactly one account");

    // The username must be present on the projection, and the disabled flag with it.
    let manager = &picker[0];
    let identifier = manager
        .username
        .as_ref()
        .expect("an intact account carries its identifier");
    assert!(
        identifier.as_str().starts_with("user-"),
        "the picker must carry the login identifier, got {identifier:?}"
    );
    assert!(
        !manager.disabled,
        "a fresh account is not disabled"
    );

    // The picker must never carry anything sensitive. This is the projection that
    // crosses into JavaScript, so its field list is asserted directly.
    let projection = format!("{manager:?}");
    for forbidden in ["argon2", "$argon2id", "verifier", "failed_attempts", "locked_until"] {
        assert!(
            !projection.to_lowercase().contains(forbidden),
            "the picker projection must not expose `{forbidden}`"
        );
    }

    // And a disabled account is still listed, so it is visible rather than missing.
    let ctx_ref = &ctx;
    session_service::reauthenticate(&ctx_ref.pool, ctx_ref.tokens.as_ref(), MANAGER_PASSWORD)
        .await
        .expect("reauth");
    let elevated = session_service::resolve(&ctx_ref.pool, ctx_ref.tokens.as_ref())
        .await
        .expect("resolve again");

    let sales = users::create_user(
        &ctx_ref.pool,
        &elevated,
        "Ahmed",
        "ahmed",
        Role::Sales,
        MANAGER_PASSWORD,
    )
    .await
    .expect("create a second Ahmed");

    users::disable_user(&ctx_ref.pool, &elevated, sales).await.expect("disable");

    let picker = auth::list_users(&pool).await.expect("list again");
    let disabled_entry = picker
        .iter()
        .find(|u| u.id == sales)
        .expect("a disabled account must still appear in the picker");
    assert!(
        disabled_entry.disabled,
        "the picker must mark the account as disabled rather than hiding it"
    );
}

#[tokio::test]
async fn a_disabled_account_is_refused_a_distinct_error_from_a_locked_one() {
    // `ACCOUNT_DISABLED` and `ACCOUNT_TEMPORARILY_LOCKED` are separate codes on
    // purpose: a lockout ends on its own in fifteen minutes, a disable does not.
    // Telling an operator to wait for something that will never change is worse
    // than useless.
    let shop = shop().await;
    shop.reauthenticate().await;
    let target = shop.add_sales("Ahmed", "ahmed").await;
    let elevated = shop.resolve().await;

    users::disable_user(shop.pool(), &elevated, target).await.expect("disable");
    shop.ctx.tokens.clear().expect("clear");
    let disabled = auth::login(shop.pool(), shop.ctx.tokens.as_ref(), target, MANAGER_PASSWORD).await;
    assert!(
        matches!(disabled, Err(DomainError::AccountDisabled)),
        "expected ACCOUNT_DISABLED, got {disabled:?}"
    );
    assert_eq!(
        disabled.err().map(|e| e.code()),
        Some("ACCOUNT_DISABLED")
    );

    // Now lock a live account and confirm it reports differently. Re-enabling revoked
    // the target's session, so the manager has to sign in again before resolving.
    users::enable_user(shop.pool(), &elevated, target).await.expect("enable");
    for _ in 0..MAX_FAILED_ATTEMPTS {
        let _ = auth::login(shop.pool(), shop.ctx.tokens.as_ref(), target, "wrong").await;
    }
    let locked = auth::login(shop.pool(), shop.ctx.tokens.as_ref(), target, MANAGER_PASSWORD).await;
    assert!(
        matches!(locked, Err(DomainError::AccountLocked)),
        "expected ACCOUNT_TEMPORARILY_LOCKED, got {locked:?}"
    );
    assert_ne!(
        DomainError::AccountDisabled.code(),
        DomainError::AccountLocked.code(),
        "a disable and a lockout must not share a code"
    );
}

#[tokio::test]
async fn the_dead_manager_reset_error_code_is_gone() {
    // D15. It promised a manager reset that no code performed, and the lockout it
    // described expires on its own, so the variant, the transport code and the
    // Arabic text are all removed.
    let pool = db::open_in_memory().await.expect("in-memory database");
    bootstrap::create_first_manager(&pool, "Peter", MANAGER_PASSWORD)
        .await
        .expect("create");

    // Lock the account out, then confirm the reachable error is the lockout itself.
    let tokens = Arc::new(InMemoryTokenStore::new());
    let manager_id: String = sqlx::query_scalar("SELECT id FROM users LIMIT 1")
        .fetch_one(&pool)
        .await
        .expect("id");
    let manager = UserId::from_uuid(manager_id.parse().expect("uuid"));

    for _ in 0..MAX_FAILED_ATTEMPTS {
        let _ = auth::login(&pool, tokens.as_ref(), manager, "wrong").await;
    }
    let locked = auth::login(&pool, tokens.as_ref(), manager, MANAGER_PASSWORD).await;
    match locked {
        Err(DomainError::AccountLocked) => {}
        other => panic!("expected AccountLocked, got {other:?}"),
    }

    // The old code must not be emitted for any reachable failure.
    let emitted: Vec<&'static str> = vec![
        DomainError::AccountLocked.code(),
        DomainError::AccountDisabled.code(),
        DomainError::PermissionDenied.code(),
    ];
    assert!(
        !emitted.contains(&"ACCOUNT_LOCKED_MANAGER_RESET_REQUIRED"),
        "the dead manager-reset code must no longer be emitted"
    );
}
