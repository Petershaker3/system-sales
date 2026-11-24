/**
 * Tauri command bindings for the expenses section (`ADR-043`).
 *
 * One screen, one list: an expense is either paid out of the drawer during an open
 * shift, or paid from anywhere else. Both are the shop's money, and the section says
 * which is which instead of hiding one of them in a different screen.
 */

import { invoke } from '@tauri-apps/api/core';

export type PaidFrom = 'drawer' | 'outside';

export interface ExpenseRecord {
  readonly id: string;
  /** `null` when the money did not leave the drawer. */
  readonly shiftId: string | null;
  readonly paidFrom: PaidFrom;
  readonly category: string;
  readonly amountMinor: number;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
}

/** One row of the section: the expense, flattened beside who recorded it. */
export interface ExpenseRow extends ExpenseRecord {
  readonly createdByName: string;
}

export interface ExpenseCategoryTotal {
  readonly category: string;
  readonly totalMinor: number;
  readonly count: number;
}

export interface ExpenseOverview {
  readonly rows: readonly ExpenseRow[];
  readonly totalMinor: number;
  readonly drawerMinor: number;
  readonly outsideMinor: number;
  readonly count: number;
  readonly byCategory: readonly ExpenseCategoryTotal[];
  /** Categories this shop used before — the quick buttons in the form. */
  readonly knownCategories: readonly string[];
  /** Set while a shift is open, so «من الدرج» is offered only when it is true. */
  readonly openShiftId: string | null;
}

/**
 * Read the section for one window. Both bounds `null` is «الكل».
 *
 * The bounds are computed by the screen from the calendar day, exactly like the
 * repairs screen does (`ADR-036`), so «النهارده» means the same thing on both.
 */
export function expensesOverview(
  fromMs: number | null = null,
  toMs: number | null = null
): Promise<ExpenseOverview> {
  return invoke<ExpenseOverview>('expenses_overview', { fromMs, toMs });
}

/**
 * Record an expense. Returns the row that was written; the caller re-reads the
 * window so its totals include the new row.
 *
 * `paidFrom` is stated, never guessed: the command refuses anything but the two
 * words, because a default would decide whether a bill reduced the drawer.
 */
export function recordShopExpense(
  category: string,
  amountMinor: number,
  note: string | null,
  paidFrom: PaidFrom
): Promise<ExpenseRecord> {
  return invoke<ExpenseRecord>('record_shop_expense', {
    category,
    amountMinor,
    note,
    paidFrom,
  });
}
