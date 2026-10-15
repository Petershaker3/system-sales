//! Lockout policy.
//!
//! `plan:151` requires that failed-attempt limits be defined *before* users are
//! issued. These values are the Product Owner decision of 2026-10-03:
//! five failures, then a fifteen-minute lock.
//!
//! The state machine is a pure function of the recorded counters so it can be
//! tested without a database. The service layer persists whatever this returns.

/// Failures tolerated before the account locks.
pub const MAX_FAILED_ATTEMPTS: i32 = 5;

/// How long a locked account stays locked.
pub const LOCKOUT_MS: i64 = 15 * 60 * 1000;

/// The minimum a password must be to be accepted.
pub const MIN_PASSWORD_LEN: usize = 8;

/// Delay before the first failed recovery attempt may be followed by another.
///
/// A delay, never a lock: the window is measured from the previous attempt and
/// expires on its own, so the owner is never permanently barred from a
/// legitimate recovery.
pub const RECOVERY_BASE_DELAY_MS: i64 = 5 * 1000;

/// Ceiling on the recovery delay. Bounded so a long guessing run cannot become
/// a denial of service against the owner, and so a crashed in-flight attempt
/// (one that holds a reservation and never finalises) is taken over within a
/// known, short time.
pub const RECOVERY_MAX_DELAY_MS: i64 = 5 * 60 * 1000;

/// How long to wait before attempt number `failed + 1`.
///
/// Exponential from [`RECOVERY_BASE_DELAY_MS`], capped at
/// [`RECOVERY_MAX_DELAY_MS`], and saturating rather than wrapping: an overflow
/// that produced a negative delay would silently disable the throttle, which is
/// the one outcome this function must never have. Pure, so the curve is
/// testable without a database.
pub fn recovery_delay_ms(failed: i32) -> i64 {
    if failed <= 0 {
        return 0;
    }
    let shift = u32::try_from(failed - 1).unwrap_or(u32::MAX).min(31);
    RECOVERY_BASE_DELAY_MS
        .saturating_mul(1i64 << shift)
        .min(RECOVERY_MAX_DELAY_MS)
}

/// Outcome of applying one authentication attempt to the recorded state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockoutState {
    pub failed_attempts: i32,
    /// `None` when the account is not locked.
    pub locked_until: Option<crate::domain::identity::Timestamp>,
}

/// What the service layer must write back after an attempt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LockoutTransition {
    pub failed_attempts: i32,
    pub locked_until: Option<crate::domain::identity::Timestamp>,
    /// True when this attempt is the one that trips the lock.
    pub just_locked: bool,
}

/// Whether the account is locked at `now`.
pub fn is_locked(state: &LockoutState, now: crate::domain::identity::Timestamp) -> bool {
    match state.locked_until {
        Some(until) => now < until,
        None => false,
    }
}

/// Record a failed attempt.
///
/// On the fifth failure the account is locked for [`LOCKOUT_MS`]. The counter is
/// not reset at that point: keeping the saturated count means a further attempt
/// while locked cannot silently lower the bar.
pub fn register_failure(
    state: &LockoutState,
    now: crate::domain::identity::Timestamp,
) -> LockoutTransition {
    let failed_attempts = state.failed_attempts.saturating_add(1);
    if failed_attempts >= MAX_FAILED_ATTEMPTS {
        LockoutTransition {
            failed_attempts,
            locked_until: Some(now.plus_millis(LOCKOUT_MS)),
            just_locked: true,
        }
    } else {
        LockoutTransition {
            failed_attempts,
            locked_until: state.locked_until,
            just_locked: false,
        }
    }
}

/// Clear the counters after a successful authentication.
pub fn register_success() -> LockoutTransition {
    LockoutTransition {
        failed_attempts: 0,
        locked_until: None,
        just_locked: false,
    }
}

/// Password policy in force for V1.
///
/// Length only. Character-class rules were not part of the approved decision,
/// and inventing them here would be encoding an assumption as a requirement,
/// which `PROJECT_INSTRUCTIONS.md` §4 forbids.
pub fn password_is_acceptable(password: &str) -> bool {
    password.chars().count() >= MIN_PASSWORD_LEN
}