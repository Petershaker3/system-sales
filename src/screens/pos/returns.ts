/**
 * Pure domain calculations for partial returns, exchanges, and damaged stock
 * (Plan item 1.11, `ADR-026`, `PLAN.md` §10, §19).
 */

import type {
  ReturnableSaleInspection,
  ReturnableSaleLine,
  ReturnableSalePayment,
  ReturnCondition,
  SalePaymentInput,
} from '../../api/sales.ts';

export const RETURN_REASON_PRESETS: readonly string[] = [
  'عيب صناعة',
  'غير مطابق للمطلوب',
  'استبدال بموديل أو مقاس تاني',
  'رغبة العميل',
];

export interface ReturnLineDraft {
  readonly lineId: string;
  readonly quantity: number;
  readonly condition: ReturnCondition;
}

export interface PartialLineReturnPreview {
  readonly lineId: string;
  readonly quantity: number;
  readonly condition: ReturnCondition;
  readonly unitSellingPriceMinor: number;
  readonly discountMinor: number;
  readonly lineTotalMinor: number;
  readonly lineCostMinor: number;
}

/**
 * Compute price, discount, net total, and original cost snapshot for returning
 * `returnQty` units from an original `sale_line` (`ADR-026` §3).
 */
export function computePartialLineReturn(
  line: ReturnableSaleLine,
  returnQty: number,
  condition: ReturnCondition
): PartialLineReturnPreview | null {
  const q = Math.trunc(returnQty);
  if (q <= 0 || line.remainingQty <= 0 || q > line.remainingQty) {
    return null;
  }

  const origQty = Math.max(1, line.quantity);
  const alreadyRetQty = Math.max(0, line.alreadyReturnedQty);
  const priorDiscount = Math.floor((line.discountMinor * alreadyRetQty) / origQty);
  const remainingDiscount = Math.max(0, line.discountMinor - priorDiscount);

  const discountMinor =
    q === line.remainingQty
      ? remainingDiscount
      : Math.min(
          remainingDiscount,
          Math.max(0, Math.floor((line.discountMinor * q) / origQty))
        );

  const grossMinor = q * line.unitSellingPriceMinor;
  const lineTotalMinor = Math.max(0, grossMinor - discountMinor);

  const origLineCost = line.lineCostMinor ?? 0;
  const priorCost = Math.floor((origLineCost * alreadyRetQty) / origQty);
  const remainingCost = Math.max(0, origLineCost - priorCost);
  const lineCostMinor =
    q === line.remainingQty
      ? remainingCost
      : Math.min(
          remainingCost,
          Math.max(0, Math.floor((origLineCost * q) / origQty))
        );

  return {
    lineId: line.lineId,
    quantity: q,
    condition,
    unitSellingPriceMinor: line.unitSellingPriceMinor,
    discountMinor,
    lineTotalMinor,
    lineCostMinor,
  };
}

export interface ReturnSummaryPreview {
  readonly lines: readonly PartialLineReturnPreview[];
  readonly totalQty: number;
  readonly intactQty: number;
  readonly damagedQty: number;
  readonly linesNetMinor: number;
  readonly invoiceDiscountShareMinor: number;
  readonly refundMinor: number;
  readonly intactCostMinor: number;
  readonly damagedCostMinor: number;
}

/**
 * Compute full return summary across selected lines on an inspected sale (`ADR-026` §3).
 */
export function computeReturnSummaryPreview(
  inspection: ReturnableSaleInspection,
  drafts: Readonly<Record<string, { quantity: number; condition: ReturnCondition }>>
): ReturnSummaryPreview {
  const previews: PartialLineReturnPreview[] = [];
  let totalQty = 0;
  let intactQty = 0;
  let damagedQty = 0;
  let linesNetMinor = 0;
  let intactCostMinor = 0;
  let damagedCostMinor = 0;

  let origLinesNetSubtotal = 0;
  let remainingLinesNetSubtotal = 0;

  for (const line of inspection.lines) {
    origLinesNetSubtotal += line.lineTotalMinor;
    if (line.remainingQty > 0) {
      const remPreview = computePartialLineReturn(
        line,
        line.remainingQty,
        'intact'
      );
      if (remPreview) {
        remainingLinesNetSubtotal += remPreview.lineTotalMinor;
      }
    }

    const draft = drafts[line.lineId];
    if (!draft || draft.quantity <= 0) continue;
    const p = computePartialLineReturn(line, draft.quantity, draft.condition);
    if (!p) continue;
    previews.push(p);
    totalQty += p.quantity;
    linesNetMinor += p.lineTotalMinor;
    if (p.condition === 'intact') {
      intactQty += p.quantity;
      intactCostMinor += p.lineCostMinor;
    } else {
      damagedQty += p.quantity;
      damagedCostMinor += p.lineCostMinor;
    }
  }

  if (previews.length === 0) {
    return {
      lines: [],
      totalQty: 0,
      intactQty: 0,
      damagedQty: 0,
      linesNetMinor: 0,
      invoiceDiscountShareMinor: 0,
      refundMinor: 0,
      intactCostMinor: 0,
      damagedCostMinor: 0,
    };
  }

  const origInvoiceDiscount = Math.max(
    0,
    origLinesNetSubtotal - inspection.totalMinor
  );

  let refundMinor = 0;
  let invoiceDiscountShareMinor = 0;
  if (linesNetMinor >= remainingLinesNetSubtotal && remainingLinesNetSubtotal > 0) {
    refundMinor = Math.max(0, inspection.remainingRefundableMinor);
    invoiceDiscountShareMinor = Math.max(0, linesNetMinor - refundMinor);
  } else {
    invoiceDiscountShareMinor =
      origLinesNetSubtotal > 0
        ? Math.floor((origInvoiceDiscount * linesNetMinor) / origLinesNetSubtotal)
        : 0;
    refundMinor = Math.max(0, linesNetMinor - invoiceDiscountShareMinor);
  }

  return {
    lines: previews,
    totalQty,
    intactQty,
    damagedQty,
    linesNetMinor,
    invoiceDiscountShareMinor,
    refundMinor,
    intactCostMinor,
    damagedCostMinor,
  };
}

/**
 * Allocate `refundMinor` across the original sale's payment methods by default (`PLAN.md` §10).
 */
export function allocateDefaultRefundPayments(
  payments: readonly ReturnableSalePayment[],
  refundMinor: number
): SalePaymentInput[] {
  const fallback = payments[0]?.method ?? 'cash';
  if (refundMinor <= 0) {
    return [{ method: fallback, amountMinor: 0, reference: null }];
  }

  const out: { method: string; amountMinor: number; reference: string | null }[] = [];
  let left = refundMinor;

  for (const p of payments) {
    if (left <= 0) break;
    const avail = Math.max(0, p.remainingMinor);
    const take = Math.min(left, avail);
    if (take > 0) {
      out.push({
        method: p.method,
        amountMinor: take,
        reference: p.reference ?? null,
      });
      left -= take;
    }
  }

  if (left > 0) {
    const first = out[0];
    if (first !== undefined) {
      first.amountMinor += left;
    } else {
      out.push({ method: fallback, amountMinor: left, reference: null });
    }
  }

  return out;
}

/**
 * Compute exchange net difference (`newSaleTotalMinor - refundMinor`):
 * - `> 0`: customer pays difference («فرق يدفعُه العميل»)
 * - `< 0`: customer receives difference («فرق يرجع للعميل»)
 * - `= 0`: even exchange («استبدال بدون فرق»)
 */
export function computeExchangeDifference(
  refundMinor: number,
  newSaleTotalMinor: number
): {
  readonly netDifferenceMinor: number;
  readonly direction: 'customer_pays' | 'customer_receives' | 'even';
  readonly absDifferenceMinor: number;
} {
  const netDifferenceMinor = newSaleTotalMinor - refundMinor;
  if (netDifferenceMinor > 0) {
    return {
      netDifferenceMinor,
      direction: 'customer_pays',
      absDifferenceMinor: netDifferenceMinor,
    };
  }
  if (netDifferenceMinor < 0) {
    return {
      netDifferenceMinor,
      direction: 'customer_receives',
      absDifferenceMinor: -netDifferenceMinor,
    };
  }
  return {
    netDifferenceMinor: 0,
    direction: 'even',
    absDifferenceMinor: 0,
  };
}
