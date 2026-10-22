// Small, dependency-free helpers shared by the tool, the tests, and the build.
//
// Everything here is pure: no DOM, no sql.js, no I/O. That is what lets the
// same functions run in the browser tool and under `node --test`.

import { sha256 as nobleSha256, sha384 as nobleSha384 } from '@noble/hashes/sha2';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** Money is stored in piastres, never as a float (ADR-010). */
export function toMinor(pounds) {
  const value = Number(pounds);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Piastres back to a display number. */
export function fromMinor(minor) {
  return (Number(minor) || 0) / 100;
}

/** Arabic-Indic (and Persian) digits to ASCII, leaving everything else alone. */
export function latinDigits(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/[\u0660-\u0669]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
}

/**
 * Parse the legacy clock — `٠١:٤٦ م` — into 24-hour pieces.
 *
 * The legacy system writes a wall clock with an Arabic meridiem. A value that
 * cannot be read returns null rather than a guessed hour, and the caller says
 * so in the report.
 */
export function parseClock(text) {
  if (!text) return null;
  const cleaned = latinDigits(String(text)).trim();
  const match = cleaned.match(/^(\d{1,2})\s*:\s*(\d{1,2})\s*(AM|PM|am|pm|ص|م)?$/);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3] || '';
  if (Number.isNaN(hour) || Number.isNaN(minute) || minute > 59) return null;
  if (/^(م|PM|pm)$/.test(meridiem)) {
    if (hour < 12) hour += 12;
  } else if (/^(ص|AM|am)$/.test(meridiem)) {
    if (hour === 12) hour = 0;
  }
  if (hour > 23) return null;
  return { hour, minute };
}

/** `YYYY-MM-DD` plus a legacy clock → epoch milliseconds in local time. */
export function stampMs(day, clockText) {
  if (!day) return null;
  const match = String(day).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const clock = parseClock(clockText) || { hour: 12, minute: 0 };
  const date = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    clock.hour,
    clock.minute,
    0,
    0,
  );
  const value = date.getTime();
  return Number.isFinite(value) ? value : null;
}

/** Midday of a day key: a safe stamp for a record whose clock is unreadable. */
export function middayMs(day) {
  return stampMs(day, '12:00');
}

/** Epoch milliseconds → `YYYY-MM-DD` in local time. */
export function dayOf(ms) {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function monthOf(day) {
  return String(day).slice(0, 7);
}

export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Case- and space-insensitive comparison key for names. */
export function nameKey(text) {
  return normalizeText(text).toLocaleLowerCase('ar-EG');
}

/**
 * A stable UUID-shaped id derived from `seed`.
 *
 * Stable on purpose: re-running the tool over the same backup produces the same
 * ids, so an owner who imports twice (or compares two exports) can tell one row
 * from another. Version 7 and variant bits are set so the value is a valid UUID
 * wherever the app parses one (`UserId`/`ProductId` both do).
 */
export function idFor(seed) {
  const bytes = nobleSha256(utf8ToBytes(`system-sales/migration/v1/${seed}`));
  return uuidFrom(bytes.subarray(0, 16));
}

/** 16 bytes → the canonical 8-4-4-4-12 UUID text with v7/variant bits set. */
function uuidFrom(bytes) {
  const hex = bytesToHex(bytes).split('');
  hex[12] = '7';
  hex[16] = '8';
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`;
}

/** Random UUID v7-ish id for rows the owner adds inside the tool. */
export function newId(prefix = 'added') {
  const random = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(random);
  } else {
    for (let index = 0; index < random.length; index += 1) {
      random[index] = Math.floor(Math.random() * 256);
    }
  }
  return `${prefix ? `${prefix}-` : ''}${uuidFrom(random)}`;
}

/** Text to the UTF-8 bytes every hash and cipher in this tool expects. */
export function utf8Of(text) {
  return utf8ToBytes(String(text));
}

export function sha256Bytes(bytes) {
  return nobleSha256(bytes);
}

/**
 * Standard base64 without padding — the alphabet PHC strings use.
 *
 * `btoa` exists in the browser and in Node 22; the Buffer branch is there so the
 * same function works in any older runtime the tool is ever run under.
 */
export function base64NoPad(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return encoded.replace(/=+$/, '');
}

export function sha256Hex(bytes) {
  return bytesToHex(nobleSha256(bytes));
}

export function sha384Bytes(text) {
  return nobleSha384(utf8ToBytes(text));
}

export function bytesToHexString(bytes) {
  return bytesToHex(bytes);
}

/** Read a value that may be a number, a numeric string, or missing. */
export function numberOr(value, fallback = 0) {
  const parsed = Number(latinDigits(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** `4GB` / `128` / `6 جيجا` → an integer number of gigabytes, or null. */
export function gigabytes(text) {
  const cleaned = latinDigits(text).toLowerCase().replace(/\s+/g, '');
  const match = cleaned.match(/(\d+(?:\.\d+)?)\s*(gb|g|جيجا|جيجابايت)?/);
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
}

/** Group an iterable into a map keyed by `keyOf`. */
export function groupBy(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

export function sum(items, valueOf) {
  return items.reduce((total, item) => total + (valueOf(item) || 0), 0);
}

export function monthLabel(month) {
  const [year, index] = month.split('-');
  const names = [
    'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
    'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر',
  ];
  return `${names[Number(index) - 1] || index} ${year}`;
}
