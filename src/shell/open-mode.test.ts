// The open-shop flag as the shell carries it (`ADR-039`): one answer, read from
// `bootstrap_status`, and three consequences of it. The tests exist because the
// flag is the difference between a settings screen that asks for a password and
// one that does not — and because a card that forgot to clear it would hide the
// lock on a shop that has an account.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clearOpenMode,
  openMode,
  openModeHint,
  openOperatorName,
  readOpenMode,
  skipsPasswordReauth,
} from './open-mode.ts';

test('a shop with an account is not open, and keeps every prompt', () => {
  clearOpenMode();
  readOpenMode({ needsSetup: false, openMode: false, openDisplayName: null });
  assert.equal(openMode.value.active, false);
  assert.equal(openMode.value.displayName, '');
  assert.equal(skipsPasswordReauth(), false);
  assert.equal(openModeHint(), '');
});

test('the open shop is the only state that skips the password', () => {
  readOpenMode({ needsSetup: false, openMode: true, openDisplayName: 'المالك' });
  assert.equal(openMode.value.active, true);
  assert.equal(skipsPasswordReauth(), true);
  assert.match(openModeHint(), /شغال من غير حساب باسم «المالك»/);
  assert.match(openModeHint(), /اعمل حساب المالك من الإعدادات/);
  clearOpenMode();
  assert.equal(skipsPasswordReauth(), false, 'clearing must actually clear');
});

test('a broken start-up says so as setup, and is not open', () => {
  // `needsSetup` true is the fallback for a database the open row could not be
  // written to. It must not be read as the open shop, or the shell would hide the
  // lock on a device that has nothing to show.
  readOpenMode({ needsSetup: true, openMode: false, openDisplayName: null });
  assert.equal(openMode.value.active, false);
  assert.equal(skipsPasswordReauth(), false);
});

test('a row with no name of its own is called صاحب المحل, never «»', () => {
  assert.equal(openOperatorName(''), 'صاحب المحل');
  assert.equal(openOperatorName('  بيتر  '), 'بيتر');
  readOpenMode({ needsSetup: false, openMode: true, openDisplayName: null });
  assert.match(openModeHint(), /«صاحب المحل»/);
  clearOpenMode();
});
