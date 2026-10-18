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
import ShortagesPanel from './ShortagesPanel.vue';
import type { RegisteredUsedPhone } from '../../api/brands';

defineProps<{
  session?: Session | null;
}>();

const activeTab = ref<'items' | 'shortages'>('items');
const shortagesCount = ref(0);
/** The kind chooser behind «صنف جديد»; the form it names opens next. */
const kind = ref(false);
const newPhone = ref(false);
const newUsed = ref(false);
const newUsedMode = ref<'catalog' | 'opening'>('catalog');
const newItem = ref(false);
const showImeiCheck = ref(false);
/** Bumped after an item is registered, so the panels read the catalogue again. */
const reload = ref(0);
const damagedItems = ref<readonly DamagedStockRow[]>([]);

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

async function loadStoreMeta(): Promise<void> {
  await Promise.all([loadDamaged(), loadShortagesBadge()]);
}

onMounted(loadStoreMeta);
watch(reload, loadStoreMeta);

function pick(kindPicked: 'phone' | 'used' | 'item'): void {
  kind.value = false;
  if (kindPicked === 'phone') newPhone.value = true;
  else if (kindPicked === 'used') {
    newUsedMode.value = 'catalog';
    newUsed.value = true;
  } else newItem.value = true;
}

function registered(name: string): void {
  newPhone.value = false;
  newItem.value = false;
  reload.value += 1;
  toast(`اتسجّل «${name}». استلم الكمية بسعر الشراء من «استلام توريد»`, 'ok', 4500);
}

function usedSaved(_registered: RegisteredUsedPhone, keepOpen: boolean): void {
  reload.value += 1;
  if (!keepOpen) {
    newUsed.value = false;
  }
}
</script>

<template>
  <div class="page">
    <div class="page-h">
      <h2>الأصناف والكميات</h2>
      <span class="sub">سجّل الصنف بسعره، وبعدين استلم الكمية بسعر الشراء. التكلفة بتتحسب بالمتوسط المرجح.</span>
      <span class="sp"></span>
      <button type="button" class="btn primary" @click="kind = true"><Icon name="package-plus" /> صنف جديد</button>
      <button
        type="button"
        class="btn"
        data-open-used-phone
        @click="
          newUsedMode = 'catalog';
          newUsed = true;
        "
      >
        <Icon name="recycle" /> شراء مستعمل من عميل
      </button>
      <button
        type="button"
        class="btn ghost"
        data-open-imei-check
        @click="showImeiCheck = true"
      >
        <Icon name="search" /> فحص الـ IMEI
      </button>
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

    <template v-if="activeTab === 'items'">
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

    <div class="legacy-grid">
      <section class="card legacy-panel"><CatalogPanel :key="`c${reload}`" /></section>
      <section class="card legacy-panel">
        <StockPanel :key="`s${reload}`" @new-item="kind = true" @received="loadShortagesBadge" />
      </section>
    </div>
    </template>

    <ShortagesPanel
      v-else
      :session="session ?? null"
      @changed="shortagesCount = $event"
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
  </div>
</template>

<style scoped>
.page-h .sp {
  flex: 1;
}
</style>
