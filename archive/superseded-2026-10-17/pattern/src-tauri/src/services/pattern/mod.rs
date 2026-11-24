//! Pattern approval use cases (SP-1b, `plan` Task 9): `is_enabled`,
//! `is_configured`, `status`, `set`, `verify`, `reset`, `disable`.
//!
//! The Pattern is a second, per-operation approval beyond assurance
//! (`ADR-014`). What is stored is only an Argon2id verifier and an epoch —
//! never the Pattern text — and a successful verification stamps the *session
//! row* with `(approved_at, epoch)` rather than granting anything durable:
//! the approval expires in five minutes and dies whenever the epoch moves.
//!
//! # Two error families, one vocabulary
//!
//! Failures here are identity failures with existing codes: a wrong Pattern is
//! `INVALID_CREDENTIALS`, an unconfigured one is `PATTERN_NOT_CONFIGURED`,
//! policy refusal is `PASSWORD_DOES_NOT_MEET_POLICY`. No new code is minted at
//! this layer.

use serde::Serialize;
use sqlx::SqlitePool;

use crate::data::repositories::identity::{audit, pattern as pattern_repo, session as session_repo, user as user_repo};
use crate::data::repositories::settings::app_settings as settings_repo;
use crate::domain::identity::{
    password_is_acceptable, DomainError, Permission, Session, Timestamp,
};
use crate::domain::settings::PATTERN_REQUIRED;
use crate::services::identity::crypto;
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// What the panel needs to render: whether protection is on, and whether a
/// Pattern exists to check against.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternStatus {
    pub enabled: bool,
    pub configured: bool,
}

/// Resolve the current operator. Verification itself needs no extra
/// permission: the prompt appears for whoever is operating, and the Pattern —
/// not the role — is what the sensitive operation demands.
async fn resolve_session(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<Session, DomainError> {
    identity_session::resolve(pool, tokens).await
}

/// Whether Pattern protection is switched on for this device.
///
/// Pool-only on purpose: an internal caller (a future sensitive operation
/// deciding whether to prompt) must be able to ask without holding a session,
/// and the answer is device configuration, not operator data.
pub async fn is_enabled(pool: &SqlitePool) -> Result<bool, DomainError> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let value = settings_repo::get(&mut conn, PATTERN_REQUIRED)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(value.as_deref() == Some("1"))
}

/// Whether a Pattern has ever been configured (a verifier row exists).
///
/// Distinct from [`is_enabled`] on purpose: protection can be on with no
/// Pattern yet, and that state must fail closed as `PATTERN_NOT_CONFIGURED`
/// rather than read as "off".
pub async fn is_configured(pool: &SqlitePool) -> Result<bool, DomainError> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let stored = pattern_repo::find(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(stored.is_some())
}

/// The epoch a Pattern approval must be stamped against to count as fresh.
///
/// `None` when no Pattern exists, which is exactly what
/// `Session::require_sensitivity` turns into `PATTERN_NOT_CONFIGURED`. That is
/// why this returns an `Option` rather than a default: a fabricated `0` would
/// make an approval granted under no Pattern look current.
///
/// Pool-only for the same reason as [`is_enabled`]: the first caller is a
/// sensitive operation deciding whether to prompt, and it asks before it has
/// decided anything else about the operator.
pub async fn current_epoch(pool: &SqlitePool) -> Result<Option<i64>, DomainError> {
    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let stored = pattern_repo::find(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(stored.map(|stored| stored.epoch))
}

/// Both facts in one command round-trip for the settings panel.
pub async fn status(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<PatternStatus, DomainError> {
    resolve_session(pool, tokens).await?;
    Ok(PatternStatus {
        enabled: is_enabled(pool).await?,
        configured: is_configured(pool).await?,
    })
}

/// Set (or replace) the Pattern and switch protection on.
///
/// One transaction does three things together: upserts the verifier (which
/// **advances the epoch**, invalidating every outstanding approval), writes
/// `pattern_required = 1`, and appends `PATTERN_SET`. Any other ordering
/// leaves a window where the new verifier exists with protection still off,
/// or protection on with no audit of who turned it on.
///
/// The Pattern must satisfy the ordinary password policy: it is a secret that
/// guards sensitive operations, and an empty or trivially short one would make
/// the whole mechanism decorative.
pub async fn set(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    pattern: &str,
) -> Result<(), DomainError> {
    let session = resolve_session(pool, tokens).await?;
    session.authorize(Permission::ManageSettings)?;

    if !password_is_acceptable(pattern) {
        return Err(DomainError::WeakPassword);
    }
    let verifier = crypto::hash_password(pattern).map_err(|_| DomainError::InvalidCredentials)?;

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let epoch = pattern_repo::set(&mut tx, &verifier, &actor.as_str(), now.as_millis())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    settings_repo::set(
        &mut tx,
        PATTERN_REQUIRED,
        "1",
        &actor.as_str(),
        now.as_millis(),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        actor,
        audit::event::PATTERN_SET,
        now,
        Some(serde_json::json!({ "epoch": epoch }).to_string()),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// Check an entered Pattern and stamp this session's approval.
///
/// Modelled on `services::identity::session::reauthenticate`: the token comes
/// from the OS credential store (never from a parameter), the failure code for
/// a wrong Pattern is the ordinary `INVALID_CREDENTIALS` — a wrong secret is a
/// wrong secret — and there is deliberately **no audit event** for success or
/// failure (`plan` Task 7): a successful entry changes no state beyond a
/// five-minute stamp, and logging every prompt trains a reader to skip the
/// log.
///
/// On success the session row records `(approved_at, current epoch)`. Both
/// together are what `Session::require_sensitivity` checks: a later set,
/// change or reset moves the epoch and the stamp compares unequal, and five
/// minutes after `approved_at` it is stale regardless.
pub async fn verify(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    pattern: &str,
) -> Result<(), DomainError> {
    resolve_session(pool, tokens).await?;

    let token = tokens
        .get()
        .map_err(|_| DomainError::SecureStorageUnavailable)?
        .ok_or(DomainError::SessionNotFound)?;
    let token_hash = crypto::hash_token(&token);

    let mut conn = pool
        .acquire()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let stored = pattern_repo::find(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::PatternNotConfigured)?;

    if !crypto::verify_password(pattern, &stored.verifier) {
        return Err(DomainError::InvalidCredentials);
    }

    session_repo::set_pattern_approval(&mut conn, &token_hash, Timestamp::now(), stored.epoch)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// Clear the Pattern after the Manager password is re-proved.
///
/// Precedent: `change_own_password` — the secret that guards the recovery
/// itself must be entered fresh, so a walk-away unlocked device cannot erase
/// the Pattern. The row is deleted, not blanked: afterwards `is_configured`
/// reads `false` and a sensitive operation fails closed as
/// `PATTERN_NOT_CONFIGURED` until a new Pattern is set. An approval written
/// before the reset compares unequal right away, because deletion makes the
/// current epoch unknown rather than merely older.
pub async fn reset(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    password: &str,
) -> Result<(), DomainError> {
    let session = resolve_session(pool, tokens).await?;
    session.authorize(Permission::ManageSettings)?;

    let now = Timestamp::now();

    // Everything inside one transaction: the password check reads, the clear
    // and the audit write. A wrong password returns before anything is
    // written, and a mid-flight failure leaves neither a cleared Pattern nor
    // an event claiming one was cleared.
    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let user = user_repo::find_by_id(&mut tx, session.user_id())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::InvalidCredentials)?;
    if !crypto::verify_password(password, user.verifier.expose()) {
        // The same code as a wrong Pattern, for the same reason: a wrong
        // secret, and no lockout is risked here (re-authenticated Manager
        // session, OS credential store plus session expiry are the controls).
        return Err(DomainError::InvalidCredentials);
    }

    pattern_repo::clear(&mut tx)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(&mut tx, session.user_id(), audit::event::PATTERN_RESET, now, None)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// Switch Pattern protection off, keeping the stored Pattern.
///
/// Only the setting flips — deliberately *not* the verifier, so turning
/// protection off for a quiet afternoon does not also erase the Pattern and
/// force a re-proved set afterwards. A sensitive operation with protection off
/// simply does not ask; re-enabling asks again under the same epoch, and any
/// approval still inside its five-minute window would carry over — a
/// deliberate trade of a five-minute edge case for a recoverable off switch.
pub async fn disable(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<(), DomainError> {
    let session = resolve_session(pool, tokens).await?;
    session.authorize(Permission::ManageSettings)?;

    let now = Timestamp::now();
    let actor = session.user_id();

    let mut tx = pool
        .begin()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    settings_repo::set(
        &mut tx,
        PATTERN_REQUIRED,
        "0",
        &actor.as_str(),
        now.as_millis(),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        actor,
        audit::event::SETTING_CHANGED,
        now,
        Some(
            serde_json::json!({ "key": PATTERN_REQUIRED, "value": "0" }).to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}
