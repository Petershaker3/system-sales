// The phone's expense draft (`ADR-043`): the same queue as a product capture, but a
// different destination. These checks are the phone-side half of the wire guard; the
// desktop checks the same rules again in Rust.
import assert from 'node:assert/strict';
import test from 'node:test';

import { draftKindLabel, validateExpenseDraft, type ExpenseDraftInput } from './companion.ts';

const ok: ExpenseDraftInput = {
  deviceName: 'موبايل بيتر',
  category: 'إيجار',
  amountMinor: 500_000,
  paidFrom: 'outside',
  note: '',
};

test('a complete expense draft is accepted', () => {
  assert.equal(validateExpenseDraft(ok), null);
});

test('the category is required and bounded, in the shop’s words', () => {
  assert.match(validateExpenseDraft({ ...ok, category: '   ' }) ?? '', /بند المصروف/);
  const problem = validateExpenseDraft({ ...ok, category: 'ا'.repeat(81) });
  assert.match(problem ?? '', /80|٨٠/);
  assert.equal(validateExpenseDraft({ ...ok, category: 'ا'.repeat(80) }), null);
});

test('the amount is a positive whole number of piastres', () => {
  assert.match(validateExpenseDraft({ ...ok, amountMinor: 0 }) ?? '', /أكبر من صفر/);
  assert.match(validateExpenseDraft({ ...ok, amountMinor: -100 }) ?? '', /أكبر من صفر/);
  assert.match(validateExpenseDraft({ ...ok, amountMinor: 12.5 }) ?? '', /أكبر من صفر/);
});

test('the note is optional but bounded', () => {
  assert.equal(validateExpenseDraft({ ...ok, note: 'إيجار أكتوبر' }), null);
  assert.match(validateExpenseDraft({ ...ok, note: 'ا'.repeat(301) }) ?? '', /الملاحظة/);
});

test('the source must be one of the two words the desktop knows', () => {
  assert.equal(validateExpenseDraft({ ...ok, paidFrom: 'drawer' }), null);
  assert.equal(validateExpenseDraft({ ...ok, paidFrom: 'outside' }), null);
  assert.match(
    validateExpenseDraft({ ...ok, paidFrom: 'cash' as never }) ?? '',
    /خرج من الدرج/,
  );
});

test('the queue reads an old row as a product and an expense as an expense', () => {
  assert.equal(draftKindLabel({ kind: '' }), 'product', 'drafts stored before expenses existed');
  assert.equal(draftKindLabel({ kind: 'product' }), 'product');
  assert.equal(draftKindLabel({ kind: 'expense' }), 'expense');
});
