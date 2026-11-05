// The till's quick-action row: what is stored, what is shown, and the one
// invariant that keeps a saved setting from hiding a button that does not exist.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hiddenButtonList,
  hiddenButtonsSummary,
  isQuickActionShown,
  POS_QUICK_ACTIONS,
  toggleQuickAction,
} from './quick-actions.ts';

test('an empty stored list hides nothing — the row this build ships', () => {
  assert.equal(hiddenButtonList(''), '');
  for (const action of POS_QUICK_ACTIONS) {
    assert.equal(isQuickActionShown('', action.id), true, action.id);
  }
  assert.equal(hiddenButtonsSummary(''), 'الكل ظاهر');
});

test('toggling hides and shows one button at a time, in the canonical order', () => {
  const hideImei = toggleQuickAction('', 'imei');
  assert.equal(hideImei, 'imei');
  assert.equal(isQuickActionShown(hideImei, 'imei'), false);
  assert.equal(isQuickActionShown(hideImei, 'camera'), true);

  // The order is the row's order, whatever order the toggles happened in.
  const both = toggleQuickAction(hideImei, 'camera');
  assert.equal(both, 'camera,imei');
  assert.equal(toggleQuickAction(both, 'camera'), 'imei');
  assert.equal(toggleQuickAction('imei', 'imei'), '', 'showing it again stores nothing');
});

test('a stored list names the buttons to hide, never what to keep', () => {
  // A newer build added a fourth button; this stored value must not hide it.
  assert.equal(hiddenButtonList('camera,printer-app'), 'camera');
  assert.equal(isQuickActionShown('camera,printer-app', 'repair'), true);
  // Garbage, repeats and case noise all collapse to one canonical list.
  assert.equal(hiddenButtonList(' IMEI , imei , Camera '), 'camera,imei');
  assert.equal(hiddenButtonList('nonsense'), '');
});

test('the summary says what the owner will see, in his words', () => {
  assert.equal(hiddenButtonsSummary('camera'), 'مخفي: كاميرا');
  assert.equal(
    hiddenButtonsSummary('camera,repair,imei'),
    'كلهن مخفيين',
    'hiding the whole row is a state of its own, not a list of three names'
  );
});

test('the camera and the IMEI check carry the same icon', () => {
  const camera = POS_QUICK_ACTIONS.find((action) => action.id === 'camera');
  const imei = POS_QUICK_ACTIONS.find((action) => action.id === 'imei');
  assert.ok(camera && imei);
  assert.equal(camera.icon, imei.icon);
  assert.equal(camera.icon, 'scan-barcode');
});
