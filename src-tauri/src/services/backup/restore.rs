//! Applying a backup to this device, without ever leaving it half-replaced.
//!
//! # Order of operations
//!
//! 1. Open and validate the envelope **completely** — header, length, AEAD tag,
//!    container, manifest, per-component hashes. A package that fails any of
//!    this is rejected before a single live file is touched.
//! 2. Write every component into `staging/` and re-read it to confirm the disk
//!    kept what was written.
//! 3. Copy the current live state into a complete `rollback/` snapshot and
//!    rename it into place atomically. From here on the previous state can
//!    always be reconstructed.
//! 4. Replace the live entries from `staging/`.
//! 5. Validate the installed bytes against the manifest.
//! 6. Discard the snapshot and the journal.
//!
//! Any failure in 2–5 reverts from the snapshot via
//! [`journal::recover_interrupted`], which is the same code that runs at the
//! next startup if the process dies instead. There is exactly one recovery path,
//! so it cannot be correct in one place and wrong in the other.
//!
//! # What "replace" means
//!
//! The backup is the authoritative state. Restoring it replaces the database,
//! its WAL sidecars and the image directory with the package's contents. A
//! stale `shop.db-wal` left beside a restored `shop.db` would corrupt the
//! database, so the sidecars are removed as part of the replacement.

use std::fs;
use std::path::Path;

use zeroize::Zeroizing;

use crate::domain::backup::error::BackupError;
use crate::domain::backup::format::{self as fmt, TAG_LEN};
use crate::domain::backup::manifest::DB_COMPONENT;

use super::container::{self, Unpacked};
use super::crypto;
use super::journal::{self, Journal, Phase, WorkSpace, DB_FILE, DB_SHM, DB_WAL, IMAGES_DIR};
use super::{check_password, now_ms};

/// What a completed restore did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreOutcome {
    pub database_len: u64,
    pub image_count: usize,
}

/// Decrypt, authenticate and parse the package, touching nothing on the device.
fn open_envelope(backup_path: &Path, secret: &[u8]) -> Result<Unpacked, BackupError> {
    let file = fs::read(backup_path).map_err(|_| BackupError::RestoreFailed)?;
    if file.len() < fmt::AAD_LEN + TAG_LEN {
        return Err(BackupError::FileTruncated);
    }

    let header = fmt::decode_header(&file)?;
    fmt::check_file_len(&header, file.len() as u64)?;

    let salt: [u8; fmt::SALT_LEN] = file[fmt::HEADER_LEN..fmt::HEADER_LEN + fmt::SALT_LEN]
        .try_into()
        .map_err(|_| BackupError::HeaderInvalid)?;
    let nonce: [u8; fmt::NONCE_LEN] = file[fmt::HEADER_LEN + fmt::SALT_LEN..fmt::AAD_LEN]
        .try_into()
        .map_err(|_| BackupError::HeaderInvalid)?;

    let aad = &file[..fmt::AAD_LEN];
    let ciphertext = &file[fmt::AAD_LEN..];

    let key = crypto::derive_key(
        secret,
        &salt,
        header.memory_kib,
        header.iterations,
        header.parallelism,
    )?;
    let plaintext = crypto::open(&key, &nonce, aad, ciphertext)?;
    container::unpack(&plaintext)
}

/// Write one staged component and confirm the disk kept the bytes.
fn write_staged(
    staging: &Path,
    rel: &str,
    bytes: &[u8],
    expected_sha256: &str,
) -> Result<(), BackupError> {
    // `rel` was validated as a relative, traversal-free path before this point.
    let target = staging.join(rel);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|_| BackupError::RestoreFailed)?;
    }
    fs::write(&target, bytes).map_err(|_| BackupError::RestoreFailed)?;

    let written = fs::read(&target).map_err(|_| BackupError::RestoreFailed)?;
    if crypto::sha256_hex(&written) != expected_sha256 {
        return Err(BackupError::RestoreFailed);
    }
    Ok(())
}

/// Validate the live entries against the manifest after replacement.
fn validate_installed(data_dir: &Path, unpacked: &Unpacked) -> Result<(), BackupError> {
    let db = fs::read(data_dir.join(DB_FILE)).map_err(|_| BackupError::RestoreFailed)?;
    if crypto::sha256_hex(&db) != unpacked.manifest.database.sha256 {
        return Err(BackupError::ContentInvalid);
    }
    for (index, (path, _)) in unpacked.images.iter().enumerate() {
        let bytes = fs::read(data_dir.join(path)).map_err(|_| BackupError::RestoreFailed)?;
        if crypto::sha256_hex(&bytes) != unpacked.manifest.images[index].sha256 {
            return Err(BackupError::ContentInvalid);
        }
    }
    Ok(())
}

fn apply(data_dir: &Path, unpacked: &Unpacked) -> Result<(), BackupError> {
    fs::create_dir_all(data_dir).map_err(|_| BackupError::RestoreFailed)?;
    let work = WorkSpace::new(data_dir);
    let _ = journal::remove_if_exists(&work.root);
    fs::create_dir_all(&work.staging()).map_err(|_| BackupError::RestoreFailed)?;

    journal::store_journal(
        &work,
        &Journal {
            layout_version: journal::LAYOUT_VERSION,
            phase: Phase::Prepared,
            started_at_unix_ms: now_ms(),
        },
    )?;

    // 2. Stage everything, verifying each write.
    write_staged(
        &work.staging(),
        DB_COMPONENT,
        &unpacked.database,
        &unpacked.manifest.database.sha256,
    )?;
    for (index, (path, bytes)) in unpacked.images.iter().enumerate() {
        let meta = &unpacked.manifest.images[index];
        write_staged(&work.staging(), path, bytes, &meta.sha256)?;
    }

    // 3. Complete snapshot of the previous state, renamed into place atomically.
    journal::snapshot_live(data_dir, &work)?;
    journal::store_journal(
        &work,
        &Journal {
            layout_version: journal::LAYOUT_VERSION,
            phase: Phase::BackedUp,
            started_at_unix_ms: now_ms(),
        },
    )?;

    // 4. Replace the live entries, sidecars included.
    for name in [DB_FILE, DB_WAL, DB_SHM, IMAGES_DIR] {
        journal::remove_if_exists(&data_dir.join(name))?;
    }
    let staged_db = work.staging().join(DB_COMPONENT);
    fs::rename(&staged_db, data_dir.join(DB_FILE)).map_err(|_| BackupError::RestoreFailed)?;
    let staged_images = work.staging().join(IMAGES_DIR);
    if fs::symlink_metadata(&staged_images).is_ok() {
        fs::rename(&staged_images, data_dir.join(IMAGES_DIR))
            .map_err(|_| BackupError::RestoreFailed)?;
    }

    journal::store_journal(
        &work,
        &Journal {
            layout_version: journal::LAYOUT_VERSION,
            phase: Phase::Installed,
            started_at_unix_ms: now_ms(),
        },
    )?;

    // 5. Confirm the live bytes match the manifest.
    validate_installed(data_dir, unpacked)?;

    // 6. Commit. Best effort: once the installed bytes are validated, a failure
    //    to delete the snapshot must not revert a good restore.
    let _ = journal::remove_if_exists(&work.rollback());
    let _ = journal::remove_if_exists(&work.root);
    Ok(())
}

/// Restore `backup_path` over the device data at `data_dir`.
///
/// The database connection must be closed before this is called: the function
/// replaces `shop.db` on disk. It does not open or close the pool for you.
pub fn restore_backup(
    data_dir: &Path,
    backup_path: &Path,
    password: &str,
) -> Result<RestoreOutcome, BackupError> {
    check_password(password)?;
    let secret = Zeroizing::new(password.as_bytes().to_vec());

    // Fully validate before touching the device.
    let unpacked = open_envelope(backup_path, &secret)?;

    // Clear any leftover from a previous interrupted attempt (idempotent).
    journal::recover_interrupted(data_dir)?;

    let outcome = RestoreOutcome {
        database_len: unpacked.manifest.database.len,
        image_count: unpacked.manifest.images.len(),
    };

    match apply(data_dir, &unpacked) {
        Ok(()) => Ok(outcome),
        Err(error) => {
            // Same recovery path as startup: revert from the snapshot, or
            // discard staging if the live device was never touched.
            let _ = journal::recover_interrupted(data_dir);
            Err(error)
        }
    }
}
