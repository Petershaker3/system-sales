// The look of the screens and the shop/receipt profile: the two looks
// («لافتة الشارع» / «علبة الموبايل»), light or dark, the shop colour, the font,
// the text size, the digits, and the shop/receipt configuration
// (DESIGN.md, docs/ui/REDESIGN.md; owner decisions in ADR-016, ADR-022).

import { reactive, ref } from 'vue';

import * as api from '../api/appearance';
import type { AppearanceKey } from '../api/appearance';
import * as imagesApi from '../api/images';
import { accentTokens, DEFAULT_ACCENT, parseCssColor, rgbOf, WHITE } from './color.ts';
import type { Grounds, Rgb } from './color.ts';
import { setDigits } from './format.ts';
import type { Digits } from './format.ts';
import type { IconName } from './icons.ts';

export type Look = 'plate' | 'box';
export type ThemeChoice = 'light' | 'dark' | 'auto';
export type FontChoice = 'auto' | 'plex' | 'cairo' | 'tajawal' | 'readex';
export type Scale = 'normal' | 'large';
export type ImagesChoice = 'on' | 'off';
export type ImeiModeChoice = 'optional' | 'required';
export type PayMethodId = 'cash' | 'vf' | 'instapay' | 'card' | 'install' | 'credit';
export type ReceiptModeChoice = 'wa' | 'none' | 'print' | 'both';
export type PrinterEnabledChoice = 'on' | 'off';
export type ReceiptPaperChoice = '80' | '58';
export type SellerCanCloseShiftChoice = 'on' | 'off';
export type ServiceFeeModeChoice = 'manual' | 'auto';

export interface PayMethodMeta {
  readonly id: PayMethodId;
  readonly name: string;
  readonly icon: IconName;
  readonly hint: string;
  readonly alwaysEnabled?: boolean;
}

export const PAY_METHODS: readonly PayMethodMeta[] = [
  {
    id: 'cash',
    name: 'كاش',
    icon: 'banknote',
    hint: 'شغّالة دايمًا — مع حساب الباقي واقتراحات المبلغ',
    alwaysEnabled: true,
  },
  {
    id: 'vf',
    name: 'فودافون كاش',
    icon: 'wallet',
    hint: 'للعملاء اللي بيحوّلوا على محفظة المحل',
  },
  {
    id: 'instapay',
    name: 'إنستاباي',
    icon: 'zap',
    hint: 'للتحويل على حساب المحل في إنستاباي',
  },
  {
    id: 'card',
    name: 'فيزا / ميزة',
    icon: 'credit-card',
    hint: 'لو عندك ماكينة كروت في المحل',
  },
  {
    id: 'install',
    name: 'تقسيط',
    icon: 'calendar-clock',
    hint: 'valU، سهولة، Sympl، حالًا، كونتكت',
  },
  {
    id: 'credit',
    name: 'آجل',
    icon: 'notebook-pen',
    hint: 'بيسجّل المبلغ على حساب العميل (لازم تختار عميل)',
  },
];

export const INSTALLMENT_PROVIDERS: readonly string[] = [
  'valU',
  'سهولة',
  'Sympl',
  'حالًا',
  'كونتكت',
];

export const DEFAULT_PAY_METHODS = 'cash,vf,instapay,card,install,credit';
export const DEFAULT_DISCOUNT_LIMIT_PCT = '5';
export const DEFAULT_SHOP_NAME = 'موبايل ستور';
export const DEFAULT_SHOP_PHONE = '01000000000';
export const DEFAULT_SHOP_ADDRESS = '12 شارع شبرا، القاهرة';
export const DEFAULT_RECEIPT_FOOTER =
  'شكرًا لزيارتكم. الاستبدال خلال 14 يوم بالفاتورة والعلبة.';
export const DEFAULT_WA_TEMPLATE =
  'أهلاً {الاسم}، دي فاتورتك رقم {رقم} من {المحل}. الضمان لحد {تاريخ_الضمان}.';
export const DEFAULT_RECEIPT_MODE: ReceiptModeChoice = 'wa';
export const DEFAULT_PRINTER_ENABLED: PrinterEnabledChoice = 'off';
export const DEFAULT_RECEIPT_PAPER: ReceiptPaperChoice = '80';
export const DEFAULT_WARRANTY_NEW = '12';
export const DEFAULT_WARRANTY_USED = '1';
export const DEFAULT_WARRANTY_ITEM = '0';
export const DEFAULT_SELLER_CAN_CLOSE_SHIFT: SellerCanCloseShiftChoice = 'off';
export const DEFAULT_SERVICE_FEE_MODE: ServiceFeeModeChoice = 'manual';
export const DEFAULT_SERVICE_FEE_PCT = '1';
export const DEFAULT_SERVICE_FEE_MIN = '5';
export const DEFAULT_BILL_FEE = '5';

export function normalizeServiceFeeEgp(
  raw: unknown,
  fallback: string = DEFAULT_SERVICE_FEE_MIN
): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return fallback;
  const trimmed = String(raw).trim();
  if (!/^\d{1,5}$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 10000) return fallback;
  return String(n);
}

export function normalizeWarrantyMonths(
  raw: unknown,
  fallback: string = DEFAULT_WARRANTY_NEW
): string {
  if (typeof raw !== 'string' && typeof raw !== 'number') return fallback;
  const trimmed = String(raw).trim();
  if (!/^\d{1,2}$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 60) return fallback;
  return String(n);
}

export function normalizeDiscountLimitPct(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_DISCOUNT_LIMIT_PCT;
  const trimmed = raw.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return DEFAULT_DISCOUNT_LIMIT_PCT;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0 || n > 100) return DEFAULT_DISCOUNT_LIMIT_PCT;
  return String(n);
}

export function discountLimitPctNum(
  raw: string = appearance.discountLimitPct
): number {
  return Number(normalizeDiscountLimitPct(raw));
}

export function normalizePayMethods(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_PAY_METHODS;
  const allowed = PAY_METHODS.map((m) => m.id);
  const seen = new Set<PayMethodId>();
  for (const part of raw.split(',')) {
    const token = part.trim().toLowerCase() as PayMethodId;
    if (!allowed.includes(token) || seen.has(token)) {
      return DEFAULT_PAY_METHODS;
    }
    seen.add(token);
  }
  if (!seen.has('cash')) return DEFAULT_PAY_METHODS;
  return allowed.filter((id) => seen.has(id)).join(',');
}

function normalizeText(
  raw: unknown,
  fallback: string,
  allowEmpty: boolean,
  maxChars: number
): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.replace(/\r\n/g, '\n').trim();
  if (!allowEmpty && trimmed === '') return fallback;
  if (trimmed.length > maxChars) return trimmed.slice(0, maxChars);
  return trimmed;
}

export interface Appearance {
  look: Look;
  theme: ThemeChoice;
  accent: string;
  font: FontChoice;
  scale: Scale;
  digits: Digits;
  images: ImagesChoice;
  imeiMode: ImeiModeChoice;
  payMethods: string;
  discountLimitPct: string;
  shopName: string;
  shopPhone: string;
  shopAddress: string;
  receiptFooter: string;
  waTemplate: string;
  receiptMode: ReceiptModeChoice;
  printerEnabled: PrinterEnabledChoice;
  receiptPaper: ReceiptPaperChoice;
  warrantyNew: string;
  warrantyUsed: string;
  warrantyItem: string;
  sellerCanCloseShift: SellerCanCloseShiftChoice;
  serviceFeeMode: ServiceFeeModeChoice;
  serviceFeePct: string;
  serviceFeeMin: string;
  billFee: string;
}

export const DEFAULT_APPEARANCE: Readonly<Appearance> = {
  look: 'plate',
  theme: 'light',
  accent: DEFAULT_ACCENT,
  font: 'auto',
  scale: 'normal',
  digits: 'latin',
  images: 'on',
  imeiMode: 'optional',
  payMethods: DEFAULT_PAY_METHODS,
  discountLimitPct: DEFAULT_DISCOUNT_LIMIT_PCT,
  shopName: DEFAULT_SHOP_NAME,
  shopPhone: DEFAULT_SHOP_PHONE,
  shopAddress: DEFAULT_SHOP_ADDRESS,
  receiptFooter: DEFAULT_RECEIPT_FOOTER,
  waTemplate: DEFAULT_WA_TEMPLATE,
  receiptMode: DEFAULT_RECEIPT_MODE,
  printerEnabled: DEFAULT_PRINTER_ENABLED,
  receiptPaper: DEFAULT_RECEIPT_PAPER,
  warrantyNew: DEFAULT_WARRANTY_NEW,
  warrantyUsed: DEFAULT_WARRANTY_USED,
  warrantyItem: DEFAULT_WARRANTY_ITEM,
  sellerCanCloseShift: DEFAULT_SELLER_CAN_CLOSE_SHIFT,
  serviceFeeMode: DEFAULT_SERVICE_FEE_MODE,
  serviceFeePct: DEFAULT_SERVICE_FEE_PCT,
  serviceFeeMin: DEFAULT_SERVICE_FEE_MIN,
  billFee: DEFAULT_BILL_FEE,
};

/** Ready-made shop colours; «لون تاني» accepts any colour and stays readable. */
export const ACCENTS: readonly string[] = [
  '#1d4f91',
  '#0f6e5a',
  '#b3261e',
  '#0e6170',
  '#6b2f73',
  '#a86b00',
  '#2f3437',
];

export const LOOKS: readonly { id: Look; name: string; hint: string }[] = [
  { id: 'plate', name: 'لافتة الشارع', hint: 'أرضية هادية فيها لمسة من لون المحل، وحواف ناعمة' },
  { id: 'box', name: 'علبة الموبايل', hint: 'أبيض وحبر وخطوط رفيعة، زي علبة موبايل جديدة' },
];

export const FONTS: readonly { id: FontChoice; name: string }[] = [
  { id: 'auto', name: 'خط الطابع' },
  { id: 'plex', name: 'IBM Plex' },
  { id: 'cairo', name: 'Cairo' },
  { id: 'tajawal', name: 'Tajawal' },
  { id: 'readex', name: 'Readex Pro' },
];

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/** Anything read back from the backend → a valid appearance (unknown values fall back). */
export function normalizeAppearance(raw: unknown): Appearance {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const accent = typeof r['accent'] === 'string' && rgbOf(r['accent']) !== null ? r['accent'] : DEFAULT_APPEARANCE.accent;
  return {
    look: oneOf(r['look'], ['plate', 'box'] as const, DEFAULT_APPEARANCE.look),
    theme: oneOf(r['theme'], ['light', 'dark', 'auto'] as const, DEFAULT_APPEARANCE.theme),
    accent: accent.toLowerCase(),
    font: oneOf(r['font'], ['auto', 'plex', 'cairo', 'tajawal', 'readex'] as const, DEFAULT_APPEARANCE.font),
    scale: oneOf(r['scale'], ['normal', 'large'] as const, DEFAULT_APPEARANCE.scale),
    digits: oneOf(r['digits'], ['latin', 'arabic'] as const, DEFAULT_APPEARANCE.digits),
    images: oneOf(r['images'], ['on', 'off'] as const, DEFAULT_APPEARANCE.images),
    imeiMode: oneOf(r['imeiMode'], ['optional', 'required'] as const, DEFAULT_APPEARANCE.imeiMode),
    payMethods: normalizePayMethods(r['payMethods']),
    discountLimitPct: normalizeDiscountLimitPct(r['discountLimitPct']),
    shopName: normalizeText(r['shopName'], DEFAULT_SHOP_NAME, false, 120),
    shopPhone: normalizeText(r['shopPhone'], DEFAULT_SHOP_PHONE, true, 40),
    shopAddress: normalizeText(r['shopAddress'], DEFAULT_SHOP_ADDRESS, true, 200),
    receiptFooter: normalizeText(r['receiptFooter'], DEFAULT_RECEIPT_FOOTER, true, 500),
    waTemplate: normalizeText(r['waTemplate'], DEFAULT_WA_TEMPLATE, false, 1000),
    receiptMode: oneOf(r['receiptMode'], ['wa', 'none', 'print', 'both'] as const, DEFAULT_RECEIPT_MODE),
    printerEnabled: oneOf(r['printerEnabled'], ['on', 'off'] as const, DEFAULT_PRINTER_ENABLED),
    receiptPaper: oneOf(r['receiptPaper'], ['80', '58'] as const, DEFAULT_RECEIPT_PAPER),
    warrantyNew: normalizeWarrantyMonths(r['warrantyNew'], DEFAULT_WARRANTY_NEW),
    warrantyUsed: normalizeWarrantyMonths(r['warrantyUsed'], DEFAULT_WARRANTY_USED),
    warrantyItem: normalizeWarrantyMonths(r['warrantyItem'], DEFAULT_WARRANTY_ITEM),
    sellerCanCloseShift: oneOf(
      r['sellerCanCloseShift'],
      ['on', 'off'] as const,
      DEFAULT_SELLER_CAN_CLOSE_SHIFT
    ),
    serviceFeeMode: oneOf(
      r['serviceFeeMode'],
      ['manual', 'auto'] as const,
      DEFAULT_SERVICE_FEE_MODE
    ),
    serviceFeePct: normalizeDiscountLimitPct(
      typeof r['serviceFeePct'] === 'string'
        ? r['serviceFeePct']
        : DEFAULT_SERVICE_FEE_PCT
    ),
    serviceFeeMin: normalizeServiceFeeEgp(
      r['serviceFeeMin'],
      DEFAULT_SERVICE_FEE_MIN
    ),
    billFee: normalizeServiceFeeEgp(r['billFee'], DEFAULT_BILL_FEE),
  };
}

export function isPayMethodEnabled(
  id: PayMethodId,
  raw: string = appearance.payMethods
): boolean {
  if (id === 'cash') return true;
  return raw
    .split(',')
    .map((s) => s.trim())
    .includes(id);
}

export function enabledPayMethods(
  raw: string = appearance.payMethods
): PayMethodMeta[] {
  return PAY_METHODS.filter((m) => isPayMethodEnabled(m.id, raw));
}

/** The single, reactive appearance every component reads. */
export const appearance: Appearance = reactive({ ...DEFAULT_APPEARANCE });

/** Reactive optional 192×192 JPEG shop logo (`data:image/jpeg;base64,...` or `null`). */
export const shopLogo = ref<string | null>(null);

export async function loadShopLogo(): Promise<string | null> {
  try {
    shopLogo.value = await imagesApi.getShopLogo();
    return shopLogo.value;
  } catch {
    return shopLogo.value;
  }
}

export async function saveShopLogo(dataUrl: string): Promise<string> {
  const stored = await imagesApi.setShopLogo(dataUrl);
  shopLogo.value = stored;
  return stored;
}

export async function clearShopLogo(): Promise<void> {
  await imagesApi.removeShopLogo();
  shopLogo.value = null;
}

export function resolvedTheme(a: Appearance = appearance): 'light' | 'dark' {
  if (a.theme !== 'auto') return a.theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** A colour variable as the browser computed it (after color-mix). */
function cssColor(name: string): Rgb {
  const probe = document.createElement('i');
  probe.style.cssText = `position:absolute;visibility:hidden;color:var(${name})`;
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return parseCssColor(value) ?? WHITE;
}

/** Write the appearance onto <html>. Safe to call repeatedly. */
export function applyAppearance(a: Appearance = appearance): void {
  const root = document.documentElement;
  const theme = resolvedTheme(a);
  root.dataset['theme'] = theme;
  root.dataset['look'] = a.look;
  root.dataset['font'] = a.font;
  root.dataset['scale'] = a.scale;
  root.style.setProperty('--accent', a.accent);
  setDigits(a.digits);

  // The grounds depend on the look, the theme and the accent tint, so they are
  // read after those are set, with the previous muted correction removed.
  root.style.removeProperty('--muted');
  const grounds: Grounds = {
    bg: cssColor('--bg'),
    surface: cssColor('--surface'),
    surface2: cssColor('--surface-2'),
    surface3: cssColor('--surface-3'),
    muted: cssColor('--muted'),
  };
  const tokens = accentTokens(a.accent, theme === 'dark', grounds);
  for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
}

const KEYS: Record<keyof Appearance, AppearanceKey> = {
  look: 'ui.look',
  theme: 'ui.theme',
  accent: 'ui.accent',
  font: 'ui.font',
  scale: 'ui.scale',
  digits: 'ui.digits',
  images: 'ui.images',
  imeiMode: 'ui.imei_mode',
  payMethods: 'ui.pay_methods',
  discountLimitPct: 'ui.discount_limit_pct',
  shopName: 'ui.shop_name',
  shopPhone: 'ui.shop_phone',
  shopAddress: 'ui.shop_address',
  receiptFooter: 'ui.receipt_footer',
  waTemplate: 'ui.wa_template',
  receiptMode: 'ui.receipt_mode',
  printerEnabled: 'ui.printer_enabled',
  receiptPaper: 'ui.receipt_paper',
  warrantyNew: 'ui.warranty_new',
  warrantyUsed: 'ui.warranty_used',
  warrantyItem: 'ui.warranty_item',
  sellerCanCloseShift: 'ui.seller_can_close_shift',
  serviceFeeMode: 'ui.service_fee_mode',
  serviceFeePct: 'ui.service_fee_pct',
  serviceFeeMin: 'ui.service_fee_min',
  billFee: 'ui.bill_fee',
};

export type ServiceFeeMode = ServiceFeeModeChoice;

/**
 * Change part of the appearance: repaint at once, then store it. When the store
 * refuses (no permission, or a fresh password is needed) the previous look is
 * put back and the error is rethrown for the caller to handle.
 */
export async function setAppearance(patch: Partial<Appearance>): Promise<void> {
  const before: Appearance = { ...appearance };
  const next = normalizeAppearance({ ...appearance, ...patch });
  Object.assign(appearance, next);
  applyAppearance();
  try {
    for (const field of Object.keys(patch) as (keyof Appearance)[]) {
      if (before[field] === next[field]) continue;
      const stored = await api.updateAppearance(KEYS[field], next[field]);
      Object.assign(appearance, normalizeAppearance(stored));
    }
    applyAppearance();
  } catch (err) {
    Object.assign(appearance, before);
    applyAppearance();
    throw err;
  }
}

export function toggleTheme(): Promise<void> {
  return setAppearance({ theme: resolvedTheme() === 'dark' ? 'light' : 'dark' });
}

/**
 * Apply the defaults at once, then the stored choices as soon as they are read,
 * and follow the system theme when «auto» is chosen.
 */
export async function startAppearance(): Promise<void> {
  applyAppearance();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (appearance.theme === 'auto') applyAppearance();
  });
  try {
    Object.assign(appearance, normalizeAppearance(await api.readAppearance()));
    applyAppearance();
  } catch {
    // The backend is not reachable yet: the defaults stay, which is a fine look.
  }
}
