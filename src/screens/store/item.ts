// «صنف جديد» for counted goods (ADR-018 §3): what it offers and what it
// refuses before a round trip. The mockup's `itemCats`, `niSkuErr` and the
// order of checks in `niCheck` are the reference.
//
// The barcode generator is NOT here: Rust owns the shop's EAN-13 numbering
// (`domain::catalog::shop_code`), and the button asks it through `next_shop_code`.
// The check functions below only describe a code that is already in hand.

import type { CategoryEntry } from '../../api/categories.ts';
import { normalize } from '../../ui/arabic.ts';
import { kindsWord, parseMoney } from '../../ui/format.ts';



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

/**
 * The goods already on the shelf, typed at registration (owner request
 * 2026-10-21: «تفاصيل البضاعة عشان تتسجل» — all of it in one form, like the
 * approved mockup's `niItem`): a count and a unit cost, received into stock
 * the moment the product exists, instead of a second trip to «استلام توريد»
 * to type what was already known here.
 */
export interface PlannedReceipt {
  readonly qty: number;
  readonly costMinor: number;
}

/**
 * Read the count and the cost of the goods on hand.
 *
 * - `null`: both fields empty — the product registers alone and the receiving
 *   stays the next step, exactly as before.
 * - a string: what is wrong, in the shop's words (a count without a cost is
 *   refused loudly: every unit needs a cost — `ADR-013`).
 * - a `PlannedReceipt`: what to receive right after the product is created.
 */
export function plannedReceipt(qtyRaw: string, costRaw: string): PlannedReceipt | string | null {
  const q = qtyRaw.trim();
  const c = costRaw.trim();
  if (q === '' && c === '') return null;
  if (q === '') return 'اكتب العدد الموجود، أو سيب الخانتين فاضيين';
  const qty = Number(q);
  if (!Number.isInteger(qty) || qty <= 0) return 'العدد لازم يكون رقم صحيح أكبر من صفر';
  const costMinor = parseMoney(c);
  if (costMinor === null || costMinor < 0) return 'اكتب تكلفة الوحدة للبضاعة الموجودة';
  return { qty, costMinor };
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

// ---------------------------------------------------------------------------
// Product variants («الصنف ده ليه تفرعات», ADR-018 §4, plan item 1.2 step 4)
// ---------------------------------------------------------------------------

/** The seven dimensions the shop splits a counted item by (`NI_DIMS`). */
export const VARIANT_DIMENSIONS = [
  'الموبايل',
  'اللون',
  'النوع',
  'المقاس',
  'القوة',
  'الطول',
  'المساحة',
] as const;

export type VariantDimensionLabel = (typeof VARIANT_DIMENSIONS)[number];

/** Maximum combinations one parent item may generate (`NI_MAX_VARIANTS`). */
export const MAX_VARIANTS = 60;

const COLOR_SUGGESTIONS = [
  'أسود',
  'أبيض',
  'أزرق',
  'أخضر',
  'رمادي',
  'فضي',
  'ذهبي',
  'بنفسجي',
  'بينك',
  'أحمر',
] as const;

const POWER_SUGGESTIONS = ['20W', '25W', '33W', '45W', '65W'] as const;
const LENGTH_SUGGESTIONS = ['1م', '2م', '3م'] as const;
const STORAGE_SUGGESTIONS = ['32GB', '64GB', '128GB', '256GB'] as const;
const DEFAULT_PHONE_MODELS = ['Galaxy A16', 'iPhone 16', 'Redmi 14C'] as const;

/** Quick suggestion chips under a dimension's value input (`niSuggest`). */
export function dimensionSuggestions(
  label: string,
  phoneModels: readonly string[] = DEFAULT_PHONE_MODELS,
): readonly string[] {
  if (label === 'الموبايل') {
    const unique = [...new Set(phoneModels.map((m) => m.trim()).filter((m) => m !== ''))];
    return (unique.length > 0 ? unique : [...DEFAULT_PHONE_MODELS]).slice(0, 10);
  }
  if (label === 'اللون') return COLOR_SUGGESTIONS;
  if (label === 'القوة') return POWER_SUGGESTIONS;
  if (label === 'الطول') return LENGTH_SUGGESTIONS;
  if (label === 'المساحة') return STORAGE_SUGGESTIONS;
  return [];
}

/** Trim a typed dimension value, stripping trailing commas and collapsing spaces. */
export function cleanVariantValue(raw: string): string {
  return raw.trim().replace(/[,،]+$/g, '').trim().split(/\s+/).filter(Boolean).join(' ');
}


/** Append a value to a dimension's list unless it is blank or already present. */
export function addVariantValue(current: readonly string[], raw: string): string[] {
  const clean = cleanVariantValue(raw);
  if (clean === '') return [...current];
  const key = normalize(clean);
  if (current.some((existing) => normalize(existing) === key)) return [...current];
  return [...current, clean];
}

/**
 * Cartesian product of one or two dimensions (`variantCombos` in
 * `docs/ui/mockup-v1/analytics.js`).
 *
 * The first dimension is required: when its values are empty, no combinations
 * are produced even if the second dimension has values.
 */
export function variantCombos(
  dims: readonly { readonly values: readonly string[] }[],
): string[][] {
  if (dims.length === 0 || (dims[0]?.values.length ?? 0) === 0) return [];
  const active = dims
    .map((d) => d.values.map(cleanVariantValue).filter((v) => v !== ''))
    .filter((vals) => vals.length > 0);
  if (active.length === 0) return [];
  return active.reduce<string[][]>(
    (acc, vals) => acc.flatMap((prefix) => vals.map((v) => [...prefix, v])),
    [[]],
  );
}

export function comboKey(combo: readonly string[]): string {
  return combo.join('|');
}

export function comboLabel(combo: readonly string[]): string {
  return combo.join('، ');
}

export function variantTitle(base: string, combo: readonly string[]): string {
  const cleanBase = base.trim().split(/\s+/).filter(Boolean).join(' ');
  return [cleanBase, ...combo].filter((part) => part !== '').join(' ');
}

export interface VariantRowDraft {
  readonly barcode: string;
  readonly price: string;
  /** Units of this type already on the shelf (optional, «العدد» in the mockup). */
  readonly qty?: string;
  /** Unit cost of those units; empty falls back to the form's cost («التكلفة»). */
  readonly cost?: string;
}

export interface VariantsDraft {
  readonly categoryId: string;
  readonly name: string;
  readonly dim1Label: string;
  readonly dim1Values: readonly string[];
  readonly dim2Label: string;
  readonly dim2Values: readonly string[];
  /** Default sale price in piastres (`null` = empty or invalid). */
  readonly priceMinor: number | null;
  /** The default unit cost a row without its own inherits («الفاضي = اللي فوق»). */
  readonly defaultCost?: string;
  readonly rows: Readonly<Record<string, VariantRowDraft>>;
}

/**
 * Validate a variant item draft in the mockup's `niCheck` order. Returns `''`
 * when ready to save.
 */
export function variantsProblem(
  categories: readonly CategoryEntry[],
  draft: VariantsDraft,
): string {
  if (categories.length === 0) return 'مفيش تصنيف بالعدد. ضيف واحد من الإعدادات.';
  if (draft.categoryId === '') return 'اختار التصنيف';
  if (draft.name.trim() === '') return 'اكتب اسم الصنف';

  const combos = variantCombos([
    { values: draft.dim1Values },
    { values: draft.dim2Values },
  ]);
  if (combos.length === 0) {
    return `اكتب نوع واحد على الأقل في «${draft.dim1Label}»، ودوس Enter بعد كل واحد`;
  }
  if (combos.length > MAX_VARIANTS) {
    return `${kindsWord(combos.length)} كتير على صنف واحد (الحد ${MAX_VARIANTS}). قسّمه لأكتر من صنف`;
  }

  const seenBarcodes = new Map<string, string>();
  for (const combo of combos) {
    const key = comboKey(combo);
    const label = comboLabel(combo);
    const row = draft.rows[key];
    const sku = row?.barcode.trim() ?? '';
    const bad = barcodeProblem(sku);
    if (bad !== '') return `«${label}»: ${bad}`;
    if (sku !== '') {
      const prev = seenBarcodes.get(sku);
      if (prev !== undefined) return `«${label}»: الباركود ده على «${prev}»`;
      seenBarcodes.set(sku, label);
    }
  }

  if (draft.priceMinor === null || draft.priceMinor <= 0) return 'اكتب سعر البيع';

  for (const combo of combos) {
    const key = comboKey(combo);
    const label = comboLabel(combo);
    const rawPrice = draft.rows[key]?.price.trim() ?? '';
    if (rawPrice !== '') {
      const rowPrice = parseMoney(rawPrice);
      if (rowPrice === null || rowPrice <= 0) return `«${label}»: اكتب سعر البيع`;
    }
  }

  // The units on the shelf: a row's own cost, or the form's cost above it, or
  // a loud refusal — a count without a cost is a receipt nobody can audit.
  for (const combo of combos) {
    const row = draft.rows[comboKey(combo)];
    const rowCost = (row?.cost ?? '').trim() !== '' ? row!.cost! : draft.defaultCost ?? '';
    const plan = plannedReceipt(row?.qty ?? '', rowCost);
    if (typeof plan === 'string') return `«${comboLabel(combo)}»: ${plan}`;
  }

  return '';
}

