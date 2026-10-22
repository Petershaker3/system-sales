//! Commands that act on the running application itself.
//!
//! One command, and one reason: a restore replaces `shop.db` on disk while the
//! pool that read it is closed for good (`commands::backup::restore_backup`).
//! The restored database is opened by the *next* process, so the operator has to
//! restart — and the panel that ran the restore offers that as one button instead
//! of asking them to hunt for the window's close box.

use tauri::AppHandle;

/// Restart the application (the current process exits and a new one starts).
///
/// Deliberately takes no session and checks no permission. After a restore the
/// pool is closed, so any command that resolved a session would answer
/// `LOCAL_STORAGE_UNAVAILABLE` — the very failure this button exists to end.
/// Restarting changes no data: `shop.db` on disk is already whatever the last
/// committed operation made it, and a restart is the only way back to it.
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    // `AppHandle::restart` never returns: it hands the process to a new instance.
    app.restart();
}
