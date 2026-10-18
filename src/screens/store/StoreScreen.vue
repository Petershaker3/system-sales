<script setup lang="ts">
// «المخزن» (owner decision ADR-016 #26). For now it hosts the panels that
// already work — products (with their category, ADR-018 §1) and stock
// receiving — in the new frame, and «صنف جديد» (ADR-018 §2 and §3). The
// categories and the phone companies are managed from the settings, as in the
// mockup. The full store screen of the mockup (variants, IMEI receiving,
// shortages) arrives with the next steps of plan item 1.2 and with 1.4 and 1.15.
import { computed, onMounted, ref, watch } from 'vue';

import { type DamagedStockRow, listDamagedStock } from '../../api/sales';
import CatalogPanel from '../../components/CatalogPanel.vue';
import StockPanel from '../../components/StockPanel.vue';
import { fmtDate, fmtTime, money, num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import NewItemKindModal from './NewItemKindModal.vue';
import NewItemModal from './NewItemModal.vue';
import NewPhoneModal from './NewPhoneModal.vue';

/** The kind chooser behind «صنف جديد»; the form it names opens next. */
const kind = ref(false);
const newPhone = ref(false);
const newItem = ref(false);
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

onMounted(loadDamaged);
watch(reload, loadDamaged);

function pick(kindPicked: 'phone' | 'item'): void {
  kind.value = false;
  if (kindPicked === 'phone') newPhone.value = true;
  else newItem.value = true;
}

function registered(name: string): void {
  newPhone.value = false;
  newItem.value = false;
  reload.value += 1;
  toast(`اتسجّل «${name}». استلم الكمية بسعر الشراء من «استلام توريد»`, 'ok', 4500);
}
</script>

<template>
  <div class="page">
    <div class="page-h">
      <h2>الأصناف والكميات</h2>
      <span class="sub">سجّل الصنف بسعره، وبعدين استلم الكمية بسعر الشراء. التكلفة بتتحسب بالمتوسط المرجح.</span>
      <span class="sp"></span>
      <button type="button" class="btn primary" @click="kind = true"><Icon name="package-plus" /> صنف جديد</button>
    </div>
    <div class="note"><Icon name="info" /><span>الاستلام بالـ IMEI شغّال من «استلام توريد»، وتنبيهات النواقص جاية في المرحلة 1.15.</span></div>

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
      <section class="card legacy-panel"><StockPanel :key="`s${reload}`" @new-item="kind = true" /></section>
    </div>

    <NewItemKindModal v-if="kind" @close="kind = false" @pick="pick" />
    <NewPhoneModal v-if="newPhone" @close="newPhone = false" @created="registered" />
    <NewItemModal v-if="newItem" @close="newItem = false" @created="registered" />
  </div>
</template>

<style scoped>
.page-h .sp {
  flex: 1;
}
</style>
