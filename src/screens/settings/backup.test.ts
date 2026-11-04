import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTO_BACKUP_INTERVAL_MS,
  formatBackupLocation,
  formatBackupSize,
  formatBackupTime,
  formatBackupVerifyBadge,
  isPeriodicBackupDue,
  MAX_RETAINED_BACKUPS,
  pickDroppedBackupFile,
  restoreNeedsRestart,
  retainBackups,
  suggestedBackupFileName,
  USB_VOLUME_NAME,
} from './backup.ts';

test('formats backup sizes and locations matching the approved mockup', () => {
  assert.equal(USB_VOLUME_NAME, 'MSHOP-BACKUP');
  assert.equal(formatBackupSize(14.2 * 1024 * 1024), '14.2 MB');
  assert.equal(formatBackupSize(320 * 1024), '320 KB');
  assert.equal(formatBackupLocation(true), 'الكمبيوتر + فلاشة USB');
  assert.equal(formatBackupLocation(false), 'الكمبيوتر');
  assert.deepEqual(formatBackupVerifyBadge(true), {
    text: 'سليمة ✓',
    ok: true,
  });
  assert.deepEqual(formatBackupVerifyBadge(false), {
    text: 'غير مفحوصة',
    ok: false,
  });
});

test('formats Today and Yesterday timestamps in Arabic 12-hour format', () => {
  const now = new Date(2026, 9, 18, 15, 30, 0).getTime();
  const today2pm = new Date(2026, 9, 18, 14, 0, 0).getTime();
  const yesterday11pm = new Date(2026, 9, 17, 23, 10, 0).getTime();
  assert.equal(formatBackupTime(today2pm, now), 'اليوم 02:00 م');
  assert.equal(formatBackupTime(yesterday11pm, now), 'أمس 11:10 م');
});

test('checks the 2-hour periodic schedule and rotates to 30 retained backups', () => {
  assert.equal(MAX_RETAINED_BACKUPS, 30);
  assert.equal(isPeriodicBackupDue(null, 1000), true);
  assert.equal(
    isPeriodicBackupDue(1000, 1000 + AUTO_BACKUP_INTERVAL_MS - 1),
    false,
  );
  assert.equal(
    isPeriodicBackupDue(1000, 1000 + AUTO_BACKUP_INTERVAL_MS),
    true,
  );

  const list = Array.from({ length: 35 }, (_, idx) => ({
    id: `backup-${String(idx + 1).padStart(2, '0')}.msb`,
    createdAtUnixMs: (idx + 1) * 1000,
  }));
  const retained = retainBackups(list);
  assert.equal(retained.length, 30);
  assert.equal(retained[0]?.id, 'backup-35.msb');
  assert.equal(retained[29]?.id, 'backup-06.msb');
});

test('a dropped package is the file that gets imported, and a photo is not', () => {
  // Windows hands over absolute paths, extension included, so the panel never
  // has to ask the operator to type one.
  assert.equal(
    pickDroppedBackupFile(['C:\\Users\\peter\\Desktop\\نسخة.MSB1']),
    'C:\\Users\\peter\\Desktop\\نسخة.MSB1',
  );
  // The automatic policy writes `.msb`; a manual package is `.msb1`.
  assert.equal(pickDroppedBackupFile(['/tmp/backup-20261022-0900-abc.msb']), '/tmp/backup-20261022-0900-abc.msb');
  assert.equal(pickDroppedBackupFile(['/tmp/invoice.pdf', '/tmp/shop.msb1']), '/tmp/shop.msb1');
  assert.equal(pickDroppedBackupFile(['/tmp/invoice.pdf']), null);
  assert.equal(pickDroppedBackupFile([]), null);
});

test('the suggested name is dated, minute-precise, and inside the data dir', () => {
  const name = suggestedBackupFileName(new Date(2026, 9, 22, 14, 35, 9));
  assert.equal(name, 'backup-2026-10-22-1435.msb1');
  // No separators: a name is relative by construction, never a path.
  assert.equal(name.includes('/'), false);
  assert.equal(name.includes('\\'), false);
});

test('only a restore that closed the pool asks for a restart', () => {
  // Authorization runs before `pool.close()`, so these leave the app usable and
  // the panel must not send the operator through a pointless restart.
  for (const code of [
    'REAUTHENTICATION_REQUIRED',
    'PERMISSION_DENIED',
    'NO_ACTIVE_SESSION',
    'SESSION_IDLE_EXPIRED',
    'SESSION_LIFETIME_EXPIRED',
    'SECURE_STORAGE_UNAVAILABLE',
    'BACKUP_UNSAFE_PATH',
  ]) {
    assert.equal(restoreNeedsRestart(code), false, code);
  }
  // Everything the engine can answer after the pool is closed needs the restart.
  for (const code of [
    'BACKUP_DECRYPT_FAILED',
    'BACKUP_FILE_TRUNCATED',
    'BACKUP_HEADER_INVALID',
    'BACKUP_NOT_A_BACKUP_FILE',
    'BACKUP_UNSUPPORTED_VERSION',
    'BACKUP_RESTORE_FAILED',
  ]) {
    assert.equal(restoreNeedsRestart(code), true, code);
  }
  // Unknown fails closed, exactly like the backend.
  assert.equal(restoreNeedsRestart(undefined), true);
  assert.equal(restoreNeedsRestart(null), true);
});
