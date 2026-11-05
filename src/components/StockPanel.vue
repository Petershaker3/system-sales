<script setup lang="ts">
// «الاستلام» — one screen that answers one question: **إيه اللي وصل المحل؟**
// (`0035`, 2026-11-05.)
//
// The shopkeeper does not think in «create a product, then receive stock». He
// thinks «وصلت ٥ من الـA16 ده، المورد فلان، فاتورة ٤٤٢». So this panel does both
// in one write, in one transaction: a brand-new model or accessory can be created
// right here, and the pieces that came with it land on it.
//
// # Three doors, never mixed
//
// 1. **بضاعة جديدة** — a delivery: a new model/accessory, or more of an existing
//    one. This is the only door that names a supplier, an invoice and a cost.
// 2. **موبايل مستعمل** — one device with its own condition, cost and seller. It
//    stays a unit (`ADR-032`), never a quantity.
// 3. **تسويات** — what is on the shelf is wrong: damaged, lost, or a miscount.
//    Not a purchase, so it takes a reason instead of a supplier.
//
// The three were mixed in «خصم كمية» sitting under «استلام بضاعة», which read as
// if removing stock were a way of receiving it.
//
// # What is preserved from the previous panel
//
// Receiving a delivery is `Routine` (`ADR-015`) and reading cost needs the manager
// password (`ADR-013`), so the position stays behind «عرض المخزن». Opening stock
// is `Sensitive` and spends one owner PIN — once for the whole document now,
// instead of once per line.

import { computed, nextTick, onMounted, ref, watch } from 'vue';

import * as catalog from '../api/catalog';
import type { Product } from '../api/catalog';
import { listCategories } from '../api/categories';
import type { CategoryEntry } from '../api/categories';
import { listBrands } from '../api/brands';
import type { BrandEntry } from '../api/brands';
import { describeError } from '../api/errors';
import * as inventory from '../api/inventory';
import type { ProductUnit, ReceiptRow, StockPosition } from '../api/inventory';
import * as lifecycle from '../api/lifecycle';
import * as posApi from '../api/pos';
import type { PosProduct } from '../api/pos';
import { shortagesOverview } from '../api/shortages';
import { deliveryFormProblem, piecesProblem } from '../screens/store/receiving';
import { imeiLuhn, normalizeImeiDigits } from '../screens/pos/imei';
import { formatArrivedToast } from '../screens/store/shortages';
import { withOwnerApproval } from '../shell/approval';
import { skipsPasswordReauth } from '../shell/open-mode';
import { appearance } from '../ui/appearance';
import { money, moneyUnitWord, num, parseMoney } from '../ui/format';
import CameraScanButton from '../ui/CameraScanButton.vue';
import Icon from '../ui/Icon.vue';
import type { ScanReading } from '../ui/scan';
import { toast } from '../ui/toast';

/**
 * A product to hand over to the receive form, by id (`StoreScreen` sets it when
 * the shop codes a phone, or when «+ مخزون» is pressed on a row).
 */
const props = defineProps<{ selectProduct?: string }>();

const emit = defineEmits<{
  'new-item': [];
  received: [productId: string];
  'open-used': [];
}>();

/** Which of the three doors is open (`0035`). */
const door = ref<'delivery' | 'adjust'>('delivery');

// --- product picker --------------------------------------------------------

const products = ref<Product[]>([]);
const posById = ref<Map<string, PosProduct>>(new Map());
const search = ref('');
const selectedProductId = ref('');

/**
 * «صنف موجود» or «صنف/موديل جديد» inside the delivery door.
 *
 * Both end in the same save: Rust creates the product and receives the pieces in
 * one transaction, so a model can never be left registered with no delivery
 * against it.
 */
const source = ref<'existing' | 'new'>('existing');
const newKind = ref<'phone' | 'item'>('phone');

const categories = ref<CategoryEntry[]>([]);
const brands = ref<BrandEntry[]>([]);

const phoneCategories = computed(() =>
  categories.value.filter((category) => category.kind === 'phone' && !category.hidden)
);
const itemCategories = computed(() => {
  const out: CategoryEntry[] = [];
  for (const main of categories.value.filter((c) => c.parentId === null && c.kind === 'item')) {
    const subs = categories.value.filter((c) => c.parentId === main.id);
    out.push(...(subs.length > 0 ? subs : [main]));
  }
  return out;
});

const newPhone = ref({
  categoryId: '',
  brandId: '',
  model: '',
  deviceType: 'touch' as 'touch' | 'keypad',
  storageGb: '128',
  ramGb: '',
  price: '',
});
const newItem = ref({ name: '', categoryId: '', price: '' });

const brandChoices = computed(() =>
  brands.value.filter((brand) => !brand.hidden && brand.deviceType !== 'both'
    ? brand.deviceType === newPhone.value.deviceType
    : !brand.hidden)
);

// --- movement forms --------------------------------------------------------

const receiptMode = ref<'supplier' | 'opening'>('supplier');
const receiveQuantity = ref('');
/**
 * Who delivered this lot (decision D1): a label the operator types, optional.
 * There is no supplier registry and no purchase document — the shop's supplier
 * list is read back off the receipts themselves.
 */
const receiveSupplier = ref('');
const receiveUnitCost = ref('');
/** The supplier's own invoice number, as printed on the paper that came with it. */
const receiveDocumentRef = ref('');
/** The day the goods were bought, `YYYY-MM-DD`. Empty means «today». */
const receivePurchaseDate = ref('');
/** One free line about this delivery. */
const receiveNote = ref('');
const imeiDraft = ref('');
const receiveImeis = ref<string[]>([]);

/**
 * سطر في «توريد واحد» قبل الحفظ.
 *
 * صاحب المحل بيستلم الشحنة كلها مرة واحدة (٥ أصناف مثلًا) وبيعمل التوريد بعد ما
 * يخلص، مش صنف صنف بحفظ منفصل. كل سطر بيقفل على اللي اتكتب وقت إضافته — الصنف
 * والكمية والتكلفة وأرقام الـIMEI — فالتعديل بعد كده في الفورم مش بيغيّر سطر
 * اتضاف. والحفظ بقى **ترانزاكشن واحدة**: يا الشحنة كلها يا مفيش حاجة (`0035`).
 */
interface PendingReceipt {
  readonly key: number;
  readonly productId: string | null;
  readonly productName: string;
  readonly quantity: number;
  readonly unitCost: number;
  readonly supplier: string;
  readonly mode: 'supplier' | 'opening';
  readonly imeis: readonly string[];
  readonly documentRef?: string;
  readonly purchaseDate?: string;
  readonly note?: string;
  readonly newItem?: { name: string; categoryId: string | null; salePriceMinor: number | null };
  readonly newPhone?: {
    categoryId: string;
    brandId: string;
    model: string;
    deviceType: 'touch' | 'keypad';
    storageGb: number | null;
    ramGb: number | null;
    salePriceMinor: number | null;
  };
}

const pendingReceipts = ref<PendingReceipt[]>([]);
let pendingKey = 0;

const pendingPieces = computed(() =>
  pendingReceipts.value.reduce((sum, line) => sum + line.quantity, 0)
);

const pendingTotalMinor = computed(() =>
  pendingReceipts.value.reduce((sum, line) => sum + line.quantity * line.unitCost, 0)
);

function removePending(key: number): void {
  pendingReceipts.value = pendingReceipts.value.filter((line) => line.key !== key);
}
const removeQuantity = ref('');
const removeReason = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);

const filteredProducts = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase('ar');
  if (needle === '') return products.value;
  return products.value.filter((product) =>
    product.name.toLocaleLowerCase('ar').includes(needle)
  );
});

const selectedProduct = computed(
  () => products.value.find((product) => product.id === selectedProductId.value) ?? null
);

const selectedIsSerial = computed(() => {
  const p = selectedProduct.value;
  if (p === null) return false;
  if (p.disposition === 'serialized') return true;
  const posProd = posById.value.get(p.id);
  return (
    posProd !== undefined &&
    (posProd.tracking === 'serial_optional' ||
      posProd.tracking === 'serial_required' ||
      posProd.brandId !== null)
  );
});

/** The pieces this form would add, or `null` when the box is not a number yet. */
const typedQuantity = computed(() => parseNonNegativeInteger(receiveQuantity.value));

/** «الحالي ٤ + الجديد ٣ = ٧» — the sentence the panel was missing (`0035`). */
const expectedQuantity = computed<number | null>(() => {
  const typed = typedQuantity.value;
  if (typed === null || typed < 1) return null;
  if (source.value === 'new') return typed;
  if (position.value === null) return null;
  return position.value.quantity + typed;
});

const typedCostMinor = computed(() => parseMoney(receiveUnitCost.value));

const typedLineTotalMinor = computed<number | null>(() => {
  const typed = typedQuantity.value;
  const cost = typedCostMinor.value;
  if (typed === null || typed < 1 || cost === null || cost < 0) return null;
  return typed * cost;
});

/**
 * Land the product a row handed over («+ مخزون») in the form, and put the cursor
 * on whatever the next real step is.
 *
 * The cost of a product is a secret the panel reveals on purpose (`ADR-013`), so
 * for a shop with accounts the quantity box does not exist yet — the hand-off
 * stops at «عرض المخزن» with the field focused. An open shop (`ADR-039`) has no
 * password to prove, so the walk goes the whole way into the quantity box. Never
 * pre-filled: the quantity and the unit cost are what only the shopkeeper knows.
 */
async function handTheNewProductOver(prods: catalog.Product[]): Promise<void> {
  const id = props.selectProduct;
  if (!id || !prods.some((p) => p.id === id)) return;
  source.value = 'existing';
  selectedProductId.value = id;
  if (skipsPasswordReauth()) {
    await loadPosition().catch(() => undefined);
  }
  await nextTick();
  (document.getElementById('stock-qty') ?? document.getElementById('stock-reveal'))?.focus();
}

async function loadPickers(): Promise<void> {
  busy.value = true;
  let prods: catalog.Product[] = [];
  try {
    const [list, cat, cats, brandList] = await Promise.all([
      catalog.listProducts('active'),
      posApi.posCatalog().catch(() => null),
      listCategories().catch(() => [] as CategoryEntry[]),
      listBrands().catch(() => [] as BrandEntry[]),
    ]);
    products.value = list;
    prods = list;
    categories.value = cats;
    brands.value = brandList;
    if (cat) {
      posById.value = new Map(cat.products.map((p) => [p.id, p]));
    }
    if (newPhone.value.categoryId === '') {
      newPhone.value.categoryId = phoneCategories.value[0]?.id ?? '';
    }
    if (newPhone.value.brandId === '') {
      newPhone.value.brandId = brands.value.find((b) => !b.hidden)?.id ?? '';
    }
    if (newItem.value.categoryId === '') {
      newItem.value.categoryId = itemCategories.value[0]?.id ?? '';
    }
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
  // After `busy` is released, not before: the reveal button is `:disabled="busy"`, and a
  // focus call on a disabled control does nothing — which is the difference between the
  // cursor landing on the shopkeeper's next step and landing nowhere.
  await handTheNewProductOver(prods);
}

// --- the read-only position ------------------------------------------------

const position = ref<StockPosition | null>(null);
const units = ref<ProductUnit[]>([]);
const showReauth = ref(false);
const reauthPassword = ref('');

/**
 * Load the position, asking for the password first.
 *
 * `withReauth` is the same shape `SettingsPanel` uses: the password is proven
 * once, the operation runs, and the field is cleared either way.
 */
async function withReauth(action: () => Promise<void>): Promise<void> {
  if (skipsPasswordReauth()) {
    // `ADR-039`: a shop that has not claimed an account has no password to prove,
    // and its session already stands at the assurance this modal exists to reach.
    await action();
    return;
  }
  reauthPassword.value = '';
  error.value = '';
  showReauth.value = true;
  pendingReauth.value = action;
}

const pendingReauth = ref<(() => Promise<void>) | null>(null);

async function confirmReauth(): Promise<void> {
  const action = pendingReauth.value;
  if (action === null) return;
  busy.value = true;
  try {
    await lifecycle.reauthenticate(reauthPassword.value);
    showReauth.value = false;
    reauthPassword.value = '';
    pendingReauth.value = null;
    await action();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function loadUnits(): Promise<void> {
  if (selectedProductId.value === '' || !selectedIsSerial.value) {
    units.value = [];
    return;
  }
  try {
    units.value = await inventory.listProductUnits(selectedProductId.value);
  } catch {
    units.value = [];
  }
}

async function loadPosition(): Promise<void> {
  if (selectedProductId.value === '') {
    error.value = 'اختر منتجًا أولًا.';
    return;
  }
  position.value = await inventory.getPosition(selectedProductId.value);
  await loadUnits();
  await loadHistory();
}

async function refreshPosition(): Promise<void> {
  if (selectedProductId.value === '' || position.value === null) return;
  try {
    position.value = await inventory.getPosition(selectedProductId.value);
    await loadUnits();
    await loadHistory();
  } catch {
    // The panel still shows what it has; a stale position is better than a
    // cleared screen, and the next explicit load reports any real problem.
  }
}

/** The last deliveries of the selected product — its own purchase history (`0035`). */
const history = ref<readonly ReceiptRow[]>([]);

/** The rows that carry the operator's own words, so no empty «ملاحظة :» is printed. */
const historyWithNote = computed(() => history.value.filter((row) => (row.note ?? '') !== ''));

async function loadHistory(): Promise<void> {
  if (selectedProductId.value === '') {
    history.value = [];
    return;
  }
  try {
    history.value = await inventory.listReceipts(20, selectedProductId.value);
  } catch {
    history.value = [];
  }
}

watch(selectedProductId, async () => {
  imeiDraft.value = '';
  receiveImeis.value = [];
  error.value = '';
  // The notice survives a selection on purpose: receiving a brand-new product ends
  // by selecting it, and «تم الاستلام» would be wiped by the very line that
  // received it.
  if (selectedProductId.value === '') {
    position.value = null;
    units.value = [];
    history.value = [];
    return;
  }
  if (position.value !== null) {
    await refreshPosition();
  } else {
    // A delivery can be recorded without revealing cost: `receive_document` does
    // not need the price of what is already on the shelf. The position is what
    // shows the expected balance, so it is offered rather than forced.
    await loadHistory();
  }
});

// --- IMEI entry on receive -------------------------------------------------

/**
 * One camera reading fills the IMEI draft and enters the batch, so the shopkeeper
 * scans the box and moves on — the same checks (15 digits, Luhn, duplicates) run as
 * if the number had been typed.
 */
function onImeiScan(reading: ScanReading): void {
  imeiDraft.value = reading.digits === '' ? reading.raw : reading.digits;
  addImeiToBatch();
}

function addImeiToBatch(): void {
  const digits = normalizeImeiDigits(imeiDraft.value);
  if (digits === '') return;
  if (!/^\d{15}$/.test(digits)) {
    error.value = 'رقم الـ IMEI لازم يكون 15 رقم بالظبط.';
    return;
  }
  if (!imeiLuhn(digits)) {
    error.value = 'رقم الـ IMEI فيه رقم غلط (فحص Luhn).';
    return;
  }
  if (receiveImeis.value.includes(digits)) {
    error.value = 'الـ IMEI ده مضاف بالفعل في الدفعة دي.';
    return;
  }
  if (units.value.some((u) => u.imei === digits || u.imei2 === digits)) {
    error.value = 'الـ IMEI ده متسجّل بالفعل في المخزن.';
    return;
  }
  receiveImeis.value.push(digits);
  imeiDraft.value = '';
  error.value = '';
  const currentQty = parseNonNegativeInteger(receiveQuantity.value) ?? 0;
  if (receiveImeis.value.length > currentQty) {
    receiveQuantity.value = String(receiveImeis.value.length);
  }
}

function removeImeiFromBatch(idx: number): void {
  receiveImeis.value.splice(idx, 1);
}

/**
 * Give one loose piece on the shelf its real IMEI (`0035`).
 *
 * The shop's rule is that an IMEI is never mandatory, so phones arrive as pieces.
 * When the number turns up later this registers the identity without touching the
 * balance: the piece was already counted and already cost what it cost.
 */
const unitImeiDraft = ref('');

async function registerStockUnitImei(): Promise<void> {
  const digits = normalizeImeiDigits(unitImeiDraft.value);
  if (!/^\d{15}$/.test(digits) || !imeiLuhn(digits)) {
    error.value = 'رقم الـ IMEI لازم يكون 15 رقم وصحح فحص Luhn.';
    return;
  }
  busy.value = true;
  notice.value = '';
  try {
    await inventory.registerStockUnit(selectedProductId.value, digits);
    unitImeiDraft.value = '';
    notice.value = 'اتسجّل الـ IMEI على جهاز من اللي في المخزن — الرصيد ما اتغيّرش.';
    await loadUnits();
    await refreshPosition();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- receive / remove ------------------------------------------------------

function parseNonNegativeInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function parseOptionalDate(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
}

/** اقرأ الفورم الحالي كسطر توريد، أو `null` مع رسالة لو فيه حاجة ناقصة. */
function readReceiptForm(): Omit<PendingReceipt, 'key' | 'productName'> | null {
  const quantity = parseNonNegativeInteger(receiveQuantity.value);
  // The cost box says «سعر الوحدة (ج.م)», so it is read the way every other money box
  // in the app is read: `parseMoney` turns what the shopkeeper types in the shop's own
  // unit into piastres. Reading it as a plain integer made «8000» mean 80 EGP — a
  // hundredfold error on the one figure the whole costing chain starts from, and it
  // only showed up on the receipt afterwards.
  const unitCost = parseMoney(receiveUnitCost.value);

  // Which new thing, if any, this line is describing — its own fields still have to
  // make sense before the delivery can be checked as a whole.
  const creating = source.value === 'new';
  const newNameProblem = creating
    ? newKind.value === 'phone'
      ? newPhone.value.categoryId === ''
        ? 'مفيش تصنيف للموبايلات. ضيف واحد من الإعدادات.'
        : newPhone.value.brandId === ''
          ? 'اختار الشركة.'
          : newPhone.value.model.trim() === ''
            ? 'اكتب الموديل.'
            : ''
      : newItem.value.name.trim() === ''
        ? 'اكتب اسم الصنف.'
        : ''
    : '';

  // The form's own rules live in `receiving.ts`, tested without a browser: the same
  // ones `0035` enforces in Rust, said while the box is still on screen.
  const paperworkProblem = deliveryFormProblem({
    existingProduct: !creating,
    hasProduct: selectedProductId.value !== '',
    creating,
    newNameProblem,
    quantity: receiveQuantity.value,
    unitCost: receiveUnitCost.value,
    purchaseDate: receiptMode.value === 'supplier' ? receivePurchaseDate.value : '',
    reference: receiptMode.value === 'supplier' ? receiveDocumentRef.value : '',
    note: receiveNote.value,
    imeiCount: receiveImeis.value.length,
    imeiRequired: appearance.imeiMode === 'required',
    serial: selectedIsSerial.value || creating,
  });
  if (paperworkProblem !== '') {
    error.value = paperworkProblem;
    return null;
  }
  if (quantity === null || unitCost === null) return null;
  const purchaseDate = parseOptionalDate(receivePurchaseDate.value.trim());

  const shared = {
    quantity,
    unitCost,
    supplier: receiptMode.value === 'supplier' ? receiveSupplier.value.trim() : '',
    mode: receiptMode.value,
    imeis: selectedIsSerial.value ? [...receiveImeis.value] : [],
    documentRef: receiptMode.value === 'supplier' ? receiveDocumentRef.value.trim() : '',
    purchaseDate: receiptMode.value === 'supplier' ? purchaseDate ?? '' : '',
    note: receiveNote.value.trim(),
  } as const;

  if (source.value === 'new') {
    const priceMinor =
      newKind.value === 'phone'
        ? parseTypedPrice(newPhone.value.price)
        : parseTypedPrice(newItem.value.price);
    if (newKind.value === 'phone') {
      const phone = newPhone.value;
      const storage = parseNonNegativeInteger(phone.storageGb);
      const ram = phone.ramGb.trim() === '' ? null : parseNonNegativeInteger(phone.ramGb);
      return {
        ...shared,
        productId: null,
        newPhone: {
          categoryId: phone.categoryId,
          brandId: phone.brandId,
          model: phone.model.trim(),
          deviceType: phone.deviceType,
          storageGb: storage,
          ramGb: ram,
          salePriceMinor: priceMinor !== null && priceMinor > 0 ? priceMinor : null,
        },
      };
    }
    return {
      ...shared,
      productId: null,
      newItem: {
        name: newItem.value.name.trim(),
        categoryId: newItem.value.categoryId === '' ? null : newItem.value.categoryId,
        salePriceMinor: priceMinor !== null && priceMinor > 0 ? priceMinor : null,
      },
    };
  }

  return { ...shared, productId: selectedProductId.value };
}

/** امسح الفورم بعد ما السطر اتحفظ أو اتضاف: التوريد الجاي حاجة تانية. */
function resetReceiptForm(): void {
  receiveQuantity.value = '';
  receiveUnitCost.value = '';
  imeiDraft.value = '';
  receiveImeis.value = [];
  error.value = '';
}

function lineName(line: Omit<PendingReceipt, 'key' | 'productName'>): string {
  if (line.newPhone) {
    const brand = brands.value.find((b) => b.id === line.newPhone?.brandId);
    const storage = line.newPhone.storageGb === null ? '' : ` ${line.newPhone.storageGb}GB`;
    return `${brand?.name ?? ''} ${line.newPhone.model}${storage}`.trim();
  }
  if (line.newItem) return line.newItem.name;
  return selectedProduct.value?.name ?? line.productId ?? '';
}

/** حوّل سطر الشحنة للشكل اللي Rust بياخده. */
function toInput(line: PendingReceipt): inventory.ReceiveLineInput {
  return {
    productId: line.productId,
    newItem: line.newItem
      ? { name: line.newItem.name, categoryId: line.newItem.categoryId, salePriceMinor: line.newItem.salePriceMinor }
      : null,
    newPhone: line.newPhone ?? null,
    quantity: line.quantity,
    unitCostMinor: line.unitCost,
    imeis: [...line.imeis],
  };
}

/** استلم سطر واحد فعلاً. */
async function receiveLines(lines: readonly PendingReceipt[]): Promise<string[]> {
  const first = lines[0];
  if (first === undefined) return [];
  const productIds = lines.map((line) => line.productId).filter((id): id is string => id !== null);
  const preShortages = await shortagesOverview()
    .then((ov) => ov.items.filter((sh) => sh.productId !== null && productIds.includes(sh.productId)))
    .catch(() => []);

  const paperwork: inventory.ReceiptPaperwork = {
    supplierName: first.supplier === '' ? null : first.supplier,
    documentRef: first.documentRef === '' ? null : first.documentRef ?? null,
    purchaseDate: first.purchaseDate === '' ? null : first.purchaseDate ?? null,
    note: first.note === '' ? null : first.note ?? null,
  };
  const inputs = lines.map(toInput);

  let saved: inventory.ReceivedDocument;
  if (first.mode === 'opening') {
    const approved = await withOwnerApproval(
      () => inventory.receiveDocument('opening', paperwork, inputs),
      'تسجيل بضاعة أول المدة'
    );
    if (approved.status === 'cancelled') return [];
    saved = approved.value;
  } else {
    saved = await inventory.receiveDocument('supplier', paperwork, inputs);
  }

  for (const sh of preShortages) {
    toast(formatArrivedToast(sh), 'ok');
  }
  const last = saved.lines[saved.lines.length - 1];
  notice.value = `تم الاستلام. الرصيد الآن ${last?.quantity ?? saved.totalQuantity}.`;
  for (const written of saved.lines) emit('received', written.productId);
  return saved.lines.map((written) => written.productId);
}

async function submitReceive(): Promise<void> {
  const line = readReceiptForm();
  if (line === null) return;
  busy.value = true;
  notice.value = '';
  const savedIds: string[] = [];
  try {
    const row: PendingReceipt = { key: pendingKey++, productName: lineName(line), ...line };
    savedIds.push(...(await receiveLines([row])));
    resetReceiptForm();
    if (line.newPhone || line.newItem) {
      // A brand-new product: the form goes back to «موجود» on what was just
      // created, so the next delivery of the same model is one click.
      await loadPickers();
      const first = savedIds[0];
      if (first !== undefined) {
        source.value = 'existing';
        selectedProductId.value = first;
        position.value = null;
        await loadPosition().catch(() => undefined);
      }
    } else {
      await refreshPosition();
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/**
 * «أضف للتوريد»: صنف تاني في نفس الشحنة.
 *
 * من غير حفظ: السطر بيقف في القائمة تحت، و«احفظ التوريد» هو اللي بيكتبهم كلهم —
 * في ترانزاكشن واحدة (`0035`).
 */
function addToBatch(): void {
  const line = readReceiptForm();
  if (line === null) return;
  pendingReceipts.value = [
    ...pendingReceipts.value,
    {
      key: pendingKey++,
      productName: lineName(line),
      ...line,
    },
  ];
  if (line.newPhone || line.newItem) {
    // A new product cannot be added twice under one name; the cart keeps the
    // whole description so the save creates it once.
    newPhone.value.model = '';
    newItem.value.name = '';
  }
  resetReceiptForm();
  notice.value = 'اتضاف سطر للتوريد — كمّل باقي الأصناف أو احفظ.';
}

/**
 * حفظ الشحنة كلها: ترانزاكشن واحدة (`0035`).
 *
 * قبل التغيير ده كان كل سطر بيتحفظ لوحده، فشحنة خمسة أصناف كانت بتقبل أربعة لو
 * الخامس فشل. دلوقتي يا الشحنة كلها يا مفيش حاجة، ومفيش رسالة نجاح جزئي.
 */
async function saveBatch(): Promise<void> {
  if (pendingReceipts.value.length === 0 || busy.value) return;
  busy.value = true;
  notice.value = '';
  const lines = [...pendingReceipts.value];
  try {
    await receiveLines(lines);
    pendingReceipts.value = [];
    notice.value = `اتحفظ توريد ${num(lines.length)} صنف (${num(
      lines.reduce((sum, line) => sum + line.quantity, 0)
    )} قطعة) مرة واحدة.`;
    await loadPickers();
    await refreshPosition();
  } catch (err) {
    // Nothing was written: the whole document was refused, so the cart stays
    // exactly as the shopkeeper built it (`0035`).
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function submitRemove(): Promise<void> {
  const quantity = parseNonNegativeInteger(removeQuantity.value);
  const quantityWhy = piecesProblem(removeQuantity.value);
  if (quantityWhy !== '') {
    error.value = quantityWhy;
    return;
  }
  if (quantity === null) return;
  if (removeReason.value.trim() === '') {
    error.value = 'اكتب سبب الخصم: تالف، ولا فقدان، ولا فرق جرد.';
    return;
  }

  busy.value = true;
  notice.value = '';
  try {
    const outcome = await inventory.removeStock(
      selectedProductId.value,
      quantity,
      removeReason.value.trim()
    );
    notice.value = `تم الخصم (${removeReason.value.trim()}). تكلفة الكمية ${formatPiastres(
      outcome.costMinor
    )} والرصيد ${outcome.quantity}.`;
    removeQuantity.value = '';
    removeReason.value = '';
    error.value = '';
    await refreshPosition();
  } catch (err) {
    // A refused removal changes nothing, so the position on screen is still
    // correct and there is nothing to refresh.
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- labels ----------------------------------------------------------------

/** Piastres to a readable amount. Display only; never fed back into arithmetic. */
function formatPiastres(minor: number | null): string {
  if (minor === null) return '—';
  const whole = Math.trunc(minor / 100);
  const rest = Math.abs(minor % 100);
  return money(whole * 100 + rest);
}

/** A price box that is empty or unreadable: say «بدون سعر» rather than zero. */
function parseTypedPrice(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed === '' ? null : parseMoney(trimmed);
}

function shortDate(day: string | null | undefined): string {
  if (day === null || day === undefined || day === '') return '';
  return day;
}

onMounted(() => {
  void loadPickers();
});
void loadPickers;
</script>

<template>
  <section class="stock">
    <div class="stock-head">
      <h2 class="stock-title">الاستلام والتسويات</h2>
      <span class="sp"></span>
      <button type="button" class="btn sm soft" @click="emit('new-item')">
        <Icon name="package-plus" /> صنف جديد
      </button>
    </div>

    <!-- التلات أبواب -->
    <div class="inv-seg door-seg" role="tablist" aria-label="نوع العملية" data-receive-doors>
      <button
        type="button"
        role="tab"
        :aria-selected="door === 'delivery'"
        :class="{ active: door === 'delivery' }"
        data-receive-door="delivery"
        @click="door = 'delivery'"
      >
        <Icon name="arrow-down-to-line" /> بضاعة جديدة
      </button>
      <!--
        «موبايل مستعمل» is a door of its own but not a form of its own: a used phone
        is one device with its own seller, condition and paper (`ADR-032`), and that
        intake already exists. The door opens it rather than repeating it here.
      -->
      <button type="button" role="tab" data-receive-door="used" @click="emit('open-used')">
        <Icon name="recycle" /> موبايل مستعمل
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="door === 'adjust'"
        :class="{ active: door === 'adjust' }"
        data-receive-door="adjust"
        @click="door = 'adjust'"
      >
        <Icon name="receipt-text" /> تسويات
      </button>
    </div>

    <!-- ===================== ١) بضاعة جديدة ===================== -->
    <template v-if="door === 'delivery'">
      <div class="inv-seg src-seg" role="tablist" aria-label="المصدر">
        <button
          type="button"
          role="tab"
          :class="{ active: source === 'existing' }"
          data-receive-source="existing"
          @click="source = 'existing'"
        >
          صنف موجود عندي
        </button>
        <button
          type="button"
          role="tab"
          :class="{ active: source === 'new' }"
          data-receive-source="new"
          @click="source = 'new'"
        >
          <Icon name="plus" /> صنف/موديل جديد
        </button>
      </div>

      <!-- صنف موجود: بحث + اختيار -->
      <template v-if="source === 'existing'">
        <label class="field">
          <span>دوّر على الصنف</span>
          <input
            v-model="search"
            data-receive-search
            autocomplete="off"
            placeholder="اكتب اسم الصنف…"
          />
        </label>
        <label class="field">
          <span>المنتج</span>
          <select id="stock-product" v-model="selectedProductId">
            <option value="">— اختر منتجًا —</option>
            <option v-for="product in filteredProducts" :key="product.id" :value="product.id">
              {{ product.name }}
            </option>
          </select>
        </label>
      </template>

      <!-- صنف/موديل جديد: يتعمل جوه نفس الاستلام -->
      <template v-else>
        <div class="inv-seg" role="tablist" aria-label="نوع الصنف الجديد">
          <button
            type="button"
            role="tab"
            :class="{ active: newKind === 'phone' }"
            data-new-kind="phone"
            @click="newKind = 'phone'"
          >
            موبايل
          </button>
          <button
            type="button"
            role="tab"
            :class="{ active: newKind === 'item' }"
            data-new-kind="item"
            @click="newKind = 'item'"
          >
            إكسسوار / صنف بالعدد
          </button>
        </div>

        <template v-if="newKind === 'phone'">
          <div class="grid2">
            <label class="field">
              <span>الشركة</span>
              <select v-model="newPhone.brandId" data-new-phone-brand>
                <option v-for="brand in brandChoices" :key="brand.id" :value="brand.id">
                  {{ brand.name }}
                </option>
              </select>
            </label>
            <label class="field">
              <span>الموديل</span>
              <input v-model="newPhone.model" data-new-phone-model autocomplete="off" />
            </label>
            <label class="field">
              <span>النوع</span>
              <select v-model="newPhone.deviceType" data-new-phone-type>
                <option value="touch">تانش</option>
                <option value="keypad">زراير</option>
              </select>
            </label>
            <label class="field">
              <span>المساحة (GB)</span>
              <input v-model="newPhone.storageGb" inputmode="numeric" data-new-phone-storage />
            </label>
            <label class="field">
              <span>الرام (اختياري)</span>
              <input v-model="newPhone.ramGb" inputmode="numeric" />
            </label>
            <label class="field">
              <span>سعر البيع (اختياري)</span>
              <input
                v-model="newPhone.price"
                inputmode="decimal"
                data-new-phone-price
                placeholder="سيبه فاضي وهيتحدد وقت البيع"
              />
            </label>
          </div>
        </template>
        <template v-else>
          <div class="grid2">
            <label class="field">
              <span>اسم الصنف</span>
              <input v-model="newItem.name" data-new-item-name autocomplete="off" />
            </label>
            <label class="field">
              <span>التصنيف</span>
              <select v-model="newItem.categoryId" data-new-item-category>
                <option value="">بدون تصنيف</option>
                <option v-for="category in itemCategories" :key="category.id" :value="category.id">
                  {{ category.name }}
                </option>
              </select>
            </label>
            <label class="field">
              <span>سعر البيع (اختياري)</span>
              <input
                v-model="newItem.price"
                inputmode="decimal"
                data-new-item-price
                placeholder="سيبه فاضي وهيتحدد وقت البيع"
              />
            </label>
          </div>
        </template>
      </template>

      <!-- الحالي / المتوقع: يتأكد قبل الحفظ -->
      <div v-if="source === 'existing'" class="pos-gate">
        <div v-if="!position" class="gate">
          <p class="hint">عرض رصيد المنتج وتكلفته يتطلب تأكيد هوية المدير.</p>
          <button
            id="stock-reveal"
            type="button"
            :disabled="busy || selectedProductId === ''"
            @click="withReauth(loadPosition)"
          >
            عرض المخزن
          </button>
        </div>
        <dl v-else class="facts position">
          <dt>الرصيد الحالي</dt>
          <dd class="num" data-receive-current>{{ num(position.quantity) }}</dd>
          <dt>إجمالي التكلفة (متوسط مرجح)</dt>
          <dd>{{ formatPiastres(position.effectiveCostMinor) }}</dd>
          <template v-if="selectedIsSerial">
            <dt>أجهزة بـ IMEI مسجّل</dt>
            <dd data-receive-tracked>
              متسجّل {{ num(units.length) }} من {{ num(position.quantity) }}
            </dd>
          </template>
          <template v-if="expectedQuantity !== null">
            <dt>بعد الحفظ</dt>
            <dd class="num pending" data-receive-expected>{{ num(expectedQuantity) }} قطعة</dd>
          </template>
        </dl>
      </div>
      <p v-else class="facts-preview" data-receive-new-preview>
        <Icon name="plus" />
        <span>
          موديل جديد هيبدأ برصيد
          <b class="num">{{ num(typedQuantity ?? 0) }}</b> قطعة بعد الحفظ
        </span>
      </p>

      <!-- المنتج اللي في الرف: أجهزته بالـIMEI -->
      <div v-if="source === 'existing' && selectedIsSerial && units.length > 0" class="units-box">
        <div class="units-head">أجهزة متسجّل ليها IMEI في المخزن ({{ num(units.length) }})</div>
        <div class="units-chips">
          <span v-for="u in units" :key="u.id" class="unit-tag" :data-unit-imei="u.imei">
            <b class="mono" dir="ltr">{{ u.imei }}</b>
            <small v-if="u.conditionGrade" class="unit-sub">· فئة {{ u.conditionGrade }}</small>
            <small
              v-if="u.batteryHealthPct !== null && u.batteryHealthPct !== undefined"
              class="unit-sub mono"
              dir="ltr"
            >
              · {{ u.batteryHealthPct }}%
            </small>
            <small v-if="u.color" class="unit-sub">· {{ u.color }}</small>
            <small v-if="u.accessories" class="unit-sub">· ({{ u.accessories }})</small>
            <small v-if="u.sellerName" class="unit-sub">· البائع: {{ u.sellerName }}</small>
          </span>
        </div>
      </div>

      <!-- تسجيل IMEI لجهاز موجود بالفعل من غير رقم -->
      <form
        v-if="source === 'existing' && selectedIsSerial && position !== null && units.length < position.quantity"
        class="form inline-form"
        data-register-unit
        @submit.prevent="registerStockUnitImei"
      >
        <h4 class="form-title">فيه جهاز في المخزن من غير IMEI؟ سجّله هنا</h4>
        <div class="imei-entry-row">
          <input
            v-model="unitImeiDraft"
            class="mono"
            dir="ltr"
            inputmode="numeric"
            maxlength="17"
            autocomplete="off"
            data-register-unit-imei
            placeholder="15 رقم…"
          />
          <button type="submit" class="btn sm soft" :disabled="busy" data-register-unit-save>
            سجّل الرقم
          </button>
        </div>
        <p class="hint">بياخد رقم من الأجهزة اللي في المخزن — الرصيد والتكلفة ما بيتغيّروش.</p>
      </form>

      <!-- Receive -->
      <form class="form" data-receive-form @submit.prevent="submitReceive">
        <div class="form-head">
          <h4 class="form-title">استلام بضاعة</h4>
          <div class="seg" role="group" aria-label="نوع الاستلام">
            <button
              id="stock-mode-supplier"
              type="button"
              class="seg-b"
              :class="{ on: receiptMode === 'supplier' }"
              @click="receiptMode = 'supplier'"
            >
              من مورد
            </button>
            <button
              id="stock-mode-opening"
              type="button"
              class="seg-b"
              :class="{ on: receiptMode === 'opening' }"
              @click="receiptMode = 'opening'"
            >
              بضاعة موجودة عندي (أول مرة)
            </button>
          </div>
        </div>

        <div class="grid2">
          <label class="field">
            <span>الكمية</span>
            <input id="stock-qty" v-model="receiveQuantity" inputmode="numeric" autocomplete="off" />
          </label>
          <label class="field">
            <span>سعر الوحدة ({{ moneyUnitWord() }})</span>
            <input id="stock-cost" v-model="receiveUnitCost" inputmode="decimal" autocomplete="off" />
          </label>
        </div>

        <template v-if="receiptMode === 'supplier'">
          <div class="grid2">
            <label class="field">
              <span>المورد (اختياري)</span>
              <input
                v-model="receiveSupplier"
                data-receive-supplier
                autocomplete="off"
                maxlength="120"
                placeholder="اسم من كتبته"
              />
            </label>
            <label class="field">
              <span>رقم فاتورة المورد (اختياري)</span>
              <input
                v-model="receiveDocumentRef"
                data-receive-ref
                autocomplete="off"
                maxlength="60"
                placeholder="مثال: 442/2026"
              />
            </label>
            <label class="field">
              <span>تاريخ الشراء (اختياري)</span>
              <input
                v-model="receivePurchaseDate"
                data-receive-date
                autocomplete="off"
                inputmode="numeric"
                maxlength="10"
                placeholder="2026-11-05"
              />
            </label>
            <label class="field">
              <span>ملاحظة (اختياري)</span>
              <input
                v-model="receiveNote"
                data-receive-note
                autocomplete="off"
                maxlength="300"
                placeholder="أي حاجة عن الشحنة دي"
              />
            </label>
          </div>
        </template>

        <div v-if="source === 'existing' && selectedIsSerial" class="imei-box">
          <div class="imei-box-head">
            <span>
              أرقام الـ IMEI ({{ appearance.imeiMode === 'required' ? 'إلزامي' : 'اختياري' }}) —
              {{ receiveImeis.length }} مضاف
            </span>
          </div>
          <div class="imei-entry-row">
            <input
              id="stock-imei-input"
              v-model="imeiDraft"
              :class="{ mono: imeiDraft !== '' }"
              :dir="imeiDraft ? 'ltr' : 'rtl'"
              inputmode="numeric"
              maxlength="17"
              autocomplete="off"
              placeholder="امسح أو اكتب 15 رقم…"
              @keydown.enter.prevent="addImeiToBatch"
            />
            <CameraScanButton :compact="true" data-stock-imei-scan @scan="onImeiScan" />
            <button
              id="stock-imei-add"
              type="button"
              class="btn sm soft"
              @click="addImeiToBatch"
            >
              أضف IMEI
            </button>
          </div>
          <div v-if="receiveImeis.length > 0" class="imei-chips">
            <span v-for="(im, idx) in receiveImeis" :key="im" class="imei-chip mono" dir="ltr">
              {{ im }}
              <button
                type="button"
                class="chip-x"
                title="حذف"
                @click="removeImeiFromBatch(idx)"
              >
                ×
              </button>
            </span>
          </div>
          <p class="hint">
            تسجيل الرقم اختياري — سيب الخانة فاضية وجهاز واحد بس هو اللي بياخد الرقم.
          </p>
        </div>

        <p v-if="receiptMode === 'supplier'" class="hint">
          المورد ورقم الفاتورة والتاريخ حاجات بتكتبها أنت على التوريد نفسه. سيبه فاضي لو مش عارف.
        </p>
        <p v-else class="hint">
          بضاعة أول المدة بتدخل المخزن من غير مورد ومن غير فاتورة ومش بتتحسب في مشتريات الموردين.
        </p>

        <!-- المتوقع قبل الحفظ -->
        <p v-if="typedLineTotalMinor !== null" class="expected" data-receive-total>
          <template v-if="source === 'existing' && position !== null">
            الرصيد {{ num(position.quantity) }} + المستلم {{ num(typedQuantity ?? 0) }} =
            <b class="num">{{ num(expectedQuantity ?? 0) }}</b> قطعة
          </template>
          <template v-else>
            {{ num(typedQuantity ?? 0) }} قطعة جديدة
          </template>
          · إجمالي التكلفة {{ money(typedLineTotalMinor) }}
        </p>

        <!-- شحنة واحدة فيها أكتر من صنف: أضف سطر ورا سطر، وبعدين احفظ مرة واحدة -->
        <div class="row" style="gap: 8px; flex-wrap: wrap">
          <button type="submit" :disabled="busy" data-stock-receive>استلام على طول</button>
          <button
            type="button"
            class="btn soft"
            :disabled="busy"
            data-stock-add-to-batch
            @click="addToBatch"
          >
            <Icon name="plus" /> أضف للتوريد
          </button>
        </div>
      </form>

      <!-- سلة التوريد: السطور اللي هتتحفظ مع بعض، مرة واحدة -->
      <section v-if="pendingReceipts.length > 0" class="batch" data-stock-batch>
        <div class="batch-head">
          <b>توريد {{ num(pendingReceipts.length) }} صنف</b>
          <span class="muted">
            {{ num(pendingPieces) }} قطعة · {{ money(pendingTotalMinor) }}
          </span>
        </div>
        <ul class="batch-list">
          <li v-for="line in pendingReceipts" :key="line.key" :data-stock-batch-line="line.key">
            <span class="batch-name"><bdi dir="auto">{{ line.productName }}</bdi></span>
            <span class="muted num">{{ num(line.quantity) }} × {{ money(line.unitCost) }}</span>
            <span v-if="line.supplier" class="muted">· {{ line.supplier }}</span>
            <span v-if="line.documentRef" class="muted">· فاتورة {{ line.documentRef }}</span>
            <span v-if="line.newPhone || line.newItem" class="tag ok">جديد</span>
            <span v-if="line.mode === 'opening'" class="tag warn">أول المدة</span>
            <span class="sp"></span>
            <button
              type="button"
              class="icon-btn xs"
              :title="`شيل ${line.productName}`"
              :data-stock-batch-remove="line.key"
              @click="removePending(line.key)"
            >
              <Icon name="x" :size="12" />
            </button>
          </li>
        </ul>
        <button
          type="button"
          class="btn primary"
          :disabled="busy || pendingReceipts.length === 0"
          data-stock-save-batch
          @click="saveBatch"
        >
          <Icon name="check" /> احفظ التوريد ({{ num(pendingReceipts.length) }})
        </button>
        <p class="hint">الحفظ مرة واحدة: يا الشحنة كلها بتتسجل يا مفيش حاجة.</p>
      </section>

      <!-- سجل توريدات الصنف ده: جالي إمتى، من مين، بكام -->
      <section
        v-if="source === 'existing' && history.length > 0"
        class="history"
        data-receive-history
      >
        <h4 class="form-title">آخر توريدات الصنف ده</h4>
        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>التاريخ</th>
                <th class="ta-n">الكمية</th>
                <th class="ta-n">سعر الوحدة</th>
                <th>المورد</th>
                <th>الفاتورة</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in history" :key="row.id" :data-receive-history-row="row.id">
                <td class="muted">
                  {{ shortDate(row.purchaseDate) || new Date(row.occurredAt).toLocaleDateString('ar-EG') }}
                </td>
                <td class="ta-n num">{{ num(row.quantity) }}</td>
                <td class="ta-n num">{{ money(row.unitCostMinor) }}</td>
                <td><bdi dir="auto">{{ row.supplierName ?? '—' }}</bdi></td>
                <td><bdi dir="auto">{{ row.documentRef ?? '—' }}</bdi></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-for="row in historyWithNote" :key="`n-${row.id}`" class="hint">
          ملاحظة {{ shortDate(row.purchaseDate) }}: {{ row.note }}
        </p>
      </section>
    </template>

    <!-- ===================== ٣) تسويات ===================== -->
    <template v-else>
      <p class="hint adjust-note">
        التسوية مش شراء: هي تصحيح لما على الرف — تالف، ولا فقدان، ولا فرق جرد. بتتسجل بحركة
        <b>adjustment</b> مش بحركة استلام، والسبب بيتحفظ في سجل التدقيق.
      </p>
      <label class="field">
        <span>المنتج</span>
        <select id="stock-product-adjust" v-model="selectedProductId" data-adjust-product>
          <option value="">— اختر منتجًا —</option>
          <option v-for="product in filteredProducts" :key="product.id" :value="product.id">
            {{ product.name }}
          </option>
        </select>
      </label>
      <div v-if="!position" class="gate">
        <button
          id="stock-reveal-adjust"
          type="button"
          :disabled="busy || selectedProductId === ''"
          @click="withReauth(loadPosition)"
        >
          عرض المخزن
        </button>
      </div>
      <p v-else class="facts-preview">
        <Icon name="boxes" />
        <span>الرصيد الحالي <b class="num">{{ num(position.quantity) }}</b> قطعة</span>
      </p>

      <form class="form" data-adjust-form @submit.prevent="submitRemove">
        <h4 class="form-title">خصم كمية بسبب</h4>
        <div class="grid2">
          <label class="field">
            <span>الكمية</span>
            <input v-model="removeQuantity" inputmode="numeric" autocomplete="off" data-adjust-qty />
          </label>
          <label class="field">
            <span>السبب (إجباري)</span>
            <input
              v-model="removeReason"
              autocomplete="off"
              maxlength="300"
              data-adjust-reason
              placeholder="تالف / فقدان / فرق جرد"
            />
          </label>
        </div>
        <button type="submit" :disabled="busy" data-adjust-submit>خصم</button>
        <p class="hint">
          يُرفض الخصم كاملًا إذا لم يتوفر رصيد كافٍ؛ لا يحدث خصم جزئي.
        </p>
      </form>
    </template>

    <p v-if="notice" class="notice" data-stock-notice>{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- Re-authentication for reading a cost. -->
    <div v-if="showReauth" class="overlay">
      <form class="modal" @submit.prevent="confirmReauth">
        <h3 class="modal-title">تأكيد الهوية</h3>
        <p class="hint">أدخل كلمة مرور المدير للمتابعة.</p>
        <label class="field">
          <span>كلمة المرور</span>
          <input v-model="reauthPassword" type="password" autocomplete="current-password" required autofocus />
        </label>
        <button type="submit" :disabled="busy">تأكيد</button>
      </form>
    </div>
  </section>
</template>

<style scoped>
/* سلة التوريد: قايمة قصيرة فوق زر الحفظ، عشان يشوف الشحنة قبل ما تسجل. */
.batch { margin: 10px 0 4px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--r-m); background: var(--surface-2); }
.batch-head { display: flex; justify-content: space-between; gap: 8px; font-size: .86rem; margin-bottom: 6px; }
.batch-list { list-style: none; margin: 0 0 8px; padding: 0; display: grid; gap: 4px; }
.batch-list li { display: flex; align-items: center; gap: 6px; font-size: .84rem; }
.batch-name { font-weight: 600; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.batch-list .sp { flex: 1; }

.door-seg { margin: 0 0 12px; align-self: flex-start; flex-wrap: wrap; }
.src-seg { margin: 0 0 10px; align-self: flex-start; }
.grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px 12px; }
.facts-preview { display: flex; align-items: center; gap: 8px; margin: 10px 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-m); background: var(--surface-2); font-size: .88rem; }
.pending { color: var(--ok, #070); font-weight: 700; }
.expected { margin: 8px 0; font-size: .9rem; font-weight: 600; }
.adjust-note { margin: 0 0 10px; }
.history { margin-top: 14px; }
.inline-form { border-style: dashed; }

/* Minimal, matching CatalogPanel. */
.stock {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #ddd;
}
.stock-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.stock-head .sp {
  flex: 1;
}
.stock-title {
  font-size: 1.05rem;
  margin: 0;
}
.gate {
  margin-bottom: 1rem;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1rem;
}
.units-box {
  margin: 0.75rem 0;
  padding: 0.6rem 0.75rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.units-head {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.4rem;
}
.units-chips,
.imei-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.unit-tag,
.imei-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  font-size: 0.82rem;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface);
}
.chip-x {
  border: none;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
  padding: 0 2px;
}
.form {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 1px solid #ddd;
}
.form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}
.form-title {
  font-size: 0.95rem;
  margin: 0 0 0.5rem;
}
.imei-box {
  margin: 0.75rem 0;
  padding: 0.6rem;
  border: 1px dashed var(--border);
  border-radius: var(--r-sm);
}
.imei-box-head {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.4rem;
}
.imei-entry-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.imei-entry-row input {
  flex: 1;
}
.notice {
  margin-top: 0.75rem;
  padding: 0.6rem;
  border: 1px solid #070;
  color: #070;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 10;
}
.modal {
  background: #fff;
  padding: 1rem;
  max-width: 22rem;
  width: 100%;
}
.modal-title {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
.row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
</style>
