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
