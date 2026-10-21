//! The daily PIN (ADR-017 §1): setting your own, a manager setting a seller's,
//! and the sign-in picker's `hasPin`. Signing in with it is
//! [`crate::services::identity::auth::login_with_pin`].
//!
//! What is stored is an Argon2id verifier in `user_credentials.pin_verifier`,
//! never the PIN, and no audit detail ever carries either. A PIN is 4 to 6
//! digits ([`pin_is_acceptable`]); a wrong one counts in the same lockout as a
//! wrong password.

use std::collections::HashSet;

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::{
    pin_is_acceptable, DomainError, Permission, Session, Timestamp, UserId,
};
use crate::services::identity::crypto;
use crate::services::identity::open_mode;

/// Validate a PIN and derive its verifier. The policy check comes first so a
/// malformed PIN is refused before any hashing work.
fn verifier_for(pin: &str) -> Result<String, DomainError> {
    if !pin_is_acceptable(pin) {
        return Err(DomainError::WeakPin);
    }
    crypto::hash_password(pin).map_err(|_| DomainError::InvalidCredentials)
}

/// Set or change the signed-in user's own PIN.
///
/// * The **first** PIN needs only the session: right after first-run setup, or
///   after a sign-in with the password.
/// * **Changing** an existing PIN needs the current password, so a session left
///   open cannot be used to take over someone's daily secret.
/// * A pending forced password change comes first, as it does for everything
///   but the password change itself.
pub async fn set_own_pin(
    pool: &SqlitePool,
    session: &Session,
    current_password: Option<&str>,
    new_pin: &str,
) -> Result<(), DomainError> {
    if session.must_change_password() {
        return Err(DomainError::PasswordChangeRequired);
    }
    session.authorize(Permission::ChangeOwnPassword)?;
    let verifier = verifier_for(new_pin)?;
    let now = Timestamp::now();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let user = user_repo::find_by_id(&mut conn, session.user_id())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::UserNotFound)?;
    let existing = credential_repo::pin_verifier(&mut conn, user.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::AccountDataIntegrityError)?;
    let first = existing.is_none();

    if !first {
        let proven = current_password
            .map(|password| crypto::verify_password(password, user.verifier.expose()))
            .unwrap_or(false);
        if !proven {
            let _ = audit::append(
                &mut conn,
                user.id,
                audit::event::LOGIN_FAILED,
                now,
                Some(r#"{"reason":"current_password_mismatch","for":"pin_change"}"#.to_string()),
            )
            .await;
            return Err(DomainError::InvalidCredentials);
        }
    }
    drop(conn);

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    let changed = credential_repo::set_pin_verifier(&mut tx, user.id, &verifier)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if changed != 1 {
        return Err(DomainError::AccountDataIntegrityError);
    }
    // ADR-017 §3: a new PIN withdraws every approval the old one granted.
    session_repo::clear_approvals_granted_by(&mut tx, user.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        user.id,
        audit::event::PIN_SET,
        now,
        Some(format!(r#"{{"first":{first}}}"#)),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// A manager sets an account's PIN (ADR-017 §1): a new seller's first PIN, or a
/// replacement for one that was forgotten or seen.
///
/// `ManageUsers` already demands the manager's freshly proven password, so no
/// second check is made here. The target's sessions end, so a PIN that may have
/// been seen is not left behind on a running session — except when the manager
/// sets their own, which would only sign them out.
pub async fn manager_set_pin(
    pool: &SqlitePool,
    session: &Session,
    target: UserId,
    pin: &str,
) -> Result<(), DomainError> {
    session.authorize(Permission::ManageUsers)?;
    let verifier = verifier_for(pin)?;
    let now = Timestamp::now();
    let actor = session.user_id();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    user_repo::find_by_id(&mut conn, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::UserNotFound)?;
    // A PIN is the secret that used to be reachable on the open row: the till
    // operator is a manager, so `target == actor` passed every other gate and four
    // digits typed at the counter would have gone on opening the owner's account
    // after they made it (`ADR-039`). Refused here, and wiped by the claim in case
    // a value is ever planted some other way.
    open_mode::ensure_is_account(&mut conn, target).await?;
    drop(conn);

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    let changed = credential_repo::set_pin_verifier(&mut tx, target, &verifier)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if changed != 1 {
        return Err(DomainError::AccountDataIntegrityError);
    }
    // ADR-017 §3: a new PIN withdraws every approval the old one granted.
    session_repo::clear_approvals_granted_by(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let revoked = if target == actor {
        0
    } else {
        session_repo::delete_by_user(&mut tx, target)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?
    };
    audit::append(
        &mut tx,
        actor,
        audit::event::PIN_SET_BY_MANAGER,
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

/// The ids of the accounts that have a PIN, for the sign-in picker's `hasPin`.
/// Only the fact leaves this function, never a verifier.
pub async fn pin_holders(pool: &SqlitePool) -> Result<HashSet<String>, DomainError> {
    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let ids = credential_repo::users_with_pin(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(ids.into_iter().collect())
}
