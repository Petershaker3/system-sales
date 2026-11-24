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
import { listAllProductUnits } from '../api/inventory';
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
import { digitsOf, filterProducts } from '../screens/store/catalog-search';
import CameraScanButton from '../ui/CameraScanButton.vue';
import Modal from '../ui/Modal.vue';
import { toast } from '../ui/toast';
import { money, moneyInputValue, moneyUnitWord } from '../ui/format';
import Icon from '../ui/Icon.vue';
import type { IconName } from '../ui/icons';
import type { ScanReading } from '../ui/scan';
import { asIconName } from '../screens/pos/icons';

const emit = defineEmits<{
  'print-label': [productId: string];
  /**
   * «+ مخزون»: receive more of THIS product.
   *
   * Every other path to a delivery started at the delivery form and then asked the
   * shopkeeper to find the product again in a list of hundreds. The row knows the
   * product, so it hands it over and the delivery form opens on it (`0035`).
   */
  receive: [productId: string];
}>();

const error = ref<string>('');
const notice = ref<string>('');
const busy = ref(false);

const products = ref<Product[]>([]);
const images = ref<ProductImage[]>([]);
const filter = ref<ProductStatus>('active');
/**
 * واحد للبحث كله: الاسم، الكود/الباركود، أو سيريال الجهاز. البحث فوري على اللي
 * محمّل في الشاشة، فمفيش استناه ولا طلب سيرفر لكل حرف.
 */
const search = ref('');
/** IMEIs on the shelf, by product — the third thing he searches by. */
const serialsByProduct = ref<ReadonlyMap<string, readonly string[]>>(new Map());
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
    const [loadedProducts, loadedImages, units] = await Promise.all([
      api.listProducts(filter.value),
      listProductImages(),
      // A session without the inventory read still searches by name and code.
      listAllProductUnits().catch(() => []),
    ]);
    products.value = loadedProducts;
    images.value = loadedImages;
    const byProduct = new Map<string, string[]>();
    for (const unit of units) {
      const list = byProduct.get(unit.productId) ?? [];
      if (unit.imei) list.push(unit.imei);
      if (unit.imei2) list.push(unit.imei2);
      byProduct.set(unit.productId, list);
    }
    serialsByProduct.value = byProduct;
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
    toast(`اتحفظ تعديل «${updated.name}»`, 'ok');
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
 * ما في الشاشة، مفلتر بالبحث الحالي.
 *
 * البحث محلي عشان يبان فورًا مع كل حرف؛ 「Enter」 بس هو اللي بيروح للسيرفر
 * (باركود صنف مش في القائمة الحالية، أو صنف مؤرشف).
 */
const shownProducts = computed(() =>
  filterProducts(products.value, search.value, serialsByProduct.value)
);

/**
 * Enter: لو مفيش نتيجة محلية، اسأل السيرفر عن باركود مطابق بالظبط.
 *
 * No camera and no decoder here: barcode capture is BLOCKED (`ADR-008`), and a
 * value the operator types needs neither.
 */
async function searchNow(): Promise<void> {
  const needle = search.value.trim();
  if (needle === '') {
    await load();
    return;
  }
  if (shownProducts.value.length > 0) return;
  if (digitsOf(needle) === '') return;
  busy.value = true;
  try {
    const found = await api.findProductByBarcode(needle);
    products.value = [found];
    error.value = '';
  } catch {
    // مفيش باركود مطابق: الرسالة اللي فوق الجدول أوضح من خطأ سيرفر هنا.
    error.value = '';
  } finally {
    busy.value = false;
  }
}

/** The camera beside the search box reads one code and searches for it. */
function onSearchScan(reading: ScanReading): void {
  search.value = reading.raw;
  void searchNow();
}

/** One reading into the edit form's barcode box — no search, nothing submitted. */
function onFormBarcodeScan(reading: ScanReading): void {
  formBarcode.value = reading.raw;
}

function clearSearch(): void {
  search.value = '';
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

    <!-- شيء واحد للبحث: الاسم، الكود، أو السيريال — فوري مع كل حرف -->
    <form class="row" data-catalog-search @submit.prevent="searchNow">
      <input
        v-model="search"
        class="grow"
        type="search"
        placeholder="ابحث بالاسم أو الكود/الباركود أو سيريال الجهاز"
        autocomplete="off"
        aria-label="بحث في المخزن"
        data-catalog-search-input
      />
      <CameraScanButton :compact="true" data-catalog-search-scan @scan="onSearchScan" />
      <button type="submit" :disabled="busy" data-catalog-search-go>بحث</button>
      <button type="button" data-catalog-search-clear @click="clearSearch">مسح</button>
    </form>
    <p v-if="search.trim() !== ''" class="hint" data-catalog-search-count>
      {{ shownProducts.length === 0 ? 'مفيش نتايج مطابقة.' : `${shownProducts.length} من ${products.length}` }}
    </p>

    <!-- التعديل في نافذة: الفورم كان بيتفتح فوق الجدول وبرّه الشاشة، فكان بيبان
         كأن زر «تعديل» مش شغّال. -->
    <p v-if="editingId === null" class="hint">
      الإضافة من «صنف جديد» فوق. ودوس «تعديل» على أي صنف عشان تغيّر اسمه أو سعره أو تصنيفه.
    </p>

    <Modal
      v-if="editingId !== null"
      title="تعديل صنف"
      :sub="formName"
      size="md"
      @close="resetForm"
    >
      <form id="catalog-edit-form" class="panel-form" data-catalog-edit-form @submit.prevent="submit">
        <label class="field">
          <span>الاسم</span>
          <input v-model="formName" required autocomplete="off" data-autofocus data-edit-name />
        </label>

        <label class="field">
          <span>النوع</span>
          <select v-model="formDisposition" data-edit-disposition>
            <option value="quantity">كمّي</option>
            <option value="serialized">مسلسّل</option>
            <option value="one_off">قطعة تُباع مرة واحدة</option>
          </select>
        </label>

        <label class="field">
          <span>التصنيف</span>
          <select v-model="formCategory" data-edit-category>
            <option value="">من غير تصنيف</option>
            <option v-for="c in categoryOptions" :key="c.id" :value="c.id">{{ c.label }}</option>
          </select>
        </label>

        <label class="field">
          <span>الباركود (اختياري)</span>
          <div class="row" style="margin-bottom: 0">
            <input v-model="formBarcode" class="grow" dir="ltr" autocomplete="off" data-edit-barcode />
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
            data-edit-price
          />
        </label>
        <p class="hint">
          ترك الحقل فارغًا يعني أن السعر غير محدد، وهو ليس نفس الصفر.
          الصفر يعني منتجًا مجانيًا فعلًا.
        </p>

        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </form>

      <template #foot>
        <button type="submit" form="catalog-edit-form" :disabled="busy" data-edit-save>حفظ</button>
        <button type="button" class="ghost" @click="resetForm">إلغاء</button>
      </template>
    </Modal>

    <!-- List -->
    <p v-if="shownProducts.length === 0 && !busy" class="hint" data-catalog-empty>
      {{ products.length === 0 ? 'لا توجد منتجات.' : 'مفيش صنف مطابق للبحث.' }}
    </p>

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
      <li v-for="product in shownProducts" :key="product.id" class="item">
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
            v-if="product.status === 'active'"
            type="button"
            class="btn sm soft"
            :data-receive-product="product.id"
            title="استلام كمية جديدة من الصنف ده"
            @click="emit('receive', product.id)"
          >
            <Icon name="plus" :size="12" /> مخزون
          </button>
          <button
            type="button"
            :data-edit-product="product.id"
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
