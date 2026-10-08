//! Sensitivity: step-up authorization for sensitive operations.
//!
//! `spec:210` requires the authorization decision to be proven at the
//! application/data layer, and inventory work is a *mix*: receiving a carton is
//! routine, opening a balance is not. So Pattern approval is deliberately NOT
//! folded into `Permission::requires_reauthenticated` — that is a blanket
//! per-permission rule, and a blanket rule cannot express "routine for one
//! operation, sensitive for another".
//!
//! This module owns the fourth axis, and the [`Session`] type owns the first
//! three (`Session::authorize`). Services call both; neither is re-implemented
//! at a call site.

use crate::domain::identity::{Assurance, DomainError, Session, Timestamp};

/// How much authority an operation needs, decided by the operation itself.
///
/// Passed by the service at the call site, not configured: opening a balance is
/// sensitive in every shop on every device.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sensitivity {
    /// Ordinary catalogue or sales work. No step-up.
    Routine,
    /// Changes inventory value or money at risk. Requires the fourth axis.
    Sensitive,
}

/// How long a Pattern approval survives, in milliseconds.
///
/// **5 minutes** — a Product Owner assumption (plan SP-1b, Assumption 1), not a
/// decision taken here: a step-up for one operation should not outlive its
/// purpose, and five minutes covers filling in a form without becoming a
/// standing unlock.
pub const PATTERN_TTL_MS: i64 = 5 * 60 * 1000;

/// A recorded Pattern approval: *when* it was granted, and *under which epoch*.
///
/// Both conditions must hold for the approval to be fresh — inside the TTL
/// window **and** the epoch still current. The second condition is what lets a
/// Pattern change invalidate every open approval without a sweep: the epoch is
/// bumped in `manager_pattern` and every stored approval compares unequal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PatternApproval {
    approved_at: Timestamp,
    epoch: i64,
}

impl PatternApproval {
    /// Record an approval granted at `approved_at` under `epoch`.
    pub fn granted(approved_at: Timestamp, epoch: i64) -> Self {
        Self { approved_at, epoch }
    }

    /// Fresh means: inside the TTL window **and** the epoch still current.
    ///
    /// `millis_since` saturates at zero rather than going negative, so a clock
    /// that moved backwards yields "not yet elapsed" rather than an approval
    /// that lasts longer than its window.
    pub fn is_fresh(&self, now: Timestamp, current_epoch: i64, ttl_ms: i64) -> bool {
        self.epoch == current_epoch
            && now.millis_since(self.approved_at) < ttl_ms
    }
}

impl Session {
    /// The fourth authorization axis: Pattern step-up for sensitive work.
    ///
    /// Consulted after `Session::authorize` has already approved role and
    /// assurance. `pattern_required` and `current_pattern_epoch` come from
    /// settings and `manager_pattern` at call time, so the domain stays free of
    /// I/O — the service reads them and passes them in.
    ///
    /// Refuses distinguish three states, because the operator's remedy differs:
    ///
    /// * [`DomainError::PatternNotConfigured`] — protection is enabled but no
    ///   Pattern exists yet; only a manager can fix that.
    /// * [`DomainError::PatternRequired`] — nobody has approved in this session;
    ///   entering the Pattern is the remedy.
    /// * [`DomainError::PatternApprovalStale`] — an approval exists but has
    ///   expired or was invalidated by a Pattern change; approving again is the
    ///   remedy.
    pub fn require_sensitivity(
        &self,
        sensitivity: Sensitivity,
        pattern_required: bool,
        current_pattern_epoch: Option<i64>,
        now: Timestamp,
    ) -> Result<(), DomainError> {
        if sensitivity == Sensitivity::Routine {
            return Ok(());
        }

        if self.assurance() != Assurance::Reauthenticated {
            return Err(DomainError::ReauthenticationRequired);
        }

        if !pattern_required {
            return Ok(());
        }

        let Some(current_epoch) = current_pattern_epoch else {
            return Err(DomainError::PatternNotConfigured);
        };

        if self.pattern_approved_at().is_none() {
            return Err(DomainError::PatternRequired);
        }

        if self.pattern_approval_is_current(now, current_epoch, PATTERN_TTL_MS) {
            Ok(())
        } else {
            Err(DomainError::PatternApprovalStale)
        }
    }
}
