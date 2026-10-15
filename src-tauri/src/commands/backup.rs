//! Tauri commands exposing the encrypted backup engine (P2a-Rust).
//!
//! Transport boundaries only. No SQL and no business rule appears here, and no
//! command accepts a session, token or role: the operator is resolved from the
//! OS credential store inside the use case, gated on
//! `Permission::ManageSettings` (manager-only + blanket re-authenticated).
//!
//! # Restore and the process lifetime
//!
//! Restoring replaces `shop.db` on disk, so the pool is closed first and the
//! process restarts on success (`AppHandle::restart`, verified present in the
//! pinned tauri 2.12.0): a fresh startup opens the restored database through
//! the normal path, including startup recovery. On failure the pool stays
//! closed and the command fails with the underlying backup code; the device
//! data on disk is intact (the engine reverts from its snapshot), but the app
//! must be restarted manually before any further command can succeed.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri::Manager;
use zeroize::Zeroizing;

use crate::domain::backup::error::BackupError;
use crate::services::backup::{self as use_cases, BackupServiceError};
use crate::services::identity::IdentityContext;

type Ctx<'a> = State<'a, IdentityContext>;

/// Every failure crossing the boundary is a stable code, never prose.
/// `spec:127` keeps user-facing text in Arabic message files on the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupCommandError {
    pub code: &'static str,
}

impl From<BackupServiceError> for BackupCommandError {
    fn from(error: BackupServiceError) -> Self {
        Self { code: error.code() }
    }
}

/// What a completed backup contains, for reporting without exposing secrets.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupReportDto {
    pub database_len: u64,
    pub image_count: usize,
}

/// What a completed restore did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcomeDto {
    pub database_len: u64,
    pub image_count: usize,
}

/// Write an encrypted backup of the device database and images.
///
/// `output` is a relative path inside the application data directory; absolute
/// paths and parent traversal are refused with `BACKUP_UNSAFE_PATH`.
#[tauri::command]
pub async fn create_backup(
    ctx: Ctx<'_>,
    app: AppHandle,
    output: String,
    password: String,
) -> Result<BackupReportDto, BackupCommandError> {
    // Wiped on drop. The service layer copies what it needs into its own
    // `Zeroizing` buffer the same way `create.rs` does.
    let password = Zeroizing::new(password);
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| BackupCommandError {
            code: BackupError::CreateFailed.code(),
        })?;
    let resolved =
        use_cases::resolve_inside(&data_dir, &output).map_err(BackupServiceError::from)?;
    let report = use_cases::authorized_create(
        &ctx.pool,
        ctx.tokens.as_ref(),
        &data_dir,
        &resolved,
        password.as_str(),
    )
    .await?;
    Ok(BackupReportDto {
        database_len: report.database_len,
        image_count: report.image_count,
    })
}

/// Replace the device data with a backup package, then restart.
///
/// Authorization runs while the pool is still open. The pool is then closed —
/// the engine replaces `shop.db` on disk and must not race an open connection
/// — and the package is applied on a blocking thread. On success the process
/// restarts so startup opens the restored database; this call never returns.
/// On failure the pool stays closed (fail closed: `Manager::manage` cannot
/// replace managed state and `unmanage` is deprecated as unsafe), the on-disk
/// data is intact, and the app must be restarted manually.
#[tauri::command]
pub async fn restore_backup(
    ctx: Ctx<'_>,
    app: AppHandle,
    backup_path: String,
    password: String,
) -> Result<RestoreOutcomeDto, BackupCommandError> {
    let password = Zeroizing::new(password);
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| BackupCommandError {
            code: BackupError::RestoreFailed.code(),
        })?;
    let resolved =
        use_cases::resolve_inside(&data_dir, &backup_path).map_err(BackupServiceError::from)?;

    // Authorize first: this needs the live pool, which is closed below.
    use_cases::authorize(&ctx.pool, ctx.tokens.as_ref()).await?;

    // The engine replaces `shop.db` on disk; every pooled connection must be
    // gone before it starts. From here on a failure means a manual restart.
    ctx.pool.close().await;

    let joined = tauri::async_runtime::spawn_blocking(move || {
        use_cases::restore_backup(&data_dir, &resolved, password.as_str())
    })
    .await
    .map_err(|_| BackupServiceError::Backup(BackupError::RestoreFailed))?;

    let outcome = match joined {
        Ok(outcome) => outcome,
        Err(error) => {
            // Terse by design: `Display` carries no secret and no path. The
            // specific code (wrong password, truncated file, ...) still
            // crosses the boundary so the operator sees the right message.
            eprintln!(
                "backup restore failed; the database pool is closed and a manual restart is required: {error}"
            );
            return Err(BackupServiceError::from(error).into());
        }
    };

    eprintln!(
        "backup restore applied (database_len={}, image_count={}); restarting",
        outcome.database_len, outcome.image_count
    );
    // Diverges (`-> !`, verified in the pinned tauri 2.12.0 `AppHandle`): the
    // fresh process opens the restored database through the normal startup.
    app.restart();
}
