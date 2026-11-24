//! First-run setup: creating the very first manager, exactly once.
//!
//! The Product Owner decided there is no seeded account and no bootstrap CLI.
//! The database starts empty (`spec:175`) and the first manager is created by
//! the user on first launch.
//!
//! # Why the gate is inside the transaction
//!
//! `spec:210` requires permissions to be enforced at the application/data layer
//! and not by hiding UI elements. A check performed by the frontend, or even by a
//! Rust command that checks and then writes in two separate steps, is a race and
//! is bypassable. Here the count and the insert share one SQLx transaction, so a
//! second attempt either sees zero users and proceeds, or sees a committed user
//! and aborts. There is no interleaving in which two managers are created.

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::DomainError;
use crate::domain::identity::UserId;
use crate::domain::identity::Role;
use crate::domain::identity::{Timestamp, ABSOLUTE_LIFETIME_MS};
use crate::domain::identity::{
    password_is_acceptable, CredentialVerifier, User, Username,
};
use crate::services::identity::crypto;

/// Whether this device has no account at all.
///
/// Reported by `bootstrap_status` for the log and the banner; it opens no screen
/// (`ADR-039`). The one path that still creates an account on an empty device is
/// `open_mode::claim_open_account`, which calls [`create_first_manager`] itself.
pub async fn bootstrap_needed(pool: &SqlitePool) -> Result<bool, sqlx::Error> {
    let mut conn = pool.acquire().await?;
    Ok(user_repo::count_all(&mut conn).await? == 0)
}

/// Create the first manager on a device that has no accounts.
///
/// Returns the new user's id, display name and role. It never returns a session
/// token: the token is written straight to the OS credential store and is not
/// observable by the caller.
///
/// Two callers, and that is the whole list (`ADR-039`): the settings card's claim,
/// when the open row could not be made and the device is empty, and the integration
/// fixtures that need a shop with a real owner before they test anything else. There
/// is no first-run command in front of it any more — hiding a screen was never what
/// made this single-shot, and the check that it is one is the same
/// `count_claimed == 0` inside the transaction that the claim runs.
pub async fn create_first_manager(
    pool: &SqlitePool,
    display_name: &str,
    password: &str,
) -> Result<CreatedAccount, DomainError> {
    let trimmed = display_name.trim();

    if trimmed.is_empty() {
        return Err(DomainError::WeakPassword);
    }
    if !password_is_acceptable(password) {
        return Err(DomainError::WeakPassword);
    }

    let verifier = CredentialVerifier::from_phc(
        crypto::hash_password(password).map_err(|_| DomainError::InvalidCredentials)?,
    )?;

    let id = UserId::generate();
    let now = Timestamp::now();

    let user = User {
        id,
        display_name: trimmed.to_string(),
        // The first account is always a manager. There is nobody yet who could
        // be granted a lesser role, and a shop with no administrator cannot be
        // operated.
        role: Role::Manager,
        verifier,
        failed_attempts: 0,
        locked_until: None,
    };

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    // The gate. Same transaction as the insert below.
    let existing = user_repo::count_all(&mut *tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if existing > 0 {
        return Err(DomainError::BootstrapAlreadyCompleted);
    }

    user_repo::insert(&mut tx, &user, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // Every account needs a credentials row, including the very first one. The
    // `0003` backfill only reaches rows that existed when the migration ran, so a
    // fresh device would otherwise create a manager with no username: invisible in
    // the login picker, and a hole in the `NOT NULL UNIQUE` invariant that D19
    // requires the schema to enforce.
    //
    // This account cannot choose its own identifier - it was created before anyone
    // signed in - so it takes the same deterministic `user-<8 hex>` placeholder the
    // backfill uses, and the manager renames it from user management.
    let username = Username::backfill_from(&id);
    credential_repo::insert(&mut tx, id, &username)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        id,
        audit::event::FIRST_MANAGER_CREATED,
        now,
        Some(format!(r#"{{"role":"{}"}}"#, user.role.as_str())),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(CreatedAccount {
        user_id: id,
        display_name: trimmed.to_string(),
        role: user.role,
        absolute_expires_at: now.plus_millis(ABSOLUTE_LIFETIME_MS),
    })
}

/// What the setup screen learns after success.
///
/// Deliberately excludes the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedAccount {
    pub user_id: UserId,
    pub display_name: String,
    pub role: Role,
    pub absolute_expires_at: Timestamp,
}