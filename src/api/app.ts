/**
 * The running application's own commands.
 *
 * Two calls: restart (after a restore the database pool is closed for good, so
 * the restored file is read by the next process — `components/BackupPanel.vue`),
 * and opening a WhatsApp chat in the machine's own browser, which a webview
 * cannot do by itself (`src/ui/external.ts`).
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

/**
 * Open a WhatsApp chat in the machine's browser (`commands/shell.rs`).
 *
 * The URL is checked twice — here and in Rust — because this is the one string
 * that leaves the app and reaches the operating system.
 */
export async function openExternalUrl(url: string): Promise<void> {
  await invoke('open_external_url', { url });
}
