<script setup lang="ts">
// «الهواتف» — the shop's handsets as their own section (owner request, 2026-10-23).
//
// Why a section of its own: a phone shop's stock is not one list. It is
//   * handsets, each with its own IMEI and its own cost,
//   * models, where the question is «how many left and what did they cost me»,
//   * and a count that has to be read two ways — by number, and by money.
// All three existed inside «المخزن» and «البيع» separately, and the owner had to
// assemble the answer himself. Nothing here is new data: the same
// `list_all_product_units` and `pos_catalog` the rest of the app reads.
//
// Tabs are the four questions: الأجهزة (each handset), الموديلات (each model),
// الجرد (عدد أو فلوس), and الإعداد (the phone settings, where they live).

import { computed, onMounted, ref } from 'vue';

import { describeError } from '../../api/errors';
import { listAllProductUnits, type ProductUnit } from '../../api/inventory';
import { posCatalog, type PosCatalog, type PosProduct } from '../../api/pos';
import { money, num, pcsWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import {
  buildPhoneModels,
  daysInStock,
  isPhoneProduct,
  isUsedUnit,
  matchesPhone,
  phoneTotals,
} from './phones';

type Tab = 'units' | 'models' | 'count' | 'setup';

const TABS: readonly { id: Tab; label: string; icon: 'smartphone' | 'boxes' | 'clipboard-list' | 'sliders-horizontal' }[] = [
  { id: 'units', label: 'الأجهزة', icon: 'smartphone' },
  { id: 'models', label: 'الموديلات', icon: 'boxes' },
  { id: 'count', label: 'الجرد', icon: 'clipboard-list' },
  { id: 'setup', label: 'الإعداد', icon: 'sliders-horizontal' },
];

const tab = ref<Tab>('units');
const query = ref('');
const loadState = ref<'loading' | 'ready' | 'error'>('loading');
const loadError = ref('');

const products = ref<readonly PosProduct[]>([]);
const brands = ref<PosCatalog['brands']>([]);
const units = ref<readonly ProductUnit[]>([]);
const now = Date.now();

onMounted(async () => {
  try {
    const [catalog, all] = await Promise.all([posCatalog(), listAllProductUnits()]);
    products.value = catalog.products;
    brands.value = catalog.brands;
    units.value = all;
    loadState.value = 'ready';
  } catch (err) {
    loadError.value = describeError(err);
    loadState.value = 'error';
  }
});

const productById = computed(() => new Map(products.value.map((p) => [p.id, p])));
const brandById = computed(() => new Map(brands.value.map((b) => [b.id, b])));

/** Only handsets: a screen protector is stock, not a phone. */
const phoneProducts = computed(() => products.value.filter(isPhoneProduct));

const models = computed(() =>
  buildPhoneModels(
    phoneProducts.value.map((p) => ({
      id: p.id,
      name: p.name,
      salePriceMinor: p.salePriceMinor,
      disposition: p.disposition,
      categoryId: p.categoryId,
      status: 'active',
      onHand: p.onHand,
      tracking: p.tracking ?? 'none',
    })),
    units.value,
  ),
);

const totals = computed(() => phoneTotals(models.value));

/** Every handset, with the model and company beside it, newest first. */
const rows = computed(() => {
  const list = units.value.map((unit) => {
    const product = productById.value.get(unit.productId);
    const brand = product?.brandId ? brandById.value.get(product.brandId) : undefined;
    return {
      unit,
      name: product?.name ?? 'صنف مش في الكتالوج',
      brand: brand?.name ?? '',
      used: isUsedUnit(unit),
      days: daysInStock(unit.createdAt, now),
      costMinor: unit.unitCostMinor ?? 0,
    };
  });
  return list.sort((a, b) => b.unit.createdAt - a.unit.createdAt);
});

const filteredRows = computed(() =>
  rows.value.filter((row) =>
    matchesPhone(query.value, {
      name: `${row.name} ${row.brand}`,
      imei: row.unit.imei,
      color: row.unit.color,
    }),
  ),
);

const filteredModels = computed(() =>
  models.value.filter((m) => matchesPhone(query.value, { name: m.name })),
);

const filteredTotals = computed(() => {
  const ids = new Set(filteredModels.value.map((m) => m.productId));
  return phoneTotals(models.value.filter((m) => ids.has(m.productId)));
});

/** The count tab reads one list two ways; this is the switch between them. */
const countMode = ref<'number' | 'money'>('number');

const byCompany = computed(() => {
  const map = new Map<string, { name: string; units: number; costMinor: number; saleMinor: number }>();
  for (const row of rows.value) {
    const key = row.brand === '' ? 'بدون شركة' : row.brand;
    const current = map.get(key) ?? { name: key, units: 0, costMinor: 0, saleMinor: 0 };
    const price = productById.value.get(row.unit.productId)?.salePriceMinor ?? 0;
    map.set(key, {
      ...current,
      units: current.units + 1,
      costMinor: current.costMinor + row.costMinor,
      saleMinor: current.saleMinor + price,
    });
  }
  return [...map.values()].sort((a, b) => b.units - a.units || b.costMinor - a.costMinor);
});

/** Phone settings live in الإعدادات; this screen sends the owner there. */
function openSettingsTab(id: 'catalog' | 'receipt' | 'look' | 'rail'): void {
  window.dispatchEvent(new CustomEvent('mshop:open-settings', { detail: { tab: id } }));
}

const imeiModeLabel = computed(() => 'اختياري');
</script>

<template>
  <div class="page phones-page" data-phones-screen>
    <div class="page-h">
      <h2>الهواتف</h2>
      <span class="sub">الجهاز والـIMEI والتكلفة والسعر — كل حاجة في مكان واحد</span>
    </div>

    <!-- what the shelf is worth, in the two units the owner counts in -->
    <div class="phone-hero" data-phone-hero>
      <div class="ph-cell">
        <small>عدد الأجهزة</small>
        <b class="num" data-phone-units>{{ num(totals.units) }}</b>
        <span>{{ pcsWord(totals.units) }}</span>
      </div>
      <div class="ph-cell">
        <small>جديد / مستعمل</small>
        <b class="num">{{ num(totals.units - totals.usedUnits) }} / {{ num(totals.usedUnits) }}</b>
        <span>جهاز</span>
      </div>
      <div class="ph-cell">
        <small>قيمة الشراء</small>
        <b class="num" data-phone-cost>{{ money(totals.costMinor) }}</b>
        <span>الفلوس اللي في الرف</span>
      </div>
      <div class="ph-cell">
        <small>قيمة البيع المتوقعة</small>
        <b class="num" data-phone-sale>{{ totals.saleMinor === null ? 'فيه موديل من غير سعر' : money(totals.saleMinor) }}</b>
        <span v-if="totals.expectedProfitMinor !== null" class="ok-t">
          صافي متوقع {{ money(totals.expectedProfitMinor) }}
        </span>
        <span v-else-if="totals.unregistered > 0">فيه أجهزة من غير تكلفة مسجّلة</span>
        <span v-else>سعّر الموديلات اللي من غير سعر</span>
      </div>
    </div>

    <p v-if="totals.unregistered > 0" class="note warn" data-phone-unregistered>
      <Icon name="triangle-alert" />
      <span>
        فيه {{ num(totals.unregistered) }} جهاز في المخزن من غير IMEI مسجّل —
        سجّله من «المخزن» ← «استلام توريد» عشان تقدر تبيعه وتراجع رقمه.
      </span>
    </p>

    <div class="phone-bar">
      <div class="tabs" data-phone-tabs>
        <button
          v-for="t in TABS"
          :key="t.id"
          type="button"
          class="btn sm"
          :class="{ primary: tab === t.id }"
          :data-phone-tab="t.id"
          @click="tab = t.id"
        >
          <Icon :name="t.icon" /> {{ t.label }}
        </button>
      </div>
      <label class="phone-search">
        <Icon name="search" />
        <input
          v-model="query"
          type="search"
          autocomplete="off"
          data-phone-search
          placeholder="ابحث بالموديل أو الـIMEI أو اللون…"
        />
      </label>
    </div>

    <div v-if="loadState === 'error'" class="note warn">
      <Icon name="triangle-alert" /><span>{{ loadError }}</span>
    </div>

    <!-- 1· every handset ---------------------------------------------------- -->
    <div v-show="tab === 'units'" data-phone-panel="units">
      <table class="t sv-t phone-table">
        <thead>
          <tr>
            <th>الموديل</th>
            <th>الشركة</th>
            <th>IMEI</th>
            <th>الحالة</th>
            <th>اللون</th>
            <th class="ta-n">التكلفة</th>
            <th class="ta-n">المدة في الرف</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredRows" :key="row.unit.id" :data-phone-unit="row.unit.id">
            <td>{{ row.name }}</td>
            <td>{{ row.brand || '—' }}</td>
            <td class="mono"><bdi dir="ltr">{{ row.unit.imei }}</bdi></td>
            <td>
              <span class="pill" :class="row.used ? 'warn' : 'ok'">{{ row.used ? 'مستعمل' : 'جديد' }}</span>
            </td>
            <td>{{ row.unit.color || '—' }}</td>
            <td class="ta-n num">{{ money(row.costMinor) }}</td>
            <td class="ta-n num">{{ num(row.days) }} يوم</td>
          </tr>
          <tr v-if="filteredRows.length === 0">
            <td colspan="7" class="empty">
              {{
                query
                  ? 'مفيش جهاز بالبحث ده'
                  : 'مفيش أجهزة متسجلة بالـIMEI — استلم الجهاز ورقمه من «المخزن»'
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 2· every model ------------------------------------------------------ -->
    <div v-show="tab === 'models'" data-phone-panel="models">
      <table class="t sv-t phone-table">
        <thead>
          <tr>
            <th>الموديل</th>
            <th class="ta-n">متاح</th>
            <th class="ta-n">من غير IMEI</th>
            <th class="ta-n">جديد</th>
            <th class="ta-n">مستعمل</th>
            <th class="ta-n">متوسط التكلفة</th>
            <th class="ta-n">سعر البيع</th>
            <th class="ta-n">قيمة الرف</th>
            <th class="ta-n">آخر استلام</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="m in filteredModels" :key="m.productId" :data-phone-model="m.productId">
            <td>{{ m.name }}</td>
            <td class="ta-n num">{{ num(m.available) }}</td>
            <td class="ta-n num" :class="{ 'danger-t': m.unregistered > 0 }">
              {{ m.unregistered > 0 ? num(m.unregistered) : '—' }}
            </td>
            <td class="ta-n num">{{ num(m.newCount) }}</td>
            <td class="ta-n num">{{ num(m.usedCount) }}</td>
            <td class="ta-n num">{{ m.available === 0 ? '—' : money(m.avgCostMinor) }}</td>
            <td class="ta-n num">{{ m.salePriceMinor === null ? 'من غير سعر' : money(m.salePriceMinor) }}</td>
            <td class="ta-n num">{{ money(m.costMinor) }}</td>
            <td class="ta-n num">{{ m.newestAt === 0 ? '—' : `${num(daysInStock(m.newestAt, now))} يوم` }}</td>
          </tr>
          <tr v-if="filteredModels.length === 0">
            <td colspan="9" class="empty">مفيش موديلات موبايلات في الكتالوج</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 3· the count, two ways ---------------------------------------------- -->
    <div v-show="tab === 'count'" data-phone-panel="count">
      <div class="count-switch">
        <button
          type="button"
          class="btn sm"
          :class="{ primary: countMode === 'number' }"
          data-count-mode="number"
          @click="countMode = 'number'"
        >
          <Icon name="boxes" /> بالعدد
        </button>
        <button
          type="button"
          class="btn sm"
          :class="{ primary: countMode === 'money' }"
          data-count-mode="money"
          @click="countMode = 'money'"
        >
          <Icon name="banknote" /> بالفلوس
        </button>
      </div>

      <table class="t sv-t phone-table">
        <thead>
          <tr>
            <th>الشركة</th>
            <th class="ta-n">{{ countMode === 'number' ? 'عدد الأجهزة' : 'قيمة الشراء' }}</th>
            <th class="ta-n" v-if="countMode === 'money'">قيمة البيع المتوقعة</th>
            <th class="ta-n" v-if="countMode === 'number'">نسبة من الرف</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in byCompany" :key="c.name" :data-company-row="c.name">
            <td>{{ c.name }}</td>
            <td class="ta-n num">
              {{ countMode === 'number' ? num(c.units) : money(c.costMinor) }}
            </td>
            <td class="ta-n num" v-if="countMode === 'money'">{{ money(c.saleMinor) }}</td>
            <td class="ta-n num" v-if="countMode === 'number'">
              {{ totals.units === 0 ? '—' : `${Math.round((c.units / totals.units) * 100)}%` }}
            </td>
          </tr>
          <tr class="tot-row">
            <td><b>الإجمالي</b></td>
            <td class="ta-n num">
              <b>{{ countMode === 'number' ? num(filteredTotals.units) : money(filteredTotals.costMinor) }}</b>
            </td>
            <td class="ta-n num" v-if="countMode === 'money'">
              <b>{{ filteredTotals.saleMinor === null ? '—' : money(filteredTotals.saleMinor) }}</b>
            </td>
            <td class="ta-n num" v-if="countMode === 'number'"><b>100%</b></td>
          </tr>
        </tbody>
      </table>
      <p class="hint">
        «بالعدد» بيجاوب: عندي كام جهاز؟ «بالفلوس» بيجاوب: الرف واقف فيه كام،
        وهيجيب كام. الاتنين من نفس القايمة، فمستحيل يختلفوا.
      </p>
    </div>

    <!-- 4· the phone settings, and where they live -------------------------- -->
    <div v-show="tab === 'setup'" data-phone-panel="setup">
      <div class="setup-grid">
        <article class="setup-card">
          <h3><Icon name="shield-check" /> الضمان</h3>
          <p>
            مدة ضمان الموبايل الجديد والمستعمل بتتحط في الإيصال والضمان، وبتتطبق
            على كل جهاز.
          </p>
          <button type="button" class="btn sm" data-goto="receipt" @click="openSettingsTab('receipt')">
            افتح الإيصال والضمان
          </button>
        </article>
        <article class="setup-card">
          <h3><Icon name="scan-line" /> الـIMEI</h3>
          <p>
            الوضع الحالي: <b>{{ imeiModeLabel }}</b>. لو خليته «إلزامي» مش هينفع تبيع
            جهاز من غير ما تكتب رقمه.
          </p>
          <button type="button" class="btn sm" data-goto="catalog" @click="openSettingsTab('catalog')">
            افتح الأصناف والبيع
          </button>
        </article>
        <article class="setup-card">
          <h3><Icon name="tags" /> الشركات والتصنيفات</h3>
          <p>
            شركات الموبايلات (سامسونج، أيفون…) وتصنيفات «موبايلات جديدة» و«مستعمل»
            بتتظبط من الإعدادات، وبتظهر في البحث وفي شاشة البيع.
          </p>
          <button type="button" class="btn sm" data-goto="catalog" @click="openSettingsTab('catalog')">
            افتح الأصناف والبيع
          </button>
        </article>
      </div>
      <p class="hint">
        تسجيل جهاز جديد (جديد أو مستعمل، بالـIMEI والتكلفة وسعر البيع) من
        «المخزن» ← «صنف جديد» ← «موبايل».
      </p>
    </div>
  </div>
</template>

<style scoped>
.phone-hero {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}
.ph-cell {
  display: grid;
  gap: 2px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-m);
  background: var(--surface);
}
.ph-cell small {
  color: var(--muted);
  font-size: 0.8rem;
}
.ph-cell b {
  font-size: 1.45rem;
  line-height: 1.2;
}
.ph-cell span {
  color: var(--text-2);
  font-size: 0.82rem;
}
.ok-t {
  color: var(--ok);
}
.phone-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.phone-search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 240px;
  height: 42px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-m);
  background: var(--surface);
  color: var(--muted);
}
.phone-search input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  outline: none;
  font-size: 1rem;
  color: var(--text);
}
.phone-table {
  width: 100%;
}
.phone-table .empty {
  text-align: center;
  color: var(--muted);
  padding: 18px;
}
.tot-row td {
  border-top: 2px solid var(--border-strong);
}
.count-switch {
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
}
.pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 0.78rem;
  font-weight: 600;
}
.pill.ok {
  background: color-mix(in srgb, var(--ok) 14%, transparent);
  color: var(--ok);
}
.pill.warn {
  background: color-mix(in srgb, var(--warn, #a86b00) 16%, transparent);
  color: var(--warn, #a86b00);
}
.setup-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px;
}
.setup-card {
  display: grid;
  gap: 8px;
  align-content: start;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-m);
  background: var(--surface);
}
.setup-card h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 1rem;
}
.setup-card p {
  margin: 0;
  color: var(--text-2);
  font-size: 0.88rem;
  line-height: 1.6;
}
.setup-card .btn {
  justify-self: start;
}
</style>
