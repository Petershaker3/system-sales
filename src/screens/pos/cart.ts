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
}

export interface CartLine {
  readonly productId: string;
  name: string;
  /** The catalogue price when the line was added; refreshed by `reprice`. */
  unitPriceMinor: number;
  quantity: number;
}

export interface Invoice {
  readonly id: string;
  lines: CartLine[];
  customerName: string;
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
  | { readonly ok: false; readonly reason: 'no-price' | 'out-of-stock' | 'limit'; readonly available: number };

let counter = 0;
function nextId(): string {
  counter += 1;
  return `inv-${Date.now().toString(36)}-${counter}`;
}

export function newInvoice(id: string = nextId()): Invoice {
  return { id, lines: [], customerName: '', held: false };
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

/** Add units of a product to the current invoice, merging with its line. */
export function addProduct(state: CartState, product: SellableProduct, quantity = 1): AddResult {
  if (product.priceMinor === null) return { ok: false, reason: 'no-price', available: 0 };
  const free = available(state, product);
  if (free <= 0) return { ok: false, reason: 'out-of-stock', available: 0 };
  if (quantity > free) return { ok: false, reason: 'limit', available: free };

  const inv = current(state);
  const at = inv.lines.findIndex((line) => line.productId === product.id);
  if (at >= 0) {
    const line = inv.lines[at];
    if (line !== undefined) line.quantity += quantity;
    state.selected = at;
  } else {
    inv.lines.push({ productId: product.id, name: product.name, unitPriceMinor: product.priceMinor, quantity });
    state.selected = inv.lines.length - 1;
  }
  return { ok: true };
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
  return line ?? null;
}

export function moveSelection(state: CartState, delta: number): void {
  const n = current(state).lines.length;
  if (n === 0) return;
  state.selected = state.selected < 0 ? (delta > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, state.selected + delta));
}

export interface Totals {
  readonly totalMinor: number;
  readonly count: number;
}

export function totals(inv: Invoice): Totals {
  let totalMinor = 0;
  let count = 0;
  for (const line of inv.lines) {
    totalMinor += line.unitPriceMinor * line.quantity;
    count += line.quantity;
  }
  return { totalMinor, count };
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

/** Switch to another open invoice; an empty current one is dropped, not held. */
export function switchTo(state: CartState, index: number): void {
  if (index === state.active) return;
  const now = current(state);
  const target = state.invoices[index];
  if (target === undefined) return;
  if (now.lines.length === 0 && now.customerName === '') state.invoices.splice(state.active, 1);
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
  inv.customerName = '';
  state.selected = -1;
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
  }
  state.selected = Math.min(state.selected, current(state).lines.length - 1);
  return dropped;
}
