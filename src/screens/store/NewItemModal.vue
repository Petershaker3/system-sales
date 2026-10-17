<script setup lang="ts">
// «إكسسوار أو أي صنف بالعدد» (ADR-018 §3), the mockup's `niItem`: the category
// (with an inline «تصنيف جديد»), the name, the barcode or a code the shop makes
// for itself, and the sale price. The quantity and the cost come from receiving,
// as for any product; variants wait for step 4 and the image for step 5.
//
// The barcode that starts with 2 is an EAN-13 the shop makes for its own label
// (PLAN §6). Rust numbers them, so the button asks `next_shop_code` and this
// form only shows what came back.
import { computed, onMounted, ref } from 'vue';

import * as catalogApi from '../../api/catalog';
import { createCategory, listCategories } from '../../api/categories';
import type { CategoryEntry } from '../../api/categories';
import { describeError } from '../../api/errors';
import { money, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { beep, toast } from '../../ui/toast';
import { asIconName } from '../pos/icons';
import { barcodeProblem, isShopCode, itemCategories, itemProblem, newCategoryParent } from './item';

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

/** Counted-goods categories in the mockup's order. */
const cats = computed(() => itemCategories(categories.value));
const priceMinor = computed(() => parseMoney(price.value));
const shopCode = computed(() => isShopCode(barcode.value.trim()));
const chosen = computed(() => categories.value.find((c) => c.id === categoryId.value) ?? null);

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

async function save(): Promise<void> {
  if (busy.value) return;
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

      <div class="field">
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

      <div class="field price-field">
        <label for="ni-price">سعر البيع</label>
        <input id="ni-price" v-model="price" class="num" dir="ltr" inputmode="numeric" autocomplete="off" />
        <span v-if="priceMinor !== null" class="hint">{{ money(priceMinor) }}</span>
      </div>

      <div v-if="name.trim() !== '' && chosen !== null" class="ni-name">
        <Icon name="tag" /> هيتسجّل باسم <b><bdi dir="auto">{{ name.trim() }}</bdi></b> في
        <b><bdi>{{ chosen.name }}</bdi></b>
      </div>
      <div class="muted ni-foot">
        <Icon name="info" />
        <span>بعد التسجيل استلم الكمية بسعر الشراء من «استلام توريد». التفرعات والصور جايين في الخطوتين الجايين.</span>
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
