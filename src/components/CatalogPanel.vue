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

import { computed, onMounted, ref } from 'vue';

import * as api from '../api/catalog';
import { listCategories } from '../api/categories';
import type { CategoryEntry } from '../api/categories';
import { describeError } from '../api/errors';
import type { Disposition, Product, ProductStatus } from '../api/catalog';
import {
  listProductImages,
  removeProductImage,
  setProductImage,
  type ProductImage,
} from '../api/images';
import { approxKilobytes, shrinkImageFile } from '../screens/store/image';
import CameraScanButton from '../ui/CameraScanButton.vue';
import { money, moneyInputValue, moneyUnitWord } from '../ui/format';
import Icon from '../ui/Icon.vue';
import type { IconName } from '../ui/icons';
import type { ScanReading } from '../ui/scan';
import { asIconName } from '../screens/pos/icons';

const emit = defineEmits<{
  'print-label': [productId: string];
}>();

const error = ref<string>('');
const notice = ref<string>('');
const busy = ref(false);

const products = ref<Product[]>([]);
const images = ref<ProductImage[]>([]);
const filter = ref<ProductStatus>('active');
const barcodeSearch = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const pickingProduct = ref<Product | null>(null);


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
/** The chosen category's id, or '' for none (ADR-018 §1). */
const formCategory = ref('');

/** The live categories, managed from the settings. */
const categories = ref<CategoryEntry[]>([]);

/** Mains in the owner's order, each followed by its sub-categories. */
const categoryOptions = computed(() => {
  const mains = categories.value.filter((c) => c.parentId === null);
  return mains.flatMap((main) => [
    { id: main.id, label: main.name },
    ...categories.value
      .filter((c) => c.parentId === main.id)
      .map((sub) => ({ id: sub.id, label: `${sub.name} (${main.name})` })),
  ]);
});

function categoryLabel(product: Product): string {
  if (product.categoryId === null) return 'من غير تصنيف';
  return categoryOptions.value.find((c) => c.id === product.categoryId)?.label ?? 'من غير تصنيف';
}

const imageMap = computed<Record<string, ProductImage>>(() => {
  const map: Record<string, ProductImage> = {};
  for (const img of images.value) {
    map[img.productId] = img;
  }
  return map;
});

function productIcon(product: Product): IconName {
  if (product.disposition === 'serialized') return 'smartphone';
  const cat = product.categoryId
    ? categories.value.find((c) => c.id === product.categoryId)
    : undefined;
  return asIconName(cat?.icon ?? '') ?? 'package';
}



async function loadCategories(): Promise<void> {
  try {
    categories.value = await listCategories();
  } catch (err) {
    error.value = describeError(err);
  }
}

function priceLabel(product: Product): string {
  if (product.salePriceMinor === null) return 'غير محدد';
  return money(product.salePriceMinor);
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
    const [loadedProducts, loadedImages] = await Promise.all([
      api.listProducts(filter.value),
      listProductImages(),
    ]);
    products.value = loadedProducts;
    images.value = loadedImages;
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function openImagePicker(product: Product): void {
  if (product.status !== 'active') return;
  pickingProduct.value = product;
  if (fileInput.value) {
    fileInput.value.value = '';
    fileInput.value.click();
  }
}

async function onPickImageFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement | null;
  const file = input?.files?.[0];
  const target = pickingProduct.value;
  pickingProduct.value = null;
  if (!file || !target) return;
  error.value = '';
  notice.value = '';
  try {
    const dataUrl = await shrinkImageFile(file);
    const saved = await setProductImage(target.id, dataUrl);
    images.value = [
      ...images.value.filter((img) => img.productId !== target.id),
      saved,
    ];
    const kb = approxKilobytes(saved.dataUrl);
    notice.value = `اتحفظت صورة «${target.name}» (${kb} ك.ب)`;
  } catch (err) {
    error.value = describeError(err);
  }
}

async function deleteImage(product: Product): Promise<void> {
  error.value = '';
  notice.value = '';
  try {
    await removeProductImage(product.id);
    images.value = images.value.filter((img) => img.productId !== product.id);
    notice.value = 'اتشالت الصورة، والصنف رجع بالأيقونة';
  } catch (err) {
    error.value = describeError(err);
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
  formCategory.value = '';
}

function startEdit(product: Product): void {
  editingId.value = product.id;
  formName.value = product.name;
  formDisposition.value = product.disposition;
  formBarcode.value = product.barcode ?? '';
  // Null must render as an empty field, not as "0.00", or the operator would
  // save a free price onto a product that simply had none.
  formPriceMinor.value =
    product.salePriceMinor === null ? '' : moneyInputValue(product.salePriceMinor);
  formCategory.value = product.categoryId ?? '';
}

async function generateEditShopCode(): Promise<void> {
  error.value = '';
  try {
    formBarcode.value = await api.nextShopCode();
  } catch (err) {
    error.value = describeError(err);
  }
}

async function submit(): Promise<void> {
  busy.value = true;
  try {
    const price = parsePrice();
    if (price === null && formPriceMinor.value.trim() !== '') {
      error.value = 'السعر المدخل غير صالح.';
      return;
    }

    // The form edits an existing product only. Adding one is «صنف جديد»
    // (ADR-018 §3), which knows the category kind and the shop code.
    if (editingId.value === null) return;
    const updated = await api.updateProduct(editingId.value, {
      name: formName.value,
      disposition: formDisposition.value,
      barcode: formBarcode.value.trim() === '' ? null : formBarcode.value.trim(),
      salePriceMinor: price,
    });
    const chosen = formCategory.value === '' ? null : formCategory.value;
    if (updated.categoryId !== chosen) await api.setProductCategory(updated.id, chosen);
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

/** The camera beside a barcode box reads one code and runs the same search. */
function onSearchScan(reading: ScanReading): void {
  barcodeSearch.value = reading.raw;
  void searchByBarcode();
}

/** One reading into the edit form's barcode box — no search, nothing submitted. */
function onFormBarcodeScan(reading: ScanReading): void {
  formBarcode.value = reading.raw;
}

function clearSearch(): void {
  barcodeSearch.value = '';
  void load();
}

function changeFilter(next: ProductStatus): void {
  filter.value = next;
  void load();
}

onMounted(() => {
  void load();
  void loadCategories();
});
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

    <!-- Search by barcode: typed, pasted, or read with the camera. -->
    <form class="row" @submit.prevent="searchByBarcode">
      <input
        v-model="barcodeSearch"
        class="grow"
        placeholder="ابحث بالباركود (اكتب أو الصق أو امسح)"
        autocomplete="off"
      />
      <CameraScanButton :compact="true" data-catalog-search-scan @scan="onSearchScan" />
      <button type="submit" :disabled="busy">بحث</button>
      <button type="button" @click="clearSearch">مسح</button>
    </form>

    <!-- Edit only: a new product is «صنف جديد» above (ADR-018 §3). -->
    <p v-if="editingId === null" class="hint">
      الإضافة من «صنف جديد» فوق. ومن هنا تعدّل صنف موجود أو تأرشفه.
    </p>
    <form v-else class="panel-form" @submit.prevent="submit">
      <p class="hint">تعديل منتج</p>

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
        <span>التصنيف</span>
        <select v-model="formCategory">
          <option value="">من غير تصنيف</option>
          <option v-for="c in categoryOptions" :key="c.id" :value="c.id">{{ c.label }}</option>
        </select>
      </label>

      <label class="field">
        <span>الباركود (اختياري)</span>
        <div class="row" style="margin-bottom: 0">
          <input v-model="formBarcode" class="grow" dir="ltr" autocomplete="off" />
          <CameraScanButton
            :compact="true"
            data-edit-barcode-scan
            @scan="onFormBarcodeScan"
          />
          <button
            type="button"
            data-edit-generate-barcode
            title="اعمل كود EAN-13 للمحل يبدأ بـ 2"
            @click="generateEditShopCode"
          >
            اعمل كود للمحل
          </button>
        </div>
      </label>

      <label class="field">
        <span>سعر البيع (اختياري) — {{ moneyUnitWord() }}</span>
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
        <button type="submit" :disabled="busy">حفظ</button>
        <button type="button" @click="resetForm">إلغاء</button>
      </div>
    </form>

    <!-- List -->
    <p v-if="products.length === 0 && !busy" class="hint">لا توجد منتجات.</p>

    <input
      id="img-file"
      ref="fileInput"
      type="file"
      accept="image/*"
      hidden
      @change="onPickImageFile"
    />

    <p v-if="notice" class="notice" role="status">{{ notice }}</p>

    <ul class="list">
      <li v-for="product in products" :key="product.id" class="item">
        <div style="display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1">
          <button
            v-if="product.status === 'active'"
            type="button"
            class="pic"
            :class="{ has: !!imageMap[product.id] }"
            data-act="imgPick"
            :data-id="product.id"
            :title="imageMap[product.id] ? 'غيّر صورة الصنف' : 'ضيف صورة للصنف (اختياري)'"
            @click="openImagePicker(product)"
          >
            <img v-if="imageMap[product.id]" :src="imageMap[product.id]!.dataUrl" alt="" />
            <Icon v-else :name="productIcon(product)" />
            <span class="cam"><Icon name="camera" /></span>
          </button>
          <span
            v-else
            class="pic"
            :class="{ has: !!imageMap[product.id] }"
          >
            <img v-if="imageMap[product.id]" :src="imageMap[product.id]!.dataUrl" alt="" />

            <Icon v-else :name="productIcon(product)" />
          </span>
          <button
            v-if="product.status === 'active' && imageMap[product.id]"
            type="button"
            class="icon-btn xs"
            data-act="imgDel"
            :data-id="product.id"
            title="شيل الصورة"
            @click="deleteImage(product)"
          >
            <Icon name="x" :size="12" />
          </button>
          <div class="item-main">
            <span class="item-name">{{ product.name }}</span>
            <span class="hint">
              {{ dispositionLabel(product.disposition) }} · {{ categoryLabel(product) }} ·
              {{ priceLabel(product) }} · {{ statusLabel(product.status) }}
            </span>
            <span v-if="product.barcode" class="hint">{{ product.barcode }}</span>
          </div>
        </div>
        <div class="row">
          <button
            v-if="product.status === 'active'"
            type="button"
            :data-product-label="product.id"
            title="طباعة ملصق باركود للصنف"
            @click="emit('print-label', product.id)"
          >
            ملصق
          </button>
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
