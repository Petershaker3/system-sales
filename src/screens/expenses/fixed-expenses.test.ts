import assert from 'node:assert/strict';
import test from 'node:test';
import { addFixedExpense, updateFixedExpense, removeFixedExpense, fixedExpenseSourceAvailable, MAX_FIXED_EXPENSES, parseFixedExpenses, type FixedExpense } from './fixed-expenses.ts';

const rent: FixedExpense = { id: 'fx-1', category: 'إيجار', amountMinor: 12345, note: null, paidFrom: 'drawer' };
test('reads the divergent branch format including optional amount', () => {
  const rows = [rent, { ...rent, id: 'fx-2', amountMinor: null, paidFrom: 'outside' }];
  assert.deepEqual(parseFixedExpenses(JSON.stringify(rows)), rows);
  assert.deepEqual(parseFixedExpenses(null), []);
});
test('invalid data or source is refused rather than silently rewritten', () => {
  assert.throws(() => parseFixedExpenses('{'));
  assert.throws(() => parseFixedExpenses(JSON.stringify([{ ...rent, paidFrom: 'wallet' }])));
  assert.throws(() => parseFixedExpenses(JSON.stringify([rent, rent])));
});
test('duplicates do not multiply and a full list never drops old templates', () => {
  assert.deepEqual(addFixedExpense([rent], { ...rent, id: 'another' }), [rent]);
  const full = Array.from({ length: MAX_FIXED_EXPENSES }, (_, i) => ({ ...rent, id: `${i}`, category: `${i}` }));
  assert.throws(() => addFixedExpense(full, rent));
  assert.equal(full.length, MAX_FIXED_EXPENSES);
});
test('a drawer template cannot silently become an outside expense', () => {
  assert.equal(fixedExpenseSourceAvailable(rent, null), false);
  assert.equal(fixedExpenseSourceAvailable(rent, 'shift'), true);
  assert.equal(fixedExpenseSourceAvailable({ ...rent, paidFrom: 'outside' }, null), true);
});

test('edit preserves identity and deletion affects only the chosen template', () => {
  const extra = { ...rent, id: 'other', category: 'كهرباء', future: 'kept' };
  const edited = updateFixedExpense([rent, extra], { ...extra, amountMinor: 999 });
  assert.equal(edited[1]?.id, 'other');
  assert.equal((edited[1] as typeof extra).future, 'kept');
  assert.deepEqual(removeFixedExpense(edited, 'fx-1'), [edited[1]]);
  assert.throws(() => updateFixedExpense([rent], { ...rent, id: 'missing' }));
});
test('same name with different amount is allowed, but editing into an exact duplicate is refused', () => {
  const other = { ...rent, id: 'fx-2', amountMinor: 100 };
  assert.equal(addFixedExpense([rent], other).length, 2);
  assert.throws(() => updateFixedExpense([rent, other], { ...rent, id: 'fx-2' }));
});
