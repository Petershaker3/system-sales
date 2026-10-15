//! One-time supervised manager-password recovery (plan R1, Design B).
//!
//! Recovery builds only: this module is compiled only with
//! `--features recovery`. Production builds contain no recovery path at all,
//! which an architecture test pins by enumerating the registered commands
//! with and without the flag.
//!
//! # Honesty note
//!
//! Resetting a password without the old one is a bypass by construction. It
//! is contained, not disguised: the call itself is the supervised owner act
//! (the owner types the new password under supervision after explicit
//! approval), the approval row binds reference + device + target + reason,
//! consumption is atomic with the verifier write (at-most-once even across a
//! crash), every step is audited, old sessions die, and the build carrying
//! this module is replaced by a clean one immediately after use (R1-T7).

//! Whole-module gate: this file compiles only in recovery builds. The module
//! declaration in `services/identity/mod.rs` carries the same gate, so
//! removing either breaks the build loudly.
#![cfg(feature = "recovery")]

use sqlx::SqlitePool;

use crate::data::repositories::identity::audit;
use crate::data::repositories::identity::credentials as credential_repo;
use crate::data::repositories::identity::pattern as pattern_repo;
use crate::data::repositories::identity::recovery as recovery_repo;
use crate::data::repositories::identity::session as session_repo;
use crate::data::repositories::identity::user as user_repo;
use crate::domain::identity::{
    password_is_acceptable, recovery_delay_ms, CredentialVerifier, DomainError, Role, Timestamp,
    UserId, RECOVERY_MAX_DELAY_MS,
};
use crate::services::identity::crypto;

/// Mint a reservation token. Only used to correlate an admitted attempt with
/// the write that records its outcome; it carries no secret and grants nothing
/// on its own.
fn reservation_token() -> String {
    UserId::generate().as_str()
}

/// Claim the right to attempt one Pattern check, or refuse as throttled.
///
/// The delay is computed and enforced HERE, before any Argon2 work, so a rapid
/// re-invocation of the command cannot turn into a stream of guesses. The claim
/// is a compare-and-swap on the state the delay was derived from, which is what
/// makes it hold under concurrency: of two simultaneous callers exactly one
/// is admitted and the other is refused as throttled without hashing.
///
/// A failed reservation is not retried in a loop. It means either the cooldown
/// is still running or another attempt is in flight, and both are answered by
/// the same refusal.
async fn reserve_attempt(
    pool: &SqlitePool,
    device_id: &str,
    now: Timestamp,
) -> Result<String, DomainError> {
    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    recovery_repo::ensure_attempt(&mut conn, device_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;

    let state = recovery_repo::find_attempt(&mut conn, device_id)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .unwrap_or(recovery_repo::AttemptState {
            failed_attempts: 0,
            last_attempt_at: None,
        });

    let now_ms = now.as_millis();
    let delay = recovery_delay_ms(state.failed_attempts);
    let token = reservation_token();
    let admitted = recovery_repo::reserve_attempt(
        &mut conn,
        device_id,
        state.failed_attempts,
        now_ms - delay,
        now_ms - RECOVERY_MAX_DELAY_MS,
        &token,
        now_ms,
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    if admitted {
        Ok(token)
    } else {
        Err(DomainError::RecoveryRateLimited)
    }
}

/// Hash a password into a verifier, rejecting one that fails the policy first.
///
/// Mirrors the policy gate in `password.rs`: a rejected password costs no
/// hashing work and surfaces as a policy error, never as storage trouble.
fn verifier_for(password: &str) -> Result<CredentialVerifier, DomainError> {
    if !password_is_acceptable(password) {
        return Err(DomainError::WeakPassword);
    }
    let phc = crypto::hash_password(password).map_err(|_| DomainError::InvalidCredentials)?;
    CredentialVerifier::from_phc(phc)
}

/// Stage an owner approval for a later single execution.
///
/// The supervised owner act: the owner confirms the exact approval (plan R1,
/// Q2 wording), enters the CURRENT device Pattern, and the supervisor records
/// the approval. The Pattern check is the same credential check the Pattern
/// service itself performs (`pattern_repo::find` + `crypto::verify_password`,
/// same codes) — no session exists to stamp, and none is created.
///
/// An identical re-stage is a silent no-op (one row, one approval event): the
/// stable fields — reference, device, target, reason — define identity, and
/// `approved_at` deliberately does not, so a retry is never misread as a
/// conflict. A conflicting row, or any re-stage of a consumed approval,
/// fails closed and writes nothing.
pub async fn stage_approval(
    pool: &SqlitePool,
    reference: &str,
    device_id: &str,
    target: UserId,
    reason: &str,
    approved_by: &str,
    pattern: &str,
) -> Result<(), DomainError> {
    // The permission barrier (verdict fix F1): knowledge of the current device
    // Pattern, checked before anything is written. B1: the throttle is claimed
    // first, so a refusal costs no Argon2 work and a rapid re-invocation cannot
    // become a guessing loop. Argon2's cost is a defence in depth, not the
    // attempt limit. No audit event on refusal — matching `verify`, which
    // audits neither way — and no approval row.
    let now = Timestamp::now();
    let reservation = reserve_attempt(pool, device_id, now).await?;

    let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
    let stored = pattern_repo::find(&mut conn)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::PatternNotConfigured)?;
    let verified = crypto::verify_password(pattern, &stored.verifier);
    drop(conn);

    if !verified {
        // Counted under the reservation token, so only the admitted attempt
        // may increment: no lost update, no double count. The throttle is
        // cleared on success, so a single mistake never escalates on its own.
        let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
        recovery_repo::record_attempt_failure(&mut conn, device_id, &reservation)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
        return Err(DomainError::InvalidCredentials);
    }
    {
        let mut conn = pool.acquire().await.map_err(|_| DomainError::StorageUnavailable)?;
        recovery_repo::clear_attempt(&mut conn, device_id, &reservation)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?;
    }

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    let staged = recovery_repo::Approval {
        reference: reference.to_string(),
        device_id: device_id.to_string(),
        target_user_id: target.as_str().to_string(),
        reason: reason.to_string(),
        approved_at: now.as_millis(),
    };
    match recovery_repo::find_by_reference(&mut tx, reference)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
    {
        None => recovery_repo::provision(&mut tx, &staged)
            .await
            .map_err(|_| DomainError::StorageUnavailable)?,
        Some(stored) if stored.consumed_at.is_some() => {
            return Err(DomainError::RecoveryAlreadyUsed)
        }
        Some(stored) if !stored.approval.same_stable_fields(&staged) => {
            return Err(DomainError::RecoveryNotApproved)
        }
        // Identical and unconsumed: a retry, not a new approval. No second
        // row (the key forbids it) and no second event (it would mislead).
        Some(_) => return Ok(()),
    }

    audit::append(
        &mut tx,
        target,
        audit::event::RECOVERY_APPROVED,
        now,
        Some(
            serde_json::json!({
                "reference": reference,
                "device_id": device_id,
                "approved_by": approved_by,
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(())
}

/// Execute a staged approval: consume it and set a temporary password on the
/// target manager, forcing a change at next sign-in.
///
/// No staged, unconsumed, device-matching approval exists — no reset, no
/// writes at all. Consumption shares the transaction with the verifier write
/// (at-most-once even across a crash), and the target is read from the staged
/// row, never from the caller, so an approval cannot be redirected to another
/// account. The `device_id` argument is likewise checked against the staged
/// row — the value the owner authenticated with the Pattern at staging time
/// (verdict fix F2) — so a mismatch refuses even though both strings cross
/// the same transport: one of them is anchored in owner-authenticated state.
pub async fn recover_manager_password(
    pool: &SqlitePool,
    reference: &str,
    device_id: &str,
    new_password: &str,
) -> Result<UserId, DomainError> {
    // Policy before any write: a weak password must not consume the approval.
    let verifier = verifier_for(new_password)?;
    let now = Timestamp::now();

    let mut tx = pool.begin().await.map_err(|_| DomainError::StorageUnavailable)?;

    // Atomic consumption: crash before commit rolls back (safe retry with the
    // same reference), crash after commit leaves a consumed row (replay
    // refused). Either way at-most-once is structural.
    let consumed = recovery_repo::consume_if_unconsumed(&mut tx, reference, device_id, now.as_millis())
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let staged = match consumed {
        Some(approval) => approval,
        None => {
            let status = recovery_repo::find_by_reference(&mut tx, reference)
                .await
                .map_err(|_| DomainError::StorageUnavailable)?;
            return Err(match status {
                Some(stored) if stored.consumed_at.is_some() => DomainError::RecoveryAlreadyUsed,
                _ => DomainError::RecoveryNotApproved,
            });
        }
    };
    let target = UserId::from_uuid(
        staged
            .target_user_id
            .parse::<uuid::Uuid>()
            .map_err(|_| DomainError::RecoveryNotApproved)?,
    );

    // The approval names a live manager and nothing else. A missing, disabled
    // or non-manager target means the approval does not describe a
    // recoverable account.
    let user = user_repo::find_by_id(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .ok_or(DomainError::RecoveryNotApproved)?;
    if user.role != Role::Manager {
        return Err(DomainError::RecoveryNotApproved);
    }
    let disabled = user_repo::find_disabled_at(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?
        .flatten()
        .is_some();
    if disabled {
        return Err(DomainError::RecoveryNotApproved);
    }

    user_repo::update_verifier(&mut tx, target, &verifier, now)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    credential_repo::set_must_change_password(&mut tx, target, true)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    let revoked = session_repo::delete_by_user(&mut tx, target)
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        target,
        audit::event::PASSWORD_RESET,
        now,
        Some(
            serde_json::json!({
                "target": target.as_str(),
                "sessions_revoked": revoked,
                "via": "recovery",
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;
    audit::append(
        &mut tx,
        target,
        audit::event::RECOVERY_EXECUTED,
        now,
        Some(
            serde_json::json!({
                "reference": reference,
                "device_id": device_id,
            })
            .to_string(),
        ),
    )
    .await
    .map_err(|_| DomainError::StorageUnavailable)?;

    tx.commit()
        .await
        .map_err(|_| DomainError::StorageUnavailable)?;
    Ok(target)
}
