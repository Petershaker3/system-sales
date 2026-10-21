<script setup lang="ts">
// «المصاريف» — the shop's own spending, in one list (`ADR-043`).
//
// Two kinds of money share this screen because they are one question to the owner:
// what left the shop this month? Whether it came out of the till during a shift or
// out of their own pocket at the landlord's door, the section records it, totals it,
// and says which is which. A drawer expense still reduces that shift's expected cash
// — the accounting did not move, the place you read it from did.
//
// Nothing here is editable. Every row is a movement of money, and a movement that can
// be rewritten after the fact is a number nobody can audit (`ADR-024`).

import { computed, onMounted, ref } from 'vue';

import { describeError } from '../../api/errors';
import {
  expensesOverview,
  recordShopExpense,
  type ExpenseOverview,
  type ExpenseRow,
  type PaidFrom,
} from '../../api/expenses';
import type { Session } from '../../api/identity';
import { dg, money, moneyInputValue, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import {
  addFixedExpense,
  categorySharePercent,
  drawerAvailabilityNote,
  effectivePaidFrom,
  expensePeriodBounds,
  EXPENSE_PERIODS,
  FIXED_EXPENSES_KEY,
  fixedExpenseProblem,
  type FixedExpense,
  paidFromLabel,
  parseFixedExpenses,
  removeFixedExpense,
  serializeFixedExpenses,
  suggestedCategories,
  topCategory,
  type ExpensePeriodKey,
} from './expenses';

const props = defineProps<{
  session: Session;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const overview = ref<ExpenseOverview | null>(null);
const period = ref<ExpensePeriodKey>('month');
const loading = ref(true);
const saving = ref(false);

const category = ref('');
const amountText = ref('');
const noteText = ref('');
const chosenPaidFrom = ref<PaidFrom>('outside');

/** The bills pinned on this device — see `./expenses.ts` (`FixedExpense`). */
const fixedExpenses = ref<FixedExpense[]>([]);

const openShiftId = computed<string | null>(() => overview.value?.openShiftId ?? null);
const rows = computed<readonly ExpenseRow[]>(() => overview.value?.rows ?? []);
const totals = computed(() => ({
  total: overview.value?.totalMinor ?? 0,
  drawer: overview.value?.drawerMinor ?? 0,
  outside: overview.value?.outsideMinor ?? 0,
  count: overview.value?.count ?? 0,
}));
const byCategory = computed(() => overview.value?.byCategory ?? []);
const best = computed(() => topCategory(byCategory.value));
const chips = computed(() =>
  suggestedCategories(overview.value?.knownCategories ?? []).slice(0, 12)
);
const paidFrom = computed<PaidFrom>(() =>
  effectivePaidFrom(openShiftId.value, chosenPaidFrom.value)
);
const periodLabel = computed<string>(
  () => EXPENSE_PERIODS.find((p) => p.k === period.value)?.label ?? ''
);

function isOwner(): boolean {
  return props.session.role === 'manager';
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    const bounds = expensePeriodBounds(period.value);
    overview.value = await expensesOverview(bounds.fromMs, bounds.toMs);
  } catch (error) {
    toast(describeError(error), 'err');
  } finally {
    loading.value = false;
  }
}

async function selectPeriod(next: ExpensePeriodKey): Promise<void> {
  if (period.value === next) return;
  period.value = next;
  await load();
}

function pickCategory(value: string): void {
  category.value = value;
}

async function submitExpense(): Promise<void> {
  if (saving.value) return;
  const label = category.value.trim();
  if (label === '') {
    toast('اكتب اسم البند الأول', 'err');
    return;
  }
  const amountMinor = parseMoney(amountText.value);
  if (amountMinor === null || amountMinor <= 0) {
    toast('اكتب المبلغ بشكل صحيح', 'err');
    return;
  }
  saving.value = true;
  try {
    await recordShopExpense(label, amountMinor, noteText.value.trim() || null, paidFrom.value);
    // The new row may fall outside the window on screen (a «النهارده» filter and a row
    // written just before midnight); the reload is the truth either way.
    await load();
    amountText.value = '';
    noteText.value = '';
    toast(`اتسجل مصروف «${label}» بمبلغ ${money(amountMinor)}`, 'ok');
    emit('changed');
  } catch (error) {
    toast(describeError(error), 'err');
  } finally {
    saving.value = false;
  }
}

function fmtDay(ms: number): string {
  const date = new Date(ms);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;
  return `${day}/${month} · ${time}`;
}

// --- The pinned bills (owner request 2026-10-21) ------------------------------

function loadFixedExpenses(): void {
  try {
    fixedExpenses.value = parseFixedExpenses(window.localStorage.getItem(FIXED_EXPENSES_KEY));
  } catch {
    fixedExpenses.value = [];
  }
}

function saveFixedExpenses(next: FixedExpense[]): void {
  fixedExpenses.value = next;
  try {
    window.localStorage.setItem(FIXED_EXPENSES_KEY, serializeFixedExpenses(next));
  } catch {
    // Private mode or a full disk: the pins stay for this visit only.
  }
}

/** Pin whatever the form holds right now as a bill that repeats. */
function pinCurrentExpense(): void {
  const label = category.value.trim();
  const amountMinor = parseMoney(amountText.value);
  const problem = fixedExpenseProblem(label, amountMinor);
  if (problem !== '' || amountMinor === null) {
    toast(problem === '' ? 'اكتب المبلغ بشكل صحيح' : problem, 'err');
    return;
  }
  const entry: FixedExpense = {
    id: `fx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    category: label,
    amountMinor,
    note: noteText.value.trim() || null,
    paidFrom: paidFrom.value,
  };
  const before = fixedExpenses.value.length;
  const next = addFixedExpense(fixedExpenses.value, entry);
  saveFixedExpenses(next);
  toast(
    next.length === before
      ? `«${label}» مثبّتة بالفعل بنفس المبلغ`
      : `ثبّتّ «${label}» — من البنود الثابتة تسجلها بضغطة واحدة`,
    'ok'
  );
}

/** Pour a pinned bill back into the form — to edit it before recording. */
function fillFromFixed(entry: FixedExpense): void {
  category.value = entry.category;
  amountText.value = moneyInputValue(entry.amountMinor);
  noteText.value = entry.note ?? '';
  chosenPaidFrom.value = entry.paidFrom;
}

/** One tap: the pinned bill becomes an ordinary audited expense row. */
async function recordFixed(entry: FixedExpense): Promise<void> {
  if (saving.value) return;
  saving.value = true;
  try {
    await recordShopExpense(
      entry.category,
      entry.amountMinor,
      entry.note,
      effectivePaidFrom(openShiftId.value, entry.paidFrom)
    );
    await load();
    toast(`اتسجل مصروف «${entry.category}» بمبلغ ${money(entry.amountMinor)}`, 'ok');
    emit('changed');
  } catch (error) {
    toast(describeError(error), 'err');
  } finally {
    saving.value = false;
  }
}

function unpinFixed(entry: FixedExpense): void {
  saveFixedExpenses(removeFixedExpense(fixedExpenses.value, entry.id));
}

onMounted(() => {
  loadFixedExpenses();
  void load();
});
</script>

<template>
  <div class="page" data-expenses-screen>
    <div class="page-h" style="justify-content: space-between; flex-wrap: wrap; gap: 10px">
      <div>
        <h2>المصاريف</h2>
        <p class="sub">كل اللي خرج من المحل في الفترة دي — من الدرج ومن برّاه — في قايمة واحدة.</p>
      </div>
      <div class="seg" role="tablist" aria-label="فترة المصاريف">
        <button
          v-for="p in EXPENSE_PERIODS"
          :key="p.k"
          type="button"
          :class="{ active: period === p.k }"
          :data-expenses-period="p.k"
          @click="selectPeriod(p.k)"
        >
          {{ p.label }}
        </button>
      </div>
    </div>

    <!-- The three numbers the current window adds up to. -->
    <div class="cards" data-expenses-totals>
      <div class="card">
        <div class="muted" style="font-size: 0.85rem">إجمالي المصاريف</div>
        <div class="num" style="font-size: 1.45rem; font-weight: 700" data-expenses-total>
          {{ money(totals.total) }}
        </div>
        <div class="muted" style="font-size: 0.8rem">{{ dg(totals.count) }} حركة في الفترة</div>
      </div>
      <div class="card">
        <div class="muted" style="font-size: 0.85rem">من الدرج</div>
        <div class="num" style="font-size: 1.45rem; font-weight: 700" data-expenses-drawer>
          {{ money(totals.drawer) }}
        </div>
        <div class="muted" style="font-size: 0.8rem">بتخصم من متوقع الدرج في الوردية</div>
      </div>
      <div class="card">
        <div class="muted" style="font-size: 0.85rem">من برّه الدرج</div>
        <div class="num" style="font-size: 1.45rem; font-weight: 700" data-expenses-outside>
          {{ money(totals.outside) }}
        </div>
        <div class="muted" style="font-size: 0.8rem">مدفوعة من جيب المالك أو حساب تاني</div>
      </div>
    </div>

    <div class="exp-grid">
      <!-- Recording one. -->
      <section class="card" data-expenses-form>
        <h3 style="margin-top: 0">سجّل مصروف</h3>

        <label class="field">
          <span>البند</span>
          <input
            v-model="category"
            type="text"
            maxlength="80"
            placeholder="مثال: إيجار المحل"
            data-expenses-category
          />
        </label>
        <div class="row" style="gap: 6px; flex-wrap: wrap; margin: 8px 0 12px">
          <button
            v-for="chip in chips"
            :key="chip"
            type="button"
            class="chip"
            :class="{ active: category === chip }"
            :data-expenses-chip="chip"
            @click="pickCategory(chip)"
          >
            {{ chip }}
          </button>
        </div>

        <label class="field">
          <span>المبلغ (جنيه)</span>
          <input
            v-model="amountText"
            type="text"
            inputmode="decimal"
            placeholder="0"
            data-expenses-amount
          />
        </label>
        <label class="field">
          <span>ملاحظة (اختياري)</span>
          <input
            v-model="noteText"
            type="text"
            maxlength="300"
            placeholder="مثال: إيجار شهر أكتوبر — دفعت لمحمد"
            data-expenses-note
          />
        </label>

        <div class="seg" role="radiogroup" aria-label="مصدر الفلوس" style="margin: 4px 0 8px">
          <button
            type="button"
            :class="{ active: paidFrom === 'outside' }"
            :disabled="openShiftId === null"
            data-expenses-paid-from="outside"
            @click="chosenPaidFrom = 'outside'"
          >
            من برّه الدرج
          </button>
          <button
            type="button"
            :class="{ active: paidFrom === 'drawer' }"
            :disabled="openShiftId === null"
            data-expenses-paid-from="drawer"
            @click="chosenPaidFrom = 'drawer'"
          >
            من الدرج
          </button>
        </div>
        <p class="muted" style="margin: 0 0 10px" data-expenses-drawer-note>
          {{ drawerAvailabilityNote(openShiftId) }}
        </p>

        <button
          type="button"
          class="btn primary"
          :disabled="saving"
          data-expenses-save
          @click="submitExpense"
        >
          <Icon name="plus" />
          {{ saving ? 'بيتسجل…' : 'سجّل المصروف' }}
        </button>
        <p class="muted" style="margin: 10px 0 0; font-size: 0.82rem">
          المصروف بيتسجل مرة واحدة ومابيتعدّلش — لو غلطت سجّل الحركة الصح واكتب في الملاحظة إنها
          تصحيح للغلطة.
        </p>
      </section>

      <!-- The bills that repeat (owner request 2026-10-21): pin the form once,
           then the same rent or electricity is one tap away. The pins live on
           this device; every tap records an ordinary audited expense row. -->
      <section class="card" data-fixed-expenses>
        <div class="row" style="justify-content: space-between; align-items: center; gap: 8px">
          <h3 style="margin: 0">البنود الثابتة</h3>
          <button
            type="button"
            class="btn sm ghost"
            data-fixed-expenses-pin
            @click="pinCurrentExpense"
          >
            <Icon name="save" /> ثبّت البند الحالي
          </button>
        </div>
        <p class="muted" style="margin: 6px 0 10px; font-size: 0.82rem">
          بند بيتكرر كل شهر؟ اكتبه في النموذج واضغط «ثبّت البند الحالي» — بعدها سجّله بضغطة واحدة،
          أو اضغط على اسمه يتملى في النموذج لو عايز تعدّل فيه الأول.
        </p>
        <p
          v-if="fixedExpenses.length === 0"
          class="muted"
          style="margin: 0"
          data-fixed-expenses-empty
        >
          لسه مفيش بنود مثبّتة.
        </p>
        <div v-else class="fixed-list">
          <div
            v-for="entry in fixedExpenses"
            :key="entry.id"
            class="fixed-row"
            :data-fixed-expense="entry.id"
          >
            <button
              type="button"
              class="fixed-info"
              :title="`املى «${entry.category}» في النموذج`"
              @click="fillFromFixed(entry)"
            >
              <b><bdi dir="auto">{{ entry.category }}</bdi></b>
              <span class="muted" style="font-size: 0.8rem">
                {{ money(entry.amountMinor) }} · {{ paidFromLabel(entry.paidFrom) }}
                <template v-if="entry.note !== null"> · <bdi dir="auto">{{ entry.note }}</bdi></template>
              </span>
            </button>
            <button
              type="button"
              class="btn sm"
              :disabled="saving"
              :data-fixed-expense-record="entry.id"
              @click="recordFixed(entry)"
            >
              <Icon name="plus" /> سجّل
            </button>
            <button
              type="button"
              class="icon-btn sm ghost"
              :data-fixed-expense-remove="entry.id"
              title="شيل التثبيت"
              aria-label="شيل التثبيت"
              @click="unpinFixed(entry)"
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
      </section>

      <!-- Where the money went. -->
      <section class="card" data-expenses-by-category>
        <div class="row" style="justify-content: space-between; align-items: baseline">
          <h3 style="margin: 0">التوزيع على البنود</h3>
          <span class="muted" style="font-size: 0.82rem">
            <template v-if="best !== null">
              أكتر بند: <b data-expenses-top-category>{{ best.category }}</b>
            </template>
            <template v-else>مفيش مصاريف في الفترة</template>
          </span>
        </div>
        <div
          v-if="byCategory.length === 0"
          class="muted"
          style="padding: 10px 0"
          data-expenses-categories-empty
        >
          لسه مفيش مصاريف متسجلة في الفترة دي.
        </div>
        <div v-for="entry in byCategory" :key="entry.category" data-expenses-cat-row>
          <div class="row" style="justify-content: space-between; align-items: baseline">
            <b>{{ entry.category }}</b>
            <span class="num">{{ money(entry.totalMinor) }}</span>
          </div>
          <div class="share-track">
            <span :style="{ width: `${categorySharePercent(totals.total, entry.totalMinor)}%` }" />
          </div>
          <small class="muted">{{ dg(entry.count) }} حركة</small>
        </div>
      </section>
    </div>

    <!-- The list. -->
    <div class="card" style="padding: 0; overflow: hidden">
      <div class="row" style="padding: 12px 16px; justify-content: space-between; align-items: baseline">
        <b>سجل المصاريف</b>
        <span class="muted" style="font-size: 0.82rem">{{ periodLabel }}</span>
      </div>

      <div v-if="loading" class="muted" style="padding: 16px">بيتحمّل…</div>
      <div v-else-if="rows.length === 0" class="muted" style="padding: 16px" data-expenses-empty>
        مفيش مصاريف في الفترة دي. أول ما تسجّل واحد هيظهر هنا على طول.
      </div>
      <div v-else class="table-wrap" style="border: 0; border-radius: 0">
        <table class="t">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>البند</th>
              <th>المصدر</th>
              <th>اللي سجّله</th>
              <th>ملاحظة</th>
              <th style="text-align: end">المبلغ</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id" data-expenses-row>
              <td class="num muted">{{ fmtDay(row.createdAt) }}</td>
              <td><b>{{ row.category }}</b></td>
              <td>
                <span class="tag" :class="row.paidFrom === 'drawer' ? 'warn' : ''">
                  {{ paidFromLabel(row.paidFrom) }}
                </span>
              </td>
              <td class="muted">{{ row.createdByName }}</td>
              <td class="muted">{{ row.note ?? '—' }}</td>
              <td class="num" style="text-align: end">{{ money(row.amountMinor) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <p v-if="!isOwner()" class="muted">
      قسم المصاريف للمالك — البيّاع بيسجّل مصاريف الدرج من شاشة الوردية.
    </p>
  </div>
</template>

<style scoped>
/* Form and breakdown side by side, one above the other on a handset. */
.exp-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr);
  gap: 14px;
  align-items: start;
}

/* The pinned bills: one quiet row per bill — tap the name to fill the form,
   «سجّل» to record it as it stands. */
.fixed-list {
  display: grid;
  gap: 6px;
}
.fixed-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
}
.fixed-info {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: start;
  color: inherit;
  font: inherit;
}
.fixed-info:hover b {
  color: var(--accent-text);
}

/* One bar per category, sized by its share of the window's spending. */
.share-track {
  height: 6px;
  border-radius: 3px;
  background: var(--surface-2);
  margin: 4px 0 2px;
  overflow: hidden;
}
.share-track span {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: var(--accent-fill);
}

@media (max-width: 900px) {
  .exp-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
