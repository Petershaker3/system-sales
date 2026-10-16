//! User administration.
//!
//! Every function here requires `Permission::ManageUsers`, which
//! `Permission::requires_reauthenticated` makes contingent on a freshly proven
//! password. No caller can reach these without passing that gate, so the
//! re-authentication requirement cannot be forgotten at a call site.
//!
//! Two rules shape the whole module:
//!
//! * **No user is ever deleted.** `products.created_by` is `ON DELETE RESTRICT`,
//!   so deleting an operator who ever catalogued something would fail at the
//!   database level anyway. Disabling is the lifecycle.
//! * **The last active manager cannot be disabled.** V1 has no server and no sync
//!   (`ADR-008`), so there is no second device and no backdoor to recover through.
//!   Disabling the only manager would leave a device that can never be
//!   administered again. This is refused, not merely discouraged.

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::{
    CredentialVerifier, DomainError, Permission, Role, Session, Timestamp, UserId, Username,
    password_is_acceptable,
};
use crate::services::identity::crypto;

/// One account as the management screen sees it.
///
/// Carries the username because `display_name` is not unique: two operators may
/// share a name, and a management list that showed only names would make them
/// indistinguishable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedUser {
    pub user_id: UserId,
    pub display_name: String,
    /// The login identifier.
    ///
    /// A placeholder when `integrity_fault` is set: the repository reports a
    /// `None` for an account with no credentials row, and inventing a value the
    /// operator might then act on would be worse than an obviously marked row.
    pub username: String,
    pub role: Role,
    pub disabled: bool,
    pub must_change_password: bool,
    /// This account has no `user_credentials` row.
    ///
    /// The management list is the one place an operator can *see* that an account is
    /// broken and act on it, so it must not simply omit the account. The flag makes
    /// the fault visible; the placeholder above keeps the row selectable.
    pub integrity_fault: bool,
}

/// Every account, for user management.
pub async fn list_managed(
    pool: &SqlitePool,
    session: &Session,
) -> Result<Vec<ManagedUser>, DomainError> {
    session.authorize(Permission::ManageUsers)?;

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let rows = user_repo::list_with_usernames(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let integrity_fault = row.username.is_none();
            ManagedUser {
                user_id: row.user.id,
                display_name: row.user.display_name,
                username: row
                    .username
                    .map(|u| u.as_str().to_string())
                    .unwrap_or_else(|| MISSING_USERNAME_PLACEHOLDER.to_string()),
                role: row.user.role,
                disabled: row.disabled_at.is_some(),
                // A missing flag is unknown, not `false`. Reported as `false` here
                // only because the row is already flagged as faulty; the login and
                // resolve paths refuse such an account outright.
                must_change_password: row.must_change_password.unwrap_or(false),
                integrity_fault,
            }
        })
        .collect())
}

/// Shown in place of a login identifier that does not exist.
///
/// Unmistakably not a valid identifier: it is longer than `Username::MAX_LEN` and
/// contains characters the rules forbid, so it can never be mistaken for a real
/// account name or submitted as one.
pub const MISSING_USERNAME_PLACEHOLDER: &str = "(بيانات ناقصة)";

/// Create an account with a role chosen by a manager.
///
/// Follows `bootstrap.rs` exactly: validate, hash, then a single transaction
/// containing the user row, the credential row and the audit event. There is no
/// count gate here — unlike bootstrap, creating a second manager is legitimate —
/// but the atomicity is the same, so a failure cannot leave an account with no
/// username or a username with no account.
pub async fn create_user(
    pool: &SqlitePool,
    session: &Session,
    display_name: &str,
    username: &str,
    role: Role,
    password: &str,
) -> Result<UserId, DomainError> {
    session.authorize(Permission::ManageUsers)?;

    let display_name = display_name.trim();
    if display_name.is_empty() {
        return Err(DomainError::DisplayNameRequired);
    }
    let username = Username::new(username)?;
    if !password_is_acceptable(password) {
        return Err(DomainError::WeakPassword);
    }
    let verifier =
        CredentialVerifier::from_phc(crypto::hash_password(password).map_err(|_| {
            DomainError::InvalidCredentials
        })?)?;

    let id = UserId::generate();
    let now = Timestamp::now();
    let actor = session.user_id();

    // Opened on the pool rather than on an acquired connection: holding a pooled
    // connection while asking the pool for a second one deadlocks a
    // single-connection pool, which is how the in-memory test database is set up.
    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    let user = crate::domain::identity::User {
        id,
        display_name: display_name.to_string(),
        role,
        verifier,
        failed_attempts: 0,
        locked_until: None,
    };

    if let Err(error) = user_repo::insert(&mut tx, &user, now).await {
        return Err(match error {
            _ if user_repo::is_unique_violation(&error) => DomainError::UsernameAlreadyExists,
            _ => DomainError::StorageUnavailable,
        });
    }

    if let Err(error) = credential_repo::insert(&mut tx, id, &username).await {
        return Err(if user_repo::is_unique_violation(&error) {
            DomainError::UsernameAlreadyExists
        } else {
            DomainError::StorageUnavailable
        });
    }

    audit::append(
        &mut tx,
        actor,
        audit::event::USER_CREATED,
        now,
        Some(format!(
            r#"{{"target":"{}","role":"{}","username":"{}"}}"#,
            id.as_str(),
            role.as_str(),
            username.as_str()
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(id)
}

/// Change an account's role.
///
/// Refuses to strip the last manager of `ManageUsers`, which is the same
/// unadministrable-device problem as disabling them: a shop with no operator who
/// can onboard staff cannot add one.
pub async fn change_role(
    pool: &SqlitePool,
    session: &Session,
    target: UserId,
    new_role: Role,
) -> Result<(), DomainError> {
    session.authorize(Permission::ManageUsers)?;

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    let target_user = user_repo::find_by_id(&mut conn, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::UserNotFound)?;

    if target_user.role == new_role {
        return Ok(());
    }

    // Only a demotion away from Manager needs the guard.
    if target_user.role == Role::Manager && new_role != Role::Manager {
        let active = user_repo::count_active_managers(&mut conn, now)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        if active <= 1 {
            return Err(DomainError::CannotDisableLastManager);
        }
    }

    // The pooled connection is released before the transaction opens. Holding it
    // while asking the pool for a second connection deadlocks a single-connection
    // pool, which is how the in-memory test database is configured.
    drop(conn);

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    user_repo::update_role(&mut tx, target, new_role, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::ROLE_CHANGED,
        now,
        Some(format!(
            r#"{{"target":"{}","from":"{}","to":"{}"}}"#,
            target.as_str(),
            target_user.role.as_str(),
            new_role.as_str()
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(())
}

/// Disable an account.
///
/// Refuses the last active manager and refuses self-disable. A disabled account
/// cannot obtain a session — `Session::open` refuses it — and any session it
/// already holds stops resolving on the very next command.
pub async fn disable_user(
    pool: &SqlitePool,
    session: &Session,
    target: UserId,
) -> Result<(), DomainError> {
    session.authorize(Permission::ManageUsers)?;

    let actor = session.user_id();
    if actor == target {
        // Otherwise a manager could disable themselves and sign the device out
        // permanently, since no one else could re-enable the account.
        return Err(DomainError::CannotDisableSelf);
    }

    let now = Timestamp::now();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    let target_user = user_repo::find_by_id(&mut conn, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::UserNotFound)?;

    if target_user.role == Role::Manager {
        let active = user_repo::count_active_managers(&mut conn, now)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        if active <= 1 {
            return Err(DomainError::CannotDisableLastManager);
        }
    }

    // The pooled connection is released before the transaction opens. Holding it
    // while asking the pool for a second connection deadlocks a single-connection
    // pool, which is how the in-memory test database is configured.
    drop(conn);

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    user_repo::set_disabled(&mut tx, target, Some(now), Some(actor), now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let revoked = session_repo::delete_by_user(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::USER_DISABLED,
        now,
        Some(format!(
            r#"{{"target":"{}","sessions_revoked":{}}}"#,
            target.as_str(),
            revoked
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(())
}

/// Re-enable a previously disabled account.
pub async fn enable_user(
    pool: &SqlitePool,
    session: &Session,
    target: UserId,
) -> Result<(), DomainError> {
    session.authorize(Permission::ManageUsers)?;

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    if user_repo::find_by_id(&mut conn, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .is_none()
    {
        return Err(DomainError::UserNotFound);
    }

    // The pooled connection is released before the transaction opens. Holding it
    // while asking the pool for a second connection deadlocks a single-connection
    // pool, which is how the in-memory test database is configured.
    drop(conn);

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    user_repo::set_disabled(&mut tx, target, None, None, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::USER_ENABLED,
        now,
        Some(format!(r#"{{"target":"{}"}}"#, target.as_str())),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(())
}

/// Change an account's login identifier.
///
/// Manager-only and re-authenticated, which `authorize(Permission::ManageUsers)`
/// already enforces. A sales user cannot rename themselves; only a manager can
/// rename anyone, including themselves.
///
/// The username is not a secret, but it is the identity an operator selects and
/// reads aloud, so both the old and the new value are audited.
pub async fn set_username(
    pool: &SqlitePool,
    session: &Session,
    target: UserId,
    username: &str,
) -> Result<(), DomainError> {
    session.authorize(Permission::ManageUsers)?;

    let username = Username::new(username)?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    let existing = credential_repo::find_by_user(&mut conn, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::UserNotFound)?;

    // The pooled connection is released before the transaction opens. Holding it
    // while asking the pool for a second connection deadlocks a single-connection
    // pool, which is how the in-memory test database is configured.
    drop(conn);

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    if let Err(error) = credential_repo::update_username(&mut tx, target, &username).await {
        return Err(if user_repo::is_unique_violation(&error) {
            DomainError::UsernameAlreadyExists
        } else {
            DomainError::StorageUnavailable
        });
    }

    audit::append(
        &mut tx,
        actor,
        audit::event::USERNAME_CHANGED,
        now,
        Some(format!(
            r#"{{"target":"{}","old_username":"{}","new_username":"{}"}}"#,
            target.as_str(),
            existing.username.as_str(),
            username.as_str()
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(())
}