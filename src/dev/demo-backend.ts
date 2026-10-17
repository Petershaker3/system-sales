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

const users: DemoUser[] = [
  { id: 'u-peter', displayName: 'بيتر', username: 'peter', role: 'manager', password: DEMO_PASSWORD, pin: '1111', disabled: false },
  { id: 'u-youssef', displayName: 'يوسف', username: 'youssef', role: 'sales', password: DEMO_PASSWORD, pin: '2222', disabled: false },
  { id: 'u-marina', displayName: 'مارينا', username: 'marina', role: 'sales', password: DEMO_PASSWORD, pin: '3333', disabled: false },
];

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
};
interface DemoUnit {
  id: string;
  productId: string;
  imei: string;
  imei2: string | null;
  color: string | null;
  unitCostMinor: number;
  status: 'in_stock' | 'sold' | 'retired';
  createdAt: number;
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
interface DemoProductImage {
  productId: string;
  file: string;
  w: number;
  h: number;
  bytes: number;
  dataUrl: string;
}
const productImages = new Map<string, DemoProductImage>();

const customers: { id: string; name: string; contact: string | null; archived: boolean }[] = [
  { id: 'c-1', name: 'أحمد سمير', contact: '01001234567', archived: false },
];
const sales: { id: string; reference: string; totalMinor: number }[] = [];
const settings = {
  defaultCostMethod: 'moving_average',
  invoicePrefix: 'INV',
  defaultVatEnabled: false,
  defaultVatRateBp: null as number | null,
  defaultVatInclusive: false,
  maxDiscountKind: 'money',
  maxDiscountValue: 0,
};

let current: DemoUser | null = null;
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
  if (fresh && now() >= freshUntil) fail('REAUTHENTICATION_REQUIRED');
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

const handlers: Record<string, (args: Args) => unknown> = {
  // identity
  bootstrap_status: () => ({ needsSetup: false }),
  whoami: () => session(),
  list_users_for_picker: () =>
    users.map((u) => ({
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
    if (user.password !== str(args, 'password')) fail('INVALID_CREDENTIALS');
    freshUntil = now() + 5 * 60_000;
    return 'reauthenticated';
  },

  // display choices
  read_appearance: () => ({ ...appearance }),
  update_appearance: (args) => {
    const rawKey = str(args, 'key');
    const key = (
      rawKey === 'ui.imei_mode' ? 'imeiMode' : rawKey.replace(/^ui\./, '')
    ) as keyof typeof appearance;
    if (!(key in appearance)) fail('SETTING_UNKNOWN_KEY');
    if (key === 'theme') requireUser();
    else if (key === 'images' || key === 'imeiMode') requireManager(false);
    else requireManager(true);
    appearance[key] = str(args, 'value').toLowerCase();
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
        })),
    };
  },

  record_sale: (args) => {
    requireUser();
    const lines =
      (args?.['lines'] as { productId: string; quantity: number; imei?: string | null }[] | undefined) ?? [];
    if (lines.length === 0) fail('SALE_EMPTY');
    let total = 0;
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
      total += (x.salePriceMinor ?? 0) * line.quantity;
    }
    const confirmed = args?.['confirmedTotalMinor'];
    if (typeof confirmed === 'number' && confirmed !== total) fail('SALE_PRICE_CHANGED');
    let cost = 0;
    for (const line of lines) {
      const x = findProduct(line.productId);
      const rawImei = typeof line.imei === 'string' && line.imei.trim() !== '' ? demoNormalizeImei(line.imei) : null;
      const inStockUnits = productUnits
        .filter((u) => u.productId === x.id && u.status === 'in_stock')
        .sort((a, b) => a.createdAt - b.createdAt);
      const unitsCost = inStockUnits.reduce((s, u) => s + u.unitCostMinor, 0);
      const unregQty = Math.max(0, x.onHand - inStockUnits.length);
      const unregCost = Math.max(0, x.totalCostMinor - unitsCost);

      if (rawImei !== null) {
        const existing = productUnits.find((u) => u.imei === rawImei || u.imei2 === rawImei);
        if (existing) {
          if (existing.productId !== x.id || existing.status !== 'in_stock') fail('IMEI_UNIT_NOT_AVAILABLE');
          existing.status = 'sold';
          const removed = Math.min(x.totalCostMinor, existing.unitCostMinor);
          x.totalCostMinor -= removed;
          x.onHand -= 1;
          x.soldRecently += 1;
          cost += removed;
        } else {
          if (unregQty < 1) fail('IMEI_NO_UNREGISTERED_STOCK');
          const removed = Math.ceil(unregCost / Math.max(1, unregQty));
          productUnits.push({
            id: newId('u'),
            productId: x.id,
            imei: rawImei,
            imei2: null,
            color: null,
            unitCostMinor: removed,
            status: 'sold',
            createdAt: now(),
          });
          x.totalCostMinor -= removed;
          x.onHand -= 1;
          x.soldRecently += 1;
          cost += removed;
        }
      } else {
        if (line.quantity <= unregQty) {
          const removed = Math.ceil((unregCost * line.quantity) / Math.max(1, unregQty));
          x.totalCostMinor -= removed;
          x.onHand -= line.quantity;
          x.soldRecently += line.quantity;
          cost += removed;
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
        }
      }
    }
    const reference = `${settings.invoicePrefix}-${today()}-${String(sales.length + 1).padStart(4, '0')}`;
    const sale = { id: newId('s'), reference, totalMinor: total };
    sales.push(sale);
    return { saleId: sale.id, reference, totalMinor: total, costTotalMinor: cost };
  },
  set_sale_customer_name: (args) => {
    requireUser();
    if (!sales.some((s) => s.id === str(args, 'saleId'))) fail('SALE_NOT_FOUND');
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
    return { productId: x.id, quantity: x.onHand, costMinor: 0 };
  },
  receive_opening_stock: (args) => {
    requireManager();
    if (!approvedOnce) fail('OWNER_APPROVAL_REQUIRED');
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
        status: u.status,
      }));
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
      products.some(
        (x) => x.status === 'active' && x.brandId === b.id && (x.model ?? '').toLowerCase() === model.toLowerCase() && x.storageGb === storage && x.ramGb === ram
      )
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
    requireManager();
    return customers;
  },
  get_customer: (args) => customers.find((c) => c.id === str(args, 'id')) ?? fail('CUSTOMER_NOT_FOUND'),
  create_customer: (args) => {
    requireUser();
    const c = { id: newId('c'), name: str(args, 'name'), contact: str(args, 'contact') || null, archived: false };
    customers.push(c);
    return c;
  },
  archive_customer: (args) => {
    requireManager();
    const c = customers.find((x) => x.id === str(args, 'id')) ?? fail('CUSTOMER_NOT_FOUND');
    c.archived = true;
    return c;
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
    requireManager(true);
    return users.map((u) => ({
      userId: u.id,
      displayName: u.displayName,
      username: u.username,
      role: u.role,
      disabled: u.disabled,
      mustChangePassword: false,
      credentialsMissing: false,
    }));
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
