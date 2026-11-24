//! Encrypted backup and recovery (`ADR-003`).
//!
//! The service half of the slice: Argon2id key derivation, XChaCha20-Poly1305
//! sealing, the plaintext container, backup creation, and the staged restore
//! engine with its crash-recovery path.
//!
//! The domain half (`domain::backup`) owns the byte layout, the manifest and
//! the path policy. This module never re-implements those rules; it calls them.
//!
//! # Entry points
//!
//! * [`create_backup`] — snapshot the live database and images into one file.
//! * [`restore_backup`] — apply a file to this device, crash-safely.
//! * [`recover_interrupted`] — run at startup, before opening the database, to
//!   finish or undo a restore that was interrupted.

pub mod auto;
pub mod container;
pub mod create;
pub mod crypto;
pub mod journal;
pub mod restore;
/// Authorized entry points for the in-app backup commands (P2a-Rust).
pub mod authorized;

pub use authorized::{
    authorize, authorized_create, resolve_inside, resolve_readable, BackupServiceError,
};

pub use create::{create_backup, snapshot_database, BackupReport};
pub use journal::{recover_interrupted, RecoveryOutcome};
pub use restore::{restore_backup, verify_backup, RestoreOutcome};

use crate::domain::backup::error::BackupError;

/// Shortest backup password accepted.
///
/// A backup leaves the device and carries purchase prices and customer contact
/// data, so it is at least as sensitive as an account password. The floor
/// matches `MIN_PASSWORD_LEN` in the identity domain rather than inventing a
/// second policy; it is enforced in Rust so a caller cannot skip it.
pub const MIN_BACKUP_PASSWORD_LEN: usize = 8;

/// Reject a missing or too-short password.
pub fn check_password(password: &str) -> Result<(), BackupError> {
    if password.is_empty() {
        return Err(BackupError::PasswordRequired);
    }
    if password.chars().count() < MIN_BACKUP_PASSWORD_LEN {
        return Err(BackupError::PasswordTooWeak);
    }
    Ok(())
}

/// Milliseconds since the Unix epoch, UTC.
pub(crate) fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
