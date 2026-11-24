// Pure IMEI helpers for receiving and selling phones (`ADR-019`, `docs/PLAN.md` §7,
// `docs/ui/mockup-v1/pos.js`).

import type { PosUnit } from '../../api/pos';

/** Normalize Arabic-Indic digits (`٠`–`٩`, `۰`–`۹`) and strip spaces and dashes. */
export function normalizeImeiDigits(raw: string): string {
  let out = '';
  for (const ch of raw) {
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '-') continue;
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x0660 && code <= 0x0669) {
      out += String(code - 0x0660);
    } else if (code >= 0x06f0 && code <= 0x06f9) {
      out += String(code - 0x06f0);
    } else {
      out += ch;
    }
  }
  return out;
}

/** Standard 15-digit IMEI Luhn check (`docs/ui/mockup-v1/pos.js`, `imeiLuhn`). */
export function imeiLuhn(raw: string): boolean {
  const s = normalizeImeiDigits(raw);
  if (!/^\d{15}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(s[i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(s[14]);
}

export type ImeiValidation =
  | { readonly ok: true; readonly imei: string }
  | {
      readonly ok: false;
      readonly code: 'IMEI_LENGTH_INVALID' | 'IMEI_CHECK_DIGIT_INVALID';
      readonly digits: string;
    };

export function validateImeiInput(raw: string): ImeiValidation {
  const digits = normalizeImeiDigits(raw);
  if (!/^\d{15}$/.test(digits)) {
    return { ok: false, code: 'IMEI_LENGTH_INVALID', digits };
  }
  if (!imeiLuhn(digits)) {
    return { ok: false, code: 'IMEI_CHECK_DIGIT_INVALID', digits };
  }
  return { ok: true, imei: digits };
}

export function isSerialProduct(p: {
  readonly tracking?: string | null;
  readonly brandId?: string | null;
}): boolean {
  if (p.tracking === 'serial_optional' || p.tracking === 'serial_required') return true;
  if (p.tracking === 'none') return Boolean(p.brandId);
  return Boolean(p.brandId);
}

export function requiresImeiOnSale(
  p: { readonly tracking?: string | null; readonly brandId?: string | null },
  globalImeiMode: 'optional' | 'required'
): boolean {
  if (p.tracking === 'serial_required') return true;
  return isSerialProduct(p) && globalImeiMode === 'required';
}

/**
 * Find available `in_stock` units matching a 4–15 digit query (last 4 digits or
 * substring of 8+ digits, matching `docs/ui/mockup-v1/pos.js` `searchAll`).
 */
export function searchUnitsByImei(
  units: readonly PosUnit[],
  query: string,
  takenImeis: ReadonlySet<string>,
  limit = 6
): PosUnit[] {
  const digits = normalizeImeiDigits(query);
  if (!/^\d{4,15}$/.test(digits)) return [];
  const matches: PosUnit[] = [];
  for (const u of units) {
    if (takenImeis.has(u.imei)) continue;
    const matched =
      u.imei.endsWith(digits) ||
      (digits.length >= 8 && u.imei.includes(digits)) ||
      (u.imei2 !== null &&
        (u.imei2.endsWith(digits) || (digits.length >= 8 && u.imei2.includes(digits))));
    if (matched) {
      matches.push(u);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

/**
 * The last digit that makes a 14-digit body a valid IMEI (`Luhn`).
 *
 * The shop's own stand-in numbers have to pass the same check as a real one:
 * the database refuses anything that is not 15 digits, and a number that fails
 * Luhn could not be typed into the box later either.
 */
export function luhnCheckDigit(first14: string): number {
  if (!/^\d{14}$/.test(first14)) return 0;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(first14[i]);
    // The same parity `imeiLuhn` uses for a 15-digit number: the odd positions
    // are the doubled ones, so a body computed here passes that check.
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

/**
 * The number the shop keeps for a device that has no IMEI yet.
 *
 * The owner's rule for the migration was the same one here: «خلي رقم الـ IMEI
 * اصفار لغايه مغيره» — eleven zeros, a three-digit shop counter and the Luhn
 * digit (`000000000000018`). It is a serial the shop owns, not a claim about the
 * handset, and every screen writes it as «بدون IMEI» so nobody mistakes it for
 * one.
 */
export function placeholderImei(counter: number): string {
  const n = Math.abs(Math.trunc(counter)) % 1000;
  const body = `00000000000${String(n).padStart(3, '0')}`;
  return body + String(luhnCheckDigit(body));
}

/** Whether a stored number is one of those stand-ins rather than a real IMEI. */
export function isPlaceholderImei(imei: string | null | undefined): boolean {
  return typeof imei === 'string' && /^0{11}\d{4}$/.test(imei);
}

/** What to show where an IMEI goes: the real one, or «بدون IMEI». */
export function imeiLabel(imei: string | null | undefined): string {
  if (imei === null || imei === undefined || imei.trim() === '') return 'بدون IMEI';
  return isPlaceholderImei(imei) ? 'بدون IMEI' : imei;
}

/** The last four digits, or the words for a stand-in number. */
export function imeiTail(imei: string | null | undefined): string {
  if (imei === null || imei === undefined || imei.trim() === '') return 'بدون IMEI';
  return isPlaceholderImei(imei) ? 'بدون IMEI' : `…${imei.slice(-4)}`;
}

/** The lowest counter whose stand-in number nobody has taken yet. */
export function nextPlaceholderCounter(taken: Iterable<string>): number {
  const used = new Set(taken);
  for (let n = 1; n < 1000; n++) {
    if (!used.has(placeholderImei(n))) return n;
  }
  return 999;
}
