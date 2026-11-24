//! The work area, the recovery journal, and startup recovery.
//!
//! # Why a restore cannot be "just renames"
//!
//! A restore replaces the device database (and its WAL sidecars) and the
//! product-image directory. That is several filesystem operations, and a
//! sequence of renames is not a transaction: a power cut between two of them
//! leaves a half-replaced device. `ADR-003` therefore requires a crash-safe
//! procedure and a way to recover an interrupted one.
//!
//! # The invariant that makes recovery safe
//!
//! Before anything live is changed, the previous state is copied into
//! `rollback.tmp` and that directory is renamed to `rollback` in one atomic
//! operation. So:
//!
//! > `rollback/` exists **only if** it is a complete snapshot of the state
//! > before the restore began.
//!
//! Recovery never has to guess how far a restore got: if a complete snapshot
//! exists, restore it; otherwise the live device was never mutated and the
//! staging directory can simply be deleted.
//!
//! # Journals and directory state
//!
//! A small JSON journal records the phase so an operator (and a test) can see
//! what happened. Correctness does **not** depend on it: a journal write that
//! is lost or corrupted mid-update cannot mislead recovery, because the
//! decision is made from the presence of the atomic snapshot directory. That is
//! deliberate — a recovery mechanism that trusts a file that may itself have
//! been interrupted would be the very bug it exists to prevent.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::domain::backup::error::BackupError;

/// The restore work area, relative to the device data directory.
pub const WORK_DIR: &str = ".backup-restore";
pub const STAGING_DIR: &str = "staging";
pub const ROLLBACK_DIR: &str = "rollback";
pub const ROLLBACK_TMP_DIR: &str = "rollback.tmp";
pub const JOURNAL_FILE: &str = "journal.json";
pub const JOURNAL_TMP_FILE: &str = "journal.json.tmp";

/// Live entries a restore manages. Anything not listed is left alone.
pub const DB_FILE: &str = "shop.db";
pub const DB_WAL: &str = "shop.db-wal";
pub const DB_SHM: &str = "shop.db-shm";
pub const IMAGES_DIR: &str = "images";

/// Layout version of the work area itself (not the envelope).
pub const LAYOUT_VERSION: u16 = 1;

/// How far a restore had progressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Staging written; live not touched.
    Prepared,
    /// A complete rollback snapshot exists; live may now be mutated.
    BackedUp,
    /// Staged content has been installed; validation may be in progress.
    Installed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Journal {
    pub layout_version: u16,
    pub phase: Phase,
    pub started_at_unix_ms: i64,
}

/// What startup recovery found and did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryOutcome {
    /// No work area existed; nothing had been interrupted.
    NothingToDo,
    /// Staging was discarded. The live device was never modified.
    Cleaned { phase: Option<Phase> },
    /// Live data was put back from the rollback snapshot.
    Reverted { phase: Option<Phase>, had_snapshot: bool },
}

/// The paths a restore uses under one work area.
pub struct WorkSpace {
    pub root: PathBuf,
}

impl WorkSpace {
    pub fn new(data_dir: &Path) -> Self {
        WorkSpace {
            root: data_dir.join(WORK_DIR),
        }
    }

    pub fn staging(&self) -> PathBuf {
        self.root.join(STAGING_DIR)
    }

    pub fn rollback(&self) -> PathBuf {
        self.root.join(ROLLBACK_DIR)
    }

    pub fn rollback_tmp(&self) -> PathBuf {
        self.root.join(ROLLBACK_TMP_DIR)
    }

    fn journal_path(&self) -> PathBuf {
        self.root.join(JOURNAL_FILE)
    }
}

fn fs_error() -> BackupError {
    BackupError::RestoreFailed
}

/// Remove a file or directory if it exists. Absence is not an error.
pub fn remove_if_exists(path: &Path) -> Result<(), BackupError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path).map_err(|_| fs_error()),
        Ok(_) => fs::remove_file(path).map_err(|_| fs_error()),
        Err(_) => Ok(()),
    }
}

/// Recursively copy a file or directory. The destination is replaced.
pub fn copy_entry(src: &Path, dst: &Path) -> Result<(), BackupError> {
    let meta = fs::symlink_metadata(src).map_err(|_| fs_error())?;
    if meta.is_dir() {
        fs::create_dir_all(dst).map_err(|_| fs_error())?;
        let mut entries: Vec<_> = fs::read_dir(src)
            .map_err(|_| fs_error())?
            .flatten()
            .map(|e| (e.file_name(), e.path()))
            .collect();
        // Sorted so a test run is reproducible.
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, path) in entries {
            copy_entry(&path, &dst.join(name))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent).map_err(|_| fs_error())?;
        }
        fs::copy(src, dst).map_err(|_| fs_error())?;
        Ok(())
    }
}

/// Whether a directory exists and holds at least one entry.
pub fn is_nonempty_dir(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
}

/// Persist a journal phase.
///
/// Written to a temporary file, flushed, then renamed over the previous journal.
/// On Windows the rename needs the destination gone first; the window where no
/// journal exists is harmless because recovery keys off the snapshot directory.
pub fn store_journal(work: &WorkSpace, journal: &Journal) -> Result<(), BackupError> {
    fs::create_dir_all(&work.root).map_err(|_| fs_error())?;
    let bytes = serde_json::to_vec(journal).map_err(|_| fs_error())?;
    let tmp = work.root.join(JOURNAL_TMP_FILE);
    let dst = work.journal_path();
    {
        let mut file = fs::File::create(&tmp).map_err(|_| fs_error())?;
        file.write_all(&bytes).map_err(|_| fs_error())?;
        file.sync_all().map_err(|_| fs_error())?;
    }
    let _ = fs::remove_file(&dst);
    fs::rename(&tmp, &dst).map_err(|_| fs_error())?;
    Ok(())
}

/// Read the journal, if it is present and parseable.
///
/// An unparseable journal is reported as absent rather than fatal: recovery must
/// still run on a device whose journal was interrupted mid-write.
pub fn load_journal(work: &WorkSpace) -> Option<Journal> {
    let bytes = fs::read(work.journal_path()).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Copy every managed live entry into a fresh, complete snapshot directory.
///
/// The snapshot is built under `rollback.tmp` and renamed into place, so a
/// half-written snapshot is never mistaken for a complete one.
pub fn snapshot_live(data_dir: &Path, work: &WorkSpace) -> Result<(), BackupError> {
    let tmp = work.rollback_tmp();
    let final_dir = work.rollback();
    let _ = remove_if_exists(&tmp);
    let _ = remove_if_exists(&final_dir);
    fs::create_dir_all(&tmp).map_err(|_| fs_error())?;

    for name in [DB_FILE, DB_WAL, DB_SHM, IMAGES_DIR] {
        let live = data_dir.join(name);
        if fs::symlink_metadata(&live).is_ok() {
            copy_entry(&live, &tmp.join(name))?;
        }
    }

    fs::rename(&tmp, &final_dir).map_err(|_| fs_error())?;
    Ok(())
}

/// Put the managed live entries back exactly as the snapshot describes them.
///
/// Idempotent: every live target is removed and then rebuilt from the snapshot,
/// so running it twice, or re-running it after an interruption, converges on the
/// same state. A target the snapshot does not contain is removed from live, so a
/// partially installed new database cannot survive a revert.
pub fn revert_live_from_snapshot(data_dir: &Path, work: &WorkSpace) -> Result<(), BackupError> {
    let snapshot = work.rollback();
    for name in [DB_FILE, DB_WAL, DB_SHM, IMAGES_DIR] {
        remove_if_exists(&data_dir.join(name))?;
    }
    for name in [DB_FILE, DB_WAL, DB_SHM, IMAGES_DIR] {
        let saved = snapshot.join(name);
        if fs::symlink_metadata(&saved).is_ok() {
            copy_entry(&saved, &data_dir.join(name))?;
        }
    }
    Ok(())
}

/// Detect and recover a restore that was interrupted by a crash or power loss.
///
/// Call this **before** opening the database at startup. It is idempotent and
/// safe to call when nothing was interrupted.
pub fn recover_interrupted(data_dir: &Path) -> Result<RecoveryOutcome, BackupError> {
    let work = WorkSpace::new(data_dir);
    if fs::symlink_metadata(&work.root).is_err() {
        return Ok(RecoveryOutcome::NothingToDo);
    }

    let phase = load_journal(&work).map(|j| j.phase);
    let staging = work.staging();
    let rollback_tmp = work.rollback_tmp();

    if is_nonempty_dir(&work.rollback()) {
        // A complete pre-restore snapshot exists: put it back.
        revert_live_from_snapshot(data_dir, &work)?;
        let _ = remove_if_exists(&staging);
        let _ = remove_if_exists(&rollback_tmp);
        let _ = remove_if_exists(&work.rollback());
        let _ = remove_if_exists(&work.root);
        return Ok(RecoveryOutcome::Reverted {
            phase,
            had_snapshot: true,
        });
    }

    // No complete snapshot: the live device was never mutated.
    let _ = remove_if_exists(&staging);
    let _ = remove_if_exists(&rollback_tmp);
    let _ = remove_if_exists(&work.root);
    Ok(RecoveryOutcome::Cleaned { phase })
}
