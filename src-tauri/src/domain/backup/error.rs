//! Errors the backup/restore domain can raise on its own.
//!
//! These are the only failure codes the backup slice emits. Transport, storage
//! and keyring failures are mapped onto this enum by the service layer, so
//! `domain/` stays free of SQLx, Tauri and filesystem types (`spec:99`).
//!
//! # Why there is no "wrong password" variant
//!
//! [`BackupError::DecryptionFailed`] is returned for a wrong password, a
//! modified header, a modified ciphertext and a truncated body alike. Giving
//! those separate codes would hand an attacker an oracle: with one guess they
//! could tell "this file is real but my password is wrong" from "this file is
//! damaged". `ADR-003:15` requires the wrong password and the tampered package
//! to fail closed, and this enum collapses them so the failure is
//! indistinguishable on the wire.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupError {
    /// The file does not begin with the backup magic bytes.
    NotABackupFile,
    /// The envelope version is not one this build understands.
    UnsupportedVersion,
    /// The header names a KDF or AEAD this build does not implement.
    UnsupportedAlgorithm,
    /// The file ended before a declared structure did.
    FileTruncated,
    /// The fixed header is internally inconsistent (reserved bytes, lengths).
    HeaderInvalid,
    /// KDF cost parameters are outside the accepted bounds.
    ///
    /// Checked *before* Argon2 runs, so a crafted header cannot ask this device
    /// to allocate an unbounded amount of memory.
    KdfParamsInvalid,
    /// The declared payload exceeds the accepted maximum.
    PayloadTooLarge,
    /// AEAD authentication failed: wrong password or altered file.
    DecryptionFailed,
    /// The manifest is missing, malformed, or self-inconsistent.
    ManifestInvalid,
    /// The encrypted payload is structurally invalid or fails its checksums.
    ContentInvalid,
    /// A component path could escape the restore directory.
    UnsafePath,
    /// The same component path appears more than once.
    DuplicateComponent,
    /// The manifest declares no database component.
    MissingDatabase,
    /// No password was supplied.
    PasswordRequired,
    /// The password is shorter than the accepted minimum.
    PasswordTooWeak,
    /// The backup file could not be produced.
    CreateFailed,
    /// The backup could not be applied to this device.
    RestoreFailed,
    /// A previous restore was interrupted and could not be completed.
    RecoveryIncomplete,
}

impl BackupError {
    /// The stable, language-independent code sent to the frontend.
    ///
    /// The Arabic wording lives in `src/api/errors.ts`; an architecture test
    /// fails the build if a code here has no message there.
    pub fn code(&self) -> &'static str {
        match self {
            BackupError::NotABackupFile => "BACKUP_NOT_A_BACKUP_FILE",
            BackupError::UnsupportedVersion => "BACKUP_UNSUPPORTED_VERSION",
            BackupError::UnsupportedAlgorithm => "BACKUP_UNSUPPORTED_ALGORITHM",
            BackupError::FileTruncated => "BACKUP_FILE_TRUNCATED",
            BackupError::HeaderInvalid => "BACKUP_HEADER_INVALID",
            BackupError::KdfParamsInvalid => "BACKUP_KDF_PARAMS_INVALID",
            BackupError::PayloadTooLarge => "BACKUP_PAYLOAD_TOO_LARGE",
            BackupError::DecryptionFailed => "BACKUP_DECRYPT_FAILED",
            BackupError::ManifestInvalid => "BACKUP_MANIFEST_INVALID",
            BackupError::ContentInvalid => "BACKUP_CONTENT_INVALID",
            BackupError::UnsafePath => "BACKUP_UNSAFE_PATH",
            BackupError::DuplicateComponent => "BACKUP_DUPLICATE_COMPONENT",
            BackupError::MissingDatabase => "BACKUP_MISSING_DATABASE",
            BackupError::PasswordRequired => "BACKUP_PASSWORD_REQUIRED",
            BackupError::PasswordTooWeak => "BACKUP_PASSWORD_TOO_WEAK",
            BackupError::CreateFailed => "BACKUP_CREATE_FAILED",
            BackupError::RestoreFailed => "BACKUP_RESTORE_FAILED",
            BackupError::RecoveryIncomplete => "BACKUP_RECOVERY_INCOMPLETE",
        }
    }
}

impl fmt::Display for BackupError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Deliberately terse and free of any secret or path: this may be logged
        // on a device whose owner is not the operator.
        f.write_str(match self {
            BackupError::NotABackupFile => "not a backup file",
            BackupError::UnsupportedVersion => "unsupported backup version",
            BackupError::UnsupportedAlgorithm => "unsupported backup algorithm",
            BackupError::FileTruncated => "backup file is truncated",
            BackupError::HeaderInvalid => "backup header is invalid",
            BackupError::KdfParamsInvalid => "backup key-derivation parameters are invalid",
            BackupError::PayloadTooLarge => "backup payload is too large",
            BackupError::DecryptionFailed => "backup could not be decrypted",
            BackupError::ManifestInvalid => "backup manifest is invalid",
            BackupError::ContentInvalid => "backup content is invalid",
            BackupError::UnsafePath => "backup contains an unsafe path",
            BackupError::DuplicateComponent => "backup contains a duplicate component",
            BackupError::MissingDatabase => "backup contains no database",
            BackupError::PasswordRequired => "a backup password is required",
            BackupError::PasswordTooWeak => "the backup password is too short",
            BackupError::CreateFailed => "the backup could not be created",
            BackupError::RestoreFailed => "the backup could not be restored",
            BackupError::RecoveryIncomplete => "an interrupted restore could not be completed",
        })
    }
}

impl std::error::Error for BackupError {}
