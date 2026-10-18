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
  retainBackups,
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
