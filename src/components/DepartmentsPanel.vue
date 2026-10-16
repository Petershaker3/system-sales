<script setup lang="ts">
// Department classification panel — the first screen that makes migration0004
// writable (SP-1b, `plan` Task 11).
//
// `ManageDepartments` needs no re-authentication: naming a classification is
// routine work (`spec:210`). Hiding this panel from a sales user matches the
// enforced rule (`Permission::ManageDepartments`), it is not the rule itself —
// the backend refuses regardless of what the DOM offers.
//
// Two sections on purpose. Live departments carry the arrows (up/down) and the
// archive; archived ones only the restore — the backend refuses to move an
// archived row, so the sent sequence is exactly the live list as displayed.

import { computed, ref } from 'vue';

import * as api from '../api/departments';
import { describeError } from '../api/errors';
import type { CostMethod, Department } from '../api/departments';

const departments = ref<Department[]>([]);
const busy = ref(false);
const error = ref('');

const activeDepartments = computed(() =>
  departments.value.filter((department) => department.status === 'active'),
);
const archivedDepartments = computed(() =>
  departments.value.filter((department) => department.status === 'archived'),
);

async function load(): Promise<void> {
  busy.value = true;
  try {
    departments.value = await api.listDepartments();
    error.value = '';
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- create / edit ---------------------------------------------------------
const showForm = ref(false);
const editingId = ref<string | null>(null);
const editingSortOrder = ref(0);
const formName = ref('');
const formCostMethod = ref<CostMethod>('moving_average');
const formVatEnabled = ref(false);
const formVatRate = ref(''); // percent as typed; '' = no rate
const formVatInclusive = ref(false);

function resetForm(): void {
  editingId.value = null;
  editingSortOrder.value = nextSortOrder();
  formName.value = '';
  formCostMethod.value = 'moving_average';
  formVatEnabled.value = false;
  formVatRate.value = '';
  formVatInclusive.value = false;
}

/** The button's three faces: edit → cancel edit, closed → open, open → close. */
function toggleForm(): void {
  if (editingId.value !== null || showForm.value) {
    showForm.value = false;
    resetForm();
    error.value = '';
  } else {
    resetForm();
    showForm.value = true;
    error.value = '';
  }
}

/** One past the largest stored position, so a new department lands last. */
function nextSortOrder(): number {
  const orders = departments.value.map((department) => department.sortOrder);
  return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

function startEdit(department: Department): void {
  editingId.value = department.id;
  editingSortOrder.value = department.sortOrder;
  formName.value = department.name;
  formCostMethod.value = department.costMethod;
  formVatEnabled.value = department.vat.enabled;
  formVatRate.value =
    department.vat.rateBp === null ? '' : String(department.vat.rateBp / 100);
  formVatInclusive.value = department.vat.inclusive;
  showForm.value = true;
  error.value = '';
}

/** The percent input becomes basis points; '' stays "no rate". */
function parseVatRateBp(): { ok: true; value: number | null } | { ok: false } {
  const raw = formVatRate.value.trim();
  if (raw === '') return { ok: true, value: null };
  const percent = Number(raw);
  if (!Number.isFinite(percent) || percent < 0) return { ok: false };
  return { ok: true, value: Math.round(percent * 100) };
}

async function submit(): Promise<void> {
  const rate = parseVatRateBp();
  if (!rate.ok) {
    error.value = 'نسبة ضريبة القيمة المضافة غير صالحة.';
    return;
  }
  // The backend refuses this combination (`DEPARTMENT_VAT_RATE_REQUIRED`);
  // saying so here spares the operator a round trip for a known rule.
  if (formVatEnabled.value && rate.value === null) {
    error.value = 'فعّل الضريبة يتطلب نسبة مئوية.';
    return;
  }

  busy.value = true;
  try {
    const input = {
      name: formName.value,
      costMethod: formCostMethod.value,
      vatEnabled: formVatEnabled.value,
      vatRateBp: rate.value,
      vatInclusive: formVatInclusive.value,
      sortOrder: editingId.value === null ? nextSortOrder() : editingSortOrder.value,
    };
    if (editingId.value === null) {
      await api.createDepartment(input);
    } else {
      await api.updateDepartment(editingId.value, input);
    }
    error.value = '';
    showForm.value = false;
    resetForm();
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- archive / restore -----------------------------------------------------
async function toggleArchive(department: Department): Promise<void> {
  busy.value = true;
  try {
    await api.setDepartmentArchived(department.id, department.status === 'active');
    if (editingId.value === department.id) resetForm();
    error.value = '';
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- ordering --------------------------------------------------------------
async function move(department: Department, direction: -1 | 1): Promise<void> {
  const ids = activeDepartments.value.map((live) => live.id);
  const index = ids.indexOf(department.id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return;
  const first = ids[index];
  const second = ids[target];
  if (first === undefined || second === undefined) return;
  ids[index] = second;
  ids[target] = first;

  busy.value = true;
  try {
    await api.reorderDepartments(ids);
    error.value = '';
    await load();
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

// --- labels ----------------------------------------------------------------
function costMethodLabel(costMethod: CostMethod): string {
  return costMethod === 'fifo' ? 'وارد أولاً يخرج أولاً' : 'متوسط التكلفة المتحرك';
}

function vatLabel(department: Department): string {
  if (!department.vat.enabled) return 'بدون ضريبة';
  const rate = department.vat.rateBp === null ? '؟' : String(department.vat.rateBp / 100);
  return department.vat.inclusive ? `ضريبة ${rate}% (شاملة)` : `ضريبة ${rate}% (منفصلة)`;
}

resetForm();
void load();
</script>

<template>
  <section class="departments">
    <h2 class="dept-title">الأقسام</h2>

    <p v-if="departments.length === 0 && !busy" class="hint">لا توجد أقسام بعد.</p>

    <ul v-else class="list">
      <li v-for="department in activeDepartments" :key="department.id" class="item">
        <div class="item-main">
          <span class="item-name">{{ department.name }}</span>
          <span class="hint">
            {{ costMethodLabel(department.costMethod) }} · {{ vatLabel(department) }}
          </span>
        </div>
        <div class="row">
          <button
            type="button"
            :disabled="busy"
            title="لأعلى"
            @click="move(department, -1)"
          >
            ↑
          </button>
          <button
            type="button"
            :disabled="busy"
            title="لأسفل"
            @click="move(department, 1)"
          >
            ↓
          </button>
          <button type="button" :disabled="busy" @click="startEdit(department)">
            تعديل
          </button>
          <button type="button" :disabled="busy" @click="toggleArchive(department)">
            أرشفة
          </button>
        </div>
      </li>
    </ul>

    <div v-if="archivedDepartments.length > 0" class="archived-block">
      <h3 class="archived-title">مؤرشفة</h3>
      <ul class="list">
        <li v-for="department in archivedDepartments" :key="department.id" class="item">
          <div class="item-main">
            <span class="item-name archived-name">{{ department.name }}</span>
            <span class="hint">مؤرشفة</span>
          </div>
          <div class="row">
            <button type="button" :disabled="busy" @click="toggleArchive(department)">
              استعادة
            </button>
          </div>
        </li>
      </ul>
    </div>

    <div class="row">
      <button type="button" :disabled="busy" @click="toggleForm">
        {{
          editingId !== null
            ? 'إلغاء التعديل'
            : showForm
              ? 'إغلاق'
              : 'إضافة قسم'
        }}
      </button>
      <button type="button" :disabled="busy" @click="load">تحديث</button>
    </div>

    <form v-if="showForm" class="form" @submit.prevent="submit">
      <label class="field">
        <span>اسم القسم</span>
        <input v-model="formName" required autocomplete="off" />
      </label>

      <!--
        The costing method is deliberately NOT editable here.

        As of SP-2 the method is live arithmetic, and switching it has to convert
        the stock that already exists — seed a FIFO layer from the current
        average, or collapse the layers into a moving-average total. An ordinary
        edit cannot do that, so offering the choice here produced a control that
        could only ever be refused (`DEPARTMENT_COST_METHOD_REQUIRES_SWITCH`).
        The current method is displayed read-only, and the switch lives in
        `StockPanel` where the conversion and its two gates are visible.
      -->
      <div class="readonly-method">
        <span class="readonly-label">طريقة حساب التكلفة</span>
        <span>{{ costMethodLabel(formCostMethod) }}</span>
        <span class="hint">تُغيَّر من لوحة «المخزون والتكلفة» لأن التحويل يحوّل المخزون القائم.</span>
      </div>

      <label class="field">
        <span>نسبة الضريبة (%)</span>
        <input
          v-model="formVatRate"
          inputmode="decimal"
          autocomplete="off"
          placeholder="اتركها فارغة إذا لا ضريبة"
        />
      </label>

      <label class="check">
        <input v-model="formVatEnabled" type="checkbox" />
        <span>الضريبة مفعّلة على هذا القسم</span>
      </label>
      <label class="check">
        <input v-model="formVatInclusive" type="checkbox" :disabled="!formVatEnabled" />
        <span>السعر المعروض شامل الضريبة</span>
      </label>

      <button type="submit" :disabled="busy">
        {{ editingId === null ? 'إضافة' : 'حفظ' }}
      </button>
    </form>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
/* Minimal, matching UserManagement.vue. */
.departments {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #ddd;
}
.dept-title {
  font-size: 1.05rem;
  margin: 0 0 0.75rem;
}
.archived-block {
  margin-top: 1rem;
}
.archived-title {
  font-size: 0.95rem;
  margin: 0 0 0.5rem;
  color: #555;
}
.archived-name {
  color: #777;
}
.list {
  list-style: none;
  margin: 0 0 1rem;
  padding: 0;
}
.item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0;
  border-bottom: 1px solid #eee;
  flex-wrap: wrap;
}
.item-main {
  display: flex;
  flex-direction: column;
}
.item-name {
  font-weight: 600;
}
.row {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}
.form {
  margin: 1rem 0;
  padding: 0.75rem;
  border: 1px solid #ddd;
}
.check {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.readonly-method {
  margin-bottom: 0.9rem;
  padding: 0.5rem 0.6rem;
  border: 1px dashed #ccc;
}
.readonly-label {
  display: block;
  margin-bottom: 0.25rem;
}
</style>
