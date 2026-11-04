// «الجرد» وأرقام المخزن اللي فوقه (owner, 2026-11-02).
//
// The owner asked for the count by numbers and split into the two shelves he
// actually sells — «زراير» (keypad) and «تانش» (touch) — so the arithmetic
// lives here, away from the screen, and the screen only prints it.

export type CountScope = 'all' | 'keypad' | 'touch';
export type DeviceKind = 'touch' | 'keypad';

/**
 * Is this product a phone, or an item counted by quantity?
 *
 * `tracking` decides, not `disposition`: the app's own phones are `quantity` with
 * `serial_optional` (`services/catalog/phone.rs`), and the sale path accepts only
 * `quantity`. Reading `disposition` alone would have filed every phone the app
 * created — and every phone the migration now creates — as an accessory.
 */
export function isDeviceProduct(p: CountProductInput): boolean {
  if (p.disposition === 'one_off') return false;
  if (p.disposition === 'serialized') return true;
  return p.tracking === 'serial_optional' || p.tracking === 'serial_required';
}

/** A one-off occurrence keeps no balance, so it is in no count at all. */
export function isCountedProduct(p: CountProductInput): boolean {
  return p.disposition !== 'one_off';
}

/** The little of a catalogue product this screen reads. */
export interface CountProductInput {
  readonly id: string;
  readonly name: string;
  readonly disposition: string;
  readonly deviceType?: DeviceKind | null;
  readonly brandId?: string | null;
  readonly onHand: number;
  readonly salePriceMinor: number | null;
  /** `serial_optional` / `serial_required` for anything sold by IMEI. */
  readonly tracking?: string | null;
}

/** One line of the count sheet: a model and how many pieces the shop says it has. */
export interface CountRow {
  readonly productId: string;
  readonly name: string;
  readonly company: string;
  readonly kind: DeviceKind | null;
  readonly pieces: number;
}

export interface CountTally {
  readonly models: number;
  readonly pieces: number;
}

export const EMPTY_TALLY: CountTally = { models: 0, pieces: 0 };

export interface CountSheet {
  /** Phone models, newest shelf first as the catalogue gives them. */
  readonly rows: readonly CountRow[];
  readonly keypad: CountTally;
  readonly touch: CountTally;
  /** A phone whose shelf nobody said: «سمارت» is the app's own default. */
  readonly unknown: CountTally;
  /** Everything counted by quantity (accessories, spare parts…). */
  readonly items: CountTally;
}

function add(a: CountTally, pieces: number): CountTally {
  return { models: a.models + 1, pieces: a.pieces + pieces };
}

/**
 * The count sheet, from the sales catalogue.
 *
 * A phone with no `deviceType` is not guessed into «زراير»: guessing would put a
 * touch phone in the keypad count and make the total disagree with the shelf.
 */
export function buildCountSheet(
  products: readonly CountProductInput[],
  companyOf: (brandId: string | null) => string,
): CountSheet {
  const rows: CountRow[] = [];
  let keypad = EMPTY_TALLY;
  let touch = EMPTY_TALLY;
  let unknown = EMPTY_TALLY;
  let items = EMPTY_TALLY;

  for (const p of products) {
    if (!isCountedProduct(p)) continue;
    if (!isDeviceProduct(p)) {
      items = add(items, p.onHand);
      continue;
    }
    const kind = p.deviceType ?? null;
    const row: CountRow = {
      productId: p.id,
      name: p.name,
      company: companyOf(p.brandId ?? null),
      kind,
      pieces: p.onHand,
    };
    rows.push(row);
    if (kind === 'keypad') keypad = add(keypad, p.onHand);
    else if (kind === 'touch') touch = add(touch, p.onHand);
    else unknown = add(unknown, p.onHand);
  }

  return { rows, keypad, touch, unknown, items };
}

export function filterCountRows(rows: readonly CountRow[], scope: CountScope): CountRow[] {
  if (scope === 'all') return [...rows];
  return rows.filter((r) => r.kind === scope);
}

/** The number the owner counts against: every piece the system says is in the shop. */
export function countSheetPieces(sheet: CountSheet): number {
  return sheet.keypad.pieces + sheet.touch.pieces + sheet.unknown.pieces + sheet.items.pieces;
}

export function countScopePieces(sheet: CountSheet, scope: CountScope): number {
  if (scope === 'keypad') return sheet.keypad.pieces;
  if (scope === 'touch') return sheet.touch.pieces;
  return countSheetPieces(sheet);
}

/* --- the figures above the screen (`أهم رقم` before the content) ----------- */

export interface StoreFiguresInput {
  readonly products: readonly CountProductInput[];
  /** `unitCostMinor` is absent when the session may not see cost. */
  readonly units: readonly { readonly unitCostMinor?: number | null }[];
}

export interface StoreFigures {
  /** Devices only: the wholesale value of the phones on the shelf. `null` = no cost in view. */
  readonly deviceValueMinor: number | null;
  readonly devicePieces: number;
  readonly itemPieces: number;
  readonly totalPieces: number;
  readonly itemsCount: number;
  readonly noPriceModels: number;
}

/**
 * The four figures at the top of «المخزن».
 *
 * The value is measured at the wholesale price (cost), never at the sale price —
 * the owner's own rule (`2026-10-23`). It covers the devices, whose cost comes with
 * their units; an item's cost is behind the password-gated position read one product
 * at a time, so it is not added to a number that would then look complete.
 */
export function storeFigures(input: StoreFiguresInput): StoreFigures {
  let devicePieces = 0;
  let itemPieces = 0;
  let itemsCount = 0;
  let noPriceModels = 0;
  for (const p of input.products) {
    if (!isCountedProduct(p)) continue;
    if (isDeviceProduct(p)) {
      devicePieces += p.onHand;
      if (p.salePriceMinor === null) noPriceModels += 1;
    } else {
      itemPieces += p.onHand;
      itemsCount += 1;
    }
  }

  let value = 0;
  let hasCost = false;
  for (const u of input.units) {
    if (typeof u.unitCostMinor === 'number') {
      value += u.unitCostMinor;
      hasCost = true;
    }
  }

  return {
    deviceValueMinor: hasCost ? value : null,
    devicePieces,
    itemPieces,
    totalPieces: devicePieces + itemPieces,
    itemsCount,
    noPriceModels,
  };
}
