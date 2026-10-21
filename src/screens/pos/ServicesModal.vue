<script setup lang="ts">
/**
 * Quick services modal (`F9` — خدمات سريعة: محافظ · كروت شحن · فواتير)
 * (Plan item 1.10, `ADR-025`, `ADR-016` #35, `PLAN.md` §9, §19, `docs/ui/mockup-v1/pos.js`).
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';

import { describeError } from '../../api/errors';
import {
  recordServiceOp,
  recordWalletOp,
  walletsOverview,
  type WalletSummary,
} from '../../api/wallet';
import {
  BILL_TYPES,
  computeAutoWalletFeeMinor,
  drawerCashDeltaForCustomerOp,
  RECHARGE_CARD_VALUES,
  resolveServiceFeeMinor,
  resolveWalletPeriodBounds,
  TELECOM_OPERATORS,
  walletBalanceAfterCustomerOp,
} from '../wallets/wallets';
import { appearance } from '../../ui/appearance';
import { money, moneyInputValue, moneyUnitWord, num, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import type { IconName } from '../../ui/icons';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';

export type ServicesTab = 'wallet' | 'cards' | 'bills';

const props = withDefaults(
  defineProps<{
    initialTab?: ServicesTab;
    initialWalletId?: string | null;
    initialWalletType?: 'deposit' | 'withdraw';
  }>(),
  {
    initialTab: 'wallet',
    initialWalletId: null,
    initialWalletType: 'deposit',
  }
);

const emit = defineEmits<{
  close: [];
  recorded: [];
}>();

const tab = ref<ServicesTab>(props.initialTab);
const wallets = ref<readonly WalletSummary[]>([]);
const loading = ref(false);
const busy = ref(false);

// --- Wallet tab state ---
const walletType = ref<'deposit' | 'withdraw'>(props.initialWalletType);
const selectedWalletId = ref<string>(props.initialWalletId ?? 'vf');
const svcAmtText = ref('');
const svcFeeText = ref('');
const svcFeeTouched = ref(false);
const svcNoteText = ref('');
const svcAmtInput = ref<HTMLInputElement | null>(null);
const svcFeeInput = ref<HTMLInputElement | null>(null);

// --- Cards tab state ---
const cardOpId = ref<string>('vf');
const cardAmtText = ref('50');
const cardFeeText = ref('');
const cardFeeTouched = ref(false);
const cardNoteText = ref('');
const cardFeeInput = ref<HTMLInputElement | null>(null);

// --- Bills tab state ---
const billTypeId = ref<string>('net');
const billAmtText = ref('');
const billAcctText = ref('');
const billFeeText = ref('');
const billFeeTouched = ref(false);
const billFeeInput = ref<HTMLInputElement | null>(null);

const isAutoFee = computed<boolean>(() => appearance.serviceFeeMode === 'auto');
const feePctNum = computed<number>(() =>
  Math.max(0, Math.min(20, parseInt(appearance.serviceFeePct, 10) || 1))
);
const feeMinEgp = computed<number>(() =>
  Math.max(0, parseInt(appearance.serviceFeeMin, 10) || 5)
);
const billFeeDefaultEgp = computed<number>(() =>
  Math.max(0, parseInt(appearance.billFee, 10) || 5)
);

const visibleWallets = computed<readonly WalletSummary[]>(() =>
  wallets.value.filter((w) => !w.wallet.hidden)
);

const selectedWallet = computed<WalletSummary | null>(() => {
  const list = visibleWallets.value;
  if (list.length === 0) return null;
  return (
    list.find((w) => w.wallet.id === selectedWalletId.value) ?? list[0] ?? null
  );
});

const svcAmtMinor = computed<number>(() => {
  const m = parseMoney(svcAmtText.value);
  return m !== null && m > 0 ? m : 0;
});

const autoWalletFeeMinor = computed<number>(() =>
  computeAutoWalletFeeMinor(
    svcAmtMinor.value,
    feePctNum.value,
    feeMinEgp.value * 100
  )
);

watch(
  [svcAmtMinor, isAutoFee, autoWalletFeeMinor],
  () => {
    if (isAutoFee.value && !svcFeeTouched.value) {
      svcFeeText.value =
        svcAmtMinor.value > 0 ? moneyInputValue(autoWalletFeeMinor.value) : '';
    }
  },
  { immediate: true }
);

const resolvedWalletFeeMinor = computed<number | null>(() =>
  resolveServiceFeeMinor(
    svcFeeText.value,
    appearance.serviceFeeMode,
    autoWalletFeeMinor.value
  )
);

const previewWalletFeeMinor = computed<number>(
  () => resolvedWalletFeeMinor.value ?? 0
);

const afterBalanceMinor = computed<number>(() => {
  const w = selectedWallet.value;
  if (!w) return 0;
  return walletBalanceAfterCustomerOp(
    w.balanceMinor,
    walletType.value,
    svcAmtMinor.value
  );
});

const drawerDeltaMinor = computed<number>(() =>
  drawerCashDeltaForCustomerOp(
    walletType.value,
    svcAmtMinor.value,
    previewWalletFeeMinor.value
  )
);

const insufficientWalletBalance = computed<boolean>(() => {
  const w = selectedWallet.value;
  if (!w || walletType.value !== 'deposit' || svcAmtMinor.value <= 0) {
    return false;
  }
  return svcAmtMinor.value > w.balanceMinor;
});

const overDailyLimit = computed<boolean>(() => {
  const w = selectedWallet.value;
  if (!w || svcAmtMinor.value <= 0 || w.wallet.dailyLimitMinor <= 0) {
    return false;
  }
  return w.today.usedMinor + svcAmtMinor.value > w.wallet.dailyLimitMinor;
});

const afterLowAlert = computed<boolean>(() => {
  const w = selectedWallet.value;
  if (
    !w ||
    walletType.value !== 'deposit' ||
    svcAmtMinor.value <= 0 ||
    insufficientWalletBalance.value ||
    w.wallet.minAlertMinor <= 0
  ) {
    return false;
  }
  return afterBalanceMinor.value < w.wallet.minAlertMinor;
});

const afterOverMax = computed<boolean>(() => {
  const w = selectedWallet.value;
  if (
    !w ||
    walletType.value !== 'withdraw' ||
    svcAmtMinor.value <= 0 ||
    w.wallet.maxLimitMinor <= 0
  ) {
    return false;
  }
  return afterBalanceMinor.value > w.wallet.maxLimitMinor;
});

// --- Cards computed ---
const cardAmtMinor = computed<number>(() => {
  const m = parseMoney(cardAmtText.value);
  return m !== null && m > 0 ? m : 0;
});

const autoCardFeeMinor = computed<number>(() =>
  isAutoFee.value ? Math.min(500, Math.max(100, Math.round(cardAmtMinor.value * 0.05))) : 0
);

const resolvedCardFeeMinor = computed<number | null>(() =>
  resolveServiceFeeMinor(
    cardFeeText.value,
    appearance.serviceFeeMode,
    autoCardFeeMinor.value
  )
);

// --- Bills computed ---
const billAmtMinor = computed<number>(() => {
  const m = parseMoney(billAmtText.value);
  return m !== null && m > 0 ? m : 0;
});

const autoBillFeeMinor = computed<number>(() => billFeeDefaultEgp.value * 100);

watch(
  [isAutoFee, autoBillFeeMinor],
  () => {
    if (isAutoFee.value && !billFeeTouched.value) {
      billFeeText.value = String(billFeeDefaultEgp.value);
    }
  },
  { immediate: true }
);

const resolvedBillFeeMinor = computed<number | null>(() =>
  resolveServiceFeeMinor(
    billFeeText.value,
    appearance.serviceFeeMode,
    autoBillFeeMinor.value
  )
);

async function loadWallets(): Promise<void> {
  loading.value = true;
  try {
    const bounds = resolveWalletPeriodBounds('today');
    const overview = await walletsOverview(
      bounds.todayFromMs,
      bounds.periodFromMs,
      bounds.periodToMs,
      null,
      20
    );
    wallets.value = overview.wallets;
    const firstVisible = visibleWallets.value[0];
    if (
      firstVisible &&
      !visibleWallets.value.some((w) => w.wallet.id === selectedWalletId.value)
    ) {
      selectedWalletId.value = firstVisible.wallet.id;
    }
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await loadWallets();
  await nextTick();
  svcAmtInput.value?.focus();
});

async function submitWalletOp(): Promise<void> {
  if (busy.value) return;
  const w = selectedWallet.value;
  if (!w) {
    toast('مفيش محافظ مفعّلة، فعّل محفظة من الإعدادات', 'err');
    return;
  }
  if (svcAmtMinor.value <= 0) {
    toast('اكتب المبلغ', 'err');
    svcAmtInput.value?.focus();
    return;
  }
  const feeMinor = resolvedWalletFeeMinor.value;
  if (feeMinor === null) {
    toast('اكتب العمولة، ولو مفيش عمولة اكتب 0', 'err');
    svcFeeInput.value?.focus();
    return;
  }
  if (walletType.value === 'withdraw' && feeMinor > svcAmtMinor.value) {
    toast('العمولة أكبر من المبلغ', 'err');
    svcFeeInput.value?.focus();
    return;
  }
  if (insufficientWalletBalance.value) {
    toast(
      `رصيد ${w.wallet.name} (${money(w.balanceMinor)}) مش كافي، اشحن المحفظة الأول`,
      'err'
    );
    return;
  }

  busy.value = true;
  try {
    await recordWalletOp(
      w.wallet.id,
      walletType.value,
      svcAmtMinor.value,
      feeMinor,
      svcNoteText.value.trim() || null
    );
    toast(
      `اتسجّلت عملية المحفظة، رصيد ${w.wallet.name}: ${money(afterBalanceMinor.value)}`,
      'ok'
    );
    emit('recorded');
    emit('close');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

function pickCardVal(valEgp: number): void {
  cardAmtText.value = String(valEgp);
  if (isAutoFee.value && !cardFeeTouched.value) {
    cardFeeText.value = moneyInputValue(autoCardFeeMinor.value);
  }
}

async function submitCardOp(): Promise<void> {
  if (busy.value) return;
  if (cardAmtMinor.value <= 0) {
    toast('اكتب أو اختار فئة كارت الشحن', 'err');
    return;
  }
  const feeMinor = resolvedCardFeeMinor.value;
  if (feeMinor === null) {
    toast('اكتب العمولة، ولو مفيش عمولة اكتب 0', 'err');
    cardFeeInput.value?.focus();
    return;
  }
  const op =
    TELECOM_OPERATORS.find((o) => o.id === cardOpId.value) ??
    TELECOM_OPERATORS[0];

  busy.value = true;
  try {
    await recordServiceOp(
      'card',
      `كارت شحن ${op.name} ${money(cardAmtMinor.value)}`,
      op.id,
      cardAmtMinor.value,
      feeMinor,
      cardNoteText.value.trim() || null
    );
    toast(
      `اتسجّل كارت شحن ${op.name} (${money(cardAmtMinor.value + feeMinor)})`,
      'ok'
    );
    emit('recorded');
    emit('close');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function submitBillOp(): Promise<void> {
  if (busy.value) return;
  if (billAmtMinor.value <= 0) {
    toast('اكتب مبلغ الفاتورة', 'err');
    return;
  }
  const feeMinor = resolvedBillFeeMinor.value;
  if (feeMinor === null) {
    toast('اكتب رسوم الخدمة، ولو مفيش رسوم اكتب 0', 'err');
    billFeeInput.value?.focus();
    return;
  }
  const bt =
    BILL_TYPES.find((b) => b.id === billTypeId.value) ?? BILL_TYPES[0];

  busy.value = true;
  try {
    await recordServiceOp(
      'bill',
      bt.id,
      billAcctText.value.trim() || null,
      billAmtMinor.value,
      feeMinor,
      bt.name
    );
    toast(
      `اتسجّل دفع فاتورة ${bt.name} (${money(billAmtMinor.value + feeMinor)})`,
      'ok'
    );
    emit('recorded');
    emit('close');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal
    title="خدمات سريعة"
    sub="محافظ · كروت شحن · دفع فواتير"
    size="wide"
    @close="emit('close')"
  >
    <div data-services-modal>
      <div class="tabs" style="margin-bottom: 14px">
        <button
          type="button"
          class="tab"
          :class="{ on: tab === 'wallet' }"
          data-svc-tab="wallet"
          @click="tab = 'wallet'"
        >
          محافظ
        </button>
        <button
          type="button"
          class="tab"
          :class="{ on: tab === 'cards' }"
          data-svc-tab="cards"
          @click="tab = 'cards'"
        >
          كروت شحن
        </button>
        <button
          type="button"
          class="tab"
          :class="{ on: tab === 'bills' }"
          data-svc-tab="bills"
          @click="tab = 'bills'"
        >
          فواتير
        </button>
      </div>

      <!-- TAB 1: WALLETS -->
      <div v-if="tab === 'wallet'" data-svc-wallet-panel>
        <div v-if="!selectedWallet && !loading" class="empty">
          <Icon name="wallet" />
          <p>مفيش محافظ مفعّلة، فعّل محفظة من الإعدادات</p>
        </div>

        <form v-else-if="selectedWallet" @submit.prevent="submitWalletOp">
          <div class="g2" style="margin-bottom: 12px">
            <button
              type="button"
              class="btn"
              :class="walletType === 'deposit' ? 'primary' : 'ghost'"
              data-svc-wallet-type="deposit"
              @click="walletType = 'deposit'"
            >
              <Icon name="arrow-down-to-line" />
              <span>إيداع (العميل بيدفع كاش، وانت بتحوّل من محفظتك)</span>
            </button>
            <button
              type="button"
              class="btn"
              :class="walletType === 'withdraw' ? 'primary' : 'ghost'"
              data-svc-wallet-type="withdraw"
              @click="walletType = 'withdraw'"
            >
              <Icon name="arrow-up-from-line" />
              <span>سحب (العميل بيحوّل على محفظتك، وانت بتديله كاش)</span>
            </button>
          </div>

          <div class="wallets" style="margin-bottom: 12px">
            <button
              v-for="ws in visibleWallets"
              :key="ws.wallet.id"
              type="button"
              class="wallet"
              :class="{ on: ws.wallet.id === selectedWallet.wallet.id }"
              :data-svc-wallet="ws.wallet.id"
              @click="selectedWalletId = ws.wallet.id"
            >
              <span
                class="wl-dot"
                :style="{ background: ws.wallet.color }"
              ></span>
              <span class="t">
                <b><bdi dir="auto">{{ ws.wallet.name }}</bdi></b>
                <small class="num">{{ money(ws.balanceMinor) }}</small>
              </span>
            </button>
          </div>

          <div
            v-if="walletType === 'withdraw' && selectedWallet.wallet.number"
            class="wl-pay-to"
            style="margin-bottom: 12px"
            data-svc-pay-to
          >
            <Icon name="smartphone" />
            <span>
              خلّي العميل يحوّل على
              <b class="mono" dir="ltr">{{ selectedWallet.wallet.number }}</b>
            </span>
          </div>

          <div class="g3">
            <div class="field">
              <label class="lbl" for="svc-amt">المبلغ ({{ moneyUnitWord() }})</label>
              <input
                id="svc-amt"
                ref="svcAmtInput"
                v-model="svcAmtText"
                class="in lg"
                :class="{ mono: svcAmtText !== '' }"
                :dir="svcAmtText ? 'ltr' : 'rtl'"
                inputmode="decimal"
                placeholder="1000"
                data-svc-amt
              />
            </div>

            <div class="field">
              <label class="lbl" for="svc-fee">العمولة ({{ moneyUnitWord() }})</label>
              <input
                id="svc-fee"
                ref="svcFeeInput"
                v-model="svcFeeText"
                class="in lg"
                :class="{ mono: svcFeeText !== '' }"
                :dir="svcFeeText ? 'ltr' : 'rtl'"
                inputmode="decimal"
                :placeholder="isAutoFee ? '0' : 'اكتبها'"
                data-svc-fee
                @input="svcFeeTouched = true"
              />
              <small class="hint">
                {{
                  isAutoFee
                    ? `محسوبة ${num(feePctNum)}٪، وأقل حاجة ${money(feeMinEgp * 100)}. تقدر تغيّرها`
                    : 'مش ثابتة، اكتبها (لو مفيش اكتب 0)'
                }}
              </small>
            </div>

            <div class="field">
              <label class="lbl" for="svc-note">ملاحظة (اختياري)</label>
              <input
                id="svc-note"
                v-model="svcNoteText"
                class="in"
                placeholder="لو محتاج تفكّر نفسك"
                data-svc-note
              />
            </div>
          </div>

          <div
            class="due-box"
            style="margin-top: 12px; justify-content: space-between"
            data-svc-due-box
          >
            <div>
              <small>رصيد <bdi dir="auto">{{ selectedWallet.wallet.name }}</bdi> بعدها</small>
              <b
                class="num"
                :style="{
                  fontSize: '1.25rem',
                  color: insufficientWalletBalance ? 'var(--danger)' : '',
                }"
                data-svc-after-balance
              >
                {{ money(afterBalanceMinor) }}
              </b>
            </div>
            <div style="text-align: end">
              <small>
                {{
                  walletType === 'deposit'
                    ? 'تحصّل من العميل كاش'
                    : 'تدفع للعميل كاش'
                }}
              </small>
              <b class="num" style="font-size: 1.4rem" data-svc-cash-delta>
                {{ money(Math.abs(drawerDeltaMinor)) }}
              </b>
            </div>
          </div>

          <div
            v-if="insufficientWalletBalance"
            class="note danger"
            style="margin-top: 10px"
            data-svc-insufficient
          >
            <Icon name="triangle-alert" />
            <span>
              رصيد <b><bdi dir="auto">{{ selectedWallet.wallet.name }}</bdi></b> ({{
                money(selectedWallet.balanceMinor)
              }}) مش كافي للمبلغ ده. اشحن المحفظة أو اختار محفظة تانية.
            </span>
          </div>

          <div
            v-if="overDailyLimit"
            class="note warn"
            style="margin-top: 10px"
            data-svc-over-daily
          >
            <Icon name="triangle-alert" />
            <span>
              هتعدّي الحد اليومي لمحفظة
              <b><bdi dir="auto">{{ selectedWallet.wallet.name }}</bdi></b> (المستخدم النهارده
              {{ money(selectedWallet.today.usedMinor) }} من
              {{ money(selectedWallet.wallet.dailyLimitMinor) }})
            </span>
          </div>

          <div
            v-if="afterLowAlert"
            class="note warn"
            style="margin-top: 10px"
            data-svc-low-alert
          >
            <Icon name="info" />
            <span>
              رصيد المحفظة بعد العملية هيبقى أقل من حد التنبيه ({{
                money(selectedWallet.wallet.minAlertMinor)
              }})
            </span>
          </div>

          <div
            v-if="afterOverMax"
            class="note warn"
            style="margin-top: 10px"
            data-svc-over-max
          >
            <Icon name="triangle-alert" />
            <span>
              رصيد المحفظة هيعدّي الحد الأقصى ({{
                money(selectedWallet.wallet.maxLimitMinor)
              }})، فرّغ منها للدرج قريب
            </span>
          </div>
        </form>
      </div>

      <!-- TAB 2: RECHARGE CARDS -->
      <div v-else-if="tab === 'cards'" data-svc-cards-panel>
        <form @submit.prevent="submitCardOp">
          <div class="wallets" style="margin-bottom: 12px">
            <button
              v-for="op in TELECOM_OPERATORS"
              :key="op.id"
              type="button"
              class="wallet"
              :class="{ on: op.id === cardOpId }"
              :data-svc-card-op="op.id"
              @click="cardOpId = op.id"
            >
              <span class="wl-dot" :style="{ background: op.color }"></span>
              <span class="t">
                <b>{{ op.name }}</b>
                <small>كارت شحن</small>
              </span>
            </button>
          </div>

          <div class="card-vals" style="margin-bottom: 12px">
            <button
              v-for="v in RECHARGE_CARD_VALUES"
              :key="v"
              type="button"
              class="btn lg"
              :class="cardAmtText === String(v) ? 'primary' : 'ghost'"
              :data-svc-card-val="v"
              @click="pickCardVal(v)"
            >
              <span class="num"><b>{{ money(v) }}</b></span>
            </button>
          </div>

          <div class="g3">
            <div class="field">
              <label class="lbl" for="card-amt">قيمة الكارت ({{ moneyUnitWord() }})</label>
              <input
                id="card-amt"
                v-model="cardAmtText"
                class="in"
                :class="{ mono: cardAmtText !== '' }"
                :dir="cardAmtText ? 'ltr' : 'rtl'"
                inputmode="decimal"
                placeholder="50"
                data-svc-card-amt
              />
            </div>
            <div class="field">
              <label class="lbl" for="card-fee">العمولة / الخدمة ({{ moneyUnitWord() }})</label>
              <input
                id="card-fee"
                ref="cardFeeInput"
                v-model="cardFeeText"
                class="in"
                :class="{ mono: cardFeeText !== '' }"
                :dir="cardFeeText ? 'ltr' : 'rtl'"
                inputmode="decimal"
                :placeholder="isAutoFee ? '0' : 'اكتبها'"
                data-svc-card-fee
                @input="cardFeeTouched = true"
              />
              <small class="hint">لو مفيش عمولة اكتب 0</small>
            </div>
            <div class="field">
              <label class="lbl" for="card-note">ملاحظة (اختياري)</label>
              <input
                id="card-note"
                v-model="cardNoteText"
                class="in"
                placeholder="كارت فكة / شحن عالطاير"
                data-svc-card-note
              />
            </div>
          </div>

          <div class="due-box" style="margin-top: 12px">
            <small>تحصّل من العميل كاش</small>
            <b class="num" data-svc-card-total>
              {{ money(cardAmtMinor + (resolvedCardFeeMinor ?? 0)) }}
            </b>
          </div>
        </form>
      </div>

      <!-- TAB 3: BILLS -->
      <div v-else-if="tab === 'bills'" data-svc-bills-panel>
        <form @submit.prevent="submitBillOp">
          <div class="wallets" style="margin-bottom: 12px">
            <button
              v-for="bt in BILL_TYPES"
              :key="bt.id"
              type="button"
              class="wallet"
              :class="{ on: bt.id === billTypeId }"
              :data-svc-bill-type="bt.id"
              @click="billTypeId = bt.id"
            >
              <Icon :name="bt.icon as IconName" />
              <span class="t"><b>{{ bt.name }}</b></span>
            </button>
          </div>

          <div class="g3">
            <div class="field">
              <label class="lbl" for="bill-amt">مبلغ الفاتورة ({{ moneyUnitWord() }})</label>
              <input
                id="bill-amt"
                v-model="billAmtText"
                class="in lg"
                :class="{ mono: billAmtText !== '' }"
                :dir="billAmtText ? 'ltr' : 'rtl'"
                inputmode="decimal"
                placeholder="200"
                data-svc-bill-amt
              />
            </div>
            <div class="field">
              <label class="lbl" for="bill-acct">
                رقم الحساب أو التليفون (اختياري)
              </label>
              <input
                id="bill-acct"
                v-model="billAcctText"
                class="in"
                :class="{ mono: billAcctText !== '' }"
                :dir="billAcctText ? 'ltr' : 'rtl'"
                placeholder="لو محتاج تفكّر نفسك"
                data-svc-bill-acct
              />
            </div>
            <div class="field">
              <label class="lbl" for="bill-fee">رسوم الخدمة ({{ moneyUnitWord() }})</label>
              <input
                id="bill-fee"
                ref="billFeeInput"
                v-model="billFeeText"
                class="in lg"
                :class="{ mono: billFeeText !== '' }"
                :dir="billFeeText ? 'ltr' : 'rtl'"
                inputmode="decimal"
                :placeholder="isAutoFee ? String(billFeeDefaultEgp) : 'اكتبها'"
                data-svc-bill-fee
                @input="billFeeTouched = true"
              />
              <small class="hint">
                {{
                  isAutoFee
                    ? 'محسوبة من الإعدادات، وتقدر تغيّرها'
                    : 'مش ثابتة، اكتبها (لو مفيش اكتب 0)'
                }}
              </small>
            </div>
          </div>

          <div class="due-box" style="margin-top: 12px">
            <small>تحصّل من العميل</small>
            <b class="num" data-svc-bill-total>
              {{ money(billAmtMinor + (resolvedBillFeeMinor ?? 0)) }}
            </b>
          </div>
        </form>
      </div>
    </div>

    <template #foot>
      <button type="button" class="btn ghost" @click="emit('close')">
        إلغاء
      </button>
      <button
        v-if="tab === 'wallet' && selectedWallet"
        type="button"
        class="btn primary lg"
        :disabled="busy || insufficientWalletBalance"
        data-svc-wallet-submit
        @click="submitWalletOp"
      >
        <Icon name="check" />
        <span>سجّل العملية</span>
      </button>
      <button
        v-else-if="tab === 'cards'"
        type="button"
        class="btn primary lg"
        :disabled="busy"
        data-svc-card-submit
        @click="submitCardOp"
      >
        <Icon name="check" />
        <span>سجّل الكارت</span>
      </button>
      <button
        v-else-if="tab === 'bills'"
        type="button"
        class="btn primary lg"
        :disabled="busy"
        data-svc-bill-submit
        @click="submitBillOp"
      >
        <Icon name="check" />
        <span>سجّل الدفع</span>
      </button>
    </template>
  </Modal>
</template>
