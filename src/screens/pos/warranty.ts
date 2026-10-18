/**
 * Default warranty periods and ISO calendar-day (`YYYY-MM-DD`) calculation for
 * POS sale lines (`docs/PLAN.md` §16, §19; `ADR-023`).
 */

import { parseCount } from '../../ui/format.ts';
import { addMonthsDate } from './receipt.ts';

export type ProductWarrantyKind = 'phone' | 'used' | 'item';

export interface WarrantySettingsSlice {
  readonly warrantyNew: string | number;
  readonly warrantyUsed: string | number;
  readonly warrantyItem: string | number;
}

export const QUICK_WARRANTY_OPTIONS: readonly {
  readonly months: number;
  readonly label: string;
}[] = [
  { months: 0, label: 'بدون ضمان' },
  { months: 1, label: 'شهر' },
  { months: 3, label: '3 شهور' },
  { months: 6, label: '6 شهور' },
  { months: 12, label: 'سنة (12 شهر)' },
  { months: 24, label: 'سنتين (24 شهر)' },
];

/**
 * Parse and clamp warranty months (`0..60`). Accepts Arabic or Latin digits.
 */
export function clampWarrantyMonths(
  raw: unknown,
  fallback: number = 0
): number {
  if (typeof raw === 'number') {
    if (!Number.isInteger(raw) || raw < 0 || raw > 60) return fallback;
    return raw;
  }
  if (typeof raw !== 'string') return fallback;
  const parsed = parseCount(raw);
  if (parsed === null || parsed < 0 || parsed > 60) return fallback;
  return parsed;
}

/**
 * Resolve default warranty months for a product category kind from Settings (`ADR-023`).
 */
export function defaultWarrantyMonthsForKind(
  kind: ProductWarrantyKind | string,
  settings: WarrantySettingsSlice
): number {
  if (kind === 'used') {
    return clampWarrantyMonths(settings.warrantyUsed, 1);
  }
  if (kind === 'phone') {
    return clampWarrantyMonths(settings.warrantyNew, 12);
  }
  return clampWarrantyMonths(settings.warrantyItem, 0);
}

/**
 * Format a `Date` as a local calendar day `YYYY-MM-DD` (matching `0013_warranty.sql`
 * and `domain::sales::WarrantyDate`).
 */
export function toIsoCalendarDate(d: Date): string {
  const y = String(d.getFullYear()).padStart(4, '0');
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Compute `warrantyStart` and `warrantyEnd` ISO calendar dates (`YYYY-MM-DD`)
 * for a sale line given its `warrantyMonths`. When `months <= 0`, both are omitted.
 */
export function warrantyDatesForMonths(
  months: number,
  saleDate: Date = new Date()
): {
  readonly warrantyStart?: string;
  readonly warrantyEnd?: string;
} {
  const m = clampWarrantyMonths(months, 0);
  if (m <= 0) {
    return {};
  }
  const start = toIsoCalendarDate(saleDate);
  const end = toIsoCalendarDate(addMonthsDate(saleDate, m));
  return {
    warrantyStart: start,
    warrantyEnd: end,
  };
}
