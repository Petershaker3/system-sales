// «صنف جديد» for counted goods (ADR-018 §3): what it offers and what it
// refuses before a round trip. The mockup's `itemCats`, `niSkuErr` and the
// order of checks in `niCheck` are the reference.
//
// The barcode generator is NOT here: Rust owns the shop's EAN-13 numbering
// (`domain::catalog::shop_code`), and the button asks it through `next_shop_code`.
// The check functions below only describe a code that is already in hand.

import type { CategoryEntry } from '../../api/categories';

/**
 * The categories a counted item may be put in: the sub-categories of every main
 * registered «بالعدد», or the main itself when it has none — the mockup's
 * `itemCats`.
 *
 * A hidden category is still offered here: hiding removes its button from the
 * sales screen and nothing else (ADR-018 §1).
 */
export function itemCategories(categories: readonly CategoryEntry[]): CategoryEntry[] {
  const out: CategoryEntry[] = [];
  for (const main of categories.filter((c) => c.parentId === null && c.kind === 'item')) {
    const subs = categories.filter((c) => c.parentId === main.id);
    out.push(...(subs.length > 0 ? subs : [main]));
  }
  return out;
}

/**
 * Where the inline «تصنيف جديد» puts a category: under the main of the category
 * currently chosen.
 *
 * When a sub is chosen that is its parent; when a childless main is chosen it
 * becomes the parent itself, which gives the main its first sub. `null` means
 * there is no selection, and the caller creates a main category instead.
 */
export function newCategoryParent(categories: readonly CategoryEntry[], selectedId: string): string | null {
  const selected = categories.find((c) => c.id === selectedId);
  if (selected === undefined) return null;
  return selected.parentId ?? selected.id;
}

/** Digits in a typed or scanned barcode: 6 to 14, as in the mockup's `niSkuErr`. */
export function barcodeProblem(barcode: string): string {
  const value = barcode.trim();
  if (value === '') return '';
  if (!/^\d{6,14}$/.test(value)) return 'الباركود أرقام بس (من 6 لـ 14 رقم)';
  return '';
}

/**
 * The EAN-13 check digit of a 12-digit body, or `null` when the body is not 12
 * ASCII digits. Used only to recognise a shop code; generation stays in Rust.
 */
export function ean13CheckDigit(body: string): number | null {
  if (!/^\d{12}$/.test(body)) return null;
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/** A 13-digit EAN-13 made by the shop: starts with 2 and its check digit is right. */
export function isShopCode(code: string): boolean {
  return /^2\d{12}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** What a draft is missing, in the mockup's order, or `''` when it is complete. */
export interface ItemDraft {
  readonly categoryId: string;
  readonly name: string;
  readonly barcode: string;
  /** `null` = the field is empty or unreadable. */
  readonly priceMinor: number | null;
}

export function itemProblem(categories: readonly CategoryEntry[], draft: ItemDraft): string {
  if (categories.length === 0) return 'مفيش تصنيف بالعدد. ضيف واحد من الإعدادات.';
  if (draft.categoryId === '') return 'اختار التصنيف';
  if (draft.name.trim() === '') return 'اكتب اسم الصنف';
  const barcode = barcodeProblem(draft.barcode);
  if (barcode !== '') return barcode;
  if (draft.priceMinor === null || draft.priceMinor <= 0) return 'اكتب سعر البيع';
  return '';
}
