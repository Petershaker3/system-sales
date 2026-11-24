<script setup lang="ts">
// Barcode Labels & Internal Shop Code modal (`طباعة الملصقات والباركود الداخلي`,
// Phase 2 Item 2.3, `ADR-033`, `docs/PLAN.md` §6 & §19, `ADR-016` #12 & D5).

import { computed, onMounted, ref } from 'vue';

import * as catalogApi from '../../api/catalog';
import type { Product } from '../../api/catalog';
import { type CategoryEntry, listCategories } from '../../api/categories';
import { describeError } from '../../api/errors';
import * as posApi from '../../api/pos';
import type { PosProduct, PosUnit } from '../../api/pos';
import { appearance } from '../../ui/appearance';
import { money, num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';
import {
  buildTsplScript,
  buildUnitLabelSubtitle,
  encodeBarcode,
  getLabelSizePreset,
  isInternalShopCode,
  LABEL_SIZES,
  type LabelPrintOptions,
  type LabelQueueItem,
  type LabelSizeId,
  renderLabelsSheetPng,
  totalLabelsCount,
} from './labels';

const props = withDefaults(
  defineProps<{
    initialProductId?: string | null;
    initialUnitId?: string | null;
  }>(),
  {
    initialProductId: null,
    initialUnitId: null,
  },
);

const emit = defineEmits<{
  close: [];
  barcodeGenerated: [productId: string, barcode: string];
}>();

const busy = ref(false);
const error = ref('');
const sourceTab = ref<'products' | 'units'>('products');
const searchQuery = ref('');

const products = ref<Product[]>([]);
const categories = ref<CategoryEntry[]>([]);
const posById = ref<Map<string, PosProduct>>(new Map());
const allUnits = ref<PosUnit[]>([]);

const queue = ref<LabelQueueItem[]>([]);

const size = ref<LabelSizeId>('40x30');
const showShopName = ref(true);
const showPrice = ref(true);
const showUnitDetails = ref(true);
const showTsplPreview = ref(false);
const lastPrintedCount = ref<number | null>(null);

const options = computed<LabelPrintOptions>(() => ({
  size: size.value,
  showShopName: showShopName.value,
  showPrice: showPrice.value,
  showUnitDetails: showUnitDetails.value,
}));

const activePreset = computed(() => getLabelSizePreset(size.value));
const totalStickers = computed(() => totalLabelsCount(queue.value));

function categoryNameFor(categoryId: string | null): string {
  if (!categoryId) return 'عام';
  return categories.value.find((c) => c.id === categoryId)?.name ?? 'عام';
}

function stockFor(productId: string): number {
  return posById.value.get(productId)?.onHand ?? 0;
}

const missingBarcodeProducts = computed(() =>
  products.value.filter((p) => p.status === 'active' && (!p.barcode || p.barcode.trim() === '')),
);

const filteredProducts = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return products.value.filter((p) => {
    if (p.status !== 'active') return false;
    if (!q) return true;
    return (
      p.name.toLowerCase().includes(q) ||
      (p.barcode ?? '').toLowerCase().includes(q) ||
      categoryNameFor(p.categoryId).toLowerCase().includes(q)
    );
  });
});

interface UnitWithProduct {
  readonly unit: PosUnit;
  readonly product: Product;
}

const filteredUnits = computed<readonly UnitWithProduct[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const byProd = new Map(products.value.map((p) => [p.id, p]));
  const out: UnitWithProduct[] = [];
  for (const u of allUnits.value) {
    const prod = byProd.get(u.productId);
    if (!prod) continue;
    if (
      q &&
      !prod.name.toLowerCase().includes(q) &&
      !u.imei.toLowerCase().includes(q) &&
      !(u.imei2 ?? '').toLowerCase().includes(q) &&
      !(u.color ?? '').toLowerCase().includes(q)
    ) {
      continue;
    }
    out.push({ unit: u, product: prod });
  }
  return out;
});

const tsplCode = computed(() =>
  buildTsplScript(queue.value, options.value, appearance.shopName || 'المحل'),
);

async function loadData(preserveQueue = false): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    const [prods, cats, posCat] = await Promise.all([
      catalogApi.listProducts('active'),
      listCategories().catch(() => [] as CategoryEntry[]),
      posApi.posCatalog().catch(() => null),
    ]);
    products.value = prods;
    categories.value = cats;
    if (posCat) {
      posById.value = new Map(posCat.products.map((p) => [p.id, p]));
      allUnits.value = [...(posCat.units ?? [])];
    }

    if (!preserveQueue && queue.value.length === 0) {
      if (props.initialUnitId) {
        const foundUnit = allUnits.value.find((u) => u.id === props.initialUnitId);
        const prod = foundUnit ? prods.find((p) => p.id === foundUnit.productId) : undefined;
        if (foundUnit && prod) {
          sourceTab.value = 'units';
          size.value = '50x30';
          addUnitToQueue(foundUnit, prod);
          return;
        }
      }
      if (props.initialProductId) {
        const prod = prods.find((p) => p.id === props.initialProductId);
        if (prod) {
          await addProductToQueue(prod);
          return;
        }
      }
      // Seed queue with first active barcoded product so preview is immediately visible
      const firstWithBarcode = prods.find((p) => p.barcode && p.barcode.trim() !== '');
      if (firstWithBarcode) {
        await addProductToQueue(firstWithBarcode);
      }
    }
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void loadData(false);
});

async function generateCodeForProduct(product: Product): Promise<Product | null> {
  busy.value = true;
  error.value = '';
  try {
    const code = await catalogApi.nextShopCode();
    const updated = await catalogApi.updateProduct(product.id, {
      barcode: code,
    });
    products.value = products.value.map((p) => (p.id === updated.id ? updated : p));
    queue.value = queue.value.map((item) =>
      item.kind === 'product' && item.productId === updated.id
        ? { ...item, barcode: code }
        : item,
    );
    emit('barcodeGenerated', updated.id, code);
    toast(`اتعمل كود للمحل (${code}) واتحفظ للصنف «${updated.name}»`, 'ok');
    return updated;
  } catch (err) {
    error.value = describeError(err);
    return null;
  } finally {
    busy.value = false;
  }
}

async function generateCodesForAllMissing(): Promise<void> {
  const missing = missingBarcodeProducts.value;
  if (missing.length === 0) {
    toast('كل الأصناف النشطة ليها باركود بالفعل', 'info');
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const codes = await catalogApi.nextShopCodes(missing.length);
    for (let i = 0; i < missing.length; i++) {
      const target = missing[i]!;
      const code = codes[i];
      if (!code) continue;
      const updated = await catalogApi.updateProduct(target.id, { barcode: code });
      products.value = products.value.map((p) => (p.id === updated.id ? updated : p));
      emit('barcodeGenerated', updated.id, code);
    }
    toast(
      `اتعمل ${num(codes.length)} كود داخلي للمحل (EAN-13) واتحفظوا على الأصناف`,
      'ok',
      4200,
    );
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function addProductToQueue(product: Product): Promise<void> {
  let activeProd = product;
  if (!activeProd.barcode || activeProd.barcode.trim() === '') {
    const generated = await generateCodeForProduct(activeProd);
    if (!generated) return;
    activeProd = generated;
  }
  const key = `prod:${activeProd.id}`;
  const existing = queue.value.find((item) => item.key === key);
  if (existing) {
    queue.value = queue.value.map((item) =>
      item.key === key ? { ...item, copies: item.copies + 1 } : item,
    );
    return;
  }
  queue.value = [
    ...queue.value,
    {
      key,
      kind: 'product',
      productId: activeProd.id,
      name: activeProd.name,
      categoryLabel: categoryNameFor(activeProd.categoryId),
      barcode: activeProd.barcode!,
      salePriceMinor: activeProd.salePriceMinor,
      onHand: stockFor(activeProd.id),
      copies: 1,
    },
  ];
}

function addUnitToQueue(unit: PosUnit, product: Product): void {
  const key = `unit:${unit.id}`;
  const existing = queue.value.find((item) => item.key === key);
  if (existing) {
    queue.value = queue.value.map((item) =>
      item.key === key ? { ...item, copies: item.copies + 1 } : item,
    );
    return;
  }
  queue.value = [
    ...queue.value,
    {
      key,
      kind: 'unit',
      productId: product.id,
      unitId: unit.id,
      name: product.name,
      categoryLabel: categoryNameFor(product.categoryId),
      barcode: unit.imei,
      imei2: unit.imei2 ?? null,
      salePriceMinor: product.salePriceMinor,
      onHand: 1,
      conditionGrade: unit.conditionGrade ?? null,
      batteryHealthPct: unit.batteryHealthPct ?? null,
      color: unit.color ?? null,
      accessories: unit.accessories ?? null,
      copies: 1,
    },
  ];
}

function setCopies(key: string, nextCopies: number): void {
  const clamped = Math.max(1, Math.min(200, Math.trunc(nextCopies) || 1));
  queue.value = queue.value.map((item) =>
    item.key === key ? { ...item, copies: clamped } : item,
  );
}

function removeFromQueue(key: string): void {
  queue.value = queue.value.filter((item) => item.key !== key);
}

function fillCopiesFromStock(): void {
  queue.value = queue.value.map((item) =>
    item.kind === 'product'
      ? { ...item, copies: Math.max(1, item.onHand) }
      : { ...item, copies: 1 },
  );
  toast('اتظبط عدد الملصقات على قد الرصيد المتاح في المخزن', 'ok');
}

function clearQueue(): void {
  queue.value = [];
  lastPrintedCount.value = null;
}

async function downloadPngSheet(): Promise<void> {
  if (queue.value.length === 0) return;
  const blob = await renderLabelsSheetPng(
    queue.value,
    options.value,
    appearance.shopName || 'المحل',
  );
  if (!blob) return;
  if (navigator.webdriver !== true) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `labels-${size.value}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  toast(`اتحفظت صورة الملصقات (${num(totalStickers.value)} ملصق · ${activePreset.value.label})`, 'ok');
}

async function copyTsplCommands(): Promise<void> {
  const code = tsplCode.value;
  if (!code) return;
  if (navigator.webdriver !== true && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(code).catch(() => {});
  }
  showTsplPreview.value = true;
  toast('اتنسخت أوامر طابعة الملصقات (TSPL) للحافظة', 'ok');
}

async function printLabelsNow(): Promise<void> {
  if (queue.value.length === 0) return;
  const count = totalStickers.value;
  await renderLabelsSheetPng(
    queue.value,
    options.value,
    appearance.shopName || 'المحل',
  );
  lastPrintedCount.value = count;
  toast(
    `جاهز للطباعة: ${num(count)} ملصق بمقاس ${activePreset.value.widthMm}×${activePreset.value.heightMm} مم`,
    'ok',
    4000,
  );
}
</script>

<template>
  <Modal
    title="طباعة الملصقات والباركود الداخلي"
    :sub="`${num(queue.length)} صنف/جهاز في القايمة · إجمالي ${num(totalStickers)} ملصق`"
    size="wide"
    @close="emit('close')"
  >
    <div class="lbl-layout" data-labels-modal>
      <!-- Left column: Picker + Active Queue -->
      <div class="lbl-col">
        <div class="row" style="justify-content: space-between; align-items: center; gap: 8px">
          <div class="inv-seg" role="tablist" data-labels-source-tabs>
            <button
              type="button"
              role="tab"
              :aria-selected="sourceTab === 'products'"
              :class="{ active: sourceTab === 'products' }"
              data-labels-tab="products"
              @click="sourceTab = 'products'"
            >
              <Icon name="scan-barcode" /> أصناف بالباركود ({{ num(products.length) }})
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="sourceTab === 'units'"
              :class="{ active: sourceTab === 'units' }"
              data-labels-tab="units"
              @click="sourceTab = 'units'"
            >
              <Icon name="smartphone" /> أجهزة بالـ IMEI ({{ num(allUnits.length) }})
            </button>
          </div>

          <button
            v-if="sourceTab === 'products' && missingBarcodeProducts.length > 0"
            type="button"
            class="btn sm"
            data-labels-generate-all-missing
            :disabled="busy"
            @click="generateCodesForAllMissing"
          >
            <Icon name="scan-barcode" /> ولّد أكواد للي من غير باركود ({{
              num(missingBarcodeProducts.length)
            }})
          </button>
        </div>

        <label class="inline-search" style="width: 100%; margin-top: 8px">
          <Icon name="search" />
          <input
            id="lbl-search"
            v-model="searchQuery"
            data-labels-search
            placeholder="ابحث بالاسم أو الباركود أو الـ IMEI…"
            autocomplete="off"
          />
        </label>

        <!-- Source List -->
        <div v-if="sourceTab === 'products'" class="lbl-source-list" data-labels-products-list>
          <div
            v-for="p in filteredProducts"
            :key="p.id"
            class="lbl-source-row"
            :data-labels-product-row="p.id"
          >
            <div style="min-width: 0; flex: 1">
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                <b><bdi dir="rtl">{{ p.name }}</bdi></b>
                <span class="tag">{{ categoryNameFor(p.categoryId) }}</span>
                <span class="muted num">المتاح: {{ num(stockFor(p.id)) }}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px; margin-top: 3px">
                <template v-if="p.barcode">
                  <span class="mono tag" dir="ltr" :data-labels-product-code="p.id">
                    {{ p.barcode }}
                  </span>
                  <span
                    v-if="isInternalShopCode(p.barcode)"
                    class="tag accent"
                    data-labels-internal-badge
                  >
                    كود المحل EAN-13
                  </span>
                </template>
                <span v-else class="muted">من غير باركود</span>
                <span v-if="p.salePriceMinor !== null" class="num">
                  · <b>{{ money(p.salePriceMinor) }}</b>
                </span>
              </div>
            </div>
            <div class="row" style="gap: 6px; margin: 0">
              <button
                v-if="!p.barcode"
                type="button"
                class="btn sm"
                :data-labels-make-code="p.id"
                :disabled="busy"
                @click="generateCodeForProduct(p)"
              >
                <Icon name="scan-barcode" /> اعمل كود للمحل
              </button>
              <button
                type="button"
                class="btn sm soft"
                :data-labels-add-product="p.id"
                :disabled="busy"
                @click="addProductToQueue(p)"
              >
                <Icon name="plus" /> ضيف للطباعة
              </button>
            </div>
          </div>
          <div v-if="filteredProducts.length === 0" class="muted" style="padding: 14px; text-align: center">
            مفيش أصناف مطابقة للبحث.
          </div>
        </div>

        <div v-else class="lbl-source-list" data-labels-units-list>
          <div
            v-for="{ unit, product } in filteredUnits"
            :key="unit.id"
            class="lbl-source-row"
            :data-labels-unit-row="unit.id"
          >
            <div style="min-width: 0; flex: 1">
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap">
                <b><bdi dir="rtl">{{ product.name }}</bdi></b>
                <span v-if="unit.conditionGrade" class="tag accent">
                  فئة {{ unit.conditionGrade }}
                </span>
                <span v-if="unit.batteryHealthPct" class="tag">
                  بطارية {{ num(unit.batteryHealthPct) }}%
                </span>
                <span v-if="unit.color" class="tag">{{ unit.color }}</span>
              </div>
              <div style="display: flex; align-items: center; gap: 6px; margin-top: 3px">
                <span class="mono tag" dir="ltr">IMEI: {{ unit.imei }}</span>
                <span v-if="product.salePriceMinor !== null" class="num">
                  · <b>{{ money(product.salePriceMinor) }}</b>
                </span>
              </div>
            </div>
            <button
              type="button"
              class="btn sm soft"
              :data-labels-add-unit="unit.id"
              @click="addUnitToQueue(unit, product)"
            >
              <Icon name="plus" /> ستيكر العلبة
            </button>
          </div>
          <div v-if="filteredUnits.length === 0" class="muted" style="padding: 14px; text-align: center">
            مفيش أجهزة متاحة بالـ IMEI مطابقة للبحث.
          </div>
        </div>

        <!-- Queue Table -->
        <div class="lbl-queue-box" data-labels-queue>
          <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 8px">
            <b><Icon name="tag" /> قايمة الطباعة ({{ num(queue.length) }})</b>
            <div class="row" style="gap: 6px; margin: 0">
              <button
                v-if="queue.length > 0"
                type="button"
                class="btn sm"
                data-labels-fill-stock
                @click="fillCopiesFromStock"
              >
                املأ بالمتاح في المخزن
              </button>
              <button
                v-if="queue.length > 0"
                type="button"
                class="btn sm ghost"
                data-labels-clear
                @click="clearQueue"
              >
                فضّي القايمة
              </button>
            </div>
          </div>

          <div v-if="queue.length === 0" class="muted" style="padding: 12px; text-align: center">
            اختار صنف أو جهاز من فوق عشان تطبعه على الملصق.
          </div>
          <div v-else class="lbl-queue-rows">
            <div
              v-for="item in queue"
              :key="item.key"
              class="lbl-queue-row"
              :data-labels-queue-row="item.key"
            >
              <div style="min-width: 0; flex: 1">
                <b><bdi dir="rtl">{{ item.name }}</bdi></b>
                <div class="muted" style="font-size: 12px">
                  <span class="mono" dir="ltr">{{ item.barcode }}</span>
                  <span v-if="item.salePriceMinor !== null">
                    · {{ money(item.salePriceMinor) }}
                  </span>
                </div>
              </div>
              <div class="row" style="gap: 4px; margin: 0; align-items: center">
                <button
                  type="button"
                  class="icon-btn sm"
                  title="نقص نسخة"
                  @click="setCopies(item.key, item.copies - 1)"
                >
                  −
                </button>
                <input
                  type="number"
                  min="1"
                  max="200"
                  class="num lbl-copies-in"
                  dir="ltr"
                  :value="item.copies"
                  :data-labels-copies="item.key"
                  @input="setCopies(item.key, Number(($event.target as HTMLInputElement).value))"
                />
                <button
                  type="button"
                  class="icon-btn sm"
                  title="زوّد نسخة"
                  @click="setCopies(item.key, item.copies + 1)"
                >
                  +
                </button>
                <button
                  type="button"
                  class="icon-btn sm danger"
                  title="شيل من القايمة"
                  @click="removeFromQueue(item.key)"
                >
                  <Icon name="x" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Right column: Label Settings + Live Scannable Sticker Preview + TSPL -->
      <div class="lbl-col">
        <div class="lbl-settings-card">
          <div class="ni-row" style="margin-bottom: 10px">
            <span class="label">مقاس الملصق الحراري</span>
            <div class="chips wrap" data-labels-sizes>
              <button
                v-for="preset in LABEL_SIZES"
                :key="preset.id"
                type="button"
                class="chip"
                :class="{ on: size === preset.id }"
                :data-labels-size="preset.id"
                @click="size = preset.id"
              >
                {{ preset.label }}
              </button>
            </div>
            <span class="hint">{{ activePreset.desc }}</span>
          </div>

          <div class="lbl-toggles">
            <label class="ni-switch" style="padding: 6px 10px">
              <span class="switch" data-labels-toggle-shop>
                <input v-model="showShopName" type="checkbox" />
                <span></span>
              </span>
              <span class="t"><b>اسم المحل فوق الملصق</b></span>
            </label>

            <label class="ni-switch" style="padding: 6px 10px">
              <span class="switch" data-labels-toggle-price>
                <input v-model="showPrice" type="checkbox" />
                <span></span>
              </span>
              <span class="t"><b>سعر البيع على الملصق</b></span>
            </label>

            <label class="ni-switch" style="padding: 6px 10px">
              <span class="switch" data-labels-toggle-unit>
                <input v-model="showUnitDetails" type="checkbox" />
                <span></span>
              </span>
              <span class="t"><b>تفاصيل المستعمل (الفئة والبطارية واللون)</b></span>
            </label>
          </div>
        </div>

        <!-- Live Sticker Preview -->
        <div class="lbl-preview-wrap" data-labels-preview>
          <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 8px">
            <b>معاينة الملصق الحقيقي ({{ activePreset.widthMm }}×{{ activePreset.heightMm }} مم)</b>
            <button
              type="button"
              class="btn sm ghost"
              data-labels-toggle-tspl
              @click="showTsplPreview = !showTsplPreview"
            >
              <Icon name="printer" />
              {{ showTsplPreview ? 'إخفاء أوامر TSPL' : 'أوامر طابعة TSPL' }}
            </button>
          </div>

          <div v-if="queue.length === 0" class="muted" style="padding: 28px; text-align: center">
            مفيش ملصقات في القايمة للمعاينة.
          </div>
          <div v-else class="lbl-stickers-grid">
            <div
              v-for="item in queue"
              :key="item.key"
              class="lbl-sticker"
              :data-sticker-size="size"
              :data-sticker-key="item.key"
            >
              <span class="lbl-copies-badge num">× {{ num(item.copies) }}</span>
              <div v-if="showShopName" class="lbl-st-shop">
                {{ appearance.shopName || 'المحل' }}
              </div>
              <div class="lbl-st-name">
                <bdi dir="rtl">{{ item.name }}</bdi>
              </div>
              <div
                v-if="showUnitDetails && item.kind === 'unit' && buildUnitLabelSubtitle(item)"
                class="lbl-st-unit"
                data-sticker-unit-subtitle
              >
                <bdi dir="rtl">{{ buildUnitLabelSubtitle(item) }}</bdi>
              </div>

              <!-- Real Scannable 1D Barcode SVG (EAN-13 or Code-128B) -->
              <svg
                class="lbl-st-barcode"
                :viewBox="`0 0 ${encodeBarcode(item.barcode).totalModules} 44`"
                preserveAspectRatio="none"
                role="img"
                :aria-label="`باركود ${item.barcode}`"
                data-sticker-svg
              >
                <rect
                  v-for="(r, rIdx) in encodeBarcode(item.barcode).rects"
                  :key="rIdx"
                  :x="r.x"
                  y="0"
                  :width="r.w"
                  height="44"
                  fill="#000000"
                />
              </svg>

              <div class="lbl-st-digits mono" dir="ltr" data-sticker-digits>
                {{ item.kind === 'unit' ? `IMEI: ${item.barcode}` : item.barcode }}
              </div>

              <div
                v-if="showPrice && item.salePriceMinor !== null"
                class="lbl-st-price num"
                data-sticker-price
              >
                {{ money(item.salePriceMinor) }}
              </div>
            </div>
          </div>

          <!-- TSPL Thermal Label Printer Script -->
          <div v-if="showTsplPreview && tsplCode" class="lbl-tspl-box" data-labels-tspl-code>
            <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 4px">
              <span class="muted">أوامر طابعات الملصقات الحرارية (TSPL2 — Xprinter / TSC):</span>
              <button type="button" class="btn sm" @click="copyTsplCommands">
                نسخ الكود
              </button>
            </div>
            <pre class="mono" dir="ltr">{{ tsplCode }}</pre>
          </div>

          <div
            v-if="lastPrintedCount !== null"
            class="tag ok"
            style="margin-top: 8px; align-self: flex-start"
            data-labels-print-status
          >
            <Icon name="check" /> جاهز للطباعة: {{ num(lastPrintedCount) }} ملصق ({{
              activePreset.label
            }})
          </div>
        </div>
      </div>
    </div>

    <div v-if="error" class="err-msg">{{ error }}</div>

    <template #foot>
      <span class="muted">
        إجمالي الملصقات: <b class="num">{{ num(totalStickers) }}</b> ملصق · المقاس:
        <b>{{ activePreset.widthMm }}×{{ activePreset.heightMm }} مم</b>
      </span>
      <span class="sp"></span>
      <button type="button" class="btn ghost" @click="emit('close')">
        إغلاق <kbd>Esc</kbd>
      </button>
      <button
        type="button"
        class="btn"
        data-labels-copy-tspl-btn
        :disabled="queue.length === 0"
        @click="copyTsplCommands"
      >
        <Icon name="tag" /> أوامر TSPL
      </button>
      <button
        type="button"
        class="btn"
        data-labels-download-png
        :disabled="queue.length === 0"
        @click="downloadPngSheet"
      >
        <Icon name="download" /> نزّل صورة PNG
      </button>
      <button
        type="button"
        class="btn primary"
        data-labels-print
        :disabled="queue.length === 0"
        @click="printLabelsNow"
      >
        <Icon name="printer" /> اطبع الملصقات ({{ num(totalStickers) }})
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.lbl-layout {
  display: grid;
  grid-template-columns: 1.08fr 0.92fr;
  gap: 16px;
  align-items: start;
}
@media (max-width: 860px) {
  .lbl-layout {
    grid-template-columns: 1fr;
  }
}
.lbl-col {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.lbl-source-list {
  max-height: 220px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--bg-sub);
  display: flex;
  flex-direction: column;
}
.lbl-source-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--line);
}
.lbl-source-row:last-child {
  border-bottom: 0;
}
.lbl-queue-box {
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 10px 12px;
  background: var(--surface);
}
.lbl-queue-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 175px;
  overflow-y: auto;
}
.lbl-queue-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid var(--line);
  border-radius: var(--r);
  background: var(--bg-sub);
}
.lbl-copies-in {
  width: 56px;
  text-align: center;
  padding: 4px 6px;
}
.lbl-settings-card {
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 10px 12px;
  background: var(--bg-sub);
}
.lbl-toggles {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.lbl-preview-wrap {
  border: 1px solid var(--line);
  border-radius: var(--r);
  padding: 12px;
  background: var(--bg-sub);
  display: flex;
  flex-direction: column;
}
.lbl-stickers-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 12px;
  max-height: 310px;
  overflow-y: auto;
  padding: 4px;
}
.lbl-sticker {
  position: relative;
  background: #ffffff;
  color: #111827;
  border: 1.5px solid #1f2937;
  border-radius: 6px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 3px;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.lbl-copies-badge {
  position: absolute;
  top: 6px;
  inset-inline-start: 6px;
  background: #1d4f91;
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 99px;
}
.lbl-st-shop {
  font-size: 11px;
  font-weight: 600;
  color: #4b5563;
}
.lbl-st-name {
  font-size: 13px;
  font-weight: 700;
  color: #111827;
  line-height: 1.25;
}
.lbl-st-unit {
  font-size: 11px;
  font-weight: 600;
  color: #1d4f91;
}
.lbl-st-barcode {
  width: 92%;
  height: 44px;
  margin-top: 3px;
  background: #ffffff;
}
.lbl-st-digits {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.6px;
  color: #111827;
}
.lbl-st-price {
  font-size: 14px;
  font-weight: 800;
  color: #111827;
  margin-top: 1px;
}
.lbl-tspl-box {
  margin-top: 10px;
  border-top: 1px dashed var(--line);
  padding-top: 8px;
}
.lbl-tspl-box pre {
  margin: 0;
  padding: 8px;
  font-size: 11px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r);
  max-height: 110px;
  overflow: auto;
}
.sp {
  flex: 1;
}
</style>
