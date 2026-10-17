<script setup lang="ts">
// Paying (docs/ui/mockup-v1/pos.js, «الدفع»). Cash only in this build: the
// other methods, split payments and «آجل» wait for the payments table (plan
// item 1.5). The sale is written by `record_sale` in one transaction; the total
// shown is sent as `confirmedTotalMinor`, so a price that changed in between is
// refused rather than charged.
import { computed, nextTick, ref } from 'vue';

import { describeError } from '../../api/errors';
import * as salesApi from '../../api/sales';
import type { SaleOutcome } from '../../api/sales';
import { dg, money, num, parseMoney, pcsWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';
import { changeDue } from './cart';
import type { CartLine } from './cart';

const props = defineProps<{ lines: readonly CartLine[]; totalMinor: number; count: number }>();
const emit = defineEmits<{ close: []; paid: [outcome: SaleOutcome]; priceChanged: [] }>();

const cashText = ref('');
const customerName = ref('');
const busy = ref(false);
const error = ref('');
const done = ref<{ outcome: SaleOutcome; changeMinor: number } | null>(null);
const finishButton = ref<HTMLButtonElement | null>(null);

const cashMinor = computed(() => (cashText.value.trim() === '' ? props.totalMinor : parseMoney(cashText.value)));
const change = computed(() => (cashMinor.value === null ? null : changeDue(props.totalMinor, cashMinor.value)));

/** Quick amounts: exact, then the next round notes above the total. */
const suggestions = computed(() => {
  const total = props.totalMinor;
  const out = new Set<number>([total]);
  for (const step of [5000, 10000, 20000, 50000, 100000]) {
    const up = Math.ceil(total / step) * step;
    if (up > total) out.add(up);
    if (out.size >= 5) break;
  }
  return [...out].sort((a, b) => a - b);
});

async function pay(): Promise<void> {
  if (busy.value || done.value !== null) return;
  if (cashMinor.value === null) {
    error.value = 'اكتب المبلغ بالجنيه، زي 150 أو 150.5';
    return;
  }
  if (change.value === null) {
    error.value = `المبلغ أقل من المطلوب بـ ${money(props.totalMinor - cashMinor.value)}`;
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const outcome = await salesApi.recordSale(
      props.lines.map((line) => ({
        productId: line.productId,
        quantity: line.quantity,
        imei: line.imei ?? null,
      })),
      props.totalMinor
    );
    const name = customerName.value.trim();
    if (name !== '') {
      try {
        await salesApi.setSaleCustomerName(outcome.saleId, name);
      } catch (err) {
        // The sale is written; only the name did not stick. Say so, plainly.
        toast(`الفاتورة اتسجّلت، بس اسم العميل ماتسجّلش: ${describeError(err)}`, 'err', 5000);
      }
    }
    done.value = { outcome, changeMinor: change.value ?? 0 };
    // The form is gone; Enter now means «فاتورة جديدة».
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
    :sub="done ? 'كاش' : `كاش · ${pcsWord(count)}`"
    size="sm"
    :closable="!busy"
    @close="done ? finish() : emit('close')"
  >
    <form v-if="!done" class="stack" @submit.prevent="onEnter" @keydown.enter.prevent="onEnter">
      <div class="due-box">
        <div class="r"><span>الإجمالي ({{ pcsWord(count) }})</span><span class="num">{{ money(totalMinor) }}</span></div>
        <div class="r grand"><span>المطلوب</span><span class="num">{{ money(totalMinor) }}</span></div>
      </div>
      <div class="field">
        <label for="cash-in">استلمت كام؟ (فاضي = المبلغ بالظبط)</label>
        <input
          id="cash-in"
          v-model="cashText"
          class="big-in num"
          inputmode="decimal"
          autocomplete="off"
          :placeholder="num(totalMinor / 100)"
          data-autofocus
        />
      </div>
      <div class="sugs">
        <button v-for="s in suggestions" :key="s" type="button" class="chip" @click="cashText = String(s / 100)">
          {{ s === totalMinor ? 'بالظبط' : money(s) }}
        </button>
      </div>
      <div v-if="change !== null" class="change-box">
        <span>الباقي للعميل</span><b class="num">{{ money(change) }}</b>
      </div>
      <div v-else-if="cashMinor !== null" class="change-box short">
        <span>ناقص</span><b class="num">{{ money(totalMinor - cashMinor) }}</b>
      </div>
      <div class="field">
        <label for="cust-in">اسم العميل (اختياري)</label>
        <input id="cust-in" v-model="customerName" autocomplete="off" maxlength="120" placeholder="للضمان والمرتجع" />
      </div>
      <div class="err-msg" role="alert">{{ error }}</div>
    </form>
    <div v-else class="stack">
      <div class="done-hero">
        <Icon name="circle-check" />
        <div class="done-t">
          <b>اتسجّلت الفاتورة</b>
          <bdi dir="ltr" class="mono ref">{{ dg(done.outcome.reference) }}</bdi>
          <span class="muted">{{ money(done.outcome.totalMinor) }} كاش</span>
        </div>
      </div>
      <div class="change-box">
        <span>الباقي للعميل</span><b class="num">{{ money(done.changeMinor) }}</b>
      </div>
    </div>
    <template #foot>
      <template v-if="!done">
        <button type="button" class="btn primary lg" :disabled="busy" @click="pay">
          <Icon name="check" /> تم الدفع <kbd>Enter</kbd>
        </button>
        <button type="button" class="btn ghost" :disabled="busy" @click="emit('close')">رجوع</button>
      </template>
      <button v-else ref="finishButton" type="button" class="btn primary lg" @click="finish">
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
