// Finding a product on the sales screen (docs/ui/mockup-v1/pos.js,
// `searchAll` / `rankProducts`). Pure: the screen passes the catalogue in.
//
// - A scanned or typed barcode that matches exactly wins outright.
// - Otherwise every word of the query must appear in the product's name, its
//   barcode or its category's name (and its parent's); names that start with the first word come
//   first, then names that contain the whole query, then the best sellers.

import { normalize } from '../../ui/arabic.ts';

export interface Searchable {
  readonly id: string;
  readonly name: string;
  readonly barcode: string | null;
  /** Its category's name and its parent's (ADR-018 §1). */
  readonly categoryWords: string;
  readonly soldRecently: number;
}

export interface Indexed<T extends Searchable> {
  readonly item: T;
  readonly hay: string;
  readonly normName: string;
  readonly barcode: string;
}

export function buildIndex<T extends Searchable>(items: readonly T[]): Indexed<T>[] {
  return items.map((item) => ({
    item,
    hay: normalize([item.name, item.barcode ?? '', item.categoryWords].join(' ')),
    normName: normalize(item.name),
    barcode: normalize(item.barcode ?? ''),
  }));
}

export function search<T extends Searchable>(index: readonly Indexed<T>[], query: string, limit = 8): T[] {
  const q = normalize(query);
  if (q === '') return [];

  const compact = q.replace(/\s/g, '');
  const exact = index.filter((entry) => entry.barcode !== '' && entry.barcode === compact);
  if (exact.length > 0) return exact.map((entry) => entry.item);

  const words = q.split(' ');
  const first = words[0] ?? '';
  const scored: [number, T][] = [];
  for (const entry of index) {
    if (!words.every((word) => entry.hay.includes(word))) continue;
    let score = entry.item.soldRecently;
    if (entry.normName.startsWith(first)) score += 1000;
    if (entry.normName.includes(q)) score += 500;
    scored.push([score, entry.item]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, limit).map(([, item]) => item);
}

/** True when the query looks like a scan: digits only, long enough to be a code. */
export function looksLikeCode(query: string): boolean {
  return /^\d{6,}$/.test(normalize(query).replace(/\s/g, ''));
}
