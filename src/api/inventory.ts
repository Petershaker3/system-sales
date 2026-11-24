/**
 * Stock and costing API (SP-2, `ADR-013`, `ADR-015`).
 *
 * A thin typed wrapper over `invoke`, like the other `api/` files. Every function is a
 * use case that already exists in Rust; this file decides nothing about
 * permission, rounding or cost. In particular it never computes an average — the
 * ceiling rule lives in `domain/costing` and the value comes back from Rust
 * already rounded.
 *
 * Every product counted by quantity is costed by moving average (ADR-016 #7);
 * FIFO and switching the method were retired in plan item 1.3.
 *
 * `totalCostMinor` is nullable and the null is meaningful: `null` means the
 * product was never stocked, `0` would mean free stock. Nothing here collapses
 * them.
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * A product's stock position.
 *
 * `effectiveCostMinor` comes from Rust: the moving-average total, or zero for a
 * product nobody has received yet.
 */
export interface StockPosition {
  readonly productId: string;
  readonly quantity: number;
  /** `null` when the product was never stocked. Not the same as zero. */
  readonly totalCostMinor: number | null;
  readonly effectiveCostMinor: number;
}

/** What one movement changed. */
export interface StockOutcome {
  readonly productId: string;
  readonly quantity: number;
  /** Cost of the units removed; zero for a receipt. */
  readonly costMinor: number;
}

/** One registered `in_stock` device unit (`ADR-019`, `ADR-032`). */
export interface ProductUnit {
  readonly id: string;
  readonly productId: string;
  readonly imei: string;
  readonly imei2: string | null;
  readonly color: string | null;
  readonly unitCostMinor?: number;
  readonly conditionGrade?: 'A' | 'B' | 'C' | string | null;
  readonly batteryHealthPct?: number | null;
  readonly accessories?: string | null;
  readonly intakeNote?: string | null;
  readonly sellerName?: string | null;
  readonly sellerPhone?: string | null;
  readonly sellerNationalId?: string | null;
  readonly createdAt: number;
}

/**
 * Receive stock at a known unit cost. Routine work: no re-authentication.
 * Refuses a negative quantity or unit cost (`COST_*`).
 *
 * `supplierName` is the operator's own label for who delivered it (decision D1):
 * optional, and blank means nobody named one. There is no supplier registry and
 * no purchase document — the shop's supplier list is derived from the receipts
 * themselves, so this is a label on one delivery and nothing more.
 *
 * `imeis` is the optional list of 15-digit Luhn-checked IMEIs for serialized
 * products (`ADR-019`).
 */
export async function receiveStock(
  productId: string,
  quantity: number,
  unitCostMinor: number,
  supplierName?: string,
  imeis?: readonly string[]
): Promise<StockOutcome> {
  return invoke<StockOutcome>('receive_stock', {
    productId,
    quantity,
    unitCostMinor,
    supplierName: supplierName ?? null,
    imeis: imeis ? [...imeis] : null,
  });
}

/**
 * Receive first-time opening stock already on the shelf (`ADR-016` #30, `ADR-019`).
 * Sensitive: spends one owner PIN approval (`OWNER_APPROVAL_REQUIRED` without one)
 * and takes no supplier name.
 */
export async function receiveOpeningStock(
  productId: string,
  quantity: number,
  unitCostMinor: number,
  imeis?: readonly string[]
): Promise<StockOutcome> {
  return invoke<StockOutcome>('receive_opening_stock', {
    productId,
    quantity,
    unitCostMinor,
    imeis: imeis ? [...imeis] : null,
  });
}

/** List registered `in_stock` device units for a product (`ADR-019`). */
export async function listProductUnits(productId: string): Promise<ProductUnit[]> {
  return invoke<ProductUnit[]>('list_product_units', { productId });
}

/** List all registered `in_stock` device units across all active products (`ADR-034`, Plan item 2.4). */
export async function listAllProductUnits(): Promise<ProductUnit[]> {
  return invoke<ProductUnit[]>('list_all_product_units');
}

/**
 * Give a device its real IMEI after it was registered without one.
 *
 * A used handset with no IMEI gets the shop's own stand-in number, shown as
 * «بدون IMEI». This replaces it with the number on the box, while the piece is
 * still in stock; the backend refuses a number another device already holds.
 */
export async function setUnitImei(unitId: string, imei: string): Promise<string> {
  return invoke<string>('set_unit_imei', { unitId, imei });
}

/** One product's physical count input during a Stock Count reconciliation (`ADR-034`). */
export interface StockCountItemInput {
  readonly productId: string;
  readonly countedQuantity: number;
  readonly missingUnitIds?: readonly string[];
  readonly unitCostMinor?: number | null;
}

/** Summary of what a Stock Count reconciliation changed (`ADR-034`). */
export interface StockCountReconcileOutcome {
  readonly adjustedProducts: number;
  readonly retiredUnits: number;
  readonly netQuantityDelta: number;
  readonly netCostDeltaMinor: number;
}

/**
 * Reconcile physical stock count discrepancies and missing IMEI units (`ADR-034`, Plan item 2.4).
 * Sensitive: requires `Permission::ManageInventory` and spends one Owner PIN approval.
 */
export async function reconcileStockCount(
  reason: string,
  items: readonly StockCountItemInput[]
): Promise<StockCountReconcileOutcome> {
  return invoke<StockCountReconcileOutcome>('reconcile_stock_count', {
    reason,
    items: items.map((item) => ({
      productId: item.productId,
      countedQuantity: item.countedQuantity,
      missingUnitIds: item.missingUnitIds ? [...item.missingUnitIds] : [],
      unitCostMinor: item.unitCostMinor ?? null,
    })),
  });
}

/**
 * Remove stock and report what it cost at the moving average.
 * Refused whole when there is not enough on hand (`COST_INSUFFICIENT_STOCK`) —
 * never partially applied.
 */
export async function removeStock(
  productId: string,
  quantity: number,
  reason = ''
): Promise<StockOutcome> {
  return invoke<StockOutcome>('remove_stock', { productId, quantity, reason });
}

/**
 * Register the IMEI of ONE piece already in stock (`0035`).
 *
 * The owner's rule is that an IMEI is never mandatory, so a phone can be received
 * as loose pieces. When the number turns up later, this gives one of those pieces
 * its identity without changing the balance or the cost: the piece was already
 * counted.
 */
export async function registerStockUnit(
  productId: string,
  imei: string,
  color?: string | null
): Promise<ProductUnit> {
  return invoke<ProductUnit>('register_stock_unit', {
    productId,
    imei,
    color: color ?? null,
  });
}

/**
 * Read a position. Costs money, so it is gated behind a freshly proven password
 * exactly like the wholesale figures are; expect `REAUTHENTICATION_REQUIRED`.
 */
export async function getPosition(productId: string): Promise<StockPosition> {
  return invoke<StockPosition>('get_position', { productId });
}

/** What the whole stock is worth at cost, and how many pieces it holds. */
export interface StockValue {
  /** Cost of everything on hand, in piastres. Devices and items together. */
  readonly valueMinor: number;
  readonly quantity: number;
  readonly products: number;
}

/**
 * One answer for «قيمة المخزن بالجملة» — cost, never the sale price.
 *
 * Spends `ManageInventory` and `ViewCostAndProfit`, like `getPosition`, but asks
 * for the whole shop at once instead of one product at a time.
 */
export async function stockValue(): Promise<StockValue> {
  return invoke<StockValue>('stock_value');
}

/** One delivery in the receiving log. */
export interface ReceiptRow {
  readonly id: string;
  readonly productId: string;
  readonly productName: string;
  readonly quantity: number;
  readonly unitCostMinor: number;
  /** The label the operator typed when it came in, if he typed one. */
  readonly supplierName: string | null;
  readonly occurredAt: number;
  /** `supplier` for a purchase, `opening` for stock already on the shelf. */
  readonly receiptKind?: 'supplier' | 'opening' | null;
  /** The delivery this line belongs to: several lines share one (`0035`). */
  readonly documentId?: string | null;
  /** The supplier's own invoice/reference number, as typed (`0035`). */
  readonly documentRef?: string | null;
  /** The day the goods were bought, `YYYY-MM-DD`, when the operator said (`0035`). */
  readonly purchaseDate?: string | null;
  /** The note typed on the delivery (`0035`). */
  readonly note?: string | null;
}

/**
 * The receiving log, newest first.
 *
 * `productId` narrows it to one product's purchase history — the question a
 * shopkeeper asks at the shelf: «الصنف ده جالي إمتى ومن مين وبكام».
 */
export async function listReceipts(limit = 100, productId?: string): Promise<ReceiptRow[]> {
  return invoke<ReceiptRow[]>('list_receipts', { limit, productId: productId ?? null });
}

/** A new counted product created by the delivery itself (`0035`). */
export interface NewItemLine {
  readonly name: string;
  readonly categoryId?: string | null;
  /** `null` means «no price yet» — never `0`. */
  readonly salePriceMinor?: number | null;
}

/** A new phone model created by the delivery itself (`0035`). */
export interface NewPhoneLine {
  readonly categoryId: string;
  readonly brandId: string;
  readonly model: string;
  readonly deviceType: 'touch' | 'keypad';
  readonly storageGb?: number | null;
  readonly ramGb?: number | null;
  readonly salePriceMinor?: number | null;
}

/**
 * One line of a delivery: an existing product, or the new one it is receiving for
 * the first time. Exactly one of `productId` / `newItem` / `newPhone`.
 */
export interface ReceiveLineInput {
  readonly productId?: string | null;
  readonly newItem?: NewItemLine | null;
  readonly newPhone?: NewPhoneLine | null;
  readonly quantity: number;
  readonly unitCostMinor: number;
  readonly imeis?: readonly string[];
}

/** The paperwork typed on one delivery (`0035`). All of it is optional. */
export interface ReceiptPaperwork {
  readonly supplierName?: string | null;
  /** The supplier's own invoice/reference number. */
  readonly documentRef?: string | null;
  /** The day the goods were bought, `YYYY-MM-DD`. */
  readonly purchaseDate?: string | null;
  readonly note?: string | null;
}

/** One saved line: where it landed, and the balance afterwards. */
export interface ReceivedLine {
  readonly productId: string;
  readonly quantity: number;
}

/** What one saved delivery wrote back. */
export interface ReceivedDocument {
  readonly documentId: string;
  readonly totalQuantity: number;
  readonly lines: readonly ReceivedLine[];
}

/**
 * Save a whole delivery in ONE transaction (`0035`).
 *
 * Every line commits or none does. A line may name an existing product or
 * describe a new one, which is how «موديل جديد + أول كمية» stops being two
 * screens and two writes.
 *
 * `opening` spends one owner PIN for the whole document; the caller collects it
 * first, exactly as `receiveOpeningStock` does.
 */
export async function receiveDocument(
  receiptKind: 'supplier' | 'opening',
  paperwork: ReceiptPaperwork,
  lines: readonly ReceiveLineInput[]
): Promise<ReceivedDocument> {
  return invoke<ReceivedDocument>('receive_document', {
    receiptKind,
    supplierName: paperwork.supplierName ?? null,
    documentRef: paperwork.documentRef ?? null,
    purchaseDate: paperwork.purchaseDate ?? null,
    note: paperwork.note ?? null,
    lines: lines.map((line) => ({
      productId: line.productId ?? null,
      newItem: line.newItem ?? null,
      newPhone: line.newPhone ?? null,
      quantity: line.quantity,
      unitCostMinor: line.unitCostMinor,
      imeis: line.imeis ?? [],
    })),
  });
}
