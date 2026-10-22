/**
 * The running application's own commands.
 *
 * One call today: restart. `restore_backup` closes the database pool and never
 * reopens it, so the restored database is read by the next process — the panel
 * that restored offers the restart as a button (`components/BackupPanel.vue`).
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * Restart the app: the current process exits and a new one starts.
 *
 * Needs no session on purpose — after a restore the pool is closed, so a command
 * that resolved a session would answer `LOCAL_STORAGE_UNAVAILABLE` instead.
 */
export async function restartApp(): Promise<void> {
  await invoke('restart_app');
}
