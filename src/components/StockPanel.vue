<script setup lang="ts">
// Stock and costing panel (SP-2, `ADR-013`, `ADR-015`).
//
// Three use cases, and the panel's job is to make the *costing rule* visible
// rather than to compute anything:
//
//   - receive: add units at a known unit cost. Routine.
//   - remove:  consume units and show what they cost. Routine.
//   - switch:  change a department's costing method. Sensitive.
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
// The panel renders `effectiveCostMinor`, never a locally divided average. Under
// Moving Average that figure is ceilinged by `domain/costing`; recomputing it in
// TypeScript would produce a second, different rounding rule — the exact drift
// `ADR-013` exists to prevent.
//
// # Why switching is a separate action
//
// The ordinary department edit refuses a costing-method change, because
// relabelling a department without converting its stock would claim a cost the
// stock does not have. This panel is therefore the *only* place the method can
// change, which is why it asks for confirmation rather than offering a dropdown
// in the edit form.

import { computed, ref } from 'vue';

import * as catalog from '../api/catalog';
import * as departments from '../api/departments';
import * as inventory from '../api/inventory';
import * as lifecycle from '../api/lifecycle';
import { describeError } from '../api/errors';
import PatternPrompt from './PatternPrompt.vue';
import type { Product } from '../api/catalog';
import type { CostMethod, Department } from '../api/departments';
import type { StockPosition } from '../api/inventory';

// --- product and department pickers ----------------------------------------

const products = ref<Product[]>([]);
const depts = ref<Department[]>([]);

const selectedProductId = ref('');
const selectedDepartmentId = ref('');

// --- movement forms --------------------------------------------------------

const receiveQuantity = ref('');
/**
 * Who delivered this lot (decision D1): a label the operator types, optional.
 * There is no supplier registry and no purchase document — the shop's supplier
 * list is read back off the receipts themselves.
 */
const receiveSupplier = ref('');
const receiveUnitCost = ref('');
const removeQuantity = ref('');
const error = ref('');
const notice = ref('');
const busy = ref(false);

const selectedProduct = computed(
  () => products.value.find((product) => product.id === selectedProductId.value) ?? null
);

async function loadPickers(): Promise<void> {
  busy.value = true;
  try {
    const [listed, allDepartments] = await Promise.all([
      catalog.listProducts('active'),
      departments.listDepartments(),
    ]);
    products.value = listed;
    depts.value = allDepartments.filter((department) => department.status === 'active');
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- the read-only position ------------------------------------------------

const position = ref<StockPosition | null>(null);
const showReauth = ref(false);
const reauthPassword = ref('');

/**
 * Load the position, asking for the password first.
 *
 * `withReauth` is the same shape `SettingsPanel` uses: the password is proven
 * once, the operation runs, and the field is cleared either way.
 */
async function withReauth(action: () => Promise<void>): Promise<void> {
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

async function loadPosition(): Promise<void> {
  if (selectedProductId.value === '') {
    error.value = 'اختر منتجًا أولًا.';
    return;
  }
  position.value = await inventory.getPosition(selectedProductId.value);
}

async function refreshPosition(): Promise<void> {
  if (selectedProductId.value === '' || position.value === null) return;
  try {
    position.value = await inventory.getPosition(selectedProductId.value);
  } catch {
    // The panel still shows what it has; a stale position is better than a
    // cleared screen, and the next explicit load reports any real problem.
  }
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

  busy.value = true;
  notice.value = '';
  try {
    const outcome = await inventory.receiveStock(
      selectedProductId.value,
      quantity,
      unitCost,
      receiveSupplier.value.trim()
    );
    notice.value = `تم الاستلام. الرصيد الآن ${outcome.quantity}.`;
    receiveQuantity.value = '';
    receiveUnitCost.value = '';
    // The supplier is cleared with the rest of the delivery: the next delivery is
    // usually from somebody else, and a stale label would be a false record.
    receiveSupplier.value = '';
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

// --- the costing-method switch --------------------------------------------

const showSwitch = ref(false);
const switchTarget = ref<CostMethod>('moving_average');
const switchPassword = ref('');

function startSwitch(): void {
  const department = depts.value.find((entry) => entry.id === selectedDepartmentId.value);
  if (department === undefined) return;
  // Offer the method it is not: switching to what it already uses does nothing.
  switchTarget.value =
    department.costMethod === 'fifo' ? 'moving_average' : 'fifo';
  switchPassword.value = '';
  error.value = '';
  notice.value = '';
  showSwitch.value = true;
}

const showPattern = ref(false);

function afterPatternVerified(): void {
  showPattern.value = false;
  // Assurance is still raised from the password a moment ago, so this only has
  // to retry the switch. Re-authenticating again would ask for a password the
  // operator has already given for this very operation.
  void performSwitch();
}

/**
 * The switch itself, with the assurance level already raised.
 *
 * A Pattern refusal is not an error to display: it means the operation needs one
 * more step, so the prompt opens instead. Any other failure is reported where it
 * happened.
 */
async function performSwitch(): Promise<void> {
  busy.value = true;
  try {
    await inventory.switchCostMethod(selectedDepartmentId.value, switchTarget.value);
    showSwitch.value = false;
    notice.value = 'تم تغيير طريقة التكلفة وتحويل المخزون القائم.';
    error.value = '';
    await loadPickers();
    await refreshPosition();
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'PATTERN_REQUIRED' || code === 'PATTERN_APPROVAL_STALE') {
      showPattern.value = true;
      return;
    }
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

/**
 * Prove the Manager password, then switch.
 *
 * The two steps stay separate because they answer different questions: the
 * password establishes *who*, the Pattern establishes *freshness*. Rust decides
 * whether the Pattern is needed at all, so the panel asks only when it is told to.
 */
async function confirmSwitch(): Promise<void> {
  busy.value = true;
  try {
    await lifecycle.reauthenticate(switchPassword.value);
    switchPassword.value = '';
    await performSwitch();
  } catch (err) {
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

function costMethodLabel(method: CostMethod): string {
  return method === 'fifo' ? 'وارد أولاً يخرج أولاً (FIFO)' : 'المتوسط المرجح المتحرك';
}

function positionAuthorityLabel(current: StockPosition): string {
  return current.costMethod === 'fifo'
    ? 'الطبقات هي المرجع للتكلفة'
    : 'إجمالي التكلفة هو المرجع';
}

void loadPickers();
</script>

<template>
  <section class="stock">
    <h2 class="stock-title">المخزون والتكلفة</h2>

    <!-- Product picker -->
    <label class="field">
      <span>المنتج</span>
      <select v-model="selectedProductId">
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
        عرض المخزون
      </button>
    </div>

    <div v-else class="position">
      <h3 class="position-title">{{ selectedProduct?.name ?? 'المخزون' }}</h3>
      <dl class="facts">
        <dt>الرصيد</dt>
        <dd>{{ position.quantity }}</dd>
        <dt>طريقة التكلفة</dt>
        <dd>{{ costMethodLabel(position.costMethod) }}</dd>
        <dt>{{ positionAuthorityLabel(position) }}</dt>
        <dd>{{ formatPiastres(position.effectiveCostMinor) }}</dd>
      </dl>

      <!-- Layers are read-only: a layer is a fact about a past receipt. -->
      <div v-if="position.layers.length > 0" class="layers">
        <h4 class="layers-title">طبقات FIFO</h4>
        <ul class="layer-list">
          <li v-for="(layer, index) in position.layers" :key="index" class="layer">
            <span>الطبقة {{ index + 1 }} (الأقدم أولًا)</span>
            <span>{{ layer.quantity }} × {{ formatPiastres(layer.unitCostMinor) }}</span>
          </li>
        </ul>
        <p class="hint">
          الطبقات للقراءة فقط. oldest-first هو ترتيب الخصم، والعنصر المنفَق يحتفظ بسعره.
        </p>
      </div>

      <!-- Receive -->
      <form class="form" @submit.prevent="submitReceive">
        <h4 class="form-title">استلام توريد</h4>
        <label class="field">
          <span>الكمية</span>
          <input v-model="receiveQuantity" inputmode="numeric" autocomplete="off" />
        </label>
        <label class="field">
          <span>سعر الوحدة (قرش)</span>
          <input v-model="receiveUnitCost" inputmode="numeric" autocomplete="off" />
        </label>
        <label class="field">
          <span>المورد (اختياري)</span>
          <input
            v-model="receiveSupplier"
            autocomplete="off"
            maxlength="120"
            placeholder="اسم من كتبته"
          />
        </label>
        <p class="hint">
          المورد اسم تكتبه أنت على التوريد نفسه. سيبه فاضي لو مش عارف.
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

    <!-- The costing-method switch -->
    <div class="switch-block">
      <h3 class="switch-title">طريقة حساب التكلفة</h3>
      <label class="field">
        <span>القسم</span>
        <select v-model="selectedDepartmentId">
          <option value="">— اختر قسمًا —</option>
          <option v-for="department in depts" :key="department.id" :value="department.id">
            {{ department.name }} — {{ costMethodLabel(department.costMethod) }}
          </option>
        </select>
      </label>
      <p class="hint">
        تغيير الطريقة يحوّل المخزون القائم لهذا القسم: من المتوسط المرجح إلى FIFO تُبذر
        طبقة واحدة، والعكس يطوي الطبقات في إجمالي. عملية حساسة تحتاج تأكيد الهوية والنمط.
      </p>
      <button
        type="button"
        :disabled="busy || selectedDepartmentId === ''"
        @click="startSwitch"
      >
        تبديل طريقة التكلفة
      </button>
    </div>

    <p v-if="notice" class="notice">{{ notice }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>

    <!-- Step-up prompt: permissionless by design, so no re-auth in front of it. -->
    <PatternPrompt :visible="showPattern" @verified="afterPatternVerified" @cancelled="showPattern = false" />

    <!-- Switch confirmation: the Manager password is re-proved here on purpose. -->
    <div v-if="showSwitch" class="overlay">
      <form class="modal" @submit.prevent="confirmSwitch">
        <h3 class="modal-title">تبديل طريقة التكلفة</h3>
        <p class="hint">
          سيصبح المرجع {{ costMethodLabel(switchTarget) }} وسيُحوَّل مخزون هذا القسم القائم.
        </p>
        <label class="field">
          <span>كلمة مرور المدير</span>
          <input v-model="switchPassword" type="password" autocomplete="current-password" required />
        </label>
        <div class="row">
          <button type="submit" :disabled="busy">تأكيد</button>
          <button type="button" :disabled="busy" @click="showSwitch = false">إلغاء</button>
        </div>
      </form>
    </div>

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
/* Minimal, matching DepartmentsPanel. */
.stock {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #ddd;
}
.stock-title {
  font-size: 1.05rem;
  margin: 0 0 1rem;
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
.layers {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 1px solid #eee;
}
.layers-title {
  font-size: 0.95rem;
  margin: 0 0 0.5rem;
}
.layer-list {
  list-style: none;
  margin: 0 0 0.5rem;
  padding: 0;
}
.layer {
  display: flex;
  justify-content: space-between;
  padding: 0.25rem 0;
  border-bottom: 1px solid #f0f0f0;
}
.form {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 1px solid #ddd;
}
.form-title {
  font-size: 0.95rem;
  margin: 0 0 0.5rem;
}
.switch-block {
  margin-top: 1.5rem;
  padding-top: 1rem;
  border-top: 1px solid #eee;
}
.switch-title {
  font-size: 1rem;
  margin: 0 0 0.5rem;
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