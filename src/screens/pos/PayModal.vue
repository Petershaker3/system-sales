<script setup lang="ts">
// Paying (`docs/ui/mockup-v1/pos.js`, «الدفع»; `ADR-020`, `docs/PLAN.md` §8).
// Supports cash, wallets (`vf`), InstaPay (`instapay`), optional card (`card`),
// instalments (`install`), credit (`credit` / آجل with customer balance), and
// split payments across multiple methods in a single atomic transaction.
import { computed, nextTick, ref, watch } from 'vue';

import type { Customer } from '../../api/customer';
import { describeError } from '../../api/errors';
import * as salesApi from '../../api/sales';
import type { SaleOutcome } from '../../api/sales';
import {
  appearance,
  enabledPayMethods,
  INSTALLMENT_PROVIDERS,
  isPayMethodEnabled,
  PAY_METHODS,
  type PayMethodId,
} from '../../ui/appearance';
import { dg, money, num, parseMoney, pcsWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';
import { changeDue } from './cart';
import type { CartLine } from './cart';
import {
  cashSuggestions,
  type DraftPayment,
  methodLabel,
  paidSoFar,
  paymentsSummaryText,
  remainingDue,
} from './payments';

const props = defineProps<{
  lines: readonly CartLine[];
  totalMinor: number;
  count: number;
  selectedCustomer?: Customer | null;
}>();

const emit = defineEmits<{
  close: [];
  paid: [outcome: SaleOutcome];
  priceChanged: [];
  openCustomerPicker: [];
}>();

const method = ref<PayMethodId>('cash');
const splitPayments = ref<DraftPayment[]>([]);
const cashText = ref('');
const nonCashAmountText = ref('');
const referenceText = ref('');
const installProvider = ref<string>(INSTALLMENT_PROVIDERS[0] ?? 'valU');
const customerName = ref('');
const busy = ref(false);
const error = ref('');
const done = ref<{
  outcome: SaleOutcome;
  changeMinor: number;
  summary: string;
} | null>(null);
const finishButton = ref<HTMLButtonElement | null>(null);

const visibleMethods = computed(() =>
  enabledPayMethods(appearance.payMethods)
);

watch(
  () => appearance.payMethods,
  (raw) => {
    if (!isPayMethodEnabled(method.value, raw)) {
      method.value = 'cash';
    }
  }
);

const currentMethodMeta = computed(
  () =>
    PAY_METHODS.find((m) => m.id === method.value) ?? PAY_METHODS[0]!
);

const paidMinor = computed(() => paidSoFar(splitPayments.value));
const dueMinor = computed(() =>
  remainingDue(props.totalMinor, splitPayments.value)
);

const cashMinor = computed(() =>
  cashText.value.trim() === '' ? dueMinor.value : parseMoney(cashText.value)
);
const change = computed(() =>
  cashMinor.value === null ? null : changeDue(dueMinor.value, cashMinor.value)
);

const nonCashMinor = computed(() =>
  nonCashAmountText.value.trim() === ''
    ? dueMinor.value
    : parseMoney(nonCashAmountText.value)
);

const suggestions = computed(() => cashSuggestions(dueMinor.value));

const canAddSplitPart = computed(() => {
  if (dueMinor.value <= 0) return false;
  if (method.value === 'cash') {
    return (
      cashMinor.value !== null &&
      cashMinor.value > 0 &&
      cashMinor.value < dueMinor.value
    );
  }
  return (
    nonCashMinor.value !== null &&
    nonCashMinor.value > 0 &&
    nonCashMinor.value < dueMinor.value
  );
});

const splitPartMinor = computed(() => {
  if (method.value === 'cash') return cashMinor.value ?? 0;
  return nonCashMinor.value ?? 0;
});

const creditInSplitMinor = computed(() =>
  splitPayments.value
    .filter((p) => p.method === 'credit')
    .reduce((sum, p) => sum + p.amountMinor, 0)
);

const projectedCreditAddedMinor = computed(() => {
  const activeCredit =
    method.value === 'credit' && dueMinor.value > 0
      ? (nonCashMinor.value ?? dueMinor.value)
      : 0;
  return creditInSplitMinor.value + Math.max(0, activeCredit);
});

function buildReferenceFor(m: PayMethodId): string | null {
  const refTrimmed = referenceText.value.trim();
  if (m === 'install') {
    const provider = installProvider.value.trim() || 'valU';
    return refTrimmed ? `${provider} - ${refTrimmed}` : provider;
  }
  return refTrimmed === '' ? null : refTrimmed;
}

function selectMethod(next: PayMethodId): void {
  method.value = next;
  error.value = '';
}

function addSplitPayment(): void {
  error.value = '';
  const amount = splitPartMinor.value;
  if (amount <= 0 || amount >= dueMinor.value) return;
  if (method.value === 'credit' && !props.selectedCustomer) {
    error.value = 'اختار عميل الأول عشان تضيف جزء آجل';
    return;
  }
  splitPayments.value.push({
    method: method.value,
    amountMinor: amount,
    reference: buildReferenceFor(method.value),
  });
  cashText.value = '';
  nonCashAmountText.value = '';
  referenceText.value = '';

  const nextMethod = visibleMethods.value.find((m) => m.id !== method.value);
  if (nextMethod) {
    method.value = nextMethod.id;
  }
}

function removeSplitAt(index: number): void {
  splitPayments.value.splice(index, 1);
  error.value = '';
}

function iconOfMethod(id: PayMethodId) {
  return PAY_METHODS.find((m) => m.id === id)?.icon ?? 'banknote';
}

async function pay(): Promise<void> {
  if (busy.value || done.value !== null) return;
  error.value = '';

  const finalPayments: DraftPayment[] = [...splitPayments.value];
  let cashChangeMinor = 0;

  if (dueMinor.value > 0) {
    if (method.value === 'cash') {
      if (cashMinor.value === null) {
        error.value = 'اكتب المبلغ بالجنيه، زي 150 أو 150.5';
        return;
      }
      if (change.value === null) {
        error.value = `المبلغ أقل من المطلوب بـ ${money(dueMinor.value - cashMinor.value)} (أو دوس «دفع جزئي» لتقسيم الفاتورة)`;
        return;
      }
      cashChangeMinor = change.value;
      finalPayments.push({
        method: 'cash',
        amountMinor: dueMinor.value,
        reference: null,
      });
    } else {
      if (nonCashMinor.value === null || nonCashMinor.value <= 0) {
        error.value = 'اكتب المبلغ بالجنيه أكبر من صفر';
        return;
      }
      if (nonCashMinor.value < dueMinor.value) {
        error.value = `المبلغ أقل من المتبقي (${money(dueMinor.value)}) — دوس «دفع جزئي» الأول عشان تقسّم الباقي`;
        return;
      }
      if (nonCashMinor.value > dueMinor.value) {
        error.value = `المبلغ أكبر من المتبقي (${money(dueMinor.value)})`;
        return;
      }
      finalPayments.push({
        method: method.value,
        amountMinor: dueMinor.value,
        reference: buildReferenceFor(method.value),
      });
    }
  }

  const hasCredit = finalPayments.some((p) => p.method === 'credit');
  if (hasCredit && !props.selectedCustomer) {
    error.value = 'البيع الآجل لازم يتربط بعميل متسجّل';
    return;
  }

  busy.value = true;
  try {
    const outcome = await salesApi.recordSale(
      props.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        imei: line.imei ?? null,
      })),
      props.totalMinor,
      finalPayments,
      props.selectedCustomer?.id ?? null
    );
    if (!props.selectedCustomer) {
      const name = customerName.value.trim();
      if (name !== '') {
        try {
          await salesApi.setSaleCustomerName(outcome.saleId, name);
        } catch (err) {
          toast(
            `الفاتورة اتسجّلت، بس اسم العميل ماتسجّلش: ${describeError(err)}`,
            'err',
            5000
          );
        }
      }
    }
    done.value = {
      outcome,
      changeMinor: cashChangeMinor,
      summary: paymentsSummaryText(finalPayments),
    };
    await nextTick();
    finishButton.value?.focus({ preventScroll: true });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'SALE_PRICE_CHANGED') {
      emit('priceChanged');
      emit('close');
      return;
    }
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

function finish(): void {
  if (done.value !== null) emit('paid', done.value.outcome);
  emit('close');
}

function onEnter(): void {
  if (done.value !== null) finish();
  else void pay();
}
</script>

<template>
  <Modal
    :title="done ? 'تم البيع' : 'الدفع'"
    :sub="
      done
        ? done.summary
        : `${currentMethodMeta.name} · ${pcsWord(count)}`
    "
    size="md"
    :closable="!busy"
    @close="done ? finish() : emit('close')"
  >
    <form
      v-if="!done"
      class="stack"
      @submit.prevent="onEnter"
      @keydown.enter.prevent="onEnter"
    >
      <div class="due-box">
        <div class="r">
          <span>الإجمالي ({{ pcsWord(count) }})</span>
          <span class="num">{{ money(totalMinor) }}</span>
        </div>
        <div v-if="paidMinor > 0" class="r">
          <span>مدفوع حتى الآن</span>
          <span class="num">{{ money(paidMinor) }}</span>
        </div>
        <div class="r grand">
          <span>{{ paidMinor > 0 ? 'المتبقي' : 'المطلوب' }}</span>
          <span class="num">{{ money(dueMinor) }}</span>
        </div>
      </div>

      <div v-if="splitPayments.length > 0" class="split-box stack" style="gap: 6px">
        <small class="muted">دفعات مقسّمة متسجّلة في الفاتورة:</small>
        <div
          v-for="(sp, idx) in splitPayments"
          :key="idx"
          class="paid-item"
          :data-split-method="sp.method"
        >
          <Icon :name="iconOfMethod(sp.method)" />
          <span>{{ methodLabel(sp.method, sp.reference) }}</span>
          <span class="sp" />
          <b class="num">{{ money(sp.amountMinor) }}</b>
          <button
            type="button"
            class="icon-btn xs danger"
            title="شيل الدفعة دي"
            @click="removeSplitAt(idx)"
          >
            <Icon name="x" />
          </button>
        </div>
      </div>

      <div class="methods" role="group" aria-label="طرق الدفع">
        <button
          v-for="m in visibleMethods"
          :key="m.id"
          type="button"
          class="method"
          :class="{ on: method === m.id }"
          :data-method="m.id"
          @click="selectMethod(m.id)"
        >
          <Icon :name="m.icon" />
          <span>{{ m.name }}</span>
        </button>
      </div>

      <template v-if="dueMinor > 0">
        <template v-if="method === 'cash'">
          <div class="field">
            <label for="cash-in">استلمت كام؟ (فاضي = المبلغ بالظبط)</label>
            <input
              id="cash-in"
              v-model="cashText"
              class="big-in num"
              inputmode="decimal"
              autocomplete="off"
              :placeholder="num(dueMinor / 100)"
              data-autofocus
            />
          </div>
          <div class="sugs">
            <button
              v-for="s in suggestions"
              :key="s"
              type="button"
              class="chip"
              @click="cashText = String(s / 100)"
            >
              {{ s === dueMinor ? 'بالظبط' : money(s) }}
            </button>
          </div>
          <div v-if="change !== null" class="change-box">
            <span>الباقي للعميل</span>
            <b class="num">{{ money(change) }}</b>
          </div>
          <div v-else-if="cashMinor !== null" class="change-box short">
            <span>ناقص</span>
            <b class="num">{{ money(dueMinor - cashMinor) }}</b>
          </div>
        </template>

        <template v-else-if="method === 'install'">
          <div class="field">
            <span class="label">شركة التقسيط</span>
            <div class="sugs">
              <button
                v-for="prov in INSTALLMENT_PROVIDERS"
                :key="prov"
                type="button"
                class="chip"
                :class="{ on: installProvider === prov }"
                :data-provider="prov"
                @click="installProvider = prov"
              >
                <bdi dir="auto">{{ prov }}</bdi>
              </button>
            </div>
          </div>
          <div class="grid2">
            <div class="field">
              <label for="noncash-amount-in">المبلغ بالتقسيط (فاضي = المتبقي كله)</label>
              <input
                id="noncash-amount-in"
                v-model="nonCashAmountText"
                class="num"
                inputmode="decimal"
                autocomplete="off"
                :placeholder="num(dueMinor / 100)"
              />
            </div>
            <div class="field">
              <label for="pay-ref-in">رقم المعاملة / الموافقة (اختياري)</label>
              <input
                id="pay-ref-in"
                v-model="referenceText"
                :class="{ mono: referenceText !== '' }"
                :dir="referenceText ? 'ltr' : 'rtl'"
                autocomplete="off"
                maxlength="80"
                placeholder="مثال: 994412"
              />
            </div>
          </div>
        </template>

        <template v-else-if="method === 'credit'">
          <div v-if="!selectedCustomer" class="note warn" data-credit-needs-customer>
            <Icon name="triangle-alert" />
            <div class="stack" style="gap: 8px; flex: 1">
              <span>البيع الآجل محتاج عميل متسجّل عشان يتسجّل المبلغ على حسابه ويظهر رصيده.</span>
              <button
                id="pick-credit-customer-btn"
                type="button"
                class="btn primary sm"
                style="justify-self: start"
                @click="emit('openCustomerPicker')"
              >
                <Icon name="user-plus" /> اختار أو سجّل عميل للآجل
              </button>
            </div>
          </div>
          <div v-else class="due-box" data-credit-customer-summary>
            <div class="r">
              <span><Icon name="user" /> العميل: <b>{{ selectedCustomer.name }}</b></span>
              <button
                type="button"
                class="btn sm ghost"
                @click="emit('openCustomerPicker')"
              >
                تغيير العميل
              </button>
            </div>
            <div class="r">
              <span>رصيده الآجل الحالي</span>
              <b class="num">{{ money(selectedCustomer.balanceMinor) }}</b>
            </div>
            <div class="r grand">
              <span>رصيده بعد الفاتورة</span>
              <b class="num">{{ money(selectedCustomer.balanceMinor + projectedCreditAddedMinor) }}</b>
            </div>
          </div>
          <div class="field">
            <label for="noncash-amount-in">المبلغ الآجل (فاضي = المتبقي كله)</label>
            <input
              id="noncash-amount-in"
              v-model="nonCashAmountText"
              class="num"
              inputmode="decimal"
              autocomplete="off"
              :placeholder="num(dueMinor / 100)"
            />
          </div>
        </template>

        <template v-else>
          <div class="grid2">
            <div class="field">
              <label for="noncash-amount-in">
                المبلغ بـ {{ currentMethodMeta.name }} (فاضي = المتبقي كله)
              </label>
              <input
                id="noncash-amount-in"
                v-model="nonCashAmountText"
                class="num"
                inputmode="decimal"
                autocomplete="off"
                :placeholder="num(dueMinor / 100)"
              />
            </div>
            <div class="field">
              <label for="pay-ref-in">رقم العملية / مرجع التحويل (اختياري)</label>
              <input
                id="pay-ref-in"
                v-model="referenceText"
                :class="{ mono: referenceText !== '' }"
                :dir="referenceText ? 'ltr' : 'rtl'"
                autocomplete="off"
                maxlength="100"
                placeholder="آخر 4 أرقام أو مرجع العملية"
              />
            </div>
          </div>
        </template>

        <button
          v-if="canAddSplitPart"
          id="add-split-payment-btn"
          type="button"
          class="btn soft block"
          @click="addSplitPayment"
        >
          <Icon name="plus" /> دفع جزئي بـ {{ currentMethodMeta.name }} ({{ money(splitPartMinor) }}) والباقي بطريقة تانية
        </button>
      </template>

      <div v-if="!selectedCustomer" class="field">
        <label for="cust-in">اسم العميل (اختياري — أو اختار عميل متسجّل بـ F4)</label>
        <div class="row" style="gap: 8px">
          <input
            id="cust-in"
            v-model="customerName"
            style="flex: 1"
            autocomplete="off"
            maxlength="120"
            placeholder="للضمان والمرتجع"
          />
          <button
            type="button"
            class="btn"
            title="اختار عميل متسجّل"
            @click="emit('openCustomerPicker')"
          >
            <Icon name="user" /> عميل مسجّل
          </button>
        </div>
      </div>
      <div v-else-if="method !== 'credit'" class="paid-item">
        <Icon name="user" />
        <span>العميل: <b>{{ selectedCustomer.name }}</b></span>
        <span v-if="selectedCustomer.balanceMinor > 0" class="tag warn num">
          عليه {{ money(selectedCustomer.balanceMinor) }} آجل
        </span>
        <span class="sp" />
        <button
          type="button"
          class="btn xs ghost"
          @click="emit('openCustomerPicker')"
        >
          تغيير
        </button>
      </div>

      <div class="err-msg" role="alert">{{ error }}</div>
    </form>

    <div v-else class="stack">
      <div class="done-hero">
        <Icon name="circle-check" />
        <div class="done-t">
          <b>اتسجّلت الفاتورة</b>
          <bdi dir="ltr" class="mono ref">{{ dg(done.outcome.reference) }}</bdi>
          <span class="muted">{{ money(done.outcome.totalMinor) }} · {{ done.summary }}</span>
        </div>
      </div>
      <div class="change-box">
        <span>الباقي للعميل</span>
        <b class="num">{{ money(done.changeMinor) }}</b>
      </div>
    </div>

    <template #foot>
      <template v-if="!done">
        <button
          id="confirm-pay-btn"
          type="button"
          class="btn primary lg"
          :disabled="busy || (method === 'credit' && !selectedCustomer)"
          @click="pay"
        >
          <Icon name="check" /> تم الدفع <kbd>Enter</kbd>
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
      <button
        v-else
        ref="finishButton"
        type="button"
        class="btn primary lg"
        @click="finish"
      >
        <Icon name="plus" /> فاتورة جديدة <kbd>Enter</kbd>
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.done-t {
  display: grid;
  gap: 2px;
}
.done-t b {
  font-size: 1.15rem;
}
.done-t .ref {
  font-size: 0.95rem;
  justify-self: start;
}
</style>
