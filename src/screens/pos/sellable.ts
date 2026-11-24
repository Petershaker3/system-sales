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
 * Pieces on the shelf.
 *
 * A phone is counted by its units — a migrated `serialized` model keeps its
 * `stock_levels` row at zero and reading it would call a full shelf «خلصان».
 *
 * But a piece does not have to carry a serial (`0035`, «الـIMEI مش إجباري»): a
 * delivery of three handsets with no numbers yet is three pieces on the shelf and
 * zero units. Reading only the units called that shelf empty and refused the sale
 * of a phone standing right there, so the answer is whichever is larger — the
 * units registered, or the pieces the stock position says exist. Both count the
 * same pieces when every one of them has a serial.
 */
export function posOnHand(
  p: { readonly id: string; readonly onHand: number },
  isSerial: boolean,
  unitCounts: Readonly<Record<string, number>>
): number {
  return isSerial ? Math.max(unitCounts[p.id] ?? 0, p.onHand) : p.onHand;
}
