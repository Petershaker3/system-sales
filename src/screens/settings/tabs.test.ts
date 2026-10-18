import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPrinterTogglePatch,
  formatPrinterStatusSummary,
  isTabSectionVisible,
  selectSettingsTab,
  SETTINGS_TABS,
} from './tabs.ts';

test('SETTINGS_TABS matches the 8 approved settings tabs in exact order', () => {
  assert.equal(SETTINGS_TABS.length, 8);
  assert.deepEqual(
    SETTINGS_TABS.map((t) => [t.id, t.label]),
    [
      ['shop', 'المحل'],
      ['look', 'الشكل'],
      ['catalog', 'الأصناف والبيع'],
      ['users', 'المستخدمين والصلاحيات'],
      ['pay', 'المحافظ والدفع'],
      ['receipt', 'الإيصال والضمان'],
      ['backup', 'النسخ الاحتياطي'],
      ['devices', 'الأجهزة والطابعة'],
    ],
  );
});

test('isTabSectionVisible and selectSettingsTab filter by tab and toggle back to all', () => {
  assert.equal(isTabSectionVisible('all', 'shop'), true);
  assert.equal(isTabSectionVisible('all', 'devices'), true);
  assert.equal(isTabSectionVisible('devices', 'devices'), true);
  assert.equal(isTabSectionVisible('devices', 'shop'), false);

  const picked = selectSettingsTab('all', 'devices');
  assert.equal(picked, 'devices');
  const switched = selectSettingsTab(picked, 'pay');
  assert.equal(switched, 'pay');
  const toggledBack = selectSettingsTab(switched, 'pay');
  assert.equal(toggledBack, 'all');
});

test('buildPrinterTogglePatch resets print/both receiptMode to wa when printer is turned off', () => {
  assert.deepEqual(buildPrinterTogglePatch(true, 'wa'), {
    printerEnabled: 'on',
  });
  assert.deepEqual(buildPrinterTogglePatch(false, 'print'), {
    printerEnabled: 'off',
    receiptMode: 'wa',
  });
  assert.deepEqual(buildPrinterTogglePatch(false, 'both'), {
    printerEnabled: 'off',
    receiptMode: 'wa',
  });
  assert.deepEqual(buildPrinterTogglePatch(false, 'none'), {
    printerEnabled: 'off',
  });
});

test('formatPrinterStatusSummary describes WhatsApp-only and thermal printer ready states', () => {
  const off = formatPrinterStatusSummary('off', '80');
  assert.equal(off.ready, false);
  assert.equal(off.title, 'مفيش طابعة دلوقتي');
  assert.equal(off.badge, 'واتساب بس');

  const on58 = formatPrinterStatusSummary('on', '58');
  assert.equal(on58.ready, true);
  assert.equal(on58.title, 'XP-80 (USB)');
  assert.equal(on58.badge, 'جاهزة');
  assert.ok(on58.subtitle.includes('58 مم'));
});
