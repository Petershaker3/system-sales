// The browser demo: an in-memory stand-in for the Rust backend, so the new
// screens can be seen and tried in a plain browser (`npm run demo`).
//
// Built only with VITE_DEMO=1 (see src/vite-env.d.ts). Production and every
// Tauri build leave this file out of the bundle. Nothing here is persisted —
// a reload starts again from the same demo shop — and the top bar says the
// data is demo data. It imitates the real commands' shapes and their main
// refusals (stock, price, permission, a fresh password for the owner's
// settings) so the screens behave as they will on the desktop, but it is not
// the backend and proves nothing about it: the Rust tests do that.

import { mockIPC } from '@tauri-apps/api/mocks';

type Args = Record<string, unknown> | undefined;
type Role = 'manager' | 'sales';

interface DemoUser {
  id: string;
  displayName: string;
  username: string;
  role: Role;
  password: string;
  /** The daily PIN (ADR-017); `null` = none yet. Plain text: this is the demo, never Rust. */
  pin: string | null;
  disabled: boolean;
}

interface DemoProduct {
  id: string;
  name: string;
  disposition: 'quantity' | 'serialized' | 'one_off';
  barcode: string | null;
  salePriceMinor: number | null;
  categoryId: string | null;
  /** A phone's details (ADR-018 §2); null for anything else. */
  brandId: string | null;
  model: string | null;
  deviceType: 'touch' | 'keypad' | null;
  storageGb: number | null;
  ramGb: number | null;
  tracking?: 'none' | 'serial_optional' | 'serial_required';
  /** A variant's parent and combination details (ADR-018 §4); null for standalone products. */
  parentId?: string | null;
  parentName?: string | null;
  dimension1?: string | null;
  dimension2?: string | null;
  variant1?: string | null;
  variant2?: string | null;
  variantOrder?: number | null;
  onHand: number;
  totalCostMinor: number;
  soldRecently: number;
  status: 'active' | 'archived';
}


// The category tree (ADR-018 §1), with the same rules as Rust: two levels, a
// sub-category takes its parent's kind, names unique, defaults never deleted,
// only an empty category deleted.
interface DemoCategory {
  id: string;
  name: string;
  parentId: string | null;
  kind: 'item' | 'phone' | 'used';
  icon: string;
  hidden: boolean;
  sortOrder: number;
  isDefault: boolean;
}

const now = () => Date.now();
let seq = 0;
const newId = (prefix: string) => `${prefix}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const fail = (code: string): never => {
  throw { code };
};

const DEMO_PASSWORD = '1234';

// The owner's recovery code (ADR-017 §4). The demo starts with one for بيتر,
// shown in the demo's sign-in hint, so «نسيت كلمة السر؟» can be tried. Plain
// text, like the demo PINs: this is the demo, never Rust.
const RECOVERY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const recoveryCodes: Record<string, { code: string; createdAt: number }> = {
  'u-peter': { code: '23456789ABCDEFGHJKMN', createdAt: Date.now() - 86_400_000 },
};
const readCode = (typed: string): string | null => {
  const code = typed.replace(/[\s-]/g, '').toUpperCase();
  return code.length === 20 && [...code].every((ch) => RECOVERY_ALPHABET.includes(ch)) ? code : null;
};
const groupCode = (code: string): string => code.match(/.{4}/g)?.join('-') ?? code;
function drawCode(): string {
  let code = '';
  while (code.length < 20) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 248 && code.length < 20) code += RECOVERY_ALPHABET.charAt(byte % 31);
    }
  }
  return code;
}

// The demo starts the way a fresh device does — the shop running on its own
// operator, no account claimed yet, the till already open (`ADR-039`). That is the
// default now, on purpose: what an owner sees when they run the program for the first
// time should be what the demo shows, not the state after somebody made an account.
//
// `?shop=1` is the other demo: three accounts, a lock card, and the fake-data shop the
// browser suites walk through (their flows sign people in, so they need people).
// `?openShop=1` is still accepted and means nothing — it is what happens with no flag.
//
// The decision itself is Rust's (`services/identity/open_mode.rs`); this is the same
// shape, so the flow (banner → card → claim) can be tried without a database.
// `?empty=1` is the third demo, and the state nobody wants: the device has no rows at
// all and the start-up that prepares the shop did not run. It exists because
// `ADR-039` deleted the form that used to open there, so what is left must be readable
// — the lock card with nobody in it is the whole program's worst screen, and the only
// one worth rehearsing is the one that tells the owner what to do.
const emptyDevice =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('empty');
const seededShop =
  !emptyDevice &&
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('shop');
const openShop = !seededShop && !emptyDevice;

/** The open operator: a manager row with no password anybody knows and no PIN. */
const openOwner: DemoUser = {
  id: 'u-open',
  displayName: 'المالك',
  username: 'user-open',
  role: 'manager',
  // Stands for the random secret the real row hashes: it exists so the row is an
  // ordinary account, and no password a person types matches it.
  password: 'no-password-is-known-for-the-open-row',
  pin: null,
  disabled: false,
};

/** False only in the open-shop demo, and only until the owner claims the row. */
let claimed = !openShop;

const users: DemoUser[] = openShop
  ? [openOwner]
  : [
      { id: 'u-peter', displayName: 'بيتر', username: 'peter', role: 'manager', password: DEMO_PASSWORD, pin: '1111', disabled: false },
      { id: 'u-youssef', displayName: 'يوسف', username: 'youssef', role: 'sales', password: DEMO_PASSWORD, pin: '2222', disabled: false },
      { id: 'u-marina', displayName: 'مارينا', username: 'marina', role: 'sales', password: DEMO_PASSWORD, pin: '3333', disabled: false },
    ];

if (emptyDevice) users.length = 0;

const cat = (id: string, name: string, parentId: string | null, kind: DemoCategory['kind'], icon: string, sortOrder: number, isDefault = true): DemoCategory => ({
  id,
  name,
  parentId,
  kind,
  icon,
  hidden: false,
  sortOrder,
  isDefault,
});

// Phone companies (ADR-018 §2), as Rust adds them: the mockup's twelve, with the
// lines that drop the company from a name and the Arabic spellings search uses.
interface DemoBrand {
  id: string;
  name: string;
  deviceType: 'touch' | 'keypad' | 'both';
  sortOrder: number;
  hidden: boolean;
  isDefault: boolean;
  lines: string[];
  aliases: string;
}
const brand = (id: string, name: string, deviceType: DemoBrand['deviceType'], sortOrder: number, lines: string[], aliases: string): DemoBrand => ({
  id,
  name,
  deviceType,
  sortOrder,
  hidden: false,
  isDefault: true,
  lines,
  aliases,
});
const brands: DemoBrand[] = [
  brand('b-samsung', 'Samsung', 'touch', 10, [], 'سامسونج جالاكسي جلاكسي'),
  brand('b-apple', 'Apple', 'touch', 20, ['iPhone'], 'ابل آبل ايفون آيفون'),
  brand('b-xiaomi', 'Xiaomi', 'touch', 30, ['Redmi', 'POCO'], 'شاومي شاومى ريدمي ردمي بوكو'),
  brand('b-oppo', 'OPPO', 'touch', 40, [], 'اوبو أوبو'),
  brand('b-realme', 'realme', 'touch', 50, [], 'ريلمي ريل مي'),
  brand('b-honor', 'Honor', 'touch', 60, [], 'هونر هونور'),
  brand('b-infinix', 'Infinix', 'touch', 70, [], 'انفينكس انفنكس'),
  brand('b-tecno', 'Tecno', 'both', 80, [], 'تكنو تيكنو'),
  brand('b-vivo', 'vivo', 'touch', 90, [], 'فيفو'),
  brand('b-huawei', 'Huawei', 'touch', 100, [], 'هواوي'),
  brand('b-nokia', 'Nokia', 'both', 110, [], 'نوكيا'),
  brand('b-itel', 'itel', 'keypad', 120, [], 'ايتل آيتل'),
];
const storageLabel = (gb: number) => (gb >= 1024 && gb % 1024 === 0 ? `${gb / 1024}TB` : `${gb}GB`);
function phoneName(b: DemoBrand, model: string, storageGb: number | null): string {
  const m = model.trim().split(/\s+/).join(' ');
  const low = m.toLowerCase();
  const bare = low.startsWith(`${b.name.toLowerCase()} `) || b.lines.some((l) => low.startsWith(l.toLowerCase()));
  return [bare ? '' : b.name, m, storageGb === null ? '' : storageLabel(storageGb)].filter((x) => x !== '').join(' ');
}

// The default tree (PLAN §6), as Rust adds it, plus one category the owner made.
const categories: DemoCategory[] = [
  cat('c-phones', 'موبايلات جديدة', null, 'phone', 'smartphone', 10),
  cat('c-used', 'مستعمل', null, 'used', 'recycle', 20),
  cat('c-acc', 'إكسسوارات', null, 'item', 'package', 30),
  cat('c-cases', 'جرابات', 'c-acc', 'item', 'shield', 10),
  cat('c-screens', 'اسكرينات', 'c-acc', 'item', 'layers', 20),
  cat('c-chargers', 'شواحن', 'c-acc', 'item', 'plug-zap', 30),
  cat('c-cables', 'كابلات ووصلات', 'c-acc', 'item', 'cable', 40),
  cat('c-audio', 'سماعات', 'c-acc', 'item', 'headphones', 50),
  cat('c-power', 'باور بانك وميموري', 'c-acc', 'item', 'battery-charging', 60),
  cat('c-car', 'حوامل', 'c-acc', 'item', 'car', 70),
  cat('c-smart', 'ساعات ذكية', null, 'item', 'watch', 40),
  cat('c-cards', 'كروت شحن', null, 'item', 'wallet-cards', 50, false),
];

const p = (
  name: string,
  price: number | null,
  onHand: number,
  sold: number,
  category: string | null,
  barcode: string | null = null,
  disposition: DemoProduct['disposition'] = 'quantity'
): DemoProduct => ({
  id: newId('p'),
  name,
  disposition,
  barcode,
  salePriceMinor: price === null ? null : price * 100,
  categoryId: category,
  brandId: null,
  model: null,
  deviceType: null,
  storageGb: null,
  ramGb: null,
  onHand,
  totalCostMinor: price === null ? onHand * 500 : Math.round(price * 100 * 0.7) * onHand,
  soldRecently: sold,
  status: 'active',
});

const products: DemoProduct[] = [
  p('شاحن سامسونج 25 وات أصلي', 350, 14, 22, 'c-chargers', '8806090000011'),
  p('شاحن آيفون 20 وات', 450, 9, 18, 'c-chargers', '1942530000027'),
  p('كابل تايب سي 1 متر', 80, 40, 51, 'c-cables', '6901234500013'),
  p('كابل لايتنينج أنكر', 150, 12, 9, 'c-cables'),
  p('باور بانك 10000 مللي', 650, 6, 7, 'c-power'),
  p('سماعة بلوتوث JBL Tune', 1250, 4, 5, 'c-audio'),
  p('سماعة سلك سامسونج', 120, 25, 16, 'c-audio'),
  p('ايربودز برو', 600, 2, 11, 'c-audio'),
  p('اسكرينة زجاج آيفون 13', 75, 60, 44, 'c-screens', '6970000000135'),
  p('اسكرينة نانو سامسونج A54', 60, 35, 20, 'c-screens'),
  p('جراب سيليكون آيفون 13', 90, 18, 27, 'c-cases'),
  p('جراب شفاف سامسونج A15', 50, 30, 19, 'c-cases'),
  p('كارت شحن فودافون 50', 50, 100, 80, 'c-cards'),
  p('كارت شحن أورنج 25', 25, 100, 35, 'c-cards'),
  p('كارت ميموري 64 جيجا', 250, 10, 6, 'c-power'),
  p('فلاشة 32 جيجا', 180, 0, 4, 'c-power'),
  p('حامل موبايل للعربية', 220, 5, 3, 'c-car'),
  p('ساعة ذكية T500', 550, 3, 2, 'c-smart'),
  p('وصلة OTG', null, 8, 0, 'c-cables'),
  p('موبايل سامسونج A15', 7500, 3, 0, 'c-phones', null, 'serialized'),
  { ...p('Samsung Galaxy A16 128GB', 9250, 4, 3, 'c-phones'), brandId: 'b-samsung', model: 'Galaxy A16', deviceType: 'touch', storageGb: 128, ramGb: 6, tracking: 'serial_optional' },
  { ...p('iPhone 16 128GB', 57500, 1, 1, 'c-phones'), brandId: 'b-apple', model: 'iPhone 16', deviceType: 'touch', storageGb: 128, ramGb: null, tracking: 'serial_optional' },
  { ...p('Redmi 14C 128GB', 6299, 3, 2, 'c-phones'), brandId: 'b-xiaomi', model: 'Redmi 14C', deviceType: 'touch', storageGb: 128, ramGb: 4, tracking: 'serial_optional' },
];

// The shop's own barcode (ADR-018 §3 & §4, PLAN §6), mirroring
// `domain::catalog::shop_code`: an EAN-13 starting with 2, consecutive from the
// highest internal code the demo catalogue (or `reserved` form rows) holds.
const VARIANT_DIMS = ['الموبايل', 'اللون', 'النوع', 'المقاس', 'القوة', 'الطول', 'المساحة'];
const variantParents: {
  id: string;
  name: string;
  categoryId: string;
  dimension1: string;
  dimension2: string | null;
}[] = [];

function ean13(body: string): string {
  const sum = [...body].reduce((total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3), 0);
  return body + String((10 - (sum % 10)) % 10);
}
function nextShopCodes(count: number, reserved: readonly string[] = []): string[] {
  if (count <= 0) return [];
  const allCodes = [
    ...products.map((product) => product.barcode),
    ...reserved,
  ];
  const sequences = allCodes
    .filter((code): code is string => /^2\d{12}$/.test(code ?? ''))
    .map((code) => Number(code.slice(1, 12)));
  const highest = sequences.length > 0 ? Math.max(...sequences) : 0;
  const bounded = Math.min(count, 60);
  return Array.from({ length: bounded }, (_, index) =>
    ean13(`2${String(highest + index + 1).padStart(11, '0')}`),
  );
}
function nextShopCode(): string {
  return nextShopCodes(1)[0] ?? ean13('200000000001');
}


const appearance = {
  look: 'plate',
  theme: 'light',
  accent: '#1d4f91',
  font: 'auto',
  scale: 'normal',
  digits: 'latin',
  images: 'on',
  imeiMode: 'optional',
  payMethods: 'cash,vf,instapay,card,install,credit',
  discountLimitPct: '5',
  shopName: 'محل النور للموبايلات',
  shopPhone: '01012345678',
  shopAddress: 'شارع الجمهورية، أسيوط',
  receiptFooter: 'شكراً لزيارتكم · الاستبدال خلال 14 يوم بالفاتورة والعلبة بحالتها',
  waTemplate: 'أهلاً {الاسم}، إيصال فاتورة رقم {رقم} من {المحل} بمبلغ {الإجمالي}.{الضمان} شكراً لزيارتكم.',
  receiptMode: 'wa',
  printerEnabled: 'off',
  receiptPaper: '80',
  warrantyNew: '12',
  warrantyUsed: '1',
  warrantyItem: '0',
  sellerCanCloseShift: 'off',
  serviceFeeMode: 'manual',
  serviceFeePct: '1',
  serviceFeeMin: '5',
  billFee: '5',
  backupOnShift: 'on',
  backupEvery2h: 'on',
  backupUsbAuto: 'on',
  backupVerify: 'on',
};
let shopLogoDataUrl: string | null = null;
interface DemoUnit {
  id: string;
  productId: string;
  imei: string;
  imei2: string | null;
  color: string | null;
  unitCostMinor: number;
  status: 'in_stock' | 'sold' | 'retired';
  createdAt: number;
  conditionGrade?: 'A' | 'B' | 'C' | null;
  batteryHealthPct?: number | null;
  accessories?: string | null;
  intakeNote?: string | null;
  sellerName?: string | null;
  sellerPhone?: string | null;
  sellerNationalId?: string | null;
}
const productUnits: DemoUnit[] = [];
function demoNormalizeImei(raw: string): string {
  return raw
    .trim()
    .replace(/[\u0660-\u0669]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[\s-]/g, '');
}
function demoLuhn(imei: string): boolean {
  if (!/^\d{15}$/.test(imei)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    let d = imei.charCodeAt(i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}
let approvedOnce = false;

/**
 * Whether a sensitive command may run without a fresh owner PIN.
 *
 * `ADR-039`: in the open-shop demo the operator is the owner, and Rust mints the
 * approval for the open session itself, so nothing here waits for a PIN no account
 * has. Everywhere else the shipped rule stands: one approval, spent once.
 */
const ownerApprovalHolds = () => approvedOnce || !claimed;
interface DemoProductImage {
  productId: string;
  file: string;
  w: number;
  h: number;
  bytes: number;
  dataUrl: string;
}
const productImages = new Map<string, DemoProductImage>();

const customers: {
  id: string;
  name: string;
  contact: string | null;
  archived: boolean;
  balanceMinor: number;
}[] = [
  {
    id: 'c-1',
    name: 'أحمد سمير',
    contact: '01001234567',
    archived: false,
    balanceMinor: 0,
  },
];
interface DemoCustomerLedgerEntry {
  id: string;
  customerId: string;
  kind: 'credit_sale' | 'payment' | 'sale_reversal';
  amountMinor: number;
  method: string | null;
  /** The shop wallet that took a repayment (`ADR-041`). Absent on the rows that move no wallet money. */
  walletId?: string | null;
  saleId: string | null;
  note: string | null;
  occurredAt: number;
}
const customerLedger: DemoCustomerLedgerEntry[] = [];
interface DemoSaleLine {
  id: string;
  lineNo: number;
  productId: string;
  productName: string;
  quantity: number;
  unitSellingPriceMinor: number;
  discountMinor: number;
  lineTotalMinor: number;
  unitCostMinor: number;
  lineCostTotalMinor: number;
  imei: string | null;
  unitId: string | null;
  warrantyStart: string | null;
  warrantyEnd: string | null;
}

interface DemoSale {
  id: string;
  kind: 'sale' | 'reversal';
  reversesSaleId: string | null;
  reference: string;
  soldBy?: string;
  linesSubtotalMinor: number;
  invoiceDiscountMinor: number;
  totalMinor: number;
  costTotalMinor: number;
  discountMinor: number;
  customerId: string | null;
  isCancelled: boolean;
  occurredAt: number;
  payments: {
    method: string;
    amountMinor: number;
    reference: string | null;
    /** The shop wallet this money was collected into (`ADR-040`). */
    walletId: string | null;
  }[];
  lines: DemoSaleLine[];
}

const sales: DemoSale[] = [];

function buildDemoHistoricalSales(): DemoSale[] {
  const nowDt = new Date();
  const y = nowDt.getFullYear();
  const m = nowDt.getMonth();
  const out: DemoSale[] = [];
  let idx = 100;

  const pChargerSam = products[0]!;
  const pChargerIp = products[1]!;
  const pCable = products[2]!;
  const pJbl = products[5]!;
  const pA15 = products[19]!;
  const pA16 = products[20]!;

  const addHist = (
    dt: Date,
    sellerId: string,
    method: 'cash' | 'vf' | 'instapay' | 'card' | 'credit',
    items: {
      productId: string;
      productName: string;
      qty: number;
      priceMinor: number;
      costMinor: number;
      imei: string | null;
    }[],
    discountMinor = 0,
  ) => {
    idx += 1;
    const subtotal = items.reduce((a, it) => a + it.priceMinor * it.qty, 0);
    const total = Math.max(0, subtotal - discountMinor);
    const cost = items.reduce((a, it) => a + it.costMinor * it.qty, 0);
    const ymd = `${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`;
    out.push({
      id: `hist-sale-${idx}`,
      kind: 'sale',
      reversesSaleId: null,
      reference: `INV-${ymd}-${String(idx).padStart(4, '0')}`,
      soldBy: sellerId,
      linesSubtotalMinor: subtotal,
      invoiceDiscountMinor: discountMinor,
      totalMinor: total,
      costTotalMinor: cost,
      discountMinor,
      customerId: null,
      isCancelled: false,
      occurredAt: dt.getTime(),
      // Money that predates the wallet being named on the payment: the primary wallet of the
      // method takes it, exactly as the `0030` backfill leaves it in a real ledger.
      payments: [{ method, amountMinor: total, reference: null, walletId: null }],
      lines: items.map((it, lIdx) => ({
        id: `hist-line-${idx}-${lIdx + 1}`,
        lineNo: lIdx + 1,
        productId: it.productId,
        productName: it.productName,
        quantity: it.qty,
        unitSellingPriceMinor: it.priceMinor,
        discountMinor: 0,
        lineTotalMinor: it.priceMinor * it.qty,
        unitCostMinor: it.costMinor,
        lineCostTotalMinor: it.costMinor * it.qty,
        imei: it.imei,
        unitId: null,
        warrantyStart: null,
        warrantyEnd: null,
      })),
    });
  };

  // Same month 1 year ago (for YoY comparison)
  addHist(
    new Date(y - 1, m, 3, 13, 0),
    'u-peter',
    'cash',
    [
      {
        productId: pA15.id,
        productName: pA15.name,
        qty: 1,
        priceMinor: 750_000,
        costMinor: 640_000,
        imei: '351000000000018',
      },
      {
        productId: pChargerSam.id,
        productName: pChargerSam.name,
        qty: 2,
        priceMinor: 35_000,
        costMinor: 24_500,
        imei: null,
      },
    ],
  );

  // Previous 5 months (m - 5 .. m - 1)
  const monthFactors = [0.75, 0.82, 0.9, 0.88, 0.95];
  for (let back = 5; back >= 1; back -= 1) {
    const f = monthFactors[5 - back] ?? 0.9;
    const phonePrice = Math.round(750_000 * f);
    const phoneCost = Math.round(640_000 * f);
    addHist(
      new Date(y, m - back, 4, 12, 30),
      'u-peter',
      'cash',
      [
        {
          productId: pA15.id,
          productName: pA15.name,
          qty: 1,
          priceMinor: phonePrice,
          costMinor: phoneCost,
          imei: `3520000000000${back}1`,
        },
        {
          productId: pChargerIp.id,
          productName: pChargerIp.name,
          qty: 2,
          priceMinor: 45_000,
          costMinor: 31_500,
          imei: null,
        },
      ],
    );
    addHist(
      new Date(y, m - back, 11, 17, 15),
      'u-youssef',
      'vf',
      [
        {
          productId: pJbl.id,
          productName: pJbl.name,
          qty: 1,
          priceMinor: 125_000,
          costMinor: 87_500,
          imei: null,
        },
        {
          productId: pCable.id,
          productName: pCable.name,
          qty: 3,
          priceMinor: 8_000,
          costMinor: 5_600,
          imei: null,
        },
      ],
    );
  }

  // Early in the current month (strictly before the last 7 days so `today` and `week` are untouched)
  if (nowDt.getDate() > 9) {
    addHist(
      new Date(y, m, 2, 14, 0),
      'u-peter',
      'cash',
      [
        {
          productId: pA16.id,
          productName: pA16.name,
          qty: 1,
          priceMinor: 925_000,
          costMinor: 810_000,
          imei: '353000000000019',
        },
        {
          productId: pChargerSam.id,
          productName: pChargerSam.name,
          qty: 2,
          priceMinor: 35_000,
          costMinor: 24_500,
          imei: null,
        },
      ],
    );
  }

  return out;
}

const demoHistoricalSales: DemoSale[] = buildDemoHistoricalSales();

interface DemoSaleReturn {
  id: string;
  originalSaleId: string;
  reversalSaleId: string;
  returnReference: string;
  exchangeSaleId: string | null;
  exchangeReference: string | null;
  refundMinor: number;
  costReversedMinor: number;
  damagedCostMinor: number;
  reason: string;
  actorId: string;
  approvedBy: string | null;
  occurredAt: number;
  lines: {
    saleLineId: string;
    quantity: number;
    condition: 'intact' | 'damaged';
    refundMinor: number;
    unitCostMinor: number;
    lineCostTotalMinor: number;
  }[];
}
const demoSaleReturns: DemoSaleReturn[] = [];

interface DemoDamagedStockItem {
  id: string;
  saleReturnId: string;
  returnReference: string;
  originalSaleId: string;
  saleReference: string;
  saleLineId: string;
  productId: string;
  productName: string;
  unitId: string | null;
  imei: string | null;
  quantity: number;
  unitCostMinor: number;
  totalCostMinor: number;
  reason: string;
  actorId: string;
  approvedBy: string | null;
  occurredAt: number;
}
const demoDamagedStock: DemoDamagedStockItem[] = [];

interface DemoPairedDevice {
  id: string;
  name: string;
  model: string;
  pairedAt: number;
  lastSeenAt: number;
  online: boolean;
}

const demoPairedDevices: DemoPairedDevice[] = [
  {
    id: 'dev-owner-1',
    name: 'موبايل بيتر',
    model: 'iPhone 15 Pro',
    pairedAt: Date.now() - 7 * 86_400_000,
    lastSeenAt: Date.now(),
    online: true,
  },
  {
    id: 'dev-seller-1',
    name: 'موبايل يوسف',
    model: 'Redmi Note 13',
    pairedAt: Date.now() - 3 * 86_400_000,
    lastSeenAt: Date.now() - 300_000,
    online: true,
  },
];

interface DemoCompanionScan {
  id: string;
  target: 'pos' | 'receive';
  code: string;
  productId: string | null;
  productName: string | null;
  deviceName: string;
  scannedAt: number;
}

let demoCompanionScans: DemoCompanionScan[] = [];
let demoRemoteEnabled = false;

function demoCompanionStatusDto() {
  const shopName = appearance.shopName || 'موبايل ستور';
  const hostIp = '192.168.1.10';
  const port = 8787;
  const pairCode = 'PAIR-8787';
  const remoteCode = 'RMT-9042';
  return {
    hostIp,
    port,
    pairCode,
    pairPayload: `MSHOP-PAIR|v1|${shopName}|${hostIp}:${port}|${pairCode}`,
    running: true,
    pairedDevices: demoPairedDevices.map((d) => ({ ...d })),
    pendingScans: demoCompanionScans.map((s) => ({ ...s })),
    remoteEnabled: demoRemoteEnabled,
    remoteCode,
    remotePayload: `MSHOP-REMOTE|v1|${shopName}|${remoteCode}`,
    lastRemoteSyncAt: demoRemoteEnabled ? now() : null,
  };
}

interface DemoShift {
  id: string;
  shiftNumber: number;
  status: 'open' | 'closed';
  openingCashMinor: number;
  expectedCashMinor: number | null;
  countedCashMinor: number | null;
  differenceMinor: number | null;
  closeNote: string | null;
  openedBy: string;
  openedAt: number;
  closedBy: string | null;
  closedAt: number | null;
}

interface DemoExpense {
  id: string;
  shiftId: string;
  category: string;
  amountMinor: number;
  note: string | null;
  createdBy: string;
  createdAt: number;
}

interface DemoCashMovement {
  id: string;
  shiftId: string;
  kind: 'cash_in' | 'owner_draw';
  amountMinor: number;
  reason: string;
  createdBy: string;
  createdAt: number;
}

const shifts: DemoShift[] = [
  {
    id: 'shift-1',
    shiftNumber: 1,
    status: 'open',
    openingCashMinor: 100_000,
    expectedCashMinor: null,
    countedCashMinor: null,
    differenceMinor: null,
    closeNote: null,
    openedBy: 'u-youssef',
    openedAt: 1,
    closedBy: null,
    closedAt: null,
  },
];
const expenses: DemoExpense[] = [];
const cashMovements: DemoCashMovement[] = [];

interface DemoWallet {
  id: string;
  name: string;
  /** The company several numbers are filed under, `null` when it stands alone (`ADR-040`). */
  company: string | null;
  number: string;
  color: string;
  openingBalanceMinor: number;
  minAlertMinor: number;
  maxLimitMinor: number;
  dailyLimitMinor: number;
  payMethod: 'vf' | 'instapay' | null;
  sort: number;
  hidden: boolean;
  isCustom: boolean;
  createdAt: number;
}

interface DemoWalletOp {
  id: string;
  walletId: string | null;
  toWalletId: string | null;
  kind:
    | 'deposit'
    | 'withdraw'
    | 'topup'
    | 'unload'
    | 'move'
    | 'adjust'
    | 'bill'
    | 'card'
    | 'software';
  via: 'drawer' | 'out' | null;
  serviceType: string | null;
  reference: string | null;
  amountMinor: number;
  feeMinor: number;
  note: string | null;
  createdBy: string;
  createdAt: number;
  voidedBy: string | null;
  voidedAt: number | null;
  voidReason: string | null;
}

const demoWallets: DemoWallet[] = [
  {
    id: 'vf',
    name: 'فودافون كاش',
    company: null,
    number: '01001234567',
    color: '#e60000',
    openingBalanceMinor: 1_500_000,
    minAlertMinor: 300_000,
    maxLimitMinor: 9_000_000,
    dailyLimitMinor: 6_000_000,
    payMethod: 'vf',
    sort: 1,
    hidden: false,
    isCustom: false,
    createdAt: 1,
  },
  {
    id: 'et',
    name: 'اتصالات كاش',
    company: null,
    number: '01112345678',
    color: '#5cb85c',
    openingBalanceMinor: 500_000,
    minAlertMinor: 250_000,
    maxLimitMinor: 9_000_000,
    dailyLimitMinor: 6_000_000,
    payMethod: null,
    sort: 2,
    hidden: false,
    isCustom: false,
    createdAt: 1,
  },
  {
    id: 'or',
    name: 'أورنج كاش',
    company: null,
    number: '01223456789',
    color: '#ff7900',
    openingBalanceMinor: 600_000,
    minAlertMinor: 200_000,
    maxLimitMinor: 9_000_000,
    dailyLimitMinor: 6_000_000,
    payMethod: null,
    sort: 3,
    hidden: false,
    isCustom: false,
    createdAt: 1,
  },
  {
    id: 'we',
    name: 'وي باي',
    company: null,
    number: '01554567890',
    color: '#6b2fb5',
    openingBalanceMinor: 250_000,
    minAlertMinor: 150_000,
    maxLimitMinor: 9_000_000,
    dailyLimitMinor: 6_000_000,
    payMethod: null,
    sort: 4,
    hidden: false,
    isCustom: false,
    createdAt: 1,
  },
  {
    id: 'ip',
    name: 'إنستاباي',
    company: null,
    number: 'alnoor@instapay',
    color: '#6b3fa0',
    openingBalanceMinor: 2_000_000,
    minAlertMinor: 0,
    maxLimitMinor: 0,
    dailyLimitMinor: 12_000_000,
    payMethod: 'instapay',
    sort: 5,
    hidden: false,
    isCustom: false,
    createdAt: 1,
  },
];

const demoWalletOps: DemoWalletOp[] = [];

interface DemoSavedBackup {
  id: string;
  fileName: string;
  createdAtUnixMs: number;
  triggerKind: 'manual' | 'shift_open' | 'shift_close' | 'periodic';
  reason: string;
  totalLen: number;
  databaseLen: number;
  imageCount: number;
  verified: boolean;
  usbCopied: boolean;
}

const demoSavedBackups: DemoSavedBackup[] = [
  {
    id: 'backup-1792324800000-d004.msb',
    fileName: 'backup-1792324800000-d004.msb',
    createdAtUnixMs: Date.now() - 30 * 60_000,
    triggerKind: 'periodic',
    reason: 'دوري (كل ساعتين)',
    totalLen: Math.round(14.2 * 1024 * 1024),
    databaseLen: Math.round(11.8 * 1024 * 1024),
    imageCount: 18,
    verified: true,
    usbCopied: true,
  },
  {
    id: 'backup-1792317600000-d003.msb',
    fileName: 'backup-1792317600000-d003.msb',
    createdAtUnixMs: Date.now() - 150 * 60_000,
    triggerKind: 'periodic',
    reason: 'دوري (كل ساعتين)',
    totalLen: Math.round(14.1 * 1024 * 1024),
    databaseLen: Math.round(11.7 * 1024 * 1024),
    imageCount: 18,
    verified: true,
    usbCopied: false,
  },
  {
    id: 'backup-1792307100000-d002.msb',
    fileName: 'backup-1792307100000-d002.msb',
    createdAtUnixMs: Date.now() - 300 * 60_000,
    triggerKind: 'shift_open',
    reason: 'فتح وردية #1',
    totalLen: Math.round(13.9 * 1024 * 1024),
    databaseLen: Math.round(11.5 * 1024 * 1024),
    imageCount: 17,
    verified: true,
    usbCopied: true,
  },
  {
    id: 'backup-1792271400000-d001.msb',
    fileName: 'backup-1792271400000-d001.msb',
    createdAtUnixMs: Date.now() - 24 * 60 * 60_000,
    triggerKind: 'shift_close',
    reason: 'تقفيل وردية #0',
    totalLen: Math.round(13.9 * 1024 * 1024),
    databaseLen: Math.round(11.5 * 1024 * 1024),
    imageCount: 17,
    verified: true,
    usbCopied: true,
  },
];

function recordDemoBackup(
  triggerKind: DemoSavedBackup['triggerKind'],
  reason: string,
): DemoSavedBackup {
  const ts = now();
  const id = `backup-${ts}-${String(demoSavedBackups.length + 1).padStart(4, '0')}.msb`;
  const entry: DemoSavedBackup = {
    id,
    fileName: id,
    createdAtUnixMs: ts,
    triggerKind,
    reason,
    totalLen: Math.round(14.3 * 1024 * 1024),
    databaseLen: Math.round(11.9 * 1024 * 1024),
    imageCount: Object.keys(productImages).length || 18,
    verified: appearance.backupVerify === 'on',
    usbCopied: appearance.backupUsbAuto === 'on',
  };
  demoSavedBackups.unshift(entry);
  if (demoSavedBackups.length > 30) {
    demoSavedBackups.length = 30;
  }
  return { ...entry };
}

function demoOpDrawerDelta(op: DemoWalletOp): number {
  if (op.voidedAt !== null) return 0;
  switch (op.kind) {
    case 'deposit':
    case 'bill':
    case 'card':
      return op.amountMinor + op.feeMinor;
    case 'software':
      return op.feeMinor;
    case 'withdraw':
      return -(op.amountMinor - op.feeMinor);
    case 'topup':
      return op.via === 'drawer' ? -op.amountMinor : 0;
    case 'unload':
      return op.via === 'drawer' ? op.amountMinor : 0;
    default:
      return 0;
  }
}

interface DemoRepair {
  id: string;
  ticketNo: string;
  serviceKind: 'hardware' | 'software';
  customerName: string;
  customerPhone: string;
  deviceName: string;
  imei: string | null;
  deviceLock: string;
  issue: string;
  accessories: string;
  dueLabel: string;
  status: 'received' | 'diagnosing' | 'waiting' | 'ready' | 'delivered' | 'cancelled';
  estimatedPriceMinor: number;
  finalPriceMinor: number;
  partsCostMinor: number;
  depositMinor: number;
  payMethod: 'cash' | 'vf' | 'instapay' | 'card';
  /** The shop wallet the ticket's money was collected into (`ADR-041`). */
  payWalletId?: string | null;
  technicianName: string | null;
  warrantyDays: number;
  note: string;
  createdBy: string;
  createdAt: number;
  deliveredAt: number | null;
}

const DEMO_PAST_TS = Date.now() - 3 * 86_400_000;

const demoRepairs: DemoRepair[] = [
  {
    id: 'rep-seed-1',
    ticketNo: 'R-1091',
    serviceKind: 'hardware',
    customerName: 'كريم سامي',
    customerPhone: '01098765432',
    deviceName: 'آيفون 12 برو',
    imei: '356789012345111',
    deviceLock: 'رمز 1470',
    issue: 'تغيير شاشة أصلية + سماعة مكالمات',
    accessories: 'جراب + شريحة',
    dueLabel: 'النهارده',
    status: 'ready',
    estimatedPriceMinor: 3_200_00,
    finalPriceMinor: 0,
    partsCostMinor: 2_100_00,
    depositMinor: 500_00,
    payMethod: 'cash',
    technicianName: 'م. حسن',
    warrantyDays: 30,
    note: 'تم التركيب والتجربة وجاهز للاستلام',
    createdBy: 'u-peter',
    createdAt: DEMO_PAST_TS,
    deliveredAt: null,
  },
  {
    id: 'rep-seed-2',
    ticketNo: 'R-1092',
    serviceKind: 'hardware',
    customerName: 'سارة محمود',
    customerPhone: '01234567890',
    deviceName: 'شاومي ريدمي نوت 12',
    imei: null,
    deviceLock: 'حرف L',
    issue: 'تغيير سوكت شحن + تنظيف بوردة',
    accessories: 'شاحن',
    dueLabel: 'بكره',
    status: 'diagnosing',
    estimatedPriceMinor: 450_00,
    finalPriceMinor: 0,
    partsCostMinor: 120_00,
    depositMinor: 100_00,
    payMethod: 'cash',
    technicianName: 'م. حسن',
    warrantyDays: 14,
    note: 'تحت الفحص في الورشة',
    createdBy: 'u-peter',
    createdAt: DEMO_PAST_TS + 3_600_000,
    deliveredAt: null,
  },
  {
    id: 'rep-seed-3',
    ticketNo: 'R-1093',
    serviceKind: 'software',
    customerName: 'طارق فؤاد',
    customerPhone: '01122334455',
    deviceName: 'سامسونج A34',
    imei: null,
    deviceLock: '',
    issue: 'تخطي حساب جوجل FRP + تفليش روم رسمي',
    accessories: '',
    dueLabel: 'النهارده',
    status: 'delivered',
    estimatedPriceMinor: 250_00,
    finalPriceMinor: 250_00,
    partsCostMinor: 0,
    depositMinor: 0,
    payMethod: 'cash',
    technicianName: 'يوسف',
    warrantyDays: 0,
    note: 'تم التسليم في ساعتها',
    createdBy: 'u-youssef',
    createdAt: DEMO_PAST_TS + 7_200_000,
    deliveredAt: DEMO_PAST_TS + 7_200_000,
  },
  {
    id: 'rep-seed-4',
    ticketNo: 'R-1094',
    serviceKind: 'hardware',
    customerName: 'وائل جمال',
    customerPhone: '01555667788',
    deviceName: 'أوبو رينو 8T',
    imei: null,
    deviceLock: '0000',
    issue: 'تغيير بطارية أصلية',
    accessories: 'جراب',
    dueLabel: 'النهارده',
    status: 'delivered',
    estimatedPriceMinor: 850_00,
    finalPriceMinor: 850_00,
    partsCostMinor: 500_00,
    depositMinor: 200_00,
    payMethod: 'cash',
    technicianName: 'م. حسن',
    warrantyDays: 14,
    note: 'تم التسليم للعميل',
    createdBy: 'u-peter',
    createdAt: DEMO_PAST_TS + 10_800_000,
    deliveredAt: DEMO_PAST_TS + 14_400_000,
  },
];

/** The first wallet that receives `method`, hidden ones only as a last resort. */
function demoSalePayeeWalletId(method: string): string | null {
  const takers = demoWallets
    .filter((x) => x.payMethod === method)
    .sort(
      (a, b) =>
        Number(a.hidden) - Number(b.hidden) ||
        a.sort - b.sort ||
        (a.id < b.id ? -1 : 1)
    );
  return takers[0]?.id ?? null;
}

/**
 * Which wallet number one payment is recorded on (`ADR-041`).
 *
 * The number the operator named when they named one — and a named number that does not take the
 * method is refused rather than reassigned — otherwise the primary for the method. A method no
 * shop wallet holds (cash, card, آجل, تقسيط) yields null, and naming a wallet for it is refused
 * the same way the real service refuses it.
 */
function demoResolvePaymentWalletId(
  method: string,
  chosen: string | null,
  code: string
): string | null {
  if (method !== 'vf' && method !== 'instapay') {
    if (chosen) fail(code);
    return null;
  }
  if (!chosen) return demoSalePayeeWalletId(method);
  const w = demoWallets.find((x) => x.id === chosen);
  if (w === undefined || w.payMethod !== method) fail(code);
  return w === undefined ? null : w.id;
}

/** The wallet id a caller sent, or null when it sent nothing usable. */
function walletIdArg(args: unknown, key: string): string | null {
  const raw = (args as Record<string, unknown> | undefined)?.[key];
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

/**
 * Name the wallet on the seeded money that predates the choice, the way `0030` and `0031` name it
 * on a real database: the number that received the method at that moment. The reading rule in
 * `demoComputeWalletBalanceMinor` then has one shape in the demo and in Rust, with no fallback
 * the real system never applies (`ADR-041`).
 */
function demoNameHistoricalWallets(): void {
  for (const sale of sales) {
    for (const pay of sale.payments) {
      if (pay.walletId === null) pay.walletId = demoSalePayeeWalletId(pay.method);
    }
  }
  for (const entry of customerLedger) {
    if (entry.kind === 'payment' && !entry.walletId) {
      entry.walletId = demoSalePayeeWalletId(entry.method ?? '');
    }
  }
  for (const repair of demoRepairs) {
    if (repair.status === 'delivered' && !repair.payWalletId) {
      repair.payWalletId = demoSalePayeeWalletId(repair.payMethod);
    }
  }
}

function demoComputeWalletBalanceMinor(w: DemoWallet): number {
  let bal = w.openingBalanceMinor;
  for (const op of demoWalletOps) {
    if (op.voidedAt !== null) continue;
    if (op.walletId === w.id) {
      if (op.kind === 'deposit' || op.kind === 'unload' || op.kind === 'move') {
        bal -= op.amountMinor;
      } else if (op.kind === 'withdraw' || op.kind === 'topup' || op.kind === 'adjust') {
        bal += op.amountMinor;
      }
    }
    if (op.toWalletId === w.id && op.kind === 'move') {
      bal += op.amountMinor;
    }
  }
  // Money is this wallet's when the row names it, and belongs to no wallet when it does not —
  // one rule for the three streams, as in `compute_wallet_balance` (`ADR-041`). What a row names
  // is decided when the money moves, never re-derived from the listing order, so the same sum
  // cannot walk between two numbers of one company.
  for (const sale of sales) {
    const sign = sale.kind === 'reversal' ? -1 : 1;
    for (const pay of sale.payments) {
      if (pay.walletId === w.id) bal += sign * pay.amountMinor;
    }
  }
  for (const entry of customerLedger) {
    if (entry.kind === 'payment' && entry.walletId === w.id) {
      bal += Math.abs(entry.amountMinor);
    }
  }
  for (const repair of demoRepairs) {
    if (repair.status === 'delivered' && repair.payWalletId === w.id) {
      bal += Math.max(0, repair.finalPriceMinor - repair.depositMinor);
    }
  }
  return bal;
}

function demoWalletState(
  balanceMinor: number,
  minAlertMinor: number,
  maxLimitMinor: number
): 'ok' | 'low' | 'near' | 'over' | 'neg' {
  if (balanceMinor < 0) return 'neg';
  if (maxLimitMinor > 0 && balanceMinor > maxLimitMinor) return 'over';
  if (maxLimitMinor > 0 && balanceMinor >= Math.floor((maxLimitMinor * 9) / 10)) {
    return 'near';
  }
  if (minAlertMinor > 0 && balanceMinor < minAlertMinor) return 'low';
  return 'ok';
}

function demoWalletPeriodStats(w: DemoWallet, fromMs: number, toMs: number) {
  let opsCount = 0;
  let depCount = 0;
  let depMinor = 0;
  let witCount = 0;
  let witMinor = 0;
  let feesMinor = 0;
  let usedMinor = 0;
  for (const op of demoWalletOps) {
    if (op.voidedAt !== null) continue;
    if (op.walletId !== w.id) continue;
    if (op.createdAt < fromMs || op.createdAt > toMs) continue;
    if (op.kind === 'deposit') {
      opsCount += 1;
      depCount += 1;
      depMinor += op.amountMinor;
      feesMinor += op.feeMinor;
      usedMinor += op.amountMinor;
    } else if (op.kind === 'withdraw') {
      opsCount += 1;
      witCount += 1;
      witMinor += op.amountMinor;
      feesMinor += op.feeMinor;
      usedMinor += op.amountMinor;
    }
  }
  let salesInMinor = 0;
  {
    for (const s of sales) {
      if (s.occurredAt < fromMs || s.occurredAt > toMs) continue;
      const sign = s.kind === 'reversal' ? -1 : 1;
      for (const p of s.payments) {
        if (p.walletId === w.id) {
          salesInMinor += sign * p.amountMinor;
        }
      }
    }
    for (const entry of customerLedger) {
      if (
        entry.kind === 'payment' &&
        entry.walletId === w.id &&
        entry.occurredAt >= fromMs &&
        entry.occurredAt <= toMs
      ) {
        salesInMinor += Math.abs(entry.amountMinor);
      }
    }
    for (const rep of demoRepairs) {
      if (
        rep.status === 'delivered' &&
        rep.payWalletId === w.id &&
        rep.deliveredAt !== null &&
        rep.deliveredAt >= fromMs &&
        rep.deliveredAt <= toMs
      ) {
        salesInMinor += Math.max(0, rep.finalPriceMinor - rep.depositMinor);
      }
    }
  }
  return {
    walletId: w.id,
    opsCount,
    depCount,
    depMinor,
    witCount,
    witMinor,
    feesMinor,
    usedMinor,
    salesInMinor,
  };
}

function demoServicesWindowTotals(fromMs: number, toMs: number) {
  let servicesCount = 0;
  let servicesFeeMinor = 0;
  let servicesCashInMinor = 0;
  let servicesCashOutMinor = 0;
  let walletDrawerNetMinor = 0;
  for (const op of demoWalletOps) {
    if (op.voidedAt !== null) continue;
    if (op.createdAt < fromMs || op.createdAt > toMs) continue;
    if (
      op.kind === 'deposit' ||
      op.kind === 'bill' ||
      op.kind === 'card'
    ) {
      servicesCount += 1;
      servicesFeeMinor += op.feeMinor;
      servicesCashInMinor += op.amountMinor + op.feeMinor;
    } else if (op.kind === 'software') {
      servicesCount += 1;
      servicesFeeMinor += op.feeMinor;
      servicesCashInMinor += op.feeMinor;
    } else if (op.kind === 'withdraw') {
      servicesCount += 1;
      servicesFeeMinor += op.feeMinor;
      servicesCashOutMinor += op.amountMinor - op.feeMinor;
    } else if (op.kind === 'topup' && op.via === 'drawer') {
      walletDrawerNetMinor -= op.amountMinor;
    } else if (op.kind === 'unload' && op.via === 'drawer') {
      walletDrawerNetMinor += op.amountMinor;
    }
  }
  return {
    servicesCount,
    servicesFeeMinor,
    servicesCashInMinor,
    servicesCashOutMinor,
    walletDrawerNetMinor,
  };
}

function buildDemoShiftSummary(shift: DemoShift) {
  const fromMs = shift.openedAt;
  const toMs = shift.closedAt ?? Number.MAX_SAFE_INTEGER;
  const shiftSales = sales.filter((s) => s.occurredAt >= fromMs && s.occurredAt <= toMs);
  let cashSalesMinor = 0;
  let vfSalesMinor = 0;
  let instapaySalesMinor = 0;
  let cardSalesMinor = 0;
  let installSalesMinor = 0;
  let creditSalesMinor = 0;
  let salesTotalMinor = 0;
  let salesCostMinor = 0;
  for (const s of shiftSales) {
    const sign = s.kind === 'reversal' ? -1 : 1;
    salesTotalMinor += sign * s.totalMinor;
    salesCostMinor += sign * s.costTotalMinor;
    for (const p of s.payments) {
      if (p.method === 'cash') cashSalesMinor += sign * p.amountMinor;
      else if (p.method === 'vf') vfSalesMinor += sign * p.amountMinor;
      else if (p.method === 'instapay') instapaySalesMinor += sign * p.amountMinor;
      else if (p.method === 'card') cardSalesMinor += sign * p.amountMinor;
      else if (p.method === 'install') installSalesMinor += sign * p.amountMinor;
      else if (p.method === 'credit') creditSalesMinor += sign * p.amountMinor;
    }
  }
  const customerCashInMinor = customerLedger
    .filter(
      (e) =>
        e.kind === 'payment' &&
        e.method === 'cash' &&
        e.occurredAt >= fromMs &&
        e.occurredAt <= toMs
    )
    .reduce((sum, e) => sum + Math.abs(e.amountMinor), 0);

  const svc = demoServicesWindowTotals(fromMs, toMs);
  for (const rep of demoRepairs) {
    if (rep.status === 'cancelled') continue;
    if (rep.createdAt >= fromMs && rep.createdAt <= toMs && rep.depositMinor > 0) {
      svc.servicesCashInMinor += rep.depositMinor;
    }
    if (
      rep.status === 'delivered' &&
      rep.deliveredAt !== null &&
      rep.deliveredAt >= fromMs &&
      rep.deliveredAt <= toMs
    ) {
      const rem = Math.max(0, rep.finalPriceMinor - rep.depositMinor);
      svc.servicesCount += 1;
      svc.servicesFeeMinor += rep.finalPriceMinor - rep.partsCostMinor;
      if (rep.payMethod === 'cash') svc.servicesCashInMinor += rem;
      else if (rep.payMethod === 'vf') vfSalesMinor += rem;
      else if (rep.payMethod === 'instapay') instapaySalesMinor += rem;
      else if (rep.payMethod === 'card') cardSalesMinor += rem;
    }
  }

  const shiftExpenses = expenses
    .filter((e) => e.shiftId === shift.id)
    .sort((a, b) => b.createdAt - a.createdAt);
  const shiftMovements = cashMovements
    .filter((m) => m.shiftId === shift.id)
    .sort((a, b) => b.createdAt - a.createdAt);

  const expensesMinor = shiftExpenses.reduce((sum, e) => sum + e.amountMinor, 0);
  const cashInMinor = shiftMovements
    .filter((m) => m.kind === 'cash_in')
    .reduce((sum, m) => sum + m.amountMinor, 0);
  const ownerDrawMinor = shiftMovements
    .filter((m) => m.kind === 'owner_draw')
    .reduce((sum, m) => sum + m.amountMinor, 0);

  const expectedCashMinor =
    shift.openingCashMinor +
    cashSalesMinor +
    customerCashInMinor +
    svc.servicesCashInMinor -
    svc.servicesCashOutMinor +
    svc.walletDrawerNetMinor +
    cashInMinor -
    expensesMinor -
    ownerDrawMinor;
  const grossProfitMinor = salesTotalMinor - salesCostMinor;
  const netProfitMinor = grossProfitMinor + svc.servicesFeeMinor - expensesMinor;

  return {
    shift: { ...shift },
    totals: {
      openingCashMinor: shift.openingCashMinor,
      cashSalesMinor,
      vfSalesMinor,
      instapaySalesMinor,
      cardSalesMinor,
      installSalesMinor,
      creditSalesMinor,
      salesTotalMinor,
      salesCostMinor,
      salesCount: shiftSales.length,
      customerCashInMinor,
      servicesCount: svc.servicesCount,
      servicesFeeMinor: svc.servicesFeeMinor,
      servicesCashInMinor: svc.servicesCashInMinor,
      servicesCashOutMinor: svc.servicesCashOutMinor,
      walletDrawerNetMinor: svc.walletDrawerNetMinor,
      cashInMinor,
      ownerDrawMinor,
      expensesMinor,
      expectedCashMinor,
      grossProfitMinor,
      netProfitMinor,
    },
    expenses: shiftExpenses.map((e) => ({ ...e })),
    cashMovements: shiftMovements.map((m) => ({ ...m })),
  };
}
const settings = {
  defaultCostMethod: 'moving_average',
  invoicePrefix: 'INV',
  defaultVatEnabled: false,
  defaultVatRateBp: null as number | null,
  defaultVatInclusive: false,
  maxDiscountKind: 'money',
  maxDiscountValue: 0,
};

// An open shop has no sign-in to wait for: the shell opens on its own operator,
// which is what `session::resolve` answers in Rust when there is no token.
let current: DemoUser | null = openShop ? openOwner : null;
let freshUntil = 0;

const session = () =>
  current === null
    ? null
    : {
        userId: current.id,
        displayName: current.displayName,
        role: current.role,
        assurance: now() < freshUntil ? 'reauthenticated' : 'normal',
      };

function requireUser(): DemoUser {
  return current ?? fail('NOT_AUTHENTICATED');
}

function requireManager(fresh = false): DemoUser {
  const user = requireUser();
  if (user.role !== 'manager') fail('PERMISSION_DENIED');
  // `ADR-039`: while the shop is open its session already stands at the assurance a
  // fresh password would prove — `open_mode::reauthenticate` answers Ok because there
  // is no secret to re-type yet — so the mirror must not demand one either, or every
  // cost read in the demo is a wall the real program does not have.
  if (fresh && claimed && now() >= freshUntil) fail('REAUTHENTICATION_REQUIRED');
  return user;
}

const productDto = (x: DemoProduct) => ({
  id: x.id,
  name: x.name,
  disposition: x.disposition,
  barcode: x.barcode,
  salePriceMinor: x.salePriceMinor,
  categoryId: x.categoryId,
  status: x.status,
  createdBy: 'u-peter',
  updatedBy: 'u-peter',
  createdAt: 0,
  updatedAt: 0,
});

const categoryDto = (c: DemoCategory) => ({
  id: c.id,
  name: c.name,
  parentId: c.parentId,
  kind: c.kind,
  icon: c.icon,
  hidden: c.hidden,
  sortOrder: c.sortOrder,
});
const brandDto = (b: DemoBrand) => ({
  id: b.id,
  name: b.name,
  deviceType: b.deviceType,
  sortOrder: b.sortOrder,
  hidden: b.hidden,
  lines: b.lines,
});
const findBrand = (id: string) => brands.find((b) => b.id === id) ?? fail('BRAND_NOT_FOUND');
const ordered = () => [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'ar'));
const findCategory = (id: string) => categories.find((c) => c.id === id) ?? fail('DEPARTMENT_NOT_FOUND');
const nameTaken = (name: string, except: string | null) =>
  categories.some((c) => c.id !== except && c.name.trim().toLowerCase() === name.trim().toLowerCase());
const categoryOf = (args: Args): string | null => {
  const id = args?.['categoryId'];
  if (typeof id !== 'string') return null;
  return categories.some((c) => c.id === id) ? id : fail('PRODUCT_CATEGORY_NOT_FOUND');
};

const str = (args: Args, key: string): string => {
  const v = args?.[key];
  return typeof v === 'string' ? v : '';
};
const numArg = (args: Args, key: string): number => {
  const v = args?.[key];
  return typeof v === 'number' ? v : NaN;
};
const findProduct = (id: string) => products.find((x) => x.id === id) ?? fail('NO_PRODUCT_WITH_THIS_ID');

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

// --- shortages (Plan item 1.15, ADR-030) -----------------------------------

interface DemoShortage {
  id: string;
  productId: string | null;
  name: string;
  qty: number;
  note: string;
  customerName: string | null;
  customerPhone: string | null;
  status: 'open' | 'ordered';
  createdBy: string;
  createdAt: number;
  resolvedAt: number | null;
}

const airpodsProd = products.find((p) => p.name.includes('ايربودز برو'));

const demoShortages: DemoShortage[] = [
  {
    id: 'sh-demo-1',
    productId: null,
    name: 'شاحن لاسلكي ماج سيف',
    qty: 2,
    note: 'العميل سأل عليه ومش عندنا في المحل',
    customerName: 'كريم مصطفى',
    customerPhone: '01011122233',
    status: 'open',
    createdBy: 'u-youssef',
    createdAt: Date.now() - 2 * 3600_000,
    resolvedAt: null,
  },
  ...(airpodsProd
    ? [
        {
          id: 'sh-demo-2',
          productId: airpodsProd.id,
          name: airpodsProd.name,
          qty: 3,
          note: 'باقي قطعتين، مطلوب كرتونة صغيرة',
          customerName: null,
          customerPhone: null,
          status: 'ordered' as const,
          createdBy: 'u-peter',
          createdAt: Date.now() - 5 * 3600_000,
          resolvedAt: null,
        },
      ]
    : []),
];

function normShortageName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .split(/\s+/)
    .join(' ');
}

function demoMinQty(p: DemoProduct): number {
  const catObj = p.categoryId ? categories.find((c) => c.id === p.categoryId) : undefined;
  if (catObj?.kind === 'used') return 1;
  const isSerial =
    p.disposition === 'serialized' ||
    p.tracking === 'serial_optional' ||
    p.tracking === 'serial_required' ||
    p.brandId !== null ||
    catObj?.kind === 'phone';
  if (isSerial) return 2;
  return 5;
}

function repairTicketDto(rep: DemoRepair, includeCost: boolean) {
  const creator = users.find((u) => u.id === rep.createdBy);
  const collectedMinor =
    rep.status === 'cancelled'
      ? 0
      : rep.status === 'delivered'
        ? Math.max(rep.finalPriceMinor, rep.depositMinor)
        : rep.depositMinor;
  const targetPrice =
    rep.status === 'delivered' || rep.finalPriceMinor > 0
      ? rep.finalPriceMinor
      : rep.estimatedPriceMinor;
  const remainingMinor =
    rep.status === 'delivered' || rep.status === 'cancelled'
      ? 0
      : Math.max(0, targetPrice - rep.depositMinor);
  const netProfit = collectedMinor - rep.partsCostMinor;
  return {
    id: rep.id,
    ticketNo: rep.ticketNo,
    serviceKind: rep.serviceKind,
    customerName: rep.customerName,
    customerPhone: rep.customerPhone,
    deviceName: rep.deviceName,
    imei: rep.imei,
    deviceLock: rep.deviceLock,
    issue: rep.issue,
    accessories: rep.accessories,
    dueLabel: rep.dueLabel,
    status: rep.status,
    estimatedPriceMinor: rep.estimatedPriceMinor,
    finalPriceMinor: rep.finalPriceMinor,
    partsCostMinor: includeCost ? rep.partsCostMinor : null,
    netProfitMinor: includeCost ? netProfit : null,
    depositMinor: rep.depositMinor,
    collectedMinor,
    remainingMinor,
    payMethod: rep.payMethod,
    technicianName: rep.technicianName,
    warrantyDays: rep.warrantyDays,
    note: rep.note,
    createdBy: rep.createdBy,
    createdByName: creator?.displayName ?? 'المالك',
    createdAt: rep.createdAt,
    deliveredAt: rep.deliveredAt,
  };
}

function emptyDemoRepairBucket(serviceKind: string, includeCost: boolean) {
  return {
    serviceKind,
    ticketsCount: 0,
    openCount: 0,
    readyCount: 0,
    deliveredCount: 0,
    depositCollectedMinor: 0,
    deliveryCollectedMinor: 0,
    totalRevenueMinor: 0,
    cashCollectedMinor: 0,
    vfCollectedMinor: 0,
    instapayCollectedMinor: 0,
    cardCollectedMinor: 0,
    partsCostMinor: includeCost ? 0 : (null as number | null),
    netProfitMinor: includeCost ? 0 : (null as number | null),
  };
}

function buildDemoRepairsOverview(
  fromTs: number | null,
  toTs: number | null,
  includeCost: boolean
) {
  const inWin = (ts: number) => {
    if (fromTs !== null && ts < fromTs) return false;
    if (toTs !== null && ts > toTs) return false;
    return true;
  };
  const hardware = emptyDemoRepairBucket('hardware', includeCost);
  const software = emptyDemoRepairBucket('software', includeCost);
  const combined = emptyDemoRepairBucket('all', includeCost);

  const addBucket = (
    b: ReturnType<typeof emptyDemoRepairBucket>,
    rep: DemoRepair,
    createdInPeriod: boolean,
    deliveredInPeriod: boolean,
    isOpen: boolean
  ) => {
    if (isOpen) {
      b.openCount += 1;
      if (rep.status === 'ready') b.readyCount += 1;
    }
    if ((createdInPeriod || deliveredInPeriod || isOpen) && rep.status !== 'cancelled') {
      b.ticketsCount += 1;
    }
    if (rep.status === 'cancelled') return;
    const addPay = (m: string, amt: number) => {
      if (amt <= 0) return;
      if (m === 'vf') b.vfCollectedMinor += amt;
      else if (m === 'instapay') b.instapayCollectedMinor += amt;
      else if (m === 'card') b.cardCollectedMinor += amt;
      else b.cashCollectedMinor += amt;
    };
    if (createdInPeriod && rep.depositMinor > 0) {
      b.depositCollectedMinor += rep.depositMinor;
      b.totalRevenueMinor += rep.depositMinor;
      addPay('cash', rep.depositMinor);
    }
    if (rep.status === 'delivered' && deliveredInPeriod) {
      b.deliveredCount += 1;
      const slice = Math.max(0, rep.finalPriceMinor - rep.depositMinor);
      b.deliveryCollectedMinor += slice;
      b.totalRevenueMinor += slice;
      addPay(rep.payMethod, slice);
      if (b.partsCostMinor !== null) b.partsCostMinor += rep.partsCostMinor;
    } else if (rep.status !== 'delivered' && createdInPeriod && rep.partsCostMinor > 0) {
      if (b.partsCostMinor !== null) b.partsCostMinor += rep.partsCostMinor;
    }
    if (b.partsCostMinor !== null) {
      b.netProfitMinor = b.totalRevenueMinor - b.partsCostMinor;
    }
  };

  const techMap = new Map<
    string,
    {
      hwCount: number;
      swCount: number;
      deliveredCount: number;
      hwRev: number;
      swRev: number;
      partsCost: number;
    }
  >();

  const visibleTickets = [];
  for (const rep of demoRepairs) {
    const isOpen =
      rep.status === 'received' ||
      rep.status === 'diagnosing' ||
      rep.status === 'waiting' ||
      rep.status === 'ready';
    const createdIn = inWin(rep.createdAt);
    const deliveredIn = rep.deliveredAt !== null ? inWin(rep.deliveredAt) : false;

    if (rep.serviceKind === 'software') {
      addBucket(software, rep, createdIn, deliveredIn, isOpen);
    } else {
      addBucket(hardware, rep, createdIn, deliveredIn, isOpen);
    }
    addBucket(combined, rep, createdIn, deliveredIn, isOpen);

    if (rep.status !== 'cancelled' && (createdIn || deliveredIn || isOpen)) {
      const tech = (rep.technicianName ?? '').trim();
      if (tech) {
        const entry = techMap.get(tech) ?? {
          hwCount: 0,
          swCount: 0,
          deliveredCount: 0,
          hwRev: 0,
          swRev: 0,
          partsCost: 0,
        };
        if (rep.serviceKind === 'software') entry.swCount += 1;
        else entry.hwCount += 1;
        let rev = 0;
        if (createdIn && rep.depositMinor > 0) rev += rep.depositMinor;
        if (rep.status === 'delivered' && deliveredIn) {
          entry.deliveredCount += 1;
          rev += Math.max(0, rep.finalPriceMinor - rep.depositMinor);
          entry.partsCost += rep.partsCostMinor;
        }
        if (rep.serviceKind === 'software') entry.swRev += rev;
        else entry.hwRev += rev;
        techMap.set(tech, entry);
      }
    }

    if (isOpen || createdIn || deliveredIn) {
      visibleTickets.push(repairTicketDto(rep, includeCost));
    }
  }

  const technicians = Array.from(techMap.entries())
    .map(([technicianName, acc]) => {
      const totalRevenueMinor = acc.hwRev + acc.swRev;
      const net = totalRevenueMinor - acc.partsCost;
      return {
        technicianName,
        hardwareCount: acc.hwCount,
        softwareCount: acc.swCount,
        deliveredCount: acc.deliveredCount,
        hardwareRevenueMinor: acc.hwRev,
        softwareRevenueMinor: acc.swRev,
        totalRevenueMinor,
        partsCostMinor: includeCost ? acc.partsCost : null,
        netProfitMinor: includeCost ? net : null,
      };
    })
    .sort((a, b) => b.totalRevenueMinor - a.totalRevenueMinor);

  return {
    tickets: visibleTickets,
    hardware,
    software,
    combined,
    technicians,
  };
}

function shortageDto(sh: DemoShortage) {
  const prod = sh.productId ? products.find((p) => p.id === sh.productId) : undefined;
  const creator = users.find((u) => u.id === sh.createdBy);
  return {
    id: sh.id,
    productId: sh.productId,
    name: sh.name,
    qty: sh.qty,
    note: sh.note,
    customerName: sh.customerName,
    customerPhone: sh.customerPhone,
    status: sh.status,
    createdBy: sh.createdBy,
    createdByName: creator?.displayName ?? 'المالك',
    createdAt: sh.createdAt,
    resolvedAt: sh.resolvedAt,
    onHand: prod ? prod.onHand : null,
    minQty: prod ? demoMinQty(prod) : null,
  };
}

function buildDemoShortagesOverview() {
  const active = demoShortages
    .filter((sh) => sh.resolvedAt === null)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
      return b.createdAt - a.createdAt;
    })
    .map(shortageDto);

  const inShortageProdIds = new Set(
    demoShortages
      .filter((sh) => sh.resolvedAt === null && sh.productId !== null)
      .map((sh) => sh.productId!)
  );

  const suggestions = products
    .filter((p) => {
      if (p.status !== 'active') return false;
      if (inShortageProdIds.has(p.id)) return false;
      const min = demoMinQty(p);
      return p.onHand <= min;
    })
    .sort((a, b) => a.onHand - b.onHand || a.name.localeCompare(b.name))
    .map((p) => {
      const catObj = p.categoryId ? categories.find((c) => c.id === p.categoryId) : undefined;
      const minQty = demoMinQty(p);
      return {
        productId: p.id,
        name: p.name,
        categoryId: p.categoryId,
        categoryName: catObj?.name ?? null,
        onHand: p.onHand,
        minQty,
        suggestedQty: Math.max(1, minQty * 2 - p.onHand),
      };
    });

  return { items: active, suggestions };
}

// Every seeded row above now names its wallet, as a database upgraded through `0030`/`0031`
// would. Placed here because the wallets and the repair seeds are declared further down than the
// sales they are matched against.
demoNameHistoricalWallets();

const handlers: Record<string, (args: Args) => unknown> = {
  // identity
  // Three accounts exist in the demo data, so the shop is never open in the sense
  // of `ADR-039`, and the claim has nothing to claim. Answered the way Rust answers a
  // shop that already has an account, so the card in الإعدادات shows the same line a
  // real second attempt would. `?empty=1` answers the way Rust answers a database with
  // nothing in it and no open row: `needsSetup` true, `openMode` false — no screen
  // opens on the first number any more, which is exactly the point of the line the
  // lock card shows.
  bootstrap_status: () => ({
    needsSetup: emptyDevice,
    openMode: !claimed,
    openDisplayName: claimed ? null : openOwner.displayName,
  }),
  // The claim in `ADR-039`: the same row, with a name and a password of its own.
  claim_open_account: (args) => {
    if (claimed) fail('BOOTSTRAP_ALREADY_COMPLETED');
    const name = str(args, 'displayName').trim();
    const password = str(args, 'password');
    if (name === '') fail('DISPLAY_NAME_REQUIRED');
    if (password.length < 8) fail('PASSWORD_DOES_NOT_MEET_POLICY');
    openOwner.displayName = name;
    openOwner.password = password;
    // `ADR-039`: `clear_secondary_secrets`. The open operator is a manager, so a PIN
    // could be set on this row before anybody owned it; the owner's password is the
    // only secret that survives the claim.
    openOwner.pin = null;
    claimed = true;
    freshUntil = 0;
    return session();
  },
  whoami: () => session(),
  // The open owner row is not an account anybody can sign in to, so it is not
  // offered to sign in to either (`ADR-039`, as in `auth::list_users`). The
  // «حساب المالك» card is where it is spoken about, until it is claimed.
  list_users_for_picker: () =>
    users
      .filter((u) => claimed || u !== openOwner)
      .map((u) => ({
      id: u.id,
      displayName: u.displayName,
      username: u.username,
      role: u.role,
      disabled: u.disabled,
      hasPin: u.pin !== null,
    })),
  login: (args) => {
    const user = users.find((u) => u.id === str(args, 'userId') && !u.disabled);
    if (user === undefined || user.password !== str(args, 'password')) fail('INVALID_CREDENTIALS');
    current = user ?? null;
    freshUntil = 0;
    return session();
  },
  // The same rules as Rust (ADR-017): 4–6 digits; changing needs the password.
  login_with_pin: (args) => {
    const user = users.find((u) => u.id === str(args, 'userId') && !u.disabled) ?? fail('INVALID_CREDENTIALS');
    if (user.pin === null) fail('PIN_NOT_SET');
    if (user.pin !== str(args, 'pin')) fail('INVALID_CREDENTIALS');
    current = user;
    freshUntil = 0;
    return session();
  },
  set_my_pin: (args) => {
    const user = requireUser();
    const pin = str(args, 'pin');
    if (!/^\d{4,6}$/.test(pin)) fail('PIN_DOES_NOT_MEET_POLICY');
    if (user.pin !== null && args?.['currentPassword'] !== user.password) fail('INVALID_CREDENTIALS');
    user.pin = pin;
  },
  set_user_pin: (args) => {
    requireManager(true);
    const pin = str(args, 'pin');
    if (!/^\d{4,6}$/.test(pin)) fail('PIN_DOES_NOT_MEET_POLICY');
    const target = users.find((u) => u.id === str(args, 'userId')) ?? fail('INVALID_CREDENTIALS');
    // The open till is not an account to act on (`ADR-039`): no list names it, and
    // the only manager who could is the row itself. `INVALID_CREDENTIALS` is what a
    // missing id answers too (`ADR-017`: the two share a code so the response never
    // discloses which identifiers exist), so this is Rust's answer, not a softer one.
    if (target === openOwner && !claimed) fail('INVALID_CREDENTIALS');
    target.pin = pin;
  },
  // The owner's PIN approval (ADR-017 §3): any session may ask, only an active
  // manager's PIN answers. No demo command is sensitive yet, so nothing spends
  // the approval; the prompt can still be seen working.
  approve_with_owner_pin: (args) => {
    requireUser();
    const approver = users.find((u) => u.id === str(args, 'approverId')) ?? fail('INVALID_CREDENTIALS');
    if (approver.role !== 'manager') fail('PERMISSION_DENIED');
    if (approver.disabled) fail('ACCOUNT_DISABLED');
    if (approver.pin === null) fail('PIN_NOT_SET');
    if (approver.pin !== str(args, 'pin')) fail('INVALID_CREDENTIALS');
    approvedOnce = true;
  },
  // The recovery code (ADR-017 §4): the same rules as Rust, minus the lockout.
  recover_password_with_code: (args) => {
    const user = users.find((u) => u.id === str(args, 'userId')) ?? fail('INVALID_CREDENTIALS');
    if (user.disabled) fail('ACCOUNT_DISABLED');
    const newPassword = str(args, 'newPassword');
    if (newPassword.length < 8) fail('PASSWORD_DOES_NOT_MEET_POLICY');
    const held = recoveryCodes[user.id] ?? fail('RECOVERY_CODE_NOT_SET');
    if (readCode(str(args, 'code')) !== held.code) fail('INVALID_CREDENTIALS');
    user.password = newPassword;
    current = null;
    freshUntil = 0;
    const next = drawCode();
    recoveryCodes[user.id] = { code: next, createdAt: now() };
    return { code: groupCode(next) };
  },
  create_recovery_code: (args) => {
    const user = requireManager();
    if (str(args, 'currentPassword') !== user.password) fail('INVALID_CREDENTIALS');
    const next = drawCode();
    recoveryCodes[user.id] = { code: next, createdAt: now() };
    return { code: groupCode(next) };
  },
  recovery_code_status: () => {
    const user = requireManager();
    return { createdAt: recoveryCodes[user.id]?.createdAt ?? null };
  },
  logout: () => {
    current = null;
    freshUntil = 0;
  },
  password_change_required: () => false,
  reauthenticate: (args) => {
    const user = requireUser();
    // `ADR-039`: an open shop has no password to prove, and its session already holds
    // the level this call exists to grant. Rust answers the same way.
    if (!claimed) return 'reauthenticated';
    if (user.password !== str(args, 'password')) fail('INVALID_CREDENTIALS');
    freshUntil = now() + 5 * 60_000;
    return 'reauthenticated';
  },

  // display choices
  read_appearance: () => ({ ...appearance }),
  update_appearance: (args) => {
    const rawKey = str(args, 'key');
    const keyMap: Record<string, keyof typeof appearance> = {
      'ui.look': 'look',
      'ui.theme': 'theme',
      'ui.accent': 'accent',
      'ui.font': 'font',
      'ui.scale': 'scale',
      'ui.digits': 'digits',
      'ui.images': 'images',
      'ui.imei_mode': 'imeiMode',
      'ui.pay_methods': 'payMethods',
      'ui.discount_limit_pct': 'discountLimitPct',
      'ui.shop_name': 'shopName',
      'ui.shop_phone': 'shopPhone',
      'ui.shop_address': 'shopAddress',
      'ui.receipt_footer': 'receiptFooter',
      'ui.wa_template': 'waTemplate',
      'ui.receipt_mode': 'receiptMode',
      'ui.printer_enabled': 'printerEnabled',
      'ui.receipt_paper': 'receiptPaper',
      'ui.warranty_new': 'warrantyNew',
      'ui.warranty_used': 'warrantyUsed',
      'ui.warranty_item': 'warrantyItem',
      'ui.seller_can_close_shift': 'sellerCanCloseShift',
      'ui.service_fee_mode': 'serviceFeeMode',
      'ui.service_fee_pct': 'serviceFeePct',
      'ui.service_fee_min': 'serviceFeeMin',
      'ui.bill_fee': 'billFee',
      'ui.backup_on_shift': 'backupOnShift',
      'ui.backup_every_2h': 'backupEvery2h',
      'ui.backup_usb_auto': 'backupUsbAuto',
      'ui.backup_verify': 'backupVerify',
    };
    const key = keyMap[rawKey] ?? fail('SETTING_UNKNOWN_KEY');
    if (key === 'theme') requireUser();
    else if (
      key === 'images' ||
      key === 'imeiMode' ||
      key === 'payMethods' ||
      key === 'discountLimitPct' ||
      key === 'shopName' ||
      key === 'shopPhone' ||
      key === 'shopAddress' ||
      key === 'receiptFooter' ||
      key === 'waTemplate' ||
      key === 'receiptMode' ||
      key === 'printerEnabled' ||
      key === 'receiptPaper' ||
      key === 'warrantyNew' ||
      key === 'warrantyUsed' ||
      key === 'warrantyItem' ||
      key === 'sellerCanCloseShift' ||
      key === 'serviceFeeMode' ||
      key === 'serviceFeePct' ||
      key === 'serviceFeeMin' ||
      key === 'billFee' ||
      key === 'backupOnShift' ||
      key === 'backupEvery2h' ||
      key === 'backupUsbAuto' ||
      key === 'backupVerify'
    )
      requireManager(false);
    else requireManager(true);

    const val = str(args, 'value').trim();
    if (key === 'discountLimitPct') {
      if (!/^\d{1,3}$/.test(val)) fail('SETTING_VALUE_INVALID');
      const n = Number(val);
      if (!Number.isInteger(n) || n < 0 || n > 100) fail('SETTING_VALUE_INVALID');
      appearance[key] = String(n);
    } else if (
      key === 'warrantyNew' ||
      key === 'warrantyUsed' ||
      key === 'warrantyItem'
    ) {
      if (!/^\d{1,2}$/.test(val)) fail('SETTING_VALUE_INVALID');
      const n = Number(val);
      if (!Number.isInteger(n) || n < 0 || n > 60) fail('SETTING_VALUE_INVALID');
      appearance[key] = String(n);
    } else if (key === 'serviceFeeMode') {
      const lower = val.toLowerCase();
      if (!['manual', 'auto'].includes(lower)) fail('SETTING_VALUE_INVALID');
      appearance[key] = lower;
    } else if (
      key === 'serviceFeePct' ||
      key === 'serviceFeeMin' ||
      key === 'billFee'
    ) {
      if (!/^\d{1,4}$/.test(val)) fail('SETTING_VALUE_INVALID');
      const n = Number(val);
      if (!Number.isInteger(n) || n < 0) fail('SETTING_VALUE_INVALID');
      appearance[key] = String(n);
    } else if (
      key === 'shopName' ||
      key === 'shopPhone' ||
      key === 'shopAddress' ||
      key === 'receiptFooter' ||
      key === 'waTemplate'
    ) {
      if ((key === 'shopName' || key === 'waTemplate') && val === '') {
        fail('SETTING_VALUE_INVALID');
      }
      appearance[key] = val;
    } else if (key === 'receiptMode') {
      const lower = val.toLowerCase();
      if (!['wa', 'none', 'print', 'both'].includes(lower)) fail('SETTING_VALUE_INVALID');
      appearance[key] = lower;
    } else if (
      key === 'printerEnabled' ||
      key === 'sellerCanCloseShift' ||
      key === 'backupOnShift' ||
      key === 'backupEvery2h' ||
      key === 'backupUsbAuto' ||
      key === 'backupVerify'
    ) {
      const lower = val.toLowerCase();
      if (!['on', 'off'].includes(lower)) fail('SETTING_VALUE_INVALID');
      appearance[key] = lower;
    } else if (key === 'receiptPaper') {
      if (!['80', '58'].includes(val)) fail('SETTING_VALUE_INVALID');
      appearance[key] = val;
    } else {
      appearance[key] = val.toLowerCase();
    }
    return { ...appearance };
  },


  // the sales screen
  pos_catalog: () => {
    requireUser();
    return {
      products: products
        .filter((x) => x.status === 'active')
        .map((x) => ({
          id: x.id,
          name: x.name,
          disposition: x.disposition,
          tracking: x.tracking ?? (x.brandId !== null ? 'serial_optional' : 'none'),
          barcode: x.barcode,
          salePriceMinor: x.salePriceMinor,
          categoryId: x.categoryId,
          brandId: x.brandId,
          parentId: x.parentId ?? null,
          parentName: x.parentName ?? null,
          dimension1: x.dimension1 ?? null,
          dimension2: x.dimension2 ?? null,
          variant1: x.variant1 ?? null,
          variant2: x.variant2 ?? null,
          variantOrder: x.variantOrder ?? null,
          onHand: x.onHand,
          soldRecently: x.soldRecently,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ar')),
      categories: ordered().map(categoryDto),
      brands: [...brands]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((b) => ({ id: b.id, name: b.name, aliases: b.aliases, sortOrder: b.sortOrder })),
      units: productUnits
        .filter((u) => u.status === 'in_stock')
        .map((u) => ({
          id: u.id,
          productId: u.productId,
          imei: u.imei,
          imei2: u.imei2,
          color: u.color,
          conditionGrade: u.conditionGrade ?? null,
          batteryHealthPct: u.batteryHealthPct ?? null,
          accessories: u.accessories ?? null,
          intakeNote: u.intakeNote ?? null,
          createdAt: u.createdAt,
        })),
    };
  },

  record_sale: (args) => {
    requireUser();
    const lines =
      (args?.['lines'] as
        | {
            productId: string;
            quantity: number;
            imei?: string | null;
            discountMinor?: number | null;
            warrantyStart?: string | null;
            warrantyEnd?: string | null;
          }[]
        | undefined) ?? [];
    if (lines.length === 0) fail('SALE_EMPTY');
    let grossSubtotal = 0;
    let linesNetSubtotal = 0;
    for (const line of lines) {
      const x = findProduct(line.productId);
      if (x.status !== 'active') fail('SALE_PRODUCT_ARCHIVED');
      if (x.disposition !== 'quantity') fail('SALE_DISPOSITION_NOT_SUPPORTED');
      if (x.salePriceMinor === null) fail('SALE_PRICE_NOT_SET');
      if (!(line.quantity > 0)) fail('SALE_INVALID_QUANTITY');
      if (line.quantity > x.onHand) fail('COST_INSUFFICIENT_STOCK');
      const tracking = x.tracking ?? (x.brandId !== null ? 'serial_optional' : 'none');
      const rawImei = typeof line.imei === 'string' && line.imei.trim() !== '' ? demoNormalizeImei(line.imei) : null;
      if (rawImei === null && tracking !== 'none' && (tracking === 'serial_required' || appearance.imeiMode === 'required')) {
        fail('IMEI_REQUIRED_FOR_ALL_UNITS');
      }
      if (rawImei !== null) {
        if (tracking === 'none') fail('IMEI_PRODUCT_NOT_SERIAL_TRACKED');
        if (line.quantity !== 1) fail('SALE_INVALID_QUANTITY');
        if (!demoLuhn(rawImei)) fail('IMEI_CHECK_DIGIT_INVALID');
      }
      const lineGross = (x.salePriceMinor ?? 0) * line.quantity;
      const lineDisc = typeof line.discountMinor === 'number' ? line.discountMinor : 0;
      if (!Number.isInteger(lineDisc) || lineDisc < 0 || lineDisc > lineGross) {
        fail('SALE_DISCOUNT_INVALID');
      }
      grossSubtotal += lineGross;
      linesNetSubtotal += lineGross - lineDisc;
    }
    const invoiceDisc =
      typeof args?.['invoiceDiscountMinor'] === 'number'
        ? (args['invoiceDiscountMinor'] as number)
        : 0;
    if (!Number.isInteger(invoiceDisc) || invoiceDisc < 0 || invoiceDisc > linesNetSubtotal) {
      fail('SALE_DISCOUNT_INVALID');
    }
    const total = linesNetSubtotal - invoiceDisc;
    const totalDiscount = grossSubtotal - total;
    const confirmed = args?.['confirmedTotalMinor'];
    if (typeof confirmed === 'number' && confirmed !== total) fail('SALE_PRICE_CHANGED');

    const limitPct = Number(appearance.discountLimitPct ?? '5');
    if (totalDiscount > 0 && totalDiscount * 100 > grossSubtotal * limitPct) {
      if (!ownerApprovalHolds()) fail('OWNER_APPROVAL_REQUIRED');
      approvedOnce = false;
    }

    const rawCustomerId = str(args, 'customerId').trim() || null;
    const linkedCustomer =
      rawCustomerId === null
        ? null
        : (customers.find((c) => c.id === rawCustomerId) ?? fail('CUSTOMER_NOT_FOUND'));
    if (linkedCustomer && linkedCustomer.archived) fail('CUSTOMER_IS_ARCHIVED');

    const rawPayments = Array.isArray(args?.['payments'])
      ? (args['payments'] as {
          method: string;
          amountMinor: number;
          reference?: string | null;
        }[])
      : [{ method: 'cash', amountMinor: total, reference: null }];
    if (rawPayments.length === 0) fail('SALE_PAYMENT_MISSING');

    const enabledSet = new Set(
      appearance.payMethods.split(',').map((s) => s.trim())
    );
    enabledSet.add('cash');
    let paySum = 0;
    let creditSum = 0;
    const cleanPayments: {
      method: string;
      amountMinor: number;
      reference: string | null;
      walletId: string | null;
    }[] = [];
    for (const p of rawPayments) {
      const m = (p.method ?? '').trim();
      if (!['cash', 'vf', 'instapay', 'card', 'install', 'credit'].includes(m)) {
        fail('SALE_PAYMENT_METHOD_INVALID');
      }
      if (!enabledSet.has(m)) fail('SALE_PAYMENT_METHOD_DISABLED');
      if (total > 0 && !(p.amountMinor > 0)) fail('SALE_PAYMENT_AMOUNT_INVALID');
      const ref = typeof p.reference === 'string' && p.reference.trim() !== '' ? p.reference.trim() : null;
      if (m === 'install' && ref === null) fail('SALE_INSTALLMENT_PROVIDER_REQUIRED');
      if (m === 'credit' && linkedCustomer === null) fail('SALE_CREDIT_REQUIRES_CUSTOMER');
      paySum += p.amountMinor;
      if (m === 'credit') creditSum += p.amountMinor;
      cleanPayments.push({
        method: m,
        amountMinor: p.amountMinor,
        reference: ref,
        walletId: demoResolvePaymentWalletId(
          m,
          walletIdArg(p as Record<string, unknown>, 'walletId'),
          'SALE_PAYMENT_WALLET_INVALID'
        ),
      });
    }
    if (paySum !== total) fail('SALE_PAYMENT_TOTAL_MISMATCH');

    let cost = 0;
    const saleLines: DemoSaleLine[] = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx]!;
      const x = findProduct(line.productId);
      const rawImei = typeof line.imei === 'string' && line.imei.trim() !== '' ? demoNormalizeImei(line.imei) : null;
      const inStockUnits = productUnits
        .filter((u) => u.productId === x.id && u.status === 'in_stock')
        .sort((a, b) => a.createdAt - b.createdAt);
      const unitsCost = inStockUnits.reduce((s, u) => s + u.unitCostMinor, 0);
      const unregQty = Math.max(0, x.onHand - inStockUnits.length);
      const unregCost = Math.max(0, x.totalCostMinor - unitsCost);

      let lineCostTotal = 0;
      let linkedUnitId: string | null = null;
      if (rawImei !== null) {
        const existing = productUnits.find((u) => u.imei === rawImei || u.imei2 === rawImei);
        if (existing) {
          if (existing.productId !== x.id || existing.status !== 'in_stock') fail('IMEI_UNIT_NOT_AVAILABLE');
          existing.status = 'sold';
          linkedUnitId = existing.id;
          const removed = Math.min(x.totalCostMinor, existing.unitCostMinor);
          x.totalCostMinor -= removed;
          x.onHand -= 1;
          x.soldRecently += 1;
          cost += removed;
          lineCostTotal = removed;
        } else {
          if (unregQty < 1) fail('IMEI_NO_UNREGISTERED_STOCK');
          const removed = Math.ceil(unregCost / Math.max(1, unregQty));
          const createdUnit: DemoUnit = {
            id: newId('u'),
            productId: x.id,
            imei: rawImei,
            imei2: null,
            color: null,
            unitCostMinor: removed,
            status: 'sold',
            createdAt: now(),
          };
          productUnits.push(createdUnit);
          linkedUnitId = createdUnit.id;
          x.totalCostMinor -= removed;
          x.onHand -= 1;
          x.soldRecently += 1;
          cost += removed;
          lineCostTotal = removed;
        }
      } else {
        if (line.quantity <= unregQty) {
          const removed = Math.ceil((unregCost * line.quantity) / Math.max(1, unregQty));
          x.totalCostMinor -= removed;
          x.onHand -= line.quantity;
          x.soldRecently += line.quantity;
          cost += removed;
          lineCostTotal = removed;
        } else {
          const overflow = line.quantity - unregQty;
          const retired = inStockUnits.slice(0, overflow);
          let removed = unregCost;
          for (const u of retired) {
            u.status = 'retired';
            removed += u.unitCostMinor;
          }
          removed = Math.min(x.totalCostMinor, removed);
          x.totalCostMinor -= removed;
          x.onHand -= line.quantity;
          x.soldRecently += line.quantity;
          cost += removed;
          lineCostTotal = removed;
        }
      }
      const unitPrice = x.salePriceMinor ?? 0;
      const lineDisc = typeof line.discountMinor === 'number' ? line.discountMinor : 0;
      const lineTotal = unitPrice * line.quantity - lineDisc;
      const unitCostSnap = Math.floor((lineCostTotal + line.quantity / 2) / line.quantity);
      saleLines.push({
        id: newId('sl'),
        lineNo: idx + 1,
        productId: x.id,
        productName: x.name,
        quantity: line.quantity,
        unitSellingPriceMinor: unitPrice,
        discountMinor: lineDisc,
        lineTotalMinor: lineTotal,
        unitCostMinor: unitCostSnap,
        lineCostTotalMinor: lineCostTotal,
        imei: rawImei,
        unitId: linkedUnitId,
        warrantyStart: typeof line.warrantyStart === 'string' && line.warrantyStart !== '' ? line.warrantyStart : null,
        warrantyEnd: typeof line.warrantyEnd === 'string' && line.warrantyEnd !== '' ? line.warrantyEnd : null,
      });
    }
    const origSalesCount = sales.filter((s) => s.kind === 'sale').length;
    const reference = `${settings.invoicePrefix}-${today()}-${String(origSalesCount + 1).padStart(4, '0')}`;
    const sale: DemoSale = {
      id: newId('s'),
      kind: 'sale',
      reversesSaleId: null,
      reference,
      soldBy: current?.id ?? 'u-peter',
      linesSubtotalMinor: linesNetSubtotal,
      invoiceDiscountMinor: invoiceDisc,
      totalMinor: total,
      costTotalMinor: cost,
      discountMinor: totalDiscount,
      customerId: linkedCustomer ? linkedCustomer.id : null,
      isCancelled: false,
      occurredAt: now(),
      payments: cleanPayments,
      lines: saleLines,
    };
    sales.push(sale);
    if (typeof window !== 'undefined') {
      (window as unknown as { __lastDemoSale?: typeof sale }).__lastDemoSale = sale;
    }
    if (linkedCustomer && creditSum > 0) {
      linkedCustomer.balanceMinor += creditSum;
      customerLedger.unshift({
        id: newId('cl'),
        customerId: linkedCustomer.id,
        kind: 'credit_sale',
        amountMinor: creditSum,
        method: null,
        saleId: sale.id,
        note: `فاتورة ${reference}`,
        occurredAt: now(),
      });
    }
    return { saleId: sale.id, reference, totalMinor: total, costTotalMinor: cost };
  },
  cancel_sale: (args) => {
    const user = requireManager(false);
    if (!ownerApprovalHolds()) fail('OWNER_APPROVAL_REQUIRED');
    approvedOnce = false;

    const saleId = str(args, 'saleId').trim();
    const reason = str(args, 'reason').trim();
    if (!reason) fail('SALE_REVERSAL_REASON_REQUIRED');
    const orig =
      sales.find((s) => s.id === saleId && s.kind === 'sale') ?? fail('SALE_NOT_FOUND');
    if (orig.isCancelled) fail('SALE_ALREADY_CANCELLED');

    orig.isCancelled = true;
    for (const l of orig.lines) {
      const prod = products.find((p) => p.id === l.productId);
      if (prod) {
        prod.onHand += l.quantity;
        prod.totalCostMinor += l.lineCostTotalMinor;
      }
      if (l.unitId) {
        const u = productUnits.find((x) => x.id === l.unitId);
        if (u) u.status = 'in_stock';
      }
    }

    const revRef = `${orig.reference}-REV`;
    const reversalSale: DemoSale = {
      id: newId('s'),
      kind: 'reversal',
      reversesSaleId: orig.id,
      reference: revRef,
      soldBy: user.id,
      linesSubtotalMinor: orig.linesSubtotalMinor,
      invoiceDiscountMinor: orig.invoiceDiscountMinor,
      totalMinor: orig.totalMinor,
      costTotalMinor: orig.costTotalMinor,
      discountMinor: orig.discountMinor,
      customerId: orig.customerId,
      isCancelled: false,
      occurredAt: now(),
      payments: orig.payments.map((p) => ({ ...p })),
      lines: orig.lines.map((l) => ({ ...l })),
    };
    sales.push(reversalSale);

    const creditTotal = orig.payments
      .filter((p) => p.method === 'credit')
      .reduce((sum, p) => sum + p.amountMinor, 0);
    if (creditTotal > 0 && orig.customerId) {
      const cust = customers.find((c) => c.id === orig.customerId);
      if (cust) {
        cust.balanceMinor -= creditTotal;
        customerLedger.unshift({
          id: newId('cl'),
          customerId: cust.id,
          kind: 'sale_reversal',
          amountMinor: -creditTotal,
          method: 'credit',
          saleId: reversalSale.id,
          note: `إلغاء فاتورة ${orig.reference}: ${reason}`,
          occurredAt: reversalSale.occurredAt,
        });
      }
    }

    return {
      saleId: reversalSale.id,
      reference: revRef,
      totalMinor: orig.totalMinor,
      costTotalMinor: orig.costTotalMinor,
    };
  },
  list_sales_history: (args) => {
    const user = requireUser();
    const isManager = user.role === 'manager';
    const canSeeCost = isManager;
    const limit = Math.min(25_000, Math.max(1, numArg(args, 'limit') || 500));

    const combined = [...demoHistoricalSales, ...sales];
    const filtered = combined
      .filter(
        (s) =>
          s.kind === 'sale' &&
          (isManager || (s.soldBy ?? 'u-peter') === user.id)
      )
      .slice(-limit);

    return filtered.map((s) => {
      const sellerId = s.soldBy ?? 'u-peter';
      const sellerUser = users.find((u) => u.id === sellerId);
      const cust = s.customerId
        ? (customers.find((c) => c.id === s.customerId) ?? null)
        : null;
      const prevReturns = demoSaleReturns.filter((r) => r.originalSaleId === s.id);
      const alreadyRefundedMinor = s.isCancelled
        ? s.totalMinor
        : prevReturns.reduce((sum, r) => sum + r.refundMinor, 0);

      const lineDtos = s.lines.map((l) => {
        const prod = products.find((p) => p.id === l.productId);
        const catId = prod?.categoryId ?? null;
        const catObj = catId ? (categories.find((c) => c.id === catId) ?? null) : null;
        return {
          lineId: l.id,
          lineNo: l.lineNo,
          productId: l.productId,
          productName: l.productName,
          categoryId: catId,
          categoryName: catObj ? catObj.name : null,
          parentCategoryId: catObj ? catObj.parentId : null,
          quantity: l.quantity,
          unitSellingPriceMinor: l.unitSellingPriceMinor,
          discountMinor: l.discountMinor,
          lineTotalMinor: l.lineTotalMinor,
          ...(canSeeCost
            ? {
                unitCostMinor: l.unitCostMinor,
                lineCostMinor: l.lineCostTotalMinor,
                lineProfitMinor: l.lineTotalMinor - l.lineCostTotalMinor,
              }
            : {}),
          warrantyStart: l.warrantyStart,
          warrantyEnd: l.warrantyEnd,
          unitId: l.unitId,
          imei: l.imei,
        };
      });

      return {
        saleId: s.id,
        reference: s.reference,
        occurredAt: s.occurredAt,
        soldBy: sellerId,
        sellerName: sellerUser ? sellerUser.displayName : sellerId,
        customerId: s.customerId,
        customerName: cust ? cust.name : null,
        customerPhone: cust ? cust.contact : null,
        linesSubtotalMinor: s.linesSubtotalMinor,
        discountMinor: s.discountMinor,
        totalMinor: s.totalMinor,
        ...(canSeeCost
          ? {
              costTotalMinor: s.costTotalMinor,
              profitMinor: s.totalMinor - s.costTotalMinor,
            }
          : {}),
        alreadyRefundedMinor,
        isCancelled: s.isCancelled,
        lines: lineDtos,
        payments: s.payments.map((p) => ({
          method: p.method,
          amountMinor: p.amountMinor,
          reference: p.reference,
        })),
      };
    });
  },
  set_sale_customer_name: (args) => {
    requireUser();
    if (!sales.some((s) => s.id === str(args, 'saleId'))) fail('SALE_NOT_FOUND');
  },
  inspect_sale_for_return: (args) => {
    const user = requireUser();
    const canViewCost = user.role === 'manager';
    const query = str(args, 'saleIdOrReference').trim();
    const orig =
      sales.find(
        (s) =>
          s.kind === 'sale' &&
          (s.id === query || s.reference.toLowerCase() === query.toLowerCase())
      ) ?? fail('SALE_NOT_FOUND');

    const prevReturns = demoSaleReturns.filter((r) => r.originalSaleId === orig.id);
    const alreadyRefundedMinor = orig.isCancelled
      ? orig.totalMinor
      : prevReturns.reduce((sum, r) => sum + r.refundMinor, 0);
    const remainingRefundableMinor = Math.max(0, orig.totalMinor - alreadyRefundedMinor);

    const cust = orig.customerId
      ? (customers.find((c) => c.id === orig.customerId) ?? null)
      : null;

    const lineViews = orig.lines.map((l) => {
      let alreadyReturnedQty = 0;
      if (orig.isCancelled) {
        alreadyReturnedQty = l.quantity;
      } else {
        for (const r of prevReturns) {
          for (const rl of r.lines) {
            if (rl.saleLineId === l.id) alreadyReturnedQty += rl.quantity;
          }
        }
      }
      const remainingQty = Math.max(0, l.quantity - alreadyReturnedQty);
      return {
        lineId: l.id,
        lineNo: l.lineNo,
        productId: l.productId,
        productName: l.productName,
        quantity: l.quantity,
        alreadyReturnedQty,
        remainingQty,
        unitSellingPriceMinor: l.unitSellingPriceMinor,
        discountMinor: l.discountMinor,
        lineTotalMinor: l.lineTotalMinor,
        ...(canViewCost
          ? {
              unitCostMinor: l.unitCostMinor,
              lineCostTotalMinor: l.lineCostTotalMinor,
            }
          : {}),
        imei: l.imei,
        unitId: l.unitId,
        warrantyStart: l.warrantyStart,
        warrantyEnd: l.warrantyEnd,
      };
    });

    return {
      saleId: orig.id,
      reference: orig.reference,
      occurredAt: orig.occurredAt,
      soldBy: 'u-peter',
      customerId: orig.customerId,
      customerName: cust ? cust.name : null,
      customerPhone: cust ? cust.contact : null,
      linesSubtotalMinor: orig.linesSubtotalMinor,
      invoiceDiscountMinor: orig.invoiceDiscountMinor,
      discountMinor: orig.discountMinor,
      totalMinor: orig.totalMinor,
      alreadyRefundedMinor,
      remainingRefundableMinor,
      isCancelled: orig.isCancelled,
      lines: lineViews,
      payments: orig.payments.map((p) => ({
        ...p,
        alreadyRefundedMinor: 0,
        remainingMinor: p.amountMinor,
      })),
      returns: prevReturns.map((r) => ({
        id: r.id,
        originalSaleId: r.originalSaleId,
        returnSaleId: r.reversalSaleId,
        reversalSaleId: r.reversalSaleId,
        returnReference: r.returnReference,
        exchangeSaleId: r.exchangeSaleId,
        exchangeReference: r.exchangeReference,
        refundMinor: r.refundMinor,
        ...(canViewCost
          ? {
              costReversedMinor: r.costReversedMinor,
              damagedCostMinor: r.damagedCostMinor,
            }
          : {}),
        reason: r.reason,
        actorId: r.actorId,
        approvedBy: r.approvedBy,
        occurredAt: r.occurredAt,
      })),
    };
  },
  list_recent_sales_for_return: (args) => {
    requireUser();
    const q = str(args, 'query').trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, numArg(args, 'limit') || 20));
    const origSales = sales
      .filter((s) => s.kind === 'sale')
      .sort((a, b) => b.occurredAt - a.occurredAt);
    const out = [];
    for (const s of origSales) {
      const cust = s.customerId
        ? (customers.find((c) => c.id === s.customerId) ?? null)
        : null;
      const firstProductName = s.lines[0]?.productName ?? 'فاتورة';
      if (q) {
        const hitRef = s.reference.toLowerCase().includes(q);
        const hitCust = (cust?.name ?? '').toLowerCase().includes(q);
        const hitProd = s.lines.some(
          (l) =>
            l.productName.toLowerCase().includes(q) ||
            (l.imei ?? '').toLowerCase().includes(q)
        );
        if (!hitRef && !hitCust && !hitProd) continue;
      }
      const prevReturns = demoSaleReturns.filter((r) => r.originalSaleId === s.id);
      const alreadyRefundedMinor = s.isCancelled
        ? s.totalMinor
        : prevReturns.reduce((sum, r) => sum + r.refundMinor, 0);
      out.push({
        saleId: s.id,
        reference: s.reference,
        occurredAt: s.occurredAt,
        customerId: s.customerId,
        customerName: cust ? cust.name : null,
        totalMinor: s.totalMinor,
        alreadyRefundedMinor,
        isCancelled: s.isCancelled,
        lineCount: s.lines.length,
        firstProductName,
      });
      if (out.length >= limit) break;
    }
    return out;
  },
  record_sale_return: (args) => {
    const user = requireUser();
    if (!ownerApprovalHolds()) fail('OWNER_APPROVAL_REQUIRED');
    approvedOnce = false;

    const saleId = (str(args, 'originalSaleId') || str(args, 'saleId')).trim();
    const orig =
      sales.find((s) => s.id === saleId && s.kind === 'sale') ?? fail('SALE_NOT_FOUND');
    if (orig.isCancelled) fail('SALE_ALREADY_CANCELLED');

    const reason = str(args, 'reason').trim();
    if (!reason || reason.length > 240) fail('SALE_RETURN_REASON_REQUIRED');

    const rawLines = Array.isArray(args?.['returnLines'])
      ? (args['returnLines'] as {
          saleLineId: string;
          quantity: number;
          condition: string;
        }[])
      : Array.isArray(args?.['lines'])
        ? (args['lines'] as {
            saleLineId: string;
            quantity: number;
            condition: string;
          }[])
        : [];
    if (rawLines.length === 0) fail('SALE_RETURN_EMPTY');

    const prevReturns = demoSaleReturns.filter((r) => r.originalSaleId === orig.id);
    const alreadyRefundedMinor = prevReturns.reduce((sum, r) => sum + r.refundMinor, 0);
    const remainingInvoiceRefundable = Math.max(0, orig.totalMinor - alreadyRefundedMinor);

    const seenLineIds = new Set<string>();
    const plans: {
      origLine: DemoSaleLine;
      returnQty: number;
      condition: 'intact' | 'damaged';
      discountShareMinor: number;
      lineTotalMinor: number;
      unitCostMinor: number;
      lineCostTotalMinor: number;
    }[] = [];

    for (const rl of rawLines) {
      if (seenLineIds.has(rl.saleLineId)) fail('SALE_RETURN_DUPLICATE_LINE');
      seenLineIds.add(rl.saleLineId);
      if (rl.condition !== 'intact' && rl.condition !== 'damaged') {
        fail('SALE_RETURN_CONDITION_INVALID');
      }
      if (!Number.isInteger(rl.quantity) || rl.quantity <= 0) {
        fail('SALE_RETURN_QUANTITY_EXCEEDS_REMAINING');
      }
      const origLine =
        orig.lines.find((l) => l.id === rl.saleLineId) ?? fail('SALE_RETURN_LINE_NOT_FOUND');
      let alreadyReturnedQty = 0;
      for (const r of prevReturns) {
        for (const rLine of r.lines) {
          if (rLine.saleLineId === origLine.id) alreadyReturnedQty += rLine.quantity;
        }
      }
      const remainingQty = Math.max(0, origLine.quantity - alreadyReturnedQty);
      if (rl.quantity > remainingQty) fail('SALE_RETURN_QUANTITY_EXCEEDS_REMAINING');

      const grossReturnMinor = rl.quantity * origLine.unitSellingPriceMinor;
      const discountShareMinor =
        rl.quantity === origLine.quantity
          ? origLine.discountMinor
          : Math.round((origLine.discountMinor * rl.quantity) / origLine.quantity);
      const lineTotalMinor = Math.max(0, grossReturnMinor - discountShareMinor);
      const lineCostTotalMinor =
        rl.quantity === origLine.quantity
          ? origLine.lineCostTotalMinor
          : Math.round((origLine.lineCostTotalMinor * rl.quantity) / origLine.quantity);
      const unitCostMinor = Math.floor(
        (lineCostTotalMinor + rl.quantity / 2) / rl.quantity
      );

      plans.push({
        origLine,
        returnQty: rl.quantity,
        condition: rl.condition === 'damaged' ? 'damaged' : 'intact',
        discountShareMinor,
        lineTotalMinor,
        unitCostMinor,
        lineCostTotalMinor,
      });
    }

    const linesNetReturnMinor = plans.reduce((sum, p) => sum + p.lineTotalMinor, 0);
    let refundMinor = linesNetReturnMinor;
    if (orig.invoiceDiscountMinor > 0 && orig.linesSubtotalMinor > 0) {
      const invDiscShare = Math.round(
        (orig.invoiceDiscountMinor * linesNetReturnMinor) / orig.linesSubtotalMinor
      );
      refundMinor = Math.max(0, linesNetReturnMinor - invDiscShare);
    }
    refundMinor = Math.min(refundMinor, remainingInvoiceRefundable);

    // Allocate refund payments
    const rawRefundPayments = Array.isArray(args?.['refundPayments'])
      ? (args['refundPayments'] as {
          method: string;
          amountMinor: number;
          reference?: string | null;
        }[])
      : null;

    let cleanRefundPayments: {
      method: string;
      amountMinor: number;
      reference: string | null;
      walletId: string | null;
    }[] = [];
    if (rawRefundPayments && rawRefundPayments.length > 0) {
      let sum = 0;
      for (const p of rawRefundPayments) {
        sum += p.amountMinor;
        cleanRefundPayments.push({
          method: p.method,
          amountMinor: p.amountMinor,
          reference: p.reference ?? null,
          walletId: demoResolvePaymentWalletId(
            p.method,
            walletIdArg(p as Record<string, unknown>, 'walletId'),
            'SALE_PAYMENT_WALLET_INVALID'
          ),
        });
      }
      if (sum !== refundMinor) fail('SALE_PAYMENT_TOTAL_MISMATCH');
    } else if (refundMinor > 0) {
      let remaining = refundMinor;
      for (const p of orig.payments) {
        if (remaining <= 0) break;
        const take = Math.min(remaining, p.amountMinor);
        if (take > 0) {
          cleanRefundPayments.push({
            method: p.method,
            amountMinor: take,
            reference: p.reference,
            walletId: p.walletId ?? demoSalePayeeWalletId(p.method),
          });
          remaining -= take;
        }
      }
      if (remaining > 0) {
        cleanRefundPayments.push({
          method: 'cash',
          amountMinor: remaining,
          reference: null,
          walletId: null,
        });
      }
    } else {
      cleanRefundPayments = [
        { method: 'cash', amountMinor: 0, reference: null, walletId: null },
      ];
    }

    const occurredAt = now();
    const returnReference = `${orig.reference}-RET-${prevReturns.length + 1}`;
    let costReversedMinor = 0;
    let damagedCostMinor = 0;
    const reversalLines: DemoSaleLine[] = [];

    for (let idx = 0; idx < plans.length; idx++) {
      const plan = plans[idx]!;
      const prod = findProduct(plan.origLine.productId);
      if (plan.condition === 'intact') {
        prod.onHand += plan.returnQty;
        prod.totalCostMinor += plan.lineCostTotalMinor;
        if (plan.origLine.unitId) {
          const u = productUnits.find((x) => x.id === plan.origLine.unitId);
          if (u) u.status = 'in_stock';
        }
        costReversedMinor += plan.lineCostTotalMinor;
      } else {
        damagedCostMinor += plan.lineCostTotalMinor;
        if (plan.origLine.unitId) {
          const u = productUnits.find((x) => x.id === plan.origLine.unitId);
          if (u) u.status = 'retired';
        }
      }
      reversalLines.push({
        id: newId('sl'),
        lineNo: idx + 1,
        productId: plan.origLine.productId,
        productName: plan.origLine.productName,
        quantity: plan.returnQty,
        unitSellingPriceMinor: plan.origLine.unitSellingPriceMinor,
        discountMinor: plan.discountShareMinor,
        lineTotalMinor: plan.lineTotalMinor,
        unitCostMinor: plan.unitCostMinor,
        lineCostTotalMinor:
          plan.condition === 'intact' ? plan.lineCostTotalMinor : 0,
        imei: plan.origLine.imei,
        unitId: plan.origLine.unitId,
        warrantyStart: plan.origLine.warrantyStart,
        warrantyEnd: plan.origLine.warrantyEnd,
      });
    }

    const reversalSale: DemoSale = {
      id: newId('s'),
      kind: 'reversal',
      reversesSaleId: orig.id,
      reference: returnReference,
      linesSubtotalMinor: linesNetReturnMinor,
      invoiceDiscountMinor: Math.max(0, linesNetReturnMinor - refundMinor),
      totalMinor: refundMinor,
      costTotalMinor: costReversedMinor,
      discountMinor: 0,
      customerId: orig.customerId,
      isCancelled: false,
      occurredAt,
      payments: cleanRefundPayments,
      lines: reversalLines,
    };
    sales.push(reversalSale);

    // If credit was refunded on a customer, reduce customer balance
    const creditRefund = cleanRefundPayments
      .filter((p) => p.method === 'credit')
      .reduce((sum, p) => sum + p.amountMinor, 0);
    if (creditRefund > 0 && orig.customerId) {
      const cust = customers.find((c) => c.id === orig.customerId);
      if (cust) {
        cust.balanceMinor -= creditRefund;
        customerLedger.unshift({
          id: newId('cl'),
          customerId: cust.id,
          kind: 'sale_reversal',
          amountMinor: -creditRefund,
          method: 'credit',
          saleId: reversalSale.id,
          note: `مرتجع فاتورة ${orig.reference}: ${reason}`,
          occurredAt,
        });
      }
    }

    const returnId = newId('ret');
    demoSaleReturns.push({
      id: returnId,
      originalSaleId: orig.id,
      reversalSaleId: reversalSale.id,
      returnReference,
      exchangeSaleId: null,
      exchangeReference: null,
      refundMinor,
      costReversedMinor,
      damagedCostMinor,
      reason,
      actorId: user.id,
      approvedBy: 'u-peter',
      occurredAt,
      lines: plans.map((p) => ({
        saleLineId: p.origLine.id,
        quantity: p.returnQty,
        condition: p.condition,
        refundMinor: p.lineTotalMinor,
        unitCostMinor: p.unitCostMinor,
        lineCostTotalMinor: p.lineCostTotalMinor,
      })),
    });

    for (const plan of plans) {
      if (plan.condition === 'damaged') {
        demoDamagedStock.unshift({
          id: newId('dmg'),
          saleReturnId: returnId,
          returnReference,
          originalSaleId: orig.id,
          saleReference: orig.reference,
          saleLineId: plan.origLine.id,
          productId: plan.origLine.productId,
          productName: plan.origLine.productName,
          unitId: plan.origLine.unitId,
          imei: plan.origLine.imei,
          quantity: plan.returnQty,
          unitCostMinor: plan.unitCostMinor,
          totalCostMinor: plan.lineCostTotalMinor,
          reason,
          actorId: user.id,
          approvedBy: 'u-peter',
          occurredAt,
        });
      }
    }

    // Check if all lines are now returned
    const allReturned = orig.lines.every((l) => {
      let retQty = 0;
      for (const r of demoSaleReturns.filter((x) => x.originalSaleId === orig.id)) {
        for (const rl of r.lines) {
          if (rl.saleLineId === l.id) retQty += rl.quantity;
        }
      }
      return retQty >= l.quantity;
    });
    if (allReturned) {
      orig.isCancelled = true;
    }

    const canViewCost = user.role === 'manager';
    return {
      returnId,
      reversalSaleId: reversalSale.id,
      returnReference,
      originalSaleId: orig.id,
      refundMinor,
      ...(canViewCost
        ? {
            costReversedMinor,
            damagedCostMinor,
          }
        : {}),
      exchangeSaleId: null,
    };
  },
  record_sale_exchange: (args) => {
    requireUser();
    if (!ownerApprovalHolds()) fail('OWNER_APPROVAL_REQUIRED');
    // Keep approvedOnce = true for the inner record_sale_return call, and also allow any discount in the new sale
    const returnOutcome = handlers['record_sale_return']!({
      saleId: args?.['originalSaleId'],
      lines: args?.['returnLines'],
      reason: args?.['reason'],
      refundPayments: args?.['refundPayments'],
    }) as {
      returnId: string;
      reversalSaleId: string;
      returnReference: string;
      originalSaleId: string;
      refundMinor: number;
      costReversedMinor?: number;
      damagedCostMinor?: number;
      exchangeSaleId: string | null;
    };

    approvedOnce = true;
    const saleOutcome = handlers['record_sale']!({
      lines: args?.['newLines'],
      invoiceDiscountMinor: args?.['newInvoiceDiscountMinor'] ?? 0,
      payments: args?.['newPayments'],
      customerId: args?.['customerId'],
    }) as {
      saleId: string;
      reference: string;
      totalMinor: number;
      costTotalMinor?: number;
    };
    approvedOnce = false;

    const retRow = demoSaleReturns.find((r) => r.id === returnOutcome.returnId);
    if (retRow) {
      retRow.exchangeSaleId = saleOutcome.saleId;
      retRow.exchangeReference = saleOutcome.reference;
    }
    returnOutcome.exchangeSaleId = saleOutcome.saleId;

    return {
      returnOutcome,
      saleOutcome,
      netDifferenceMinor: saleOutcome.totalMinor - returnOutcome.refundMinor,
    };
  },
  list_damaged_stock: (args) => {
    const user = requireUser();
    const canViewCost = user.role === 'manager';
    const limit = Math.min(200, Math.max(1, numArg(args, 'limit') || 100));
    return demoDamagedStock.slice(0, limit).map((d) => ({
      id: d.id,
      saleReturnId: d.saleReturnId,
      returnReference: d.returnReference,
      originalSaleId: d.originalSaleId,
      saleReference: d.saleReference,
      saleLineId: d.saleLineId,
      productId: d.productId,
      productName: d.productName,
      unitId: d.unitId,
      imei: d.imei,
      quantity: d.quantity,
      ...(canViewCost
        ? {
            unitCostMinor: d.unitCostMinor,
            totalCostMinor: d.totalCostMinor,
          }
        : {}),
      reason: d.reason,
      actorId: d.actorId,
      approvedBy: d.approvedBy,
      occurredAt: d.occurredAt,
    }));
  },

  // the store panels
  list_products: (args) => {
    requireManager();
    const status = str(args, 'status') || 'active';
    return products.filter((x) => x.status === status).map(productDto);
  },
  get_product: (args) => productDto(findProduct(str(args, 'id'))),
  create_product: (args) => {
    requireManager();
    const name = str(args, 'name').trim();
    if (name === '') fail('PRODUCT_NAME_REQUIRED');
    const barcode = str(args, 'barcode').trim() || null;
    if (barcode !== null && products.some((x) => x.barcode === barcode)) fail('BARCODE_ALREADY_EXISTS');
    const price = args?.['salePriceMinor'];
    if (typeof price === 'number' && price < 0) fail('PRICE_NEGATIVE');
    const x: DemoProduct = {
      id: newId('p'),
      name,
      disposition: (str(args, 'disposition') || 'quantity') as DemoProduct['disposition'],
      barcode,
      salePriceMinor: typeof price === 'number' ? price : null,
      categoryId: categoryOf(args),
      brandId: null,
      model: null,
      deviceType: null,
      storageGb: null,
      ramGb: null,
      onHand: 0,
      totalCostMinor: 0,
      soldRecently: 0,
      status: 'active',
    };
    products.push(x);
    return productDto(x);
  },
  next_shop_code: () => {
    requireManager();
    return nextShopCode();
  },
  next_shop_codes: (args) => {
    requireManager();
    const count = typeof args?.['count'] === 'number' ? (args['count'] as number) : 0;
    const reserved = Array.isArray(args?.['reserved'])
      ? (args['reserved'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
    return nextShopCodes(count, reserved);
  },
  create_variants: (args) => {
    requireManager();
    const category = categories.find((c) => c.id === str(args, 'categoryId')) ?? fail('PRODUCT_CATEGORY_NOT_FOUND');
    if (category.kind !== 'item') fail('VARIANT_CATEGORY_NOT_ITEM');
    const baseName = str(args, 'name').trim().split(/\s+/).filter(Boolean).join(' ');
    if (baseName === '') fail('PRODUCT_NAME_REQUIRED');
    if (
      variantParents.some(
        (vp) => vp.categoryId === category.id && vp.name.toLowerCase() === baseName.toLowerCase(),
      )
    ) {
      fail('VARIANT_PARENT_ALREADY_EXISTS');
    }
    const dim1 = str(args, 'dimension1').trim();
    if (!VARIANT_DIMS.includes(dim1)) fail('VARIANT_DIMENSION_UNKNOWN');
    const rawVals1 = Array.isArray(args?.['values1']) ? (args['values1'] as unknown[]) : [];
    const vals1 = rawVals1
      .map((v) => String(v ?? '').trim().split(/\s+/).filter(Boolean).join(' '))
      .filter((v) => v !== '');
    if (vals1.length === 0) fail('VARIANT_VALUES_REQUIRED');
    if (new Set(vals1.map((v) => v.toLowerCase())).size !== vals1.length) fail('VARIANT_VALUE_DUPLICATE');

    const rawVals2 = Array.isArray(args?.['values2']) ? (args['values2'] as unknown[]) : [];
    const vals2 = rawVals2
      .map((v) => String(v ?? '').trim().split(/\s+/).filter(Boolean).join(' '))
      .filter((v) => v !== '');
    if (new Set(vals2.map((v) => v.toLowerCase())).size !== vals2.length) fail('VARIANT_VALUE_DUPLICATE');
    const dim2 = vals2.length > 0 ? str(args, 'dimension2').trim() : null;
    if (dim2 !== null && !VARIANT_DIMS.includes(dim2)) fail('VARIANT_DIMENSION_UNKNOWN');

    const combos: [string, string | null][] =
      vals2.length === 0
        ? vals1.map((v1) => [v1, null])
        : vals1.flatMap((v1) => vals2.map((v2): [string, string | null] => [v1, v2]));
    if (combos.length > 60) fail('VARIANT_LIMIT_EXCEEDED');

    const defaultPrice = numArg(args, 'salePriceMinor');
    if (defaultPrice < 0) fail('PRICE_NEGATIVE');
    if (defaultPrice === 0) fail('VARIANT_PRICE_REQUIRED');

    const rawRows = Array.isArray(args?.['rows'])
      ? (args['rows'] as { barcode?: string | null; salePriceMinor?: number | null }[])
      : [];
    if (rawRows.length > 0 && rawRows.length !== combos.length) fail('VARIANT_ROWS_MISMATCH');

    const batchBarcodes = new Set<string>();
    const resolved = combos.map((_, i) => {
      const r = rawRows[i];
      const barcode = typeof r?.barcode === 'string' && r.barcode.trim() !== '' ? r.barcode.trim() : null;
      if (barcode !== null) {
        const key = barcode.toLowerCase();
        if (batchBarcodes.has(key)) fail('VARIANT_BARCODE_DUPLICATE');
        batchBarcodes.add(key);
        if (products.some((x) => (x.barcode ?? '').toLowerCase() === key)) fail('BARCODE_ALREADY_EXISTS');
      }
      const price = typeof r?.salePriceMinor === 'number' ? r.salePriceMinor : defaultPrice;
      if (price < 0) fail('PRICE_NEGATIVE');
      if (price === 0) fail('VARIANT_PRICE_REQUIRED');
      return { barcode, price };
    });

    const parent = {
      id: newId('vp'),
      name: baseName,
      categoryId: category.id,
      dimension1: dim1,
      dimension2: dim2,
    };
    variantParents.push(parent);

    const variants = combos.map(([v1, v2], order) => {
      const row = resolved[order]!;
      const title = [baseName, v1, v2 ?? ''].filter((part) => part !== '').join(' ');
      const item: DemoProduct = {
        id: newId('p'),
        name: title,
        disposition: 'quantity',
        barcode: row.barcode,
        salePriceMinor: row.price,
        categoryId: category.id,
        brandId: null,
        model: null,
        deviceType: null,
        storageGb: null,
        ramGb: null,
        parentId: parent.id,
        parentName: parent.name,
        dimension1: parent.dimension1,
        dimension2: parent.dimension2,
        variant1: v1,
        variant2: v2,
        variantOrder: order,
        onHand: 0,
        totalCostMinor: 0,
        soldRecently: 0,
        status: 'active',
      };
      products.push(item);
      return {
        product: productDto(item),
        parentId: parent.id,
        variant1: v1,
        variant2: v2,
        variantOrder: order,
      };
    });

    return { parent, variants };
  },
  list_product_images: () => {
    requireUser();
    return [...productImages.values()];
  },
  set_product_image: (args) => {
    requireManager();
    const productId = str(args, 'productId');
    const item = products.find((p) => p.id === productId) ?? fail('PRODUCT_NOT_FOUND');
    const dataUrl = str(args, 'dataUrl').trim();
    if (dataUrl === '') fail('IMAGE_EMPTY');
    if (!/^data:image\/jpe?g;base64,/i.test(dataUrl)) fail('IMAGE_NOT_JPEG');
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s+/g, '');
    if (b64.length === 0) fail('IMAGE_EMPTY');
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const bytes = Math.floor((b64.length * 3) / 4) - pad;
    if (bytes <= 0) fail('IMAGE_EMPTY');
    if (bytes > 65_536) fail('IMAGE_TOO_LARGE');
    const entry: DemoProductImage = {
      productId: item.id,
      file: `images/${item.id}.jpg`,
      w: 192,
      h: 192,
      bytes,
      dataUrl,
    };
    productImages.set(item.id, entry);
    return entry;
  },
  remove_product_image: (args) => {
    requireManager();
    const productId = str(args, 'productId');
    if (!productImages.has(productId)) fail('IMAGE_NOT_FOUND');
    productImages.delete(productId);
  },
  get_shop_logo: () => {
    requireUser();
    return shopLogoDataUrl;
  },
  set_shop_logo: (args) => {
    requireManager();
    const dataUrl = str(args, 'dataUrl').trim();
    if (dataUrl === '') fail('IMAGE_EMPTY');
    if (!/^data:image\/jpe?g;base64,/i.test(dataUrl)) fail('IMAGE_NOT_JPEG');
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1).replace(/\s+/g, '');
    if (b64.length === 0) fail('IMAGE_EMPTY');
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
    const bytes = Math.floor((b64.length * 3) / 4) - pad;
    if (bytes <= 0) fail('IMAGE_EMPTY');
    if (bytes > 65_536) fail('IMAGE_TOO_LARGE');
    shopLogoDataUrl = dataUrl;
    return dataUrl;
  },
  remove_shop_logo: () => {
    requireManager();
    shopLogoDataUrl = null;
  },


  update_product: (args) => {
    requireManager();
    const x = findProduct(str(args, 'id'));
    if (typeof args?.['name'] === 'string') x.name = str(args, 'name');
    if (typeof args?.['salePriceMinor'] === 'number') x.salePriceMinor = numArg(args, 'salePriceMinor');
    if (typeof args?.['barcode'] === 'string') x.barcode = str(args, 'barcode');
    return productDto(x);
  },
  set_product_category: (args) => {
    requireManager();
    const x = findProduct(str(args, 'id'));
    x.categoryId = categoryOf(args);
    return productDto(x);
  },
  set_product_archived: (args) => {
    requireManager();
    const x = findProduct(str(args, 'id'));
    x.status = args?.['archived'] === true ? 'archived' : 'active';
    return productDto(x);
  },
  find_product_by_barcode: (args) => {
    const x = products.find((y) => y.barcode === str(args, 'barcode'));
    return x === undefined ? fail('NO_PRODUCT_WITH_THIS_BARCODE') : productDto(x);
  },
  get_position: (args) => {
    requireManager(true);
    const x = findProduct(str(args, 'productId'));
    return { productId: x.id, quantity: x.onHand, totalCostMinor: x.totalCostMinor, effectiveCostMinor: x.totalCostMinor };
  },
  receive_stock: (args) => {
    requireManager();
    const x = findProduct(str(args, 'productId'));
    const quantity = numArg(args, 'quantity');
    const unitCost = numArg(args, 'unitCostMinor');
    const rawImeis = Array.isArray(args?.['imeis']) ? (args['imeis'] as string[]) : [];
    const tracking = x.tracking ?? (x.brandId !== null ? 'serial_optional' : 'none');
    if (rawImeis.length > 0 && tracking === 'none') fail('IMEI_PRODUCT_NOT_SERIAL_TRACKED');
    if (rawImeis.length > quantity) fail('IMEI_COUNT_EXCEEDS_QUANTITY');
    if (
      tracking !== 'none' &&
      (tracking === 'serial_required' || appearance.imeiMode === 'required') &&
      rawImeis.length !== quantity
    ) {
      fail('IMEI_REQUIRED_FOR_ALL_UNITS');
    }
    const seen = new Set<string>();
    const cleanImeis: string[] = [];
    for (const raw of rawImeis) {
      const digits = demoNormalizeImei(raw);
      if (!/^\d{15}$/.test(digits)) fail('IMEI_LENGTH_INVALID');
      if (!demoLuhn(digits)) fail('IMEI_CHECK_DIGIT_INVALID');
      if (seen.has(digits)) fail('IMEI_DUPLICATE_IN_BATCH');
      if (productUnits.some((u) => u.imei === digits || u.imei2 === digits)) fail('IMEI_ALREADY_REGISTERED');
      seen.add(digits);
      cleanImeis.push(digits);
    }
    for (const digits of cleanImeis) {
      productUnits.push({
        id: newId('u'),
        productId: x.id,
        imei: digits,
        imei2: null,
        color: null,
        unitCostMinor: unitCost,
        status: 'in_stock',
        createdAt: now(),
      });
    }
    x.onHand += quantity;
    x.totalCostMinor += quantity * unitCost;
    const resolvedAt = now();
    for (const sh of demoShortages) {
      if (sh.productId === x.id && sh.resolvedAt === null) {
        sh.resolvedAt = resolvedAt;
      }
    }
    return { productId: x.id, quantity: x.onHand, costMinor: 0 };
  },
  receive_opening_stock: (args) => {
    requireManager();
    if (!ownerApprovalHolds()) fail('OWNER_APPROVAL_REQUIRED');
    approvedOnce = false;
    return handlers['receive_stock']!(args);
  },
  list_product_units: (args) => {
    requireUser();
    const pid = str(args, 'productId');
    return productUnits
      .filter((u) => u.productId === pid && u.status === 'in_stock')
      .map((u) => ({
        id: u.id,
        productId: u.productId,
        imei: u.imei,
        imei2: u.imei2,
        color: u.color,
        unitCostMinor: u.unitCostMinor,
        conditionGrade: u.conditionGrade ?? null,
        batteryHealthPct: u.batteryHealthPct ?? null,
        accessories: u.accessories ?? null,
        intakeNote: u.intakeNote ?? null,
        sellerName: u.sellerName ?? null,
        sellerPhone: u.sellerPhone ?? null,
        sellerNationalId: u.sellerNationalId ?? null,
        createdAt: u.createdAt,
        status: u.status,
      }));
  },
  list_all_product_units: () => {
    requireManager();
    const activeIds = new Set(products.filter((p) => p.status === 'active').map((p) => p.id));
    return productUnits
      .filter((u) => u.status === 'in_stock' && activeIds.has(u.productId))
      .map((u) => ({
        id: u.id,
        productId: u.productId,
        imei: u.imei,
        imei2: u.imei2,
        color: u.color,
        unitCostMinor: u.unitCostMinor,
        conditionGrade: u.conditionGrade ?? null,
        batteryHealthPct: u.batteryHealthPct ?? null,
        accessories: u.accessories ?? null,
        intakeNote: u.intakeNote ?? null,
        sellerName: u.sellerName ?? null,
        sellerPhone: u.sellerPhone ?? null,
        sellerNationalId: u.sellerNationalId ?? null,
        createdAt: u.createdAt,
        status: u.status,
      }));
  },
  reconcile_stock_count: (args) => {
    requireManager();
    if (!ownerApprovalHolds()) fail('OWNER_APPROVAL_REQUIRED');
    approvedOnce = false;
    const rawItems = Array.isArray(args?.['items']) ? (args['items'] as Record<string, unknown>[]) : [];
    let adjustedProducts = 0;
    let retiredUnits = 0;
    let netQuantityDelta = 0;
    let netCostDeltaMinor = 0;

    for (const raw of rawItems) {
      const pid = typeof raw['productId'] === 'string' ? raw['productId'] : '';
      const x = findProduct(pid);
      const counted = Math.max(0, Math.round(Number(raw['countedQuantity'] ?? x.onHand)));
      const missingIds = Array.isArray(raw['missingUnitIds'])
        ? (raw['missingUnitIds'] as string[])
        : [];

      const inStockForProduct = productUnits.filter(
        (u) => u.productId === x.id && u.status === 'in_stock'
      );
      const explicitMissing = inStockForProduct.filter((u) => missingIds.includes(u.id));
      const effectiveCounted =
        explicitMissing.length > 0
          ? Math.min(counted, Math.max(0, x.onHand - explicitMissing.length))
          : counted;
      const qtyDelta = effectiveCounted - x.onHand;
      if (qtyDelta === 0 && explicitMissing.length === 0) continue;

      if (qtyDelta < 0) {
        const removeQty = -qtyDelta;
        let explicitCost = 0;
        for (const u of explicitMissing) {
          u.status = 'retired';
          explicitCost += u.unitCostMinor;
          retiredUnits += 1;
        }
        const remRemove = removeQty - explicitMissing.length;
        let extraCost = 0;
        if (remRemove > 0) {
          const onHandAfter = Math.max(1, x.onHand - explicitMissing.length);
          const costAfter = Math.max(0, x.totalCostMinor - explicitCost);
          extraCost = Math.ceil((costAfter * remRemove) / onHandAfter);
          const remainingInStock = productUnits.filter(
            (u) => u.productId === x.id && u.status === 'in_stock'
          );
          const unregQty = Math.max(0, x.onHand - explicitMissing.length - remainingInStock.length);
          if (remRemove > unregQty) {
            const overflow = remRemove - unregQty;
            for (const u of remainingInStock.slice(0, overflow)) {
              u.status = 'retired';
              retiredUnits += 1;
            }
          }
        }
        const totalRemovedCost = Math.min(x.totalCostMinor, explicitCost + extraCost);
        x.onHand = effectiveCounted;
        x.totalCostMinor = Math.max(0, x.totalCostMinor - totalRemovedCost);
        adjustedProducts += 1;
        netQuantityDelta -= removeQty;
        netCostDeltaMinor -= totalRemovedCost;
      } else if (qtyDelta > 0) {
        const addQty = qtyDelta;
        const fallbackCost =
          typeof raw['unitCostMinor'] === 'number' && raw['unitCostMinor'] > 0
            ? Math.round(raw['unitCostMinor'])
            : 0;
        const unitCost =
          x.onHand > 0 ? Math.ceil(x.totalCostMinor / x.onHand) : fallbackCost;
        const costAdded = addQty * unitCost;
        x.onHand = effectiveCounted;
        x.totalCostMinor += costAdded;
        const resolvedAt = now();
        for (const sh of demoShortages) {
          if (sh.productId === x.id && sh.resolvedAt === null) {
            sh.resolvedAt = resolvedAt;
          }
        }
        adjustedProducts += 1;
        netQuantityDelta += addQty;
        netCostDeltaMinor += costAdded;
      }
    }

    return {
      adjustedProducts,
      retiredUnits,
      netQuantityDelta,
      netCostDeltaMinor,
    };
  },
  remove_stock: (args) => {
    requireManager();
    const x = findProduct(str(args, 'productId'));
    const quantity = numArg(args, 'quantity');
    if (quantity > x.onHand) fail('COST_INSUFFICIENT_STOCK');
    const removed = Math.ceil((x.totalCostMinor * quantity) / Math.max(1, x.onHand));
    x.onHand -= quantity;
    x.totalCostMinor -= removed;
    return { productId: x.id, quantity: x.onHand, costMinor: removed };
  },
  // phone companies and a new phone (ADR-018 §2)
  list_brands: () => {
    requireManager();
    return [...brands]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((b) => {
        const all = products.filter((x) => x.brandId === b.id);
        return {
          ...brandDto(b),
          products: all.filter((x) => x.status === 'active').length,
          isDefault: b.isDefault,
          deletable: !b.isDefault && all.length === 0,
        };
      });
  },
  create_brand: (args) => {
    requireManager();
    const name = str(args, 'name').trim();
    if (name === '') fail('BRAND_NAME_REQUIRED');
    if (brands.some((b) => b.name.toLowerCase() === name.toLowerCase())) fail('BRAND_NAME_TAKEN');
    const type = str(args, 'deviceType') as DemoBrand['deviceType'];
    if (!['touch', 'keypad', 'both'].includes(type)) fail('BRAND_TYPE_UNKNOWN');
    const b: DemoBrand = { ...brand(newId('b'), name, type, Math.max(0, ...brands.map((x) => x.sortOrder)) + 10, [], ''), isDefault: false };
    brands.push(b);
    return brandDto(b);
  },
  rename_brand: (args) => {
    requireManager();
    const b = findBrand(str(args, 'id'));
    const name = str(args, 'name').trim();
    if (name === '') fail('BRAND_NAME_REQUIRED');
    if (brands.some((x) => x !== b && x.name.toLowerCase() === name.toLowerCase())) fail('BRAND_NAME_TAKEN');
    b.name = name;
    return brandDto(b);
  },
  set_brand_type: (args) => {
    requireManager();
    const b = findBrand(str(args, 'id'));
    const type = str(args, 'deviceType') as DemoBrand['deviceType'];
    if (!['touch', 'keypad', 'both'].includes(type)) fail('BRAND_TYPE_UNKNOWN');
    b.deviceType = type;
    return brandDto(b);
  },
  set_brand_hidden: (args) => {
    requireManager();
    const b = findBrand(str(args, 'id'));
    b.hidden = args?.['hidden'] === true;
    return brandDto(b);
  },
  move_brand: (args) => {
    requireManager();
    const b = findBrand(str(args, 'id'));
    const list = [...brands].sort((x, y) => x.sortOrder - y.sortOrder);
    const at = list.indexOf(b);
    const to = str(args, 'direction') === 'up' ? at - 1 : at + 1;
    if (to >= 0 && to < list.length) {
      [list[at], list[to]] = [list[to] as DemoBrand, list[at] as DemoBrand];
      list.forEach((x, i) => (x.sortOrder = (i + 1) * 10));
    }
    return brandDto(b);
  },
  delete_brand: (args) => {
    requireManager();
    const b = findBrand(str(args, 'id'));
    if (b.isDefault) fail('BRAND_IS_DEFAULT');
    if (products.some((x) => x.brandId === b.id)) fail('BRAND_NOT_EMPTY');
    brands.splice(brands.indexOf(b), 1);
  },
  create_phone: (args) => {
    requireManager();
    const category = categories.find((c) => c.id === str(args, 'categoryId')) ?? fail('PRODUCT_CATEGORY_NOT_FOUND');
    if (category.kind !== 'phone') fail('PHONE_CATEGORY_NOT_PHONE');
    const b = findBrand(str(args, 'brandId'));
    const device = str(args, 'deviceType') as 'touch' | 'keypad';
    if (!(b.deviceType === 'both' || b.deviceType === device)) fail('PHONE_BRAND_TYPE_MISMATCH');
    const model = str(args, 'model').trim().split(/\s+/).join(' ');
    if (model === '') fail('PHONE_MODEL_REQUIRED');
    const storage = typeof args?.['storageGb'] === 'number' ? (args['storageGb'] as number) : null;
    const ram = typeof args?.['ramGb'] === 'number' ? (args['ramGb'] as number) : null;
    if (device === 'touch' && storage === null) fail('PHONE_STORAGE_REQUIRED');
    if (device === 'keypad' && (storage !== null || ram !== null)) fail('PHONE_KEYPAD_HAS_NO_SPECS');
    if (
      products.some((x) => {
        const cat = categories.find((c) => c.id === x.categoryId);
        return (
          x.status === 'active' &&
          (cat?.kind ?? 'phone') === 'phone' &&
          x.brandId === b.id &&
          (x.model ?? '').toLowerCase() === model.toLowerCase() &&
          x.storageGb === storage &&
          x.ramGb === ram
        );
      })
    )
      fail('PHONE_ALREADY_REGISTERED');
    const price = args?.['salePriceMinor'];
    const x: DemoProduct = {
      id: newId('p'),
      name: phoneName(b, model, storage),
      disposition: 'quantity',
      barcode: null,
      salePriceMinor: typeof price === 'number' ? price : null,
      categoryId: category.id,
      brandId: b.id,
      model,
      deviceType: device,
      storageGb: storage,
      ramGb: ram,
      tracking: 'serial_optional',
      onHand: 0,
      totalCostMinor: 0,
      soldRecently: 0,
      status: 'active',
    };
    products.push(x);
    return { product: productDto(x), brandId: b.id, model, deviceType: device, storageGb: storage, ramGb: ram };
  },
  create_used_phone: (args) => {
    const u = requireUser();
    const isOpeningStock = Boolean(args?.['isOpeningStock']);
    const payoutFromDrawer = Boolean(args?.['payoutFromDrawer']);
    if (isOpeningStock) {
      requireManager();
      if (!ownerApprovalHolds()) fail('OWNER_APPROVAL_REQUIRED');
      approvedOnce = false;
    }
    const category =
      categories.find((c) => c.id === str(args, 'categoryId')) ?? fail('PRODUCT_CATEGORY_NOT_FOUND');
    if (category.kind !== 'used' && category.kind !== 'phone') fail('PHONE_CATEGORY_NOT_PHONE');
    const b = findBrand(str(args, 'brandId'));
    const device = str(args, 'deviceType') as 'touch' | 'keypad';
    if (!(b.deviceType === 'both' || b.deviceType === device)) fail('PHONE_BRAND_TYPE_MISMATCH');
    const model = str(args, 'model').trim().split(/\s+/).join(' ');
    if (model === '') fail('PHONE_MODEL_REQUIRED');
    const storage = typeof args?.['storageGb'] === 'number' ? (args['storageGb'] as number) : null;
    const ram = typeof args?.['ramGb'] === 'number' ? (args['ramGb'] as number) : null;
    if (device === 'touch' && storage === null) fail('PHONE_STORAGE_REQUIRED');
    if (device === 'keypad' && (storage !== null || ram !== null)) fail('PHONE_KEYPAD_HAS_NO_SPECS');

    const gradeRaw = str(args, 'conditionGrade').trim().toUpperCase();
    if (!['A', 'B', 'C'].includes(gradeRaw)) fail('UNIT_GRADE_INVALID');
    const grade = gradeRaw as 'A' | 'B' | 'C';

    const batteryRaw = args?.['batteryHealthPct'];
    const battery =
      typeof batteryRaw === 'number' && Number.isFinite(batteryRaw) ? Math.trunc(batteryRaw) : null;
    if (battery !== null && (battery < 1 || battery > 100)) fail('UNIT_BATTERY_HEALTH_INVALID');

    const imei = demoNormalizeImei(str(args, 'imei'));
    if (!/^\d{15}$/.test(imei)) fail('IMEI_INVALID_FORMAT');
    if (!demoLuhn(imei)) fail('IMEI_INVALID_LUHN');
    const imei2Raw = str(args, 'imei2').trim();
    const imei2 = imei2Raw ? demoNormalizeImei(imei2Raw) : null;
    if (imei2 !== null) {
      if (!/^\d{15}$/.test(imei2)) fail('IMEI_INVALID_FORMAT');
      if (!demoLuhn(imei2)) fail('IMEI_INVALID_LUHN');
      if (imei2 === imei) fail('IMEI_SECONDARY_MATCHES_PRIMARY');
    }
    if (productUnits.some((unit) => unit.imei === imei || unit.imei2 === imei)) {
      fail('IMEI_ALREADY_REGISTERED');
    }
    if (imei2 && productUnits.some((unit) => unit.imei === imei2 || unit.imei2 === imei2)) {
      fail('IMEI_ALREADY_REGISTERED');
    }

    const sellerNatIdRaw = str(args, 'sellerNationalId').trim().replace(/[\s-]/g, '');
    if (sellerNatIdRaw && !/^\d{14}$/.test(sellerNatIdRaw)) fail('UNIT_NATIONAL_ID_INVALID');

    const costMinor = Math.max(0, numArg(args, 'costMinor'));
    const salePriceMinor = numArg(args, 'salePriceMinor');
    if (salePriceMinor <= 0) fail('PRODUCT_INVALID_PRICE');

    const title = `${phoneName(b, model, storage)} مستعمل فئة ${grade}`;
    let prod = products.find(
      (x) =>
        x.status === 'active' &&
        x.categoryId === category.id &&
        x.name.toLowerCase() === title.toLowerCase()
    );
    if (prod) {
      prod.salePriceMinor = salePriceMinor;
      prod.tracking = 'serial_optional';
    } else {
      prod = {
        id: newId('p'),
        name: title,
        disposition: 'quantity',
        barcode: null,
        salePriceMinor,
        categoryId: category.id,
        brandId: b.id,
        model,
        deviceType: device,
        storageGb: storage,
        ramGb: ram,
        tracking: 'serial_optional',
        onHand: 0,
        totalCostMinor: 0,
        soldRecently: 0,
        status: 'active',
      };
      products.push(prod);
    }

    prod.onHand += 1;
    prod.totalCostMinor += costMinor;

    const nowMs = Date.now();
    const unitId = newId('u');
    const color = str(args, 'color').trim() || null;
    const accessories = str(args, 'accessories').trim() || null;
    const intakeNote = str(args, 'intakeNote').trim() || null;
    const sellerName = str(args, 'sellerName').trim() || null;
    const sellerPhone = str(args, 'sellerPhone').trim() || null;
    const sellerNationalId = sellerNatIdRaw || null;

    productUnits.push({
      id: unitId,
      productId: prod.id,
      imei,
      imei2,
      color,
      unitCostMinor: costMinor,
      status: 'in_stock',
      createdAt: nowMs,
      conditionGrade: grade,
      batteryHealthPct: battery,
      accessories,
      intakeNote,
      sellerName,
      sellerPhone,
      sellerNationalId,
    });

    for (const sh of demoShortages) {
      if (sh.productId === prod.id && sh.resolvedAt === null) {
        sh.resolvedAt = nowMs;
      }
    }

    if (payoutFromDrawer && !isOpeningStock && costMinor > 0) {
      const openShift = shifts.find((s) => s.status === 'open');
      if (openShift) {
        cashMovements.push({
          id: newId('cm'),
          shiftId: openShift.id,
          kind: 'owner_draw',
          amountMinor: costMinor,
          reason: `شراء جهاز مستعمل: ${prod.name}`,
          createdBy: u.id,
          createdAt: nowMs,
        });
      }
    }

    return {
      product: productDto(prod),
      brandId: b.id,
      model,
      deviceType: device,
      storageGb: storage,
      ramGb: ram,
      unitId,
      imei,
      imei2,
      conditionGrade: grade,
      batteryHealthPct: battery,
      costMinor,
      salePriceMinor,
      onHand: prod.onHand,
    };
  },
  check_imei: (args) => {
    const u = requireUser();
    const canViewCost = u.role === 'manager';
    const normalized = demoNormalizeImei(str(args, 'imei'));
    const digitsOnly = normalized.length > 0 && /^\d+$/.test(normalized);
    const digitCount = normalized.length;
    const formatValid = digitsOnly && digitCount === 15;
    const luhnValid = formatValid && demoLuhn(normalized);
    const tac = digitsOnly && digitCount >= 8 ? normalized.slice(0, 8) : null;

    const unitMatch = normalized
      ? productUnits.find((item) => item.imei === normalized || item.imei2 === normalized) ?? null
      : null;
    const prod = unitMatch ? products.find((p) => p.id === unitMatch.productId) : null;

    const repairMatches = normalized
      ? demoRepairs
          .filter((r) => r.imei === normalized)
          .map((r) => ({
            ticketNo: r.ticketNo,
            deviceName: r.deviceName,
            issue: r.issue,
            status: r.status,
            customerName: r.customerName,
            createdAt: r.createdAt,
          }))
      : [];

    return {
      normalized,
      digitCount,
      formatValid,
      luhnValid,
      tac,
      localUnit: unitMatch
        ? {
            unitId: unitMatch.id,
            productId: unitMatch.productId,
            productName: prod?.name ?? 'جهاز',
            imei: unitMatch.imei,
            imei2: unitMatch.imei2,
            status: unitMatch.status,
            color: unitMatch.color,
            conditionGrade: unitMatch.conditionGrade ?? null,
            batteryHealthPct: unitMatch.batteryHealthPct ?? null,
            accessories: unitMatch.accessories ?? null,
            intakeNote: unitMatch.intakeNote ?? null,
            unitCostMinor: canViewCost ? unitMatch.unitCostMinor : null,
            sellerName: canViewCost ? unitMatch.sellerName ?? null : null,
            sellerPhone: canViewCost ? unitMatch.sellerPhone ?? null : null,
            sellerNationalId: canViewCost ? unitMatch.sellerNationalId ?? null : null,
            createdAt: unitMatch.createdAt,
          }
        : null,
      repairs: repairMatches,
    };
  },

  // the category tree (ADR-018 §1)
  list_categories: () => {
    requireManager();
    return ordered().map((c) => {
      const direct = products.filter((x) => x.categoryId === c.id);
      const hasSubs = categories.some((y) => y.parentId === c.id);
      return {
        ...categoryDto(c),
        products: direct.filter((x) => x.status === 'active').length,
        isDefault: c.isDefault,
        deletable: !c.isDefault && !hasSubs && direct.length === 0,
      };
    });
  },
  create_category: (args) => {
    requireManager();
    const name = str(args, 'name').trim();
    if (name === '') fail('DEPARTMENT_NAME_REQUIRED');
    if (nameTaken(name, null)) fail('CATEGORY_NAME_TAKEN');
    const parentId = str(args, 'parentId') || null;
    const parent = parentId === null ? null : findCategory(parentId);
    if (parent !== null && parent.parentId !== null) fail('CATEGORY_PARENT_NOT_MAIN');
    const asked = str(args, 'kind') as DemoCategory['kind'] | '';
    if (parent !== null && asked !== '' && asked !== parent.kind) fail('CATEGORY_KIND_MISMATCH');
    const siblings = categories.filter((c) => c.parentId === parentId);
    const c = cat(
      newId('c'),
      name,
      parentId,
      parent?.kind ?? (asked || 'item'),
      str(args, 'icon') || 'tag',
      Math.max(0, ...siblings.map((x) => x.sortOrder)) + 10,
      false
    );
    categories.push(c);
    return categoryDto(c);
  },
  rename_category: (args) => {
    requireManager();
    const c = findCategory(str(args, 'id'));
    const name = str(args, 'name').trim();
    if (name === '') fail('DEPARTMENT_NAME_REQUIRED');
    if (nameTaken(name, c.id)) fail('CATEGORY_NAME_TAKEN');
    c.name = name;
    return categoryDto(c);
  },
  set_category_hidden: (args) => {
    requireManager();
    const c = findCategory(str(args, 'id'));
    c.hidden = args?.['hidden'] === true;
    return categoryDto(c);
  },
  move_category: (args) => {
    requireManager();
    const c = findCategory(str(args, 'id'));
    const siblings = ordered().filter((x) => x.parentId === c.parentId);
    const at = siblings.indexOf(c);
    const to = str(args, 'direction') === 'up' ? at - 1 : at + 1;
    if (to >= 0 && to < siblings.length) {
      [siblings[at], siblings[to]] = [siblings[to] as DemoCategory, siblings[at] as DemoCategory];
      siblings.forEach((x, i) => (x.sortOrder = (i + 1) * 10));
    }
    return categoryDto(c);
  },
  delete_category: (args) => {
    requireManager();
    const c = findCategory(str(args, 'id'));
    if (c.isDefault) fail('CATEGORY_IS_DEFAULT');
    if (categories.some((x) => x.parentId === c.id)) fail('CATEGORY_HAS_SUBCATEGORIES');
    if (products.some((x) => x.categoryId === c.id)) fail('CATEGORY_NOT_EMPTY');
    categories.splice(categories.indexOf(c), 1);
  },

  // customers
  list_customers: () => {
    requireUser();
    return customers.filter((c) => !c.archived).map((c) => ({ ...c }));
  },
  get_customer: (args) => {
    requireUser();
    const c = customers.find((x) => x.id === str(args, 'id')) ?? fail('CUSTOMER_NOT_FOUND');
    return { ...c };
  },
  create_customer: (args) => {
    requireUser();
    const name = str(args, 'name').trim();
    if (!name) fail('CUSTOMER_NAME_INVALID');
    const c = {
      id: newId('c'),
      name,
      contact: str(args, 'contact').trim() || null,
      archived: false,
      balanceMinor: 0,
    };
    customers.push(c);
    return { ...c };
  },
  archive_customer: (args) => {
    requireManager();
    const c = customers.find((x) => x.id === str(args, 'id')) ?? fail('CUSTOMER_NOT_FOUND');
    c.archived = true;
    return { ...c };
  },
  record_customer_payment: (args) => {
    requireUser();
    const c = customers.find((x) => x.id === str(args, 'customerId')) ?? fail('CUSTOMER_NOT_FOUND');
    if (c.archived) fail('CUSTOMER_IS_ARCHIVED');
    const amountMinor = numArg(args, 'amountMinor');
    if (!(amountMinor > 0)) fail('CUSTOMER_PAYMENT_AMOUNT_INVALID');
    if (amountMinor > c.balanceMinor) fail('CUSTOMER_PAYMENT_EXCEEDS_BALANCE');
    const method = str(args, 'method').trim();
    if (!['cash', 'vf', 'instapay', 'card'].includes(method)) fail('CUSTOMER_PAYMENT_METHOD_INVALID');
    const note = str(args, 'note').trim() || null;
    const paidIntoWalletId = demoResolvePaymentWalletId(
      method,
      walletIdArg(args, 'walletId'),
      'CUSTOMER_PAYMENT_WALLET_INVALID'
    );
    c.balanceMinor -= amountMinor;
    customerLedger.unshift({
      id: newId('cl'),
      customerId: c.id,
      kind: 'payment',
      amountMinor: -amountMinor,
      method,
      walletId: paidIntoWalletId,
      saleId: null,
      note,
      occurredAt: now(),
    });
    return { ...c };
  },
  list_customer_ledger: (args) => {
    requireUser();
    const cid = str(args, 'customerId');
    if (!customers.some((x) => x.id === cid)) fail('CUSTOMER_NOT_FOUND');
    return customerLedger.filter((e) => e.customerId === cid);
  },

  // shifts, drawer expenses, and cash movements
  current_shift_summary: () => {
    requireUser();
    const open = shifts.find((s) => s.status === 'open') ?? null;
    const closed = shifts
      .filter((s) => s.status === 'closed')
      .sort((a, b) => b.shiftNumber - a.shiftNumber);
    return {
      openShift: open ? buildDemoShiftSummary(open) : null,
      lastClosedShift: closed[0] ? { ...closed[0] } : null,
      recentClosedShifts: closed.slice(0, 10).map((s) => ({ ...s })),
    };
  },
  open_shift: (args) => {
    const user = requireUser();
    if (shifts.some((s) => s.status === 'open')) fail('SHIFT_ALREADY_OPEN');
    const openingCashMinor = numArg(args, 'openingCashMinor');
    if (openingCashMinor < 0) fail('SHIFT_OPENING_CASH_INVALID');
    const maxNo = shifts.reduce((m, s) => Math.max(m, s.shiftNumber), 0);
    const shift: DemoShift = {
      id: newId('shift'),
      shiftNumber: maxNo + 1,
      status: 'open',
      openingCashMinor,
      expectedCashMinor: null,
      countedCashMinor: null,
      differenceMinor: null,
      closeNote: null,
      openedBy: user.id,
      openedAt: now(),
      closedBy: null,
      closedAt: null,
    };
    shifts.push(shift);
    if (appearance.backupOnShift === 'on') {
      recordDemoBackup('shift_open', `فتح وردية #${shift.shiftNumber}`);
    }
    return buildDemoShiftSummary(shift);
  },
  record_expense: (args) => {
    const user = requireUser();
    const open = shifts.find((s) => s.status === 'open') ?? fail('SHIFT_NOT_OPEN');
    const category = str(args, 'category').trim();
    if (!category || category.length > 80) fail('EXPENSE_CATEGORY_INVALID');
    const amountMinor = numArg(args, 'amountMinor');
    if (!(amountMinor > 0)) fail('EXPENSE_AMOUNT_INVALID');
    const note = str(args, 'note').trim() || null;
    expenses.push({
      id: newId('exp'),
      shiftId: open.id,
      category,
      amountMinor,
      note,
      createdBy: user.id,
      createdAt: now(),
    });
    return buildDemoShiftSummary(open);
  },
  record_cash_movement: (args) => {
    const user = requireUser();
    const open = shifts.find((s) => s.status === 'open') ?? fail('SHIFT_NOT_OPEN');
    const kind = str(args, 'kind').trim();
    if (kind !== 'cash_in' && kind !== 'owner_draw') fail('CASH_MOVEMENT_KIND_INVALID');
    const amountMinor = numArg(args, 'amountMinor');
    if (!(amountMinor > 0)) fail('CASH_MOVEMENT_AMOUNT_INVALID');
    const reason = str(args, 'reason').trim();
    if (!reason || reason.length > 200) fail('CASH_MOVEMENT_REASON_INVALID');
    cashMovements.push({
      id: newId('cm'),
      shiftId: open.id,
      kind: kind as 'cash_in' | 'owner_draw',
      amountMinor,
      reason,
      createdBy: user.id,
      createdAt: now(),
    });
    return buildDemoShiftSummary(open);
  },
  close_shift: (args) => {
    const user = requireUser();
    if (user.role !== 'manager' && appearance.sellerCanCloseShift !== 'on') {
      fail('SHIFT_CLOSE_FORBIDDEN_FOR_SELLER');
    }
    const open = shifts.find((s) => s.status === 'open') ?? fail('SHIFT_NOT_OPEN');
    const countedCashMinor = numArg(args, 'countedCashMinor');
    if (countedCashMinor < 0) fail('SHIFT_COUNTED_CASH_INVALID');
    const closeNote = str(args, 'closeNote').trim() || null;
    const closedAt = Math.max(now(), open.openedAt);
    open.closedAt = closedAt;
    const summaryBeforeClose = buildDemoShiftSummary(open);
    const expectedCashMinor = summaryBeforeClose.totals.expectedCashMinor;
    const differenceMinor = countedCashMinor - expectedCashMinor;
    open.status = 'closed';
    open.expectedCashMinor = expectedCashMinor;
    open.countedCashMinor = countedCashMinor;
    open.differenceMinor = differenceMinor;
    open.closeNote = closeNote;
    open.closedBy = user.id;
    if (appearance.backupOnShift === 'on') {
      recordDemoBackup('shift_close', `تقفيل وردية #${open.shiftNumber}`);
    }
    return buildDemoShiftSummary(open);
  },

  // shop wallets and services ledger (Plan item 1.10, ADR-025)
  payment_wallet_candidates: (args) => {
    const method = str(args, 'method').trim();
    return demoWallets
      .filter((w) => !w.hidden && w.payMethod === method)
      .sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1))
      .map((w) => ({ id: w.id, name: w.name, number: w.number }));
  },
  wallets_overview: (args) => {
    requireUser();
    const todayFromMs = Math.max(0, numArg(args, 'todayFromMs'));
    const periodFromMs = Math.max(0, numArg(args, 'periodFromMs'));
    const periodToMs = Math.max(0, numArg(args, 'periodToMs'));
    const walletId = str(args, 'walletId').trim() || null;
    const limit = Math.min(500, Math.max(1, numArg(args, 'limit') || 100));

    const sortedWallets = [...demoWallets].sort(
      (a, b) => a.sort - b.sort || a.createdAt - b.createdAt
    );
    const wallets = sortedWallets.map((w) => {
      const balanceMinor = demoComputeWalletBalanceMinor(w);
      return {
        wallet: { ...w },
        balanceMinor,
        state: demoWalletState(balanceMinor, w.minAlertMinor, w.maxLimitMinor),
        today: demoWalletPeriodStats(w, todayFromMs, Number.MAX_SAFE_INTEGER),
        period: demoWalletPeriodStats(w, periodFromMs, periodToMs),
      };
    });

    const ops = demoWalletOps
      .filter((op) => {
        if (op.createdAt < periodFromMs || op.createdAt > periodToMs) return false;
        if (walletId && op.walletId !== walletId && op.toWalletId !== walletId) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((op) => ({
        ...op,
        drawerDeltaMinor: demoOpDrawerDelta(op),
      }));

    return {
      wallets,
      ops,
      servicesWindow: demoServicesWindowTotals(periodFromMs, periodToMs),
    };
  },
  record_wallet_op: (args) => {
    const user = requireUser();
    const walletId = str(args, 'walletId').trim();
    const kind = str(args, 'kind').trim();
    if (kind !== 'deposit' && kind !== 'withdraw') fail('WALLET_OP_KIND_INVALID');
    const typedKind: 'deposit' | 'withdraw' = kind === 'deposit' ? 'deposit' : 'withdraw';
    const amountMinor = numArg(args, 'amountMinor');
    if (!(amountMinor > 0)) fail('WALLET_OP_AMOUNT_INVALID');
    const feeMinor = numArg(args, 'feeMinor');
    if (feeMinor < 0) fail('WALLET_OP_FEE_INVALID');
    if (typedKind === 'withdraw' && feeMinor > amountMinor) {
      fail('WALLET_OP_FEE_EXCEEDS_AMOUNT');
    }
    const w = demoWallets.find((x) => x.id === walletId) ?? fail('WALLET_NOT_FOUND');
    if (typedKind === 'deposit') {
      const bal = demoComputeWalletBalanceMinor(w);
      if (amountMinor > bal) fail('WALLET_INSUFFICIENT_BALANCE');
    }
    const op: DemoWalletOp = {
      id: newId('wop'),
      walletId: w.id,
      toWalletId: null,
      kind: typedKind,
      via: null,
      serviceType: null,
      reference: null,
      amountMinor,
      feeMinor,
      note: str(args, 'note').trim() || null,
      createdBy: user.id,
      createdAt: now(),
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
    };
    demoWalletOps.push(op);
    return { ...op, drawerDeltaMinor: demoOpDrawerDelta(op) };
  },
  record_service_op: (args) => {
    const user = requireUser();
    const kind = str(args, 'kind').trim();
    if (kind !== 'bill' && kind !== 'card' && kind !== 'software') {
      fail('WALLET_OP_KIND_INVALID');
    }
    const typedKind: 'bill' | 'card' | 'software' =
      kind === 'bill' ? 'bill' : kind === 'card' ? 'card' : 'software';
    const serviceType = str(args, 'serviceType').trim();
    if (!serviceType) fail('WALLET_OP_KIND_INVALID');
    const reference = str(args, 'reference').trim() || null;
    const rawAmountMinor = numArg(args, 'amountMinor');
    const feeMinor = numArg(args, 'feeMinor');
    if (typedKind === 'software') {
      if (!(feeMinor > 0)) fail('WALLET_OP_AMOUNT_INVALID');
    } else {
      if (!(rawAmountMinor > 0)) fail('WALLET_OP_AMOUNT_INVALID');
      if (feeMinor < 0) fail('WALLET_OP_FEE_INVALID');
    }
    const op: DemoWalletOp = {
      id: newId('wop'),
      walletId: null,
      toWalletId: null,
      kind: typedKind,
      via: null,
      serviceType,
      reference,
      amountMinor: typedKind === 'software' ? 0 : rawAmountMinor,
      feeMinor,
      note: str(args, 'note').trim() || null,
      createdBy: user.id,
      createdAt: now(),
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
    };
    demoWalletOps.push(op);
    return { ...op, drawerDeltaMinor: demoOpDrawerDelta(op) };
  },
  record_wallet_movement: (args) => {
    const user = requireManager();
    const kind = str(args, 'kind').trim();
    if (kind !== 'topup' && kind !== 'unload' && kind !== 'move') {
      fail('WALLET_OP_KIND_INVALID');
    }
    const typedKind: 'topup' | 'unload' | 'move' =
      kind === 'topup' ? 'topup' : kind === 'unload' ? 'unload' : 'move';
    const walletId = str(args, 'walletId').trim();
    const w = demoWallets.find((x) => x.id === walletId) ?? fail('WALLET_NOT_FOUND');
    const amountMinor = numArg(args, 'amountMinor');
    if (!(amountMinor > 0)) fail('WALLET_OP_AMOUNT_INVALID');

    let toWalletId: string | null = null;
    let via: 'drawer' | 'out' | null = null;
    if (typedKind === 'move') {
      const targetId = str(args, 'toWalletId').trim();
      const target =
        demoWallets.find((x) => x.id === targetId) ?? fail('WALLET_NOT_FOUND');
      if (target.id === w.id) fail('WALLET_OP_KIND_INVALID');
      if (amountMinor > demoComputeWalletBalanceMinor(w)) {
        fail('WALLET_INSUFFICIENT_BALANCE');
      }
      toWalletId = target.id;
    } else {
      const v = str(args, 'via').trim();
      if (v !== 'drawer' && v !== 'out') fail('WALLET_OP_VIA_INVALID');
      via = v === 'drawer' ? 'drawer' : 'out';
      if (typedKind === 'unload' && amountMinor > demoComputeWalletBalanceMinor(w)) {
        fail('WALLET_INSUFFICIENT_BALANCE');
      }
    }

    const op: DemoWalletOp = {
      id: newId('wop'),
      walletId: w.id,
      toWalletId,
      kind: typedKind,
      via,
      serviceType: null,
      reference: null,
      amountMinor,
      feeMinor: 0,
      note: str(args, 'note').trim() || null,
      createdBy: user.id,
      createdAt: now(),
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
    };
    demoWalletOps.push(op);
    return { ...op, drawerDeltaMinor: demoOpDrawerDelta(op) };
  },
  reconcile_wallet: (args) => {
    const user = requireManager();
    const walletId = str(args, 'walletId').trim();
    const w = demoWallets.find((x) => x.id === walletId) ?? fail('WALLET_NOT_FOUND');
    const realBalanceMinor = numArg(args, 'realBalanceMinor');
    if (realBalanceMinor < 0) fail('WALLET_OP_AMOUNT_INVALID');
    const expected = demoComputeWalletBalanceMinor(w);
    const diffMinor = realBalanceMinor - expected;
    if (diffMinor === 0) return null;
    const reason = str(args, 'reason').trim();
    if (!reason) fail('WALLET_VOID_REASON_REQUIRED');
    const extra = str(args, 'note').trim();
    const op: DemoWalletOp = {
      id: newId('wop'),
      walletId: w.id,
      toWalletId: null,
      kind: 'adjust',
      via: null,
      serviceType: null,
      reference: null,
      amountMinor: diffMinor,
      feeMinor: 0,
      note: extra ? `جرد: ${reason}، ${extra}` : `جرد: ${reason}`,
      createdBy: user.id,
      createdAt: now(),
      voidedBy: null,
      voidedAt: null,
      voidReason: null,
    };
    demoWalletOps.push(op);
    return { ...op, drawerDeltaMinor: 0 };
  },
  void_wallet_op: (args) => {
    const user = requireManager();
    const opId = str(args, 'opId').trim();
    const reason = str(args, 'reason').trim();
    if (!reason) fail('WALLET_VOID_REASON_REQUIRED');
    const op = demoWalletOps.find((x) => x.id === opId) ?? fail('WALLET_OP_NOT_FOUND');
    if (op.voidedAt !== null) fail('WALLET_OP_ALREADY_VOIDED');
    op.voidedBy = user.id;
    op.voidedAt = Math.max(now(), op.createdAt);
    op.voidReason = reason;
    return { ...op, drawerDeltaMinor: 0 };
  },
  create_wallet: (args) => {
    requireManager();
    const name = str(args, 'name').trim();
    if (!name) fail('WALLET_NAME_EMPTY');
    if (demoWallets.some((w) => w.name === name)) fail('WALLET_NAME_DUPLICATE');
    const color = str(args, 'color').trim().toLowerCase() || '#0d7377';
    const number = str(args, 'number').trim();
    const company = str(args, 'company').trim();
    if (company.length > 80) fail('WALLET_COMPANY_INVALID');
    const maxSort = demoWallets.reduce((m, w) => Math.max(m, w.sort), 0);
    const wallet: DemoWallet = {
      id: newId('wal'),
      name,
      company: company || null,
      number,
      color,
      openingBalanceMinor: 0,
      minAlertMinor: 0,
      maxLimitMinor: 0,
      dailyLimitMinor: 0,
      payMethod: null,
      sort: maxSort + 1,
      hidden: false,
      isCustom: true,
      createdAt: now(),
    };
    demoWallets.push(wallet);
    return { ...wallet };
  },
  update_wallet: (args) => {
    requireManager();
    const walletId = str(args, 'walletId').trim();
    const w = demoWallets.find((x) => x.id === walletId) ?? fail('WALLET_NOT_FOUND');
    const name = str(args, 'name').trim();
    if (!name) fail('WALLET_NAME_EMPTY');
    if (demoWallets.some((x) => x.id !== w.id && x.name === name)) {
      fail('WALLET_NAME_DUPLICATE');
    }
    const rawPay = str(args, 'payMethod').trim();
    const payMethod =
      rawPay === 'vf' || rawPay === 'instapay' ? rawPay : null;
    // Since `ADR-040` a method may be received by more than one number, so editing this
    // wallet never clears the link on another one.
    const company = str(args, 'company').trim();
    if (company.length > 80) fail('WALLET_COMPANY_INVALID');
    w.name = name;
    w.number = str(args, 'number').trim();
    w.color = str(args, 'color').trim().toLowerCase() || w.color;
    w.openingBalanceMinor = Math.max(0, numArg(args, 'openingBalanceMinor'));
    w.minAlertMinor = Math.max(0, numArg(args, 'minAlertMinor'));
    w.maxLimitMinor = Math.max(0, numArg(args, 'maxLimitMinor'));
    w.dailyLimitMinor = Math.max(0, numArg(args, 'dailyLimitMinor'));
    w.payMethod = payMethod;
    w.company = company || null;
    w.sort = numArg(args, 'sort');
    w.hidden = Boolean(args?.['hidden']);
    return { ...w };
  },
  delete_wallet: (args) => {
    requireManager();
    const walletId = str(args, 'walletId').trim();
    const idx = demoWallets.findIndex((x) => x.id === walletId);
    if (idx < 0) fail('WALLET_NOT_FOUND');
    const w = demoWallets[idx] ?? fail('WALLET_NOT_FOUND');
    if (
      !w.isCustom ||
      demoWalletOps.some((op) => op.walletId === w.id || op.toWalletId === w.id)
    ) {
      fail('WALLET_DELETE_FORBIDDEN');
    }
    demoWallets.splice(idx, 1);
  },

  // settings panels
  read_settings: () => {
    requireManager(true);
    return { ...settings };
  },
  update_setting: (args) => {
    requireManager(true);
    const key = str(args, 'key');
    if (key === 'invoice_prefix') settings.invoicePrefix = str(args, 'value');
  },
  list_users_for_management: () => {
    // While the row is unclaimed the operator is the till itself, and Rust resolves
    // that as a manager session with a fresh assurance (`open_mode::session`), so
    // the gate is satisfied by construction — not skipped. Claimed, the ordinary
    // "manager, password just proven" rule applies.
    if (claimed) requireManager(true);
    // Every row here can be disabled, re-roled, or given a temporary password, and
    // the open row is not that kind of row (`ADR-039`, as in `users::list_managed`).
    return users
      .filter((u) => claimed || u !== openOwner)
      .map((u) => ({
      userId: u.id,
      displayName: u.displayName,
      username: u.username,
      role: u.role,
      disabled: u.disabled,
      mustChangePassword: false,
      integrityFault: false,
    }));
  },

  // automatic backup policy (Plan item 1.12, ADR-027)
  list_saved_backups: () => {
    requireManager(false);
    return demoSavedBackups.map((b) => ({ ...b }));
  },
  create_auto_backup_now: () => {
    requireManager(false);
    return recordDemoBackup('manual', 'يدوي');
  },
  copy_latest_backup_to_usb: () => {
    requireManager(false);
    if (demoSavedBackups.length === 0) {
      recordDemoBackup('manual', 'يدوي');
    }
    const latest = demoSavedBackups[0] ?? fail('BACKUP_NOT_FOUND');
    latest.usbCopied = true;
    return { ...latest };
  },
  restore_saved_backup: (args) => {
    requireManager(false);
    if (!ownerApprovalHolds()) fail('OWNER_APPROVAL_REQUIRED');
    approvedOnce = false;
    const backupId = str(args, 'backupId').trim();
    const found =
      demoSavedBackups.find((b) => b.id === backupId) ??
      fail('BACKUP_NOT_FOUND');
    return {
      databaseLen: found.databaseLen,
      imageCount: found.imageCount,
    };
  },
  run_periodic_backup_tick: () => {
    requireUser();
    if (appearance.backupUsbAuto === 'on' && demoSavedBackups[0] && !demoSavedBackups[0].usbCopied) {
      demoSavedBackups[0].usbCopied = true;
      return { ...demoSavedBackups[0] };
    }
    if (appearance.backupEvery2h === 'on') {
      const lastTs = demoSavedBackups[0]?.createdAtUnixMs ?? 0;
      if (now() - lastTs >= 2 * 60 * 60 * 1000) {
        return recordDemoBackup('periodic', 'دوري (كل ساعتين)');
      }
    }
    return null;
  },

  // shortages list (Plan item 1.15, ADR-030)
  shortages_overview: () => {
    requireUser();
    return buildDemoShortagesOverview();
  },
  add_shortage: (args) => {
    const u = requireUser();
    const rawPid = typeof args?.['productId'] === 'string' ? args['productId'].trim() : '';
    const product = rawPid ? (products.find((p) => p.id === rawPid) ?? fail('PRODUCT_NOT_FOUND')) : null;
    const rawName = typeof args?.['name'] === 'string' ? args['name'].trim() : '';
    const name = rawName || (product?.name ?? '');
    if (!name) fail('SHORTAGE_NAME_REQUIRED');
    const qty = typeof args?.['qty'] === 'number' ? Math.trunc(args['qty']) : 0;
    if (qty <= 0) fail('SHORTAGE_INVALID_QUANTITY');
    const note = typeof args?.['note'] === 'string' ? args['note'].trim() : '';
    const custName =
      typeof args?.['customerName'] === 'string' && args['customerName'].trim() !== ''
        ? args['customerName'].trim()
        : null;
    const custPhone =
      typeof args?.['customerPhone'] === 'string' && args['customerPhone'].trim() !== ''
        ? args['customerPhone'].trim()
        : null;

    const existing = demoShortages.find((sh) => {
      if (sh.resolvedAt !== null) return false;
      if (product) return sh.productId === product.id;
      return sh.productId === null && normShortageName(sh.name) === normShortageName(name);
    });
    if (existing) {
      existing.qty += qty;
      if (note) existing.note = note;
      if (custName) existing.customerName = custName;
      if (custPhone) existing.customerPhone = custPhone;
      return {
        entry: shortageDto(existing),
        merged: true,
      };
    }

    const created: DemoShortage = {
      id: newId('sh'),
      productId: product?.id ?? null,
      name,
      qty,
      note,
      customerName: custName,
      customerPhone: custPhone,
      status: 'open',
      createdBy: u.id,
      createdAt: now(),
      resolvedAt: null,
    };
    demoShortages.unshift(created);
    return {
      entry: shortageDto(created),
      merged: false,
    };
  },
  set_shortage_status: (args) => {
    requireUser();
    const id = str(args, 'shortageId').trim();
    const status = str(args, 'status').trim();
    if (status !== 'open' && status !== 'ordered') fail('SHORTAGE_INVALID_STATUS');
    const sh =
      demoShortages.find((x) => x.id === id && x.resolvedAt === null) ?? fail('SHORTAGE_NOT_FOUND');
    sh.status = status as 'open' | 'ordered';
    return shortageDto(sh);
  },
  resolve_shortage: (args) => {
    requireUser();
    const id = str(args, 'shortageId').trim();
    const sh =
      demoShortages.find((x) => x.id === id && x.resolvedAt === null) ?? fail('SHORTAGE_NOT_FOUND');
    sh.resolvedAt = now();
    return shortageDto(sh);
  },
  delete_shortage: (args) => {
    const u = requireUser();
    const id = str(args, 'shortageId').trim();
    const idx = demoShortages.findIndex((x) => x.id === id);
    if (idx < 0) fail('SHORTAGE_NOT_FOUND');
    const sh = demoShortages[idx]!;
    if (u.role !== 'manager' && sh.createdBy !== u.id) {
      fail('SHORTAGE_DELETE_FORBIDDEN');
    }
    const dto = shortageDto(sh);
    demoShortages.splice(idx, 1);
    return dto;
  },
  add_all_suggested_shortages: () => {
    const u = requireUser();
    const ov = buildDemoShortagesOverview();
    const added = [];
    for (const s of ov.suggestions) {
      const created: DemoShortage = {
        id: newId('sh'),
        productId: s.productId,
        name: s.name,
        qty: s.suggestedQty,
        note: '',
        customerName: null,
        customerPhone: null,
        status: 'open',
        createdBy: u.id,
        createdAt: now(),
        resolvedAt: null,
      };
      demoShortages.unshift(created);
      added.push(shortageDto(created));
    }
    return added;
  },
  repairs_overview: (args) => {
    const u = requireUser();
    const fromTs = typeof args?.['fromTs'] === 'number' ? args['fromTs'] : null;
    const toTs = typeof args?.['toTs'] === 'number' ? args['toTs'] : null;
    const includeCost = u.role === 'manager';
    return buildDemoRepairsOverview(fromTs, toTs, includeCost);
  },
  create_repair: (args) => {
    const u = requireUser();
    const serviceKind = str(args, 'serviceKind').trim() === 'software' ? 'software' : 'hardware';
    const customerName = str(args, 'customerName').trim();
    const customerPhone = str(args, 'customerPhone').trim();
    if (!customerName || !customerPhone) fail('REPAIR_CUSTOMER_REQUIRED');
    const deviceName = str(args, 'deviceName').trim();
    if (!deviceName) fail('REPAIR_DEVICE_REQUIRED');
    const issue = str(args, 'issue').trim();
    if (!issue) fail('REPAIR_ISSUE_REQUIRED');
    const imei =
      typeof args?.['imei'] === 'string' && args['imei'].trim() ? args['imei'].trim() : null;
    const deviceLock = typeof args?.['deviceLock'] === 'string' ? args['deviceLock'].trim() : '';
    const accessories =
      typeof args?.['accessories'] === 'string' ? args['accessories'].trim() : '';
    const dueLabel =
      typeof args?.['dueLabel'] === 'string' && args['dueLabel'].trim()
        ? args['dueLabel'].trim()
        : 'بكره';
    const estimatedPriceMinor =
      typeof args?.['estimatedPriceMinor'] === 'number' ? Math.trunc(args['estimatedPriceMinor']) : 0;
    const partsCostMinor =
      typeof args?.['partsCostMinor'] === 'number' ? Math.trunc(args['partsCostMinor']) : 0;
    const depositMinor =
      typeof args?.['depositMinor'] === 'number' ? Math.trunc(args['depositMinor']) : 0;
    const payMethodRaw = typeof args?.['payMethod'] === 'string' ? args['payMethod'].trim() : 'cash';
    const payMethod = (
      ['cash', 'vf', 'instapay', 'card'].includes(payMethodRaw) ? payMethodRaw : 'cash'
    ) as DemoRepair['payMethod'];
    const payWalletId = demoResolvePaymentWalletId(
      payMethod,
      walletIdArg(args, 'payWalletId'),
      'REPAIR_PAY_WALLET_INVALID'
    );
    const technicianName =
      typeof args?.['technicianName'] === 'string' && args['technicianName'].trim()
        ? args['technicianName'].trim()
        : null;
    const warrantyDays =
      typeof args?.['warrantyDays'] === 'number' ? Math.trunc(args['warrantyDays']) : 0;
    const note = typeof args?.['note'] === 'string' ? args['note'].trim() : '';
    const deliverNow = Boolean(args?.['deliverNow']);

    let maxNum = 1094;
    for (const r of demoRepairs) {
      const m = /^R-(\d+)$/.exec(r.ticketNo);
      if (m) maxNum = Math.max(maxNum, Number(m[1]));
    }
    const ticketNo = `R-${maxNum + 1}`;
    const ts = now();
    const created: DemoRepair = {
      id: newId('rep'),
      ticketNo,
      serviceKind,
      customerName,
      customerPhone,
      deviceName,
      imei,
      deviceLock,
      issue,
      accessories,
      dueLabel,
      status: deliverNow ? 'delivered' : 'received',
      estimatedPriceMinor,
      finalPriceMinor: deliverNow ? estimatedPriceMinor : 0,
      partsCostMinor,
      depositMinor: deliverNow ? 0 : depositMinor,
      payMethod,
      payWalletId,
      technicianName,
      warrantyDays,
      note,
      createdBy: u.id,
      createdAt: ts,
      deliveredAt: deliverNow ? ts : null,
    };
    demoRepairs.unshift(created);
    return repairTicketDto(created, u.role === 'manager');
  },
  update_repair_status: (args) => {
    const u = requireUser();
    const id = str(args, 'id').trim();
    const status = str(args, 'status').trim() as DemoRepair['status'];
    const rep = demoRepairs.find((r) => r.id === id) ?? fail('REPAIR_NOT_FOUND');
    if (rep.status === 'delivered' || rep.status === 'cancelled') {
      fail('REPAIR_ALREADY_DELIVERED');
    }
    rep.status = status;
    if (typeof args?.['technicianName'] === 'string' && args['technicianName'].trim()) {
      rep.technicianName = args['technicianName'].trim();
    }
    if (typeof args?.['estimatedPriceMinor'] === 'number') {
      rep.estimatedPriceMinor = Math.trunc(args['estimatedPriceMinor']);
    }
    if (typeof args?.['partsCostMinor'] === 'number') {
      rep.partsCostMinor = Math.trunc(args['partsCostMinor']);
    }
    if (typeof args?.['note'] === 'string') {
      rep.note = args['note'].trim();
    }
    return repairTicketDto(rep, u.role === 'manager');
  },
  deliver_repair: (args) => {
    const u = requireUser();
    const id = str(args, 'id').trim();
    const rep = demoRepairs.find((r) => r.id === id) ?? fail('REPAIR_NOT_FOUND');
    if (rep.status === 'delivered' || rep.status === 'cancelled') {
      fail('REPAIR_ALREADY_DELIVERED');
    }
    rep.status = 'delivered';
    rep.finalPriceMinor =
      typeof args?.['finalPriceMinor'] === 'number'
        ? Math.trunc(args['finalPriceMinor'])
        : rep.estimatedPriceMinor;
    if (typeof args?.['partsCostMinor'] === 'number') {
      rep.partsCostMinor = Math.trunc(args['partsCostMinor']);
    }
    const payMethodRaw = typeof args?.['payMethod'] === 'string' ? args['payMethod'].trim() : 'cash';
    rep.payMethod = (
      ['cash', 'vf', 'instapay', 'card'].includes(payMethodRaw) ? payMethodRaw : 'cash'
    ) as DemoRepair['payMethod'];
    rep.payWalletId = demoResolvePaymentWalletId(
      rep.payMethod,
      walletIdArg(args, 'payWalletId'),
      'REPAIR_PAY_WALLET_INVALID'
    );
    if (typeof args?.['technicianName'] === 'string' && args['technicianName'].trim()) {
      rep.technicianName = args['technicianName'].trim();
    }
    if (typeof args?.['warrantyDays'] === 'number') {
      rep.warrantyDays = Math.trunc(args['warrantyDays']);
    }
    if (typeof args?.['note'] === 'string') {
      rep.note = args['note'].trim();
    }
    rep.deliveredAt = now();
    return repairTicketDto(rep, u.role === 'manager');
  },
  cancel_repair: (args) => {
    const u = requireUser();
    const id = str(args, 'id').trim();
    const rep = demoRepairs.find((r) => r.id === id) ?? fail('REPAIR_NOT_FOUND');
    if (rep.status === 'delivered' || rep.status === 'cancelled') {
      fail('REPAIR_ALREADY_DELIVERED');
    }
    rep.status = 'cancelled';
    if (typeof args?.['note'] === 'string' && args['note'].trim()) {
      rep.note = args['note'].trim();
    }
    return repairTicketDto(rep, u.role === 'manager');
  },
  companion_overview: () => {
    requireUser();
    return demoCompanionStatusDto();
  },
  pair_companion_device: (args) => {
    requireManager();
    const name = str(args, 'name').trim() || 'موبايل المحل';
    const model = str(args, 'model').trim() || 'Android Wi-Fi';
    demoPairedDevices.push({
      id: `dev-${Date.now()}-${demoPairedDevices.length + 1}`,
      name,
      model,
      pairedAt: now(),
      lastSeenAt: now(),
      online: true,
    });
    return demoCompanionStatusDto();
  },
  unpair_companion_device: (args) => {
    requireManager();
    const deviceId = str(args, 'deviceId').trim();
    const idx = demoPairedDevices.findIndex((d) => d.id === deviceId);
    if (idx !== -1) {
      demoPairedDevices.splice(idx, 1);
    }
    return demoCompanionStatusDto();
  },
  push_companion_scan: (args) => {
    requireUser();
    const targetRaw = str(args, 'target').trim();
    const target: 'pos' | 'receive' = targetRaw === 'receive' ? 'receive' : 'pos';
    const code = str(args, 'code').trim();
    const productId =
      typeof args?.['productId'] === 'string' && args['productId'].trim()
        ? args['productId'].trim()
        : null;
    const productName =
      typeof args?.['productName'] === 'string' && args['productName'].trim()
        ? args['productName'].trim()
        : null;
    const deviceName =
      typeof args?.['deviceName'] === 'string' && args['deviceName'].trim()
        ? args['deviceName'].trim()
        : 'موبايل المحل';
    demoCompanionScans.push({
      id: `scan-${Date.now()}-${demoCompanionScans.length + 1}`,
      target,
      code,
      productId,
      productName,
      deviceName,
      scannedAt: now(),
    });
    return demoCompanionStatusDto();
  },
  consume_companion_scans: (args) => {
    requireUser();
    const targetRaw = str(args, 'target').trim();
    const matched = demoCompanionScans.filter((s) => s.target === targetRaw);
    demoCompanionScans = demoCompanionScans.filter((s) => s.target !== targetRaw);
    return matched;
  },
  set_companion_remote: (args) => {
    const user = requireUser();
    if (user.role !== 'manager') throw { code: 'PERMISSION_DENIED' };
    demoRemoteEnabled = Boolean(args?.['enabled']);
    return demoCompanionStatusDto();
  },
};

/** Install the stand-in backend. Call once, before the app mounts. */
export function install(): void {
  mockIPC((cmd, args) => {
    const handler = handlers[cmd];
    if (handler === undefined) {
      // Not part of the demo (backups, user changes): refused, so nothing
      // pretends to have happened.
      throw { code: 'DEMO_UNAVAILABLE' };
    }
    return handler(args as Args);
  });
}

/** Shown on the sign-in card of the demo only. */
export const DEMO_HINT = `للتجربة بس: كلمة السر لكل الحسابات ${DEMO_PASSWORD}. البيانات وهمية ومش بتتحفظ.`;
