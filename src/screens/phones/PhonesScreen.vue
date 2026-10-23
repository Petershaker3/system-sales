<script setup lang="ts">
// «الهواتف» — the shop's handsets as their own section (owner request, 2026-10-23).
//
// The screen is two shelves, not a list with a filter: **جديد** and **مستعمل**.
// The owner was clear — «المستعمل ميتخلطش بالجديد، كل حاجة لوحدها» — so the two
// never share a table, a total, or a heading. A used handset is one that carries a
// condition (or a battery health); everything else is new.
//
// There are no tabs. A tab makes the owner choose between «الأجهزة» and
// «الموديلات» to answer one question about one shelf, so each shelf answers both
// at once: the model row carries the count and the money, and the handsets sit
// under it with their IMEI, colour and cost.
//
// The count switch («بالعدد» ⇄ «بالفلوس») changes how the shelf is read, never
// what it holds: both readings come from the same two built lists.
//
// The phone settings are not a tab either: three buttons at the foot open the
// settings tab that owns each rule.

import { computed, onMounted, ref } from 'vue';

import { describeError } from '../../api/errors';
import { listAllProductUnits, type ProductUnit } from '../../api/inventory';
import { posCatalog, type PosCatalog, type PosProduct } from '../../api/pos';
import { money, num, pcsWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import {
  buildPhoneModels,
  buildShelfCards,
  cardsTotals,
  companyCounts,
  daysInStock,
  isPhoneProduct,
  isUsedUnit,
  matchesPhone,
  type PhoneHandset,
} from './phones';

const loadState = ref<'loading' | 'ready' | 'error'>('loading');
const loadError = ref('');
const query = ref('');

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

/** Every handset, with the model and company beside it. */
const handsets = computed<PhoneHandset[]>(() =>
  units.value.map((unit) => {
    const product = productById.value.get(unit.productId);
    const brand = product?.brandId ? brandById.value.get(product.brandId) : undefined;
    return {
      id: unit.id,
      productId: unit.productId,
      name: product?.name ?? 'صنف مش في الكتالوج',
      brand: brand?.name ?? '',
      imei: unit.imei,
      color: unit.color ?? '',
      used: isUsedUnit(unit),
      costMinor: unit.unitCostMinor ?? 0,
      salePriceMinor: product?.salePriceMinor ?? null,
      createdAt: unit.createdAt,
      conditionGrade: unit.conditionGrade ?? null,
      batteryHealthPct: unit.batteryHealthPct ?? null,
    };
  }),
);

/** The two shelves, each built from its own kind only. */
const newCards = computed(() => buildShelfCards(models.value, handsets.value, 'new'));
const usedCards = computed(() => buildShelfCards(models.value, handsets.value, 'used'));

const newTotals = computed(() => cardsTotals(newCards.value));
const usedTotals = computed(() => cardsTotals(usedCards.value));

/** The count switch. Same shelf, read the other way. */
const countMode = ref<'number' | 'money'>('number');

const shelves = computed(() =>
  (
    [
      { kind: 'new', label: 'جديد', icon: 'sparkles', cards: newCards.value, totals: newTotals.value },
      { kind: 'used', label: 'مستعمل', icon: 'recycle', cards: usedCards.value, totals: usedTotals.value },
    ] as const
  ).map((shelf) => ({
    ...shelf,
    companies: companyCounts(shelf.cards),
    // The average cost of one handset on this shelf — over the handsets whose
    // cost is known. Stock received by quantity has no cost row, so it is left
    // out rather than counted as free.
    registeredCostMinor: shelf.cards.reduce(
      (sum, card) => sum + card.handsets.reduce((s2, h) => s2 + h.costMinor, 0),
      0,
    ),
    registeredCount: shelf.cards.reduce((sum, card) => sum + card.handsets.length, 0),
    cards: shelf.cards
      .map((card) => ({
        ...card,
        handsets: card.handsets.filter((h) =>
          matchesPhone(query.value, { name: `${h.name} ${h.brand}`, imei: h.imei, color: h.color }),
        ),
      }))
      .filter(
        (card) =>
          card.handsets.length > 0 ||
          (query.value === '' && card.unregistered > 0) ||
          (query.value !== '' && matchesPhone(query.value, { name: `${card.name} ${card.brand}` })),
      ),
  })),
);

/** A handset's subtitle on the used shelf: grade and battery, when they exist. */
function conditionText(handset: PhoneHandset): string {
  const bits: string[] = [];
  if (handset.conditionGrade) bits.push(`فئة ${handset.conditionGrade}`);
  if (handset.batteryHealthPct !== null && handset.batteryHealthPct !== undefined) {
    bits.push(`بطارية ${num(handset.batteryHealthPct)}%`);
  }
  return bits.join(' · ');
}

/** Jump to a shelf without turning the two into tabs. */
function scrollToShelf(kind: 'new' | 'used'): void {
  const el = document.querySelector(`[data-phone-shelf="${kind}"]`);
  if (el instanceof HTMLElement) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Phone settings live in الإعدادات; this screen sends the owner there. */
function openSettingsTab(id: 'catalog' | 'receipt' | 'look'): void {
  window.dispatchEvent(new CustomEvent('mshop:open-settings', { detail: { tab: id } }));
}
</script>

<template>
  <div class="page phones-page" data-phones-screen>
    <div class="page-h">
      <h2>الهواتف</h2>
      <span class="sub">الجديد لوحده، والمستعمل لوحده — كل جهاز بIMEIه وتكلفته وسعره</span>
    </div>

    <!-- the split, before the first scroll: how much is new, how much is used.
         (`.split` is taken by the inventory bar, so this block has its own name.) -->
    <div class="shelf-picker" data-phone-split>
      <button
        v-for="shelf in shelves"
        :key="`pick-${shelf.kind}`"
        type="button"
        class="shelf-pick"
        :class="`pick-${shelf.kind}`"
        :data-shelf-jump="shelf.kind"
        @click="scrollToShelf(shelf.kind)"
      >
        <Icon :name="shelf.icon" />
        <span class="pick-name">{{ shelf.label }}</span>
        <b class="num">{{ num(shelf.totals.units) }} {{ pcsWord(shelf.totals.units) }}</b>
        <span class="pick-sub">
          شراء {{ money(shelf.totals.costMinor) }} ·
          بيع {{ shelf.totals.saleMinor === null ? 'من غير سعر' : money(shelf.totals.saleMinor) }}
        </span>
      </button>
    </div>

    <!-- one switch for the whole screen: read the shelf by number or by money -->
    <div class="phone-bar">
      <div class="count-switch" data-phone-count-mode>
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

    <!-- two shelves: never one table with the used phones mixed in ---------- -->
    <section
      v-for="shelf in shelves"
      :key="shelf.kind"
      class="shelf"
      :class="`shelf-${shelf.kind}`"
      :data-phone-shelf="shelf.kind"
    >
      <header class="shelf-h">
        <div class="shelf-name">
          <Icon :name="shelf.icon" />
          <b>{{ shelf.label }}</b>
          <span class="pill" :class="shelf.kind === 'used' ? 'warn' : 'ok'">
            {{ num(shelf.totals.units) }} {{ pcsWord(shelf.totals.units) }}
          </span>
        </div>
        <div class="shelf-figs">
          <div>
            <small>قيمة الشراء</small>
            <b class="num" :data-phone-cost="shelf.kind">
              {{
                shelf.totals.costMinor === 0 && shelf.totals.units > 0
                  ? 'من غير تكلفة'
                  : money(shelf.totals.costMinor)
              }}
            </b>
          </div>
          <div>
            <small>قيمة البيع المتوقعة</small>
            <b class="num" :data-phone-sale="shelf.kind">
              {{ shelf.totals.saleMinor === null ? 'فيه موديل من غير سعر' : money(shelf.totals.saleMinor) }}
            </b>
          </div>
          <div>
            <small>{{ countMode === 'number' ? 'عدد الموديلات' : 'متوسط تكلفة الجهاز' }}</small>
            <b class="num">
              {{
                countMode === 'number'
                  ? num(shelf.totals.models)
                  : shelf.registeredCount === 0
                    ? '—'
                    : money(Math.floor(shelf.registeredCostMinor / shelf.registeredCount))
              }}
            </b>
          </div>
        </div>
      </header>

      <p v-if="shelf.totals.unregistered > 0" class="note warn" :data-phone-unregistered="shelf.kind">
        <Icon name="triangle-alert" />
        <span>
          فيه {{ num(shelf.totals.unregistered) }}
          {{ shelf.kind === 'used' ? 'مستعمل' : 'جديد' }}
          في المخزن من غير IMEI مسجّل — سجّلهم من «المخزن» ← «استلام توريد»
          عشان تقدر تبيعهم وتراجع أرقامهم.
        </span>
      </p>

      <table v-if="shelf.cards.length > 0" class="t sv-t phone-table">
        <thead>
          <tr>
            <th>الموديل / الجهاز</th>
            <th class="ta-n">العدد</th>
            <th v-if="countMode === 'number'" class="ta-n">نسبة من الرف</th>
            <th class="ta-n">التكلفة</th>
            <th v-if="countMode === 'money'" class="ta-n">قيمة الشراء</th>
            <th class="ta-n">سعر البيع</th>
            <th v-if="countMode === 'money'" class="ta-n">قيمة البيع المتوقعة</th>
            <th class="ta-n">في الرف</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="card in shelf.cards" :key="card.productId">
            <tr class="model-row" :data-phone-model="card.productId">
              <td>
                <b>{{ card.name }}</b>
                <span v-if="card.brand" class="brand">{{ card.brand }}</span>
              </td>
              <td class="ta-n num"><b>{{ num(card.count) }}</b></td>
              <td v-if="countMode === 'number'" class="ta-n num">
                {{ shelf.totals.units === 0 ? '—' : `${Math.round((card.count / shelf.totals.units) * 100)}%` }}
              </td>
              <td class="ta-n num">
                <template v-if="card.avgCostMinor === 0">—</template>
                <template v-else>
                  <span class="avg-t">متوسط</span> {{ money(card.avgCostMinor) }}
                </template>
              </td>
              <td v-if="countMode === 'money'" class="ta-n num">
                {{ card.handsets.length === 0 ? '—' : money(card.costMinor) }}
              </td>
              <td class="ta-n num">
                {{ card.salePriceMinor === null ? 'من غير سعر' : money(card.salePriceMinor) }}
              </td>
              <td v-if="countMode === 'money'" class="ta-n num">
                {{ card.saleMinor === null ? '—' : money(card.saleMinor) }}
              </td>
              <td class="ta-n num">
                {{
                  card.handsets.length === 0
                    ? '—'
                    : `${num(daysInStock(card.handsets[0]!.createdAt, now))} يوم`
                }}
              </td>
            </tr>

            <!-- the handsets themselves, under the model they belong to -->
            <tr
              v-for="handset in card.handsets"
              :key="handset.id"
              class="unit-row"
              :data-phone-unit="handset.id"
            >
              <td>
                <span class="unit-name">
                  <span class="mono"><bdi dir="ltr">IMEI {{ handset.imei }}</bdi></span>
                  <span v-if="handset.color" class="unit-color">{{ handset.color }}</span>
                  <span v-if="conditionText(handset)" class="unit-cond">{{ conditionText(handset) }}</span>
                </span>
              </td>
              <td class="ta-n num"></td>
              <td v-if="countMode === 'number'" class="ta-n num"></td>
              <td class="ta-n num">{{ money(handset.costMinor) }}</td>
              <td v-if="countMode === 'money'" class="ta-n num">{{ money(handset.costMinor) }}</td>
              <td class="ta-n num">
                {{ handset.salePriceMinor === null ? '—' : money(handset.salePriceMinor) }}
              </td>
              <td v-if="countMode === 'money'" class="ta-n num">
                {{ handset.salePriceMinor === null ? '—' : money(handset.salePriceMinor) }}
              </td>
              <td class="ta-n num">{{ num(daysInStock(handset.createdAt, now)) }} يوم</td>
            </tr>

            <tr v-if="card.unregistered > 0" :key="`${card.productId}-gap`" class="gap-row">
              <td colspan="8">
                <Icon name="triangle-alert" />
                {{ num(card.unregistered) }} {{ pcsWord(card.unregistered) }} من الموديل ده
                في المخزن بالعدد من غير IMEI — لسه متسجلوش
              </td>
            </tr>
          </template>
        </tbody>
      </table>

      <p v-else class="note">
        <Icon name="info" />
        <span v-if="query">
          مفيش {{ shelf.label }} بالبحث ده — جرّب اسم الموديل أو آخر أرقام الـIMEI.
        </span>
        <span v-else>
          مفيش أجهزة {{ shelf.label }} في الرف دلوقتي. تسجيل جهاز جديد من «المخزن» ← «صنف جديد» ← «موبايل».
        </span>
      </p>

      <!-- the same shelf by company, in the unit the owner chose -->
      <div v-if="shelf.companies.length > 0" class="by-company">
        <div
          v-for="c in shelf.companies"
          :key="c.name"
          class="company-row"
          :data-company-row="`${shelf.kind}:${c.name}`"
        >
          <span class="c-name">{{ c.name }}</span>
          <b class="num">
            {{ countMode === 'number' ? `${num(c.units)} ${pcsWord(c.units)}` : money(c.costMinor) }}
          </b>
          <span class="c-share">
            {{ countMode === 'number' ? `${num(c.sharePct)}% من الرف` : (c.saleMinor === null ? 'من غير سعر' : `بيع ${money(c.saleMinor)}`) }}
          </span>
        </div>
      </div>
    </section>

    <!-- the phone rules, and where they live ------------------------------- -->
    <section class="setup">
      <h3><Icon name="sliders-horizontal" /> إعدادات الهواتف</h3>
      <div class="setup-grid">
        <button type="button" class="setup-card" data-goto="receipt" @click="openSettingsTab('receipt')">
          <Icon name="shield-check" />
          <b>الإيصال والضمان</b>
          <span>مدة ضمان الجديد والمستعمل، وبيتطبق على كل جهاز.</span>
        </button>
        <button type="button" class="setup-card" data-goto="catalog" @click="openSettingsTab('catalog')">
          <Icon name="scan-line" />
          <b>الـIMEI والأصناف</b>
          <span>إلزامي ولا اختياري، والشركات والتصنيفات.</span>
        </button>
        <button type="button" class="setup-card" data-goto="look" @click="openSettingsTab('look')">
          <Icon name="palette" />
          <b>الشكل والألوان</b>
          <span>شكل الشاشة والفاتورة اللي الميّز بيشوفها.</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* `.page` is a column flex box: without this the shelves are squeezed to a bar. */
.phone-bar,
.shelf-picker,
.shelf,
.setup {
  flex-shrink: 0;
}
.shelf-picker {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
}
.shelf-pick {
  display: grid;
  gap: 2px;
  justify-items: start;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-m);
  background: var(--surface);
  color: inherit;
  text-align: start;
  cursor: pointer;
  border-inline-start: 5px solid var(--border-strong);
}
.shelf-pick:hover {
  border-color: var(--border-strong);
}
.pick-new {
  border-inline-start-color: var(--ok);
}
.pick-used {
  border-inline-start-color: var(--warn, #a86b00);
  background: color-mix(in srgb, var(--warn, #a86b00) 5%, var(--surface));
}
.pick-name {
  color: var(--muted);
  font-size: 0.82rem;
}
.shelf-pick b {
  font-size: 1.3rem;
  line-height: 1.2;
}
.pick-sub {
  color: var(--text-2, var(--text));
  font-size: 0.8rem;
}
.phone-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.count-switch {
  display: flex;
  gap: 6px;
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

/* each shelf is its own block, with its own colour and its own totals */
.shelf {
  display: grid;
  gap: 10px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--r-l, 14px);
  background: var(--surface);
  border-inline-start: 5px solid var(--border-strong);
}
.shelf-new {
  border-inline-start-color: var(--ok);
}
.shelf-used {
  border-inline-start-color: var(--warn, #a86b00);
  background: color-mix(in srgb, var(--warn, #a86b00) 4%, var(--surface));
}
.shelf-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.shelf-name {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 1.1rem;
}
.shelf-figs {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
}
.shelf-figs div {
  display: grid;
  gap: 1px;
}
.shelf-figs small {
  color: var(--muted);
  font-size: 0.76rem;
}
.shelf-figs b {
  font-size: 1.05rem;
}

.phone-table {
  width: 100%;
}
.phone-table th,
.phone-table td {
  white-space: nowrap;
}
.model-row td {
  border-top: 1px solid var(--border);
  font-weight: 600;
}
.model-row td:first-child b {
  display: block;
}
.avg-t {
  color: var(--muted);
  font-size: 0.74rem;
  font-weight: 400;
}
.brand {
  color: var(--muted);
  font-size: 0.78rem;
  font-weight: 400;
}
.unit-row td {
  background: color-mix(in srgb, var(--surface-2, #f5f6f8) 60%, transparent);
  font-size: 0.86rem;
  color: var(--text-2, var(--text));
  padding-top: 6px;
  padding-bottom: 6px;
}
.unit-name {
  display: inline-flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: baseline;
  padding-inline-start: 14px;
}
.unit-color,
.unit-cond {
  color: var(--muted);
  font-size: 0.8rem;
}
.gap-row td {
  background: color-mix(in srgb, var(--warn, #a86b00) 10%, transparent);
  color: var(--warn, #a86b00);
  font-size: 0.82rem;
  padding: 6px 10px;
}
.by-company {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.company-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface-2, #f5f6f8);
  font-size: 0.85rem;
}
.c-name {
  color: var(--text-2, var(--text));
}
.c-share {
  color: var(--muted);
  font-size: 0.78rem;
}

.setup {
  display: grid;
  gap: 8px;
}
.setup h3 {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 0.95rem;
  color: var(--text-2, var(--text));
}
.setup-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 10px;
}
.setup-card {
  display: grid;
  gap: 4px;
  justify-items: start;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-m);
  background: var(--surface);
  color: inherit;
  text-align: start;
  cursor: pointer;
}
.setup-card:hover {
  border-color: var(--border-strong);
}
.setup-card span {
  color: var(--muted);
  font-size: 0.82rem;
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
</style>
