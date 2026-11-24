import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  describeError,
  forgetRestoreClosedTheDatabase,
  messageFor,
  noteRestoreClosedTheDatabase,
  RESTART_AFTER_RESTORE_MESSAGE,
} from './errors.ts';

test('a closed pool is explained as a restart once a restore closed it', () => {
  forgetRestoreClosedTheDatabase();
  // Before any restore, the code keeps its stock text: a storage failure that
  // happened on its own is the technician's business.
  assert.equal(
    describeError({ code: 'LOCAL_STORAGE_UNAVAILABLE' }),
    messageFor('LOCAL_STORAGE_UNAVAILABLE'),
  );

  // `restore_backup` closes the pool and never reopens it, so after a restore
  // every command answers with this code. The operator's one action is to
  // restart, not to call anybody.
  noteRestoreClosedTheDatabase();
  assert.equal(describeError({ code: 'LOCAL_STORAGE_UNAVAILABLE' }), RESTART_AFTER_RESTORE_MESSAGE);
  // The sentence is an instruction, not a shrug.
  assert.equal(RESTART_AFTER_RESTORE_MESSAGE.includes('افتحه تاني'), true);
  assert.equal(RESTART_AFTER_RESTORE_MESSAGE.includes('إبلاغ المسؤول'), false);

  // Other codes are unaffected: a packed-package failure still speaks for itself.
  assert.equal(describeError({ code: 'BACKUP_DECRYPT_FAILED' }), messageFor('BACKUP_DECRYPT_FAILED'));

  forgetRestoreClosedTheDatabase();
  assert.equal(
    describeError({ code: 'LOCAL_STORAGE_UNAVAILABLE' }),
    messageFor('LOCAL_STORAGE_UNAVAILABLE'),
  );
});
