// Pure variant helpers for the sales screen (`PosScreen.vue` and
// `VariantPickerModal.vue`, ADR-018 §4, plan item 1.2 step 4).
//
// Mirrors `tilesHTML`, `famTileHTML` and `MODALS.variant` in
// `docs/ui/mockup-v1/{pos,views/catalog}.js`:
//   * products sharing a `parentId` collapse into one family tile at the
//     position of the first variant in the filtered list;
//   * inside the family, variants are ordered by `variantOrder`;
//   * the family tile shows the lowest price (`من ...` when prices differ)
//     and the sum of free stock across all variants;
//   * arrow keys inside the picker skip out-of-stock variants and wrap around.

export interface VariantLikeProduct {
  readonly id: string;
  readonly name: string;
  readonly salePriceMinor: number | null;
  readonly parentId?: string | null;
  readonly parentName?: string | null;
  readonly dimension1?: string | null;
  readonly dimension2?: string | null;
  readonly variant1?: string | null;
  readonly variant2?: string | null;
  readonly variantOrder?: number | null;
}

export type PosTileEntry<P extends VariantLikeProduct> =
  | { readonly kind: 'product'; readonly key: string; readonly product: P }
  | {
      readonly kind: 'family';
      readonly key: string;
      readonly parentId: string;
      readonly parentName: string;
      readonly dimensions: readonly string[];
      readonly variants: readonly P[];
    };

/**
 * Collapse variant products that share a `parentId` into one family tile entry
 * while preserving the position of the first matching variant in `list`.
 *
 * `allProducts` (when provided) supplies the full variant set of each family so
 * opening a family tile always shows all of its variants in `variantOrder`
 * order, as `famTileHTML(fam)` does in the mockup.
 */
export function collapseFamilies<P extends VariantLikeProduct>(
  list: readonly P[],
  allProducts: readonly P[] = list,
): PosTileEntry<P>[] {
  const byParent = new Map<string, P[]>();
  for (const p of allProducts) {
    const pid = p.parentId ?? null;
    if (pid === null) continue;
    const bucket = byParent.get(pid);
    if (bucket !== undefined) {
      bucket.push(p);
    } else {
      byParent.set(pid, [p]);
    }
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => (a.variantOrder ?? 0) - (b.variantOrder ?? 0));
  }

  const seen = new Set<string>();
  const out: PosTileEntry<P>[] = [];
  for (const p of list) {
    const pid = p.parentId ?? null;
    if (pid === null) {
      out.push({ kind: 'product', key: `p:${p.id}`, product: p });
      continue;
    }
    if (seen.has(pid)) continue;
    seen.add(pid);
    const variants = byParent.get(pid) ?? [p];
    const head = variants[0] ?? p;
    const dims = [head.dimension1, head.dimension2].filter(
      (d): d is string => typeof d === 'string' && d !== '',
    );
    out.push({
      kind: 'family',
      key: `f:${pid}`,
      parentId: pid,
      parentName: head.parentName ?? head.name,
      dimensions: dims.length > 0 ? dims : ['النوع'],
      variants,
    });
  }
  return out;
}

/** Lowest and highest price across a family's variants, and whether they differ. */
export function familyPriceSummary(
  variants: readonly { readonly salePriceMinor: number | null }[],
): { readonly minMinor: number | null; readonly maxMinor: number | null; readonly varies: boolean } {
  const prices = variants
    .map((v) => v.salePriceMinor)
    .filter((m): m is number => m !== null && m > 0);
  if (prices.length === 0) return { minMinor: null, maxMinor: null, varies: false };
  const minMinor = Math.min(...prices);
  const maxMinor = Math.max(...prices);
  return { minMinor, maxMinor, varies: minMinor < maxMinor };
}

/** Label shown on a variant button inside the picker («Galaxy A16، أسود»). */
export function variantOptionLabel(v: {
  readonly variant1?: string | null;
  readonly variant2?: string | null;
  readonly name: string;
}): string {
  const parts = [v.variant1, v.variant2].filter(
    (x): x is string => typeof x === 'string' && x.trim() !== '',
  );
  return parts.length > 0 ? parts.join('، ') : v.name;
}

/**
 * Index of the first enabled variant in `enabledFlags`, or `0` when all are
 * disabled.
 */
export function firstEnabledVariantIndex(enabledFlags: readonly boolean[]): number {
  const idx = enabledFlags.findIndex(Boolean);
  return idx >= 0 ? idx : 0;
}

/**
 * Move the highlighted index in the variant picker by `delta` (`+1` or `-1`),
 * skipping disabled (out-of-stock) buttons and wrapping around.
 */
export function stepVariantHighlight(
  enabledFlags: readonly boolean[],
  current: number,
  delta: 1 | -1,
): number {
  const n = enabledFlags.length;
  if (n === 0) return 0;
  for (let step = 1; step <= n; step += 1) {
    const candidate = (current + delta * step + n * 2) % n;
    if (enabledFlags[candidate]) return candidate;
  }
  return current;
}
