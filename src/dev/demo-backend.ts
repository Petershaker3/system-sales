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
];

const appearance = { look: 'plate', theme: 'light', accent: '#1d4f91', font: 'auto', scale: 'normal', digits: 'latin' };
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
    const key = str(args, 'key').replace(/^ui\./, '') as keyof typeof appearance;
    if (!(key in appearance)) fail('SETTING_UNKNOWN_KEY');
    if (key === 'theme') requireUser();
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
          barcode: x.barcode,
          salePriceMinor: x.salePriceMinor,
          categoryId: x.categoryId,
          onHand: x.onHand,
          soldRecently: x.soldRecently,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ar')),
      categories: ordered().map(categoryDto),
    };
  },
  record_sale: (args) => {
    requireUser();
    const lines = (args?.['lines'] as { productId: string; quantity: number }[] | undefined) ?? [];
    if (lines.length === 0) fail('SALE_EMPTY');
    let total = 0;
    let cost = 0;
    for (const line of lines) {
      const x = findProduct(line.productId);
      if (x.status !== 'active') fail('SALE_PRODUCT_ARCHIVED');
      if (x.disposition !== 'quantity') fail('SALE_DISPOSITION_NOT_SUPPORTED');
      if (x.salePriceMinor === null) fail('SALE_PRICE_NOT_SET');
      if (!(line.quantity > 0)) fail('SALE_INVALID_QUANTITY');
      if (line.quantity > x.onHand) fail('COST_INSUFFICIENT_STOCK');
      total += (x.salePriceMinor ?? 0) * line.quantity;
      cost += Math.ceil((x.totalCostMinor * line.quantity) / Math.max(1, x.onHand));
    }
    const confirmed = args?.['confirmedTotalMinor'];
    if (typeof confirmed === 'number' && confirmed !== total) fail('SALE_PRICE_CHANGED');
    for (const line of lines) {
      const x = findProduct(line.productId);
      const removed = Math.ceil((x.totalCostMinor * line.quantity) / Math.max(1, x.onHand));
      x.totalCostMinor -= removed;
      x.onHand -= line.quantity;
      x.soldRecently += line.quantity;
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
    const price = args?.['salePriceMinor'];
    const x: DemoProduct = {
      id: newId('p'),
      name: str(args, 'name'),
      disposition: (str(args, 'disposition') || 'quantity') as DemoProduct['disposition'],
      barcode: str(args, 'barcode') || null,
      salePriceMinor: typeof price === 'number' ? price : null,
      categoryId: categoryOf(args),
      onHand: 0,
      totalCostMinor: 0,
      soldRecently: 0,
      status: 'active',
    };
    products.push(x);
    return productDto(x);
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
    x.onHand += quantity;
    x.totalCostMinor += quantity * numArg(args, 'unitCostMinor');
    return { productId: x.id, quantity: x.onHand, costMinor: 0 };
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
