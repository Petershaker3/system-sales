<script setup lang="ts">
// Stock and costing panel (SP-2, `ADR-013`, `ADR-015`, `ADR-019`).
//
// Two use cases, and the panel's job is to show what Rust computed rather
// than to compute anything:
//
//   - receive: add units at a known unit cost (from supplier or opening stock,
//     with optional 15-digit Luhn-checked IMEIs for phones).
//   - remove:  consume units and show what they cost. Routine.
//
// Every product counted by quantity is costed by moving average (ADR-016 #7).
// FIFO and switching the method per department were retired in plan item 1.3,
// so there is nothing to choose here.
//
// # Why reading a position needs a password
//
// `get_position` returns cost figures, so it sits behind `ViewCostAndProfit`,
// which `role.rs` gates by role *and* assurance. Reading a price is not the same
// permission as moving stock, and this panel does not pretend otherwise: the
// first tap asks for the password, exactly as the settings panel does.
//
// # Why the cost shown is the one Rust returned
//
// The panel renders `effectiveCostMinor`, never a locally divided average. That
// figure is ceilinged by `domain/costing`; recomputing it in TypeScript would
// produce a second, different rounding rule — the exact drift `ADR-013` exists
// to prevent.

import { computed, ref, watch } from 'vue';

import * as catalog from '../api/catalog';
import type { Product } from '../api/catalog';
import { describeError } from '../api/errors';
import * as inventory from '../api/inventory';
import type { ProductUnit, StockPosition } from '../api/inventory';
import * as lifecycle from '../api/lifecycle';
import * as posApi from '../api/pos';
import type { PosProduct } from '../api/pos';
import { shortagesOverview } from '../api/shortages';
import { imeiLuhn, normalizeImeiDigits } from '../screens/pos/imei';
import { formatArrivedToast } from '../screens/store/shortages';
import { withOwnerApproval } from '../shell/approval';
import { skipsPasswordReauth } from '../shell/open-mode';
import { appearance } from '../ui/appearance';
import Icon from '../ui/Icon.vue';
import { toast } from '../ui/toast';

const emit = defineEmits<{ 'new-item': []; received: [productId: string] }>();

// --- product picker --------------------------------------------------------

const products = ref<Product[]>([]);
const posById = ref<Map<string, PosProduct>>(new Map());

const selectedProductId = ref('');

// --- movement forms --------------------------------------------------------

const receiptMode = ref<'supplier' | 'opening'>('supplier');
const receiveQuantity = ref('');
/**
 * Who delivered this lot (decision D1): a label the operator types, optional.
 * There is no supplier registry and no purchase document — the shop's supplier
 * list is read back off the receipts themselves.
 */
const receiveSupplier = ref('');
const receiveUnitCost = ref('');
const imeiDraft = ref('');
const receiveImeis = ref<string[]>([]);
const removeQuantity = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);

const selectedProduct = computed(
  () => products.value.find((product) => product.id === selectedProductId.value) ?? null
);

const selectedIsSerial = computed(() => {
  const p = selectedProduct.value;
  if (p === null) return false;
  if (p.disposition === 'serialized') return true;
  const posProd = posById.value.get(p.id);
  return (
    posProd !== undefined &&
    (posProd.tracking === 'serial_optional' ||
      posProd.tracking === 'serial_required' ||
      posProd.brandId !== null)
  );
});

async function loadPickers(): Promise<void> {
  busy.value = true;
  try {
    const [prods, cat] = await Promise.all([
      catalog.listProducts('active'),
      posApi.posCatalog().catch(() => null),
    ]);
    products.value = prods;
    if (cat) {
      posById.value = new Map(cat.products.map((p) => [p.id, p]));
    }
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- the read-only position ------------------------------------------------

const position = ref<StockPosition | null>(null);
const units = ref<ProductUnit[]>([]);
const showReauth = ref(false);
const reauthPassword = ref('');

/**
 * Load the position, asking for the password first.
 *
 * `withReauth` is the same shape `SettingsPanel` uses: the password is proven
 * once, the operation runs, and the field is cleared either way.
 */
async function withReauth(action: () => Promise<void>): Promise<void> {
  if (skipsPasswordReauth()) {
    // `ADR-039`: a shop that has not claimed an account has no password to prove,
    // and its session already stands at the assurance this modal exists to reach.
    // Rust decides that; this only keeps the cost column from demanding a secret the
    // shop has not got — and from refusing the read when the operator has nothing to
    // type into it.
    await action();
    return;
  }
  reauthPassword.value = '';
  error.value = '';
  showReauth.value = true;
  pendingReauth.value = action;
}

const pendingReauth = ref<(() => Promise<void>) | null>(null);

async function confirmReauth(): Promise<void> {
  const action = pendingReauth.value;
  if (action === null) return;
  busy.value = true;
  try {
    await lifecycle.reauthenticate(reauthPassword.value);
    showReauth.value = false;
    reauthPassword.value = '';
    pendingReauth.value = null;
    await action();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function loadUnits(): Promise<void> {
  if (selectedProductId.value === '' || !selectedIsSerial.value) {
    units.value = [];
    return;
  }
  try {
    units.value = await inventory.listProductUnits(selectedProductId.value);
  } catch {
    units.value = [];
  }
}

async function loadPosition(): Promise<void> {
  if (selectedProductId.value === '') {
    error.value = 'اختر منتجًا أولًا.';
    return;
  }
  position.value = await inventory.getPosition(selectedProductId.value);
  await loadUnits();
}

async function refreshPosition(): Promise<void> {
  if (selectedProductId.value === '' || position.value === null) return;
  try {
    position.value = await inventory.getPosition(selectedProductId.value);
    await loadUnits();
  } catch {
    // The panel still shows what it has; a stale position is better than a
    // cleared screen, and the next explicit load reports any real problem.
  }
}

watch(selectedProductId, async () => {
  imeiDraft.value = '';
  receiveImeis.value = [];
  error.value = '';
  notice.value = '';
  if (position.value !== null && selectedProductId.value !== '') {
    await refreshPosition();
  }
});

// --- IMEI entry on receive -------------------------------------------------

function addImeiToBatch(): void {
  const digits = normalizeImeiDigits(imeiDraft.value);
  if (digits === '') return;
  if (!/^\d{15}$/.test(digits)) {
    error.value = 'رقم الـ IMEI لازم يكون 15 رقم بالظبط.';
    return;
  }
  if (!imeiLuhn(digits)) {
    error.value = 'رقم الـ IMEI فيه رقم غلط (فحص Luhn).';
    return;
  }
  if (receiveImeis.value.includes(digits)) {
    error.value = 'الـ IMEI ده مضاف بالفعل في الدفعة دي.';
    return;
  }
  if (units.value.some((u) => u.imei === digits || u.imei2 === digits)) {
    error.value = 'الـ IMEI ده متسجّل بالفعل في المخزن.';
    return;
  }
  receiveImeis.value.push(digits);
  imeiDraft.value = '';
  error.value = '';
  const currentQty = parseNonNegativeInteger(receiveQuantity.value) ?? 0;
  if (receiveImeis.value.length > currentQty) {
    receiveQuantity.value = String(receiveImeis.value.length);
  }
}

function removeImeiFromBatch(idx: number): void {
  receiveImeis.value.splice(idx, 1);
}

// --- receive / remove ------------------------------------------------------

function parseNonNegativeInteger(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

async function submitReceive(): Promise<void> {
  const quantity = parseNonNegativeInteger(receiveQuantity.value);
  const unitCost = parseNonNegativeInteger(receiveUnitCost.value);
  if (quantity === null || quantity < 1) {
    error.value = 'الكمية يجب أن تكون عددًا صحيحًا أكبر من صفر.';
    return;
  }
  if (unitCost === null) {
    error.value = 'سعر الوحدة يجب أن يكون عددًا صحيحًا غير سالب.';
    return;
  }
  if (selectedIsSerial.value && receiveImeis.value.length > quantity) {
    error.value = 'عدد أرقام الـ IMEI أكبر من الكمية.';
    return;
  }
  if (
    selectedIsSerial.value &&
    appearance.imeiMode === 'required' &&
    receiveImeis.value.length !== quantity
  ) {
    error.value = `وضع الـ IMEI إلزامي: سجّل ${quantity} رقم IMEI قبل الحفظ.`;
    return;
  }

  busy.value = true;
  notice.value = '';
  try {
    const productId = selectedProductId.value;
    const preShortages = await shortagesOverview()
      .then((ov) => ov.items.filter((sh) => sh.productId === productId))
      .catch(() => []);
    const imeis = selectedIsSerial.value ? [...receiveImeis.value] : [];
    let outcome;
    if (receiptMode.value === 'opening') {
      const approved = await withOwnerApproval(
        () => inventory.receiveOpeningStock(productId, quantity, unitCost, imeis),
        'تسجيل بضاعة أول المدة'
      );
      if (approved.status === 'cancelled') return;
      outcome = approved.value;
    } else {
      outcome = await inventory.receiveStock(
        productId,
        quantity,
        unitCost,
        receiveSupplier.value.trim(),
        imeis
      );
    }
    notice.value = `تم الاستلام. الرصيد الآن ${outcome.quantity}.`;
    for (const sh of preShortages) {
      toast(formatArrivedToast(sh), 'ok');
    }
    emit('received', productId);
    receiveQuantity.value = '';
    receiveUnitCost.value = '';
    // The supplier is cleared with the rest of the delivery: the next delivery is
    // usually from somebody else, and a stale label would be a false record.
    receiveSupplier.value = '';
    imeiDraft.value = '';
    receiveImeis.value = [];
    error.value = '';
    await refreshPosition();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

async function submitRemove(): Promise<void> {
  const quantity = parseNonNegativeInteger(removeQuantity.value);
  if (quantity === null || quantity < 1) {
    error.value = 'الكمية يجب أن تكون عددًا صحيحًا أكبر من صفر.';
    return;
  }

  busy.value = true;
  notice.value = '';
  try {
    const outcome = await inventory.removeStock(selectedProductId.value, quantity);
    notice.value = `تم الخصم. تكلفة الكمية ${formatPiastres(outcome.costMinor)} والرصيد ${outcome.quantity}.`;
    removeQuantity.value = '';
    error.value = '';
    await refreshPosition();
  } catch (err) {
    // A refused removal changes nothing, so the position on screen is still
    // correct and there is nothing to refresh.
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- labels ----------------------------------------------------------------

/** Piastres to a readable amount. Display only; never fed back into arithmetic. */
function formatPiastres(minor: number | null): string {
  if (minor === null) return '—';
  const whole = Math.trunc(minor / 100);
  const rest = Math.abs(minor % 100);
  return `${whole}.${String(rest).padStart(2, '0')} ج.م`;
}

void loadPickers();
</script>

<template>
  <section class="stock">
    <div class="stock-head">
      <h2 class="stock-title">المخزن والتكلفة</h2>
      <span class="sp"></span>
      <button type="button" class="btn sm soft" @click="emit('new-item')">
        <Icon name="package-plus" /> صنف جديد
      </button>
    </div>

    <!-- Product picker -->
    <label class="field">
      <span>المنتج</span>
      <select id="stock-product" v-model="selectedProductId">
        <option value="">— اختر منتجًا —</option>
        <option v-for="product in products" :key="product.id" :value="product.id">
          {{ product.name }}
        </option>
      </select>
    </label>

    <!-- The position, behind a password because it reveals cost -->
    <div v-if="!position" class="gate">
      <p class="hint">
        عرض رصيد المنتج وتكلفته يتطلب تأكيد هوية المدير.
      </p>
      <button type="button" :disabled="busy || selectedProductId === ''" @click="withReauth(loadPosition)">
        عرض المخزن
      </button>
    </div>

    <div v-else class="position">
      <h3 class="position-title">{{ selectedProduct?.name ?? 'المخزن' }}</h3>
      <dl class="facts">
        <dt>الرصيد</dt>
        <dd>{{ position.quantity }}</dd>
        <dt>إجمالي التكلفة (متوسط مرجح)</dt>
        <dd>{{ formatPiastres(position.effectiveCostMinor) }}</dd>
        <template v-if="selectedIsSerial">
          <dt>أجهزة بـ IMEI مسجّل</dt>
          <dd>متسجّل {{ units.length }} من {{ position.quantity }}</dd>
        </template>
      </dl>

      <div v-if="selectedIsSerial && units.length > 0" class="units-box">
        <div class="units-head">أجهزة متسجّل ليها IMEI في المخزن ({{ units.length }})</div>
        <div class="units-chips">
          <span v-for="u in units" :key="u.id" class="unit-tag" :data-unit-imei="u.imei">
            <b class="mono" dir="ltr">{{ u.imei }}</b>
            <small v-if="u.conditionGrade" class="unit-sub">· فئة {{ u.conditionGrade }}</small>
            <small v-if="u.batteryHealthPct !== null && u.batteryHealthPct !== undefined" class="unit-sub mono" dir="ltr">
              · {{ u.batteryHealthPct }}%
            </small>
            <small v-if="u.color" class="unit-sub">· {{ u.color }}</small>
            <small v-if="u.accessories" class="unit-sub">· ({{ u.accessories }})</small>
            <small v-if="u.sellerName" class="unit-sub">· البائع: {{ u.sellerName }}</small>
          </span>
        </div>
      </div>

      <!-- Receive -->
      <form class="form" @submit.prevent="submitReceive">
        <div class="form-head">
          <h4 class="form-title">استلام بضاعة</h4>
          <div class="seg" role="group" aria-label="نوع الاستلام">
            <button
              id="stock-mode-supplier"
              type="button"
              class="seg-b"
              :class="{ on: receiptMode === 'supplier' }"
              @click="receiptMode = 'supplier'"
            >
              من مورد
            </button>
            <button
              id="stock-mode-opening"
              type="button"
              class="seg-b"
              :class="{ on: receiptMode === 'opening' }"
              @click="receiptMode = 'opening'"
            >
              بضاعة موجودة عندي (أول مرة)
            </button>
          </div>
        </div>
        <label class="field">
          <span>الكمية</span>
          <input id="stock-qty" v-model="receiveQuantity" inputmode="numeric" autocomplete="off" />
        </label>
        <label class="field">
          <span>سعر الوحدة (قرش)</span>
          <input id="stock-cost" v-model="receiveUnitCost" inputmode="numeric" autocomplete="off" />
        </label>
        <label v-if="receiptMode === 'supplier'" class="field">
          <span>المورد (اختياري)</span>
          <input
            v-model="receiveSupplier"
            autocomplete="off"
            maxlength="120"
            placeholder="اسم من كتبته"
          />
        </label>

        <div v-if="selectedIsSerial" class="imei-box">
          <div class="imei-box-head">
            <span>
              أرقام الـ IMEI ({{ appearance.imeiMode === 'required' ? 'إلزامي' : 'اختياري' }}) —
              {{ receiveImeis.length }} مضاف
            </span>
          </div>
          <div class="imei-entry-row">
            <input
              id="stock-imei-input"
              v-model="imeiDraft"
              :class="{ mono: imeiDraft !== '' }"
              :dir="imeiDraft ? 'ltr' : 'rtl'"
              inputmode="numeric"
              maxlength="17"
              autocomplete="off"
              placeholder="امسح أو اكتب 15 رقم…"
              @keydown.enter.prevent="addImeiToBatch"
            />
            <button
              id="stock-imei-add"
              type="button"
              class="btn sm soft"
              @click="addImeiToBatch"
            >
              أضف IMEI
            </button>
          </div>
          <div v-if="receiveImeis.length > 0" class="imei-chips">
            <span v-for="(im, idx) in receiveImeis" :key="im" class="imei-chip mono" dir="ltr">
              {{ im }}
              <button
                type="button"
                class="chip-x"
                title="حذف"
                @click="removeImeiFromBatch(idx)"
              >
                ×
              </button>
            </span>
          </div>
        </div>

        <p v-if="receiptMode === 'supplier'" class="hint">
          المورد اسم تكتبه أنت على التوريد نفسه. سيبه فاضي لو مش عارف.
        </p>
        <p v-else class="hint">
          بضاعة أول المدة بتدخل المخزن من غير اسم مورد ومش بتتحسب في مشتريات الموردين.
        </p>
        <button type="submit" :disabled="busy">استلام</button>
      </form>

      <!-- Remove -->
      <form class="form" @submit.prevent="submitRemove">
        <h4 class="form-title">خصم كمية</h4>
        <label class="field">
          <span>الكمية</span>
          <input v-model="removeQuantity" inputmode="numeric" autocomplete="off" />
        </label>
        <button type="submit" :disabled="busy">خصم</button>
        <p class="hint">
          يُرفض الخصم كاملًا إذا لم يتوفر رصيد كافٍ؛ لا يحدث خصم جزئي.
        </p>
      </form>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- Re-authentication for reading a cost. -->
    <div v-if="showReauth" class="overlay">
      <form class="modal" @submit.prevent="confirmReauth">
        <h3 class="modal-title">تأكيد الهوية</h3>
        <p class="hint">أدخل كلمة مرور المدير للمتابعة.</p>
        <label class="field">
          <span>كلمة المرور</span>
          <input v-model="reauthPassword" type="password" autocomplete="current-password" required autofocus />
        </label>
        <button type="submit" :disabled="busy">تأكيد</button>
      </form>
    </div>
  </section>
</template>

<style scoped>
/* Minimal, matching CatalogPanel. */
.stock {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #ddd;
}
.stock-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.stock-head .sp {
  flex: 1;
}
.stock-title {
  font-size: 1.05rem;
  margin: 0;
}
.gate {
  margin-bottom: 1rem;
}
.position {
  margin: 1rem 0;
}
.position-title {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
.facts {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1rem;
}
.units-box {
  margin: 0.75rem 0;
  padding: 0.6rem 0.75rem;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.units-head {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.4rem;
}
.units-chips,
.imei-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.unit-tag,
.imei-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  font-size: 0.82rem;
  border-radius: var(--r-sm);
  border: 1px solid var(--border);
  background: var(--surface);
}
.chip-x {
  border: none;
  background: transparent;
  color: var(--danger);
  cursor: pointer;
  padding: 0 2px;
}
.form {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 1px solid #ddd;
}
.form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  flex-wrap: wrap;
  margin-bottom: 0.5rem;
}
.form-title {
  font-size: 0.95rem;
  margin: 0;
}
.imei-box {
  margin: 0.75rem 0;
  padding: 0.6rem;
  border: 1px dashed var(--border);
  border-radius: var(--r-sm);
}
.imei-box-head {
  font-size: 0.85rem;
  font-weight: 600;
  margin-bottom: 0.4rem;
}
.imei-entry-row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.imei-entry-row input {
  flex: 1;
}
.notice {
  margin-top: 0.75rem;
  padding: 0.6rem;
  border: 1px solid #070;
  color: #070;
}
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 10;
}
.modal {
  background: #fff;
  padding: 1rem;
  max-width: 22rem;
  width: 100%;
}
.modal-title {
  font-size: 1rem;
  margin: 0 0 0.5rem;
}
.row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
</style>
