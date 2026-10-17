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
