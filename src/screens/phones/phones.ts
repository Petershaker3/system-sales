// The shop's phones, as one section (`screens/phones/PhonesScreen.vue`).
//
// A phone shop does not think in «quantity products»: it thinks in handsets —
// this model, this IMEI, this cost, this one is used. The data for that exists
// already (`list_all_product_units` + the catalogue) but it lived inside «المخزن»
// and «وضع البيع», so the owner had to assemble the picture himself.
//
// Everything here is pure: the screen reads, these functions count. The two
// questions the owner asked for are both functions of one list — «الجرد بالعدد»
// and «الجرد بالفلوس» — so they cannot disagree with each other by a bug in the
// screen.

import { normalize } from '../../ui/arabic.ts';

/** The part of a registered device this section needs (`api/inventory.ts`). */
export interface PhoneUnitLike {
  readonly id: string;
  readonly productId: string;
  readonly imei: string;
  readonly imei2?: string | null;
  readonly color?: string | null;
  readonly unitCostMinor?: number;
  readonly conditionGrade?: string | null;
  readonly batteryHealthPct?: number | null;
  readonly sellerName?: string | null;
  readonly createdAt: number;
}

/** The part of a product this section needs (`api/catalog.ts`). */
export interface PhoneProductLike {
  readonly id: string;
  readonly name: string;
  readonly salePriceMinor: number | null;
  readonly disposition: string;
  readonly categoryId?: string | null;
  readonly status?: string;
  /**
   * The stock counter (`pos_catalog`). A serialized product can hold stock whose
   * IMEIs were never registered — the shop received a box and typed the quantity
   * — so the model's shelf is `registered + unregistered`, never just the units.
   */
  readonly onHand?: number;
  /** `serial_optional` / `serial_required` for anything sold by IMEI (`ADR-019`). */
  readonly tracking?: string;
}

/** One model of phone, with what the shop has of it. */
export interface PhoneModelRow {
  readonly productId: string;
  readonly name: string;
  /** Sale price as the catalogue has it; `null` means «not priced yet», not zero. */
  readonly salePriceMinor: number | null;
  /** Handsets on the shelf right now: registered units plus unregistered stock. */
  readonly available: number;
  /**
   * Stock the stock counter holds but no handset row accounts for. Not an error —
   * a box of phones can be received by quantity — but an unregistered phone has no
   * IMEI to sell, so the screen says how many and where to fix it.
   */
  readonly unregistered: number;
  readonly usedCount: number;
  readonly newCount: number;
  /** What the shelf cost, summed from each handset's own cost. */
  readonly costMinor: number;
  /** What the shelf is expected to bring at the catalogue price (`null` with no price). */
  readonly saleMinor: number | null;
  /** Average cost per handset, rounded down to the piastre; zero when none is held. */
  readonly avgCostMinor: number;
  /** The newest handset, for «آخر استلام» — the shelf's freshness at a glance. */
  readonly newestAt: number;
}

/**
 * Is this handset used rather than new?
 *
 * A used phone is registered with its condition (and usually a battery health);
 * a new one has neither (`ADR-032` — the two registrations differ in exactly
 * those fields). Reading it from the fields rather than from the category keeps
 * the answer true even when a shop files a used phone under the new-phones tree.
 */
export function isUsedUnit(unit: PhoneUnitLike): boolean {
  if (unit.conditionGrade !== null && unit.conditionGrade !== undefined && unit.conditionGrade !== '') {
    return true;
  }
  return unit.batteryHealthPct !== null && unit.batteryHealthPct !== undefined;
}

/**
 * Which catalogue products are phones.
 *
 * Three ways a handset can be filed, and all three are the same thing to a shop:
 *   * `serialized` — the disposition that owns IMEIs;
 *   * `one_off` — the single-handset product a small shop makes when it buys one
 *     trade-in;
 *   * `serial_optional` / `serial_required` tracking — a phone that was registered
 *     as a tracked product and keeps a counter of its own.
 *
 * Reading tracking as well as disposition matters: a phone registered before the
 * dispositions split is still a phone. An archived product is not — nobody sells
 * it, so there is nothing to count.
 */
export function isPhoneProduct(product: PhoneProductLike): boolean {
  if (product.status === 'archived') return false;
  if (product.disposition === 'serialized' || product.disposition === 'one_off') return true;
  return product.tracking === 'serial_optional' || product.tracking === 'serial_required';
}

/** Group handsets under their models, biggest shelf value first. */
export function buildPhoneModels(
  products: readonly PhoneProductLike[],
  units: readonly PhoneUnitLike[],
): PhoneModelRow[] {
  const byId = new Map(products.filter(isPhoneProduct).map((p) => [p.id, p]));
  const rows = new Map<string, PhoneModelRow & { costMinor: number; saleMinor: number | null; registered: number }>();

  // Every phone model starts on the list, even with an empty shelf: «الرصيد صفر»
  // is a fact the owner wants to see, not a row that disappears.
  for (const product of byId.values()) {
    rows.set(product.id, {
      productId: product.id,
      name: product.name,
      salePriceMinor: product.salePriceMinor,
      available: 0,
      unregistered: 0,
      usedCount: 0,
      newCount: 0,
      costMinor: 0,
      saleMinor: 0,
      avgCostMinor: 0,
      newestAt: 0,
      registered: 0,
    });
  }

  for (const unit of units) {
    const product = byId.get(unit.productId);
    // A handset whose product was archived (or is not a phone at all) still holds
    // money on the shelf, so it is counted under its own name rather than dropped.
    const row = rows.get(unit.productId) ?? {
      productId: unit.productId,
      name: product?.name ?? 'صنف مش في الكتالوج',
      salePriceMinor: product?.salePriceMinor ?? null,
      available: 0,
      unregistered: 0,
      usedCount: 0,
      newCount: 0,
      costMinor: 0,
      saleMinor: 0,
      avgCostMinor: 0,
      newestAt: 0,
      registered: 0,
    };
    const used = isUsedUnit(unit);
    const cost = unit.unitCostMinor ?? 0;
    rows.set(unit.productId, {
      ...row,
      available: row.available + 1,
      registered: row.registered + 1,
      usedCount: row.usedCount + (used ? 1 : 0),
      newCount: row.newCount + (used ? 0 : 1),
      costMinor: row.costMinor + cost,
      newestAt: Math.max(row.newestAt, unit.createdAt),
    });
  }

  return [...rows.values()]
    .map(({ registered, ...row }) => {
      const onHand = byId.get(row.productId)?.onHand ?? registered;
      const available = Math.max(registered, onHand);
      return {
        ...row,
        available,
        unregistered: available - registered,
        // What the shelf would bring: every handset on it, at the catalogue price.
        // Computing it from the registered units alone under-reported the shelf of
        // a shop that received a box by quantity.
        saleMinor: row.salePriceMinor === null ? null : row.salePriceMinor * available,
        // The average is over the handsets whose cost is known — an unregistered
        // one has no cost figure anywhere, and inventing one would put a made-up
        // number in the owner's shelf value.
        avgCostMinor: registered === 0 ? 0 : Math.floor(row.costMinor / registered),
      };
    })
    .sort((a, b) => {
      if (b.costMinor !== a.costMinor) return b.costMinor - a.costMinor;
      return a.name.localeCompare(b.name);
    });
}

/** The two totals the owner asked for: how many, and how much. */
export interface PhoneTotals {
  readonly models: number;
  readonly units: number;
  /** Of those units, how many exist only as a number in the stock counter. */
  readonly unregistered: number;
  readonly usedUnits: number;
  /** What the shelf cost. */
  readonly costMinor: number;
  /** What it would bring at catalogue prices; `null` while some model has no price. */
  readonly saleMinor: number | null;
  /**
   * Sale minus cost — `null` until both halves are known for **every** handset.
   *
   * A handset received by quantity has no cost row, so the shelf's cost would be
   * understated and the «profit» would come out negative and meaningless. The
   * screen says «فيه أجهزة من غير تكلفة» instead of printing a number that is
   * arithmetically true and practically a lie.
   */
  readonly expectedProfitMinor: number | null;
}

export function phoneTotals(rows: readonly PhoneModelRow[]): PhoneTotals {
  let units = 0;
  let unregistered = 0;
  let usedUnits = 0;
  let costMinor = 0;
  let saleMinor = 0;
  let priced = true;

  for (const row of rows) {
    units += row.available;
    unregistered += row.unregistered;
    usedUnits += row.usedCount;
    costMinor += row.costMinor;
    if (row.saleMinor === null) priced = false;
    else saleMinor += row.saleMinor;
  }

  return {
    models: rows.length,
    units,
    unregistered,
    usedUnits,
    costMinor,
    saleMinor: priced ? saleMinor : null,
    expectedProfitMinor:
      priced && unregistered === 0 ? saleMinor - costMinor : null,
  };
}

/**
 * Does this handset match what was typed?
 *
 * The IMEI matches on its last digits too, because that is what a person reads
 * out loud from a phone box; a model matches on its name, a handset on its colour.
 */
export function matchesPhone(
  query: string,
  fields: { readonly name?: string; readonly imei?: string; readonly color?: string | null },
): boolean {
  const q = normalize(query);
  if (q === '') return true;
  const haystack = normalize(
    `${fields.name ?? ''} ${fields.color ?? ''} ${fields.imei ?? ''}`,
  );
  if (haystack.includes(q)) return true;
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 4 && (fields.imei ?? '').includes(digits)) return true;
  return false;
}

/** How many whole days a handset has been on the shelf. */
export function daysInStock(createdAt: number, nowMs: number): number {
  if (!Number.isFinite(createdAt) || createdAt <= 0) return 0;
  const days = Math.floor((nowMs - createdAt) / 86_400_000);
  return days < 0 ? 0 : days;
}
