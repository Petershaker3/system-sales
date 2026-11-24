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

/// The daily PIN is 4 to 6 digits (`docs/PLAN.md` §4, ADR-017).
pub const MIN_PIN_LEN: usize = 4;
/// See [`MIN_PIN_LEN`].
pub const MAX_PIN_LEN: usize = 6;

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

/// Whether `pin` is a PIN the shop accepts: 4 to 6 ASCII digits, nothing else.
///
/// No further rule (no ban on `1111` or `1234`): the owner chose a short daily
/// secret for speed at the counter, and what protects it is the lockout after
/// [`MAX_FAILED_ATTEMPTS`] failures, shared with the password (ADR-017 §1).
pub fn pin_is_acceptable(pin: &str) -> bool {
    (MIN_PIN_LEN..=MAX_PIN_LEN).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}
