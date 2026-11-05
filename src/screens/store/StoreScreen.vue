<script setup lang="ts">
// «المخزن» (owner decision ADR-016 #26, Plan item 1.15, ADR-030).
// Hosts two tabs:
// - «الأصناف»: products, stock receiving (with IMEIs and moving-average cost),
//   and damaged stock from returns.
// - «النواقص (عددها)»: manual & suggested shortages list with status tracking
//   («ناقص» / «اتطلب» / «وصل») and waiting customer alerts.
import { computed, onMounted, ref, watch } from 'vue';

import type { Session } from '../../api/identity';
import { type DamagedStockRow, listDamagedStock } from '../../api/sales';
import { posCatalog } from '../../api/pos';
import { shortagesOverview } from '../../api/shortages';
import CatalogPanel from '../../components/CatalogPanel.vue';
import StockPanel from '../../components/StockPanel.vue';
import { fmtDate, fmtTime, money, num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import NewItemKindModal from './NewItemKindModal.vue';
import NewItemModal from './NewItemModal.vue';
import NewPhoneModal from './NewPhoneModal.vue';
import NewUsedPhoneModal from './NewUsedPhoneModal.vue';
import ImeiCheckModal from './ImeiCheckModal.vue';
import LabelsModal from './LabelsModal.vue';
import StockCountModal from './StockCountModal.vue';
import ShortagesPanel from './ShortagesPanel.vue';
import { type RegisteredUsedPhone, listBrands, type BrandEntry } from '../../api/brands';
import { listAllProductUnits, listReceipts, stockValue, type ReceiptRow, type StockValue } from '../../api/inventory';
import {
  buildCountSheet,
  type CountScope,
  countScopePieces,
  countSheetPieces,
  filterCountRows,
  isDeviceProduct,
  storeFigures,
} from './count-sheet';

const props = defineProps<{
  session?: Session | null;
  /**
   * A product another screen asked to receive (`mshop:open-receive`), and a nonce so
   * pressing «+ مخزون» twice on the same product still lands on the form.
   */
  incomingProduct?: string;
  incomingNonce?: number;
}>();

const activeTab = ref<'items' | 'devices' | 'receive' | 'count' | 'shortages' | 'damaged'>(
  'items'
);
const shortagesCount = ref(0);
/** The kind chooser behind «صنف جديد»; the form it names opens next. */
const kind = ref(false);
const newPhone = ref(false);
const newUsed = ref(false);
const newUsedMode = ref<'catalog' | 'opening'>('catalog');
const newItem = ref(false);
const showImeiCheck = ref(false);
const showLabels = ref(false);
const showStockCount = ref(false);
const labelsInitialProductId = ref<string | null>(null);
const labelsInitialUnitId = ref<string | null>(null);
/** Bumped after an item is registered, so the panels read the catalogue again. */
const reload = ref(0);
const damagedItems = ref<readonly DamagedStockRow[]>([]);

/**
 * The phone shelf, counted from the sales catalogue: models, pieces, and how
 * many models still have no sale price. The full shelf — IMEI, cost, company —
 * is قسم «الهواتف»; this is المخزن's own reading of it (owner, 2026-11-02).
 */
const deviceProducts = ref<
  readonly {
    id: string;
    name: string;
    disposition: string;
    deviceType?: 'touch' | 'keypad' | null;
    brandId?: string | null;
    onHand: number;
    salePriceMinor: number | null;
    tracking?: string | null;
  }[]
>([]);
const devicePieces = ref(0);
/** Companies, for their names on the count sheet. */
const brands = ref<readonly BrandEntry[]>([]);
/** Cost per device in stock — absent when the session may not see cost. */
const unitCosts = ref<readonly { unitCostMinor?: number | null }[]>([]);
/** The whole stock at cost, in one answer from Rust. */
const stock = ref<StockValue | null>(null);
/** The receiving log shown under «استلام توريد». */
const receipts = ref<readonly ReceiptRow[]>([]);

const deviceModels = computed(() => deviceProducts.value.filter(isDeviceProduct).length);
const deviceNoPrice = computed(
  () =>
    deviceProducts.value.filter((p) => isDeviceProduct(p) && p.salePriceMinor === null).length
);

async function loadDevices(): Promise<void> {
  try {
    const catalog = await posCatalog();
    deviceProducts.value = catalog.products;
    devicePieces.value = (catalog.units ?? []).length;
  } catch {
    // A session without the sales read simply sees the counts empty.
  }
}

const damagedTotalQty = computed(() =>
  damagedItems.value.reduce((sum, d) => sum + d.quantity, 0)
);
const damagedTotalCostMinor = computed<number | null>(() => {
  let sum = 0;
  let hasCost = false;
  for (const d of damagedItems.value) {
    if (typeof d.totalCostMinor === 'number') {
      sum += d.totalCostMinor;
      hasCost = true;
    }
  }
  return hasCost ? sum : null;
});

const companyOf = (brandId: string | null): string => {
  if (!brandId) return 'بدون شركة';
  return brands.value.find((b) => b.id === brandId)?.name ?? 'بدون شركة';
};

/** The count sheet: phones by shelf (زراير / تانش) and everything counted by quantity. */
const countSheet = computed(() =>
  buildCountSheet(deviceProducts.value, companyOf)
);
const countScope = ref<CountScope>('all');
const countRows = computed(() => filterCountRows(countSheet.value.rows, countScope.value));
const countPieces = computed(() => countSheetPieces(countSheet.value));
const scopePieces = computed(() => countScopePieces(countSheet.value, countScope.value));

/** The four figures above the tabs: wholesale value, pieces, shortages, no price. */
const figures = computed(() =>
  storeFigures({ products: deviceProducts.value, units: unitCosts.value })
);

/** «قيمة المخزن بالجملة»: Rust's one answer, or the devices' unit costs if it is refused. */
const stockValueMinor = computed<number | null>(() =>
  stock.value ? stock.value.valueMinor : figures.value.deviceValueMinor
);
const stockPieces = computed(() =>
  stock.value ? stock.value.quantity : figures.value.totalPieces
);

async function loadDamaged(): Promise<void> {
  try {
    damagedItems.value = await listDamagedStock(100);
  } catch {
    // Non-blocking if session lacks inventory permission.
  }
}

async function loadShortagesBadge(): Promise<void> {
  try {
    const ov = await shortagesOverview();
    shortagesCount.value = ov.items.length;
  } catch {
    // Non-blocking
  }
}

async function loadCosts(): Promise<void> {
  try {
    stock.value = await stockValue();
  } catch {
    // No cost in view: the devices' own unit costs (if any) still say something.
    stock.value = null;
  }
  try {
    const units = await listAllProductUnits();
    unitCosts.value = units.map((u) => ({ unitCostMinor: u.unitCostMinor ?? null }));
  } catch {
    // A session that may not see cost still counts pieces; the value says «—».
    unitCosts.value = [];
  }
}

async function loadReceipts(): Promise<void> {
  try {
    receipts.value = await listReceipts(100);
  } catch {
    receipts.value = [];
  }
}

async function loadBrandNames(): Promise<void> {
  try {
    brands.value = await listBrands();
  } catch {
    // No company names then; the sheet shows «بدون شركة» rather than failing.
  }
}

async function loadStoreMeta(): Promise<void> {
  await Promise.all([
    loadDamaged(),
    loadShortagesBadge(),
    loadDevices(),
    loadCosts(),
    loadBrandNames(),
    loadReceipts(),
  ]);
}

onMounted(() => {
  // A product handed over by «الهواتف» before this screen existed: the event fired
  // while the store was not mounted, so the mount is the delivery.
  if (props.incomingProduct !== undefined && props.incomingProduct !== '') {
    openReceive(props.incomingProduct);
  }
  void loadStoreMeta();
});
watch(reload, loadStoreMeta);

// Another screen («الهواتف») may ask this one to receive a product it is showing.
watch(
  () => props.incomingNonce,
  () => {
    if (props.incomingProduct !== undefined && props.incomingProduct !== '') {
      openReceive(props.incomingProduct);
    }
  }
);

function pick(kindPicked: 'phone' | 'used' | 'item'): void {
  kind.value = false;
  if (kindPicked === 'phone') newPhone.value = true;
  else if (kindPicked === 'used') {
    newUsedMode.value = 'catalog';
    newUsed.value = true;
  } else newItem.value = true;
}

/** The product «استلام توريد» should open on, set the moment one is registered. */
const justCreated = ref('');

/**
 * Open the delivery form on a product the shopkeeper pressed «+ مخزون» on.
 *
 * The tab changes and the panel is re-keyed on the id, because a panel already open
 * on another product must not keep showing that one: the whole point of the press is
 * «this product, here».
 */
function openReceive(productId: string): void {
  justCreated.value = productId;
  activeTab.value = 'receive';
}

function registered(name: string, productId = ''): void {
  newPhone.value = false;
  newItem.value = false;
  justCreated.value = productId;
  // A new item has no stock yet: send him straight to «الاستلام» with it selected.
  if (productId !== '') activeTab.value = 'receive';
  reload.value += 1;
  toast(
    productId === ''
      ? `اتسجّل «${name}». استلم الكمية بسعر الشراء من «استلام توريد»`
      : `اتسجّل «${name}» و«استلام توريد» فتح عليه — حطّ الكمية وسعر الشراء`,
    'ok',
    4500,
  );
}

function usedSaved(_registered: RegisteredUsedPhone, keepOpen: boolean): void {
  reload.value += 1;
  if (!keepOpen) {
    newUsed.value = false;
  }
}

function openLabelsModal(productId?: string | null, unitId?: string | null): void {
  labelsInitialProductId.value = productId ?? null;
  labelsInitialUnitId.value = unitId ?? null;
  showLabels.value = true;
}
</script>

<template>
  <div class="page">
    <div class="page-h">
      <h2>المخزن</h2>
      <span class="sub">الكميات والتكلفة: التكلفة بالجملة (المتوسط المرجح) مش بسعر البيع.</span>
      <span class="sp"></span>
      <button type="button" class="btn primary" @click="kind = true"><Icon name="package-plus" /> صنف جديد</button>
    </div>

    <!-- أهم رقم قبل أي حاجة تانية: قيمة الرف، القطع، النواقص، اللي من غير سعر -->
    <div class="store-figs" data-store-figs>
      <div class="store-fig">
        <small>قيمة المخزن بالجملة</small>
        <b class="num" data-store-fig-value>
          {{ stockValueMinor === null ? '—' : money(stockValueMinor) }}
        </b>
      </div>
      <div class="store-fig">
        <small>القطع في المخزن</small>
        <b class="num" data-store-fig-pieces>{{ num(stockPieces) }}</b>
      </div>
      <div class="store-fig" :class="{ 'store-fig-warn': shortagesCount > 0 }">
        <small>النواقص</small>
        <b class="num" data-store-fig-shortages>{{ num(shortagesCount) }}</b>
      </div>
      <div class="store-fig" :class="{ 'store-fig-warn': figures.noPriceModels > 0 }">
        <small>موديلات بلا سعر بيع</small>
        <b class="num" data-store-fig-noprice>{{ num(figures.noPriceModels) }}</b>
      </div>
    </div>

    <div class="inv-seg" role="tablist" aria-label="تبويبات المخزن" data-store-tabs style="align-self: flex-start">
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'items'"
        :class="{ active: activeTab === 'items' }"
        data-store-tab="items"
        @click="activeTab = 'items'"
      >
        <Icon name="boxes" /> الأصناف
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'devices'"
        :class="{ active: activeTab === 'devices' }"
        data-store-tab="devices"
        @click="activeTab = 'devices'"
      >
        <Icon name="smartphone" /> الأجهزة
        <span v-if="deviceNoPrice > 0" class="inv-badge num" data-store-noprice-badge>
          {{ num(deviceNoPrice) }}
        </span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'receive'"
        :class="{ active: activeTab === 'receive' }"
        data-store-tab="receive"
        @click="activeTab = 'receive'"
      >
        <Icon name="arrow-down-to-line" /> الاستلام
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'count'"
        :class="{ active: activeTab === 'count' }"
        data-store-tab="count"
        @click="activeTab = 'count'"
      >
        <Icon name="scan-line" /> الجرد
        <span v-if="figures.totalPieces > 0" class="inv-badge num" data-store-count-badge>
          {{ num(figures.totalPieces) }}
        </span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'damaged'"
        :class="{ active: activeTab === 'damaged' }"
        data-store-tab="damaged"
        @click="activeTab = 'damaged'"
      >
        <Icon name="triangle-alert" /> التالف
        <span v-if="damagedTotalQty > 0" class="inv-badge num" data-store-damaged-badge>
          {{ num(damagedTotalQty) }}
        </span>
      </button>
      <button
        type="button"
        role="tab"
        :aria-selected="activeTab === 'shortages'"
        :class="{ active: activeTab === 'shortages' }"
        data-store-tab="shortages"
        @click="activeTab = 'shortages'"
      >
        <Icon name="clipboard-list" /> النواقص
        <span
          v-if="shortagesCount > 0"
          class="inv-badge num"
          data-store-shortages-badge
        >
          {{ num(shortagesCount) }}
        </span>
      </button>
    </div>

    <!-- إجراءات ثانوية، بعد المحتوى الأساسي وقبل الشغل نفسه -->
    <div class="store-actions" data-store-actions>
      <button
        type="button"
        class="btn soft"
        data-open-used-phone
        @click="
          newUsedMode = 'catalog';
          newUsed = true;
        "
      >
        <Icon name="recycle" /> شراء مستعمل من عميل
      </button>
      <button type="button" class="btn soft" data-open-stock-count @click="showStockCount = true">
        <Icon name="scan-line" /> جرد بالمسح
      </button>
      <button type="button" class="btn ghost" data-open-labels @click="openLabelsModal()">
        <Icon name="tag" /> طباعة ملصقات
      </button>
      <button type="button" class="btn ghost" data-open-imei-check @click="showImeiCheck = true">
        <Icon name="search" /> فحص الـ IMEI
      </button>
    </div>

    <template v-if="activeTab === 'items'">
      <section class="card legacy-panel">
        <CatalogPanel
          :key="`c${reload}`"
          @print-label="openLabelsModal($event, null)"
          @receive="openReceive"
        />
      </section>
    </template>

    <!-- الاستلام: الكمية وسعر الشراء، والتكلفة بالمتوسط المرجح -->
    <template v-else-if="activeTab === 'receive'">
      <section class="card legacy-panel">
        <StockPanel
          :key="`s${reload}-${justCreated}`"
          :select-product="justCreated"
          @new-item="kind = true"
          @received="
            loadShortagesBadge();
            loadReceipts();
            loadCosts();
          "
        />
      </section>

      <!-- سجل التوريدات: اللي دخل المحل فعلاً، من مين، بكام -->
      <section class="card" data-store-receipts>
        <h3><Icon name="receipt-text" /> سجل التوريدات</h3>
        <p class="sub">آخر {{ num(receipts.length) }} استلام، الأحدث الأول.</p>
        <div v-if="receipts.length === 0" class="muted" data-receipts-empty>
          لسه مفيش توريدات متسجلة.
        </div>
        <div v-else class="table-wrap">
          <table class="t" data-receipts-table>
            <thead>
              <tr>
                <th>الصنف</th>
                <th class="ta-n">الكمية</th>
                <th class="ta-n">سعر الشراء</th>
                <th>المورد</th>
                <th>فاتورة المورد</th>
                <th>تاريخ الشراء</th>
              </tr>
            </thead>
            <tbody>
              <!--
                A receipt row answers the four questions the owner asks about a
                delivery: what came, how many, for how much each, and from whom with
                which paper (`0035`). The invoice number and the purchase day are the
                supplier's, not ours — «تاريخ الشراء» is when it was bought, and the
                register's own day is the day it was entered.
              -->
              <tr v-for="r in receipts" :key="r.id" :data-receipt-row="r.id">
                <td>
                  <b><bdi dir="auto">{{ r.productName }}</bdi></b>
                  <small v-if="r.receiptKind === 'opening'" class="tag warn">أول المدة</small>
                  <small v-if="r.note" class="muted note-line"><bdi dir="auto">{{ r.note }}</bdi></small>
                </td>
                <td class="ta-n num">{{ num(r.quantity) }}</td>
                <td class="ta-n num">{{ r.unitCostMinor === 0 ? '—' : money(r.unitCostMinor) }}</td>
                <td><bdi dir="auto">{{ r.supplierName ?? '—' }}</bdi></td>
                <td>
                  <bdi dir="ltr" class="mono">{{ r.documentRef ?? '—' }}</bdi>
                </td>
                <td class="muted">
                  <template v-if="r.purchaseDate">{{ r.purchaseDate }}</template>
                  <template v-else>—</template>
                  <small class="entered">
                    اتسجل {{ fmtDate(new Date(r.occurredAt)) }}
                  </small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- الجرد: بالعدد، ومقسوم زراير وتانش زي ما الرف متقسم -->
    <template v-else-if="activeTab === 'count'">
      <section class="card" data-store-count>
        <h3><Icon name="scan-line" /> الجرد بالعدد</h3>
        <p class="sub">
          عدّ الرف وقارن برقم السيستم. زراير وتانش منفصلين، والأصناف لوحدها.
        </p>

        <div class="count-figs">
          <button
            type="button"
            class="count-fig"
            :class="{ active: countScope === 'keypad' }"
            data-count-scope="keypad"
            @click="countScope = 'keypad'"
          >
            <small>زراير</small>
            <b class="num">{{ num(countSheet.keypad.pieces) }}</b>
            <span class="muted">{{ num(countSheet.keypad.models) }} موديل</span>
          </button>
          <button
            type="button"
            class="count-fig"
            :class="{ active: countScope === 'touch' }"
            data-count-scope="touch"
            @click="countScope = 'touch'"
          >
            <small>تانش</small>
            <b class="num">{{ num(countSheet.touch.pieces) }}</b>
            <span class="muted">{{ num(countSheet.touch.models) }} موديل</span>
          </button>
          <button
            type="button"
            class="count-fig"
            :class="{ active: countScope === 'all' }"
            data-count-scope="all"
            @click="countScope = 'all'"
          >
            <small>الكل</small>
            <b class="num">{{ num(countPieces) }}</b>
            <span class="muted">{{ num(countSheet.items.pieces) }} قطعة أصناف</span>
          </button>
        </div>

        <p class="sub" data-count-scope-pieces>
          {{ countScope === 'all' ? 'كل المخزن' : countScope === 'keypad' ? 'الزراير' : 'التانش' }}:
          <b class="num">{{ num(scopePieces) }}</b> قطعة
        </p>

        <div v-if="countRows.length === 0" class="muted" data-count-empty>
          مفيش موديلات في القسم ده.
        </div>
        <div v-else class="table-wrap">
          <table class="t" data-count-table>
            <thead>
              <tr>
                <th>الموديل</th>
                <th>الشركة</th>
                <th>النوع</th>
                <th class="ta-n">القطع في السيستم</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in countRows" :key="r.productId" :data-count-row="r.productId">
                <td><b><bdi dir="auto">{{ r.name }}</bdi></b></td>
                <td><bdi dir="auto">{{ r.company }}</bdi></td>
                <td>{{ r.kind === 'keypad' ? 'زراير' : r.kind === 'touch' ? 'تانش' : 'غير محدد' }}</td>
                <td class="ta-n num"><b>{{ num(r.pieces) }}</b></td>
              </tr>
            </tbody>
          </table>
        </div>

        <p class="note">
          <Icon name="clipboard-list" />
          <span>
            العدّ والفرق والتسوية بالمسح في «جرد بالمسح» تحت — هو اللي بيثبت الفرق في المخزن.
          </span>
        </p>
      </section>
    </template>

    <!-- الأجهزة: المخزن بيقرا رف الموبايلات بالأرقام، والتفاصيل في «الهواتف» -->
    <template v-else-if="activeTab === 'devices'">
      <section class="card" data-store-devices>
        <h3><Icon name="smartphone" /> الأجهزة في المخزن</h3>
        <p class="sub">
          ملخص رف الموبايلات. كل جهاز لوحده بالـIMEI والتكلفة والشركة في قسم «الهواتف»،
          والتسجيل من «صنف جديد ← موبايل» فوق.
        </p>
        <div class="device-figs">
          <div>
            <small>الموديلات</small>
            <b class="num" data-store-device-models>{{ num(deviceModels) }}</b>
          </div>
          <div>
            <small>القطع</small>
            <b class="num" data-store-device-pieces>{{ num(devicePieces) }}</b>
          </div>
          <div>
            <small>موديلات بلا سعر بيع</small>
            <b class="num" :class="{ 'danger-t': deviceNoPrice > 0 }" data-store-device-noprice>
              {{ num(deviceNoPrice) }}
            </b>
          </div>
        </div>
        <p v-if="deviceNoPrice > 0" class="note warn">
          <Icon name="triangle-alert" />
          <span>
            الموديلات اللي من غير سعر بيع مش هتقدر تتباع في واجهة البيع لحد ما تحط سعرها.
          </span>
        </p>
      </section>
    </template>

    <!-- التالف: تبويب لوحده بدل ما يزحم قايمة الأصناف -->
    <template v-else-if="activeTab === 'damaged'">
    <section
      class="card"
      style="margin-bottom: 16px; padding: 16px"
      data-damaged-stock-card
    >
      <div
        class="row"
        style="justify-content: space-between; align-items: center; margin-bottom: 10px"
      >
        <div>
          <h3 style="margin: 0">
            <Icon name="triangle-alert" /> مخزون تالف (مرتجعات تالفة)
          </h3>
          <small class="muted">
            الأصناف المرتجعة بحالة «تالف» بتدخل هنا بتكلفة السطر الأصلية ومبترجعش للمخزن المتاح للبيع.
          </small>
        </div>
        <div class="chips">
          <span class="tag danger" data-damaged-total-qty>
            إجمالي التالف: <b class="num">{{ num(damagedTotalQty) }}</b> قطعة
          </span>
          <span
            v-if="damagedTotalCostMinor !== null"
            class="tag"
            data-damaged-total-cost
          >
            تكلفة التالف: <b class="num">{{ money(damagedTotalCostMinor) }}</b>
          </span>
        </div>
      </div>

      <div v-if="damagedItems.length === 0" class="muted" data-damaged-empty>
        مفيش أي أصناف في مخزون التالف حالياً.
      </div>
      <div v-else class="table-wrap">
        <table class="t" data-damaged-table>
          <thead>
            <tr>
              <th>الصنف</th>
              <th>الفاتورة / المرتجع</th>
              <th class="ta-n">الكمية</th>
              <th class="ta-n">تكلفة الوحدة</th>
              <th class="ta-n">إجمالي التكلفة</th>
              <th>السبب</th>
              <th>التاريخ</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="d in damagedItems"
              :key="d.id"
              :data-damaged-row="d.returnReference"
            >
              <td>
                <b><bdi dir="auto">{{ d.productName }}</bdi></b>
                <span
                  v-if="d.imei"
                  class="tag mono"
                  dir="ltr"
                  style="margin-inline-start: 6px"
                >
                  IMEI: {{ d.imei }}
                </span>
              </td>
              <td>
                <span class="mono" dir="ltr">{{ d.saleReference }}</span>
                <span class="muted"> · </span>
                <span class="mono" dir="ltr">{{ d.returnReference }}</span>
              </td>
              <td class="ta-n num">
                <b>{{ num(d.quantity) }}</b>
              </td>
              <td class="ta-n num">
                {{
                  d.unitCostMinor !== undefined
                    ? money(d.unitCostMinor)
                    : '—'
                }}
              </td>
              <td class="ta-n num">
                <b>{{
                  d.totalCostMinor !== undefined
                    ? money(d.totalCostMinor)
                    : '—'
                }}</b>
              </td>
              <td><bdi dir="auto">{{ d.reason }}</bdi></td>
              <td class="muted">
                {{ fmtDate(new Date(d.occurredAt)) }} ·
                {{ fmtTime(new Date(d.occurredAt)) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    </template>

    <ShortagesPanel
      v-else
      :session="session ?? null"
      @changed="shortagesCount = $event"
      @receive="openReceive"
    />

    <NewItemKindModal v-if="kind" @close="kind = false" @pick="pick" />
    <NewPhoneModal v-if="newPhone" @close="newPhone = false" @created="registered" />
    <NewUsedPhoneModal
      v-if="newUsed"
      :mode="newUsedMode"
      can-back
      @close="newUsed = false"
      @back="
        newUsed = false;
        kind = true;
      "
      @saved="usedSaved"
    />
    <NewItemModal v-if="newItem" @close="newItem = false" @created="registered" />
    <ImeiCheckModal v-if="showImeiCheck" @close="showImeiCheck = false" />
    <LabelsModal
      v-if="showLabels"
      :initial-product-id="labelsInitialProductId"
      :initial-unit-id="labelsInitialUnitId"
      @close="showLabels = false"
      @barcode-generated="reload += 1"
    />
    <StockCountModal
      v-if="showStockCount"
      @close="showStockCount = false"
      @reconciled="reload += 1"
    />
  </div>
</template>

<style scoped>
.page-h .sp {
  flex: 1;
}

/* The register's receipt rows: the note sits under the product, and the day the row
   was entered sits under the purchase day, quieter than it. */
.note-line,
.entered {
  display: block;
  font-size: 0.76rem;
}

/* أهم رقم قبل المحتوى: قيمة الرف، القطع، النواقص، اللي من غير سعر */
.store-figs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 10px;
}

.store-fig {
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-m);
  background: var(--surface-2, var(--surface));
}

.store-fig small {
  color: var(--muted);
  font-size: 0.78rem;
}

.store-fig b {
  font-size: 1.1rem;
}

.store-fig-warn b {
  color: var(--danger, #c0392b);
}

/* إجراءات ثانوية: بعد التبويبات، مش فوقها */
.store-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.count-figs {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
  margin-bottom: 10px;
}

.count-fig {
  display: grid;
  gap: 2px;
  padding: 10px 12px;
  text-align: start;
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: var(--r-m);
  background: var(--surface-2, var(--surface));
  color: inherit;
  font: inherit;
}

.count-fig small {
  color: var(--muted);
  font-size: 0.78rem;
}

.count-fig b {
  font-size: 1.25rem;
}

.count-fig.active {
  border-color: var(--accent, #2563eb);
  box-shadow: inset 0 0 0 1px var(--accent, #2563eb);
}
</style>
