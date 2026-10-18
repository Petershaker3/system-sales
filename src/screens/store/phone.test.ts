import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  brandsFor,
  cleanModel,
  gradeArabicLabel,
  isValidNationalId,
  phoneTitle,
  storageLabel,
  usedPhoneTitle,
} from './phone.ts';

// The same examples as the Rust unit test `a_phone_is_named_from_its_details`.
test('a phone is named from its company, model and storage', () => {
  assert.equal(phoneTitle('Samsung', [], 'Galaxy A16', 128), 'Samsung Galaxy A16 128GB');
  assert.equal(phoneTitle('Apple', ['iPhone'], 'iPhone 16', 128), 'iPhone 16 128GB', 'a line drops the company');
  assert.equal(phoneTitle('Xiaomi', ['Redmi', 'POCO'], 'redmi 14C', 256), 'redmi 14C 256GB', 'whatever the case');
  assert.equal(phoneTitle('Samsung', [], 'Samsung Galaxy S24', 256), 'Samsung Galaxy S24 256GB', 'never the company twice');
  assert.equal(phoneTitle('Nokia', [], '105', null), 'Nokia 105', 'a keypad phone has no storage');
  assert.equal(phoneTitle('Apple', ['iPhone'], '  iPhone   16  Pro ', 1024), 'iPhone 16 Pro 1TB');
});

test('storage reads in GB, or TB for whole terabytes', () => {
  assert.equal(storageLabel(64), '64GB');
  assert.equal(storageLabel(1024), '1TB');
  assert.equal(storageLabel(2048), '2TB');
  assert.equal(storageLabel(1536), '1536GB');
  assert.equal(cleanModel('  Galaxy   A16 '), 'Galaxy A16');
});

test('«موبايل جديد» offers the shown companies that make that kind of phone', () => {
  const brands = [
    { id: 's', deviceType: 'touch', hidden: false },
    { id: 'n', deviceType: 'both', hidden: false },
    { id: 'i', deviceType: 'keypad', hidden: false },
    { id: 'h', deviceType: 'touch', hidden: true },
  ] as const;
  assert.deepEqual(brandsFor(brands, 'touch').map((b) => b.id), ['s', 'n']);
  assert.deepEqual(brandsFor(brands, 'keypad').map((b) => b.id), ['n', 'i']);
});

test('usedPhoneTitle, gradeArabicLabel, and isValidNationalId match ADR-032 rules', () => {
  assert.equal(
    usedPhoneTitle('Samsung', [], 'Galaxy A54', 128, 'A'),
    'Samsung Galaxy A54 128GB مستعمل فئة A',
  );
  assert.equal(
    usedPhoneTitle('Apple', ['iPhone'], 'iPhone 13', 256, 'B'),
    'iPhone 13 256GB مستعمل فئة B',
  );
  assert.equal(
    usedPhoneTitle('Nokia', [], '105', null, 'C'),
    'Nokia 105 مستعمل فئة C',
  );
  assert.equal(gradeArabicLabel('A'), 'فئة A (زي الجديد)');
  assert.equal(gradeArabicLabel('B'), 'فئة B (خدوش خفيفة)');
  assert.equal(gradeArabicLabel('C'), 'فئة C (عيوب واضحة)');
  assert.equal(isValidNationalId(''), true);
  assert.equal(isValidNationalId('29501011234567'), true);
  assert.equal(isValidNationalId('2950101123456'), false);
  assert.equal(isValidNationalId('2950101123456A'), false);
});

