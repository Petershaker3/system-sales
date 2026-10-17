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

import { describeError } from '../../api/errors';
import type { Session } from '../../api/identity';
import * as posApi from '../../api/pos';
import type { PosCatalog, PosProduct } from '../../api/pos';
import type { SaleOutcome } from '../../api/sales';
import { countWord, money, num, pcsWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { beep, toast } from '../../ui/toast';
import * as cart from './cart';
import type { SellableProduct } from './cart';
import { brandChips, buildTree, inSelection, keepSelection, mainChips, mainOf, searchWords, subChips, toggle } from './categories';
import { asIconName, tileIcon } from './icons';
import PayModal from './PayModal.vue';
import QtyModal from './QtyModal.vue';
import { buildIndex, looksLikeCode, search } from './search';

const props = defineProps<{ session: Session }>();
const emit = defineEmits<{ go: [screen: 'store'] }>();

const catalogue = ref<PosCatalog | null>(null);
const loadError = ref('');
const state = reactive(cart.newCart());
const query = ref('');
const highlighted = ref(0);
const chip = ref<string>('top');
const modal = ref<null | 'pay' | 'qty' | 'clear'>(null);
const searchInput = ref<HTMLInputElement | null>(null);
const linesBox = ref<HTMLElement | null>(null);

const isOwner = computed(() => props.session.role === 'manager');

// --- the catalogue ---------------------------------------------------------

async function load(): Promise<void> {
  try {
    catalogue.value = await posApi.posCatalog();
    loadError.value = '';
    chip.value = keepSelection(tree.value, chip.value);
    const dropped = cart.reprice(state, sellable.value.map(asSellable));
    if (dropped.length > 0) toast(`اتشال من الفواتير المفتوحة لأنه مبقاش متاح: ${dropped.join('، ')}`, 'info', 4500);
  } catch (err) {
    loadError.value = describeError(err);
  }
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
  return { id: p.id, name: p.name, priceMinor: p.salePriceMinor, onHand: p.onHand };
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

const tiles = computed<PosProduct[]>(() => {
  const list = [...sellable.value];
  if (chip.value === 'top') {
    return list.sort((a, b) => b.soldRecently - a.soldRecently || a.name.localeCompare(b.name, 'ar')).slice(0, 12);
  }
  if (chip.value === 'all') return list;
  return list
    .filter((p) => inSelection(tree.value, p, chip.value))
    .sort((a, b) => b.soldRecently - a.soldRecently || a.name.localeCompare(b.name, 'ar'));
});

function freeOf(p: PosProduct): number {
  return cart.available(state, asSellable(p));
}

function iconOf(p: PosProduct) {
  const category = p.categoryId === null ? undefined : tree.value.byId.get(p.categoryId);
  return tileIcon(p.name, category?.icon ?? null, searchWords(tree.value, p.categoryId));
}

// --- the invoice -----------------------------------------------------------

const invoice = computed(() => cart.current(state));
const totals = computed(() => cart.totals(invoice.value));
const empty = computed(() => invoice.value.lines.length === 0);

function focusSearch(): void {
  if (modal.value === null) searchInput.value?.focus({ preventScroll: true });
}

async function scrollToSelected(): Promise<void> {
  await nextTick();
  linesBox.value?.querySelector('.line.sel')?.scrollIntoView({ block: 'nearest' });
}

function refuse(message: string): void {
  toast(message, 'err');
  beep();
}

function pick(p: PosProduct, quantity = 1): void {
  const result = cart.addProduct(state, asSellable(p), quantity);
  if (!result.ok) {
    if (result.reason === 'no-price') {
      refuse(isOwner.value ? `«${p.name}» مالوش سعر بيع. حدد السعر من المخزن الأول` : `«${p.name}» مالوش سعر بيع. كلّم المالك`);
    } else if (result.reason === 'out-of-stock') {
      refuse(`«${p.name}» خلصان من المخزن`);
    } else {
      refuse(`المتاح من «${p.name}» ${num(result.available)} بس`);
    }
    return;
  }
  void scrollToSelected();
  focusSearch();
}

function pickResult(at: number): void {
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
  query.value = '';
  modal.value = 'pay';
}

function openQty(): void {
  if (selectedProduct() === undefined) {
    if (!empty.value) state.selected = invoice.value.lines.length - 1;
    if (selectedProduct() === undefined) return;
  }
  modal.value = 'qty';
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

// --- the keyboard (docs/ui/mockup-v1/pos.js, posKey) ------------------------

function onKey(event: KeyboardEvent): void {
  if (modal.value !== null || document.querySelector('.overlay') !== null) return;
  const key = event.key;
  const active = document.activeElement;
  const inSearch = active === searchInput.value;
  const typing = !inSearch && active instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName);

  if (/^F([1-9]|1[0-2])$/.test(key) && key !== 'F5') event.preventDefault();
  if (key === 'F2') return openQty();
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
      if (results.value.length > 0) pickResult(highlighted.value);
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
              <div v-if="results.length === 0" class="no-res">
                <Icon name="search" /> مفيش نتيجة لـ «{{ query.trim() }}». جرّب جزء من الاسم
              </div>
              <div
                v-for="(p, at) in results"
                :key="p.id"
                class="result"
                :class="{ on: at === highlighted }"
                @mousedown.prevent="pickResult(at)"
                @mouseenter="highlighted = at"
              >
                <div class="ico"><Icon :name="iconOf(p)" /></div>
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
          <button
            v-for="p in tiles"
            :key="p.id"
            type="button"
            class="tile"
            :title="p.salePriceMinor === null ? 'مالوش سعر بيع' : p.name"
            @click="pick(p)"
          >
            <div class="ico"><Icon :name="iconOf(p)" /></div>
            <div class="name"><bdi dir="rtl">{{ p.name }}</bdi></div>
            <div class="foot">
              <span class="price num">{{ p.salePriceMinor === null ? 'بدون سعر' : money(p.salePriceMinor) }}</span>
              <span class="stock" :class="{ out: freeOf(p) <= 0, low: freeOf(p) > 0 && freeOf(p) <= 2 }">{{
                freeOf(p) <= 0 ? 'خلصان' : `${num(freeOf(p))} متاح`
              }}</span>
            </div>
          </button>
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
            :key="line.productId"
            class="line"
            :class="{ sel: at === state.selected }"
            @click="state.selected = at"
          >
            <div class="lm">
              <div class="ln"><bdi dir="rtl">{{ line.name }}</bdi></div>
            </div>
            <div class="side">
              <span class="lt num">{{ money(line.unitPriceMinor * line.quantity) }}</span>
              <span v-if="line.quantity > 1" class="lu num">{{ num(line.quantity) }} × {{ money(line.unitPriceMinor) }}</span>
              <div class="ctl">
                <div class="qty">
                  <button type="button" title="زوّد (+)" @click.stop="bump(at, 1)"><Icon name="plus" /></button>
                  <span class="num">{{ num(line.quantity) }}</span>
                  <button type="button" title="قلّل (−)" @click.stop="bump(at, -1)"><Icon name="minus" /></button>
                </div>
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
            <span class="num">{{ money(totals.totalMinor) }}</span>
          </div>
          <div class="r grand"><span>المطلوب</span><span class="num">{{ money(totals.totalMinor) }}</span></div>
        </div>
        <div class="cart-actions">
          <button type="button" class="btn primary btn-pay" :disabled="empty" @click="openPay">
            <Icon name="banknote" /> ادفع <span class="amt num">{{ money(totals.totalMinor) }}</span> <kbd>F12</kbd>
          </button>
          <button type="button" class="btn" :disabled="empty" title="حط الفاتورة دي في الانتظار وابدأ واحدة جديدة" @click="hold">
            انتظار <kbd>F8</kbd>
          </button>
          <button type="button" class="btn" :disabled="state.selected < 0" @click="openQty">الكمية <kbd>F2</kbd></button>
          <button type="button" class="btn ghost danger" :disabled="empty" title="مسح الفاتورة" @click="modal = 'clear'">
            <Icon name="trash-2" />
          </button>
        </div>
      </aside>
    </div>

    <div class="keys-bar">
      <span v-for="[k, label] in KEYS" :key="k"><kbd>{{ k }}</kbd>{{ label }}</span>
      <span class="sp" />
      <span><Icon name="banknote" /> الدفع كاش في النسخة دي</span>
    </div>

    <PayModal
      v-if="modal === 'pay'"
      :lines="invoice.lines"
      :total-minor="totals.totalMinor"
      :count="totals.count"
      @close="closeModal"
      @paid="onPaid"
      @price-changed="onPriceChanged"
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
  </div>
</template>

<style scoped>
.tiles-note {
  grid-column: 1 / -1;
}
/* Three actions under «ادفع» in this build (cash only, no discount yet). */
.cart-actions {
  grid-template-columns: 1fr 1fr auto;
}
.btn-pay kbd,
.cart-actions kbd {
  margin-inline-start: 2px;
}
</style>
