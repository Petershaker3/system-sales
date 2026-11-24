//! The owner's PIN approval for one sensitive operation (ADR-017 §3).
//!
//! [`approve_with_owner_pin`] stamps an approval on the current session. The
//! sensitive operation then spends it with [`consume_in_tx`], inside its own
//! transaction. In between, `Session::require_sensitivity` decides whether the
//! approval is still fresh.
//!
//! The approver is checked the way a sign-in is, because entering the PIN *is*
//! a sign-in for one operation: disabled before locked, locked before anything
//! is hashed, and a wrong PIN advances the approver's own failure counter —
//! the one their password and sign-in PIN already share — so the approval
//! prompt is no side door around the lockout.

use sqlx::{SqliteConnection, SqlitePool};

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::{
    is_locked, register_failure, register_success, DomainError, LockoutState, OwnerApproval,
    Role, Session, Timestamp, UserId,
};
use crate::services::identity::crypto;
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

/// Approve one sensitive operation on the current session with a manager's PIN.
///
/// Any signed-in session may ask — a seller's included, which is the point —
/// but only an active manager's PIN answers. The owner's own session asks too.
///
/// Refusals, each audited as `owner_approval_failed`:
///
/// * `INVALID_CREDENTIALS` — a wrong PIN (counted against the approver), or an
///   approver id that names nobody;
/// * `PERMISSION_DENIED` — the approver is not a manager;
/// * `ACCOUNT_DISABLED`, `ACCOUNT_TEMPORARILY_LOCKED`, `PIN_NOT_SET` — this
///   approver cannot approve right now, and the prompt says why.
///
/// On success the approval replaces any earlier unspent one on the session,
/// the approver's failure counter is cleared, and `owner_approval_granted` is
/// written in the same transaction as the stamp.
pub async fn approve_with_owner_pin(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    approver_id: UserId,
    pin: &str,
) -> Result<(), DomainError> {
    let session = identity_session::resolve(pool, tokens).await?;
    let token = tokens
        .get()
        .map_err(|_| DomainError::SecureStorageUnavailable)?
        .ok_or(DomainError::SessionNotFound)?;
    let token_hash = crypto::hash_token(&token);
    let operator = session.user_id();
    let now = Timestamp::now();

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let approver = match user_repo::find_by_id(&mut conn, approver_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        Some(user) => user,
        None => {
            // The same Argon2 work and the same answer as a wrong PIN, so the
            // response time does not tell which identifiers are real.
            let _ = crypto::verify_password(pin, crypto::dummy_verifier());
            refused(&mut conn, None, operator, "no_such_user", None, now).await;
            return Err(DomainError::InvalidCredentials);
        }
    };

    if approver.role != Role::Manager {
        refused(&mut conn, Some(approver.id), operator, "not_a_manager", None, now).await;
        return Err(DomainError::PermissionDenied);
    }
    if user_repo::find_disabled_at(&mut conn, approver.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .flatten()
        .is_some()
    {
        refused(&mut conn, Some(approver.id), operator, "disabled", None, now).await;
        return Err(DomainError::AccountDisabled);
    }
    let state = LockoutState {
        failed_attempts: approver.failed_attempts,
        locked_until: approver.locked_until,
    };
    if is_locked(&state, now) {
        refused(&mut conn, Some(approver.id), operator, "locked", None, now).await;
        return Err(DomainError::AccountLocked);
    }
    let verifier = match credential_repo::pin_verifier(&mut conn, approver.id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        Some(Some(verifier)) => verifier,
        Some(None) => {
            refused(&mut conn, Some(approver.id), operator, "no_pin", None, now).await;
            return Err(DomainError::PinNotSet);
        }
        // No credentials row at all: the integrity refusal sign-in gives too,
        // never a fabricated "no PIN".
        None => return Err(DomainError::AccountDataIntegrityError),
    };

    if !crypto::verify_password(pin, &verifier) {
        let transition = register_failure(&state, now);
        user_repo::update_lockout(
            &mut conn,
            approver.id,
            transition.failed_attempts,
            transition.locked_until,
            now,
        )
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
        refused(
            &mut conn,
            Some(approver.id),
            operator,
            "bad_pin",
            Some(transition.failed_attempts),
            now,
        )
        .await;
        if transition.just_locked {
            let _ = audit::append(
                &mut conn,
                approver.id,
                audit::event::ACCOUNT_LOCKED,
                now,
                Some(r#"{"reason":"too_many_failed_attempts"}"#.to_string()),
            )
            .await;
        }
        return Err(DomainError::InvalidCredentials);
    }

    // Release the pooled connection before opening a transaction: holding one
    // while asking the pool for another deadlocks a single-connection pool,
    // which is how the in-memory test database is configured.
    drop(conn);
    let approval = OwnerApproval::granted(approver.id, now);
    let cleared = register_success();
    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;
    user_repo::update_lockout(
        &mut tx,
        approver.id,
        cleared.failed_attempts,
        cleared.locked_until,
        now,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    let stamped = session_repo::set_owner_approval(&mut tx, &token_hash, &approval)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if stamped != 1 {
        // The session row vanished between resolving it and stamping it (a
        // sign-in elsewhere ended it): there is nothing to approve on.
        return Err(DomainError::SessionNotFound);
    }
    audit::append(
        &mut tx,
        approver.id,
        audit::event::OWNER_APPROVAL_GRANTED,
        now,
        Some(format!(
            r#"{{"approver":"{}","for":"{}"}}"#,
            approver.id, operator
        )),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// Spend the approval a sensitive operation was authorized with, inside that
/// operation's own transaction, and return who approved it.
///
/// `None` — routine work — passes through untouched. `Some` must still be on
/// the session row, unspent, from a manager who is still active and still
/// holds a PIN. Otherwise the operation is refused with
/// `OWNER_APPROVAL_REQUIRED`, and because the caller's transaction then rolls
/// back, nothing of the operation is written either.
pub async fn consume_in_tx(
    conn: &mut SqliteConnection,
    session: &Session,
    approval: Option<OwnerApproval>,
) -> Result<Option<UserId>, DomainError> {
    let Some(approval) = approval else {
        return Ok(None);
    };
    if session.is_open_mode() {
        // The approval an open session carries was minted by the domain from the
        // session itself, and there is no session row to clear (`ADR-039`) — the
        // shop has no account yet, so nobody spent anything by approving. The
        // approver named here is the open row, which is what the audit reads.
        return Ok(Some(approval.approved_by()));
    }
    let spent = session_repo::consume_owner_approval(conn, session.user_id(), &approval)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    if spent {
        Ok(Some(approval.approved_by()))
    } else {
        Err(DomainError::OwnerApprovalRequired)
    }
}

/// Record a refused approval. Best effort, as every refusal audit is: the
/// refusal itself must reach the operator even if the audit write fails.
async fn refused(
    conn: &mut SqliteConnection,
    approver: Option<UserId>,
    operator: UserId,
    reason: &str,
    failed_attempts: Option<i32>,
    now: Timestamp,
) {
    let detail = match failed_attempts {
        Some(count) => format!(
            r#"{{"reason":"{reason}","for":"{operator}","failed_attempts":{count}}}"#
        ),
        None => format!(r#"{{"reason":"{reason}","for":"{operator}"}}"#),
    };
    let _ = audit::append_for(
        conn,
        approver,
        audit::event::OWNER_APPROVAL_FAILED,
        now,
        Some(detail),
    )
    .await;
}
