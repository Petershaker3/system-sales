//! Tauri commands for one-time supervised manager-password recovery.
//!
//! Recovery builds only (`--features recovery`). Without the flag this module
//! does not exist and `lib.rs` registers nothing from it, so a production
//! build cannot expose the recovery path — an architecture test pins that
//! property by scanning these sources.
//!
//! Transport boundaries only. No SQL and no business rule appears here. Like
//! every other command module, no command accepts a token, a user id that
//! asserts identity, a role, or an actor: the target of the recovery is read
//! from the staged approval row inside the use case, and the only identifiers
//! crossing here are the approval reference, the device id, and the new
//! password the owner typed under supervision.

#![cfg(feature = "recovery")]

use serde::Serialize;
use tauri::State;

use crate::domain::identity::{DomainError, UserId};
use crate::services::identity::recovery as recovery_use_cases;
use crate::services::identity::IdentityContext;

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCommandError {
    pub code: &'static str,
}

impl From<DomainError> for RecoveryCommandError {
    fn from(error: DomainError) -> Self {
        Self {
            code: error.code(),
        }
    }
}

fn parse_user_id(raw: &str) -> Result<UserId, DomainError> {
    // An unparseable target means the approval does not name a recoverable
    // account. It is deliberately not `UserNotFound`/`INVALID_CREDENTIALS`:
    // that code would tell the operator their password is wrong when the
    // problem is the approval itself.
    uuid::Uuid::parse_str(raw)
        .map(UserId::from_uuid)
        .map_err(|_| DomainError::RecoveryNotApproved)
}

/// Record the owner's explicit approval for one later execution.
///
/// The supervisor calls this while the owner confirms the exact approval
/// wording (plan R1, Q2) and enters the CURRENT device Pattern. Staging
/// refuses without the Pattern (verdict fix F1). Nothing about any password
/// changes here.
#[tauri::command]
pub async fn stage_recovery_approval(
    ctx: Ctx<'_>,
    reference: String,
    device_id: String,
    target_user_id: String,
    reason: String,
    approved_by: String,
    pattern: String,
) -> Result<(), RecoveryCommandError> {
    recovery_use_cases::stage_approval(
        &ctx.pool,
        &reference,
        &device_id,
        parse_user_id(&target_user_id)?,
        &reason,
        &approved_by,
        &pattern,
    )
    .await
    .map_err(RecoveryCommandError::from)?;
    Ok(())
}

/// Consume a staged approval and set a temporary password on its target.
///
/// The caller-supplied `device_id` is compared against the STAGED row — the
/// value the owner authenticated with the Pattern at staging time (verdict
/// fix F2) — never against another caller-supplied value in the same call.
/// Mismatch refuses. No platform hardware identifier is claimed: on this
/// offline V1 build the device binding is consistency enforcement plus
/// supervisor verification against the physical device, documented as
/// procedural rather than an independent attestation barrier.
///
/// Returns the recovered account's id so the frontend can continue to the
/// normal forced-change screen. Fails closed without a matching unconsumed
/// approval, and a consumed approval fails closed on replay.
#[tauri::command]
pub async fn execute_manager_recovery(
    ctx: Ctx<'_>,
    reference: String,
    device_id: String,
    new_password: String,
) -> Result<String, RecoveryCommandError> {
    let target =
        recovery_use_cases::recover_manager_password(&ctx.pool, &reference, &device_id, &new_password)
            .await
            .map_err(RecoveryCommandError::from)?;
    Ok(target.as_str())
}
