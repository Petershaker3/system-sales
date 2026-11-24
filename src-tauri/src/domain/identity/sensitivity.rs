//! Sensitivity: the owner's PIN approval for sensitive operations (ADR-017 §3).
//!
//! `spec:210` requires the authorization decision to be proven at the
//! application/data layer, and inventory work is a *mix*: receiving a carton is
//! routine, opening a balance is not. So the approval is deliberately NOT
//! folded into `Permission::requires_reauthenticated` — that is a blanket
//! per-permission rule, and a blanket rule cannot express "routine for one
//! operation, sensitive for another".
//!
//! This module owns the fourth axis, and the [`Session`] type owns the first
//! three (`Session::authorize`). Services call both; neither is re-implemented
//! at a call site.
//!
//! # The rule
//!
//! A sensitive operation needs one fresh owner approval: an active manager
//! typed their PIN on this session less than [`OWNER_APPROVAL_TTL_MS`] ago, and
//! nothing has used that approval since. There is no password
//! re-authentication in it — speed at the counter is the point — and the
//! owner's own session needs the PIN too, so a signed-in session left
//! unattended is never a standing approval.
//!
//! The domain decides *freshness*. *One use* is enforced where the operation
//! commits (`session_repo::consume_owner_approval`, inside the operation's own
//! transaction), because only the database can see a second operation racing
//! for the same approval.

use crate::domain::identity::{DomainError, Session, Timestamp, UserId};

/// How much authority an operation needs, decided by the operation itself.
///
/// Passed by the service at the call site, not configured: opening a balance is
/// sensitive in every shop on every device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitivity {
    /// Ordinary catalogue or sales work. No approval.
    Routine,
    /// Changes inventory value or money at risk. Needs a fresh owner approval.
    Sensitive,
}

/// How long an unused owner approval survives, in milliseconds.
///
/// **2 minutes** (ADR-017 §3): long enough to hand the screen back to the
/// seller and press the button, short enough that an approval nobody used does
/// not wait around for the next operation.
pub const OWNER_APPROVAL_TTL_MS: i64 = 2 * 60 * 1000;

/// An owner approval waiting on a session: who approved, and when.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnerApproval {
    approved_by: UserId,
    approved_at: Timestamp,
}

impl OwnerApproval {
    /// Record an approval `approved_by` granted at `approved_at`.
    pub fn granted(approved_by: UserId, approved_at: Timestamp) -> Self {
        Self {
            approved_by,
            approved_at,
        }
    }

    /// The manager whose PIN was entered.
    pub fn approved_by(&self) -> UserId {
        self.approved_by
    }

    /// When the PIN was entered.
    pub fn approved_at(&self) -> Timestamp {
        self.approved_at
    }

    /// Fresh means: granted no later than `now`, and less than `ttl_ms` before it.
    ///
    /// An approval stamped in the future — the clock moved backwards since — is
    /// *not* fresh. Failing closed costs one more PIN entry; trusting it would
    /// stretch the window by however far the clock jumped.
    pub fn is_fresh(&self, now: Timestamp, ttl_ms: i64) -> bool {
        self.approved_at <= now && now.millis_since(self.approved_at) < ttl_ms
    }
}

impl Session {
    /// The fourth authorization axis: the owner's approval for sensitive work.
    ///
    /// Consulted after `Session::authorize` has already approved role and
    /// assurance. Routine work returns `Ok(None)`. Sensitive work returns the
    /// approval it will spend, so the service can consume exactly that one
    /// inside its transaction and name the approver in its audit row; without
    /// a fresh approval it is refused with
    /// [`DomainError::OwnerApprovalRequired`], whose remedy is always the same
    /// — the owner enters the PIN.
    ///
    /// The one exception is the open shop (`ADR-039`): while the device has no
    /// account, the approval has nothing to protect. It exists so a seller left
    /// at an unattended till cannot cancel a sale or move stock; in an open shop
    /// there is no seller, no second account and no PIN to type — only the owner,
    /// standing at their own counter, who is already this session. So a sensitive
    /// operation carries its own approval, and the audit names the open row as
    /// both operator and approver, which is the truth.
    pub fn require_sensitivity(
        &self,
        sensitivity: Sensitivity,
        now: Timestamp,
    ) -> Result<Option<OwnerApproval>, DomainError> {
        match sensitivity {
            Sensitivity::Routine => Ok(None),
            Sensitivity::Sensitive if self.is_open_mode() => {
                Ok(Some(OwnerApproval::granted(self.user_id(), now)))
            }
            Sensitivity::Sensitive => match self.owner_approval() {
                Some(approval) if approval.is_fresh(now, OWNER_APPROVAL_TTL_MS) => {
                    Ok(Some(approval))
                }
                _ => Err(DomainError::OwnerApprovalRequired),
            },
        }
    }
}
