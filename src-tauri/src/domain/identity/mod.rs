//! Identity domain.
//!
//! Business rules and types for accounts, roles and sessions. This module
//! depends on nothing from Tauri, SQLx, SQLite or the operating system
//! (`spec:99`, `ADR-008:121`). Timestamps are passed in rather than read from a
//! clock so every rule here is a pure function and directly testable.

mod error;
mod ids;
mod policy;
mod role;
mod sensitivity;
mod session;
mod user;

pub use error::DomainError;
pub use ids::UserId;
pub use policy::{
    is_locked, password_is_acceptable, recovery_delay_ms, register_failure, register_success,
    LockoutState,
    LockoutTransition, LOCKOUT_MS, MAX_FAILED_ATTEMPTS, MIN_PASSWORD_LEN,
    RECOVERY_BASE_DELAY_MS, RECOVERY_MAX_DELAY_MS,
};
pub use role::{Permission, Role};
pub use sensitivity::{PatternApproval, Sensitivity, PATTERN_TTL_MS};
pub use session::{
    Session, SessionFacts, SessionToken, Timestamp, Assurance, ABSOLUTE_LIFETIME_MS,
    IDLE_TIMEOUT_MS,
};
pub use user::{CredentialVerifier, User, UserSummary, Username};