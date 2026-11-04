// What the sales screen offers, and how much of it is free (`PosScreen.vue`).
// Pure, so the rule that kept every phone out of the search box is a test and
// not a comment (2026-11-02).

/**
 * Whether a product belongs on the sales screen.
 *
 * Counted products and phones both do. Phones were left out while «البيع بالـ
 * IMEI جاي مع وحدات الأجهزة» was unfinished, which made every device invisible
 * to search and impossible to sell; a phone is sold one piece per IMEI instead.
 * A `one_off` product keeps no balance and is sold as an individual occurrence,
 * so it stays out for now.
 */
export function isSellableInPos(p: { readonly disposition: string }): boolean {
  return p.disposition === 'quantity' || p.disposition === 'serialized';
}

/**
 * Pieces on the shelf: counted products read `stock_levels`, a phone reads its
 * own units — its `stock_levels` row stays at zero, and reading it would call
 * every phone «خلصان» on a shelf that is full.
 */
export function posOnHand(
  p: { readonly id: string; readonly onHand: number },
  isSerial: boolean,
  unitCounts: Readonly<Record<string, number>>
): number {
  return isSerial ? (unitCounts[p.id] ?? 0) : p.onHand;
}
