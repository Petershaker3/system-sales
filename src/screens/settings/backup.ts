/**
 * Pure helpers for the Automatic Backup Policy settings card and saved-backups table
 * (`docs/PLAN.md` §17, §19; `ADR-027`; `docs/ui/mockup-v1/views/settings.js` `setBackup()`).
 */

export const MAX_RETAINED_BACKUPS = 30;
export const AUTO_BACKUP_INTERVAL_MS = 2 * 60 * 60 * 1000;
export const USB_VOLUME_NAME = 'MSHOP-BACKUP';

export function formatBackupSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${Math.round(bytes)} B`;
}

export function formatBackupLocation(usbCopied: boolean): string {
  return usbCopied ? 'الكمبيوتر + فلاشة USB' : 'الكمبيوتر';
}

export function formatBackupVerifyBadge(verified: boolean): {
  readonly text: string;
  readonly ok: boolean;
} {
  return verified
    ? { text: 'سليمة ✓', ok: true }
    : { text: 'غير مفحوصة', ok: false };
}

function format12hClock(date: Date): string {
  const hours24 = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const period = hours24 >= 12 ? 'م' : 'ص';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  return `${String(hours12).padStart(2, '0')}:${minutes} ${period}`;
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

export function formatBackupTime(
  createdAtUnixMs: number,
  nowMs: number = Date.now(),
): string {
  const d = new Date(createdAtUnixMs);
  const now = new Date(nowMs);
  const dayDiff = Math.round(
    (startOfLocalDay(now) - startOfLocalDay(d)) / (24 * 60 * 60 * 1000),
  );
  const clock = format12hClock(d);
  if (dayDiff === 0) return `اليوم ${clock}`;
  if (dayDiff === 1) return `أمس ${clock}`;
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${clock}`;
}

export function isPeriodicBackupDue(
  lastCreatedAtUnixMs: number | null | undefined,
  nowMs: number,
): boolean {
  if (lastCreatedAtUnixMs === null || lastCreatedAtUnixMs === undefined) {
    return true;
  }
  return nowMs - lastCreatedAtUnixMs >= AUTO_BACKUP_INTERVAL_MS;
}

export function retainBackups<
  T extends { readonly createdAtUnixMs: number; readonly id: string },
>(entries: readonly T[], maxRetained: number = MAX_RETAINED_BACKUPS): T[] {
  const sorted = [...entries].sort((a, b) => {
    if (b.createdAtUnixMs !== a.createdAtUnixMs) {
      return b.createdAtUnixMs - a.createdAtUnixMs;
    }
    return b.id.localeCompare(a.id);
  });
  return sorted.slice(0, Math.max(1, maxRetained));
}

// --- the manual import/export panel ----------------------------------------
//
// Three small decisions the panel must get right, kept here so `node --test` can
// prove them without a WebView:
//
//  1. Which file a drop hands over (the operator should never type a path).
//  2. What the suggested file name is, so creating a backup is one click.
//  3. Whether a failed restore left the app usable or killed the pool.
//
// (3) matters most. `commands::backup::restore_backup` authorizes BEFORE it closes
// the pool, so a refusal for identity reasons (`REAUTHENTICATION_REQUIRED`, no
// permission, dead session) or an unsafe path leaves every later command working.
// Every other failure happens AFTER `pool.close()` and the pool never reopens, so
// the panel must tell the operator to restart. Telling them to restart when the
// real answer is «type your password» is what turned one refusal into a closed
// app and a second, identical refusal after the restart.

/** The file names this shop's backups carry, as the operator sees them. */
export const BACKUP_FILE_SUFFIXES: readonly string[] = ['.msb1', '.msb'];

/**
 * The first dropped file that is a backup package, or `null`.
 *
 * Windows drag-and-drop hands over absolute paths, extension included, so this is
 * purely a filter: a dropped photo or a shortcut must not overwrite the path the
 * operator already chose.
 */
export function pickDroppedBackupFile(paths: readonly string[]): string | null {
  for (const raw of paths) {
    const path = raw.trim();
    const lower = path.toLowerCase();
    if (path === '') continue;
    if (BACKUP_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) return path;
  }
  return null;
}

/** `backup-2026-10-22-1435.msb1` — local time, minute precision, no colons. */
export function suggestedBackupFileName(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}`;
  return `backup-${stamp}.msb1`;
}

/**
 * Codes the restore command can answer with while the pool is still open.
 *
 * `BACKUP_UNSAFE_PATH` is resolved before authorization; the identity codes come
 * from `authorize`, which is the last thing that runs before `pool.close()`.
 */
const RESTORE_REFUSED_WHILE_STILL_OPEN: ReadonlySet<string> = new Set([
  'REAUTHENTICATION_REQUIRED',
  'PERMISSION_DENIED',
  'NO_ACTIVE_SESSION',
  'SESSION_IDLE_EXPIRED',
  'SESSION_LIFETIME_EXPIRED',
  'SECURE_STORAGE_UNAVAILABLE',
  'ACCOUNT_DISABLED',
  'BACKUP_UNSAFE_PATH',
]);

/**
 * Does this restore failure require a manual restart before anything else works?
 *
 * `true` for every package failure (wrong password, truncated file, unsupported
 * version) because the pool is already closed by then — and for an unknown code,
 * which fails closed like the backend does.
 */
export function restoreNeedsRestart(code: string | null | undefined): boolean {
  if (code === null || code === undefined) return true;
  return !RESTORE_REFUSED_WHILE_STILL_OPEN.has(code);
}
