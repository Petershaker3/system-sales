// The expenses section's arithmetic (`ADR-043`): the window a period means, and the
// two answers the form may offer. A wrong bound here moves money between days; a
// defaulted source moves it between the drawer and the owner's pocket.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addFixedExpense,
  categorySharePercent,
  EXPENSE_SECTION_CATEGORIES,
  drawerAvailabilityNote,
  effectivePaidFrom,
  expensePeriodBounds,
  EXPENSE_PERIODS,
  type FixedExpense,
  fixedExpenseProblem,
  MAX_FIXED_EXPENSES,
  paidFromLabel,
  parseFixedExpenses,
  removeFixedExpense,
  serializeFixedExpenses,
  suggestedCategories,
  topCategory,
} from './expenses.ts';

/** 15 October 2026, 14:30 local — a Thursday, mid-month, so every bound is distinct. */
const MID_MONTH = new Date(2026, 9, 15, 14, 30, 0, 0).getTime();

test('a period is a local calendar day, not twenty-four hours', () => {
  const today = expensePeriodBounds('today', MID_MONTH);
  const start = new Date(today.fromMs!).getTime();
  assert.equal(new Date(start).getHours(), 0, 'the window starts at local midnight');
  assert.equal(new Date(start).getDate(), 15);
  assert.equal(today.toMs, start + 86_400_000 - 1, 'and ends on the last millisecond of it');

  const yesterday = expensePeriodBounds('yesterday', MID_MONTH);
  assert.equal(yesterday.toMs, start - 1, 'yesterday ends exactly where today begins');
  assert.equal(new Date(yesterday.fromMs!).getDate(), 14);
});

test('«الشهر ده» starts on the first of the month and «الكل» has no bounds', () => {
  const month = expensePeriodBounds('month', MID_MONTH);
  assert.equal(new Date(month.fromMs!).getDate(), 1);
  assert.equal(new Date(month.fromMs!).getMonth(), 9);
  assert.equal(month.toMs, expensePeriodBounds('today', MID_MONTH).toMs);

  assert.deepEqual(expensePeriodBounds('all', MID_MONTH), { fromMs: null, toMs: null });
});

test('a week is seven days including today', () => {
  const week = expensePeriodBounds('week', MID_MONTH);
  const today = expensePeriodBounds('today', MID_MONTH);
  assert.equal(today.fromMs! - week.fromMs!, 6 * 86_400_000);
  assert.equal(week.toMs, today.toMs);
});

test('every period the seg offers has bounds, and every label is Arabic', () => {
  assert.deepEqual(
    EXPENSE_PERIODS.map((p) => p.k),
    ['today', 'yesterday', 'week', 'month', 'all'],
  );
  for (const period of EXPENSE_PERIODS) {
    assert.ok(period.label.trim() !== '', `${period.k} needs a label`);
    assert.ok(!/^[a-z]/.test(period.label), `${period.k} is shown to an Arabic speaker`);
  }
});

test('a closed drawer leaves exactly one honest source', () => {
  // With no open shift the form can only say «من برّه الدرج»; a drawer button that
  // is merely disabled would explain nothing.
  assert.equal(effectivePaidFrom(null, 'drawer'), 'outside');
  assert.equal(effectivePaidFrom(null, 'outside'), 'outside');
  assert.equal(effectivePaidFrom('shift-1', 'drawer'), 'drawer');
  assert.equal(effectivePaidFrom('shift-1', 'outside'), 'outside');

  assert.match(drawerAvailabilityNote(null), /مفيش وردية مفتوحة/);
  assert.match(drawerAvailabilityNote('shift-1'), /وردية مفتوحة/);
});

test('each source is named in words a shopkeeper uses', () => {
  assert.equal(paidFromLabel('drawer'), 'من الدرج');
  assert.equal(paidFromLabel('outside'), 'من برّه الدرج');
});

test('suggestions are the shop’s own words first, then the defaults, no duplicates', () => {
  const suggestions = suggestedCategories(['كهربا', 'كهرباء ومياه']);
  assert.deepEqual(suggestions.slice(0, 2), ['كهربا', 'كهرباء ومياه']);
  assert.ok(suggestions.includes('إيجار'), 'the defaults still fill the empty list');
  assert.equal(
    suggestions.filter((value) => value === 'إيجار').length,
    1,
    'a default the shop already used is not offered twice',
  );
  assert.deepEqual(suggestedCategories([]), [...EXPENSE_SECTION_CATEGORIES]);
});

test('a category share is a percentage of the window, floored, never over 100', () => {
  assert.equal(categorySharePercent(1000, 250), 25);
  assert.equal(categorySharePercent(1000, 999), 99, 'floored rather than rounded up');
  assert.equal(categorySharePercent(0, 0), 0, 'an empty period has no shares');
  assert.equal(categorySharePercent(1000, 2000), 100, 'a total smaller than a part is capped');
  assert.equal(categorySharePercent(-5, 10), 0);
});

test('the top category is the biggest spend, and nothing when nothing was spent', () => {
  assert.deepEqual(
    topCategory([
      { category: 'إيجار', totalMinor: 100_000 },
      { category: 'كهربا', totalMinor: 30_000 },
    ]),
    { category: 'إيجار', totalMinor: 100_000 },
  );
  assert.deepEqual(
    topCategory([
      { category: 'إيجار', totalMinor: 30_000 },
      { category: 'كهربا', totalMinor: 30_000 },
    ]),
    { category: 'إيجار', totalMinor: 30_000 },
    'a tie keeps the first, so the label does not flicker between equal rows',
  );
  assert.equal(topCategory([]), null);
  assert.equal(topCategory([{ category: 'صفر', totalMinor: 0 }]), null, 'zero is not a spend');
});

// The pinned bills (owner request 2026-10-21): storage round-trips, garbage in
// storage is not garbage on screen, and the wall has a size.
const rent: FixedExpense = {
  id: 'fx-1',
  category: 'إيجار المحل',
  amountMinor: 150_000,
  note: 'شهر أكتوبر',
  paidFrom: 'outside',
};
const power: FixedExpense = {
  id: 'fx-2',
  category: 'كهربا',
  amountMinor: 45_000,
  note: null,
  paidFrom: 'drawer',
};

test('fixed expenses round-trip through storage unchanged', () => {
  assert.deepEqual(parseFixedExpenses(serializeFixedExpenses([rent, power])), [rent, power]);
  assert.deepEqual(parseFixedExpenses(null), []);
  assert.deepEqual(parseFixedExpenses(''), []);
});

test('broken or hostile storage yields an empty wall, not a crash', () => {
  assert.deepEqual(parseFixedExpenses('مش JSON'), []);
  assert.deepEqual(parseFixedExpenses('{"category":"إيجار"}'), [], 'an object is not a list');
  assert.deepEqual(parseFixedExpenses('[{"id":"a"}]'), [], 'a row without a name or amount is dropped');
  assert.deepEqual(
    parseFixedExpenses('[{"id":"a","category":"إيجار","amountMinor":150000,"note":7,"paidFrom":"pocket"}]'),
    [{ id: 'a', category: 'إيجار', amountMinor: 150_000, note: null, paidFrom: 'outside' }],
    'an unknown source falls back to the owner’s pocket, never to the drawer',
  );
});

test('the wall keeps its size and refuses the same bill twice', () => {
  const full: FixedExpense[] = [];
  for (let i = 0; i < MAX_FIXED_EXPENSES + 5; i += 1) {
    full.push({ ...rent, id: `fx-${i}`, category: `بند ${i}` });
  }
  const parsed = parseFixedExpenses(serializeFixedExpenses(full));
  assert.equal(parsed.length, MAX_FIXED_EXPENSES);
  assert.equal(parsed[0]!.category, `بند 5`, 'when the wall is full the oldest pins give way');

  const once = addFixedExpense([], rent);
  assert.deepEqual(addFixedExpense(once, { ...rent, id: 'fx-other' }), once, 'the same bill pinned again changes nothing');
  assert.equal(addFixedExpense(once, { ...rent, amountMinor: 160_000 }).length, 2, 'a new rent is a new bill');
  assert.deepEqual(removeFixedExpense(once, 'fx-1'), []);
  assert.deepEqual(removeFixedExpense(once, 'مش موجود'), once);
});

test('a bill is pinned or recorded only when it has a name and a real amount', () => {
  assert.equal(fixedExpenseProblem('', 100), 'اكتب اسم البند الأول');
  assert.equal(fixedExpenseProblem('إيجار', null), 'اكتب المبلغ بشكل صحيح');
  assert.equal(fixedExpenseProblem('إيجار', 0), 'اكتب المبلغ بشكل صحيح');
  assert.equal(fixedExpenseProblem('إيجار', 100), '');
});
