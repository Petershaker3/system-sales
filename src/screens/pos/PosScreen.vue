<script setup lang="ts">
// The sales screen (plan item 1.6; approved mockup docs/ui/mockup-v1/pos.js).
//
// Positions, steps and shortcuts follow the mockup: search on top, category
// chips in two rows (ADR-018 §1), product tiles, the invoice on the side, several open invoices with
// «انتظار» (F8), and the keyboard first. What this build sells: products
// counted by quantity, paid in cash, through the existing atomic `record_sale`.
// Discounts, other payment methods, IMEI units and services arrive with their
// plan items; their buttons are not shown until they work.
//
// The catalogue comes from `pos_catalog`, which a seller may read. Prices on
// screen are a claim: Rust re-reads them inside the sale and refuses a total
// that changed (SALE_PRICE_CHANGED), and this screen then reprices and asks
// again.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import { type Customer, listCustomers } from '../../api/customer';
import { describeError } from '../../api/errors';
import type { Session } from '../../api/identity';
import { listProductImages, type ProductImage } from '../../api/images';
import * as posApi from '../../api/pos';
import type { PosCatalog, PosProduct } from '../../api/pos';
import * as salesApi from '../../api/sales';
import type { SaleOutcome } from '../../api/sales';
import { withOwnerApproval } from '../../shell/approval';
import { appearance, discountLimitPctNum, enabledPayMethods } from '../../ui/appearance';
import { countWord, kindsWord, money, num, pcsWord } from '../../ui/format';

import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { beep, toast } from '../../ui/toast';
import * as cart from './cart';
import type { SellableProduct } from './cart';
import { brandChips, buildTree, inSelection, keepSelection, mainChips, mainOf, searchWords, subChips, toggle } from './categories';
import CustomerPickerModal from './CustomerPickerModal.vue';
import DiscountModal from './DiscountModal.vue';
import { asIconName, tileIcon } from './icons';
import { isSerialProduct, requiresImeiOnSale, searchUnitsByImei } from './imei';
import ImeiPickerModal from './ImeiPickerModal.vue';
import PayModal from './PayModal.vue';
import QtyModal from './QtyModal.vue';
import { buildIndex, looksLikeCode, search } from './search';
import VariantPickerModal from './VariantPickerModal.vue';
import { collapseFamilies, familyPriceSummary, type PosTileEntry } from './variants';


const props = defineProps<{ session: Session }>();
const emit = defineEmits<{ go: [screen: 'store'] }>();

const catalogue = ref<PosCatalog | null>(null);
const productImages = ref<ProductImage[]>([]);
const customers = ref<Customer[]>([]);
const loadError = ref('');

const state = reactive(cart.newCart());
const query = ref('');
const highlighted = ref(0);
const chip = ref<string>('top');
const modal = ref<null | 'pay' | 'qty' | 'clear' | 'discount'>(null);
const discountInitialScope = ref<'invoice' | 'line'>('invoice');
const exactCashBusy = ref(false);
const customerPickerOpen = ref(false);
const openFamily = ref<Extract<PosTileEntry<PosProduct>, { kind: 'family' }> | null>(null);
const imeiTarget = ref<
  | null
  | { readonly mode: 'add'; readonly product: PosProduct }
  | { readonly mode: 'line'; readonly lineIndex: number; readonly product: PosProduct }
>(null);
const searchInput = ref<HTMLInputElement | null>(null);

const linesBox = ref<HTMLElement | null>(null);

const isOwner = computed(() => props.session.role === 'manager');

// --- the catalogue ---------------------------------------------------------

async function load(): Promise<void> {
  try {
    const [loadedCatalog, loadedImages, loadedCustomers] = await Promise.all([
      posApi.posCatalog(),
      listProductImages(),
      listCustomers(),
    ]);
    catalogue.value = loadedCatalog;
    productImages.value = loadedImages;
    customers.value = loadedCustomers;
    loadError.value = '';
    chip.value = keepSelection(tree.value, chip.value);
    const dropped = cart.reprice(state, sellable.value.map(asSellable));
    if (dropped.length > 0) toast(`اتشال من الفواتير المفتوحة لأنه مبقاش متاح: ${dropped.join('، ')}`, 'info', 4500);
  } catch (err) {
    loadError.value = describeError(err);
  }
}

const imageMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const img of productImages.value) {
    map[img.productId] = img.dataUrl;
  }
  return map;
});

function tileImage(p: PosProduct): string | null {
  if (appearance.images !== 'on') return null;
  return imageMap.value[p.id] ?? null;
}

function familyImage(variants: readonly PosProduct[]): string | null {
  if (appearance.images !== 'on') return null;
  for (const v of variants) {
    const img = imageMap.value[v.id];
    if (img) return img;
  }
  return null;
}



const tree = computed(() => buildTree(catalogue.value?.categories ?? []));
const brandsById = computed(() => new Map((catalogue.value?.brands ?? []).map((b) => [b.id, b])));

/** A phone's company and its Arabic spellings, for search («سامسونج»). */
function brandWords(id: string | null): string {
  const brand = id === null ? undefined : brandsById.value.get(id);
  return brand === undefined ? '' : `${brand.name} ${brand.aliases}`;
}

/** Products this build can sell: counted by quantity. */
const sellable = computed<PosProduct[]>(() =>
  (catalogue.value?.products ?? []).filter((p) => p.disposition === 'quantity')
);
const notYetSellable = computed(() => (catalogue.value?.products.length ?? 0) - sellable.value.length);

function asSellable(p: PosProduct): SellableProduct {
  return {
    id: p.id,
    name: p.name,
    priceMinor: p.salePriceMinor,
    onHand: p.onHand,
    serial: isSerialProduct(p),
  };
}

const byId = computed(() => new Map(sellable.value.map((p) => [p.id, p])));

const index = computed(() =>
  buildIndex(
    sellable.value.map((p) => ({
      ...p,
      categoryWords: `${searchWords(tree.value, p.categoryId)} ${brandWords(p.brandId)}`,
    }))
  )
);

const unitMatches = computed(() =>
  query.value.trim() === ''
    ? []
    : searchUnitsByImei(catalogue.value?.units ?? [], query.value, cart.takenImeis(state), 4)
);

const results = computed(() => (query.value.trim() === '' ? [] : search(index.value, query.value, 8)));

const categoriesOfProducts = computed(() => sellable.value.map((p) => p.categoryId));
const chips = computed(() => mainChips(tree.value, categoriesOfProducts.value));
/** The second row: the chosen main's sub-categories, or its companies under a phone category (ADR-018 §2). */
const subchips = computed(() => {
  const subs = subChips(tree.value, chip.value, categoriesOfProducts.value);
  if (subs.length > 0) return subs;
  return brandChips(tree.value, chip.value, sellable.value, catalogue.value?.brands ?? []);
});

/** The main category whose sub-categories or companies are in the second row. */
const openMain = computed(() => {
  const id = mainOf(tree.value, chip.value);
  return id === null ? undefined : tree.value.byId.get(id);
});
const openMainName = computed(() => openMain.value?.name ?? '');
const secondRowWord = computed(() => (openMain.value !== undefined && openMain.value.kind !== 'item' ? 'شركات' : 'أقسام'));

function pickChip(id: string): void {
  chip.value = toggle(tree.value, chip.value, id);
}

function chipIcon(icon: string) {
  return asIconName(icon) ?? 'tag';
}

const tileEntries = computed<PosTileEntry<PosProduct>[]>(() => {
  const list = [...sellable.value];
  if (chip.value === 'top') {
    const sorted = list.sort(
      (a, b) => b.soldRecently - a.soldRecently || a.name.localeCompare(b.name, 'ar')
    );
    return collapseFamilies(sorted, sellable.value).slice(0, 12);
  }
  if (chip.value === 'all') return collapseFamilies(list, sellable.value);
  const filtered = list
    .filter((p) => inSelection(tree.value, p, chip.value))
    .sort((a, b) => b.soldRecently - a.soldRecently || a.name.localeCompare(b.name, 'ar'));
  return collapseFamilies(filtered, sellable.value);
});

function freeOf(p: PosProduct): number {
  return cart.available(state, asSellable(p));
}

const freeStockMap = computed<Record<string, number>>(() =>
  Object.fromEntries(sellable.value.map((p) => [p.id, freeOf(p)]))
);

function familyFreeStock(variants: readonly PosProduct[]): number {
  return variants.reduce((sum, v) => sum + freeOf(v), 0);
}

function familyPriceText(variants: readonly PosProduct[]): string {
  const { minMinor, varies } = familyPriceSummary(variants);
  if (minMinor === null) return 'بدون سعر';
  return varies ? `من ${money(minMinor)}` : money(minMinor);
}


function iconOf(p: PosProduct) {
  const category = p.categoryId === null ? undefined : tree.value.byId.get(p.categoryId);
  return tileIcon(p.name, category?.icon ?? null, searchWords(tree.value, p.categoryId));
}

// --- the invoice -----------------------------------------------------------

const invoice = computed(() => cart.current(state));
const totals = computed(() => cart.totals(invoice.value));
const discSummary = computed(() => cart.discountSummary(invoice.value));
const discountNeedsOwnerBadge = computed(() =>
  cart.discountExceedsSellerLimit(
    discSummary.value.grossSubtotalMinor,
    discSummary.value.totalDiscountMinor,
    discountLimitPctNum(appearance.discountLimitPct)
  )
);
const empty = computed(() => invoice.value.lines.length === 0);
const selectedCustomer = computed<Customer | null>(() => {
  const cid = invoice.value.customerId;
  if (!cid) return null;
  return customers.value.find((c) => c.id === cid) ?? null;
});
const enabledMethodsSummary = computed(() =>
  enabledPayMethods(appearance.payMethods)
    .map((m) => m.name)
    .join(' · ')
);

function focusSearch(): void {
  if (
    modal.value === null &&
    !customerPickerOpen.value &&
    openFamily.value === null &&
    imeiTarget.value === null
  ) {
    searchInput.value?.focus({ preventScroll: true });
  }
}

function openCustomerPicker(): void {
  customerPickerOpen.value = true;
}

function closeCustomerPicker(): void {
  customerPickerOpen.value = false;
  void nextTick(focusSearch);
}

function onCustomerUpdated(updated: Customer): void {
  const idx = customers.value.findIndex((c) => c.id === updated.id);
  if (idx >= 0) {
    customers.value.splice(idx, 1, updated);
  } else {
    customers.value.push(updated);
    customers.value.sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  }
}

function onPickCustomer(picked: Customer | null): void {
  customerPickerOpen.value = false;
  cart.setInvoiceCustomer(state, picked ? picked.id : null, picked ? picked.name : '');
  void nextTick(focusSearch);
}


async function scrollToSelected(): Promise<void> {
  await nextTick();
  linesBox.value?.querySelector('.line.sel')?.scrollIntoView({ block: 'nearest' });
}

function refuse(message: string): void {
  toast(message, 'err');
  beep();
}

function pick(p: PosProduct, quantity = 1, imei: string | null = null): void {
  if (p.salePriceMinor === null) {
    refuse(
      isOwner.value
        ? `«${p.name}» مالوش سعر بيع. حدد السعر من المخزن الأول`
        : `«${p.name}» مالوش سعر بيع. كلّم المالك`
    );
    return;
  }
  const free = freeOf(p);
  if (free <= 0) {
    refuse(`«${p.name}» خلصان من المخزن`);
    return;
  }
  if (imei === null && requiresImeiOnSale(p, appearance.imeiMode)) {
    imeiTarget.value = { mode: 'add', product: p };
    return;
  }
  const result = cart.addProduct(state, asSellable(p), quantity, imei);
  if (!result.ok) {
    if (result.reason === 'no-price') {
      refuse(isOwner.value ? `«${p.name}» مالوش سعر بيع. حدد السعر من المخزن الأول` : `«${p.name}» مالوش سعر بيع. كلّم المالك`);
    } else if (result.reason === 'out-of-stock') {
      refuse(`«${p.name}» خلصان من المخزن`);
    } else if (result.reason === 'imei-taken') {
      refuse('الـ IMEI ده محطوط بالفعل في فاتورة مفتوحة');
    } else {
      refuse(`المتاح من «${p.name}» ${num(result.available)} بس`);
    }
    return;
  }
  void scrollToSelected();
  focusSearch();
}

function openLineImei(at: number): void {
  state.selected = at;
  const line = invoice.value.lines[at];
  if (!line) return;
  const p = byId.value.get(line.productId);
  if (!p) return;
  imeiTarget.value = { mode: 'line', lineIndex: at, product: p };
}

function onPickImei(imei: string | null): void {
  const target = imeiTarget.value;
  imeiTarget.value = null;
  if (!target) {
    void nextTick(focusSearch);
    return;
  }
  if (target.mode === 'add') {
    if (imei !== null) pick(target.product, 1, imei);
  } else {
    if (!cart.setLineImei(state, target.lineIndex, imei)) {
      refuse('الـ IMEI ده محطوط بالفعل في فاتورة مفتوحة');
    } else if (imei !== null) {
      toast(`اتربط الجهاز بآخر 4 أرقام (${imei.slice(-4)})`, 'ok');
    } else {
      toast('اتشال الـ IMEI من السطر', 'info');
    }
  }
  void nextTick(focusSearch);
}

function closeImeiModal(): void {
  imeiTarget.value = null;
  void nextTick(focusSearch);
}

function pickUnitMatch(imei: string, productId: string): void {
  const p = byId.value.get(productId);
  if (!p) return;
  query.value = '';
  highlighted.value = 0;
  pick(p, 1, imei);
}

function pickResult(at: number): void {
  const u = unitMatches.value[0];
  if (at === 0 && results.value.length === 0 && u !== undefined) {
    pickUnitMatch(u.imei, u.productId);
    return;
  }
  const p = results.value[at];
  if (p === undefined) return;
  query.value = '';
  highlighted.value = 0;
  pick(p);
}

function notFound(): void {
  beep();
  toast(looksLikeCode(query.value) ? `مفيش صنف بالكود «${query.value.trim()}»` : `مفيش صنف بالاسم «${query.value.trim()}»`, 'err');
}

function selectedProduct(): PosProduct | undefined {
  const line = invoice.value.lines[state.selected];
  return line === undefined ? undefined : byId.value.get(line.productId);
}

function bump(at: number, delta: number): void {
  state.selected = at;
  const p = selectedProduct();
  if (p === undefined) return;
  const result = cart.changeQuantity(state, asSellable(p), delta);
  if (!result.ok) refuse(`المتاح من «${p.name}» ${num(result.available)} بس`);
}

function removeAt(at: number): void {
  const line = cart.removeLine(state, at);
  if (line !== null) toast(`اتشال: ${line.name}`, 'info');
  focusSearch();
}

function applyQuantity(quantity: number): void {
  const p = selectedProduct();
  modal.value = null;
  if (p === undefined) return;
  const result = cart.setQuantity(state, asSellable(p), quantity);
  if (!result.ok) refuse(`المتاح من «${p.name}» ${num(result.available)} بس`);
  focusSearch();
}

function hold(): void {
  if (!cart.hold(state)) {
    toast('الفاتورة فاضية، مفيش حاجة تتحط في الانتظار', 'info');
    return;
  }
  toast('الفاتورة اتحطت في الانتظار. ترجعلها من التبويبات فوق الفاتورة');
  focusSearch();
}

function openTab(at: number): void {
  cart.switchTo(state, at);
  focusSearch();
}

function dropTab(at: number): void {
  cart.drop(state, at);
  toast('اتلغت فاتورة الانتظار', 'info');
}

function newTab(): void {
  if (empty.value) {
    focusSearch();
    return;
  }
  cart.hold(state);
  focusSearch();
}

function clearInvoice(): void {
  cart.clear(state);
  modal.value = null;
  toast('اتمسحت الفاتورة', 'info');
  focusSearch();
}

function openPay(): void {
  if (empty.value) return;
  if (appearance.imeiMode === 'required') {
    const missingIdx = invoice.value.lines.findIndex((line) => line.serial && !line.imei);
    if (missingIdx >= 0) {
      refuse('وضع الـ IMEI إلزامي: سجّل الـ IMEI الأول');
      openLineImei(missingIdx);
      return;
    }
  }
  query.value = '';
  modal.value = 'pay';
}

function openQty(at?: number): void {
  if (typeof at === 'number' && at >= 0 && at < invoice.value.lines.length) {
    state.selected = at;
  }
  if (selectedProduct() === undefined) {
    if (!empty.value) state.selected = invoice.value.lines.length - 1;
    if (selectedProduct() === undefined) return;
  }
  modal.value = 'qty';
}

function openDiscount(scope: 'invoice' | 'line' = 'invoice', lineIndex?: number): void {
  if (empty.value) {
    toast('الفاتورة فاضية، ضيف صنف الأول قبل الخصم', 'info');
    return;
  }
  if (typeof lineIndex === 'number' && lineIndex >= 0 && lineIndex < invoice.value.lines.length) {
    state.selected = lineIndex;
  } else if (state.selected < 0 && invoice.value.lines.length > 0) {
    state.selected = invoice.value.lines.length - 1;
  }
  discountInitialScope.value = scope;
  modal.value = 'discount';
}

function onApplyLineDiscount(lineIndex: number, discountMinor: number): void {
  modal.value = null;
  if (cart.setLineDiscount(state, lineIndex, discountMinor)) {
    toast(
      discountMinor > 0
        ? `اتطبّق خصم ${money(discountMinor)} على الصنف`
        : 'اتشال خصم الصنف',
      'info'
    );
  }
  void nextTick(focusSearch);
}

function onApplyInvoiceDiscount(discountMinor: number): void {
  modal.value = null;
  if (cart.setInvoiceDiscount(state, discountMinor)) {
    toast(
      discountMinor > 0
        ? `اتطبّق خصم ${money(discountMinor)} على الفاتورة`
        : 'اتشال خصم الفاتورة',
      'info'
    );
  }
  void nextTick(focusSearch);
}

async function payExactCash(): Promise<void> {
  if (empty.value || exactCashBusy.value) return;
  if (appearance.imeiMode === 'required') {
    const missingIdx = invoice.value.lines.findIndex((line) => line.serial && !line.imei);
    if (missingIdx >= 0) {
      refuse('وضع الـ IMEI إلزامي: سجّل الـ IMEI الأول');
      openLineImei(missingIdx);
      return;
    }
  }
  exactCashBusy.value = true;
  try {
    const netTotal = totals.value.totalMinor;
    const approvalOutcome = await withOwnerApproval(
      () =>
        salesApi.recordSale(
          invoice.value.lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            imei: line.imei ?? null,
            discountMinor: line.discountMinor ?? 0,
          })),
          netTotal,
          [{ method: 'cash', amountMinor: netTotal, reference: null }],
          selectedCustomer.value?.id ?? null,
          discSummary.value.invoiceDiscountMinor
        ),
      'موافقة المالك على خصم الفاتورة'
    );
    if (approvalOutcome.status === 'cancelled') return;
    await onPaid(approvalOutcome.value);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'SALE_PRICE_CHANGED') {
      await onPriceChanged();
      return;
    }
    refuse(describeError(err));
  } finally {
    exactCashBusy.value = false;
  }
}

async function onPaid(outcome: SaleOutcome): Promise<void> {
  cart.closePaid(state);
  toast(`اتسجّلت الفاتورة ${outcome.reference}`);
  await load();
}

async function onPriceChanged(): Promise<void> {
  await load();
  toast('سعر صنف اتغيّر من شوية. الفاتورة اتحدّثت بالسعر الجديد، راجع المطلوب وادفع تاني', 'info', 5000);
}

function closeModal(): void {
  modal.value = null;
  void nextTick(focusSearch);
}

function closeVariantModal(): void {
  openFamily.value = null;
  void nextTick(focusSearch);
}

function onPickVariant(p: PosProduct): void {
  openFamily.value = null;
  pick(p);
}

// --- the keyboard (docs/ui/mockup-v1/pos.js, posKey) ------------------------

function onKey(event: KeyboardEvent): void {
  if (
    modal.value !== null ||
    customerPickerOpen.value ||
    openFamily.value !== null ||
    imeiTarget.value !== null ||
    document.querySelector('.overlay') !== null
  ) {
    return;
  }

  const key = event.key;
  const active = document.activeElement;
  const inSearch = active === searchInput.value;
  const typing = !inSearch && active instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);

  if (/^F([1-9]|1[0-2])$/.test(key) && key !== 'F5') event.preventDefault();
  if (key === 'F2') return openQty();
  if (key === 'F3') return openDiscount();
  if (key === 'F4') return openCustomerPicker();
  if (key === 'F8') return hold();
  if (key === 'F12' || (key === 'Enter' && (event.ctrlKey || event.metaKey))) {
    event.preventDefault();
    return openPay();
  }
  if (typing) return;
  if (key === '/' && !inSearch) {
    event.preventDefault();
    return focusSearch();
  }
  const hasQuery = query.value.trim() !== '';
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    event.preventDefault();
    const step = key === 'ArrowDown' ? 1 : -1;
    if (hasQuery && results.value.length > 0) {
      highlighted.value = Math.max(0, Math.min(results.value.length - 1, highlighted.value + step));
    } else {
      cart.moveSelection(state, step);
      void scrollToSelected();
    }
    return;
  }
  if (key === 'Enter') {
    event.preventDefault();
    if (hasQuery) {
      if (results.value.length > 0 || unitMatches.value.length > 0) pickResult(highlighted.value);
      else notFound();
    } else if (!empty.value) openPay();
    return;
  }
  if (key === 'Escape') {
    if (hasQuery) query.value = '';
    else state.selected = -1;
    return;
  }
  if (!hasQuery) {
    if (key === 'Delete') {
      event.preventDefault();
      if (!empty.value) removeAt(state.selected);
      return;
    }
    if (key === '+') {
      event.preventDefault();
      if (state.selected < 0 && !empty.value) state.selected = invoice.value.lines.length - 1;
      return bump(state.selected, 1);
    }
    if (key === '-' || key === '−') {
      event.preventDefault();
      if (state.selected < 0 && !empty.value) state.selected = invoice.value.lines.length - 1;
      return bump(state.selected, -1);
    }
  }
  if (!inSearch && key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) focusSearch();
}

function onQueryInput(): void {
  highlighted.value = 0;
}

onMounted(async () => {
  window.addEventListener('keydown', onKey);
  await load();
  focusSearch();
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const KEYS: readonly [string, string][] = [
  ['Enter', 'إضافة ثم دفع'],
  ['F2', 'الكمية'],
  ['F3', 'خصم'],
  ['F4', 'العميل'],
  ['F8', 'انتظار'],
  ['F12', 'دفع'],
  ['Del', 'حذف سطر'],
  ['+ / −', 'الكمية'],
  ['/', 'بحث'],
  ['Esc', 'مسح البحث'],
];
</script>

<template>
  <div class="pos-wrap">
    <div class="pos">
      <section class="catalog">
        <div class="search-row">
          <div class="search">
            <label class="search-box">
              <Icon name="search" />
              <input
                id="q"
                ref="searchInput"
                v-model="query"
                placeholder="ابحث بالاسم أو امسح الباركود…"
                autocomplete="off"
                spellcheck="false"
                aria-label="بحث"
                @input="onQueryInput"
              />
              <kbd>/</kbd>
            </label>
            <div v-if="query.trim() !== ''" class="results">
              <div v-if="results.length === 0 && unitMatches.length === 0" class="no-res">
                <Icon name="search" /> مفيش نتيجة لـ «{{ query.trim() }}». جرّب جزء من الاسم أو آخر 4 أرقام من الـ IMEI
              </div>
              <div
                v-for="u in unitMatches"
                :key="u.id"
                class="result unit-res"
                @mousedown.prevent="pickUnitMatch(u.imei, u.productId)"
              >
                <div class="ico"><Icon name="smartphone" /></div>
                <div class="t">
                  <div class="n"><bdi dir="rtl">{{ byId.get(u.productId)?.name ?? 'موبايل' }}</bdi></div>
                  <div class="s">
                    <span>IMEI <bdi dir="ltr" class="mono">…{{ u.imei.slice(-4) }}</bdi></span>
                    <span v-if="u.color">{{ u.color }}</span>
                  </div>
                </div>
                <div class="p num">
                  {{
                    byId.get(u.productId)?.salePriceMinor === null || byId.get(u.productId)?.salePriceMinor === undefined
                      ? 'بدون سعر'
                      : money(byId.get(u.productId)!.salePriceMinor!)
                  }}
                </div>
              </div>
              <div
                v-for="(p, at) in results"
                :key="p.id"
                class="result"
                :class="{ on: at === highlighted }"
                @mousedown.prevent="pickResult(at)"
                @mouseenter="highlighted = at"
              >
                <div class="ico" :class="{ img: !!tileImage(p) }">
                  <img v-if="tileImage(p)" :src="tileImage(p)!" alt="" />
                  <Icon v-else :name="iconOf(p)" />
                </div>
                <div class="t">

                  <div class="n"><bdi dir="rtl">{{ p.name }}</bdi></div>
                  <div class="s">
                    <span :class="{ 'danger-t': freeOf(p) <= 0 }">{{ freeOf(p) <= 0 ? 'خلصان' : `متاح ${num(freeOf(p))}` }}</span>
                    <span v-if="p.barcode"><bdi dir="ltr" class="mono">{{ p.barcode }}</bdi></span>
                  </div>
                </div>
                <div class="p num">{{ p.salePriceMinor === null ? 'بدون سعر' : money(p.salePriceMinor) }}</div>
                <span v-if="at === highlighted" class="enter"><kbd>Enter</kbd></span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="loadError" class="note warn"><Icon name="triangle-alert" /><span>{{ loadError }}</span></div>

        <div class="chips cats">
          <button type="button" class="chip" :class="{ on: chip === 'top' }" @click="chip = 'top'">
            <Icon name="flame" /><bdi dir="rtl">الأكثر مبيعًا</bdi>
          </button>
          <button type="button" class="chip" :class="{ on: chip === 'all' }" @click="chip = 'all'">
            <Icon name="layout-grid" /><bdi dir="rtl">الكل</bdi><span class="cnt num">{{ num(sellable.length) }}</span>
          </button>
          <button
            v-for="d in chips"
            :key="d.id"
            type="button"
            class="chip"
            :class="{ on: chip === d.id || mainOf(tree, chip) === d.id }"
            @click="pickChip(d.id)"
          >
            <Icon :name="chipIcon(d.icon)" /><bdi dir="rtl">{{ d.name }}</bdi><span class="cnt num">{{ num(d.count) }}</span>
          </button>
        </div>
        <div v-if="subchips.length > 0" class="chips subcats" :aria-label="`${secondRowWord} ${openMainName}`">
          <button
            v-for="d in subchips"
            :key="d.id"
            type="button"
            class="chip sub"
            :class="{ on: chip === d.id }"
            @click="pickChip(d.id)"
          >
            <Icon v-if="d.icon !== ''" :name="chipIcon(d.icon)" /><bdi :dir="d.icon === '' ? 'ltr' : 'rtl'">{{ d.name }}</bdi><span class="cnt num">{{ num(d.count) }}</span>
          </button>
        </div>

        <div class="tiles">
          <div v-if="catalogue !== null && sellable.length === 0" class="tiles-empty">
            <Icon name="package-plus" />
            <b>لسه مفيش أصناف في المحل</b>
            <span v-if="isOwner">سجّل البضاعة اللي عندك من «المخزن»، وبعدها بتظهر هنا على طول.</span>
            <span v-else>المالك بيضيف الأصناف من «المخزن»، وبعدها بتظهر هنا على طول.</span>
            <button v-if="isOwner" type="button" class="btn primary" @click="emit('go', 'store')">
              <Icon name="boxes" /> روح للمخزن
            </button>
          </div>
          <template v-for="entry in tileEntries" :key="entry.key">
            <button
              v-if="entry.kind === 'product'"
              type="button"
              class="tile"
              :title="entry.product.salePriceMinor === null ? 'مالوش سعر بيع' : entry.product.name"
              @click="pick(entry.product)"
            >
              <div class="ico" :class="{ img: !!tileImage(entry.product) }">
                <img v-if="tileImage(entry.product)" :src="tileImage(entry.product)!" alt="" />
                <Icon v-else :name="iconOf(entry.product)" />
              </div>
              <div class="name"><bdi dir="rtl">{{ entry.product.name }}</bdi></div>
              <div class="foot">
                <span class="price num">{{
                  entry.product.salePriceMinor === null
                    ? 'بدون سعر'
                    : money(entry.product.salePriceMinor)
                }}</span>
                <span
                  class="stock"
                  :class="{
                    out: freeOf(entry.product) <= 0,
                    low: freeOf(entry.product) > 0 && freeOf(entry.product) <= 2,
                  }"
                  >{{
                    freeOf(entry.product) <= 0
                      ? 'خلصان'
                      : `${num(freeOf(entry.product))} متاح`
                  }}</span
                >
              </div>
            </button>
            <button
              v-else
              type="button"
              class="tile fam"
              :data-fam="entry.parentId"
              :title="`ليه ${kindsWord(entry.variants.length)}: اختار النوع بعد الدوسة`"
              @click="openFamily = entry"
            >
              <div class="ico" :class="{ img: !!familyImage(entry.variants) }">
                <img v-if="familyImage(entry.variants)" :src="familyImage(entry.variants)!" alt="" />
                <Icon v-else :name="iconOf(entry.variants[0]!)" />
              </div>
              <span class="corner tag">

                <Icon name="layers" /> {{ kindsWord(entry.variants.length) }}
              </span>
              <div class="name"><bdi dir="rtl">{{ entry.parentName }}</bdi></div>
              <div class="foot">
                <span class="price num">{{ familyPriceText(entry.variants) }}</span>
                <span
                  class="stock"
                  :class="{
                    out: familyFreeStock(entry.variants) <= 0,
                    low:
                      familyFreeStock(entry.variants) > 0 &&
                      familyFreeStock(entry.variants) <= 2,
                  }"
                  >{{
                    familyFreeStock(entry.variants) <= 0
                      ? 'خلصان'
                      : `${num(familyFreeStock(entry.variants))} متاح`
                  }}</span
                >
              </div>
            </button>
          </template>

          <div v-if="isOwner && notYetSellable > 0" class="note tiles-note">
            <Icon name="info" />
            <span>{{ countWord(notYetSellable, 'صنف', 'صنفين', 'أصناف') }} بالـ IMEI أو قطعة واحدة مش ظاهرة هنا لسه. البيع بالـ IMEI جاي مع وحدات الأجهزة.</span>
          </div>
        </div>
      </section>

      <aside class="cart" aria-label="الفاتورة">
        <div class="inv-tabs">
          <button
            v-for="(inv, at) in state.invoices"
            :key="inv.id"
            type="button"
            class="inv-tab"
            :class="{ on: at === state.active, held: inv.held }"
            @click="openTab(at)"
          >
            <Icon :name="at === state.active ? 'receipt' : 'pause'" />
            <span class="tl">
              <template v-if="at === state.active">الفاتورة الحالية</template>
              <template v-else>انتظار <span class="ta num">{{ money(cart.totals(inv).totalMinor) }}</span></template>
            </span>
            <span v-if="at !== state.active" class="x" title="إلغاء فاتورة الانتظار" @click.stop="dropTab(at)">
              <Icon name="x" />
            </span>
          </button>
          <button type="button" class="inv-tab" title="فاتورة جديدة" @click="newTab"><Icon name="plus" /></button>
        </div>

        <button
          id="pos-customer-btn"
          type="button"
          class="cust-row"
          :class="{ set: !!selectedCustomer }"
          @click="openCustomerPicker"
        >
          <div class="ci"><Icon :name="selectedCustomer ? 'user' : 'user-plus'" /></div>
          <div class="t">
            <template v-if="selectedCustomer">
              <b>
                <bdi dir="rtl">{{ selectedCustomer.name }}</bdi>
                <span v-if="selectedCustomer.balanceMinor > 0" class="cb num">
                  عليه {{ money(selectedCustomer.balanceMinor) }} آجل
                </span>
              </b>
              <small>
                <span v-if="selectedCustomer.contact" class="mono" dir="ltr">{{ selectedCustomer.contact }}</span>
                <span v-else>عميل مسجّل</span>
              </small>
            </template>
            <template v-else>
              <b>عميل الفاتورة (اختياري)</b>
              <small>للضمان أو البيع الآجل</small>
            </template>
          </div>
          <kbd>F4</kbd>
        </button>

        <div ref="linesBox" class="lines">
          <div v-if="empty" class="empty">
            <div class="big-i"><Icon name="shopping-cart" /></div>
            <b>الفاتورة فاضية</b>
            <div>اكتب اسم الصنف أو امسح الباركود، أو دوس على صنف من اليمين</div>
            <div class="keys"><span><kbd>/</kbd> بحث</span><span><kbd>F8</kbd> انتظار</span><span><kbd>F12</kbd> دفع</span></div>
          </div>
          <div
            v-for="(line, at) in invoice.lines"
            v-else
            :key="line.lineId ?? `${line.productId}-${at}`"
            class="line"
            :class="{ sel: at === state.selected }"
            @click="state.selected = at"
          >
            <div class="lm">
              <div class="ln"><bdi dir="rtl">{{ line.name }}</bdi></div>
              <div v-if="line.serial || cart.lineDiscountMinor(line) > 0" class="ls">
                <button
                  v-if="line.serial"
                  type="button"
                  class="line-imei-btn"
                  :class="{ linked: !!line.imei }"
                  @click.stop="openLineImei(at)"
                >
                  <Icon name="scan-barcode" />
                  <bdi v-if="line.imei" dir="ltr" class="mono">IMEI …{{ line.imei.slice(-4) }}</bdi>
                  <template v-else>سجّل IMEI</template>
                </button>
                <button
                  v-if="cart.lineDiscountMinor(line) > 0"
                  type="button"
                  class="line-disc-btn"
                  title="تعديل خصم الصنف"
                  @click.stop="openDiscount('line', at)"
                >
                  <Icon name="percent" />
                  خصم {{ money(cart.lineDiscountMinor(line)) }}
                </button>
              </div>
            </div>
            <div class="side">
              <span class="lt num">{{ money(cart.lineNetMinor(line)) }}</span>
              <span v-if="line.quantity > 1 || cart.lineDiscountMinor(line) > 0" class="lu num">
                {{ num(line.quantity) }} × {{ money(line.unitPriceMinor) }}
              </span>
              <div class="ctl">
                <div v-if="!line.serial" class="qty">
                  <button type="button" title="زوّد (+)" @click.stop="bump(at, 1)"><Icon name="plus" /></button>
                  <span class="num" title="تغيير الكمية (F2)" @click.stop="openQty(at)">{{ num(line.quantity) }}</span>
                  <button type="button" title="قلّل (−)" @click.stop="bump(at, -1)"><Icon name="minus" /></button>
                </div>
                <button
                  type="button"
                  class="icon-btn sm"
                  :data-line-discount="at"
                  title="خصم على الصنف (F3)"
                  @click.stop="openDiscount('line', at)"
                >
                  <Icon name="percent" />
                </button>
                <button type="button" class="icon-btn sm danger" title="شيل السطر (Delete)" @click.stop="removeAt(at)">
                  <Icon name="trash-2" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="totals">
          <div class="r">
            <span>الإجمالي <small v-if="totals.count > 0" class="muted">({{ pcsWord(totals.count) }})</small></span>
            <span class="num">{{ money(discSummary.grossSubtotalMinor) }}</span>
          </div>
          <div v-if="discSummary.totalDiscountMinor > 0" id="pos-discount-row" class="r disc">
            <span>
              خصم
              <template v-if="discountNeedsOwnerBadge">، بموافقة المالك</template>
            </span>
            <span class="num">− {{ money(discSummary.totalDiscountMinor) }}</span>
          </div>
          <div class="r grand"><span>المطلوب</span><span class="num">{{ money(totals.totalMinor) }}</span></div>
        </div>
        <div class="cart-actions">
          <button type="button" class="btn primary btn-pay" :disabled="empty" @click="openPay">
            <Icon name="banknote" /> ادفع <span class="amt num">{{ money(totals.totalMinor) }}</span> <kbd>F12</kbd>
          </button>
          <button
            id="pos-exact-cash-btn"
            type="button"
            class="btn"
            :disabled="empty || exactCashBusy"
            @click="payExactCash"
          >
            <Icon name="check" /> كاش بالظبط
          </button>
          <button
            id="pos-discount-btn"
            type="button"
            class="btn"
            :disabled="empty"
            @click="openDiscount('invoice')"
          >
            خصم <kbd>F3</kbd>
          </button>
          <button
            id="pos-hold-btn"
            type="button"
            class="btn"
            :disabled="empty"
            title="حط الفاتورة دي في الانتظار وابدأ واحدة جديدة"
            @click="hold"
          >
            انتظار <kbd>F8</kbd>
          </button>
          <button
            id="pos-clear-btn"
            type="button"
            class="btn ghost danger"
            :disabled="empty"
            title="مسح الفاتورة"
            @click="modal = 'clear'"
          >
            <Icon name="trash-2" />
          </button>
        </div>
      </aside>
    </div>

    <div class="keys-bar">
      <span v-for="[k, label] in KEYS" :key="k"><kbd>{{ k }}</kbd>{{ label }}</span>
      <span class="sp" />
      <span><Icon name="banknote" /> {{ enabledMethodsSummary }}</span>
    </div>

    <PayModal
      v-if="modal === 'pay'"
      :lines="invoice.lines"
      :total-minor="totals.totalMinor"
      :count="totals.count"
      :selected-customer="selectedCustomer"
      :invoice-discount-minor="discSummary.invoiceDiscountMinor"
      :gross-subtotal-minor="discSummary.grossSubtotalMinor"
      :seller-name="props.session.displayName"
      @close="closeModal"
      @paid="onPaid"
      @price-changed="onPriceChanged"
      @open-customer-picker="openCustomerPicker"
    />
    <DiscountModal
      v-if="modal === 'discount'"
      :invoice="invoice"
      :selected-line-index="state.selected"
      :initial-scope="discountInitialScope"
      @close="closeModal"
      @apply-line="onApplyLineDiscount"
      @apply-invoice="onApplyInvoiceDiscount"
    />
    <CustomerPickerModal
      v-if="customerPickerOpen"
      :customers="customers"
      :selected-customer-id="invoice.customerId"
      @close="closeCustomerPicker"
      @pick="onPickCustomer"
      @updated="onCustomerUpdated"
    />
    <QtyModal
      v-if="modal === 'qty' && invoice.lines[state.selected]"
      :name="invoice.lines[state.selected]?.name ?? ''"
      :quantity="invoice.lines[state.selected]?.quantity ?? 1"
      @close="closeModal"
      @apply="applyQuantity"
    />
    <Modal v-if="modal === 'clear'" title="مسح الفاتورة؟" size="sm" @close="closeModal">
      <p>هتتشال كل السطور من الفاتورة الحالية. فواتير الانتظار مش هتتأثر.</p>
      <template #foot>
        <button type="button" class="btn danger-solid" data-autofocus @click="clearInvoice">امسح الفاتورة</button>
        <button type="button" class="btn ghost" @click="closeModal">رجوع</button>
      </template>
    </Modal>
    <VariantPickerModal
      v-if="openFamily !== null"
      :parent-name="openFamily.parentName"
      :dimensions="openFamily.dimensions"
      :variants="openFamily.variants"
      :free-stock="freeStockMap"
      @close="closeVariantModal"
      @pick="onPickVariant"
    />
    <ImeiPickerModal
      v-if="imeiTarget !== null"
      :product="imeiTarget.product"
      :units="catalogue?.units ?? []"
      :taken-imeis="
        imeiTarget.mode === 'line'
          ? cart.takenImeis(state, { invoiceIndex: state.active, lineIndex: imeiTarget.lineIndex })
          : cart.takenImeis(state)
      "
      :free-stock="freeOf(imeiTarget.product)"
      :current-imei="
        imeiTarget.mode === 'line'
          ? (invoice.lines[imeiTarget.lineIndex]?.imei ?? null)
          : null
      "
      :can-clear="imeiTarget.mode === 'line' && !requiresImeiOnSale(imeiTarget.product, appearance.imeiMode)"
      @close="closeImeiModal"
      @pick="onPickImei"
    />
  </div>
</template>


<style scoped>
.tiles-note {
  grid-column: 1 / -1;
}
.btn-pay kbd,
.cart-actions kbd {
  margin-inline-start: 2px;
}
.line-imei-btn,
.line-disc-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 3px;
  margin-inline-end: 4px;
  padding: 2px 8px;
  font-size: 0.78rem;
  border-radius: var(--r-sm);
  border: 1px dashed var(--border);
  background: var(--surface-2);
  color: var(--muted);
  cursor: pointer;
}
.line-imei-btn.linked {
  border-style: solid;
  border-color: var(--accent);
  background: var(--accent-weak);
  color: var(--ink);
}
.line-disc-btn {
  border-style: solid;
  border-color: var(--ok);
  background: var(--surface-2);
  color: var(--ok);
  font-weight: 600;
}
</style>
