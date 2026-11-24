// The category tree on the sales screen (ADR-018 §1), as in the mockup: a first
// row of chips with «الأكثر مبيعًا», «الكل» and the main categories, and — when a
// main category with sub-categories is chosen — a second row with them.
//
// Built from the flat, ordered list `pos_catalog` returns. A hidden category
// gets no chip, and neither do the sub-categories of a hidden one; their goods
// stay in «الكل» and in search. Under a phone category with no sub-categories
// shown, the second row is its companies instead (ADR-018 §2), as in the
// mockup: a company chip is chosen as `main~brand`. Pure, so it is tested
// without a browser (categories.test.ts).

export interface TreeCategory {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  /** `item`, `phone` or `used`: a non-`item` main shows its companies. */
  readonly kind: string;
  readonly icon: string;
  readonly hidden: boolean;
}

/** What a chip filters: a product's category and company. */
export interface ChipProduct {
  readonly categoryId: string | null;
  readonly brandId: string | null;
}

/** A phone company, as the brand chips need it. */
export interface ChipBrand {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
}

/** A company chip's selection: `main~brand`. */
export function brandPick(id: string): [string, string] | null {
  const at = id.indexOf('~');
  return at < 0 ? null : [id.slice(0, at), id.slice(at + 1)];
}

export interface CategoryTree {
  readonly byId: ReadonlyMap<string, TreeCategory>;
  /** Main categories, in the owner's order, hidden ones included. */
  readonly mains: readonly TreeCategory[];
  /** Sub-categories under each main category, in the owner's order. */
  readonly subs: ReadonlyMap<string, readonly TreeCategory[]>;
}

/** The fixed chips before the categories. */
export type FixedChip = 'top' | 'all';

/** What a chip shows: the category and how many products are under it. */
export interface Chip {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly count: number;
}

/** The tree, keeping the order the list came in (the owner's). */
export function buildTree(categories: readonly TreeCategory[]): CategoryTree {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const mains: TreeCategory[] = [];
  const subs = new Map<string, TreeCategory[]>();
  for (const c of categories) {
    if (c.parentId === null) {
      mains.push(c);
    } else if (byId.has(c.parentId)) {
      const under = subs.get(c.parentId) ?? [];
      under.push(c);
      subs.set(c.parentId, under);
    }
  }
  return { byId, mains, subs };
}

/** The main category `id` sits under, or `id` itself for a main one. */
export function mainOf(tree: CategoryTree, id: string): string | null {
  const pick = brandPick(id);
  if (pick !== null) return tree.byId.has(pick[0]) ? pick[0] : null;
  const c = tree.byId.get(id);
  if (c === undefined) return null;
  return c.parentId ?? c.id;
}

/** Whether a product in `productCategory` is under the chip `chipId`: in it, or in one of its sub-categories. */
export function inChip(tree: CategoryTree, productCategory: string | null, chipId: string): boolean {
  if (productCategory === null) return false;
  if (productCategory === chipId) return true;
  const c = tree.byId.get(productCategory);
  return c !== undefined && c.parentId === chipId;
}

/** Whether a product is under the chosen chip: a category, or a company under a main. */
export function inSelection(tree: CategoryTree, product: ChipProduct, selected: string): boolean {
  const pick = brandPick(selected);
  if (pick === null) return inChip(tree, product.categoryId, selected);
  return product.brandId === pick[1] && inChip(tree, product.categoryId, pick[0]);
}

/** Whether the category has a chip: neither it nor its parent is hidden. */
export function chipVisible(tree: CategoryTree, id: string): boolean {
  const pick = brandPick(id);
  if (pick !== null) return chipVisible(tree, pick[0]);
  const c = tree.byId.get(id);
  if (c === undefined || c.hidden) return false;
  if (c.parentId === null) return true;
  const parent = tree.byId.get(c.parentId);
  return parent !== undefined && !parent.hidden;
}

function count(tree: CategoryTree, categoriesOfProducts: readonly (string | null)[], id: string): number {
  let n = 0;
  for (const category of categoriesOfProducts) if (inChip(tree, category, id)) n++;
  return n;
}

/** The first row: the main categories that are shown, each with its count (sub-categories' included). */
export function mainChips(tree: CategoryTree, categoriesOfProducts: readonly (string | null)[]): Chip[] {
  return tree.mains
    .filter((c) => !c.hidden)
    .map((c) => ({ id: c.id, name: c.name, icon: c.icon, count: count(tree, categoriesOfProducts, c.id) }));
}

/** The second row, for the chosen chip: the shown sub-categories of its main category; none for «الكل» and «الأكثر مبيعًا». */
export function subChips(
  tree: CategoryTree,
  selected: string,
  categoriesOfProducts: readonly (string | null)[]
): Chip[] {
  const main = mainOf(tree, selected);
  if (main === null || !chipVisible(tree, main)) return [];
  return (tree.subs.get(main) ?? [])
    .filter((c) => !c.hidden)
    .map((c) => ({ id: c.id, name: c.name, icon: c.icon, count: count(tree, categoriesOfProducts, c.id) }));
}

/**
 * The second row's companies, for a phone (or second-hand) main with no
 * sub-category shown: those with products under it, in the owner's order.
 */
export function brandChips(
  tree: CategoryTree,
  selected: string,
  products: readonly ChipProduct[],
  brands: readonly ChipBrand[]
): Chip[] {
  const main = mainOf(tree, selected);
  if (main === null || !chipVisible(tree, main)) return [];
  const category = tree.byId.get(main);
  if (category === undefined || category.kind === 'item') return [];
  if ((tree.subs.get(main) ?? []).some((c) => !c.hidden)) return [];
  const counts = new Map<string, number>();
  for (const p of products) {
    if (p.brandId !== null && inChip(tree, p.categoryId, main)) counts.set(p.brandId, (counts.get(p.brandId) ?? 0) + 1);
  }
  return [...brands]
    .filter((b) => counts.has(b.id))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((b) => ({ id: `${main}~${b.id}`, name: b.name, icon: '', count: counts.get(b.id) ?? 0 }));
}

/**
 * The chip chosen after a click on `id`: that chip — or, clicking the chosen
 * sub-category or company again, back to its main category (as in the mockup).
 */
export function toggle(tree: CategoryTree, current: string, id: string): string {
  if (current !== id) return id;
  const pick = brandPick(id);
  if (pick !== null) return pick[0];
  return tree.byId.get(id)?.parentId ?? id;
}

/** The chosen chip after a reload: kept while it still has a chip, otherwise «الأكثر مبيعًا». */
export function keepSelection(tree: CategoryTree, current: string): string {
  if (current === 'top' || current === 'all') return current;
  return chipVisible(tree, current) ? current : 'top';
}

/** The words search matches for a product's category: its name and its parent's. */
export function searchWords(tree: CategoryTree, id: string | null): string {
  if (id === null) return '';
  const c = tree.byId.get(id);
  if (c === undefined) return '';
  const parent = c.parentId === null ? undefined : tree.byId.get(c.parentId);
  return parent === undefined ? c.name : `${parent.name} ${c.name}`;
}
