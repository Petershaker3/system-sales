// The open invoices on the sales screen (docs/ui/mockup-v1/pos.js,
// «الفاتورة»). Pure state transitions, so every rule here is unit-tested
// without a browser: tests in cart.test.ts.
//
// Several invoices can be open at once: the current one and those put on
// «انتظار» (F8). Stock is checked across all of them, so two held invoices can
// never promise the same last unit twice.
//
// Prices are the catalogue's. The backend reads them again inside the sale's
// transaction and refuses a total that differs (`confirmedTotalMinor`), so this
// file only has to be right for the screen, never trusted for money.

export interface SellableProduct {
  readonly id: string;
  readonly name: string;
  readonly priceMinor: number | null;
  readonly onHand: number;
  readonly serial?: boolean;
  readonly defaultWarrantyMonths?: number;
}

export interface CartLine {
  readonly lineId?: string;
  readonly productId: string;
  name: string;
  /** The catalogue price when the line was added; refreshed by `reprice`. */
  unitPriceMinor: number;
  quantity: number;
  /** Line-level discount in piastres (`ADR-021`). */
  discountMinor?: number;
  readonly serial?: boolean;
  imei?: string | null;
  /** Warranty duration in months (`0..60`, `ADR-023`). */
  warrantyMonths?: number;
}

export interface Invoice {
  readonly id: string;
  lines: CartLine[];
  customerId: string | null;
  customerName: string;
  /** Invoice-level discount in piastres (`ADR-021`). */
  discountMinor?: number;
  held: boolean;
}

export interface CartState {
  invoices: Invoice[];
  active: number;
  /** The selected line in the active invoice, or -1. */
  selected: number;
}

export type AddResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'no-price' | 'out-of-stock' | 'limit' | 'imei-taken';
      readonly available: number;
    };

let counter = 0;
function nextId(): string {
  counter += 1;
  return `inv-${Date.now().toString(36)}-${counter}`;
}

function nextLineId(): string {
  counter += 1;
  return `ln-${Date.now().toString(36)}-${counter}`;
}

export function newInvoice(id: string = nextId()): Invoice {
  return { id, lines: [], customerId: null, customerName: '', discountMinor: 0, held: false };
}

export function newCart(): CartState {
  return { invoices: [newInvoice()], active: 0, selected: -1 };
}

export function current(state: CartState): Invoice {
  const inv = state.invoices[state.active];
  if (inv === undefined) throw new Error('cart has no active invoice');
  return inv;
}

/** Units of a product already promised on any open invoice. */
export function reserved(state: CartState, productId: string): number {
  let n = 0;
  for (const inv of state.invoices) for (const line of inv.lines) if (line.productId === productId) n += line.quantity;
  return n;
}

/** What is still free to sell of a product, after every open invoice. */
export function available(state: CartState, product: SellableProduct): number {
  return Math.max(0, product.onHand - reserved(state, product.id));
}

/** Every IMEI already promised on any open or held invoice. */
export function takenImeis(
  state: CartState,
  ignore?: { readonly invoiceIndex: number; readonly lineIndex: number }
): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < state.invoices.length; i++) {
    const inv = state.invoices[i];
    if (!inv) continue;
    for (let j = 0; j < inv.lines.length; j++) {
      if (ignore && ignore.invoiceIndex === i && ignore.lineIndex === j) continue;
      const imei = inv.lines[j]?.imei;
      if (imei) out.add(imei);
    }
  }
  return out;
}

/** Add units of a product to the current invoice, merging non-serial lines and keeping serial phones one line per unit. */
export function addProduct(
  state: CartState,
  product: SellableProduct,
  quantity = 1,
  imei: string | null = null
): AddResult {
  if (product.priceMinor === null) return { ok: false, reason: 'no-price', available: 0 };
  const free = available(state, product);
  if (free <= 0) return { ok: false, reason: 'out-of-stock', available: 0 };
  if (quantity > free) return { ok: false, reason: 'limit', available: free };
  if (imei !== null && takenImeis(state).has(imei)) {
    return { ok: false, reason: 'imei-taken', available: free };
  }

  const inv = current(state);
  const defaultWarranty =
    typeof product.defaultWarrantyMonths === 'number'
      ? Math.max(0, Math.min(60, Math.floor(product.defaultWarrantyMonths)))
      : product.serial
        ? 12
        : 0;
  if (product.serial) {
    for (let k = 0; k < quantity; k++) {
      inv.lines.push({
        lineId: nextLineId(),
        productId: product.id,
        name: product.name,
        unitPriceMinor: product.priceMinor,
        quantity: 1,
        serial: true,
        imei: k === 0 ? imei : null,
        warrantyMonths: defaultWarranty,
      });
    }
    state.selected = inv.lines.length - 1;
    return { ok: true };
  }

  const at = inv.lines.findIndex((line) => line.productId === product.id && !line.serial);
  if (at >= 0) {
    const line = inv.lines[at];
    if (line !== undefined) line.quantity += quantity;
    state.selected = at;
  } else {
    inv.lines.push({
      lineId: nextLineId(),
      productId: product.id,
      name: product.name,
      unitPriceMinor: product.priceMinor,
      quantity,
      warrantyMonths: defaultWarranty,
    });
    state.selected = inv.lines.length - 1;
  }
  return { ok: true };
}

/** Set or clear warranty months (`0..60`) on a line in the active invoice (`ADR-023`). */
export function setLineWarranty(
  state: CartState,
  lineIndex: number,
  warrantyMonths: number
): boolean {
  const inv = current(state);
  const line = inv.lines[lineIndex];
  if (!line) return false;
  if (!Number.isInteger(warrantyMonths) || warrantyMonths < 0 || warrantyMonths > 60) {
    return false;
  }
  line.warrantyMonths = warrantyMonths;
  return true;
}

/** Attach or clear an IMEI on a phone line in the active invoice. */
export function setLineImei(state: CartState, lineIndex: number, imei: string | null): boolean {
  const inv = current(state);
  const line = inv.lines[lineIndex];
  if (!line || !line.serial) return false;
  if (
    imei !== null &&
    takenImeis(state, { invoiceIndex: state.active, lineIndex }).has(imei)
  ) {
    return false;
  }
  line.imei = imei;
  return true;
}

/** Set the selected line's quantity outright (F2). Zero removes the line. */
export function setQuantity(state: CartState, product: SellableProduct, quantity: number): AddResult {
  const inv = current(state);
  const line = inv.lines[state.selected];
  if (line === undefined || line.productId !== product.id) return { ok: false, reason: 'limit', available: 0 };
  if (quantity <= 0) {
    removeLine(state, state.selected);
    return { ok: true };
  }
  const free = available(state, product) + line.quantity;
  if (quantity > free) return { ok: false, reason: 'limit', available: free };
  line.quantity = quantity;
  clampInvoiceDiscounts(inv);
  return { ok: true };
}

/** + / − on the selected line. Going below one removes it. */
export function changeQuantity(state: CartState, product: SellableProduct, delta: number): AddResult {
  const line = current(state).lines[state.selected];
  if (line === undefined) return { ok: false, reason: 'limit', available: 0 };
  return setQuantity(state, product, line.quantity + delta);
}

export function removeLine(state: CartState, index: number = state.selected): CartLine | null {
  const inv = current(state);
  const at = index < 0 ? inv.lines.length - 1 : index;
  const [line] = inv.lines.splice(at, 1);
  state.selected = Math.min(at, inv.lines.length - 1);
  clampInvoiceDiscounts(inv);
  return line ?? null;
}

export function moveSelection(state: CartState, delta: number): void {
  const n = current(state).lines.length;
  if (n === 0) return;
  state.selected = state.selected < 0 ? (delta > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, state.selected + delta));
}

export function lineGrossMinor(line: CartLine): number {
  return line.unitPriceMinor * line.quantity;
}

export function lineDiscountMinor(line: CartLine): number {
  const gross = lineGrossMinor(line);
  const raw = line.discountMinor ?? 0;
  if (raw <= 0) return 0;
  return Math.min(gross, raw);
}

export function lineNetMinor(line: CartLine): number {
  return lineGrossMinor(line) - lineDiscountMinor(line);
}

export interface DiscountSummary {
  readonly grossSubtotalMinor: number;
  readonly linesDiscountMinor: number;
  readonly linesNetSubtotalMinor: number;
  readonly invoiceDiscountMinor: number;
  readonly totalDiscountMinor: number;
  readonly netTotalMinor: number;
}

export function discountSummary(inv: Invoice): DiscountSummary {
  let grossSubtotalMinor = 0;
  let linesDiscountMinor = 0;
  for (const line of inv.lines) {
    grossSubtotalMinor += lineGrossMinor(line);
    linesDiscountMinor += lineDiscountMinor(line);
  }
  const linesNetSubtotalMinor = grossSubtotalMinor - linesDiscountMinor;
  const rawInv = inv.discountMinor ?? 0;
  const invoiceDiscountMinor =
    rawInv <= 0 ? 0 : Math.min(linesNetSubtotalMinor, rawInv);
  const totalDiscountMinor = linesDiscountMinor + invoiceDiscountMinor;
  const netTotalMinor = linesNetSubtotalMinor - invoiceDiscountMinor;
  return {
    grossSubtotalMinor,
    linesDiscountMinor,
    linesNetSubtotalMinor,
    invoiceDiscountMinor,
    totalDiscountMinor,
    netTotalMinor,
  };
}

function clampInvoiceDiscounts(inv: Invoice): void {
  let netLines = 0;
  for (const line of inv.lines) {
    const gross = lineGrossMinor(line);
    if ((line.discountMinor ?? 0) > gross) line.discountMinor = gross;
    if ((line.discountMinor ?? 0) < 0) line.discountMinor = 0;
    netLines += lineNetMinor(line);
  }
  if ((inv.discountMinor ?? 0) > netLines) inv.discountMinor = netLines;
  if ((inv.discountMinor ?? 0) < 0) inv.discountMinor = 0;
}

/**
 * Compute a discount in piastres from either a fixed piastre amount or a
 * percentage (`0..=100`), returning `null` when out of range (`ADR-021`).
 */
export function computeDiscountMinor(
  baseMinor: number,
  mode: 'amount' | 'percent',
  value: number
): number | null {
  if (!Number.isFinite(value) || value < 0 || baseMinor < 0) return null;
  if (mode === 'amount') {
    const rounded = Math.round(value);
    if (rounded < 0 || rounded > baseMinor) return null;
    return rounded;
  }
  if (value > 100) return null;
  const computed = Math.round((baseMinor * value) / 100);
  return Math.min(baseMinor, Math.max(0, computed));
}

/**
 * Exact integer comparison matching Rust's `discount_exceeds_limit`:
 * `totalDiscountMinor * 100 > grossSubtotalMinor * limitPct`.
 */
export function discountExceedsSellerLimit(
  grossSubtotalMinor: number,
  totalDiscountMinor: number,
  limitPct: number
): boolean {
  if (totalDiscountMinor <= 0) return false;
  if (grossSubtotalMinor <= 0) return true;
  return totalDiscountMinor * 100 > grossSubtotalMinor * limitPct;
}

/** Apply or clear a discount on a line in the active invoice (`ADR-021`). */
export function setLineDiscount(
  state: CartState,
  lineIndex: number,
  discountMinor: number
): boolean {
  const inv = current(state);
  const line = inv.lines[lineIndex];
  if (!line) return false;
  const gross = lineGrossMinor(line);
  if (!Number.isInteger(discountMinor) || discountMinor < 0 || discountMinor > gross) {
    return false;
  }
  line.discountMinor = discountMinor;
  clampInvoiceDiscounts(inv);
  return true;
}

/** Apply or clear an invoice-level discount on the active invoice (`ADR-021`). */
export function setInvoiceDiscount(
  state: CartState,
  discountMinor: number
): boolean {
  const inv = current(state);
  const { linesNetSubtotalMinor } = discountSummary(inv);
  if (
    !Number.isInteger(discountMinor) ||
    discountMinor < 0 ||
    discountMinor > linesNetSubtotalMinor
  ) {
    return false;
  }
  inv.discountMinor = discountMinor;
  return true;
}

export interface Totals {
  readonly totalMinor: number;
  readonly count: number;
}

export function totals(inv: Invoice): Totals {
  let count = 0;
  for (const line of inv.lines) {
    count += line.quantity;
  }
  const { netTotalMinor } = discountSummary(inv);
  return { totalMinor: netTotalMinor, count };
}

/** F8: put the current invoice on hold and open a fresh one. */
export function hold(state: CartState): boolean {
  const inv = current(state);
  if (inv.lines.length === 0) return false;
  inv.held = true;
  state.invoices.push(newInvoice());
  state.active = state.invoices.length - 1;
  state.selected = -1;
  return true;
}

/** `+` tab button: open a new invoice (holding the current one if it has items). */
export function openNewInvoice(state: CartState): boolean {
  const inv = current(state);
  if (inv.lines.length === 0) return false;
  return hold(state);
}

/** Switch to another open invoice; an empty current one is dropped, not held. */
export function switchTo(state: CartState, index: number): void {
  if (index === state.active) return;
  const now = current(state);
  const target = state.invoices[index];
  if (target === undefined) return;
  if (now.lines.length === 0 && now.customerName === '' && now.customerId === null)
    state.invoices.splice(state.active, 1);
  else now.held = true;
  target.held = false;
  state.active = state.invoices.indexOf(target);
  state.selected = target.lines.length - 1;
}

/** Cancel a held invoice. The current one is cleared instead (see `clear`). */
export function drop(state: CartState, index: number): void {
  if (index === state.active) return;
  const keep = current(state);
  state.invoices.splice(index, 1);
  state.active = state.invoices.indexOf(keep);
}

export function clear(state: CartState): void {
  const inv = current(state);
  inv.lines = [];
  inv.customerId = null;
  inv.customerName = '';
  inv.discountMinor = 0;
  state.selected = -1;
}

/** Attach or clear a customer on the current invoice (`ADR-020` §3). */
export function setInvoiceCustomer(
  state: CartState,
  customerId: string | null,
  customerName = ''
): void {
  const inv = current(state);
  inv.customerId = customerId;
  inv.customerName = customerName;
}

/** After a sale: the paid invoice closes and the next held one (or a fresh one) opens. */
export function closePaid(state: CartState): void {
  state.invoices.splice(state.active, 1);
  if (state.invoices.length === 0) state.invoices.push(newInvoice());
  const fresh = state.invoices.findIndex((inv) => !inv.held);
  if (fresh >= 0) state.active = fresh;
  else {
    state.invoices.push(newInvoice());
    state.active = state.invoices.length - 1;
  }
  state.selected = -1;
}

/** Change for a cash payment, or `null` when the cash does not cover the total. */
export function changeDue(totalMinor: number, cashMinor: number): number | null {
  return cashMinor >= totalMinor ? cashMinor - totalMinor : null;
}

/**
 * Bring every open invoice in line with a freshly read catalogue: new prices
 * and names are taken, and lines whose product can no longer be sold (archived,
 * or its price removed) are dropped. Returns the names of the dropped lines.
 */
export function reprice(state: CartState, catalogue: readonly SellableProduct[]): string[] {
  const byId = new Map(catalogue.map((product) => [product.id, product]));
  const dropped: string[] = [];
  for (const inv of state.invoices) {
    inv.lines = inv.lines.filter((line) => {
      const product = byId.get(line.productId);
      if (product === undefined || product.priceMinor === null) {
        dropped.push(line.name);
        return false;
      }
      line.unitPriceMinor = product.priceMinor;
      line.name = product.name;
      return true;
    });
    clampInvoiceDiscounts(inv);
  }
  state.selected = Math.min(state.selected, current(state).lines.length - 1);
  return dropped;
}
