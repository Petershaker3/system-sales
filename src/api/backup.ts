/**
 * Encrypted backup API (P2a, ADR-003).
 *
 * A thin typed wrapper over `invoke`. Both commands are manager-only
 * (`ManageSettings`, blanket re-authenticated) and the backend refuses any
 * other caller regardless of what the DOM offers.
 *
 * Restore semantics the UI must respect (Product Owner decision 2026-10-15):
 * a successful restore does NOT restart the app automatically — the panel
 * tells the operator to restart manually. A failed restore leaves the pool
 * closed, so every later command fails until that manual restart; the panel
 * says so instead of letting errors accumulate unexplained.
 */

import { invoke } from '@tauri-apps/api/core';

import type { CommandError } from './errors';

/** What creating a backup produced. */
export interface BackupReport {
  readonly databaseLen: number;
  readonly imageCount: number;
}

/** What restoring a backup applied. */
export interface RestoreOutcome {
  readonly databaseLen: number;
  readonly imageCount: number;
}

/**
 * Create an encrypted backup of this device's database and images.
 *
 * `output` must live inside the app's own data dir; anything else is
 * refused in Rust with `BACKUP_UNSAFE_PATH`. The password needs eight
 * characters or more (`BACKUP_PASSWORD_TOO_WEAK`).
 */
export async function createBackup(
  output: string,
  password: string,
): Promise<BackupReport> {
  return invoke<BackupReport>('create_backup', { output, password });
}

/**
 * Restore this device from a backup file.
 *
 * Fully validated before anything is touched; a wrong password, tamper or
 * truncation refuses with `BACKUP_DECRYPT_FAILED` and writes nothing.
 * On success the caller MUST prompt a manual restart — the restored
 * database is picked up at startup. On failure the caller MUST say plainly
 * that a manual restart is required before anything else can run.
 */
export async function restoreBackup(
  backupPath: string,
  password: string,
): Promise<RestoreOutcome> {
  return invoke<RestoreOutcome>('restore_backup', { backupPath, password });
}

export type { CommandError };
