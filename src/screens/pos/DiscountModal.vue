<script setup lang="ts">
// F3 / discount button: line or invoice discount in EGP or %, with seller
// limit check and owner PIN approval (`docs/ui/mockup-v1/pos.js`, `ADR-021`).
import { computed, ref, watch } from 'vue';

import { requestOwnerApproval } from '../../shell/approval';
import { appearance, discountLimitPctNum } from '../../ui/appearance';
import { money, parseCount, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import {
  computeDiscountMinor,
  discountExceedsSellerLimit,
  discountSummary,
   type Invoice,
  lineDiscountMinor,
  lineGrossMinor,
} from './cart';

const props = defineProps<{
  invoice: Invoice;
  selectedLineIndex: number;
  initialScope?: 'invoice' | 'line';
}>();

const emit = defineEmits<{
  close: [];
  applyLine: [lineIndex: number, discountMinor: number];
  applyInvoice: [discountMinor: number];
}>();

const selectedLine = computed(() =>
  props.selectedLineIndex >= 0
    ? (props.invoice.lines[props.selectedLineIndex] ?? null)
    : null
);

const scope = ref<'invoice' | 'line'>(
  props.initialScope === 'line' && selectedLine.value !== null
    ? 'line'
    : 'invoice'
);
const mode = ref<'amount' | 'percent'>('amount');
const valueText = ref('');
const error = ref('');
const busy = ref(false);

const summary = computed(() => discountSummary(props.invoice));

const currentTargetDiscountMinor = computed(() => {
  if (scope.value === 'line' && selectedLine.value) {
    return lineDiscountMinor(selectedLine.value);
  }
  return summary.value.invoiceDiscountMinor;
});

function syncInitialInput(): void {
  error.value = '';
  mode.value = 'amount';
  const current = currentTargetDiscountMinor.value;
  if (current > 0) {
    const egp = current / 100;
    valueText.value = Number.isInteger(egp) ? String(egp) : String(egp);
  } else {
    valueText.value = '';
  }
}

syncInitialInput();

watch(scope, () => {
  syncInitialInput();
});

const baseMinor = computed(() => {
  if (scope.value === 'line' && selectedLine.value) {
    return lineGrossMinor(selectedLine.value);
  }
  return summary.value.linesNetSubtotalMinor;
});

const parsedMinor = computed<number | null>(() => {
  const raw = valueText.value.trim();
  if (raw === '' || raw === '0') return 0;
  if (mode.value === 'amount') {
    const m = parseMoney(raw);
    if (m === null) return null;
    return computeDiscountMinor(baseMinor.value, 'amount', m);
  }
  const pct = parseCount(raw);
  if (pct === null) return null;
  return computeDiscountMinor(baseMinor.value, 'percent', pct);
});

const projectedTotalDiscountMinor = computed<number>(() => {
  const targetDisc = parsedMinor.value ?? 0;
  if (scope.value === 'line' && selectedLine.value) {
    const otherLinesDisc =
      summary.value.linesDiscountMinor - lineDiscountMinor(selectedLine.value);
    const newLinesNet =
      summary.value.grossSubtotalMinor - (otherLinesDisc + targetDisc);
    const clampedInvDisc = Math.min(
      newLinesNet,
      summary.value.invoiceDiscountMinor
    );
    return otherLinesDisc + targetDisc + clampedInvDisc;
  }
  return summary.value.linesDiscountMinor + targetDisc;
});

const limitPct = computed(() =>
  discountLimitPctNum(appearance.discountLimitPct)
);

const exceedsLimit = computed(() =>
  discountExceedsSellerLimit(
    summary.value.grossSubtotalMinor,
    projectedTotalDiscountMinor.value,
    limitPct.value
  )
);

const effectivePctText = computed(() => {
  const gross = summary.value.grossSubtotalMinor;
  if (gross <= 0) return '0%';
  const pct = (projectedTotalDiscountMinor.value * 100) / gross;
  return `${pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1)}%`;
});

function pickQuickPercent(pct: number): void {
  mode.value = 'percent';
  valueText.value = String(pct);
  error.value = '';
}

async function apply(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  const disc = parsedMinor.value;
  if (disc === null) {
    error.value =
      mode.value === 'amount'
        ? `اكتب مبلغ خصم صحيح لا يزيد عن ${money(baseMinor.value)}`
        : 'اكتب نسبة خصم صحيحة بين 0 و 100%';
    return;
  }

  if (exceedsLimit.value && disc > 0) {
    busy.value = true;
    try {
      const approved = await requestOwnerApproval(
        `خصم ${money(projectedTotalDiscountMinor.value)} (${effectivePctText.value}) فوق حد البيّاع (${limitPct.value}%)`
      );
      if (!approved) return;
    } finally {
      busy.value = false;
    }
  }

  if (scope.value === 'line' && selectedLine.value) {
    emit('applyLine', props.selectedLineIndex, disc);
  } else {
    emit('applyInvoice', disc);
  }
}

function clearDiscount(): void {
  if (scope.value === 'line' && selectedLine.value) {
    emit('applyLine', props.selectedLineIndex, 0);
  } else {
    emit('applyInvoice', 0);
  }
}
</script>

<template>
  <Modal
    title="خصم"
    :sub="
      scope === 'line' && selectedLine
        ? `على الصنف: ${selectedLine.name}`
        : 'على الفاتورة كلها'
    "
    size="sm"
    :closable="!busy"
    @close="emit('close')"
  >
    <form class="stack" @submit.prevent="apply" @keydown.enter.prevent="apply">
      <div
        v-if="selectedLine"
        class="seg"
        role="group"
        aria-label="نطاق الخصم"
      >
        <button
          id="discount-scope-invoice"
          type="button"
          class="seg-b"
          :class="{ on: scope === 'invoice' }"
          @click="scope = 'invoice'"
        >
          على الفاتورة
        </button>
        <button
          id="discount-scope-line"
          type="button"
          class="seg-b"
          :class="{ on: scope === 'line' }"
          @click="scope = 'line'"
        >
          على الصنف المحدد
        </button>
      </div>

      <div class="seg" role="group" aria-label="نوع الخصم">
        <button
          id="discount-mode-amount"
          type="button"
          class="seg-b"
          :class="{ on: mode === 'amount' }"
          @click="
            mode = 'amount';
            valueText = '';
            error = '';
          "
        >
          مبلغ (ج.م)
        </button>
        <button
          id="discount-mode-percent"
          type="button"
          class="seg-b"
          :class="{ on: mode === 'percent' }"
          @click="
            mode = 'percent';
            valueText = '';
            error = '';
          "
        >
          نسبة (%)
        </button>
      </div>

      <div class="chips" style="gap: 6px">
        <button
          v-for="pct in [5, 10, 15, 20]"
          :id="`discount-quick-pct-${pct}`"
          :key="pct"
          type="button"
          class="chip"
          :class="{
            active: mode === 'percent' && valueText.trim() === String(pct),
          }"
          @click="pickQuickPercent(pct)"
        >
          {{ pct }}%
        </button>
      </div>

      <div class="field">
        <label for="discount-value-input">
          {{
            mode === 'amount'
              ? `قيمة الخصم بالجنيه (الحد الأقصى ${money(baseMinor)})`
              : 'نسبة الخصم المئوية (0 إلى 100%)'
          }}
        </label>
        <input
          id="discount-value-input"
          v-model="valueText"
          class="big-in num"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0"
          data-autofocus
        />
      </div>

      <div class="due-box">
        <div class="r">
          <span>{{
            scope === 'line' ? 'إجمالي الصنف قبل الخصم' : 'صافي الأصناف'
          }}</span>
          <span class="num">{{ money(baseMinor) }}</span>
        </div>
        <div class="r">
          <span>قيمة الخصم ({{ effectivePctText }} من الفاتورة)</span>
          <span class="num">- {{ money(parsedMinor ?? 0) }}</span>
        </div>
        <div class="r grand">
          <span>الصافي بعد الخصم</span>
          <span class="num">{{
            money(Math.max(0, baseMinor - (parsedMinor ?? 0)))
          }}</span>
        </div>
      </div>

      <div
        v-if="exceedsLimit && (parsedMinor ?? 0) > 0"
        id="discount-limit-warning"
        class="note"
      >
        <Icon name="lock" />
        <span>
          إجمالي الخصم ({{ effectivePctText }}) معدي حد البيّاع ({{
            limitPct
          }}%) — هيطلب <b>PIN المالك</b> للموافقة.
        </span>
      </div>

      <div v-if="error" class="err-msg">{{ error }}</div>
    </form>

    <template #foot>
      <button
        id="discount-apply-btn"
        type="button"
        class="btn primary"
        :disabled="busy"
        @click="apply"
      >
        <Icon v-if="exceedsLimit && (parsedMinor ?? 0) > 0" name="lock" />
        {{
          exceedsLimit && (parsedMinor ?? 0) > 0
            ? 'موافقة المالك وتطبيق الخصم'
            : 'تطبيق الخصم'
        }}
        <kbd>Enter</kbd>
      </button>
      <button
        v-if="currentTargetDiscountMinor > 0"
        id="discount-clear-btn"
        type="button"
        class="btn"
        :disabled="busy"
        @click="clearDiscount"
      >
        شيل الخصم
      </button>
      <button
        type="button"
        class="btn ghost"
        :disabled="busy"
        @click="emit('close')"
      >
        رجوع
      </button>
    </template>
  </Modal>
</template>
