/**
 * Safe Sales API (Sales V1).
 *
 * A thin typed wrapper over `invoke`, mirroring `inventory.ts`. Every function
 * here is a use case that already exists in Rust; this file decides nothing
 * about permission, pricing or rounding.
 *
 * # Why a line carries no price
 *
 * `SaleLine` names a product and a quantity and nothing else. The price is read
 * from the catalogue inside the transaction that records the sale, so a stale
 * screen cannot commit a figure the catalogue no longer holds. The panel shows
 * a total the operator confirms; Rust recomputes it and refuses the sale with
 * `SALE_PRICE_CHANGED` if the two disagree.
 *
 * That is why `confirmedTotalMinor` exists and why it is optional: passing it
 * turns the call into refresh-then-confirm. Passing nothing records the sale at
 * whatever Rust currently holds, which is the right behaviour only for a caller
 * that never showed a total.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * One line of a sale: a product, how many of it, and the warranty the operator
 * typed for that item.
 *
 * `quantity` must be a positive integer. Anything else is refused with
 * `SALE_INVALID_QUANTITY`; a non-integer is refused at the transport boundary.
 *
 * `warrantyStart` / `warrantyEnd` are the operator's own dates (decision D4):
 * there is no default period and nothing is inferred. Each is an ISO calendar day
 * `YYYY-MM-DD` — a date, never an instant — and either may be omitted. A day that
 * does not exist is refused with `SALE_WARRANTY_DATE_INVALID`; a range that ends
 * before it starts is refused with `SALE_WARRANTY_RANGE_INVALID`. Both are
 * refused rather than corrected, because a warranty this software invented is a
 * promise the shop never made.
 */
export interface SaleLine {
  readonly productId: string;
  readonly quantity: number;
  readonly warrantyStart?: string;
  readonly warrantyEnd?: string;
  readonly imei?: string | null;
  readonly discountMinor?: number;
}

/**
 * What recording or cancelling a sale produced.
 *
 * `saleId` is the document just written: the sale itself, or the reversal on a
 * cancellation. `reference` is its invoice number.
 *
 * `costTotalMinor` is present but the Sales panel never renders it. Cost is
 * `ViewCostAndProfit` territory, and the Rust service decides whether the
 * caller may see it — a figure the backend refuses to disclose must not be
 * rendered just because it arrived on the wire.
 */
export interface SaleOutcome {
  readonly saleId: string;
  readonly reference: string;
  readonly totalMinor: number;
  /** Present only when `Permission::ViewCostAndProfit` is granted. Absent otherwise — not zero. */
  readonly costTotalMinor?: number;
}

/**
 * Record one cash sale.
 *
 * Routine work: it needs no re-authentication and never waits for the owner's
 * approval (ADR-017 §3).
 *
 * `confirmedTotalMinor` is the total the operator saw on screen. When it is
 * present and Rust's authoritative total differs, the sale is refused with
 * `SALE_PRICE_CHANGED` and nothing is written — the operator must see the new
 * figure and confirm it again.
 *
 * Refusals worth distinguishing to an operator: `SALE_EMPTY`,
 * `SALE_PRODUCT_ARCHIVED`, `SALE_PRICE_NOT_SET`, `SALE_INVALID_QUANTITY`,
 * `SALE_DISPOSITION_NOT_SUPPORTED` (V1 sells nothing serialised or one-off),
 * `SALE_REFERENCE_CONFLICT`, `SALE_WARRANTY_DATE_INVALID` and
 * `SALE_WARRANTY_RANGE_INVALID`, and `SALE_BUSY` (retryable).
 */
/** One payment row on a sale (`ADR-020` §2). */
export interface SalePaymentInput {
  readonly method: string;
  readonly amountMinor: number;
  readonly reference?: string | null;
}

/**
 * Record one sale (single payment or split payments, with optional customer link).
 *
 * Routine work: it needs no re-authentication and never waits for the owner's
 * approval (ADR-017 §3).
 */
export async function recordSale(
  lines: readonly SaleLine[],
  confirmedTotalMinor?: number,
  payments?: readonly SalePaymentInput[],
  customerId?: string | null,
  invoiceDiscountMinor?: number
): Promise<SaleOutcome> {
  return invoke<SaleOutcome>('record_sale', {
    lines: lines.map((line) => ({
      productId: line.productId,
      quantity: line.quantity,
      warrantyStart: line.warrantyStart ?? null,
      warrantyEnd: line.warrantyEnd ?? null,
      imei: line.imei ?? null,
      discountMinor: line.discountMinor ?? 0,
    })),
    confirmedTotalMinor: confirmedTotalMinor ?? null,
    payments:
      payments && payments.length > 0
        ? payments.map((p) => ({
            method: p.method,
            amountMinor: p.amountMinor,
            reference: p.reference ?? null,
          }))
        : null,
    customerId: customerId ?? null,
    invoiceDiscountMinor: invoiceDiscountMinor ?? 0,
  });
}

/**
 * Cancel a recorded sale by reversing it.
 *
 * A sale is never edited and never deleted: cancelling writes a reversal sale
 * that returns the stock and points at the movement it undoes, so the audit
 * trail shows both. A second cancellation is refused with
 * `SALE_ALREADY_CANCELLED` rather than reversing the reversal.
 *
 * Manager-only (`Permission::CancelTransaction`) and Sensitive: it restores
 * inventory value, so each cancellation spends one owner PIN approval and Rust
 * answers `OWNER_APPROVAL_REQUIRED` without one. Call it through
 * `withOwnerApproval` (`shell/approval.ts`), which asks for the PIN and retries
 * once.
 *
 * `reason` is recorded as written and is the operator's own account of why; it
 * is not validated into a fixed vocabulary.
 */
export async function cancelSale(saleId: string, reason: string): Promise<SaleOutcome> {
  return invoke<SaleOutcome>('cancel_sale', { saleId, reason });
}

/**
 * Attach an explicit customer link to a sale (`spec:178`, CUST-05).
 *
 * One-time and seller-gated (invoice-time): a linked sale keeps its
 * relation, and a second link is refused with
 * `SALE_CUSTOMER_ALREADY_LINKED`. Reversals take no link
 * (`SALE_LINK_NOT_ALLOWED`).
 */
export async function linkSaleCustomer(
  saleId: string,
  customerId: string,
): Promise<void> {
  return invoke<void>('link_sale_customer', { saleId, customerId });
}

/**
 * Keep a free-text customer name on an unlinked sale (`spec:178`).
 *
 * Only sales with no explicit link take a snapshot; a linked sale refuses
 * with `SALE_CUSTOMER_ALREADY_LINKED`.
 */
export async function setSaleCustomerName(
  saleId: string,
  name: string,
): Promise<void> {
  return invoke<void>('set_sale_customer_name', { saleId, name });
}