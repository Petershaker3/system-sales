/**
 * Pure helpers for the Shortages tab (`المخزن ← النواقص`, Plan item 1.15, `ADR-030`).
 *
 * Matches `docs/ui/mockup-v1/views/shortages.js` and `docs/ui/SALES-SHORTAGES.md`.
 */

import { fmtDate, fmtTime, toLatinDigits } from '../../ui/format.ts';

/**
 * Default minimum threshold (`أقل حد`) for a product (`docs/ui/mockup-v1/data.js`).
 */
export function defaultMinQty(isSerial: boolean, categoryKind?: string | null): number {
  if (categoryKind === 'used') return 1;
  if (isSerial || categoryKind === 'phone') return 2;
  return 5;
}

/**
 * Suggested reorder quantity to bring a product up to `2 × minQty` (`suggestQty` in `views/shortages.js`).
 */
export function suggestedQty(onHand: number, minQty: number): number {
  return Math.max(1, minQty * 2 - onHand);
}

/**
 * Normalize Arabic/Latin text for matching catalog products when typing a shortage name.
 */
export function normalizeShortageSearch(raw: string): string {
  return toLatinDigits(raw)
    .trim()
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .split(/\s+/)
    .join(' ');
}

/**
 * Parse the single `عميل مستني` input (`اسم أو رقم، اختياري`) into `{ customerName, customerPhone }`,
 * matching `shAddNow` in `docs/ui/mockup-v1/views/shortages.js`.
 */
export function parseWaitingCustomer(raw: string): {
  readonly customerName: string | null;
  readonly customerPhone: string | null;
} {
  const c = raw.trim();
  if (!c) {
    return { customerName: null, customerPhone: null };
  }
  const digits = toLatinDigits(c).replace(/\D/g, '');
  if (digits.length >= 8) {
    const nameOnly = toLatinDigits(c)
      .replace(/[\d\s+\-()،,]+/g, ' ')
      .trim();
    return {
      customerName: nameOnly ? nameOnly : null,
      customerPhone: digits,
    };
  }
  return {
    customerName: c,
    customerPhone: null,
  };
}

/**
 * Format when a shortage was added (`النهارده 2:40 م` / `امبارح 2:40 م` / date).
 */
export function formatShortageWhen(createdAtMs: number, now: Date = new Date()): string {
  const d = new Date(createdAtMs);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86_400_000;
  const dStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (dStart === todayStart) {
    return `النهارده ${fmtTime(d)}`;
  }
  if (dStart === yesterdayStart) {
    return `امبارح ${fmtTime(d)}`;
  }
  return fmtDate(d);
}

/**
 * Format the toast shown when a product in shortages arrives (`arrivedToasts` in `views/receive.js`).
 */
export function formatArrivedToast(entry: {
  readonly name: string;
  readonly customerName?: string | null;
  readonly customerPhone?: string | null;
}): string {
  if (entry.customerName || entry.customerPhone) {
    const who = entry.customerName || 'عميل';
    const phonePart = entry.customerPhone ? `: ${entry.customerPhone}` : '';
    return `«${entry.name}» وصل، و${who} مستنيه${phonePart}`;
  }
  return `«${entry.name}» وصل واتشال من النواقص`;
}
