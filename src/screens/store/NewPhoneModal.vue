<script setup lang="ts">
// «موبايل جديد» (ADR-018 §2), the phone part of the mockup's «صنف جديد»
// (docs/ui/mockup-v1/views/catalog.js, `niPhone`): the category when there is
// more than one for phones, touch or keypad, the company (with «شركة تانية»),
// the model, the storage and RAM of a touch phone, and the sale price. The
// name is previewed as it will be stored, and Rust builds it with the same
// rule. Colours and the IMEI of each device come with the units of item 1.4;
// the quantity and the cost can be typed right here (owner request
// 2026-10-22): what is on the shelf is received the moment the phone is
// registered — or from «استلام توريد», as before, when the fields stay empty.
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import * as brandsApi from '../../api/brands';
import type { BrandEntry, DeviceType } from '../../api/brands';
import { listCategories } from '../../api/categories';
import type { CategoryEntry } from '../../api/categories';
import { describeError } from '../../api/errors';
import { receiveStock } from '../../api/inventory';
import { dg, money, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { beep, toast } from '../../ui/toast';
import { asIconName } from '../pos/icons';
import { plannedReceipt } from './item';
import { brandsFor, phoneTitle, RAM_CHOICES, STORAGE_CHOICES, storageLabel } from './phone';

const emit = defineEmits<{
  close: [];
  created: [name: string, productId?: string, receivedQty?: number];
}>();

const categories = ref<CategoryEntry[]>([]);
const brands = ref<BrandEntry[]>([]);
const loaded = ref(false);
const busy = ref(false);
const error = ref('');

const categoryId = ref('');
const device = ref<DeviceType>('touch');
const brandId = ref('');
const model = ref('');
const storageGb = ref<number | null>(null);
const ramGb = ref<number | null>(null);
const price = ref('');
// The goods already on the shelf, typed in the same form (owner request
// 2026-10-22) — the merge the item form got, for phones too.
const qty = ref('');
const cost = ref('');
const newBrand = ref<string | null>(null);
const modelInput = ref<HTMLInputElement | null>(null);

/** The categories a phone may go in: those registered «جهاز جهاز بالـ IMEI». */
const phoneCategories = computed(() => categories.value.filter((c) => c.kind === 'phone' && !c.hidden));
const offered = computed(() => brandsFor(brands.value, device.value));
const brand = computed(() => brands.value.find((b) => b.id === brandId.value) ?? null);
const title = computed(() =>
  brand.value === null || model.value.trim() === ''
    ? ''
    : phoneTitle(brand.value.name, brand.value.lines, model.value, device.value === 'touch' ? storageGb.value : null)
);

watch(device, (now) => {
  if (brand.value !== null && !brandsFor([brand.value], now).length) brandId.value = '';
  if (now === 'keypad') {
    storageGb.value = null;
    ramGb.value = null;
  }
});

function iconOf(name: string) {
  return asIconName(name) ?? 'smartphone';
}

async function load(): Promise<void> {
  try {
    [categories.value, brands.value] = await Promise.all([listCategories(), brandsApi.listBrands()]);
    categoryId.value = phoneCategories.value[0]?.id ?? '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loaded.value = true;
  }
}

/** «شركة تانية»: add the company (for this kind of phone) and choose it. */
async function addBrand(): Promise<void> {
  const name = (newBrand.value ?? '').trim();
  if (name === '' || busy.value) return;
  busy.value = true;
  try {
    const made = await brandsApi.createBrand(name, device.value);
    brands.value = await brandsApi.listBrands();
    brandId.value = made.id;
    newBrand.value = null;
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
    beep();
  } finally {
    busy.value = false;
  }
}

/** The mockup's order of checks, so the first thing missing is the one named. */
function missing(): string {
  if (categoryId.value === '') return 'مفيش تصنيف للموبايلات. ضيف واحد «جهاز جهاز بالـ IMEI» من الإعدادات.';
  if (brand.value === null) return 'اختار الشركة';
  if (model.value.trim() === '') return 'اكتب الموديل';
  if (device.value === 'touch' && storageGb.value === null) return 'اختار المساحة';
  const minor = parseMoney(price.value);
  if (minor === null || minor <= 0) return 'اكتب سعر البيع';
  // The receipt typed in the form is validated before the phone exists, so a
  // bad count never leaves a registered phone with a half-typed receipt.
  const plan = plannedReceipt(qty.value, cost.value);
  if (typeof plan === 'string') return plan;
  return '';
}

/** True when the form itself will put devices on the shelf at save time. */
const receiptPlanned = computed(() => qty.value.trim() !== '');

async function save(): Promise<void> {
  if (busy.value) return;
  const why = missing();
  if (why !== '') {
    error.value = why;
    beep();
    return;
  }
  busy.value = true;
  try {
    const made = await brandsApi.createPhone({
      categoryId: categoryId.value,
      brandId: brandId.value,
      model: model.value,
      deviceType: device.value,
      storageGb: device.value === 'touch' ? storageGb.value : null,
      ramGb: device.value === 'touch' ? ramGb.value : null,
      salePriceMinor: parseMoney(price.value),
    });
    // One registration, one receipt: the count and cost typed here become a
    // routine receive. A failure after the phone exists is announced, never
    // swallowed — the phone is registered, the receipt is not.
    let received = 0;
    const plan = plannedReceipt(qty.value, cost.value);
    if (plan !== null && typeof plan !== 'string') {
      try {
        await receiveStock(made.product.id, plan.qty, plan.costMinor);
        received = plan.qty;
      } catch (err) {
        beep();
        toast(
          'الموبايل اتسجّل، بس الاستلام اللي في النموذج فشل: ' + describeError(err),
          'err',
          6000
        );
      }
    }
    emit('created', made.product.name, made.product.id, received);
  } catch (err) {
    error.value = describeError(err);
    beep();
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await load();
  await nextTick();
  modelInput.value?.focus();
});
</script>

<template>
  <Modal
    title="موبايل جديد"
    sub="الشركة والموديل والمساحة — ولو الأجهزة موجودة عندك، اكتب العدد والتكلفة ويتسجلوا استلام على طول"
    size="md"
    @close="emit('close')"
  >
    <p v-if="!loaded" class="muted">لحظة…</p>
    <form v-else id="np-form" class="stack new-phone" @submit.prevent="save">
      <div v-if="phoneCategories.length > 1" class="ni-row">
        <span class="label">التصنيف</span>
        <div class="chips wrap">
          <button
            v-for="c in phoneCategories"
            :key="c.id"
            type="button"
            class="chip"
            :class="{ on: categoryId === c.id }"
            :aria-pressed="categoryId === c.id"
            @click="categoryId = c.id"
          >
            <Icon :name="iconOf(c.icon)" /><bdi>{{ c.name }}</bdi>
          </button>
        </div>
      </div>

      <div class="ni-row">
        <span class="label">نوع الجهاز</span>
        <div class="seg">
          <button type="button" :class="{ on: device === 'touch' }" :aria-pressed="device === 'touch'" @click="device = 'touch'">تاتش</button>
          <button type="button" :class="{ on: device === 'keypad' }" :aria-pressed="device === 'keypad'" @click="device = 'keypad'">زراير</button>
        </div>
      </div>

      <div class="ni-row">
        <span class="label">الشركة</span>
        <div id="np-brands" class="chips wrap">
          <button
            v-for="b in offered"
            :key="b.id"
            type="button"
            class="chip"
            :class="{ on: brandId === b.id }"
            :aria-pressed="brandId === b.id"
            @click="brandId = b.id"
          >
            <bdi dir="ltr">{{ b.name }}</bdi>
          </button>
          <button v-if="newBrand === null" type="button" class="chip ghost-chip" @click="newBrand = ''">
            <Icon name="plus" /> شركة تانية
          </button>
          <span v-else class="ni-inline">
            <input
              id="np-brand-new"
              v-model="newBrand"
              placeholder="اسم الشركة"
              aria-label="اسم الشركة الجديدة"
              autocomplete="off"
              @keydown.enter.prevent="addBrand"
            />
            <button type="button" class="btn sm soft" :disabled="busy" @click="addBrand"><Icon name="check" /> ضيف</button>
          </span>
        </div>
      </div>

      <div class="field">
        <label for="np-model">الموديل</label>
        <input
          id="np-model"
          ref="modelInput"
          v-model="model"
          :placeholder="device === 'keypad' ? 'مثلًا: 105، 110' : 'مثلًا: Galaxy A16، Redmi 14C'"
          autocomplete="off"
        />
      </div>

      <template v-if="device === 'touch'">
        <div class="ni-row">
          <span class="label">المساحة</span>
          <div class="chips wrap">
            <button
              v-for="gb in STORAGE_CHOICES"
              :key="gb"
              type="button"
              class="chip"
              :class="{ on: storageGb === gb }"
              :aria-pressed="storageGb === gb"
              @click="storageGb = gb"
            >
              <span class="num" dir="ltr">{{ storageLabel(gb) }}</span>
            </button>
          </div>
        </div>
        <div class="ni-row">
          <span class="label">الرام <span class="muted">(اختياري)</span></span>
          <div class="chips wrap">
            <button
              v-for="gb in RAM_CHOICES"
              :key="gb"
              type="button"
              class="chip"
              :class="{ on: ramGb === gb }"
              :aria-pressed="ramGb === gb"
              @click="ramGb = ramGb === gb ? null : gb"
            >
              <span class="num" dir="ltr">{{ gb }}GB</span>
            </button>
          </div>
        </div>
      </template>

      <div class="field price-field">
        <label for="np-price">سعر البيع</label>
        <input id="np-price" v-model="price" class="num" dir="ltr" inputmode="numeric" autocomplete="off" />
        <span v-if="parseMoney(price) !== null" class="hint">{{ money(parseMoney(price) ?? 0) }}</span>
      </div>

      <!-- The devices already on the shelf, in the same form (owner request
           2026-10-22): the count and the unit cost register a receipt the
           moment the phone exists — no second trip to «استلام توريد». -->
      <div class="np-grid2">
        <div class="field">
          <label for="np-qty">العدد الموجود في المحل <span class="muted">(اختياري)</span></label>
          <input
            id="np-qty"
            v-model="qty"
            class="num"
            dir="ltr"
            inputmode="numeric"
            placeholder="0"
            autocomplete="off"
          />
        </div>
        <div class="field">
          <label for="np-cost">تكلفة الوحدة <span class="muted">(مع العدد)</span></label>
          <input
            id="np-cost"
            v-model="cost"
            class="num"
            dir="ltr"
            inputmode="decimal"
            placeholder="0"
            autocomplete="off"
          />
        </div>
      </div>

      <div v-if="title !== ''" class="ni-name">
        <Icon name="tag" /> هيتسجّل باسم <b><bdi dir="auto">{{ title }}</bdi></b
        ><span v-if="device === 'touch' && ramGb !== null" class="num">، رام {{ dg(ramGb) }}GB</span>
      </div>
      <div class="muted ni-foot">
        <Icon name="info" />
        <span v-if="receiptPlanned">العدد والتكلفة هيتسجلوا استلام مع الموبايل على طول — والـ IMEI لكل جهاز بيتسجّل مع الاستلام بالـ IMEI لما تجهز.</span>
        <span v-else>بعد التسجيل هتلاقي الصنف مختار في «استلام توريد» تحت: حطّ الكمية وسعر الشراء، والـ IMEI لكل جهاز بيتسجّل مع الاستلام بالـ IMEI لما يجهز.</span>
      </div>
      <p class="err-msg" role="alert">{{ error }}</p>
    </form>
    <template #foot>
      <span class="sp"></span>
      <button type="submit" form="np-form" class="btn primary" :disabled="busy || !loaded">
        <Icon name="save" /> سجّل الموبايل <kbd>Enter</kbd>
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sp {
  flex: 1;
}
.new-phone {
  gap: 14px;
}
/* Two fields side by side: the count and the unit cost of the shelf stock. */
.np-grid2 {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  align-items: start;
}
.np-grid2 .field {
  margin-bottom: 0;
  min-width: 0;
}
@media (max-width: 640px) {
  .np-grid2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
.ni-row {
  display: grid;
  gap: 6px;
  min-width: 0;
}
.ni-row > .label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-2);
}
.chips.wrap {
  flex-wrap: wrap;
  overflow: visible;
}
.ghost-chip {
  border-style: dashed;
}
.ni-inline {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.ni-inline input {
  width: 170px;
  height: 34px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-s);
  padding: 0 10px;
  background: var(--surface);
  color: var(--text);
  font: inherit;
}
.ni-inline input:focus {
  border-color: var(--accent-text);
  outline: 1px solid var(--accent-text);
  outline-offset: -1px;
}
.price-field {
  max-width: 240px;
}
.ni-name {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: var(--r-s);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 0.9rem;
}
.ni-name b {
  color: var(--text);
}
.ni-foot {
  font-size: 0.85rem;
  display: flex;
  gap: 6px;
  align-items: flex-start;
}
.ni-foot :deep(svg.i),
.ni-name :deep(svg.i) {
  width: 15px;
  height: 15px;
  flex: none;
  margin-top: 2px;
}
</style>
