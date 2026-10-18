// Pure sales history & period analytics (`docs/ui/mockup-v1/analytics.js`,
// `docs/ui/mockup-v1/views/sales.js`, `docs/ui/SALES-SHORTAGES.md`, Plan item 1.14 / `ADR-029`).
//
// All monetary amounts are integer minor units (piastres, ADR-010).

import type {
  SaleHistoryEntry,
  SaleHistoryLine,
  SaleHistoryPayment,
} from '../../api/sales.ts';
import { num, toLatinDigits } from '../../ui/format.ts';

export type SalesRangeId = 'today' | 'yesterday' | 'week' | 'month' | 'month-x' | '';
export type SalesViewTab = 'inv' | 'day' | 'prod' | 'cat';

export interface SalesFilterState {
  readonly q: string;
  readonly cat: string;
  readonly seller: string;
  readonly method: string;
}

export interface FilteredSaleRow {
  readonly x: SaleHistoryEntry;
  readonly lines: readonly SaleHistoryLine[];
  readonly lineLevel: boolean;
}

export interface SalesTotals {
  readonly salesMinor: number;
  readonly profitMinor: number;
  readonly pcs: number;
  readonly invoices: number;
  readonly avgMinor: number;
  readonly partial: boolean;
}

export interface DayBreakdownRow {
  readonly day: Date;
  readonly iso: string;
  readonly salesMinor: number;
  readonly profitMinor: number;
  readonly invoices: number;
  readonly pcs: number;
}

export interface ProductBreakdownRow {
  readonly key: string;
  readonly name: string;
  readonly categoryId: string;
  readonly categoryName: string;
  readonly qty: number;
  readonly salesMinor: number;
  readonly profitMinor: number;
}

export interface SubCategoryBreakdownRow {
  readonly id: string;
  readonly name: string;
  readonly qty: number;
  readonly salesMinor: number;
  readonly profitMinor: number;
}

export interface CategoryBreakdownRow {
  readonly id: string;
  readonly name: string;
  readonly qty: number;
  readonly salesMinor: number;
  readonly profitMinor: number;
  readonly subs: readonly SubCategoryBreakdownRow[];
}

export interface MonthBreakdownRow {
  readonly key: string;
  readonly from: Date;
  readonly salesMinor: number;
  readonly profitMinor: number;
  readonly invoices: number;
  readonly pcs: number;
}

/* --- Date helpers --- */

export function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function sameDay(a: Date, b: Date): boolean {
  return dayStart(a).getTime() === dayStart(b).getTime();
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

export function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function parseIsoDay(raw: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const dd = Number(m[3]);
  const d = new Date(y, mo - 1, dd);
  if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== dd) {
    return null;
  }
  return d;
}

export function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function monthEnd(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

export function sameMonth(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function daysIn(from: Date, to: Date): number {
  return Math.round((dayStart(to).getTime() - dayStart(from).getTime()) / 86_400_000) + 1;
}

export function pct(now: number, before: number): number | null {
  return before ? Math.round(((now - before) / before) * 100) : null;
}

/* --- Period & comparison windows --- */

export function inRange(
  list: readonly SaleHistoryEntry[],
  from: Date,
  to: Date,
): SaleHistoryEntry[] {
  const a = dayStart(from).getTime();
  const b = addDays(to, 1).getTime();
  return list.filter((x) => !x.isCancelled && x.occurredAt >= a && x.occurredAt < b);
}

export function inSpan(
  list: readonly SaleHistoryEntry[],
  from: Date,
  end: Date,
): SaleHistoryEntry[] {
  const a = dayStart(from).getTime();
  const b = end.getTime();
  return list.filter((x) => !x.isCancelled && x.occurredAt >= a && x.occurredAt < b);
}

export function prevPeriod(
  from: Date,
  to: Date,
  month = false,
): { from: Date; to: Date; partial: boolean } {
  const len = daysIn(from, to);
  if (!month) {
    return { from: addDays(from, -len), to: addDays(to, -len), partial: false };
  }
  const pf = new Date(from.getFullYear(), from.getMonth() - 1, 1);
  const pe = monthEnd(pf);
  const partial = dayStart(to).getTime() < monthEnd(from).getTime();
  const last = partial ? addDays(pf, len - 1) : pe;
  return { from: pf, to: last > pe ? pe : last, partial };
}

function spanEnd(to: Date, live: boolean, now: Date): Date {
  return live
    ? new Date(dayStart(to).getTime() + (now.getTime() - dayStart(now).getTime()))
    : addDays(to, 1);
}

export function comparePeriod(
  from: Date,
  to: Date,
  month = false,
  now: Date = new Date(),
): { from: Date; to: Date; partial: boolean; live: boolean; end: Date } {
  const p = prevPeriod(from, to, month);
  const live = sameDay(to, now);
  return {
    from: p.from,
    to: p.to,
    partial: p.partial,
    live,
    end: spanEnd(p.to, live, now),
  };
}

export function firstSaleDay(
  list: readonly SaleHistoryEntry[],
  fallback: Date = new Date(),
): Date {
  let minMs: number | null = null;
  for (const x of list) {
    if (x.isCancelled) continue;
    if (minMs === null || x.occurredAt < minMs) {
      minMs = x.occurredAt;
    }
  }
  return minMs !== null ? dayStart(new Date(minMs)) : dayStart(fallback);
}

/* --- Search & invoice number helpers --- */

export function normalizeSearch(raw: string): string {
  return toLatinDigits(raw)
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .trim();
}

/**
 * Extract a concise numeric invoice sequence when possible (e.g. `1001` or `1` from `INV-20261018-0001`),
 * while preserving full reference matching.
 */
export function extractInvoiceDigits(reference: string): string {
  const m = /-(\d+)$/.exec(reference.trim());
  if (m && m[1]) {
    const n = Number(m[1]);
    return Number.isFinite(n) ? String(n) : m[1];
  }
  const bare = /^\d+$/.exec(reference.trim());
  return bare ? String(Number(bare[0])) : '';
}

function matchesExactInvoice(x: SaleHistoryEntry, rawTrimmed: string, qDigits: string): boolean {
  if (!rawTrimmed) return false;
  if (x.reference.toLowerCase() === rawTrimmed.toLowerCase()) return true;
  if (qDigits && /^\d+$/.test(rawTrimmed)) {
    const seq = extractInvoiceDigits(x.reference);
    if (seq && seq === String(Number(qDigits))) return true;
  }
  return false;
}

/* --- Filtering (`salesRows`) --- */

export function filterSalesRows(
  history: readonly SaleHistoryEntry[],
  from: Date,
  to: Date,
  filters: SalesFilterState,
  context: {
    readonly isOwner: boolean;
    readonly userId: string;
    readonly end?: Date | null;
  },
): FilteredSaleRow[] {
  const raw = toLatinDigits(filters.q).trim();
  const q = normalizeSearch(raw);
  const qd = raw.replace(/\D/g, '');
  const list = context.end
    ? inSpan(history, from, context.end)
    : inRange(history, from, to);

  // Exact invoice number / reference wins over partial phone/IMEI matches.
  const exact = raw
    ? list.find((x) => matchesExactInvoice(x, raw, qd)) ?? null
    : null;
  const candidates = exact ? [exact] : list;

  const out: FilteredSaleRow[] = [];
  for (const x of candidates) {
    if (!context.isOwner && x.soldBy !== context.userId) continue;
    if (context.isOwner && filters.seller && x.soldBy !== filters.seller) continue;
    if (filters.method && !x.payments.some((p) => p.method === filters.method)) continue;

    let lines: readonly SaleHistoryLine[] = x.lines;
    let lineLevel = false;

    if (filters.cat) {
      lines = lines.filter(
        (l) =>
          l.categoryId === filters.cat ||
          l.parentCategoryId === filters.cat,
      );
      lineLevel = true;
    }

    if (q) {
      const custNameNorm = normalizeSearch(x.customerName ?? '');
      const custPhone = toLatinDigits(x.customerPhone ?? '').replace(/\D/g, '');
      const refNorm = normalizeSearch(x.reference);
      const seqDigits = extractInvoiceDigits(x.reference);
      const hit =
        matchesExactInvoice(x, raw, qd) ||
        refNorm.includes(q) ||
        (qd !== '' && seqDigits === String(Number(qd))) ||
        (custNameNorm !== '' && custNameNorm.includes(q)) ||
        (qd.length >= 4 && custPhone.includes(qd));

      if (!hit) {
        lines = lines.filter((l) => {
          const prodNorm = normalizeSearch(l.productName);
          const imei = l.imei ?? '';
          return (
            prodNorm.includes(q) ||
            (qd.length >= 4 && imei.includes(qd))
          );
        });
        lineLevel = true;
      }
    }

    if (lines.length > 0) {
      out.push({ x, lines, lineLevel });
    }
  }
  return out;
}

/* --- Aggregations (`totalsOf`, `byDay`, `byProduct`, `byCategory`, `byMonth`) --- */

export function asRows(list: readonly SaleHistoryEntry[]): FilteredSaleRow[] {
  return list
    .filter((x) => !x.isCancelled)
    .map((x) => ({ x, lines: x.lines, lineLevel: false }));
}

export function rowAmountMinor(r: FilteredSaleRow): number {
  return r.lineLevel
    ? r.lines.reduce((a, l) => a + l.lineTotalMinor, 0)
    : r.x.totalMinor;
}

export function rowProfitMinor(r: FilteredSaleRow): number {
  return r.lineLevel
    ? r.lines.reduce((a, l) => a + (l.lineProfitMinor ?? 0), 0)
    : (r.x.profitMinor ?? 0);
}

export function totalsOf(rows: readonly FilteredSaleRow[]): SalesTotals {
  const salesMinor = rows.reduce((a, r) => a + rowAmountMinor(r), 0);
  const profitMinor = rows.reduce((a, r) => a + rowProfitMinor(r), 0);
  const pcs = rows.reduce(
    (a, r) => a + r.lines.reduce((b, l) => b + l.quantity, 0),
    0,
  );
  return {
    salesMinor,
    profitMinor,
    pcs,
    invoices: rows.length,
    avgMinor: rows.length ? Math.round(salesMinor / rows.length) : 0,
    partial: rows.some((r) => r.lineLevel),
  };
}

export function byDay(
  rows: readonly FilteredSaleRow[],
  from: Date,
  to: Date,
): DayBreakdownRow[] {
  const out: DayBreakdownRow[] = [];
  const idx = new Map<string, {
    day: Date;
    iso: string;
    salesMinor: number;
    profitMinor: number;
    invoices: number;
    pcs: number;
  }>();

  for (let d = dayStart(from); d.getTime() <= dayStart(to).getTime(); d = addDays(d, 1)) {
    const iso = isoDay(d);
    const e = {
      day: d,
      iso,
      salesMinor: 0,
      profitMinor: 0,
      invoices: 0,
      pcs: 0,
    };
    idx.set(iso, e);
    out.push(e);
  }

  for (const r of rows) {
    const e = idx.get(isoDay(new Date(r.x.occurredAt)));
    if (!e) continue;
    e.salesMinor += rowAmountMinor(r);
    e.profitMinor += rowProfitMinor(r);
    e.invoices += 1;
    e.pcs += r.lines.reduce((a, l) => a + l.quantity, 0);
  }

  return out;
}

export function byProduct(rows: readonly FilteredSaleRow[]): ProductBreakdownRow[] {
  const m = new Map<string, {
    key: string;
    name: string;
    categoryId: string;
    categoryName: string;
    qty: number;
    salesMinor: number;
    profitMinor: number;
  }>();

  for (const r of rows) {
    for (const l of r.lines) {
      const k = l.productId || l.productName;
      const existing = m.get(k) ?? {
        key: k,
        name: l.productName,
        categoryId: l.categoryId ?? 'uncategorized',
        categoryName: l.categoryName ?? 'بدون تصنيف',
        qty: 0,
        salesMinor: 0,
        profitMinor: 0,
      };
      existing.qty += l.quantity;
      existing.salesMinor += l.lineTotalMinor;
      existing.profitMinor += l.lineProfitMinor ?? 0;
      m.set(k, existing);
    }
  }

  return [...m.values()].sort((a, b) => b.salesMinor - a.salesMinor);
}

export function byCategory(
  rows: readonly FilteredSaleRow[],
  categoryNameById?: (id: string) => string,
): CategoryBreakdownRow[] {
  const resolveName = (id: string, fallback: string): string => {
    if (categoryNameById) {
      const found = categoryNameById(id);
      if (found) return found;
    }
    return fallback || 'بدون تصنيف';
  };

  const m = new Map<string, {
    id: string;
    name: string;
    qty: number;
    salesMinor: number;
    profitMinor: number;
    subs: Map<string, {
      id: string;
      name: string;
      qty: number;
      salesMinor: number;
      profitMinor: number;
    }>;
  }>();

  for (const r of rows) {
    for (const l of r.lines) {
      const catId = l.categoryId ?? 'uncategorized';
      const mainId = l.parentCategoryId ?? catId;
      const mainName =
        l.parentCategoryId !== null
          ? resolveName(mainId, l.categoryName ?? 'بدون تصنيف')
          : resolveName(catId, l.categoryName ?? 'بدون تصنيف');

      const main = m.get(mainId) ?? {
        id: mainId,
        name: mainName,
        qty: 0,
        salesMinor: 0,
        profitMinor: 0,
        subs: new Map(),
      };
      main.qty += l.quantity;
      main.salesMinor += l.lineTotalMinor;
      main.profitMinor += l.lineProfitMinor ?? 0;
      m.set(mainId, main);

      if (mainId !== catId) {
        const subName = resolveName(catId, l.categoryName ?? catId);
        const sub = main.subs.get(catId) ?? {
          id: catId,
          name: subName,
          qty: 0,
          salesMinor: 0,
          profitMinor: 0,
        };
        sub.qty += l.quantity;
        sub.salesMinor += l.lineTotalMinor;
        sub.profitMinor += l.lineProfitMinor ?? 0;
        main.subs.set(catId, sub);
      }
    }
  }

  return [...m.values()]
    .sort((a, b) => b.salesMinor - a.salesMinor)
    .map((e) => ({
      id: e.id,
      name: e.name,
      qty: e.qty,
      salesMinor: e.salesMinor,
      profitMinor: e.profitMinor,
      subs: [...e.subs.values()].sort((a, b) => b.salesMinor - a.salesMinor),
    }));
}

export function byMonth(list: readonly SaleHistoryEntry[]): MonthBreakdownRow[] {
  const m = new Map<string, {
    key: string;
    from: Date;
    salesMinor: number;
    profitMinor: number;
    invoices: number;
    pcs: number;
  }>();

  for (const x of list) {
    if (x.isCancelled) continue;
    const d = new Date(x.occurredAt);
    const k = monthKey(d);
    let e = m.get(k);
    if (!e) {
      e = {
        key: k,
        from: monthStart(d),
        salesMinor: 0,
        profitMinor: 0,
        invoices: 0,
        pcs: 0,
      };
      m.set(k, e);
    }
    e.salesMinor += x.totalMinor;
    e.profitMinor += x.profitMinor ?? 0;
    e.invoices += 1;
    e.pcs += x.lines.reduce((a, l) => a + l.quantity, 0);
  }

  return [...m.values()].sort((a, b) => a.from.getTime() - b.from.getTime());
}

/* --- Display labels (`moreItems`, `payLabel`) --- */

export function moreItemsLabel(extraCount: number): string {
  if (extraCount <= 0) return '';
  if (extraCount === 1) return 'وصنف كمان';
  if (extraCount === 2) return 'وصنفين كمان';
  return `و${num(extraCount)} ${extraCount <= 10 ? 'أصناف' : 'صنف'} كمان`;
}

export const SALES_PAYMENT_METHODS: readonly { readonly id: string; readonly name: string }[] = [
  { id: 'cash', name: 'كاش' },
  { id: 'vf', name: 'فودافون كاش' },
  { id: 'instapay', name: 'إنستاباي' },
  { id: 'card', name: 'فيزا / ميزة' },
  { id: 'install', name: 'تقسيط' },
  { id: 'credit', name: 'آجل' },
];

export function paymentMethodName(method: string, reference?: string | null): string {
  const found = SALES_PAYMENT_METHODS.find((m) => m.id === method)?.name ?? method;
  if (method === 'install' && reference) {
    return `${found} (${reference})`;
  }
  return found;
}

export function paymentSummaryLabel(payments: readonly SaleHistoryPayment[]): string {
  if (payments.length === 0) return 'كاش';
  return payments.map((p) => paymentMethodName(p.method, p.reference)).join(' + ');
}
