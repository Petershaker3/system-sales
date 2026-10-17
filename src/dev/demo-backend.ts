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
  departmentId: string | null;
  onHand: number;
  totalCostMinor: number;
  soldRecently: number;
  status: 'active' | 'archived';
}

interface DemoDepartment {
  id: string;
  name: string;
  sortOrder: number;
  status: 'active' | 'archived';
}

const now = () => Date.now();
let seq = 0;
const newId = (prefix: string) => `${prefix}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const fail = (code: string): never => {
  throw { code };
};

const DEMO_PASSWORD = '1234';

const users: DemoUser[] = [
  { id: 'u-peter', displayName: 'بيتر', username: 'peter', role: 'manager', password: DEMO_PASSWORD, pin: '1111', disabled: false },
  { id: 'u-youssef', displayName: 'يوسف', username: 'youssef', role: 'sales', password: DEMO_PASSWORD, pin: '2222', disabled: false },
  { id: 'u-marina', displayName: 'مارينا', username: 'marina', role: 'sales', password: DEMO_PASSWORD, pin: '3333', disabled: false },
];

const departments: DemoDepartment[] = [
  { id: 'd-chg', name: 'شواحن وكابلات', sortOrder: 0, status: 'active' },
  { id: 'd-aud', name: 'سماعات', sortOrder: 1, status: 'active' },
  { id: 'd-prt', name: 'حماية وجرابات', sortOrder: 2, status: 'active' },
  { id: 'd-crd', name: 'كروت وشحن', sortOrder: 3, status: 'active' },
  { id: 'd-acc', name: 'إكسسوارات تانية', sortOrder: 4, status: 'active' },
];

const p = (
  name: string,
  price: number | null,
  onHand: number,
  sold: number,
  dept: string | null,
  barcode: string | null = null,
  disposition: DemoProduct['disposition'] = 'quantity'
): DemoProduct => ({
  id: newId('p'),
  name,
  disposition,
  barcode,
  salePriceMinor: price === null ? null : price * 100,
  departmentId: dept,
  onHand,
  totalCostMinor: price === null ? onHand * 500 : Math.round(price * 100 * 0.7) * onHand,
  soldRecently: sold,
  status: 'active',
});

const products: DemoProduct[] = [
  p('شاحن سامسونج 25 وات أصلي', 350, 14, 22, 'd-chg', '8806090000011'),
  p('شاحن آيفون 20 وات', 450, 9, 18, 'd-chg', '1942530000027'),
  p('كابل تايب سي 1 متر', 80, 40, 51, 'd-chg', '6901234500013'),
  p('كابل لايتنينج أنكر', 150, 12, 9, 'd-chg'),
  p('باور بانك 10000 مللي', 650, 6, 7, 'd-chg'),
  p('سماعة بلوتوث JBL Tune', 1250, 4, 5, 'd-aud'),
  p('سماعة سلك سامسونج', 120, 25, 16, 'd-aud'),
  p('ايربودز برو', 600, 2, 11, 'd-aud'),
  p('اسكرينة زجاج آيفون 13', 75, 60, 44, 'd-prt', '6970000000135'),
  p('اسكرينة نانو سامسونج A54', 60, 35, 20, 'd-prt'),
  p('جراب سيليكون آيفون 13', 90, 18, 27, 'd-prt'),
  p('جراب شفاف سامسونج A15', 50, 30, 19, 'd-prt'),
  p('كارت شحن فودافون 50', 50, 100, 80, 'd-crd'),
  p('كارت شحن أورنج 25', 25, 100, 35, 'd-crd'),
  p('كارت ميموري 64 جيجا', 250, 10, 6, 'd-acc'),
  p('فلاشة 32 جيجا', 180, 0, 4, 'd-acc'),
  p('حامل موبايل للعربية', 220, 5, 3, 'd-acc'),
  p('ساعة ذكية T500', 550, 3, 2, 'd-acc'),
  p('وصلة OTG', null, 8, 0, 'd-acc'),
  p('موبايل سامسونج A15', 7500, 3, 0, null, null, 'serialized'),
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
  status: x.status,
  createdBy: 'u-peter',
  updatedBy: 'u-peter',
  createdAt: 0,
  updatedAt: 0,
});

const departmentDto = (d: DemoDepartment) => ({
  id: d.id,
  name: d.name,
  status: d.status,
  costMethod: 'moving_average',
  vat: { enabled: false, rateBp: null, inclusive: false },
  sortOrder: d.sortOrder,
  createdBy: 'u-peter',
  updatedBy: 'u-peter',
  createdAt: 0,
  updatedAt: 0,
  archivedAt: d.status === 'archived' ? 0 : null,
});

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
          departmentId: x.departmentId,
          onHand: x.onHand,
          soldRecently: x.soldRecently,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ar')),
      departments: departments
        .filter((d) => d.status === 'active')
        .map((d) => ({ id: d.id, name: d.name, sortOrder: d.sortOrder })),
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
      departmentId: null,
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
  list_departments: () => {
    requireManager();
    return [...departments].sort((a, b) => a.sortOrder - b.sortOrder).map(departmentDto);
  },
  get_department: (args) => departmentDto(departments.find((d) => d.id === str(args, 'id')) ?? fail('DEPARTMENT_NOT_FOUND')),
  create_department: (args) => {
    requireManager();
    const d: DemoDepartment = { id: newId('d'), name: str(args, 'name'), sortOrder: departments.length, status: 'active' };
    departments.push(d);
    return departmentDto(d);
  },
  update_department: (args) => {
    requireManager();
    const d = departments.find((x) => x.id === str(args, 'id')) ?? fail('DEPARTMENT_NOT_FOUND');
    d.name = str(args, 'name') || d.name;
    return departmentDto(d);
  },
  set_department_archived: (args) => {
    requireManager();
    const d = departments.find((x) => x.id === str(args, 'id')) ?? fail('DEPARTMENT_NOT_FOUND');
    d.status = args?.['archived'] === true ? 'archived' : 'active';
    return departmentDto(d);
  },
  reorder_departments: (args) => {
    requireManager();
    const ids = (args?.['orderedIds'] as string[] | undefined) ?? [];
    ids.forEach((id, at) => {
      const d = departments.find((x) => x.id === id);
      if (d !== undefined) d.sortOrder = at;
    });
    return [...departments].sort((a, b) => a.sortOrder - b.sortOrder).map(departmentDto);
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
  get_pattern_status: () => ({ enabled: false, configured: false }),
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
      // Not part of the demo (backups, the Pattern, user changes): refused, so
      // nothing pretends to have happened.
      throw { code: 'DEMO_UNAVAILABLE' };
    }
    return handler(args as Args);
  });
}

/** Shown on the sign-in card of the demo only. */
export const DEMO_HINT = `للتجربة بس: كلمة السر لكل الحسابات ${DEMO_PASSWORD}. البيانات وهمية ومش بتتحفظ.`;
