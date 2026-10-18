<script setup lang="ts">
// Modal for recording drawer expenses (`expenses`) and cash movements
// (`cash_movements`: `owner_draw` / `cash_in`) during an open shift
// (Plan item 1.9, `ADR-024`, `docs/PLAN.md` §12).
import { computed, ref } from 'vue';

import { describeError } from '../api/errors';
import {
  recordCashMovement,
  recordExpense,
  type CashMovementKind,
  type ShiftSummary,
} from '../api/shift';
import { DEFAULT_EXPENSE_CATEGORIES } from '../screens/pos/shift';
import { fmtTime, money, parseMoney } from '../ui/format';
import Icon from '../ui/Icon.vue';
import Modal from '../ui/Modal.vue';
import { toast } from '../ui/toast';

const props = defineProps<{
  openShift: ShiftSummary;
}>();

const emit = defineEmits<{
  close: [];
  updated: [summary: ShiftSummary];
}>();

const activeTab = ref<'expense' | 'movement'>('expense');
const busy = ref(false);

// Expense form state
const expenseCategory = ref<string>(DEFAULT_EXPENSE_CATEGORIES[0]);
const expenseAmountText = ref('');
const expenseNote = ref('');

// Cash movement form state
const movementKind = ref<CashMovementKind>('owner_draw');
const movementAmountText = ref('');
const movementReason = ref('سحب المالك');

function selectMovementKind(kind: CashMovementKind): void {
  movementKind.value = kind;
  if (
    movementReason.value.trim() === '' ||
    movementReason.value === 'سحب المالك' ||
    movementReason.value === 'فكة للدرج'
  ) {
    movementReason.value = kind === 'owner_draw' ? 'سحب المالك' : 'فكة للدرج';
  }
}

async function submitExpense(): Promise<void> {
  if (busy.value) return;
  const cat = expenseCategory.value.trim();
  if (!cat) {
    toast('اختار أو اكتب بند المصروف الأول', 'err');
    return;
  }
  const amountMinor = parseMoney(expenseAmountText.value);
  if (amountMinor === null || amountMinor <= 0) {
    toast('اكتب مبلغ المصروف بشكل صحيح', 'err');
    return;
  }
  busy.value = true;
  try {
    const updated = await recordExpense(
      cat,
      amountMinor,
      expenseNote.value.trim() || null
    );
    expenseAmountText.value = '';
    expenseNote.value = '';
    emit('updated', updated);
    toast(`تم تسجيل مصروف (${cat}) بمبلغ ${money(amountMinor)}`, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function submitMovement(): Promise<void> {
  if (busy.value) return;
  const amountMinor = parseMoney(movementAmountText.value);
  if (amountMinor === null || amountMinor <= 0) {
    toast('اكتب المبلغ بشكل صحيح', 'err');
    return;
  }
  const reason =
    movementReason.value.trim() ||
    (movementKind.value === 'owner_draw' ? 'سحب المالك' : 'فكة للدرج');
  busy.value = true;
  try {
    const updated = await recordCashMovement(movementKind.value, amountMinor, reason);
    movementAmountText.value = '';
    emit('updated', updated);
    toast(
      movementKind.value === 'owner_draw'
        ? `تم تسجيل سحب المالك بمبلغ ${money(amountMinor)}`
        : `تم تسجيل إيداع بالدرج بمبلغ ${money(amountMinor)}`,
      'ok'
    );
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

interface LedgerItem {
  readonly id: string;
  readonly kindLabel: string;
  readonly title: string;
  readonly sub: string | null;
  readonly sign: '+' | '−';
  readonly amountMinor: number;
  readonly createdAt: number;
}

const ledgerItems = computed<LedgerItem[]>(() => {
  const expItems: LedgerItem[] = props.openShift.expenses.map((e) => ({
    id: `exp-${e.id}`,
    kindLabel: 'مصروف',
    title: e.category,
    sub: e.note,
    sign: '−',
    amountMinor: e.amountMinor,
    createdAt: e.createdAt,
  }));
  const movItems: LedgerItem[] = props.openShift.cashMovements.map((m) => ({
    id: `mov-${m.id}`,
    kindLabel: m.kind === 'owner_draw' ? 'سحب المالك' : 'إيداع بالدرج',
    title: m.reason,
    sub: null,
    sign: m.kind === 'owner_draw' ? '−' : '+',
    amountMinor: m.amountMinor,
    createdAt: m.createdAt,
  }));
  return [...expItems, ...movItems].sort((a, b) => b.createdAt - a.createdAt);
});
</script>

<template>
  <Modal
    :title="`مصروفات وحركة الدرج — وردية #${openShift.shift.shiftNumber}`"
    sub="سجّل أي مصروف خرج من الدرج أو سحب للمالك أو فكة دخلت الدرج عشان التقفيل يطابق بالملليم"
    size="md"
    @close="emit('close')"
  >
    <div data-drawer-expense-modal>
      <div
        class="row"
        style="
          justify-content: space-between;
          padding: 10px 12px;
          border-radius: 10px;
          background: var(--surface-2);
          margin-bottom: 12px;
          gap: 10px;
          flex-wrap: wrap;
        "
      >
        <div>
          <small class="muted">المتوقع في الدرج دلوقتي</small>
          <div class="num" style="font-size: 18px; font-weight: 800" data-drawer-expected-cash>
            {{ money(openShift.totals.expectedCashMinor) }}
          </div>
        </div>
        <div>
          <small class="muted">مصروفات الوردية</small>
          <div class="num" style="font-weight: 700" data-drawer-expenses-total>
            {{ money(openShift.totals.expensesMinor) }}
          </div>
        </div>
        <div>
          <small class="muted">سحب المالك</small>
          <div class="num" style="font-weight: 700" data-drawer-owner-draw-total>
            {{ money(openShift.totals.ownerDrawMinor) }}
          </div>
        </div>
      </div>

      <div class="seg" role="tablist" style="width: 100%; margin-bottom: 12px">
        <button
          type="button"
          class="seg-b"
          style="flex: 1"
          :class="{ on: activeTab === 'expense' }"
          data-drawer-tab="expense"
          @click="activeTab = 'expense'"
        >
          <Icon name="receipt" /> تسجيل مصروف من الدرج
        </button>
        <button
          type="button"
          class="seg-b"
          style="flex: 1"
          :class="{ on: activeTab === 'movement' }"
          data-drawer-tab="movement"
          @click="activeTab = 'movement'"
        >
          <Icon name="wallet" /> سحب المالك / إيداع فكة
        </button>
      </div>

      <form v-if="activeTab === 'expense'" @submit.prevent="submitExpense">
        <div class="field">
          <label class="lbl">بند المصروف</label>
          <div class="chips" style="margin-bottom: 6px">
            <button
              v-for="cat in DEFAULT_EXPENSE_CATEGORIES"
              :key="cat"
              type="button"
              class="chip"
              :class="{ on: expenseCategory === cat }"
              :data-expense-chip="cat"
              @click="expenseCategory = cat"
            >
              {{ cat }}
            </button>
          </div>
          <input
            v-model="expenseCategory"
            class="in"
            placeholder="مثلًا: شاي وضيافة، مواصلات، أكياس..."
            data-expense-category
          />
        </div>

        <div class="row" style="gap: 10px; margin-top: 10px; align-items: flex-end">
          <div class="field" style="flex: 1">
            <label class="lbl">المبلغ (ج.م)</label>
            <input
              v-model="expenseAmountText"
              class="in"
              :class="{ mono: expenseAmountText !== '' }"
              :dir="expenseAmountText ? 'ltr' : 'rtl'"
              inputmode="decimal"
              placeholder="0"
              data-expense-amount
            />
          </div>
          <div class="chips" style="padding-bottom: 4px">
            <button
              v-for="amt in ['20', '50', '100', '200']"
              :key="amt"
              type="button"
              class="chip num"
              :data-expense-quick="amt"
              @click="expenseAmountText = amt"
            >
              {{ amt }} ج
            </button>
          </div>
        </div>

        <div class="field" style="margin-top: 10px">
          <label class="lbl">ملاحظة (اختياري)</label>
          <input
            v-model="expenseNote"
            class="in"
            placeholder="تفاصيل إضافية لو محتاج..."
            data-expense-note
          />
        </div>

        <div class="row" style="justify-content: flex-end; margin-top: 12px">
          <button
            type="submit"
            class="btn primary"
            :disabled="busy"
            data-expense-submit
          >
            <Icon name="plus" /> تسجيل المصروف من الدرج
          </button>
        </div>
      </form>

      <form v-else @submit.prevent="submitMovement">
        <div class="field">
          <label class="lbl">نوع الحركة</label>
          <div class="seg" style="width: 100%">
            <button
              type="button"
              class="seg-b"
              style="flex: 1"
              :class="{ on: movementKind === 'owner_draw' }"
              data-movement-kind="owner_draw"
              @click="selectMovementKind('owner_draw')"
            >
              سحب المالك (يخرج من الدرج)
            </button>
            <button
              type="button"
              class="seg-b"
              style="flex: 1"
              :class="{ on: movementKind === 'cash_in' }"
              data-movement-kind="cash_in"
              @click="selectMovementKind('cash_in')"
            >
              إيداع فكة (يدخل الدرج)
            </button>
          </div>
        </div>

        <div class="row" style="gap: 10px; margin-top: 10px; align-items: flex-end">
          <div class="field" style="flex: 1">
            <label class="lbl">المبلغ (ج.م)</label>
            <input
              v-model="movementAmountText"
              class="in"
              :class="{ mono: movementAmountText !== '' }"
              :dir="movementAmountText ? 'ltr' : 'rtl'"
              inputmode="decimal"
              placeholder="0"
              data-movement-amount
            />
          </div>
          <div class="chips" style="padding-bottom: 4px">
            <button
              v-for="amt in ['100', '200', '500', '1000']"
              :key="amt"
              type="button"
              class="chip num"
              :data-movement-quick="amt"
              @click="movementAmountText = amt"
            >
              {{ amt }} ج
            </button>
          </div>
        </div>

        <div class="field" style="margin-top: 10px">
          <label class="lbl">السبب / البيان</label>
          <input
            v-model="movementReason"
            class="in"
            placeholder="مثلًا: سحب المالك أو فكة للدرج"
            data-movement-reason
          />
        </div>

        <div class="row" style="justify-content: flex-end; margin-top: 12px">
          <button
            type="submit"
            class="btn primary"
            :disabled="busy"
            data-movement-submit
          >
            <Icon name="check" /> تسجيل حركة الدرج
          </button>
        </div>
      </form>

      <div style="margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px">
        <div class="lbl" style="margin-bottom: 8px">
          سجل حركات الدرج والمصروفات في الوردية دي ({{ ledgerItems.length }})
        </div>
        <div
          v-if="ledgerItems.length === 0"
          class="muted"
          style="font-size: 13px; text-align: center; padding: 10px"
        >
          مفيش مصروفات أو سحب متسجّل في الوردية دي لسه.
        </div>
        <div
          v-else
          data-shift-ledger-list
          style="display: flex; flex-direction: column; gap: 6px; max-height: 180px; overflow-y: auto"
        >
          <div
            v-for="item in ledgerItems"
            :key="item.id"
            class="row"
            data-shift-ledger-row
            style="
              justify-content: space-between;
              padding: 7px 10px;
              border-radius: 8px;
              background: var(--surface-2);
              font-size: 13px;
            "
          >
            <div>
              <b>{{ item.title }}</b>
              <span class="tag" style="margin-inline-start: 6px">{{ item.kindLabel }}</span>
              <small v-if="item.sub" class="muted" style="display: block">{{ item.sub }}</small>
            </div>
            <div class="row" style="gap: 8px">
              <small class="muted num">{{ fmtTime(new Date(item.createdAt)) }}</small>
              <b class="num">{{ item.sign }} {{ money(item.amountMinor) }}</b>
            </div>
          </div>
        </div>
      </div>
    </div>

    <template #foot>
      <button type="button" class="btn" data-drawer-close @click="emit('close')">
        إغلاق
      </button>
    </template>
  </Modal>
</template>
