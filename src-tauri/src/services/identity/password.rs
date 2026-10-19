//! Password management.
//!
//! Two operations, deliberately separated because they have different authority
//! requirements:
//!
//! * [`change_own_password`] — the account proves its *current* password.
//! * [`manager_reset_password`] — a manager with a freshly proven password sets
//!   someone else's, and forces a change at next sign-in.
//!
//! Both leave the credential store alone except where a session genuinely must
//! stop working. Neither ever returns, logs, or audits a password or a verifier.

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::{
    Assurance, CredentialVerifier, DomainError, Permission, Session, Timestamp, UserId,
    password_is_acceptable,
};
use crate::services::identity::crypto;
use crate::services::identity::open_mode;
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as session_service;

/// Hash a password into a verifier, rejecting one that fails the policy first.
///
/// The policy check happens *before* hashing so a rejected password costs nothing,
/// and so the error an operator sees is about their new password rather than a
/// hashing failure.
fn verifier_for(password: &str) -> Result<CredentialVerifier, DomainError> {
    if !password_is_acceptable(password) {
        return Err(DomainError::WeakPassword);
    }
    let phc = crypto::hash_password(password).map_err(|_| DomainError::InvalidCredentials)?;
    CredentialVerifier::from_phc(phc)
}

/// Change the signed-in account's own password.
///
/// The current password is required. Without that check anyone holding an unlocked
/// device could change the password and lock the real owner out — which on an
/// offline single-owner POS with no server is unrecoverable.
///
/// On success the session's assurance returns to `Normal`: `Reauthenticated` means
/// "this password was freshly proven", which describes a moment rather than a
/// lasting state, and leaving it elevated would let it leak into unrelated later
/// commands. The session itself stays valid; the operator just proved themselves
/// and has no reason to be ejected.
pub async fn change_own_password(
    pool: &SqlitePool,
    session: &Session,
    current_password: &str,
    new_password: &str,
) -> Result<Assurance, DomainError> {
    // Permitted even while a manager reset is pending: this is the one operation
    // a forced-change session may perform.
    session.authorize(Permission::ChangeOwnPassword)?;

    let new_verifier = verifier_for(new_password)?;
    let now = Timestamp::now();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    let user = user_repo::find_by_id(&mut conn, session.user_id())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::UserNotFound)?;

    if !crypto::verify_password(current_password, user.verifier.expose()) {
        // Not counted as a failed sign-in: the caller already holds a valid
        // session, and counting these would let a legitimate operator walk their
        // own account into a lockout by mistyping a confirmation.
        let _ = audit::append(
            &mut conn,
            user.id,
            audit::event::LOGIN_FAILED,
            now,
            Some(r#"{"reason":"current_password_mismatch"}"#.to_string()),
        )
        .await;
        return Err(DomainError::InvalidCredentials);
    }

    // Verifier, forced-change flag and audit event commit together. A verifier
    // written without clearing the flag would leave the account unable to do
    // anything but repeat the change.
    // The pooled connection is released before the transaction opens. Holding it
    // while asking the pool for a second connection deadlocks a single-connection
    // pool, which is how the in-memory test database is configured.
    drop(conn);

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    user_repo::update_verifier(&mut tx, user.id, &new_verifier, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    credential_repo::set_must_change_password(&mut tx, user.id, false)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        user.id,
        audit::event::PASSWORD_CHANGED,
        now,
        Some(r#"{"self_service":true}"#.to_string()),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(Assurance::Normal)
}

/// Set another account's password and force a change at their next sign-in.
///
/// This is the capability that makes a forgotten password recoverable. It revokes
/// the target's sessions only, so the manager performing the reset stays signed
/// in; see `session_repo::delete_by_user` for why that matters.
pub async fn manager_reset_password(
    pool: &SqlitePool,
    session: &Session,
    target: UserId,
    temporary_password: &str,
) -> Result<(), DomainError> {
    // Requires both the manager role and a freshly proven password: whoever is
    // resetting a password has just chosen it, so the accountability for that
    // choice belongs to a session that proved the manager still knows their own.
    session.authorize(Permission::ManageUsers)?;

    if session.user_id() == target {
        // A manager resetting their own password through the reset path would skip
        // the current-password check that `change_own_password` performs.
        return Err(DomainError::CannotDisableSelf);
    }

    let verifier = verifier_for(temporary_password)?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    // Existence is the point: a reset must fail loudly for an unknown account
    // rather than silently writing nothing.
    user_repo::find_by_id(&mut conn, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::UserNotFound)?;

    // And a reset writes a temporary password plus a forced change, so the open till
    // is refused here like everywhere else (`ADR-039`). The self-refusal above
    // already blocks it today — an open shop has exactly one manager and it is that
    // row — and the guard is what stops the second manager this module could one day
    // grow from doing it instead.
    open_mode::ensure_is_account(&mut conn, target).await?;

    // The pooled connection is released before the transaction opens. Holding it
    // while asking the pool for a second connection deadlocks a single-connection
    // pool, which is how the in-memory test database is configured.
    drop(conn);

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    user_repo::update_verifier(&mut tx, target, &verifier, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    credential_repo::set_must_change_password(&mut tx, target, true)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // Scoped to the target. `delete_all` here would revoke the manager's own
    // session mid-operation.
    let revoked = session_repo::delete_by_user(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    audit::append(
        &mut tx,
        actor,
        audit::event::PASSWORD_RESET,
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

/// Re-raise the session after a self-service change.
///
/// Split out so the command layer can downgrade the persisted session row too: the
/// in-memory `Session` and the stored row are separate, and leaving the stored
/// assurance elevated would re-authorise the next command.
pub async fn persist_downgraded_assurance(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Assurance, DomainError> {
    session_service::downgrade_to_normal(pool, tokens).await
}