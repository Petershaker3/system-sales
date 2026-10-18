/**
 * Pure helpers for shift opening/closing, Egyptian denomination counting,
 * drawer difference calculation, and Arabic WhatsApp shift report formatting
 * (Plan item 1.9, `ADR-024`, `PLAN.md` §12).
 */

import type { ShiftSummary } from '../../api/shift.ts';
import { money as egp } from '../../ui/format.ts';
import { normalizeEgyptianPhone } from './receipt.ts';

/** Standard Egyptian banknotes & coins counted at shift close (`docs/ui/mockup-v1/pos.js`). */
export const EGYPTIAN_DENOMS = [200, 100, 50, 20, 10, 5, 1, 0.5] as const;

export type EgyptianDenom = (typeof EGYPTIAN_DENOMS)[number];

/** Default quick-pick categories for shop drawer expenses. */
export const DEFAULT_EXPENSE_CATEGORIES = [
  'شاي وضيافة',
  'مواصلات وشحن',
  'أكياس وتغليف',
  'كهرباء وفواتير',
  'صيانة محل',
  'نثريات',
] as const;

/** Compute total counted cash in minor units (piastres) from denomination counts. */
export function denomTotalMinor(counts: Readonly<Record<string, number>>): number {
  let totalMinor = 0;
  for (const denom of EGYPTIAN_DENOMS) {
    const raw = counts[String(denom)];
    const qty = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    const denomMinor = Math.round(denom * 100);
    totalMinor += denomMinor * qty;
  }
  return totalMinor;
}

export interface ShiftDifferenceInfo {
  readonly state: 'exact' | 'shortage' | 'overage';
  readonly label: string;
}

/** Classify `countedCashMinor - expectedCashMinor` into exact / shortage / overage. */
export function shiftDifferenceState(differenceMinor: number): ShiftDifferenceInfo {
  if (differenceMinor === 0) {
    return {
      state: 'exact',
      label: 'مظبوط — الدرج مطابق بالملليم',
    };
  }
  if (differenceMinor < 0) {
    return {
      state: 'shortage',
      label: `عجز ${egp(Math.abs(differenceMinor))}`,
    };
  }
  return {
    state: 'overage',
    label: `زيادة ${egp(differenceMinor)}`,
  };
}

/** Build the Arabic WhatsApp report text for a shift. */
export function formatShiftWhatsAppReport(
  summary: ShiftSummary,
  shopName: string,
  countedCashMinor: number,
  closeNote: string | null = null
): string {
  const { shift, totals: t } = summary;
  const diffMinor = countedCashMinor - t.expectedCashMinor;
  const diff = shiftDifferenceState(diffMinor);
  const lines: string[] = [
    `*تقرير تقفيل الوردية #${shift.shiftNumber} — ${shopName.trim() || 'موبايل ستور'}*`,
    `رصيد بداية الوردية: ${egp(t.openingCashMinor)}`,
    `+ مبيعات كاش: ${egp(t.cashSalesMinor)}`,
  ];
  if (t.customerCashInMinor > 0) {
    lines.push(`+ تحصيل آجل كاش: ${egp(t.customerCashInMinor)}`);
  }
  if (t.servicesCashInMinor > 0) {
    lines.push(`+ خدمات ومحافظ داخل الدرج: ${egp(t.servicesCashInMinor)}`);
  }
  if (t.servicesCashOutMinor > 0) {
    lines.push(`− سحب محافظ خارج من الدرج: ${egp(t.servicesCashOutMinor)}`);
  }
  if (t.walletDrawerNetMinor !== 0) {
    const sign = t.walletDrawerNetMinor > 0 ? '+' : '−';
    lines.push(
      `${sign} شحن وتفريغ المحافظ من الدرج: ${egp(Math.abs(t.walletDrawerNetMinor))}`
    );
  }
  if (t.cashInMinor > 0) {
    lines.push(`+ إيداع فكة بالدرج: ${egp(t.cashInMinor)}`);
  }
  lines.push(`− مصروفات من الدرج: ${egp(t.expensesMinor)}`);
  if (t.ownerDrawMinor > 0) {
    lines.push(`− سحب المالك: ${egp(t.ownerDrawMinor)}`);
  }
  lines.push(`*المتوقع في الدرج: ${egp(t.expectedCashMinor)}*`);
  lines.push(`*المعدود الفعلي: ${egp(countedCashMinor)}*`);
  lines.push(`الفرق: ${diff.label}`);

  const nonCashParts: string[] = [];
  if (t.vfSalesMinor > 0) nonCashParts.push(`فودافون كاش: ${egp(t.vfSalesMinor)}`);
  if (t.instapaySalesMinor > 0) nonCashParts.push(`إنستاباي: ${egp(t.instapaySalesMinor)}`);
  if (t.cardSalesMinor > 0) nonCashParts.push(`فيزا: ${egp(t.cardSalesMinor)}`);
  if (t.installSalesMinor > 0) nonCashParts.push(`تقسيط: ${egp(t.installSalesMinor)}`);
  if (t.creditSalesMinor > 0) nonCashParts.push(`آجل: ${egp(t.creditSalesMinor)}`);
  if (nonCashParts.length > 0) {
    lines.push(`طرق الدفع الأخرى: ${nonCashParts.join(' | ')}`);
  }

  lines.push(`إجمالي المبيعات (${t.salesCount} فاتورة): ${egp(t.salesTotalMinor)}`);
  if (t.servicesCount > 0 || t.servicesFeeMinor > 0) {
    lines.push(`عمولات الخدمات (${t.servicesCount} عملية): ${egp(t.servicesFeeMinor)}`);
  }
  lines.push(`صافي الربح بعد المصروفات: ${egp(t.netProfitMinor)}`);

  const cleanNote = closeNote?.trim();
  if (cleanNote) {
    lines.push(`ملاحظة: ${cleanNote}`);
  }
  return lines.join('\n');
}

/** Build the `https://wa.me/...` URL and open it (or record it under WebDriver). */
export function sendShiftReportViaWhatsApp(
  summary: ShiftSummary,
  shopName: string,
  ownerPhone: string,
  countedCashMinor: number,
  closeNote: string | null = null
): { url: string; text: string } {
  const text = formatShiftWhatsAppReport(summary, shopName, countedCashMinor, closeNote);
  const local = normalizeEgyptianPhone(ownerPhone);
  const intl = local ? `2${local}` : '';
  const base = intl ? `https://wa.me/${intl}` : 'https://wa.me/';
  const url = `${base}?text=${encodeURIComponent(text)}`;

  if (typeof window !== 'undefined') {
    (
      window as unknown as {
        __lastShiftWhatsAppSent?: {
          url: string;
          text: string;
          shiftNumber: number;
          countedCashMinor: number;
          expectedCashMinor: number;
          differenceMinor: number;
        };
      }
    ).__lastShiftWhatsAppSent = {
      url,
      text,
      shiftNumber: summary.shift.shiftNumber,
      countedCashMinor,
      expectedCashMinor: summary.totals.expectedCashMinor,
      differenceMinor: countedCashMinor - summary.totals.expectedCashMinor,
    };

    const isWebDriver = typeof navigator !== 'undefined' && navigator.webdriver === true;
    if (!isWebDriver && typeof window.open === 'function') {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }

  return { url, text };
}
