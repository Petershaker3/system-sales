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

// ---------------------------------------------------------------------------
// Plan item 2.5 — Monthly Reports, Evaluation & Today Dashboard (`ADR-035`,
// `docs/ui/mockup-v1/analytics.js`, `docs/ui/mockup-v1/views/reports.js`,
// `docs/ui/MONTHS-REPORTS-RECEIVING.md`).
// ---------------------------------------------------------------------------

export interface SellerBreakdownRow {
  readonly id: string;
  readonly name: string;
  readonly salesMinor: number;
  readonly profitMinor: number;
  readonly invoices: number;
  readonly avgMinor: number;
}

export interface MethodBreakdownRow {
  readonly id: string;
  readonly name: string;
  readonly amountMinor: number;
  readonly count: number;
}

export type WithChange<T> = T & {
  readonly before: number;
  readonly ch: number | null;
};

export interface PaySplitSlice {
  readonly name: string;
  readonly v: number;
}

export interface TodayDashboardReport {
  readonly salesMinor: number;
  readonly invoices: number;
  readonly profitMinor: number;
  readonly yesterdayMinor: number;
  readonly vsYesterday: number | null;
  readonly week: readonly {
    readonly label: string;
    readonly date: Date;
    readonly iso: string;
    readonly salesMinor: number;
    readonly isToday: boolean;
  }[];
  readonly pay: readonly PaySplitSlice[];
  readonly top: readonly {
    readonly name: string;
    readonly qty: number;
    readonly salesMinor: number;
  }[];
  readonly recent: readonly {
    readonly saleId: string;
    readonly reference: string;
    readonly no: string;
    readonly occurredAt: number;
    readonly seller: string;
    readonly sellerId: string;
    readonly customer: string;
    readonly method: string;
    readonly totalMinor: number;
  }[];
}

export type EvaluationTone = 'good' | 'warn' | 'info';
export type VerdictKey = 'best' | 'top3' | 'low3' | 'mid' | 'early' | 'few';

export interface EvaluationVerdict {
  readonly key: VerdictKey;
  readonly tone: EvaluationTone;
}

export type EvaluationNote =
  | { readonly key: 'sales'; readonly tone: EvaluationTone; readonly ch: number | null }
  | { readonly key: 'yoy'; readonly tone: EvaluationTone; readonly ch: number | null }
  | {
      readonly key: 'margin';
      readonly tone: EvaluationTone;
      readonly now: number;
      readonly before: number;
      readonly mix: { readonly now: number; readonly before: number } | null;
    }
  | { readonly key: 'avg'; readonly tone: EvaluationTone; readonly ch: number; readonly nowMinor: number }
  | { readonly key: 'catUp'; readonly tone: EvaluationTone; readonly id: string; readonly name: string; readonly ch: number }
  | { readonly key: 'catDown'; readonly tone: EvaluationTone; readonly id: string; readonly name: string; readonly ch: number }
  | { readonly key: 'disc'; readonly tone: EvaluationTone; readonly nowMinor: number; readonly beforeMinor: number }
  | { readonly key: 'credit'; readonly tone: EvaluationTone; readonly nowMinor: number; readonly beforeMinor: number }
  | { readonly key: 'top'; readonly tone: EvaluationTone; readonly name: string; readonly qty: number; readonly salesMinor: number }
  | { readonly key: 'bestDay'; readonly tone: EvaluationTone; readonly day: Date; readonly salesMinor: number }
  | { readonly key: 'weekdays'; readonly tone: EvaluationTone; readonly days: readonly [number, number]; readonly share: number }
  | { readonly key: 'seller'; readonly tone: EvaluationTone; readonly id: string; readonly name: string; readonly share: number };

export interface MonthTrendRow extends MonthBreakdownRow {
  readonly perDayMinor: number;
  readonly live: boolean;
}

export interface MonthReportResult {
  readonly from: Date;
  readonly to: Date;
  readonly last: Date;
  readonly live: boolean;
  readonly rows: readonly FilteredSaleRow[];
  readonly T: SalesTotals;
  readonly P: { readonly from: Date; readonly to: Date; readonly partial: boolean; readonly live: boolean; readonly end: Date };
  readonly PT: SalesTotals;
  readonly Y: { readonly from: Date; readonly to: Date; readonly live: boolean; readonly end: Date };
  readonly YT: SalesTotals | null;
  readonly days: readonly DayBreakdownRow[];
  readonly done: number;
  readonly perDayMinor: number;
  readonly projectionMinor: number | null;
  readonly phones: {
    readonly all: number;
    readonly fresh: number;
    readonly used: number;
    readonly before: number;
  };
  readonly mix: {
    readonly now: number;
    readonly before: number;
  };
  readonly cats: readonly WithChange<Omit<CategoryBreakdownRow, 'subs'>>[];
  readonly products: readonly WithChange<ProductBreakdownRow>[];
  readonly sellers: readonly WithChange<SellerBreakdownRow>[];
  readonly methods: readonly WithChange<MethodBreakdownRow>[];
  readonly months: readonly MonthTrendRow[];
  readonly rank: number | null;
  readonly of: number;
  readonly verdict: EvaluationVerdict;
  readonly notes: readonly EvaluationNote[];
  readonly discMinor: number;
}

export const EVALUATION_THRESHOLDS = {
  sales: 3,
  avg: 5,
  margin: 1,
  cat: 10,
} as const;

export function yearAgo(
  from: Date,
  to: Date,
  now: Date = new Date(),
): { from: Date; to: Date; live: boolean; end: Date } {
  const f = new Date(from.getFullYear() - 1, from.getMonth(), from.getDate());
  let t = new Date(to.getFullYear() - 1, to.getMonth(), to.getDate());
  if (t.getMonth() !== to.getMonth()) {
    // Handle Feb 29 leap year gracefully
    t = monthEnd(new Date(to.getFullYear() - 1, to.getMonth(), 1));
  }
  const live = sameDay(to, now);
  return {
    from: f,
    to: t,
    live,
    end: spanEnd(t, live, now),
  };
}

export function bySeller(rows: readonly FilteredSaleRow[]): SellerBreakdownRow[] {
  const m = new Map<string, {
    id: string;
    name: string;
    salesMinor: number;
    profitMinor: number;
    invoices: number;
  }>();

  for (const r of rows) {
    const k = r.x.soldBy;
    const e = m.get(k) ?? {
      id: k,
      name: r.x.sellerName || k,
      salesMinor: 0,
      profitMinor: 0,
      invoices: 0,
    };
    e.salesMinor += rowAmountMinor(r);
    e.profitMinor += rowProfitMinor(r);
    e.invoices += 1;
    m.set(k, e);
  }

  return [...m.values()]
    .map((e) => ({
      ...e,
      avgMinor: e.invoices ? Math.round(e.salesMinor / e.invoices) : 0,
    }))
    .sort((a, b) => b.salesMinor - a.salesMinor);
}

export function byMethod(rows: readonly FilteredSaleRow[]): MethodBreakdownRow[] {
  const m = new Map<string, {
    id: string;
    name: string;
    amountMinor: number;
    count: number;
  }>();

  for (const r of rows) {
    for (const p of r.x.payments) {
      const e = m.get(p.method) ?? {
        id: p.method,
        name: paymentMethodName(p.method),
        amountMinor: 0,
        count: 0,
      };
      e.amountMinor += p.amountMinor;
      e.count += 1;
      m.set(p.method, e);
    }
  }

  return [...m.values()].sort((a, b) => b.amountMinor - a.amountMinor);
}

export function withChange<T>(
  now: readonly T[],
  before: readonly T[],
  keyFn: (item: T) => string,
  valFn: (item: T) => number,
): WithChange<T>[] {
  const m = new Map(before.map((e) => [keyFn(e), e]));
  return now.map((e) => {
    const b = m.get(keyFn(e));
    const nowVal = valFn(e);
    const beforeVal = b ? valFn(b) : 0;
    return {
      ...e,
      before: beforeVal,
      ch: b ? pct(nowVal, beforeVal) : null,
    };
  });
}

export function paySplit(
  payByMethodName: Readonly<Record<string, number>>,
  max = 5,
): PaySplitSlice[] {
  const entries = Object.entries(payByMethodName).filter(([, v]) => v > 0);
  const sum = entries.reduce((a, [, v]) => a + v, 0);
  if (sum <= 0 || entries.length === 0) return [];
  let rows: [string, number][] = entries.sort((a, b) => b[1] - a[1]);
  if (rows.length > max) {
    const restSum = rows.slice(max - 1).reduce((a, r) => a + r[1], 0);
    rows = [...rows.slice(0, max - 1), ['تاني', restSum]];
  }
  const split = rows.map(([name, v]) => ({
    name,
    v: Math.round((v / sum) * 100),
  }));
  if (split.length > 0 && split[0]) {
    const diff = 100 - split.reduce((a, p) => a + p.v, 0);
    split[0] = { name: split[0].name, v: split[0].v + diff };
  }
  return split;
}

function isUsedPhoneLine(
  l: SaleHistoryLine,
  isUsedCategory?: (catId: string | null) => boolean,
): boolean {
  if (!l.imei) return false;
  if (isUsedCategory && isUsedCategory(l.categoryId)) return true;
  if (
    l.categoryId === '01a14728-8400-7000-8000-000000000002' ||
    l.categoryId === 'used'
  ) {
    return true;
  }
  if (l.categoryName && l.categoryName.includes('مستعمل')) {
    return true;
  }
  return false;
}

function toneOf(ch: number | null, th: number): EvaluationTone {
  if (ch === null) return 'info';
  if (ch >= th) return 'good';
  if (ch <= -th) return 'warn';
  return 'info';
}

export function monthReport(
  list: readonly SaleHistoryEntry[],
  month: Date,
  now: Date = new Date(),
  options?: {
    readonly categoryNameById?: (id: string) => string;
    readonly isUsedCategory?: (catId: string | null) => boolean;
  },
): MonthReportResult {
  const from = monthStart(month);
  const last = monthEnd(month);
  const today = dayStart(now);
  const to = last.getTime() > today.getTime() ? today : last;
  const live = sameDay(to, now);

  const rows = asRows(inRange(list, from, to));
  const T = totalsOf(rows);

  const P = comparePeriod(from, to, true, now);
  const pRows = asRows(inSpan(list, P.from, P.end));
  const PT = totalsOf(pRows);

  const Y = yearAgo(from, to, now);
  const yRows = asRows(inSpan(list, Y.from, Y.end));
  const YT = yRows.length > 0 ? totalsOf(yRows) : null;

  const days = byDay(rows, from, to);
  const doneDays = live ? days.slice(0, -1) : days;
  const doneSalesMinor = doneDays.reduce((a, d) => a + d.salesMinor, 0);
  const perDayMinor =
    doneDays.length > 0 ? Math.round(doneSalesMinor / doneDays.length) : 0;
  const projectionMinor =
    live && doneDays.length > 0 ? perDayMinor * daysIn(from, last) : null;

  const countUnits = (
    rs: readonly FilteredSaleRow[],
    mode: 'all' | 'fresh' | 'used',
  ): number =>
    rs.reduce(
      (a, r) =>
        a +
        r.lines
          .filter((l) => {
            if (!l.imei) return false;
            const used = isUsedPhoneLine(l, options?.isUsedCategory);
            if (mode === 'used') return used;
            if (mode === 'fresh') return !used;
            return true;
          })
          .reduce((b, l) => b + l.quantity, 0),
      0,
    );

  const phones = {
    all: countUnits(rows, 'all'),
    fresh: countUnits(rows, 'fresh'),
    used: countUnits(rows, 'used'),
    before: countUnits(pRows, 'all'),
  };

  const catsNow = byCategory(rows, options?.categoryNameById).map(
    ({ subs: _subs, ...rest }) => rest,
  );
  const catsBefore = byCategory(pRows, options?.categoryNameById).map(
    ({ subs: _subs, ...rest }) => rest,
  );
  const cats = withChange(
    catsNow,
    catsBefore,
    (c) => c.id,
    (c) => c.salesMinor,
  );

  const products = withChange(
    byProduct(rows),
    byProduct(pRows),
    (p) => p.name,
    (p) => p.salesMinor,
  );

  const sellers = withChange(
    bySeller(rows),
    bySeller(pRows),
    (s) => s.id,
    (s) => s.salesMinor,
  );

  const methods = withChange(
    byMethod(rows),
    byMethod(pRows),
    (m) => m.id,
    (m) => m.amountMinor,
  );

  const key = monthKey(from);
  const months: MonthTrendRow[] = byMonth(list)
    .filter((m) => m.from.getTime() <= from.getTime())
    .slice(-12)
    .map((m) => ({
      ...m,
      perDayMinor:
        m.key === key
          ? perDayMinor
          : Math.round(m.salesMinor / daysIn(m.from, monthEnd(m.from))),
      live: m.key === key && live,
    }));

  const rank =
    doneDays.length > 0
      ? 1 +
        months.filter((m) => m.key !== key && m.perDayMinor > perDayMinor).length
      : null;

  const notes: EvaluationNote[] = [];
  const chSales = PT.salesMinor ? pct(T.salesMinor, PT.salesMinor) : null;
  notes.push({
    key: 'sales',
    tone: toneOf(chSales, EVALUATION_THRESHOLDS.sales),
    ch: chSales,
  });

  if (YT && YT.salesMinor > 0) {
    const chYoy = pct(T.salesMinor, YT.salesMinor);
    notes.push({
      key: 'yoy',
      tone: toneOf(chYoy, EVALUATION_THRESHOLDS.sales),
      ch: chYoy,
    });
  }

  const mNow = T.salesMinor ? (T.profitMinor / T.salesMinor) * 100 : 0;
  const mBefore = PT.salesMinor ? (PT.profitMinor / PT.salesMinor) * 100 : 0;

  const phoneShare = (rs: readonly FilteredSaleRow[], t: SalesTotals): number =>
    t.salesMinor
      ? Math.round(
          (rs.reduce(
            (a, r) =>
              a +
              r.lines
                .filter((l) => Boolean(l.imei))
                .reduce((b, l) => b + l.lineTotalMinor, 0),
            0,
          ) /
            t.salesMinor) *
            100,
        )
      : 0;

  const mix = {
    now: phoneShare(rows, T),
    before: phoneShare(pRows, PT),
  };

  if (PT.salesMinor > 0 && Math.abs(mNow - mBefore) >= EVALUATION_THRESHOLDS.margin) {
    const down = mNow < mBefore;
    const why =
      (down && mix.now - mix.before >= 5) ||
      (!down && mix.before - mix.now >= 5);
    notes.push({
      key: 'margin',
      tone: down ? 'warn' : 'good',
      now: Math.round(mNow),
      before: Math.round(mBefore),
      mix: why ? mix : null,
    });
  }

  const chAvg = PT.avgMinor ? pct(T.avgMinor, PT.avgMinor) : null;
  if (chAvg !== null && Math.abs(chAvg) >= EVALUATION_THRESHOLDS.avg) {
    notes.push({
      key: 'avg',
      tone: chAvg > 0 ? 'good' : 'warn',
      ch: chAvg,
      nowMinor: T.avgMinor,
    });
  }

  const movers = cats.filter(
    (c): c is WithChange<Omit<CategoryBreakdownRow, 'subs'>> & { readonly ch: number } =>
      c.ch !== null && c.before >= Math.max(100_000, PT.salesMinor * 0.02),
  );
  const up = movers.reduce<(typeof movers)[number] | null>(
    (a, c) => (!a || c.ch > a.ch ? c : a),
    null,
  );
  const down = movers.reduce<(typeof movers)[number] | null>(
    (a, c) => (!a || c.ch < a.ch ? c : a),
    null,
  );
  if (up && up.ch >= EVALUATION_THRESHOLDS.cat) {
    notes.push({
      key: 'catUp',
      tone: 'good',
      id: up.id,
      name: up.name,
      ch: up.ch,
    });
  }
  if (down && down.ch <= -EVALUATION_THRESHOLDS.cat) {
    notes.push({
      key: 'catDown',
      tone: 'warn',
      id: down.id,
      name: down.name,
      ch: down.ch,
    });
  }

  const discMinor = rows.reduce((a, r) => a + r.x.discountMinor, 0);
  const discBeforeMinor = pRows.reduce((a, r) => a + r.x.discountMinor, 0);
  const rate = (v: number, t: SalesTotals): number =>
    t.salesMinor ? (v / t.salesMinor) * 100 : 0;
  if (
    PT.salesMinor > 0 &&
    discMinor - discBeforeMinor >= 50_000 &&
    rate(discMinor, T) - rate(discBeforeMinor, PT) >= 0.3
  ) {
    notes.push({
      key: 'disc',
      tone: 'warn',
      nowMinor: discMinor,
      beforeMinor: discBeforeMinor,
    });
  }

  const credit = methods.find((m) => m.id === 'credit') ?? {
    amountMinor: 0,
    before: 0,
  };
  if (
    PT.salesMinor > 0 &&
    credit.amountMinor >= T.salesMinor * 0.02 &&
    rate(credit.amountMinor, T) - rate(credit.before, PT) >= 0.5
  ) {
    notes.push({
      key: 'credit',
      tone: 'warn',
      nowMinor: credit.amountMinor,
      beforeMinor: credit.before,
    });
  }

  if (products.length > 0 && products[0]) {
    notes.push({
      key: 'top',
      tone: 'info',
      name: products[0].name,
      qty: products[0].qty,
      salesMinor: products[0].salesMinor,
    });
  }

  const best = days.reduce<DayBreakdownRow | undefined>(
    (a, d) => (!a || d.salesMinor > a.salesMinor ? d : a),
    days[0],
  );
  if (best && best.salesMinor > 0) {
    notes.push({
      key: 'bestDay',
      tone: 'info',
      day: best.day,
      salesMinor: best.salesMinor,
    });
  }

  const wd = [0, 0, 0, 0, 0, 0, 0];
  for (const d of days) {
    const idx = d.day.getDay();
    wd[idx] = (wd[idx] ?? 0) + d.salesMinor;
  }
  const top2 = wd
    .map((v, i) => [i, v] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2);
  if (T.salesMinor > 0 && days.length >= 14 && top2[0] && top2[1]) {
    notes.push({
      key: 'weekdays',
      tone: 'info',
      days: [top2[0][0], top2[1][0]],
      share: Math.round(((top2[0][1] + top2[1][1]) / T.salesMinor) * 100),
    });
  }

  if (sellers.length > 1 && T.salesMinor > 0 && sellers[0]) {
    notes.push({
      key: 'seller',
      tone: 'info',
      id: sellers[0].id,
      name: sellers[0].name,
      share: Math.round((sellers[0].salesMinor / T.salesMinor) * 100),
    });
  }

  const of = months.length;
  const verdict: EvaluationVerdict =
    rank === null
      ? { key: 'early', tone: 'info' }
      : of < 3
        ? { key: 'few', tone: 'info' }
        : rank === 1
          ? { key: 'best', tone: 'good' }
          : rank <= 3
            ? { key: 'top3', tone: 'good' }
            : of >= 6 && rank > of - 3
              ? { key: 'low3', tone: 'warn' }
              : { key: 'mid', tone: 'info' };

  return {
    from,
    to,
    last,
    live,
    rows,
    T,
    P,
    PT,
    Y,
    YT,
    days,
    done: doneDays.length,
    perDayMinor,
    projectionMinor,
    phones,
    mix,
    cats,
    products,
    sellers,
    methods,
    months,
    rank,
    of,
    verdict,
    notes,
    discMinor,
  };
}

export function todayReport(
  list: readonly SaleHistoryEntry[],
  now: Date = new Date(),
  weekdayLabelFn?: (d: Date) => string,
): TodayDashboardReport {
  const today = dayStart(now);
  const ySame = spanEnd(addDays(today, -1), true, now);
  const weekValues = [0, 0, 0, 0, 0, 0, 0];
  const pay: Record<string, number> = {};
  const topMap = new Map<string, { name: string; qty: number; salesMinor: number }>();
  const todays: SaleHistoryEntry[] = [];

  let salesMinor = 0;
  let invoices = 0;
  let profitMinor = 0;
  let yesterdayMinor = 0;

  for (const x of list) {
    if (x.isCancelled) continue;
    const xDay = dayStart(new Date(x.occurredAt));
    const back = Math.round((today.getTime() - xDay.getTime()) / 86_400_000);
    if (back >= 0 && back < 7) {
      const idx = 6 - back;
      weekValues[idx] = (weekValues[idx] ?? 0) + x.totalMinor;
    }
    if (back === 1 && x.occurredAt < ySame.getTime()) {
      yesterdayMinor += x.totalMinor;
    }
    if (back !== 0) continue;

    todays.push(x);
    salesMinor += x.totalMinor;
    invoices += 1;
    profitMinor += x.profitMinor ?? 0;

    for (const p of x.payments) {
      const mName = paymentMethodName(p.method);
      pay[mName] = (pay[mName] ?? 0) + p.amountMinor;
    }
    for (const l of x.lines) {
      const existing = topMap.get(l.productName) ?? {
        name: l.productName,
        qty: 0,
        salesMinor: 0,
      };
      existing.qty += l.quantity;
      existing.salesMinor += l.lineTotalMinor;
      topMap.set(l.productName, existing);
    }
  }

  const week = weekValues.map((v, i) => {
    const dt = addDays(today, -(6 - i));
    const isToday = i === 6;
    const label = isToday
      ? 'النهارده'
      : weekdayLabelFn
        ? weekdayLabelFn(dt)
        : isoDay(dt);
    return {
      label,
      date: dt,
      iso: isoDay(dt),
      salesMinor: v,
      isToday,
    };
  });

  const split = paySplit(pay);
  const top = [...topMap.values()]
    .sort((a, b) => b.qty - a.qty || b.salesMinor - a.salesMinor)
    .slice(0, 5);

  const recent = todays
    .slice()
    .sort((a, b) => b.occurredAt - a.occurredAt)
    .slice(0, 8)
    .map((x) => ({
      saleId: x.saleId,
      reference: x.reference,
      no: extractInvoiceDigits(x.reference) || x.reference,
      occurredAt: x.occurredAt,
      seller: x.sellerName,
      sellerId: x.soldBy,
      customer: x.customerName ?? 'نقدي',
      method: paymentSummaryLabel(x.payments),
      totalMinor: x.totalMinor,
    }));

  return {
    salesMinor,
    invoices,
    profitMinor,
    yesterdayMinor,
    vsYesterday: yesterdayMinor > 0 ? pct(salesMinor, yesterdayMinor) : null,
    week,
    pay: split,
    top,
    recent,
  };
}

/** «آخر 7 شهور» / «آخر 12 شهر». */
export function nMonthsLabel(n: number): string {
  return `${num(n)} ${n >= 3 && n <= 10 ? 'شهور' : 'شهر'}`;
}

/** Compact label above bars: «2.37 مليون» / «171.5 ألف» / «450». Input is piastres. */
export function kShortMinor(minor: number): string {
  const pounds = minor / 100;
  if (pounds >= 1_000_000) {
    return `${num(Math.round(pounds / 10_000) / 100)} مليون`;
  }
  if (pounds >= 1_000) {
    return `${num(Math.round(pounds / 100) / 10)} ألف`;
  }
  return num(Math.round(pounds));
}

/**
 * Format a percentage change cell for tables (`docs/ui/mockup-v1/views/reports.js: chgCell`):
 * - `null` → `{ kind: 'new', text: 'جديد' }`
 * - `0` → `{ kind: 'zero', text: '0%' }` (no arrow)
 * - `>= 300` → `{ kind: 'up', text: '×N' }` (multiplier instead of huge `%`)
 * - `> 0` → `{ kind: 'up', text: 'N%' }`
 * - `< 0` → `{ kind: 'down', text: 'N%' }`
 */
export function chgFormat(ch: number | null): {
  readonly kind: 'new' | 'zero' | 'up' | 'down';
  readonly text: string;
} {
  if (ch === null) return { kind: 'new', text: 'جديد' };
  if (ch === 0) return { kind: 'zero', text: '0%' };
  if (ch >= 300) {
    return { kind: 'up', text: `×${num(Math.round(ch / 100 + 1))}` };
  }
  return {
    kind: ch > 0 ? 'up' : 'down',
    text: `${num(Math.abs(ch))}%`,
  };
}

