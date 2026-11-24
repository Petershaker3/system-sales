//! The owner's recovery code (ADR-017 §4; the owner's choice, ADR-016 #32):
//! make one, say when it was made, and replace a forgotten password with it.
//!
//! The code is shown once — when it is made — and only its Argon2id verifier
//! is kept. Using it replaces the password, clears the lockout, ends every
//! session and burns the code: a new one is drawn and shown once, so the paper
//! in the drawer is never good twice.
//!
//! A wrong code counts against the same lockout as a wrong password or PIN.
//! A locked account may still use its code — the code is the way out of a
//! lockout, and its ~99 bits need no lockout to stay unguessable — and a right
//! code clears the lock.

use sqlx::{SqliteConnection, SqlitePool};

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::{
    group_recovery_code, normalize_recovery_code, password_is_acceptable,
    register_failure, register_success, CredentialVerifier, DomainError, LockoutState, Permission,
    Role, Session, Timestamp, UserId,
};
use crate::services::identity::crypto;
use crate::services::identity::secure_store::SecureTokenStore;

/// A freshly drawn code and its verifier.
fn fresh_code() -> Result<(String, String), DomainError> {
    // No randomness means no code, never a weak one: the same refusal a
    // session token gets when the OS generator is unavailable.
    let code =
        crypto::generate_recovery_code().map_err(|_| DomainError::SecureStorageUnavailable)?;
    let verifier = crypto::hash_password(&code).map_err(|_| DomainError::StorageUnavailable)?;
    Ok((code, verifier))
}

/// Who may hold a recovery code: a manager — a seller who forgets a password
/// asks the owner — on a session not waiting for a forced password change.
fn require_code_holder(session: &Session) -> Result<(), DomainError> {
    if session.role() != Role::Manager {
        return Err(DomainError::PermissionDenied);
    }
    if session.must_change_password() {
        return Err(DomainError::PasswordChangeRequired);
    }
    session.authorize(Permission::ChangeOwnPassword)
}

/// Make a new recovery code for the signed-in manager, replacing any earlier
/// one, and return it grouped, to be written down — the only time it is ever
/// shown.
///
/// The current password is proven in the same call, as changing a PIN does:
/// an open session alone must not be enough to mint the way back into the
/// owner's account. A wrong password is audited and, like the other
/// in-session re-proofs, not counted against the lockout.
pub async fn create_recovery_code(
    pool: &SqlitePool,
    session: &Session,
    current_password: &str,
) -> Result<String, DomainError> {
    require_code_holder(session)?;
    let now = Timestamp::now();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let user = user_repo::find_by_id(&mut conn, session.user_id())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::UserNotFound)?;
    if !crypto::verify_password(current_password, user.verifier.expose()) {
        let _ = audit::append(
            &mut conn,
            user.id,
            audit::event::LOGIN_FAILED,
            now,
            Some(r#"{"reason":"current_password_mismatch","for":"recovery_code"}"#.to_string()),
        )
        .await;
        return Err(DomainError::InvalidCredentials);
    }
    let first = credential_repo::recovery_verifier(&mut conn, user.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::AccountDataIntegrityError)?
        .is_none();
    // Released before the transaction: a single-connection pool would
    // otherwise deadlock (the in-memory test database is one).
    drop(conn);

    let (code, verifier) = fresh_code()?;
    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    let changed = credential_repo::set_recovery_verifier(&mut tx, user.id, &verifier, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if changed != 1 {
        return Err(DomainError::AccountDataIntegrityError);
    }
    audit::append(
        &mut tx,
        user.id,
        audit::event::RECOVERY_CODE_CREATED,
        now,
        Some(format!(r#"{{"first":{first}}}"#)),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(group_recovery_code(&code))
}

/// When the signed-in manager's current recovery code was made, or `None`
/// while there is none — so the settings can say so and offer to make one.
pub async fn recovery_code_status(
    pool: &SqlitePool,
    session: &Session,
) -> Result<Option<Timestamp>, DomainError> {
    require_code_holder(session)?;
    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let created = credential_repo::recovery_created_at(&mut conn, session.user_id())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::AccountDataIntegrityError)?;
    Ok(created.map(Timestamp::from_millis))
}

/// Replace a forgotten password with the recovery code, without a session,
/// and return the new code grouped — shown once.
///
/// In order: the new password must meet the policy before anything else, so a
/// weak one costs no attempt; then the account — a disabled one is refused, a
/// locked one is not (see the module note); then the code. A wrong code
/// advances the shared lockout and is audited. A right one, in one
/// transaction: the new password, no forced change, a cleared lockout, every
/// session ended, and a new code in place of the old.
pub async fn recover_password_with_code(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    user_id: UserId,
    code: &str,
    new_password: &str,
) -> Result<String, DomainError> {
    if !password_is_acceptable(new_password) {
        return Err(DomainError::WeakPassword);
    }
    let now = Timestamp::now();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let user = match user_repo::find_by_id(&mut conn, user_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        Some(user) => user,
        None => {
            // The same Argon2 work and answer as a wrong code.
            let _ = crypto::verify_password(code, crypto::dummy_verifier());
            refused(&mut conn, None, "no_such_user", None, now).await;
            return Err(DomainError::InvalidCredentials);
        }
    };
    if user_repo::find_disabled_at(&mut conn, user.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .flatten()
        .is_some()
    {
        refused(&mut conn, Some(user.id), "disabled", None, now).await;
        return Err(DomainError::AccountDisabled);
    }
    // Not refused when locked: a wrong code extends the lock like any wrong
    // secret, a right one is the way out of it.
    let state = LockoutState {
        failed_attempts: user.failed_attempts,
        locked_until: user.locked_until,
    };
    let stored = match credential_repo::recovery_verifier(&mut conn, user.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        Some(Some(verifier)) => verifier,
        Some(None) => {
            refused(&mut conn, Some(user.id), "no_code", None, now).await;
            return Err(DomainError::RecoveryCodeNotSet);
        }
        None => return Err(DomainError::AccountDataIntegrityError),
    };

    // Text that cannot be a code is a wrong code, after the same Argon2 work.
    let verified = match normalize_recovery_code(code) {
        Some(normalized) => crypto::verify_password(&normalized, &stored),
        None => {
            let _ = crypto::verify_password(code, crypto::dummy_verifier());
            false
        }
    };
    if !verified {
        let transition = register_failure(&state, now);
        user_repo::update_lockout(
            &mut conn,
            user.id,
            transition.failed_attempts,
            transition.locked_until,
            now,
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
        refused(
            &mut conn,
            Some(user.id),
            "bad_code",
            Some(transition.failed_attempts),
            now,
        )
        .await;
        if transition.just_locked {
            let _ = audit::append(
                &mut conn,
                user.id,
                audit::event::ACCOUNT_LOCKED,
                now,
                Some(r#"{"reason":"too_many_failed_attempts"}"#.to_string()),
            )
            .await;
        }
        return Err(DomainError::InvalidCredentials);
    }
    drop(conn);

    let password_verifier = CredentialVerifier::from_phc(
        crypto::hash_password(new_password).map_err(|_| DomainError::StorageUnavailable)?,
    )?;
    let (next_code, next_verifier) = fresh_code()?;
    let cleared = register_success();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    user_repo::update_verifier(&mut tx, user.id, &password_verifier, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    credential_repo::set_must_change_password(&mut tx, user.id, false)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    user_repo::update_lockout(
        &mut tx,
        user.id,
        cleared.failed_attempts,
        cleared.locked_until,
        now,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    // Every session on the device ends: whoever held one signs in again, with
    // the new password or a PIN.
    session_repo::delete_all(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let replaced = credential_repo::set_recovery_verifier(&mut tx, user.id, &next_verifier, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if replaced != 1 {
        return Err(DomainError::AccountDataIntegrityError);
    }
    audit::append(
        &mut tx,
        user.id,
        audit::event::PASSWORD_RECOVERED_WITH_CODE,
        now,
        Some(r#"{"sessions_ended":true,"code_replaced":true}"#.to_string()),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // Whatever token this device still holds names no session any more.
    let _ = tokens.clear();
    Ok(group_recovery_code(&next_code))
}

/// Record a refused recovery attempt. Best effort, as every refusal audit is.
async fn refused(
    conn: &mut SqliteConnection,
    user: Option<UserId>,
    reason: &str,
    failed_attempts: Option<i32>,
    now: Timestamp,
) {
    let detail = match failed_attempts {
        Some(count) => format!(r#"{{"reason":"{reason}","failed_attempts":{count}}}"#),
        None => format!(r#"{{"reason":"{reason}"}}"#),
    };
    let _ = audit::append_for(
        conn,
        user,
        audit::event::RECOVERY_CODE_FAILED,
        now,
        Some(detail),
    )
    .await;
}
