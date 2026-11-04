// «بحث في المخزن»: بالاسم، بالكود/الباركود، أو بسيريال الجهاز.
//
// البحث كان على الباركود بس، وبيضرب الطلب للسيرفر في كل مرة، فالصنف اللي مكتوب
// في الجدول قدام عينه مكانش بيتلاقى بالاسم. البحث هنا محلي وفوري، وبيشتغل على
// اللي محمّل أصلاً في الشاشة — و«Enter» بيكمّل بحث السيرفر لو الرقم مش موجود
// محليًا (باركود صنف مؤرشف مثلاً).

import { toLatinDigits } from '../../ui/format.ts';
import { normalizeShortageSearch } from '../store/shortages.ts';

/** The smallest thing the search needs from a product. */
export interface SearchableProduct {
  readonly id: string;
  readonly name: string;
  readonly barcode?: string | null;
}

/** Digits only, so `0106-123` and `0106123` are the same number. */
export function digitsOf(raw: string): string {
  return toLatinDigits(raw).replace(/\D/g, '');
}

/** Does this product answer `query`? Names in Arabic, codes and serials in digits. */
export function productMatches(
  query: string,
  product: SearchableProduct,
  serials: readonly string[] = []
): boolean {
  const typed = query.trim();
  if (typed === '') return true;

  const text = normalizeShortageSearch(typed);
  if (text !== '' && normalizeShortageSearch(product.name).includes(text)) return true;

  const barcode = (product.barcode ?? '').trim();
  if (barcode !== '' && barcode.toLowerCase().includes(typed.toLowerCase())) return true;

  // A serial is typed as digits; a name is not, so the digit path is only tried
  // when something numeric was typed.
  const digits = digitsOf(typed);
  if (digits !== '') {
    if (digitsOf(barcode).includes(digits) && digitsOf(barcode) !== '') return true;
    if (serials.some((serial) => digitsOf(serial).includes(digits))) return true;
  }
  return false;
}

/** Keep the products that answer the query, in the order they were loaded. */
export function filterProducts<T extends SearchableProduct>(
  products: readonly T[],
  query: string,
  serialsByProduct: ReadonlyMap<string, readonly string[]> = new Map()
): T[] {
  const typed = query.trim();
  if (typed === '') return [...products];
  return products.filter((product) =>
    productMatches(typed, product, serialsByProduct.get(product.id) ?? [])
  );
}
