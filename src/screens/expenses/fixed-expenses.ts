// Device-local templates only: selecting one fills the normal expense form.
// An expense is recorded only through recordShopExpense and its backend checks.
import type { PaidFrom } from '../../api/expenses';

export const FIXED_EXPENSES_KEY = 'mshop.fixed-expenses.v1';
export const MAX_FIXED_EXPENSES = 24;
export interface FixedExpense {
  id: string;
  category: string;
  amountMinor: number | null;
  note: string | null;
  paidFrom: PaidFrom;
}

/** Read the divergent branch's existing on-device format without rewriting bad data. */
export function parseFixedExpenses(raw: string | null): FixedExpense[] {
  if (raw === null || raw === '') return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error('invalid fixed expenses');
  const ids = new Set<string>();
  return value.map((v: unknown) => {
    if (typeof v !== 'object' || v === null) throw new Error('invalid fixed expense');
    const row = v as Record<string, unknown>;
    if (typeof row['id'] !== 'string' || !row['id'].trim() || ids.has(row['id']) ||
        typeof row['category'] !== 'string' || !row['category'].trim() ||
        !(row['amountMinor'] === null || (typeof row['amountMinor'] === 'number' && Number.isSafeInteger(row['amountMinor']) && row['amountMinor'] > 0)) ||
        !(row['note'] === null || typeof row['note'] === 'string') ||
        !(row['paidFrom'] === 'drawer' || row['paidFrom'] === 'outside')) throw new Error('invalid fixed expense');
    ids.add(row['id']);
    return v as FixedExpense; // Preserve unknown fields from a newer version.
  });
}

export function addFixedExpense(list: readonly FixedExpense[], entry: FixedExpense): FixedExpense[] {
  if (list.some(x => x.category === entry.category && x.amountMinor === entry.amountMinor && x.note === entry.note && x.paidFrom === entry.paidFrom)) return [...list];
  if (list.length >= MAX_FIXED_EXPENSES) throw new Error('fixed expense limit');
  return [...list, entry];
}

export function fixedExpenseSourceAvailable(entry: FixedExpense, openShiftId: string | null): boolean {
  return entry.paidFrom !== 'drawer' || openShiftId !== null;
}

/** Replace only the chosen template, retaining its identity and future fields. */
export function updateFixedExpense(list: readonly FixedExpense[], entry: FixedExpense): FixedExpense[] {
  if (!list.some(x => x.id === entry.id)) throw new Error('fixed expense not found');
  if (list.some(x => x.id !== entry.id && x.category === entry.category && x.amountMinor === entry.amountMinor && x.note === entry.note && x.paidFrom === entry.paidFrom)) throw new Error('duplicate fixed expense');
  return list.map(x => x.id === entry.id ? { ...x, ...entry } : x);
}
export function removeFixedExpense(list: readonly FixedExpense[], id: string): FixedExpense[] {
  return list.filter(x => x.id !== id);
}
