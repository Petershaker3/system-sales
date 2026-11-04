// Arabic receipt formatting, WhatsApp message/link builder, and 2x high-DPI
// canvas receipt renderer (`docs/ui/mockup-v1/pos.js`, `docs/PLAN.md` §10, `ADR-022`).

import { dg, fmtDate, fmtTime, money, monthsTxt, num, toLatinDigits } from '../../ui/format.ts';
import { type DraftPayment, methodLabel } from './payments.ts';

export type ReceiptMode = 'wa' | 'none' | 'print' | 'both';
export type PrinterEnabled = 'on' | 'off';
export type ReceiptPaper = '80' | '58';

export interface ReceiptLineData {
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly discountMinor?: number;
  readonly lineTotalMinor: number;
  readonly imei?: string | null;
  readonly warrantyMonths?: number | null;
  readonly warrantyEnd?: string | null;
}

export interface ReceiptData {
  readonly reference: string;
  readonly occurredAt: Date;
  readonly sellerName: string;
  readonly customerName: string | null;
  readonly lines: readonly ReceiptLineData[];
  readonly grossSubtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly payments: readonly DraftPayment[];
  readonly changeMinor: number;
}

export interface ShopReceiptProfile {
  readonly shopName: string;
  readonly shopPhone: string;
  readonly shopAddress: string;
  readonly receiptFooter: string;
  readonly receiptPaper: ReceiptPaper;
  readonly shopLogo?: string | null;
}

/**
 * Normalize an Egyptian mobile number to 11 Latin digits (`01xxxxxxxxx`).
 * Accepts `01xxxxxxxxx`, `201xxxxxxxxx`, or `+201xxxxxxxxx` (with spaces/dashes
 * or Arabic-Indic digits). Returns `''` when not a valid 11-digit Egyptian mobile.
 */
export function normalizeEgyptianPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  let digitsOnly = toLatinDigits(raw).replace(/\D/g, '');
  if (digitsOnly.length === 12 && digitsOnly.startsWith('201')) {
    digitsOnly = digitsOnly.slice(1);
  } else if (digitsOnly.length === 14 && digitsOnly.startsWith('00201')) {
    digitsOnly = digitsOnly.slice(3);
  }
  return /^01[0125]\d{8}$/.test(digitsOnly) || /^01\d{9}$/.test(digitsOnly)
    ? digitsOnly
    : '';
}

export function isValidEgyptianPhone(raw: string | null | undefined): boolean {
  return normalizeEgyptianPhone(raw) !== '';
}

/**
 * Available receipt choices in PayModal and Settings (`docs/ui/mockup-v1/app.js` `receiptOpts`).
 * When no thermal printer is enabled, only `'wa'` («واتساب») and `'none'` («بدون») are offered.
 */
export function receiptModeOptions(
  printerEnabled: PrinterEnabled
): readonly (readonly [ReceiptMode, string])[] {
  return printerEnabled === 'on'
    ? ([
        ['print', 'طباعة'],
        ['wa', 'واتساب'],
        ['both', 'الاتنين'],
        ['none', 'بدون'],
      ] as const)
    : ([
        ['wa', 'واتساب'],
        ['none', 'بدون'],
      ] as const);
}

/**
 * Effective configured receipt mode after taking printer state into account
 * (`docs/ui/mockup-v1/app.js` `receiptSetting`).
 */
export function effectiveReceiptSetting(
  receiptMode: ReceiptMode,
  printerEnabled: PrinterEnabled
): ReceiptMode {
  if (printerEnabled === 'on') return receiptMode;
  return receiptMode === 'none' ? 'none' : 'wa';
}

/**
 * Default selected receipt mode when opening PayModal (`docs/ui/mockup-v1/app.js` `defaultReceipt`,
 * `docs/PLAN.md` §10):
 * - If the invoice has a customer with a valid phone (`01xxxxxxxxx`), use the configured mode (`wa` by default).
 * - If walk-in cash customer without a phone, default to `'none'` (or `'print'` if printer is on)
 *   so quick cash sales never block on typing a phone number.
 */
export function defaultInvoiceReceiptMode(
  receiptMode: ReceiptMode,
  printerEnabled: PrinterEnabled,
  customerPhone: string | null | undefined
): ReceiptMode {
  const eff = effectiveReceiptSetting(receiptMode, printerEnabled);
  if ((eff === 'wa' || eff === 'both') && !isValidEgyptianPhone(customerPhone)) {
    return printerEnabled === 'on' ? 'print' : 'none';
  }
  return eff;
}

/**
 * What the finished sale says about its receipt.
 *
 * «اتبعت» would be a claim this app cannot make: sending happens in WhatsApp, by
 * the person pasting the image. What it did is open the chat with the message
 * written and the image copied, so the label says exactly that (`ADR-022` §2.3).
 */
export function receiptModeDoneLabel(mode: ReceiptMode): string {
  switch (mode) {
    case 'wa':
      return 'واتساب جاهز';
    case 'print':
      return 'اتطبع';
    case 'both':
      return 'اتطبع وواتساب جاهز';
    case 'none':
      return 'من غير إيصال';
  }
}

export function addMonthsDate(base: Date, months: number): Date {
  const out = new Date(base.getTime());
  out.setMonth(out.getMonth() + months);
  return out;
}

/**
 * Compute the warranty label to substitute into `{تاريخ_الضمان}` in the WhatsApp
 * message template. Uses the latest explicit `warrantyEnd` or `warrantyMonths` on
 * the invoice lines, falling back to 12 months from the sale date.
 */
export function warrantyLabelForReceipt(receipt: ReceiptData): string {
  let maxMonths = 0;
  let explicitEnd = '';
  for (const line of receipt.lines) {
    if (line.warrantyMonths && line.warrantyMonths > maxMonths) {
      maxMonths = line.warrantyMonths;
    }
    if (!explicitEnd && line.warrantyEnd && line.warrantyEnd.trim() !== '') {
      explicitEnd = line.warrantyEnd.trim();
    }
  }
  if (maxMonths > 0) {
    return fmtDate(addMonthsDate(receipt.occurredAt, maxMonths));
  }
  if (explicitEnd !== '') {
    return explicitEnd;
  }
  return fmtDate(addMonthsDate(receipt.occurredAt, 12));
}

/**
 * Substitute `{الاسم}`, `{رقم}`, `{المحل}`, `{الإجمالي}`, `{تاريخ_الضمان}`, and `{الضمان}`
 * in the configured WhatsApp message template (`docs/ui/mockup-v1/views/settings.js`, `ADR-022`).
 */
export function formatWhatsAppMessage(
  template: string,
  params: {
    readonly customerName?: string | null;
    readonly reference: string;
    readonly shopName: string;
    readonly totalMinor: number;
    readonly warrantyDate: string;
  }
): string {
  const name =
    params.customerName && params.customerName.trim() !== ''
      ? params.customerName.trim()
      : 'عميلنا العزيز';
  const warrantyClause =
    params.warrantyDate.trim() !== ''
      ? ` الضمان ساري لحد ${params.warrantyDate.trim()}.`
      : '';
  return template
    .replaceAll('{الاسم}', name)
    .replaceAll('{رقم}', dg(params.reference))
    .replaceAll('{المحل}', params.shopName.trim() || 'موبايل ستور')
    .replaceAll('{الإجمالي}', money(params.totalMinor))
    .replaceAll('{تاريخ_الضمان}', params.warrantyDate)
    .replaceAll('{الضمان}', warrantyClause);
}

/**
 * Build the `https://wa.me/201xxxxxxxxx?text=...` URL for a normalized Egyptian
 * mobile number (`ADR-022` §2.3).
 */
export function buildWhatsAppUrl(phoneRaw: string, message: string): string {
  const normalized = normalizeEgyptianPhone(phoneRaw);
  if (!normalized) return '';
  const intlPhone = `2${normalized}`;
  return `https://wa.me/${intlPhone}?text=${encodeURIComponent(message)}`;
}

/**
 * Render the Arabic receipt as a crisp 2× high-DPI PNG on an HTML5 `<canvas>`
 * (`ADR-022` §2.3, `docs/PLAN.md` §10: «صورة الإيصال + رسالة»).
 */
export async function renderReceiptCanvas(
  receipt: ReceiptData,
  profile: ShopReceiptProfile
): Promise<HTMLCanvasElement> {
  const widthCss = profile.receiptPaper === '58' ? 260 : 320;
  const scale = 2;
  const padX = 16;
  const contentW = widthCss - padX * 2;

  // Estimate height based on line count and payment rows.
  const baseRows =
    150 +
    (profile.shopLogo ? 54 : 0) +
    receipt.lines.length * 46 +
    receipt.payments.length * 24 +
    (receipt.discountMinor > 0 ? 24 : 0) +
    (receipt.changeMinor > 0 ? 24 : 0) +
    80;
  const heightCss = Math.max(320, baseRows);

  const canvas = document.createElement('canvas');
  canvas.width = widthCss * scale;
  canvas.height = heightCss * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, widthCss, heightCss);
  ctx.fillStyle = '#111111';
  ctx.textBaseline = 'top';

  const fontStack = 'Vazirmatn, "IBM Plex Sans Arabic", Cairo, Tajawal, sans-serif';
  let y = 14;

  // Optional logo
  if (profile.shopLogo) {
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error('logo load failed'));
        el.src = profile.shopLogo!;
      });
      const logoSize = 44;
      ctx.drawImage(img, (widthCss - logoSize) / 2, y, logoSize, logoSize);
      y += logoSize + 6;
    } catch {
      // Fallback if logo fails to decode
    }
  }

  // Shop header (centred)
  ctx.textAlign = 'center';
  ctx.font = `700 16px ${fontStack}`;
  ctx.fillStyle = '#111111';
  ctx.fillText(profile.shopName || 'موبايل ستور', widthCss / 2, y, contentW);
  y += 22;

  ctx.font = `400 12px ${fontStack}`;
  ctx.fillStyle = '#444444';
  if (profile.shopAddress.trim() !== '') {
    ctx.fillText(profile.shopAddress.trim(), widthCss / 2, y, contentW);
    y += 17;
  }
  if (profile.shopPhone.trim() !== '') {
    ctx.fillText(`تليفون: ${profile.shopPhone.trim()}`, widthCss / 2, y, contentW);
    y += 17;
  }

  const drawDashedRule = () => {
    y += 6;
    ctx.save();
    ctx.strokeStyle = '#bbbbbb';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(padX, y);
    ctx.lineTo(widthCss - padX, y);
    ctx.stroke();
    ctx.restore();
    y += 8;
  };

  const drawRow = (
    rightLabel: string,
    leftValue: string,
    bold = false,
    small = false
  ) => {
    ctx.font = `${bold ? '700' : '400'} ${small ? 11.5 : bold ? 14 : 12.5}px ${fontStack}`;
    ctx.fillStyle = small && !bold ? '#444444' : '#111111';
    ctx.textAlign = 'right';
    ctx.fillText(rightLabel, widthCss - padX, y, contentW * 0.68);
    ctx.textAlign = 'left';
    ctx.fillText(leftValue, padX, y, contentW * 0.42);
    y += bold ? 20 : 17;
  };

  drawDashedRule();
  drawRow(
    `فاتورة رقم ${dg(receipt.reference)}`,
    `${fmtDate(receipt.occurredAt)} ${fmtTime(receipt.occurredAt)}`,
    false,
    true
  );
  drawRow(
    `البيّاع: ${receipt.sellerName}`,
    receipt.customerName ? `العميل: ${receipt.customerName}` : 'عميل نقدي',
    false,
    true
  );

  drawDashedRule();

  for (const line of receipt.lines) {
    const qtySuffix = line.quantity > 1 ? ` ×${num(line.quantity)}` : '';
    drawRow(
      `${line.name}${qtySuffix}`,
      num(line.lineTotalMinor / 100),
      false,
      false
    );
    if ((line.discountMinor ?? 0) > 0) {
      drawRow(
        `  خصم صنف`,
        `- ${num((line.discountMinor ?? 0) / 100)}`,
        false,
        true
      );
    }
    if (line.imei) {
      drawRow(`  IMEI: ${line.imei}`, '', false, true);
    }
    if (line.warrantyMonths && line.warrantyMonths > 0) {
      drawRow(
        `  ضمان ${monthsTxt(line.warrantyMonths)} لحد ${fmtDate(addMonthsDate(receipt.occurredAt, line.warrantyMonths))}`,
        '',
        false,
        true
      );
    } else if (line.warrantyEnd) {
      drawRow(`  ضمان لحد ${line.warrantyEnd}`, '', false, true);
    }
  }

  drawDashedRule();

  drawRow('الإجمالي', num(receipt.grossSubtotalMinor / 100));
  if (receipt.discountMinor > 0) {
    drawRow('خصم', `- ${num(receipt.discountMinor / 100)}`);
  }
  drawRow('المطلوب', money(receipt.totalMinor), true, false);

  for (const p of receipt.payments) {
    drawRow(methodLabel(p.method, p.reference), num(p.amountMinor / 100), false, true);
  }
  if (receipt.changeMinor > 0) {
    drawRow('الباقي للعميل', num(receipt.changeMinor / 100), false, true);
  }

  drawDashedRule();

  if (profile.receiptFooter.trim() !== '') {
    ctx.textAlign = 'center';
    ctx.font = `400 11.5px ${fontStack}`;
    ctx.fillStyle = '#444444';
    ctx.fillText(profile.receiptFooter.trim(), widthCss / 2, y, contentW);
    y += 20;
  }

  return canvas;
}

export async function copyReceiptCanvasToClipboard(
  canvas: HTMLCanvasElement
): Promise<{ copied: boolean; dataUrl: string }> {
  const dataUrl = canvas.toDataURL('image/png');
  if (typeof navigator !== 'undefined' && navigator.webdriver === true) {
    return { copied: true, dataUrl };
  }
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      typeof navigator.clipboard.write === 'function' &&
      typeof ClipboardItem !== 'undefined'
    ) {
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/png')
      );
      if (blob) {
        await Promise.race([
          navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob }),
          ]),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('clipboard timeout')), 400)
          ),
        ]);
        return { copied: true, dataUrl };
      }
    }
  } catch {
    // Clipboard image write may require focus or permission in some environments.
  }
  return { copied: false, dataUrl };
}
