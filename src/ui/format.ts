// Numbers, money and counted words, as the mockup writes them
// (docs/ui/mockup-v1/app.js, «الأرقام والتواريخ»).
//
// Money is stored in piastres (integer minor units, ADR-010) and only ever
// divided by 100 here, for display. Nothing in this file feeds a value back
// into arithmetic.
//
// The digit style (Latin 123 or Arabic-Indic ١٢٣) is a display setting
// (Settings → الشكل). It lives in this module so every formatter agrees.

import { ref } from 'vue';

export type Digits = 'latin' | 'arabic';

let digits: Digits = 'latin';

export function setDigits(next: Digits): void {
  digits = next;
}

export function currentDigits(): Digits {
  return digits;
}

const FORMATS: Record<Digits, Intl.NumberFormat> = {
  latin: new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }),
  arabic: new Intl.NumberFormat('ar-EG', { maximumFractionDigits: 2 }),
};

const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** A number in the shop's digit style, with thousands separators. */
export function num(n: number): string {
  return FORMATS[digits].format(n);
}

/** Digits inside free text (an invoice number, a time) in the shop's style. */
export function dg(text: string | number): string {
  const s = String(text);
  return digits === 'arabic' ? s.replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)] ?? d) : s;
}

/**
 * What the shop types and reads (`Settings → الشكل → وحدة الفلوس`).
 *
 * The database always stores piastres (`ADR-010`); this is the unit on the glass.
 * «جنيه» is the default because that is how a counter speaks, and «قرش» exists for
 * the shops that price small accessories in piastres. It is a `ref` on purpose:
 * every `money()` drawn on a screen re-renders the moment the owner changes the
 * choice, without a page reload.
 */
export type MoneyUnit = 'egp' | 'piastre';

const moneyUnit = ref<MoneyUnit>('egp');

export function setMoneyUnit(next: MoneyUnit): void {
  moneyUnit.value = next;
}

export function currentMoneyUnit(): MoneyUnit {
  return moneyUnit.value;
}

/** The word beside a money field: «جنيه» or «قرش». */
export function moneyUnitWord(): string {
  return moneyUnit.value === 'egp' ? 'جنيه' : 'قرش';
}

/**
 * Piastres → «150 ج.م» / «150.5 ج.م», or «150,000 قرش» in piastre mode. The
 * division is for display only: the formatter rounds to two decimals, and the
 * result is never computed with.
 */
export function money(minor: number): string {
  if (moneyUnit.value === 'piastre') return `${num(minor)} قرش`;
  return `${num(minor / 100)} ج.م`;
}

/** A stored amount → the text a money field should be seeded with, in the current unit. */
export function moneyInputValue(minor: number): string {
  if (moneyUnit.value === 'piastre') return String(Math.round(minor));
  const pounds = minor / 100;
  return Number.isInteger(pounds) ? String(pounds) : pounds.toFixed(2);
}

/** Arabic-Indic and Persian digits → Latin, so input typed either way parses. */
export function toLatinDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Pounds as typed («150», «١٥٠», «1,250.5») → piastres, or `null` when the text
 * is not a non-negative amount with at most two decimals.
 */
export function parseMoney(text: string): number | null {
  const t = toLatinDigits(text).replace(/[,\s٬]/g, '').replace('٫', '.');
  if (moneyUnit.value === 'piastre') {
    // One piastre is the smallest unit, so a fraction of one is not a number this
    // field can hold — it is refused rather than rounded behind the shop's back.
    if (!/^\d+$/.test(t)) return null;
    const minor = Number(t);
    return Number.isSafeInteger(minor) ? minor : null;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  const minor = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return Number.isSafeInteger(minor) ? minor : null;
}

/** A whole count as typed («3», «٣») → number, or `null`. */
export function parseCount(text: string): number | null {
  const t = toLatinDigits(text).trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  return Number(t);
}

/** «قطعة»، «قطعتين»، «5 قطع»، «12 قطعة». */
export function pcsWord(n: number): string {
  return countWord(n, 'قطعة', 'قطعتين', 'قطع');
}

/** «نوع»، «نوعين»، «4 أنواع»، «12 نوع». */
export function kindsWord(n: number): string {
  return countWord(n, 'نوع', 'نوعين', 'أنواع');
}


/** The same rule for any noun: one, two, 3–10, 11+. */
export function countWord(n: number, one: string, two: string, few: string): string {
  if (n === 1) return one;
  if (n === 2) return two;
  return n <= 10 ? `${num(n)} ${few}` : `${num(n)} ${one}`;
}

/** «شهر»، «شهرين»، «3 شهور»، «12 شهر». */
export function monthsTxt(n: number): string {
  return countWord(n, 'شهر', 'شهرين', 'شهور');
}

function locale(): string {
  return digits === 'arabic' ? 'ar-EG' : 'ar-EG-u-nu-latn';
}

export function fmtTime(d: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit' }).format(d);
}

export function fmtDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'numeric', year: 'numeric' }).format(d);
}

/** «صنف»، «صنفين»، «3 أصناف»، «11 صنف». */
export function itemsWord(n: number): string {
  return countWord(n, 'صنف', 'صنفين', 'أصناف');
}

export function fmtMonth(d: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale(), { month: 'long', year: 'numeric' }).format(d);
}

export function monthName(d: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale(), { month: 'long' }).format(d);
}

export function fmtDayDate(d: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'numeric' }).format(d);
}

export function fmtLong(d: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale(), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(d);
}

export function fmtDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat(locale(), { weekday: 'long' }).format(d);
}
