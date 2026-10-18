// Barcode label encoding (GS1 EAN-13 + Code-128B), internal shop code helpers,
// TSPL2 thermal label script builder, and 2x High-DPI label sheet renderer
// (`docs/PLAN.md` §6 & §19, `ADR-016` #12 & D5, `ADR-033`).

import { money, num, toLatinDigits } from '../../ui/format.ts';

export type LabelSizeId = '40x30' | '50x25' | '38x25' | '50x30';

export interface LabelSizePreset {
  readonly id: LabelSizeId;
  readonly label: string;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly desc: string;
}

export const LABEL_SIZES: readonly LabelSizePreset[] = [
  {
    id: '40x30',
    label: '40×30 مم (قياسي)',
    widthMm: 40,
    heightMm: 30,
    desc: 'المقاس القياسي لطابعات الملصقات الحرارية (Xprinter / TSC)',
  },
  {
    id: '50x25',
    label: '50×25 مم',
    widthMm: 50,
    heightMm: 25,
    desc: 'ملصق عريض للجرابات والشواحن والسماعات',
  },
  {
    id: '38x25',
    label: '38×25 مم',
    widthMm: 38,
    heightMm: 25,
    desc: 'ملصق صغير للكابلات والقطع الصغيرة',
  },
  {
    id: '50x30',
    label: '50×30 مم (علبة)',
    widthMm: 50,
    heightMm: 30,
    desc: 'ستيكر علبة الموبايل الجديد والمستعمل بالـ IMEI والحالة',
  },
];

export function getLabelSizePreset(id: LabelSizeId): LabelSizePreset {
  return LABEL_SIZES.find((s) => s.id === id) ?? LABEL_SIZES[0]!;
}

export interface LabelPrintOptions {
  readonly size: LabelSizeId;
  readonly showShopName: boolean;
  readonly showPrice: boolean;
  readonly showUnitDetails: boolean;
}

export interface LabelQueueItem {
  readonly key: string;
  readonly kind: 'product' | 'unit';
  readonly productId: string;
  readonly unitId?: string | null;
  readonly name: string;
  readonly categoryLabel: string;
  readonly barcode: string;
  readonly imei2?: string | null;
  readonly salePriceMinor: number | null;
  readonly onHand: number;
  readonly conditionGrade?: string | null;
  readonly batteryHealthPct?: number | null;
  readonly color?: string | null;
  readonly accessories?: string | null;
  readonly copies: number;
}

/** Compute the EAN-13 check digit (`0..9`) for a 12-digit ASCII body. */
export function ean13CheckDigit(body12: string): number | null {
  if (!/^\d{12}$/.test(body12)) return null;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = body12.charCodeAt(i) - 48;
    sum += d * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

/** Check whether `code` is a valid 13-digit EAN-13 barcode. */
export function isValidEan13(code: string | null | undefined): boolean {
  if (!code) return false;
  const clean = toLatinDigits(code).trim();
  if (!/^\d{13}$/.test(clean)) return false;
  const expected = ean13CheckDigit(clean.slice(0, 12));
  return expected !== null && expected === clean.charCodeAt(12) - 48;
}

/** Check whether `code` is an internal shop EAN-13 code (`2000000000015`..). */
export function isInternalShopCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const clean = toLatinDigits(code).trim();
  return clean.startsWith('2') && isValidEan13(clean);
}

const EAN13_PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
] as const;

const EAN13_L = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
] as const;

const EAN13_G = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
] as const;

const EAN13_R = [
  '1110010',
  '1100110',
  '1101100',
  '1000010',
  '1011100',
  '1001110',
  '1010000',
  '1000100',
  '1001000',
  '1110100',
] as const;

/**
 * Encode a valid 13-digit EAN-13 barcode into its exact 95-module GS1 bitstring
 * (`'1'` = black bar, `'0'` = white space). Returns `null` if not a valid EAN-13.
 */
export function encodeEan13Bars(raw: string): string | null {
  const clean = toLatinDigits(raw).trim();
  if (!isValidEan13(clean)) return null;
  const first = clean.charCodeAt(0) - 48;
  const parity = EAN13_PARITY[first]!;
  let out = '101';
  for (let i = 0; i < 6; i++) {
    const d = clean.charCodeAt(i + 1) - 48;
    out += parity[i] === 'G' ? EAN13_G[d]! : EAN13_L[d]!;
  }
  out += '01010';
  for (let i = 7; i < 13; i++) {
    const d = clean.charCodeAt(i) - 48;
    out += EAN13_R[d]!;
  }
  out += '101';
  return out;
}

// Standard ISO/IEC 15417 Code-128 11-module patterns for values 0..105 + 13-module Stop (106).
const CODE128_PATTERNS: readonly string[] = [
  '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100',
  '10011001000', '10011000100', '10001100100', '11001001000', '11001000100', '11000100100',
  '10110011100', '10011011100', '10011001110', '10111001100', '10011101100', '10011100110',
  '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
  '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010',
  '11011011000', '11011000110', '11000110110', '10100011000', '10001011000', '10001000110',
  '10110001000', '10001101000', '10001100010', '11010001000', '11000101000', '11000100010',
  '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
  '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110',
  '11101011000', '11101000110', '11100010110', '11101101000', '11101100010', '11100011010',
  '11101111010', '11001000010', '11110001010', '10100110000', '10100001100', '10010110000',
  '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
  '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010',
  '11000010100', '10001111010', '10100111100', '10010111100', '10010011110', '10111100100',
  '10011110100', '10011110010', '11110100100', '11110010100', '11110010010', '11011011110',
  '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
  '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110',
  '11110101110', '11010000100', '11010010000', '11010011100', '1100011101011',
];

/**
 * Encode an ASCII string (such as a 15-digit IMEI or custom SKU) into a
 * Code-128 Subset B binary bar pattern (`'1'` = bar, `'0'` = space).
 */
export function encodeCode128Bars(raw: string): string {
  const clean = toLatinDigits(raw)
    .trim()
    .replace(/[^\x20-\x7E]/g, '');
  const text = clean || '0';
  let checksum = 104; // Start Code B
  let out = CODE128_PATTERNS[104]!;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i) - 32;
    const val = code >= 0 && code <= 94 ? code : 0;
    checksum += val * (i + 1);
    out += CODE128_PATTERNS[val]!;
  }
  const checkSymbol = checksum % 103;
  out += CODE128_PATTERNS[checkSymbol]!;
  out += CODE128_PATTERNS[106]!; // Stop pattern (13 modules)
  return out;
}

export interface BarcodeRect {
  readonly x: number;
  readonly w: number;
}

export interface EncodedBarcode {
  readonly kind: 'ean13' | 'code128';
  readonly normalized: string;
  readonly bars: string;
  readonly totalModules: number;
  readonly rects: readonly BarcodeRect[];
}

/** Merge consecutive `'1'` modules in a binary bar string into `{ x, w }` SVG/Canvas runs. */
export function barsToSvgRects(bars: string): readonly BarcodeRect[] {
  const rects: BarcodeRect[] = [];
  let i = 0;
  while (i < bars.length) {
    if (bars[i] === '1') {
      const start = i;
      while (i < bars.length && bars[i] === '1') {
        i++;
      }
      rects.push({ x: start, w: i - start });
    } else {
      i++;
    }
  }
  return rects;
}

/**
 * Encode any product barcode or 15-digit IMEI into a scannable 1D barcode
 * (`ean13` when 13 valid digits, `code128` otherwise).
 */
export function encodeBarcode(raw: string): EncodedBarcode {
  const normalized = toLatinDigits(raw).trim();
  const eanBars = encodeEan13Bars(normalized);
  if (eanBars !== null) {
    return {
      kind: 'ean13',
      normalized,
      bars: eanBars,
      totalModules: eanBars.length,
      rects: barsToSvgRects(eanBars),
    };
  }
  const c128Bars = encodeCode128Bars(normalized);
  return {
    kind: 'code128',
    normalized: normalized || '0',
    bars: c128Bars,
    totalModules: c128Bars.length,
    rects: barsToSvgRects(c128Bars),
  };
}

/** Build the compact subtitle line for an IMEI unit label (`فئة A · بطارية 91% · أسود`). */
export function buildUnitLabelSubtitle(item: LabelQueueItem): string {
  const parts: string[] = [];
  if (item.conditionGrade) {
    parts.push(`فئة ${item.conditionGrade}`);
  }
  if (typeof item.batteryHealthPct === 'number' && item.batteryHealthPct > 0) {
    parts.push(`بطارية ${num(item.batteryHealthPct)}%`);
  }
  if (item.color) {
    parts.push(item.color);
  }
  if (item.accessories) {
    parts.push(item.accessories);
  }
  return parts.join(' · ');
}

/** Sum the total number of physical stickers across all queued items. */
export function totalLabelsCount(items: readonly LabelQueueItem[]): number {
  return items.reduce((sum, item) => sum + Math.max(0, Math.trunc(item.copies)), 0);
}

/** Expand a queue of items with `copies` into flat single-sticker entries (capped at `maxStickers`). */
export function expandLabelQueue(
  items: readonly LabelQueueItem[],
  maxStickers = 60,
): readonly LabelQueueItem[] {
  const out: LabelQueueItem[] = [];
  for (const item of items) {
    const count = Math.max(0, Math.trunc(item.copies));
    for (let i = 0; i < count; i++) {
      if (out.length >= maxStickers) return out;
      out.push(item);
    }
  }
  return out;
}

/**
 * Build a TSPL2 command program (`SIZE`, `GAP`, `DIRECTION`, `CLS`, `TEXT`, `BARCODE`, `PRINT`)
 * ready for Xprinter / TSC thermal label printers (`ADR-016` #12, `ADR-033`).
 */
export function buildTsplScript(
  items: readonly LabelQueueItem[],
  options: LabelPrintOptions,
  shopName: string,
): string {
  const preset = getLabelSizePreset(options.size);
  const active = items.filter((item) => item.copies > 0 && item.barcode.trim() !== '');
  if (active.length === 0) return '';

  const lines: string[] = [
    `SIZE ${preset.widthMm} mm, ${preset.heightMm} mm`,
    'GAP 2 mm, 0 mm',
    'DIRECTION 1',
  ];

  const cleanShop = shopName.replace(/"/g, "'").trim();

  for (const item of active) {
    const copies = Math.max(1, Math.trunc(item.copies));
    const code = toLatinDigits(item.barcode).trim().replace(/"/g, '');
    const sym = isValidEan13(code) ? 'EAN13' : '128';
    const cleanName = item.name.replace(/"/g, "'").trim();
    const priceStr =
      options.showPrice && item.salePriceMinor !== null
        ? money(item.salePriceMinor).replace(/"/g, "'")
        : '';
    const unitSub =
      options.showUnitDetails && item.kind === 'unit'
        ? buildUnitLabelSubtitle(item).replace(/"/g, "'")
        : '';

    lines.push('CLS');
    if (options.showShopName && cleanShop) {
      lines.push(`TEXT 16,12,"TSS24.BF2",0,1,1,"${cleanShop}"`);
    }
    lines.push(`TEXT 16,40,"TSS24.BF2",0,1,1,"${cleanName}"`);
    if (unitSub) {
      lines.push(`TEXT 16,66,"TSS24.BF2",0,1,1,"${unitSub}"`);
    }
    lines.push(`BARCODE 24,96,"${sym}",56,1,0,2,2,"${code}"`);
    if (priceStr) {
      lines.push(`TEXT 16,184,"TSS24.BF2",0,1,1,"${priceStr}"`);
    }
    lines.push(`PRINT ${copies},1`);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Render the queued labels onto a 2x High-DPI `<canvas>` sheet so Arabic glyph
 * shaping, shop name, price, used-phone grade/battery, and barcode bars print
 * identically on any thermal or standard printer (`ADR-004`, `ADR-033`).
 */
export function renderLabelsSheetCanvas(
  items: readonly LabelQueueItem[],
  options: LabelPrintOptions,
  shopName: string,
): HTMLCanvasElement {
  const preset = getLabelSizePreset(options.size);
  const expanded = expandLabelQueue(items, 60);
  const count = Math.max(1, expanded.length);

  // 8 dots/mm (203 DPI thermal standard) × 2x supersampling = 16 px/mm
  const pxPerMm = 8;
  const scale = 2;
  const labelW = preset.widthMm * pxPerMm;
  const labelH = preset.heightMm * pxPerMm;
  const gap = 12;
  const cols = count === 1 ? 1 : Math.min(2, count);
  const rows = Math.ceil(count / cols);

  const totalW = cols * labelW + (cols + 1) * gap;
  const totalH = rows * labelH + (rows + 1) * gap;

  const canvas = document.createElement('canvas');
  canvas.width = totalW * scale;
  canvas.height = totalH * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.scale(scale, scale);
  ctx.fillStyle = '#f4f5f7';
  ctx.fillRect(0, 0, totalW, totalH);

  const fontStack = '"Cairo", "Tajawal", "IBM Plex Sans Arabic", system-ui, sans-serif';
  const monoStack = 'ui-monospace, "Cascadia Mono", "Consolas", monospace';

  expanded.forEach((item, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const x = gap + col * (labelW + gap);
    const y = gap + row * (labelH + gap);

    // Sticker background + hairline border
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x, y, labelW, labelH);
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 1, y + 1, labelW - 2, labelH - 2);

    let curY = y + 14;
    const centerX = x + labelW / 2;

    if (options.showShopName && shopName.trim()) {
      ctx.fillStyle = '#4b5563';
      ctx.font = `600 11px ${fontStack}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(shopName.trim(), centerX, curY, labelW - 20);
      curY += 16;
    }

    // Product / phone title
    ctx.fillStyle = '#111827';
    ctx.font = `700 13px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(item.name, centerX, curY, labelW - 16);
    curY += 18;

    // Optional used-phone subtitle (grade, battery %, color)
    const unitSub =
      options.showUnitDetails && item.kind === 'unit' ? buildUnitLabelSubtitle(item) : '';
    if (unitSub) {
      ctx.fillStyle = '#1d4f91';
      ctx.font = `600 11px ${fontStack}`;
      ctx.fillText(unitSub, centerX, curY, labelW - 16);
      curY += 16;
    }

    // Barcode bars
    const encoded = encodeBarcode(item.barcode);
    const quietZone = 16;
    const availW = labelW - quietZone * 2;
    const modW = Math.max(1.2, availW / Math.max(1, encoded.totalModules));
    const actualBarW = encoded.totalModules * modW;
    const barStartX = x + (labelW - actualBarW) / 2;
    const footerReserved = options.showPrice && item.salePriceMinor !== null ? 44 : 24;
    const barH = Math.max(36, y + labelH - curY - footerReserved);

    ctx.fillStyle = '#000000';
    for (const r of encoded.rects) {
      ctx.fillRect(barStartX + r.x * modW, curY, r.w * modW, barH);
    }
    curY += barH + 4;

    // Human-readable barcode / IMEI digits
    ctx.fillStyle = '#111827';
    ctx.font = `700 11px ${monoStack}`;
    ctx.textAlign = 'center';
    ctx.fillText(
      item.kind === 'unit' ? `IMEI: ${encoded.normalized}` : encoded.normalized,
      centerX,
      curY,
      labelW - 16,
    );
    curY += 15;

    // Price line
    if (options.showPrice && item.salePriceMinor !== null) {
      ctx.fillStyle = '#111827';
      ctx.font = `700 14px ${fontStack}`;
      ctx.fillText(money(item.salePriceMinor), centerX, curY, labelW - 16);
    }
  });

  return canvas;
}

export async function renderLabelsSheetPng(
  items: readonly LabelQueueItem[],
  options: LabelPrintOptions,
  shopName: string,
): Promise<Blob | null> {
  const canvas = renderLabelsSheetCanvas(items, options, shopName);
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}
