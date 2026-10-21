/**
 * The expenses section's pure parts (`ADR-043`): its periods, its default categories,
 * and the labels it prints. Kept out of the component so they can be tested without
 * a browser.
 */

import type { PaidFrom } from '../../api/expenses';

export type ExpensePeriodKey = 'today' | 'yesterday' | 'week' | 'month' | 'all';

export const EXPENSE_PERIODS: ReadonlyArray<{
  readonly k: ExpensePeriodKey;
  readonly label: string;
}> = [
  { k: 'today', label: 'النهارده' },
  { k: 'yesterday', label: 'امبارح' },
  { k: 'week', label: 'آخر 7 أيام' },
  { k: 'month', label: 'الشهر ده' },
  { k: 'all', label: 'الكل' },
];

export interface ExpensePeriodBounds {
  readonly fromMs: number | null;
  readonly toMs: number | null;
}

/**
 * The window a period means, from the calendar day of `now`.
 *
 * Same arithmetic as the repairs screen (`repairPeriodRange`), for the same reason:
 * a day is a local calendar day, not "twenty-four hours ago", and two screens that
 * disagree about where a day starts disagree about money.
 */
export function expensePeriodBounds(
  period: ExpensePeriodKey,
  nowMs: number = Date.now()
): ExpensePeriodBounds {
  if (period === 'all') {
    return { fromMs: null, toMs: null };
  }
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + 86_400_000 - 1;
  if (period === 'today') {
    return { fromMs: startOfToday, toMs: endOfToday };
  }
  if (period === 'yesterday') {
    return { fromMs: startOfToday - 86_400_000, toMs: startOfToday - 1 };
  }
  if (period === 'week') {
    return { fromMs: startOfToday - 6 * 86_400_000, toMs: endOfToday };
  }
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return { fromMs: startOfMonth, toMs: endOfToday };
}

/**
 * The categories a shop most often spends on, offered as buttons before it has any
 * history of its own. They are suggestions, never a closed list: the field beside them
 * is free text, and the words a shop actually uses come back from its own rows.
 */
export const EXPENSE_SECTION_CATEGORIES: readonly string[] = [
  'إيجار',
  'رواتب',
  'كهرباء ومياه',
  'إنترنت وتليفون',
  'مواصلات وشحن',
  'صيانة وإصلاح',
  'ضيافة',
  'مستلزمات',
  'أخرى',
];

/** `من الدرج` / `من برّه الدرج` — one line, no invented nuance. */
export function paidFromLabel(paidFrom: PaidFrom): string {
  return paidFrom === 'drawer' ? 'من الدرج' : 'من برّه الدرج';
}

/**
 * One sentence about the form's default source.
 *
 * It reports the drawer's real state rather than a preference: with a shift open the
 * drawer is a legitimate answer, and without one the only honest answer is that the
 * money did not come out of a till nobody opened.
 */
export function drawerAvailabilityNote(openShiftId: string | null): string {
  return openShiftId === null
    ? 'مفيش وردية مفتوحة دلوقتي، فالمصروف هيتسجّل «من برّه الدرج» — ومش هيمسّ فلوس الدرج.'
    : 'فيه وردية مفتوحة — تقدر تسجّل المصروف «من الدرج» لو الفلوس خرجت من التilla، أو «من برّه الدرج» لو مدفوعة من مكان تاني.';
}

/**
 * What the source toggle does when the drawer is closed.
 *
 * A choice that cannot happen is not offered: with no open shift the only source is
 * outside, and the form says so instead of showing a disabled button that explains
 * nothing.
 */
export function effectivePaidFrom(openShiftId: string | null, chosen: PaidFrom): PaidFrom {
  return openShiftId === null ? 'outside' : chosen;
}

/** Categories to offer: the shop's own first, then the defaults it has not used yet. */
export function suggestedCategories(
  known: readonly string[],
  defaults: readonly string[] = EXPENSE_SECTION_CATEGORIES
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...known, ...defaults]) {
    const value = raw.trim();
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * A category's share of the period's spending, as a percentage rounded down.
 *
 * Used for the little bar beside each category. Returns 0 for an empty period rather
 * than dividing by zero or claiming a share nobody spent.
 */
export function categorySharePercent(totalMinor: number, partMinor: number): number {
  if (totalMinor <= 0 || partMinor <= 0) return 0;
  return Math.min(100, Math.floor((partMinor * 100) / totalMinor));
}

/** The biggest category in the period, or `null` when nothing was spent. */
export function topCategory(
  rows: readonly { readonly category: string; readonly totalMinor: number }[]
): { readonly category: string; readonly totalMinor: number } | null {
  let best: { category: string; totalMinor: number } | null = null;
  for (const row of rows) {
    if (row.totalMinor <= 0) continue;
    if (best === null || row.totalMinor > best.totalMinor) {
      best = { category: row.category, totalMinor: row.totalMinor };
    }
  }
  return best;
}

// Fixed-expense templates (owner request 2026-10-21): a recurring bill — the
// rent, the electricity, the line — gets pinned once and recorded in one tap
// after that. The templates live on this device only (`localStorage`); every
// tap still records an ordinary audited `record_shop_expense` row, so the
// ledger, its rules and its audit stay exactly as they were (`ADR-043`).

export const FIXED_EXPENSES_KEY = 'mshop.fixed-expenses.v1';

/** A wall of pinned bills stops being a shortcut; 24 is generous. */
export const MAX_FIXED_EXPENSES = 24;

export interface FixedExpense {
  id: string;
  category: string;
  /** `null` = pinned by name only; the amount is typed at recording time. */
  amountMinor: number | null;
  note: string | null;
  paidFrom: PaidFrom;
}

/** What is missing before the form can be pinned. Only the name is required —
 * the owner pins «إيجار المحل» even before this month's amount is known. */
export function fixedExpenseProblem(category: string): string {
  if (category.trim() === '') return 'اكتب اسم البند الأول';
  return '';
}

function asFixedExpense(value: unknown, fallbackId: string): FixedExpense | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const rawId = raw['id'];
  const rawCategory = raw['category'];
  const rawAmount = raw['amountMinor'];
  const rawNote = raw['note'];
  const id = typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : fallbackId;
  const category = typeof rawCategory === 'string' ? rawCategory.trim().slice(0, 80) : '';
  const amountMinor =
    typeof rawAmount === 'number' && Number.isInteger(rawAmount) && rawAmount > 0
      ? rawAmount
      : null;
  if (category === '') return null;
  const note =
    typeof rawNote === 'string' && rawNote.trim() !== '' ? rawNote.trim().slice(0, 300) : null;
  const paidFrom: PaidFrom = raw['paidFrom'] === 'drawer' ? 'drawer' : 'outside';
  return { id, category, amountMinor, note, paidFrom };
}

/** Read the stored templates. Anything unreadable is treated as an empty list. */
export function parseFixedExpenses(raw: string | null): FixedExpense[] {
  if (raw === null || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: FixedExpense[] = [];
  parsed.forEach((entry, index) => {
    const fixed = asFixedExpense(entry, `fx-${index}`);
    if (fixed !== null && out.every((kept) => kept.id !== fixed.id)) out.push(fixed);
  });
  // Same side as `addFixedExpense`: when the wall overflows, the oldest pins
  // give way — never the newest.
  return out.slice(-MAX_FIXED_EXPENSES);
}

export function serializeFixedExpenses(list: readonly FixedExpense[]): string {
  return JSON.stringify(list);
}

/**
 * Append a template unless the very same bill is already pinned (same name,
 * amount, note and source). When the wall is full the oldest pin gives way.
 */
export function addFixedExpense(
  list: readonly FixedExpense[],
  entry: FixedExpense
): FixedExpense[] {
  const duplicate = list.some(
    (kept) =>
      kept.category === entry.category &&
      kept.amountMinor === entry.amountMinor &&
      kept.note === entry.note &&
      kept.paidFrom === entry.paidFrom
  );
  if (duplicate) return [...list];
  return [...list, entry].slice(-MAX_FIXED_EXPENSES);
}

export function removeFixedExpense(list: readonly FixedExpense[], id: string): FixedExpense[] {
  return list.filter((kept) => kept.id !== id);
}
