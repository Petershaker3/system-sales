//! Authorized entry points for the in-app backup commands (P2a-Rust).
//!
//! The transport layer (`commands::backup`) resolves paths and owns the process
//! lifetime; this module owns the operator check. Authorization lives here, never
//! in a command, following the settings slice exactly: resolve the session from
//! the OS credential store, then require `Permission::ManageSettings`.
//!
//! The backup bundle carries purchase prices and all device data, so it is at
//! least as sensitive as settings. Reusing `ManageSettings` (manager-only +
//! blanket re-authenticated) avoids touching the authority matrix: no new
//! permission variant, no role change.

use std::fmt;
use std::path::{Component, Path, PathBuf};

use sqlx::SqlitePool;

use crate::domain::backup::error::BackupError;
use crate::domain::identity::{DomainError, Permission};
use crate::services::identity::secure_store::SecureTokenStore;
use crate::services::identity::session as identity_session;

use super::create::{create_backup, BackupReport};

/// Everything the backup commands can refuse: identity failures (no session, no
/// permission, storage down) and backup failures (bad password, bad package,
/// unsafe path). Flattened to one stable code at the command boundary.
#[derive(Debug)]
pub enum BackupServiceError {
    Identity(DomainError),
    Backup(BackupError),
}

impl From<DomainError> for BackupServiceError {
    fn from(error: DomainError) -> Self {
        Self::Identity(error)
    }
}

impl From<BackupError> for BackupServiceError {
    fn from(error: BackupError) -> Self {
        Self::Backup(error)
    }
}

impl BackupServiceError {
    /// Delegates to the two domain enums; this layer invents no codes, so the
    /// drift guard keeps covering everything the frontend can see.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Identity(error) => error.code(),
            Self::Backup(error) => error.code(),
        }
    }
}

impl fmt::Display for BackupServiceError {
    /// Developer-facing only; the operator reads the Arabic message indexed by
    /// [`BackupServiceError::code`].
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Identity(error) => write!(f, "{error}"),
            Self::Backup(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for BackupServiceError {}

/// Resolve the current operator and require backup management.
///
/// The check only; the caller decides what happens next. Keeping it separate
/// from [`authorized_create`] is what lets the restore command authorize while
/// the pool is still open, close it, and only then touch the database file.
pub async fn authorize(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
) -> Result<(), BackupServiceError> {
    let session = identity_session::resolve(pool, tokens).await?;
    session.authorize(Permission::ManageSettings)?;
    Ok(())
}

/// Create an encrypted backup after authorizing the operator.
///
/// `output` must already be resolved with [`resolve_inside`]; this function
/// performs no path policy of its own.
pub async fn authorized_create(
    pool: &SqlitePool,
    tokens: &dyn SecureTokenStore,
    data_dir: &Path,
    output: &Path,
    password: &str,
) -> Result<BackupReport, BackupServiceError> {
    authorize(pool, tokens).await?;
    // `create_backup` copies the password into a `Zeroizing` buffer itself; the
    // caller's `&str` is borrowed and cannot be wiped here.
    let report = create_backup(pool, data_dir, output, password).await?;
    Ok(report)
}

/// Resolve a caller-supplied backup path against the application data directory.
///
/// Only relative, traversal-free paths that stay inside `data_dir` are
/// accepted. Absolute paths and any `..` that would leave the directory are
/// refused with [`BackupError::UnsafePath`]: a backup must never be written
/// outside the app data dir, and a restore must never read from outside it.
///
/// The check is lexical (no filesystem access, so symlinks cannot smuggle a
/// path out between check and use) plus a final `starts_with` confirmation.
pub fn resolve_inside(data_dir: &Path, raw: &str) -> Result<PathBuf, BackupError> {
    if raw.is_empty() {
        return Err(BackupError::UnsafePath);
    }
    let candidate = Path::new(raw);
    if candidate.is_absolute() {
        return Err(BackupError::UnsafePath);
    }
    let mut joined = PathBuf::from(data_dir);
    // Depth below `data_dir`. A `..` at depth zero would leave the directory.
    let mut depth = 0usize;
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                joined.push(part);
                depth += 1;
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return Err(BackupError::UnsafePath);
                }
                joined.pop();
                depth -= 1;
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err(BackupError::UnsafePath);
            }
        }
    }
    // A path that resolves to the directory itself (`.`, `a/..`) names no file.
    if depth == 0 {
        return Err(BackupError::UnsafePath);
    }
    // Belt and braces: the lexical build above already guarantees containment.
    if !joined.starts_with(data_dir) {
        return Err(BackupError::UnsafePath);
    }
    Ok(joined)
}
