<script setup lang="ts">
// «إكسسوار أو أي صنف بالعدد» (ADR-018 §3 & §4), the mockup's `niItem`: the
// category (with an inline «تصنيف جديد»), the name, the barcode or a code the
// shop makes for itself, the sale price, and — when «الصنف ده ليه تفرعات» is
// switched on — up to two dimensions (`NI_DIMS`), up to 60 combinations, per-row
// barcode and price overrides, and «اعمل أكواد للي من غير باركود».
//
// The barcode that starts with 2 is an EAN-13 the shop makes for its own label
// (PLAN §6). Rust numbers them, so the buttons ask `next_shop_code` /
// `next_shop_codes` and this form only shows what came back.
import { computed, nextTick, onMounted, ref } from 'vue';

import * as catalogApi from '../../api/catalog';
import { createCategory, listCategories } from '../../api/categories';
import type { CategoryEntry } from '../../api/categories';
import { describeError } from '../../api/errors';
import { normalize } from '../../ui/arabic';
import { kindsWord, money, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { beep, toast } from '../../ui/toast';
import { asIconName } from '../pos/icons';
import {
  addVariantValue,
  barcodeProblem,
  comboKey,
  dimensionSuggestions,

  isShopCode,
  itemCategories,
  itemProblem,
  newCategoryParent,
  VARIANT_DIMENSIONS,
  variantCombos,
  variantsProblem,
  type VariantDimensionLabel,
  type VariantRowDraft,
} from './item';

const emit = defineEmits<{ close: []; created: [name: string] }>();

const categories = ref<CategoryEntry[]>([]);
const loaded = ref(false);
const busy = ref(false);
const makingCode = ref(false);
const error = ref('');

const categoryId = ref('');
const name = ref('');
const barcode = ref('');
const price = ref('');
const newCategory = ref<string | null>(null);

// Product variants («الصنف ده ليه تفرعات», ADR-018 §4).
const variantsOn = ref(false);
const dim1Label = ref<VariantDimensionLabel>('الموبايل');
const dim1Values = ref<string[]>([]);
const dim1Query = ref('');
const dim2Label = ref<VariantDimensionLabel>('اللون');
const dim2Values = ref<string[]>([]);
const dim2Query = ref('');
const rows = ref<Record<string, VariantRowDraft>>({});
const dimInput0 = ref<HTMLInputElement | null>(null);

/** Counted-goods categories in the mockup's order. */
const cats = computed(() => itemCategories(categories.value));
const priceMinor = computed(() => parseMoney(price.value));
const shopCode = computed(() => isShopCode(barcode.value.trim()));
const chosen = computed(() => categories.value.find((c) => c.id === categoryId.value) ?? null);

const combos = computed(() =>
  variantCombos([{ values: dim1Values.value }, { values: dim2Values.value }])
);

const dim1Suggs = computed(() =>
  dimensionSuggestions(dim1Label.value).filter(
    (s) => !dim1Values.value.some((v) => normalize(v) === normalize(s))
  )
);

const dim2Suggs = computed(() =>
  dimensionSuggestions(dim2Label.value).filter(
    (s) => !dim2Values.value.some((v) => normalize(v) === normalize(s))
  )
);

function iconOf(name: string) {
  return asIconName(name) ?? 'package';
}

async function load(): Promise<void> {
  try {
    categories.value = await listCategories();
    if (categoryId.value === '' || !cats.value.some((c) => c.id === categoryId.value)) {
      categoryId.value = cats.value[0]?.id ?? '';
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    loaded.value = true;
  }
}

/** «تصنيف جديد»: a sub under the main of the chosen category, then choose it. */
async function addCategory(): Promise<void> {
  const name = (newCategory.value ?? '').trim();
  if (name === '' || busy.value) return;
  busy.value = true;
  try {
    const parentId = newCategoryParent(categories.value, categoryId.value);
    const made = await createCategory({
      name,
      parentId,
      kind: parentId === null ? 'item' : null,
      icon: 'tag',
    });
    categories.value = await listCategories();
    categoryId.value = made.id;
    newCategory.value = null;
    error.value = '';
    toast(`اتضاف التصنيف «${made.name}»`, 'ok', 3500);
  } catch (err) {
    error.value = describeError(err);
    beep();
  } finally {
    busy.value = false;
  }
}

async function makeCode(): Promise<void> {
  if (busy.value || makingCode.value) return;
  makingCode.value = true;
  try {
    barcode.value = await catalogApi.nextShopCode();
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
    beep();
  } finally {
    makingCode.value = false;
  }
}

async function onToggleVariants(): Promise<void> {
  error.value = '';
  if (variantsOn.value) {
    await nextTick();
    dimInput0.value?.focus();
  }
}

function pushDimValue(dimIndex: 0 | 1, raw: string): void {
  if (dimIndex === 0) {
    dim1Values.value = addVariantValue(dim1Values.value, raw);
    dim1Query.value = '';
  } else {
    dim2Values.value = addVariantValue(dim2Values.value, raw);
    dim2Query.value = '';
  }
  error.value = '';
}

function removeDimValue(dimIndex: 0 | 1, val: string): void {
  if (dimIndex === 0) {
    dim1Values.value = dim1Values.value.filter((v) => v !== val);
  } else {
    dim2Values.value = dim2Values.value.filter((v) => v !== val);
  }
  error.value = '';
}

function onDimKeydown(dimIndex: 0 | 1, ev: KeyboardEvent): void {
  if (ev.key === 'Enter' || ev.key === ',' || ev.key === '،') {
    ev.preventDefault();
    const q = dimIndex === 0 ? dim1Query.value : dim2Query.value;
    pushDimValue(dimIndex, q);
  }
}

function rowBarcode(combo: readonly string[]): string {
  return rows.value[comboKey(combo)]?.barcode ?? '';
}

function setRowBarcode(combo: readonly string[], value: string): void {
  const key = comboKey(combo);
  const prev = rows.value[key] ?? { barcode: '', price: '' };
  rows.value = { ...rows.value, [key]: { ...prev, barcode: value } };
  error.value = '';
}

function rowPrice(combo: readonly string[]): string {
  return rows.value[comboKey(combo)]?.price ?? '';
}

function setRowPrice(combo: readonly string[], value: string): void {
  const key = comboKey(combo);
  const prev = rows.value[key] ?? { barcode: '', price: '' };
  rows.value = { ...rows.value, [key]: { ...prev, price: value } };
  error.value = '';
}

async function makeVariantCodes(): Promise<void> {
  if (busy.value || makingCode.value) return;
  const missingKeys = combos.value
    .map((c) => comboKey(c))
    .filter((k) => (rows.value[k]?.barcode.trim() ?? '') === '');
  if (missingKeys.length === 0) return;

  const reserved = combos.value
    .map((c) => rows.value[comboKey(c)]?.barcode.trim() ?? '')
    .filter((code) => code !== '');

  makingCode.value = true;
  try {
    const generated = await catalogApi.nextShopCodes(missingKeys.length, reserved);
    const nextRows = { ...rows.value };
    missingKeys.forEach((key, index) => {
      const code = generated[index];
      if (code !== undefined) {
        const prev = nextRows[key] ?? { barcode: '', price: '' };
        nextRows[key] = { ...prev, barcode: code };
      }
    });
    rows.value = nextRows;
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
    beep();
  } finally {
    makingCode.value = false;
  }
}

async function save(): Promise<void> {
  if (busy.value) return;
  if (variantsOn.value) {
    if (dim1Query.value.trim() !== '') pushDimValue(0, dim1Query.value);
    if (dim2Query.value.trim() !== '') pushDimValue(1, dim2Query.value);

    const why = variantsProblem(cats.value, {
      categoryId: categoryId.value,
      name: name.value,
      dim1Label: dim1Label.value,
      dim1Values: dim1Values.value,
      dim2Label: dim2Label.value,
      dim2Values: dim2Values.value,
      priceMinor: priceMinor.value,
      rows: rows.value,
    });
    if (why !== '') {
      error.value = why;
      beep();
      return;
    }

    busy.value = true;
    try {
      const rowInputs = combos.value.map((c) => {
        const row = rows.value[comboKey(c)];
        const rawSku = row?.barcode.trim() ?? '';
        const rawPrice = row?.price.trim() ?? '';
        return {
          barcode: rawSku === '' ? null : rawSku,
          salePriceMinor: rawPrice === '' ? null : parseMoney(rawPrice),
        };
      });
      const made = await catalogApi.createVariants({
        categoryId: categoryId.value,
        name: name.value,
        dimension1: dim1Label.value,
        values1: dim1Values.value,
        dimension2: dim2Values.value.length > 0 ? dim2Label.value : null,
        values2: dim2Values.value,
        defaultPriceMinor: priceMinor.value!,
        rows: rowInputs,
      });
      emit('created', `${made.parent.name} (${kindsWord(made.variants.length)})`);
    } catch (err) {
      error.value = describeError(err);
      beep();
    } finally {
      busy.value = false;
    }
    return;
  }

  const why = itemProblem(cats.value, {
    categoryId: categoryId.value,
    name: name.value,
    barcode: barcode.value,
    priceMinor: priceMinor.value,
  });
  if (why !== '') {
    error.value = why;
    beep();
    return;
  }
  busy.value = true;
  try {
    const made = await catalogApi.createProduct({
      name: name.value,
      disposition: 'quantity',
      barcode: barcode.value.trim() === '' ? null : barcode.value.trim(),
      salePriceMinor: priceMinor.value,
      categoryId: categoryId.value,
    });
    emit('created', made.name);
  } catch (err) {
    error.value = describeError(err);
    beep();
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await load();
});
</script>

<template>
  <Modal
    title="صنف جديد"
    sub="إكسسوار أو أي صنف بالعدد. الكمية والتكلفة من الاستلام"
    size="md"
    @close="emit('close')"
  >
    <p v-if="!loaded" class="muted">لحظة…</p>
    <form v-else id="ni-form" class="stack new-item" @submit.prevent="save">
      <div class="ni-row">
        <span class="label">التصنيف</span>
        <div id="ni-cats" class="chips wrap">
          <button
            v-for="c in cats"
            :key="c.id"
            type="button"
            class="chip"
            :class="{ on: categoryId === c.id }"
            :aria-pressed="categoryId === c.id"
            @click="categoryId = c.id"
          >
            <Icon :name="iconOf(c.icon)" /><bdi>{{ c.name }}</bdi>
          </button>
          <button v-if="newCategory === null" type="button" class="chip ghost-chip" @click="newCategory = ''">
            <Icon name="plus" /> تصنيف جديد
          </button>
          <span v-else class="ni-inline">
            <input
              id="ni-cat-new"
              v-model="newCategory"
              placeholder="مثلًا: قطع غيار، خطوط"
              aria-label="اسم التصنيف الجديد"
              autocomplete="off"
              @keydown.enter.prevent="addCategory"
            />
            <button type="button" class="btn sm soft" :disabled="busy" @click="addCategory">
              <Icon name="check" /> ضيف
            </button>
          </span>
        </div>
        <span v-if="cats.length === 0" class="muted"
          >مفيش تصنيف «بالعدد». ضيف واحد من الإعدادات ← «التصنيفات في شاشة البيع».</span
        >
      </div>

      <div class="field">
        <label for="ni-name">اسم الصنف</label>
        <input
          id="ni-name"
          v-model="name"
          placeholder="مثلًا: جراب سيليكون شفاف"
          autocomplete="off"
          data-autofocus
        />
      </div>

      <label class="ni-switch">
        <span class="switch">
          <input id="ni-var-on" v-model="variantsOn" type="checkbox" @change="onToggleVariants" />
          <span></span>
        </span>
        <span class="t">
          <b>الصنف ده ليه تفرعات</b>
          <small>
            زي جراب لكل موديل ولون، أو شاحن بأكتر من قوة. كل نوع ليه عدده وسعره وباركوده
          </small>
        </span>
      </label>

      <div v-if="!variantsOn" class="field">
        <label for="ni-sku">الباركود <span class="muted">(اختياري)</span></label>
        <div class="ni-inline">
          <input
            id="ni-sku"
            v-model="barcode"
            class="mono"
            inputmode="numeric"
            placeholder="امسحه بالماسح أو اكتبه"
            autocomplete="off"
          />
          <button type="button" class="btn sm soft" :disabled="busy || makingCode" @click="makeCode">
            <Icon name="scan-barcode" /> اعمل كود للمحل
          </button>
        </div>
        <span v-if="shopCode" class="hint">ده كود المحل (EAN-13) — بيتطبع على الملصق.</span>
        <span v-else-if="barcodeProblem(barcode) !== ''" class="hint">{{ barcodeProblem(barcode) }}</span>
      </div>

      <template v-else>
        <!-- Dimension 1 (required) -->
        <div class="ni-dim">
          <div class="field">
            <label for="ni-dim-0">متفرّع حسب</label>
            <select id="ni-dim-0" v-model="dim1Label">
              <option v-for="d in VARIANT_DIMENSIONS" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>
          <div class="field">
            <label for="ni-dq-0">الأنواع <span class="muted">(دوس Enter أو فاصلة بعد كل واحد)</span></label>
            <div class="ni-tags">
              <span v-for="v in dim1Values" :key="v" class="tag">
                <bdi dir="rtl">{{ v }}</bdi>
                <button
                  type="button"
                  :aria-label="`شيل «${v}»`"
                  @click="removeDimValue(0, v)"
                >
                  ×
                </button>
              </span>
              <input
                id="ni-dq-0"
                ref="dimInput0"
                v-model="dim1Query"
                class="ni-tag-in"
                :placeholder="dim1Values.length > 0 ? 'ضيف تاني...' : `اكتب ${dim1Label} ودوس Enter`"
                autocomplete="off"
                @keydown="onDimKeydown(0, $event)"
              />
            </div>
            <div v-if="dim1Suggs.length > 0" class="ni-sugg">
              <button
                v-for="s in dim1Suggs"
                :key="s"
                type="button"
                class="chip"
                @click="pushDimValue(0, s)"
              >
                + <bdi dir="rtl">{{ s }}</bdi>
              </button>
            </div>
          </div>
        </div>

        <!-- Dimension 2 (optional) -->
        <div class="ni-dim">
          <div class="field">
            <label for="ni-dim-1">وتاني <span class="muted">(اختياري)</span></label>
            <select id="ni-dim-1" v-model="dim2Label">
              <option v-for="d in VARIANT_DIMENSIONS" :key="d" :value="d">{{ d }}</option>
            </select>
          </div>
          <div class="field">
            <label for="ni-dq-1">سيبه فاضي لو التفرع واحد كفاية</label>
            <div class="ni-tags">
              <span v-for="v in dim2Values" :key="v" class="tag">
                <bdi dir="rtl">{{ v }}</bdi>
                <button
                  type="button"
                  :aria-label="`شيل «${v}»`"
                  @click="removeDimValue(1, v)"
                >
                  ×
                </button>
              </span>
              <input
                id="ni-dq-1"
                v-model="dim2Query"
                class="ni-tag-in"
                :placeholder="dim2Values.length > 0 ? 'ضيف تاني...' : `اكتب ${dim2Label} ودوس Enter`"
                autocomplete="off"
                @keydown="onDimKeydown(1, $event)"
              />
            </div>
            <div v-if="dim2Suggs.length > 0" class="ni-sugg">
              <button
                v-for="s in dim2Suggs"
                :key="s"
                type="button"
                class="chip"
                @click="pushDimValue(1, s)"
              >
                + <bdi dir="rtl">{{ s }}</bdi>
              </button>
            </div>
          </div>
        </div>

        <!-- Combination rows -->
        <div v-if="combos.length > 0">
          <div class="ni-var">
            <table class="t rc-t">
              <thead>
                <tr>
                  <th>النوع</th>
                  <th>الباركود</th>
                  <th class="ta-n">السعر</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="c in combos" :key="comboKey(c)">
                  <td>
                    <template v-for="(part, pi) in c" :key="pi">
                      <template v-if="pi > 0">، </template>
                      <bdi dir="auto">{{ part }}</bdi>
                    </template>
                  </td>
                  <td>

                    <input
                      class="rc-in mono ni-sku"
                      data-f="sku"
                      dir="ltr"
                      inputmode="numeric"
                      :value="rowBarcode(c)"
                      placeholder="اختياري"
                      autocomplete="off"
                      @input="setRowBarcode(c, ($event.target as HTMLInputElement).value)"
                    />
                  </td>
                  <td class="ta-n">
                    <input
                      class="rc-in num"
                      data-f="price"
                      dir="ltr"
                      inputmode="numeric"
                      :value="rowPrice(c)"
                      :placeholder="price.trim()"
                      autocomplete="off"
                      @input="setRowPrice(c, ($event.target as HTMLInputElement).value)"
                    />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="row wrap ni-var-f">
            <span class="muted">
              {{ kindsWord(combos.length) }}. السعر الفاضي = اللي فوق
            </span>
            <span class="sp"></span>
            <button
              id="ni-make-codes"
              type="button"
              class="btn sm soft"
              :disabled="busy || makingCode"
              @click="makeVariantCodes"
            >
              <Icon name="scan-barcode" /> اعمل أكواد للي من غير باركود
            </button>
          </div>
        </div>
      </template>

      <div class="field price-field">
        <label for="ni-price">{{ variantsOn ? 'سعر البيع الافتراضي' : 'سعر البيع' }}</label>
        <input id="ni-price" v-model="price" class="num" dir="ltr" inputmode="numeric" autocomplete="off" />
        <span v-if="priceMinor !== null" class="hint">{{ money(priceMinor) }}</span>
      </div>

      <div v-if="name.trim() !== '' && chosen !== null" class="ni-name">
        <Icon name="tag" /> هيتسجّل باسم <b><bdi dir="auto">{{ name.trim() }}</bdi></b>
        <template v-if="variantsOn && combos.length > 0">
          بـ <b>{{ kindsWord(combos.length) }}</b>
        </template>
        في <b><bdi>{{ chosen.name }}</bdi></b>
      </div>
      <div class="muted ni-foot">
        <Icon name="info" />
        <span>بعد التسجيل استلم الكمية بسعر الشراء من «استلام توريد». الصور جاية في الخطوة الجاية.</span>
      </div>
      <p class="err-msg" role="alert">{{ error }}</p>
    </form>
    <template #foot>
      <span class="sp"></span>
      <button type="submit" form="ni-form" class="btn primary" :disabled="busy || !loaded">
        <Icon name="save" /> سجّل الصنف <kbd>Enter</kbd>
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sp {
  flex: 1;
}
.new-item {
  gap: 14px;
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
  width: 220px;
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
