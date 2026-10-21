<script setup lang="ts">
// «موبايل مستعمل» / «شراء جهاز مستعمل من عميل» / «الاستبدال» / «رصيد يوم البداية»
// (`ADR-032`, `PLAN.md` §13, `docs/ui/mockup-v1/views/catalog.js` `niUsed`).
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import {
  checkImei,
  createBrand,
  createUsedPhone,
  listBrands,
  type BrandEntry,
  type ConditionGrade,
  type DeviceType,
  type ImeiCheckResult,
  type RegisteredUsedPhone,
} from '../../api/brands';
import { listCategories, type CategoryEntry } from '../../api/categories';
import { posCatalog } from '../../api/pos';
import { readAppearance } from '../../api/appearance';
import { describeError } from '../../api/errors';
import { withOwnerApproval } from '../../shell/approval';
import { money, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import CameraScanButton from '../../ui/CameraScanButton.vue';
import type { ScanReading } from '../../ui/scan';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';
import { normalizeImeiDigits, validateImeiInput } from '../pos/imei';
import {
  brandsFor,
  cleanModel,
  isValidNationalId,
  RAM_CHOICES,
  STORAGE_CHOICES,
  storageLabel,
  USED_ACCESSORY_CHOICES,
  USED_GRADE_CHOICES,
  usedPhoneTitle,
} from './phone';

const props = withDefaults(
  defineProps<{
    mode?: 'catalog' | 'opening' | 'tradein';
    canBack?: boolean;
  }>(),
  {
    mode: 'catalog',
    canBack: false,
  }
);

const emit = defineEmits<{
  close: [];
  back: [];
  saved: [registered: RegisteredUsedPhone, keepOpen: boolean];
}>();

const categories = ref<CategoryEntry[]>([]);
const brands = ref<BrandEntry[]>([]);
const categoryId = ref('');
const device = ref<DeviceType>('touch');
const brandId = ref('');
const model = ref('');
const storageGb = ref<number | null>(128);
const ramGb = ref<number | null>(8);
const color = ref('');
const imei = ref('');
const imei2 = ref('');
const conditionGrade = ref<ConditionGrade>('A');
const batteryHealth = ref('88');
const selectedAcc = ref<Record<string, boolean>>({
  box: true,
  charger: true,
  receipt: false,
});
const intakeNote = ref('');
const cost = ref('');
const price = ref('');
const sellerOpen = ref(props.mode === 'tradein');
const sellerName = ref('');
const sellerPhone = ref('');
const sellerNationalId = ref('');
const isOpeningStock = ref(props.mode === 'opening');
const payoutFromDrawer = ref(props.mode === 'tradein');
const warrantyUsedMonths = ref(1);

const addingBrand = ref(false);
const newBrandName = ref('');
const brandInput = ref<HTMLInputElement | null>(null);
const modelInput = ref<HTMLInputElement | null>(null);
const imeiCheckReport = ref<ImeiCheckResult | null>(null);
const checkingImei = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);

const modalTitle = computed(() => {
  if (props.mode === 'tradein') return 'استبدال موبايل مستعمل (شراء + بيع في فاتورة واحدة)';
  if (isOpeningStock.value) return 'تسجيل موبايل مستعمل (رصيد يوم البداية)';
  return 'موبايل مستعمل / شراء من عميل';
});

const modalSub = computed(() => {
  if (props.mode === 'tradein') {
    return 'الجهاز القديم يدخل المخزن كمستعمل بقيمته المتفق عليها وتتخصم تلقائياً من الفاتورة';
  }
  if (isOpeningStock.value) {
    return 'أجهزة مستعملة موجودة على الرف يوم بداية تشغيل البرنامج (بـ PIN صاحب المحل)';
  }
  return 'بيانات الجهاز + فحص الحالة والبطارية والـ IMEI + بيانات اللي باعه';
});

const usedCategories = computed(() => {
  const used = categories.value.filter((c) => c.kind === 'used' && !c.hidden);
  if (used.length > 0) return used;
  return categories.value.filter((c) => (c.kind === 'used' || c.kind === 'phone') && !c.hidden);
});

const offeredBrands = computed(() => brandsFor(brands.value, device.value));
const chosenBrand = computed(() => brands.value.find((b) => b.id === brandId.value) ?? null);

const preview = computed(() =>
  usedPhoneTitle(
    chosenBrand.value?.name ?? '',
    chosenBrand.value?.lines ?? [],
    model.value,
    device.value === 'touch' ? storageGb.value : null,
    conditionGrade.value
  )
);

function imeiErrorText(code: string): string {
  return code === 'IMEI_LENGTH_INVALID'
    ? 'الـ IMEI لازم يكون 15 رقم بالظبط.'
    : 'رقم التحقق الأخير (Luhn) غلط — راجع الرقم.';
}

const imeiDigitsCount = computed(() => normalizeImeiDigits(imei.value).length);
const imeiValidation = computed(() => validateImeiInput(imei.value));
const imei2Validation = computed(() => {
  if (!imei2.value.trim()) return null;
  return validateImeiInput(imei2.value);
});

const costMinorPreview = computed(() => {
  const parsed = parseMoney(cost.value);
  return parsed !== null && parsed >= 0 ? parsed : 0;
});

const saleMinorPreview = computed(() => {
  const parsed = parseMoney(price.value);
  return parsed !== null && parsed > 0 ? parsed : 0;
});

const marginMinorPreview = computed(() => saleMinorPreview.value - costMinorPreview.value);

async function load(): Promise<void> {
  try {
    const [cats, bs, app] = await Promise.all([
      listCategories(),
      listBrands(),
      readAppearance().catch(() => null),
    ]);
    categories.value = cats;
    brands.value = bs;
    if (app && typeof app.warrantyUsed === 'string') {
      const parsed = Number.parseInt(app.warrantyUsed, 10);
      if (Number.isFinite(parsed) && parsed >= 0) warrantyUsedMonths.value = parsed;
    }
  } catch {
    // Fallback for seller sessions in POS trade-in mode (`Permission::Sell`).
    try {
      const pos = await posCatalog();
      categories.value = pos.categories.map((c) => ({
        ...c,
        products: 0,
        isDefault: true,
        deletable: false,
      }));
      brands.value = pos.brands.map((b) => ({
        id: b.id,
        name: b.name,
        deviceType: 'both',
        sortOrder: b.sortOrder,
        hidden: false,
        lines: [],
        products: 0,
        isDefault: true,
        deletable: false,
      }));
    } catch (e) {
      error.value = describeError(e);
    }
  }
  if (!usedCategories.value.some((c) => c.id === categoryId.value)) {
    categoryId.value = usedCategories.value[0]?.id ?? '';
  }
  pickDefaultBrand();
}

function pickDefaultBrand(): void {
  if (!offeredBrands.value.some((b) => b.id === brandId.value)) {
    brandId.value = offeredBrands.value[0]?.id ?? '';
  }
}

function setDevice(next: DeviceType): void {
  device.value = next;
  if (next === 'keypad') {
    storageGb.value = null;
    ramGb.value = null;
    batteryHealth.value = '';
  } else if (storageGb.value === null) {
    storageGb.value = 128;
    ramGb.value = 8;
    if (!batteryHealth.value) batteryHealth.value = '88';
  }
  pickDefaultBrand();
}

function toggleAccessory(key: string): void {
  selectedAcc.value[key] = !selectedAcc.value[key];
}

function buildAccessoriesString(): string {
  return USED_ACCESSORY_CHOICES.filter((a) => selectedAcc.value[a.key])
    .map((a) => a.label)
    .join('، ');
}

async function openNewBrand(): Promise<void> {
  addingBrand.value = true;
  newBrandName.value = '';
  await nextTick();
  brandInput.value?.focus();
}

async function addInlineBrand(): Promise<void> {
  const name = newBrandName.value.trim();
  if (!name || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    const created = await createBrand(name, device.value);
    brands.value = await listBrands();
    brandId.value = created.id;
    addingBrand.value = false;
    toast(`اتضافت شركة «${created.name}»`, 'ok');
    await nextTick();
    modelInput.value?.focus();
  } catch (e) {
    error.value = describeError(e);
  } finally {
    busy.value = false;
  }
}

/**
 * A camera reading into the first IMEI field (`ADR-043`).
 *
 * `normalizeImeiDigits` is the same normaliser the keyboard path uses, so a scanned
 * number and a typed number can never end up stored in two different shapes.
 */
function onImeiScan(reading: ScanReading): void {
  imei.value = normalizeImeiDigits(reading.digits === '' ? reading.raw : reading.digits);
}

/** The second slot, for a dual-SIM handset. */
function onImei2Scan(reading: ScanReading): void {
  imei2.value = normalizeImeiDigits(reading.digits === '' ? reading.raw : reading.digits);
}

async function runQuickImeiCheck(): Promise<void> {
  const raw = imei.value.trim();
  if (!raw || checkingImei.value) return;
  checkingImei.value = true;
  error.value = null;
  try {
    imeiCheckReport.value = await checkImei(raw);
  } catch (e) {
    error.value = describeError(e);
  } finally {
    checkingImei.value = false;
  }
}

watch(imei, () => {
  imeiCheckReport.value = null;
});

async function submit(keepOpen: boolean): Promise<void> {
  if (busy.value) return;
  error.value = null;

  if (!categoryId.value) {
    error.value = 'اختار تصنيف الموبايلات المستعملة الأول.';
    return;
  }
  if (!brandId.value) {
    error.value = 'اختار الشركة الأول.';
    return;
  }
  if (!cleanModel(model.value)) {
    error.value = 'اكتب موديل الجهاز (زي Galaxy A54 أو iPhone 13).';
    modelInput.value?.focus();
    return;
  }
  if (device.value === 'touch' && storageGb.value === null) {
    error.value = 'اختار مساحة التاتش (مثلاً 128GB).';
    return;
  }
  const v1 = imeiValidation.value;
  if (!v1.ok) {
    error.value = imeiErrorText(v1.code);
    return;
  }
  const v2 = imei2Validation.value;
  if (v2 && !v2.ok) {
    error.value = imeiErrorText(v2.code);
    return;
  }
  if (v2 && v2.ok && v2.imei === v1.imei) {
    error.value = 'الـ IMEI التاني لازم يكون مختلف عن الـ IMEI الأولاني.';
    return;
  }

  let batteryPct: number | null = null;
  if (device.value === 'touch' && batteryHealth.value.trim() !== '') {
    const parsedBatt = Number.parseInt(batteryHealth.value.trim(), 10);
    if (!Number.isFinite(parsedBatt) || parsedBatt < 1 || parsedBatt > 100) {
      error.value = 'نسبة البطارية لازم تكون رقم من 1 لـ 100.';
      return;
    }
    batteryPct = parsedBatt;
  }

  if (!isValidNationalId(sellerNationalId.value)) {
    error.value = 'رقم البطاقة القومي لازم يكون 14 رقم بالظبط.';
    return;
  }

  const parsedCost = cost.value.trim() === '' && isOpeningStock.value ? 0 : parseMoney(cost.value);
  if (parsedCost === null || parsedCost < 0) {
    error.value = 'اكتب تكلفة الشراء صح.';
    return;
  }
  if (!isOpeningStock.value && parsedCost <= 0) {
    error.value = 'اكتب اشتريته بكام من العميل.';
    return;
  }

  const parsedSale = parseMoney(price.value);
  if (parsedSale === null || parsedSale <= 0) {
    error.value = 'اكتب سعر البيع المتوقع للجهاز.';
    return;
  }

  const payload = {
    categoryId: categoryId.value,
    brandId: brandId.value,
    model: model.value,
    deviceType: device.value,
    storageGb: device.value === 'touch' ? storageGb.value : null,
    ramGb: device.value === 'touch' ? ramGb.value : null,
    color: color.value.trim() || null,
    imei: v1.imei,
    imei2: v2 && v2.ok ? v2.imei : null,
    conditionGrade: conditionGrade.value,
    batteryHealthPct: batteryPct,
    accessories: buildAccessoriesString() || null,
    intakeNote: intakeNote.value.trim() || null,
    costMinor: parsedCost,
    salePriceMinor: parsedSale,
    sellerName: sellerName.value.trim() || null,
    sellerPhone: sellerPhone.value.trim() || null,
    sellerNationalId: sellerNationalId.value.trim().replace(/[\s-]/g, '') || null,
    isOpeningStock: isOpeningStock.value,
    payoutFromDrawer: !isOpeningStock.value && payoutFromDrawer.value,
  };

  busy.value = true;
  try {
    let registered: RegisteredUsedPhone;
    if (isOpeningStock.value) {
      const outcome = await withOwnerApproval(
        () => createUsedPhone(payload),
        'تسجيل موبايل مستعمل من رصيد بداية المدة'
      );
      if (outcome.status === 'cancelled') {
        busy.value = false;
        return;
      }
      registered = outcome.value;
    } else {
      registered = await createUsedPhone(payload);
    }

    toast(`اتسجّل «${registered.product.name}» بالـ IMEI ${registered.imei}`, 'ok');
    emit('saved', registered, keepOpen);
    if (keepOpen) {
      imei.value = '';
      imei2.value = '';
      intakeNote.value = '';
      imeiCheckReport.value = null;
      await nextTick();
      modelInput.value?.focus();
    }
  } catch (e) {
    error.value = describeError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<template>
  <Modal :title="modalTitle" :sub="modalSub" size="wide" @close="emit('close')">
    <div v-if="error" class="err" role="alert">{{ error }}</div>

    <!-- Opening stock / drawer payout mode bar (when not inside POS trade-in) -->
    <div v-if="mode !== 'tradein'" class="used-mode-bar">
      <label class="switch-field" data-used-opening-toggle>
        <span class="switch">
          <input v-model="isOpeningStock" type="checkbox" />
          <span></span>
        </span>
        <span class="cap">من المستعمل اللي في المحل يوم البداية (رصيد افتتاحي بـ PIN المالك)</span>
      </label>
      <label v-if="!isOpeningStock" class="switch-field" data-used-drawer-toggle>
        <span class="switch">
          <input v-model="payoutFromDrawer" type="checkbox" />
          <span></span>
        </span>
        <span class="cap">صرف ثمن الشراء من درج الوردية المفتوحة</span>
      </label>
    </div>

    <div class="field">
      <span class="lbl">نوع الجهاز</span>
      <div id="nu-dtype" class="chips">
        <button
          type="button"
          class="chip"
          :class="{ on: device === 'touch' }"
          @click="setDevice('touch')"
        >
          <Icon name="smartphone" /> تاتش (سمارت)
        </button>
        <button
          type="button"
          class="chip"
          :class="{ on: device === 'keypad' }"
          @click="setDevice('keypad')"
        >
          <Icon name="hash" /> زراير
        </button>
      </div>
    </div>

    <div class="field">
      <span class="lbl">الشركة <b>*</b></span>
      <div id="nu-brands" class="chips">
        <button
          v-for="b in offeredBrands"
          :key="b.id"
          type="button"
          class="chip"
          :class="{ on: brandId === b.id }"
          @click="brandId = b.id"
        >
          <bdi dir="auto">{{ b.name }}</bdi>
        </button>
        <button
          v-if="!addingBrand && mode !== 'tradein'"
          type="button"
          class="chip add"
          @click="openNewBrand"
        >
          <Icon name="plus" /> شركة تانية
        </button>
      </div>
      <div v-if="addingBrand" class="inline-new">
        <input
          id="nu-brand-new"
          ref="brandInput"
          v-model="newBrandName"
          class="in"
          placeholder="اسم الشركة..."
          @keydown.enter.prevent="addInlineBrand"
          @keydown.esc.prevent="addingBrand = false"
        />
        <button type="button" class="btn primary sm" :disabled="busy" @click="addInlineBrand">
          إضافة
        </button>
        <button type="button" class="btn ghost sm" @click="addingBrand = false">إلغاء</button>
      </div>
    </div>

    <div class="row2">
      <label class="field" for="nu-model">
        <span class="lbl">الموديل <b>*</b></span>
        <input
          id="nu-model"
          ref="modelInput"
          v-model="model"
          class="in"
          :dir="model ? 'ltr' : 'rtl'"
          :placeholder="device === 'keypad' ? 'مثال: 105 أو 106' : 'مثال: Galaxy A54 أو iPhone 13'"
        />
      </label>
      <label class="field" for="nu-color">
        <span class="lbl">اللون</span>
        <input
          id="nu-color"
          v-model="color"
          class="in"
          placeholder="أسود، أبيض، أزرق..."
        />
      </label>
    </div>

    <div v-if="device === 'touch'" class="row2">
      <div class="field">
        <span class="lbl">المساحة <b>*</b></span>
        <div id="nu-rom" class="chips">
          <button
            v-for="gb in STORAGE_CHOICES"
            :key="gb"
            type="button"
            class="chip mono"
            :class="{ on: storageGb === gb }"
            dir="ltr"
            @click="storageGb = gb"
          >
            {{ storageLabel(gb) }}
          </button>
        </div>
      </div>
      <div class="field">
        <span class="lbl">الرام <span class="muted">(اختياري)</span></span>
        <div id="nu-ram" class="chips">
          <button
            v-for="gb in RAM_CHOICES"
            :key="gb"
            type="button"
            class="chip mono"
            :class="{ on: ramGb === gb }"
            dir="ltr"
            @click="ramGb = ramGb === gb ? null : gb"
          >
            {{ gb }}GB
          </button>
        </div>
      </div>
    </div>

    <!-- IMEI 1 & IMEI 2 + quick check -->
    <div class="row2">
      <div class="field">
        <span class="lbl">
          IMEI الأساسي <b>*</b>
          <span class="muted">(اطلب <bdi dir="ltr">*#06#</bdi> وقارن بالعلبة)</span>
        </span>
        <div class="imei-inline">
          <input
            id="nu-imei"
            v-model="imei"
            class="in"
            :class="{ mono: imei !== '' }"
            :dir="imei ? 'ltr' : 'rtl'"
            maxlength="19"
            placeholder="15 رقم"
          />
          <CameraScanButton
            :compact="true"
            data-nu-scan-imei
            @scan="onImeiScan"
          />
          <button
            type="button"
            class="btn ghost sm"
            data-nu-check-imei
            :disabled="!imei.trim() || checkingImei"
            @click="runQuickImeiCheck"
          >
            فحص السجل
          </button>
        </div>
        <div v-if="imei.trim()" class="imei-status-line">
          <span v-if="imeiValidation.ok" class="tag ok">
            ✓ 15 رقم سليم حسابياً (Luhn)
          </span>
          <span v-else class="tag err-tag">
            {{ imeiErrorText(imeiValidation.code) }} ({{ imeiDigitsCount }}/15)
          </span>
        </div>
        <div v-if="imeiCheckReport" class="imei-report-mini" data-nu-imei-report>
          <span v-if="imeiCheckReport.localUnit" class="tag warn-tag">
            تنبيه: مسجل في المحل ({{ imeiCheckReport.localUnit.productName }} —
            {{
              imeiCheckReport.localUnit.status === 'in_stock'
                ? 'موجود في المخزن'
                : imeiCheckReport.localUnit.status === 'sold'
                  ? 'اتبايع قبل كده'
                  : 'مرتجع'
            }})
          </span>
          <span v-else-if="imeiCheckReport.luhnValid" class="tag ok">
            ✓ مش متسجل في مخزن المحل قبل كده (TAC: <bdi dir="ltr">{{ imeiCheckReport.tac }}</bdi>)
          </span>
          <span v-if="imeiCheckReport.repairs.length > 0" class="tag warn-tag">
            ليه {{ imeiCheckReport.repairs.length }} تذكرة صيانة في المحل
          </span>
        </div>
      </div>

      <div class="field">
        <label class="lbl" for="nu-imei2">
          IMEI التاني <span class="muted">(اختياري — لو خطين)</span>
        </label>
        <!-- The camera sits beside the input rather than inside a wrapping <label>:
             a control inside a label changes the caret geometry of an RTL field. -->
        <div class="imei-inline">
          <input
            id="nu-imei2"
            v-model="imei2"
            class="in"
            :class="{ mono: imei2 !== '' }"
            :dir="imei2 ? 'ltr' : 'rtl'"
            maxlength="19"
            placeholder="15 رقم"
          />
          <CameraScanButton
            :compact="true"
            data-nu-scan-imei2
            @scan="onImei2Scan"
          />
        </div>
        <div v-if="imei2Validation" class="imei-status-line">
          <span v-if="imei2Validation.ok" class="tag ok">✓ IMEI 2 سليم</span>
          <span v-else class="tag err-tag">{{ imeiErrorText(imei2Validation.code) }}</span>
        </div>
      </div>
    </div>

    <!-- Condition Grade A / B / C & Battery % -->
    <div class="row2">
      <div class="field">
        <span class="lbl">الحالة <b>*</b></span>
        <div id="nu-grade" class="chips">
          <button
            v-for="g in USED_GRADE_CHOICES"
            :key="g.code"
            type="button"
            class="chip"
            :class="{ on: conditionGrade === g.code }"
            :data-grade="g.code"
            @click="conditionGrade = g.code"
          >
            {{ g.label }}
          </button>
        </div>
      </div>

      <div class="row2">
        <label v-if="device === 'touch'" class="field" for="nu-batt">
          <span class="lbl">البطارية %</span>
          <input
            id="nu-batt"
            v-model="batteryHealth"
            class="in"
            :class="{ mono: batteryHealth !== '' }"
            :dir="batteryHealth ? 'ltr' : 'rtl'"
            inputmode="numeric"
            placeholder="88"
          />
        </label>
        <div class="field">
          <span class="lbl">معاه</span>
          <div id="nu-acc" class="chips">
            <button
              v-for="acc in USED_ACCESSORY_CHOICES"
              :key="acc.key"
              type="button"
              class="chip"
              :class="{ on: selectedAcc[acc.key] }"
              :data-acc="acc.key"
              @click="toggleAccessory(acc.key)"
            >
              {{ acc.label }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <label class="field" for="nu-note">
      <span class="lbl">العيوب أو ملاحظات الفحص</span>
      <input
        id="nu-note"
        v-model="intakeNote"
        class="in"
        placeholder="مثال: خدش صغير على الضهر — الشاشة والبصمة والكاميرا والواي فاي والمايك سلام"
      />
    </label>

    <!-- Purchase cost & expected sale price -->
    <div class="row2">
      <label class="field" for="nu-cost">
        <span class="lbl">
          {{ mode === 'tradein' ? 'قيمة الاستبدال المتفق عليها (تتخصم من الفاتورة)' : 'اشتريته بكام' }}
          <b v-if="!isOpeningStock">*</b>
          <span v-else class="muted">(اختياري لرصيد البداية — 0 لو مش معروف)</span>
        </span>
        <input
          id="nu-cost"
          v-model="cost"
          class="in"
          :class="{ mono: cost !== '' }"
          :dir="cost ? 'ltr' : 'rtl'"
          inputmode="decimal"
          placeholder="0"
        />
      </label>
      <label class="field" for="nu-price">
        <span class="lbl">هيتباع بكام <b>*</b></span>
        <input
          id="nu-price"
          v-model="price"
          class="in"
          :class="{ mono: price !== '' }"
          :dir="price ? 'ltr' : 'rtl'"
          inputmode="decimal"
          placeholder="0"
        />
      </label>
    </div>

    <div v-if="saleMinorPreview > 0 && costMinorPreview > 0" class="margin-banner">
      <span>تكلفة دخول المخزن: <b>{{ money(costMinorPreview) }}</b></span>
      <span>سعر البيع المستهدف: <b>{{ money(saleMinorPreview) }}</b></span>
      <span :class="marginMinorPreview >= 0 ? 'ok-txt' : 'err-txt'">
        الربح المتوقع عند البيع: <b>{{ money(marginMinorPreview) }}</b>
      </span>
    </div>

    <!-- Seller details (Name, Phone, 14-digit National ID) -->
    <details class="seller-details" :open="sellerOpen" @toggle="sellerOpen = ($event.target as HTMLDetailsElement).open">
      <summary data-nu-seller-summary>
        بيانات اللي باعه (الاسم · التليفون · الرقم القومي 14 رقم — لحماية المحل قانونياً)
      </summary>
      <div class="row3 seller-grid">
        <label class="field" for="nu-seller-name">
          <span class="lbl">اسم البائع</span>
          <input id="nu-seller-name" v-model="sellerName" class="in" placeholder="الاسم بالكامل" />
        </label>
        <label class="field" for="nu-seller-phone">
          <span class="lbl">تليفون البائع</span>
          <input
            id="nu-seller-phone"
            v-model="sellerPhone"
            class="in"
            :class="{ mono: sellerPhone !== '' }"
            :dir="sellerPhone ? 'ltr' : 'rtl'"
            placeholder="010xxxxxxxx"
          />
        </label>
        <label class="field" for="nu-seller-nid">
          <span class="lbl">رقم البطاقة (14 رقم)</span>
          <input
            id="nu-seller-nid"
            v-model="sellerNationalId"
            class="in"
            :class="{ mono: sellerNationalId !== '' }"
            :dir="sellerNationalId ? 'ltr' : 'rtl'"
            maxlength="14"
            placeholder="14 رقم"
          />
        </label>
      </div>
    </details>

    <div class="ni-preview">
      <span class="muted">الاسم اللي هيتسجل أوتوماتيك:</span>
      <strong id="nu-preview"><bdi dir="rtl">{{ preview || '—' }}</bdi></strong>
      <span class="sp"></span>
      <span class="tag">
        {{
          warrantyUsedMonths > 0
            ? `ضمان محل ${warrantyUsedMonths} شهر (من الإعدادات)`
            : 'بدون ضمان افتراضي (من الإعدادات)'
        }}
      </span>
    </div>

    <template #foot>
      <button v-if="canBack" type="button" class="btn ghost" :disabled="busy" @click="emit('back')">
        <Icon name="arrow-right" /> تغيير النوع
      </button>
      <span class="sp"></span>
      <button type="button" class="btn ghost" :disabled="busy" @click="emit('close')">إلغاء</button>
      <button
        v-if="mode !== 'tradein'"
        type="button"
        class="btn"
        data-nu-save-more
        :disabled="busy"
        @click="submit(true)"
      >
        <Icon name="plus" /> سجّل وضيف جهاز تاني
      </button>
      <button
        type="button"
        class="btn primary"
        data-nu-submit
        :disabled="busy"
        @click="submit(false)"
      >
        <Icon name="check" />
        {{ mode === 'tradein' ? 'سجّل وخصم من الفاتورة' : 'سجّل الجهاز المستعمل' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.sp {
  flex: 1;
}
.used-mode-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  padding: 10px 12px;
  margin-bottom: 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-m);
  background: var(--surface-2);
}
.field {
  margin-bottom: 12px;
}
.lbl b {
  color: var(--danger-text);
}
.row2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.row3 {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 10px;
}
.chip.add {
  border-style: dashed;
}
.inline-new {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.imei-inline {
  display: flex;
  gap: 8px;
}
.imei-status-line,
.imei-report-mini {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
}
.tag.ok {
  background: var(--ok-soft);
  color: var(--ok-text);
}
.tag.err-tag {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.tag.warn-tag {
  background: var(--warn-soft, var(--surface-2));
  color: var(--warn-text, var(--text));
}
.margin-banner {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  margin-bottom: 12px;
  border-radius: var(--r-s);
  background: var(--surface-2);
  font-size: var(--fs-sm);
}
.ok-txt {
  color: var(--ok-text);
}
.err-txt {
  color: var(--danger-text);
}
.seller-details {
  margin: 8px 0 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-m);
  background: var(--surface-2);
}
.seller-details summary {
  cursor: pointer;
  font-weight: 700;
  font-size: var(--fs-sm);
}
.seller-grid {
  margin-top: 10px;
}
.ni-preview {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding: 10px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-m);
  background: var(--surface-2);
}
.err {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--danger-border);
  border-radius: var(--r-s);
  background: var(--danger-soft);
  color: var(--danger-text);
  font-weight: 600;
}
</style>
