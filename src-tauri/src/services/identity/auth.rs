//! Authentication: verifying a credential and issuing a session.
//!
//! The whole file exists to get one property right: after it returns, Rust holds
//! the only usable copy of the session token, and nobody else does.

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::DomainError;
use crate::domain::identity::UserId;
use crate::domain::identity::{is_locked, register_failure, register_success, LockoutState};
use crate::domain::identity::Role;
use crate::domain::identity::{
    Assurance, SessionFacts, Timestamp, ABSOLUTE_LIFETIME_MS,
};
use crate::domain::identity::UserSummary;
use crate::services::identity::crypto;
use crate::services::identity::secure_store::SecureTokenStore;

/// The identity of the signed-in operator.
///
/// This is the only thing the frontend ever learns about a session. There is no
/// token field, because there is no token to hand over: it is already in the OS
/// credential store, and every later command resolves it internally.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticatedUser {
    pub user_id: UserId,
    pub display_name: String,
    pub role: Role,
    pub assurance: Assurance,
}

/// Accounts offered by the login picker.
///
/// Exposes id, display name and role only. No verifier, no counters, no lock
/// state: choosing a name from a list is not authorisation.
pub async fn list_users(pool: &SqlitePool) -> Result<Vec<UserSummary>, DomainError> {
    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let rows = user_repo::list_with_usernames(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // A `LEFT JOIN` means `username` can be absent. It is passed through as
    // `None` rather than defaulted or omitted, so the command layer can refuse to
    // project an account whose credentials row is missing instead of quietly
    // dropping it from the picker.
    Ok(rows
        .into_iter()
        .map(|row| {
            UserSummary::new(&row.user, row.username, row.disabled_at.is_some())
        })
        .collect())
}

/// Verify a credential and open a session.
///
/// Ordering matters and is deliberate:
///
/// 1. Resolve the account.
/// 2. Check the lockout window.
/// 3. Verify the password (or, for [`login_with_pin`], the PIN), always spending
///    the same work whether or not the account exists.
/// 4. Reset counters, then write the token to the OS credential store.
/// 5. Only then record the session row.
///
/// Writing the credential before the database row means a keyring failure
/// cannot leave a session row that no token can ever reach. If the database step
/// then fails, the credential is removed again so no orphan secret is left
/// behind. Both failures are fail-closed: the caller gets an error and there is
/// no usable session.
pub async fn login(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    user_id: UserId,
    password: &str,
) -> Result<AuthenticatedUser, DomainError> {
    sign_in(pool, tokens, user_id, SignInSecret::Password(password)).await
}

/// Sign in with the daily PIN (ADR-017 §2).
///
/// The same session, lockout, disabled-account and forced-change rules as
/// [`login`], because it is the same code path ([`sign_in`]). A wrong PIN counts
/// in the same failure counter as a wrong password: a lock is a lock. An account
/// with no PIN yet is refused with `PinNotSet` and nothing is counted.
pub async fn login_with_pin(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    user_id: UserId,
    pin: &str,
) -> Result<AuthenticatedUser, DomainError> {
    sign_in(pool, tokens, user_id, SignInSecret::Pin(pin)).await
}

/// The secret a sign-in proves.
#[derive(Clone, Copy)]
enum SignInSecret<'a> {
    Password(&'a str),
    Pin(&'a str),
}

impl<'a> SignInSecret<'a> {
    fn text(self) -> &'a str {
        match self {
            SignInSecret::Password(text) | SignInSecret::Pin(text) => text,
        }
    }

    /// The audit `reason` recorded for a wrong secret.
    fn failure_reason(self) -> &'static str {
        match self {
            SignInSecret::Password(_) => "bad_password",
            SignInSecret::Pin(_) => "bad_pin",
        }
    }
}

/// The one sign-in path behind [`login`] and [`login_with_pin`]; the steps are
/// listed on [`login`].
async fn sign_in(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    user_id: UserId,
    secret: SignInSecret<'_>,
) -> Result<AuthenticatedUser, DomainError> {
    let now = Timestamp::now();
    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    let user = match user_repo::find_by_id(&mut conn, user_id)
        .await
        .map_err(|_| DomainError::InvalidCredentials)?
    {
        Some(user) => user,
        None => {
            // Spend the same Argon2 work as a real check, then answer exactly as
            // a wrong password would. Without this, response time discloses
            // which identifiers are real.
            let _ = crypto::verify_password(secret.text(), crypto::dummy_verifier());
            let _ = audit::append_for(
                &mut conn,
                None,
                audit::event::LOGIN_FAILED,
                now,
                Some(r#"{"reason":"no_such_user"}"#.to_string()),
            )
            .await;
            return Err(DomainError::InvalidCredentials);
        }
    };

    // Checked before the lockout state so a disabled account reports "disabled"
    // rather than whatever its counter happens to say. Distinct errors on purpose:
    // a lockout expires in fifteen minutes on its own, a disable does not.
    if user_repo::find_disabled_at(&mut conn, user.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .flatten()
        .is_some()
    {
        let _ = audit::append_for(
            &mut conn,
            Some(user.id),
            audit::event::LOGIN_FAILED,
            now,
            Some(r#"{"reason":"disabled"}"#.to_string()),
        )
        .await;
        return Err(DomainError::AccountDisabled);
    }

    let state = LockoutState {
        failed_attempts: user.failed_attempts,
        locked_until: user.locked_until,
    };

    if is_locked(&state, now) {
        let _ = audit::append_for(
            &mut conn,
            Some(user.id),
            audit::event::LOGIN_FAILED,
            now,
            Some(r#"{"reason":"locked"}"#.to_string()),
        )
        .await;
        return Err(DomainError::AccountLocked);
    }

    let verified = match secret {
        SignInSecret::Password(password) => {
            crypto::verify_password(password, user.verifier.expose())
        }
        SignInSecret::Pin(pin) => {
            let stored = credential_repo::pin_verifier(&mut conn, user.id)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
            match stored {
                Some(Some(verifier)) => crypto::verify_password(pin, &verifier),
                Some(None) => {
                    let _ = audit::append(
                        &mut conn,
                        user.id,
                        audit::event::LOGIN_FAILED,
                        now,
                        Some(r#"{"reason":"no_pin"}"#.to_string()),
                    )
                    .await;
                    return Err(DomainError::PinNotSet);
                }
                // No credentials row at all: the same integrity refusal as the
                // forced-change read below, never a fabricated "no PIN".
                None => return Err(DomainError::AccountDataIntegrityError),
            }
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

        let _ = audit::append(
            &mut conn,
            user.id,
            audit::event::LOGIN_FAILED,
            now,
            Some(format!(
                r#"{{"reason":"{}","failed_attempts":{}}}"#,
                secret.failure_reason(),
                transition.failed_attempts
            )),
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

    // Correct password.
    let cleared = register_success();
    user_repo::update_lockout(&mut conn, user.id, cleared.failed_attempts, cleared.locked_until, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    // Fail-closed point: if the OS credential store cannot be reached, there is
    // no session. No fallback exists by design (ADR-009).
    let token = crypto::generate_token().map_err(|_| DomainError::SecureStorageUnavailable)?;
    tokens
        .put(&token)
        .map_err(|_| DomainError::SecureStorageUnavailable)?;

    let token_hash = crypto::hash_token(&token);
    // Account state is read here rather than assumed, so a session can never be
    // issued to a disabled account or minted without the forced-change flag the
    // permission gate depends on.
    let disabled_at = user_repo::find_disabled_at(&mut conn, user.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    // `None` means the account has no `user_credentials` row, which migration
    // `0003` guarantees for every account. Proceeding would mint a session that
    // bypasses the forced-change gate, so this is refused as an integrity failure
    // rather than defaulted to "no change needed". The token has already been placed
    // in the credential store, so it is removed again before returning.
    let must_change_password = match credential_repo::must_change_password(&mut conn, user.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        Some(value) => value,
        None => {
            let _ = tokens.clear();
            return Err(DomainError::AccountDataIntegrityError);
        }
    };

    let facts = SessionFacts {
        user_id: user.id,
        role: user.role,
        assurance: Assurance::Normal,
        issued_at: now,
        last_seen_at: now,
        absolute_expires_at: now.plus_millis(ABSOLUTE_LIFETIME_MS),
        must_change_password,
        disabled_at: disabled_at.flatten(),
        // A new session holds no owner approval. Signing in proves who the
        // operator is; the owner's PIN approves one sensitive action at a time.
        owner_approval: None,
        // A session reached by a password or a PIN belongs to an account, so it
        // is not the open operator: an open row has no credential to sign in with
        // (`ADR-039`).
        open_mode: false,
    };

    // Release the pooled connection before opening a transaction. Holding a
    // connection while asking the pool for another deadlocks a single-connection
    // pool, which is exactly how the in-memory test database is configured.
    drop(conn);

    let mut tx = match pool.begin().await {
        Ok(tx) => tx,
        Err(_) => {
            let _ = tokens.clear();
            return Err(DomainError::SessionNotFound);
        }
    };

    // One operator at a time: signing in ends any previous session.
    if session_repo::delete_all(&mut tx).await.is_err()
        || session_repo::insert(&mut tx, &token_hash, &facts).await.is_err()
    {
        drop(tx);
        let _ = tokens.clear();
        return Err(DomainError::SessionNotFound);
    }

    if audit::append(
        &mut tx,
        user.id,
        audit::event::LOGIN_SUCCEEDED,
        now,
        Some(match secret {
            SignInSecret::Password(_) => format!(r#"{{"role":"{}"}}"#, user.role.as_str()),
            SignInSecret::Pin(_) => {
                format!(r#"{{"role":"{}","method":"pin"}}"#, user.role.as_str())
            }
        }),
    )
    .await
    .is_err()
    {
        drop(tx);
        let _ = tokens.clear();
        return Err(DomainError::SessionNotFound);
    }

    if tx.commit().await.is_err() {
        let _ = tokens.clear();
        return Err(DomainError::SessionNotFound);
    }

    Ok(AuthenticatedUser {
        user_id: user.id,
        display_name: user.display_name.clone(),
        role: user.role,
        assurance: Assurance::Normal,
    })
}

/// End the current session: remove the credential and the row together.
pub async fn logout(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<(), DomainError> {
    // Read the token first so the row can be matched. A missing credential is
    // not an error: the desired end state is "signed out".
    let token = tokens.get().map_err(|_| DomainError::SecureStorageUnavailable)?;

    if let Some(token) = token {
        let token_hash = crypto::hash_token(&token);
        let mut conn = pool.acquire().await.map_err(|_| DomainError::SecureStorageUnavailable)?;

        // Audit against the session's user before deleting it.
        if let Ok(Some(row)) = session_repo::find_by_token_hash(&mut conn, &token_hash).await {
            let _ = audit::append(
                &mut conn,
                row.facts.user_id,
                audit::event::LOGOUT,
                Timestamp::now(),
                None,
            )
            .await;
            let _ = session_repo::delete_by_token_hash(&mut conn, &token_hash).await;
        }
    }

    tokens.clear().map_err(|_| DomainError::SecureStorageUnavailable)?;
    Ok(())
}