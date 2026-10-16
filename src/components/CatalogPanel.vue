<script setup lang="ts">
// Product catalogue screen.
//
// Arabic, minimal styling, matching `App.vue`. Visual design is deferred
// (`spec:210`), so this is about legibility and correctness, not appearance.
//
// No credential is read, sent or held here. Rust resolves the operator from the
// OS credential store on every call (`commands/catalog.rs`), so a catalogue
// screen cannot claim to be someone else even if the frontend were tampered
// with.
//
// The status filter is deliberately one-of-two rather than a combined list: an
// operator should never see an archived product sitting next to a sellable one.

import { onMounted, ref } from 'vue';

import * as api from '../api/catalog';
import { describeError } from '../api/errors';
import type { Disposition, Product, ProductStatus } from '../api/catalog';

const error = ref<string>('');
const busy = ref(false);

const products = ref<Product[]>([]);
const filter = ref<ProductStatus>('active');
const barcodeSearch = ref('');

/** Which product the form is editing, or null when creating a new one. */
const editingId = ref<string | null>(null);

const formName = ref('');
const formDisposition = ref<Disposition>('quantity');
const formBarcode = ref('');
/**
 * Kept as a string, not a number.
 *
 * An empty field means "price not set" and must reach Rust as null. Binding a
 * number input would make an empty field read as 0 — which means *free* — and
 * the two are different states (ADR-010).
 */
const formPriceMinor = ref('');

function priceLabel(product: Product): string {
  if (product.salePriceMinor === null) return 'غير محدد';
  return `${(product.salePriceMinor / 100).toFixed(2)} ج.م`;
}

function dispositionLabel(disposition: Disposition): string {
  // Three classes, not two. `one_off` is a product sold once as an individual
  // occurrence with no stock balance, so it must not be shown as either of the
  // other two.
  if (disposition === 'quantity') return 'كمّي';
  if (disposition === 'serialized') return 'مسلسّل';
  return 'قطعة تُباع مرة واحدة';
}

function statusLabel(status: ProductStatus): string {
  return status === 'active' ? 'نشط' : 'مؤرشف';
}

async function load(): Promise<void> {
  busy.value = true;
  try {
    products.value = await api.listProducts(filter.value);
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/**
 * Parse the price field.
 *
 * Empty means unset. A value is read as pounds and piastres, because that is
 * what an operator types; the wire format stays minor units.
 */
function parsePrice(): number | null {
  const raw = formPriceMinor.value.trim();
  if (raw === '') return null;
  const pounds = Number(raw);
  if (!Number.isFinite(pounds) || pounds < 0) return null;
  return Math.round(pounds * 100);
}

function resetForm(): void {
  editingId.value = null;
  formName.value = '';
  formDisposition.value = 'quantity';
  formBarcode.value = '';
  formPriceMinor.value = '';
}

function startEdit(product: Product): void {
  editingId.value = product.id;
  formName.value = product.name;
  formDisposition.value = product.disposition;
  formBarcode.value = product.barcode ?? '';
  // Null must render as an empty field, not as "0.00", or the operator would
  // save a free price onto a product that simply had none.
  formPriceMinor.value =
    product.salePriceMinor === null ? '' : (product.salePriceMinor / 100).toFixed(2);
}

async function submit(): Promise<void> {
  busy.value = true;
  try {
    const price = parsePrice();
    if (price === null && formPriceMinor.value.trim() !== '') {
      error.value = 'السعر المدخل غير صالح.';
      return;
    }

    if (editingId.value === null) {
      await api.createProduct({
        name: formName.value,
        disposition: formDisposition.value,
        barcode: formBarcode.value.trim() === '' ? null : formBarcode.value.trim(),
        salePriceMinor: price,
      });
    } else {
      await api.updateProduct(editingId.value, {
        name: formName.value,
        disposition: formDisposition.value,
        barcode: formBarcode.value.trim() === '' ? null : formBarcode.value.trim(),
        salePriceMinor: price,
      });
    }
    error.value = '';
    resetForm();
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function toggleArchive(product: Product): Promise<void> {
  busy.value = true;
  try {
    await api.setProductArchived(product.id, product.status === 'active');
    error.value = '';
    if (editingId.value === product.id) resetForm();
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/**
 * Typed or pasted barcode search.
 *
 * No camera and no decoder: barcode capture is BLOCKED (`ADR-008`), and a value
 * the operator types needs neither.
 */
async function searchByBarcode(): Promise<void> {
  const needle = barcodeSearch.value.trim();
  if (needle === '') return;
  busy.value = true;
  try {
    const found = await api.findProductByBarcode(needle);
    products.value = [found];
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function clearSearch(): void {
  barcodeSearch.value = '';
  void load();
}

function changeFilter(next: ProductStatus): void {
  filter.value = next;
  void load();
}

onMounted(load);
</script>

<template>
  <section class="catalog">
    <h2 class="catalog-title">المنتجات</h2>

    <!-- Filter -->
    <div class="row">
      <button
        type="button"
        :class="{ active: filter === 'active' }"
        @click="changeFilter('active')"
      >
        النشطة
      </button>
      <button
        type="button"
        :class="{ active: filter === 'archived' }"
        @click="changeFilter('archived')"
      >
        المؤرشفة
      </button>
    </div>

    <!-- Typed or pasted barcode search. Deliberately no scanner. -->
    <form class="row" @submit.prevent="searchByBarcode">
      <input
        v-model="barcodeSearch"
        class="grow"
        placeholder="ابحث بالباركود (اكتب أو الصق)"
        autocomplete="off"
      />
      <button type="submit" :disabled="busy">بحث</button>
      <button type="button" @click="clearSearch">مسح</button>
    </form>

    <!-- Create or edit -->
    <form class="panel-form" @submit.prevent="submit">
      <p class="hint">
        {{ editingId === null ? 'إضافة منتج' : 'تعديل منتج' }}
      </p>

      <label class="field">
        <span>الاسم</span>
        <input v-model="formName" required autocomplete="off" />
      </label>

      <label class="field">
        <span>النوع</span>
        <select v-model="formDisposition">
          <option value="quantity">كمّي</option>
          <option value="serialized">مسلسّل</option>
          <option value="one_off">قطعة تُباع مرة واحدة</option>
        </select>
      </label>

      <label class="field">
        <span>الباركود (اختياري)</span>
        <input v-model="formBarcode" autocomplete="off" />
      </label>

      <label class="field">
        <span>سعر البيع (اختياري)</span>
        <input
          v-model="formPriceMinor"
          inputmode="decimal"
          autocomplete="off"
          placeholder="اتركه فارغًا إذا لم يُحدَّد السعر"
        />
      </label>
      <p class="hint">
        ترك الحقل فارغًا يعني أن السعر غير محدد، وهو ليس نفس الصفر.
        الصفر يعني منتجًا مجانيًا فعلًا.
      </p>

      <div class="row">
        <button type="submit" :disabled="busy">
          {{ editingId === null ? 'إضافة' : 'حفظ' }}
        </button>
        <button v-if="editingId !== null" type="button" @click="resetForm">
          إلغاء
        </button>
      </div>
    </form>

    <!-- List -->
    <p v-if="products.length === 0 && !busy" class="hint">لا توجد منتجات.</p>

    <ul class="list">
      <li v-for="product in products" :key="product.id" class="item">
        <div class="item-main">
          <span class="item-name">{{ product.name }}</span>
          <span class="hint">
            {{ dispositionLabel(product.disposition) }} · {{ priceLabel(product) }} ·
            {{ statusLabel(product.status) }}
          </span>
          <span v-if="product.barcode" class="hint">{{ product.barcode }}</span>
        </div>
        <div class="row">
          <button
            type="button"
            :disabled="busy || product.status !== 'active'"
            @click="startEdit(product)"
          >
            تعديل
          </button>
          <button type="button" :disabled="busy" @click="toggleArchive(product)">
            {{ product.status === 'active' ? 'أرشفة' : 'إرجاع' }}
          </button>
        </div>
      </li>
    </ul>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
/* Minimal on purpose, matching App.vue. Visual design is a later slice. */
.catalog {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #ddd;
}
.catalog-title {
  font-size: 1.05rem;
  margin: 0 0 0.75rem;
}
.row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  align-items: center;
}
.row button.active {
  font-weight: 700;
}
.grow {
  flex: 1;
}
.panel-form {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 1px solid #ddd;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid #eee;
}
.item-main {
  display: flex;
  flex-direction: column;
}
.item-name {
  font-weight: 600;
}
</style>
