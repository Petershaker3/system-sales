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
