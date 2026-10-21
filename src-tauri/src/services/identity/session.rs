//! Session lifecycle: resolve the stored token, keep it alive, and re-prove a
//! password when a higher assurance level is needed.
//!
//! This is the only place the OS credential store is read on the hot path, and
//! its result never leaves the process.

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::DomainError;
use crate::domain::identity::{Assurance, Session, Timestamp};
use crate::services::identity::crypto;
use crate::services::identity::open_mode;
use crate::services::identity::secure_store::SecureTokenStore;

/// Resolve the current session.
///
/// Reads the token from the OS credential store, looks up its digest, and asks
/// the domain to validate the result. A token that is present but stale produces
/// the same errors as no token at all; callers cannot tell the difference, and
/// neither can an attacker.
///
/// The idle timer is restarted only after the session has been shown to be
/// valid, so an expired session cannot be kept alive by retrying.
///
/// # The one case with no token: a shop that has no account yet
///
/// A shop that has not claimed an account has nothing to sign in *with*
/// (`ADR-039`), so a failed credential lookup is the expected state rather than a
/// refusal. This is the single place that decides it, for the whole application:
/// every command resolves its operator here, so opening the till without an
/// account is one rule read once — not a `skip the check` branch at seventy call
/// sites, which is how a bypass becomes permanent. When the account is claimed the
/// open row is gone, [`open_mode::session`] answers `None`, and a device with
/// accounts behaves exactly as it did before.
pub async fn resolve(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, DomainError> {
    match resolve_signed_in(pool, tokens).await {
        Ok(session) => Ok(session),
        // The open answer is itself a read of the database. When that read fails
        // too, what the operator is facing is still the first failure, and
        // reporting the second one would send a technician to the wrong door.
        Err(error) => match open_mode::session(pool).await {
            Ok(Some(session)) => Ok(session),
            _ => Err(error),
        },
    }
}

/// The token path: credential store, then the session row, then the domain.
///
/// Split out so [`resolve`] can add exactly one alternative answer without
/// changing anything this function proves. It is private for the same reason the
/// credential store is: no caller may pick which of the two paths it is on.
async fn resolve_signed_in(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, DomainError> {
    let token = tokens.get().map_err(|_| DomainError::SecureStorageUnavailable)?;
    let token = token.ok_or(DomainError::SessionNotFound)?;

    let token_hash = crypto::hash_token(&token);
    let now = Timestamp::now();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    let row = session_repo::find_by_token_hash(&mut conn, &token_hash)
        .await
        .map_err(|_| DomainError::SessionNotFound)?
        .ok_or(DomainError::SessionNotFound)?;

    // Domain validates expiry and mints the Session. `Session` has no public
    // constructor, so [`Session::open`] is the only way to obtain one — here from
    // the row, and in `open_mode` from the open owner row.
    let session = Session::open(row.facts, now)?;

    session_repo::touch(&mut conn, &token_hash, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    Ok(session)
}

/// Lower the stored session back to `Normal`.
///
/// Used after a self-service operation completes. `Reauthenticated` records that a
/// password was freshly proven; leaving it set would let that elevation apply to
/// later, unrelated commands, so it is deliberately dropped once the operation it
/// authorised has finished.
pub async fn downgrade_to_normal(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Assurance, DomainError> {
    let token = tokens
        .get()
        .map_err(|_| DomainError::SecureStorageUnavailable)?
        .ok_or(DomainError::SessionNotFound)?;
    let token_hash = crypto::hash_token(&token);

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    session_repo::set_assurance(&mut conn, &token_hash, Assurance::Normal)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(Assurance::Normal)
}

/// Raise the session to `Reauthenticated` after the password is re-entered.
///
/// `plan:151` requires this before wholesale data is revealed and before user
/// administration runs. `Permission::requires_reauthenticated` decides which
/// capabilities need it, so this function does not care which they are.
pub async fn reauthenticate(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    password: &str,
) -> Result<Assurance, DomainError> {
    let session = resolve(pool, tokens).await?;

    if session.is_open_mode() {
        // Nothing to prove: an open shop has no password yet, and the assurance the
        // re-entry exists to grant is the level the open session already holds
        // (`ADR-039`). Answering with a refusal would leave the settings and the
        // user list unreachable on the one device where there is no secret to
        // forget, so the elevation is confirmed rather than demanded.
        return Ok(session.assurance());
    }

    let token = tokens
        .get()
        .map_err(|_| DomainError::SecureStorageUnavailable)?
        .ok_or(DomainError::SessionNotFound)?;
    let token_hash = crypto::hash_token(&token);

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;

    let user = user_repo::find_by_id(&mut conn, session.user_id())
        .await
        .map_err(|_| DomainError::InvalidCredentials)?
        // Report the same error for a missing account as for a wrong password.
        .ok_or(DomainError::InvalidCredentials)?;

    if !crypto::verify_password(password, user.verifier.expose()) {
        // A wrong password during re-authentication does not lock the account:
        // the account is already authenticated, and the OS credential store plus
        // the fifteen-minute lockout are the brute-force controls. Counting these
        // would let anyone walk a legitimate session into a lockout.
        let _ = audit::append(
            &mut conn,
            user.id,
            audit::event::LOGIN_FAILED,
            Timestamp::now(),
            Some(r#"{"reason":"reauth_failed"}"#.to_string()),
        )
        .await;
        return Err(DomainError::InvalidCredentials);
    }

    session_repo::set_assurance(&mut conn, &token_hash, Assurance::Reauthenticated)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let _ = audit::append(
        &mut conn,
        user.id,
        audit::event::REAUTHENTICATED,
        Timestamp::now(),
        None,
    )
    .await;

    Ok(Assurance::Reauthenticated)
}

/// Describe the current operator, or `None` when nobody is signed in.
///
/// `Session` deliberately carries only the identity needed for authorisation,
/// not presentation data, so the display name is read from `users` here. That
/// also means a rename takes effect on the next call rather than lingering in a
/// session record.
pub async fn describe(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Option<crate::services::identity::auth::AuthenticatedUser>, DomainError> {
    let resolved = match resolve(pool, tokens).await {
        Ok(session) => session,
        Err(error) => return Err(error),
    };

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let user = user_repo::find_by_id(&mut conn, resolved.user_id())
        .await
        .map_err(|_| DomainError::SessionNotFound)?
        .ok_or(DomainError::SessionNotFound)?;

    Ok(Some(crate::services::identity::auth::AuthenticatedUser {
        user_id: user.id,
        display_name: user.display_name,
        // The role on the session was resolved from `users` when the session row
        // was read, so it is the authoritative one, not a cached copy.
        role: resolved.role(),
        assurance: resolved.assurance(),
    }))
}

/// Drop sessions that can no longer be used, and report how many went.
///
/// Called at startup so a device that was off overnight does not accumulate
/// dead rows.
pub async fn purge_expired(pool: &SqlitePool) -> Result<u64, DomainError> {
    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    session_repo::delete_expired(&mut conn, Timestamp::now())
        .await
        .map_err(|_| DomainError::SessionNotFound)
}