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
 * `backupPath` may be absolute: the bundle arrives from another device, off a
 * USB stick, an SD card or a shared folder. A relative path is resolved inside
 * the app's data dir, and is refused in Rust if it climbs out of it
 * (`BACKUP_UNSAFE_PATH`).
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

export type BackupTriggerKind = 'manual' | 'shift_open' | 'shift_close' | 'periodic';

export interface SavedBackupEntry {
  readonly id: string;
  readonly fileName: string;
  readonly createdAtUnixMs: number;
  readonly triggerKind: BackupTriggerKind | string;
  readonly reason: string;
  readonly totalLen: number;
  readonly databaseLen: number;
  readonly imageCount: number;
  readonly verified: boolean;
  readonly usbCopied: boolean;
}

/**
 * List saved automatic and manual backups («آخر النسخ المحفوظة», `ADR-027`).
 */
export async function listSavedBackups(): Promise<SavedBackupEntry[]> {
  return invoke<SavedBackupEntry[]>('list_saved_backups');
}

/**
 * Create an automatic-policy backup immediately («خد نسخة دلوقتي», `ADR-027`).
 */
export async function createAutoBackupNow(): Promise<SavedBackupEntry> {
  return invoke<SavedBackupEntry>('create_auto_backup_now');
}

/**
 * Copy the latest backup to a connected `MSHOP-BACKUP` USB flash drive («انسخ على فلاشة», `ADR-027`).
 */
export async function copyLatestBackupToUsb(): Promise<SavedBackupEntry> {
  return invoke<SavedBackupEntry>('copy_latest_backup_to_usb');
}

/**
 * Restore a saved backup from «آخر النسخ المحفوظة» with Owner PIN approval (`ADR-027`).
 */
export async function restoreSavedBackup(backupId: string): Promise<RestoreOutcome> {
  return invoke<RestoreOutcome>('restore_saved_backup', { backupId });
}

/**
 * Run the periodic 2-hour backup and USB auto-sync tick (`ADR-027`).
 */
export async function runPeriodicBackupTick(): Promise<SavedBackupEntry | null> {
  return invoke<SavedBackupEntry | null>('run_periodic_backup_tick');
}

export type { CommandError };
