<script setup lang="ts">
// Paying (`docs/ui/mockup-v1/pos.js`, «الدفع» & «تم البيع»; `ADR-020`, `ADR-022`,
// `docs/PLAN.md` §8, §10).
import { computed, nextTick, reactive, ref, watch } from 'vue';

import type { Customer } from '../../api/customer';
import { describeError } from '../../api/errors';
import * as salesApi from '../../api/sales';
import type { SaleOutcome } from '../../api/sales';
import { withOwnerApproval } from '../../shell/approval';
import {
  appearance,
  enabledPayMethods,
  INSTALLMENT_PROVIDERS,
  isPayMethodEnabled,
  PAY_METHODS,
  type PayMethodId,
  shopLogo,
} from '../../ui/appearance';
import { dg, money, moneyInputValue, num, parseMoney, pcsWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';
import { changeDue } from './cart';
import WalletNumberChips from './WalletNumberChips.vue';
import type { CartLine } from './cart';
import {
  cashSuggestions,
  type DraftPayment,
  methodLabel,
  paidSoFar,
  paymentsSummaryText,
  remainingDue,
} from './payments';
import {
  buildWhatsAppUrl,
  copyReceiptCanvasToClipboard,
  defaultInvoiceReceiptMode,
  formatWhatsAppMessage,
  isValidEgyptianPhone,
  normalizeEgyptianPhone,
  type ReceiptData,
  type ReceiptMode,
  receiptModeDoneLabel,
  receiptModeOptions,
  renderReceiptCanvas,
  warrantyLabelForReceipt,
} from './receipt';
import ReceiptPreview from './ReceiptPreview.vue';
import { warrantyDatesForMonths } from './warranty';

const props = defineProps<{
  lines: readonly CartLine[];
  totalMinor: number;
  count: number;
  selectedCustomer?: Customer | null;
  invoiceDiscountMinor?: number;
  grossSubtotalMinor?: number;
  sellerName?: string;
  tradeInCreditMinor?: number;
  tradeInLabel?: string | null;
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
/**
 * Which wallet number took the money, kept per method (`ADR-041`). Per method rather than one
 * running choice because a split sale can pay part by vf and part by instapay, and each part
 * belongs to the number the operator named for it.
 */
const walletByMethod = reactive<Record<string, string | null>>({});
const installProvider = ref<string>(INSTALLMENT_PROVIDERS[0] ?? 'valU');
const customerName = ref('');
const receiptMode = ref<ReceiptMode>(
  defaultInvoiceReceiptMode(
    appearance.receiptMode,
    appearance.printerEnabled,
    props.selectedCustomer?.contact
  )
);
const waPhone = ref<string>(
  normalizeEgyptianPhone(props.selectedCustomer?.contact)
);
const busy = ref(false);
const error = ref('');

const done = ref<{
  outcome: SaleOutcome;
  changeMinor: number;
  summary: string;
  receipt: ReceiptData;
  receiptMode: ReceiptMode;
  waPhone: string;
  waMessage: string;
  waUrl: string;
  imageCopied: boolean;
} | null>(null);

const askWaAfterDone = ref(false);
const doneWaDraft = ref('');
const doneWaError = ref('');
const doneWaInput = ref<HTMLInputElement | null>(null);
const finishButton = ref<HTMLButtonElement | null>(null);

const visibleMethods = computed(() =>
  enabledPayMethods(appearance.payMethods)
);

const receiptOptions = computed(() =>
  receiptModeOptions(appearance.printerEnabled)
);

watch(
  () => appearance.payMethods,
  (raw) => {
    if (!isPayMethodEnabled(method.value, raw)) {
      method.value = 'cash';
    }
  }
);

watch(
  () => props.selectedCustomer,
  (cust) => {
    const phone = normalizeEgyptianPhone(cust?.contact);
    if (phone && waPhone.value.trim() === '') {
      waPhone.value = phone;
    }
    receiptMode.value = defaultInvoiceReceiptMode(
      appearance.receiptMode,
      appearance.printerEnabled,
      phone || waPhone.value
    );
    error.value = '';
  }
);

const currentMethodMeta = computed(
  () =>
    PAY_METHODS.find((m) => m.id === method.value) ?? PAY_METHODS[0]!
);

const netPayableMinor = computed(() =>
  Math.max(0, props.totalMinor - (props.tradeInCreditMinor ?? 0))
);

const paidMinor = computed(() => paidSoFar(splitPayments.value));
const dueMinor = computed(() =>
  remainingDue(netPayableMinor.value, splitPayments.value)
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

function selectReceiptMode(next: ReceiptMode): void {
  receiptMode.value = next;
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
    walletId: walletByMethod[method.value] ?? null,
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

function currentShopProfile() {
  return {
    shopName: appearance.shopName,
    shopPhone: appearance.shopPhone,
    shopAddress: appearance.shopAddress,
    receiptFooter: appearance.receiptFooter,
    receiptPaper: appearance.receiptPaper,
    shopLogo: shopLogo.value,
  };
}

async function dispatchWhatsAppReceipt(
  receipt: ReceiptData,
  phoneRaw: string
): Promise<void> {
  const normalized = normalizeEgyptianPhone(phoneRaw);
  if (!normalized) return;

  const warrantyDate = warrantyLabelForReceipt(receipt);
  const message = formatWhatsAppMessage(appearance.waTemplate, {
    customerName: receipt.customerName,
    reference: receipt.reference,
    shopName: appearance.shopName,
    totalMinor: receipt.totalMinor,
    warrantyDate,
  });
  const url = buildWhatsAppUrl(normalized, message);
  const canvas = await renderReceiptCanvas(receipt, currentShopProfile());
  const { copied, dataUrl } = await copyReceiptCanvasToClipboard(canvas);

  if (done.value) {
    done.value.waPhone = normalized;
    done.value.waMessage = message;
    done.value.waUrl = url;
    done.value.imageCopied = copied;
    if (done.value.receiptMode === 'none') {
      done.value.receiptMode = 'wa';
    } else if (done.value.receiptMode === 'print') {
      done.value.receiptMode = 'both';
    }
  }

  (
    window as unknown as {
      __lastWhatsAppSent?: {
        phone: string;
        message: string;
        url: string;
        imageDataUrl: string;
        copied: boolean;
      };
    }
  ).__lastWhatsAppSent = {
    phone: normalized,
    message,
    url,
    imageDataUrl: dataUrl,
    copied,
  };

  if (typeof navigator !== 'undefined' && navigator.webdriver !== true && url) {
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      // Ignore popup blocker
    }
  }

  toast(
    `اتبعت الإيصال على واتساب ${normalized} (صورة الإيصال + رسالة)`,
    'ok'
  );
}

async function onCopyReceiptImage(): Promise<void> {
  if (!done.value) return;
  const canvas = await renderReceiptCanvas(
    done.value.receipt,
    currentShopProfile()
  );
  const { copied } = await copyReceiptCanvasToClipboard(canvas);
  toast(
    copied
      ? 'اتنسخت صورة الإيصال، جاهزة للصق (Ctrl+V) في واتساب'
      : 'اتجهزت صورة الإيصال',
    'info'
  );
}

async function onReprintReceipt(): Promise<void> {
  if (!done.value) return;
  await renderReceiptCanvas(done.value.receipt, currentShopProfile());
  toast(
    `بيطبع الإيصال رقم ${done.value.outcome.reference} (كصورة عشان العربي يطلع مظبوط)`,
    'info'
  );
}

async function onClickDoneWhatsApp(): Promise<void> {
  if (!done.value) return;
  const existingPhone =
    done.value.waPhone ||
    normalizeEgyptianPhone(props.selectedCustomer?.contact);
  if (existingPhone) {
    await dispatchWhatsAppReceipt(done.value.receipt, existingPhone);
    return;
  }
  askWaAfterDone.value = true;
  doneWaDraft.value = '';
  doneWaError.value = '';
  await nextTick();
  doneWaInput.value?.focus({ preventScroll: true });
}

async function submitDoneWhatsApp(): Promise<void> {
  if (!done.value) return;
  const normalized = normalizeEgyptianPhone(doneWaDraft.value);
  if (!normalized) {
    doneWaError.value = 'رقم الواتساب لازم يكون 11 رقم ويبدأ بـ 01';
    return;
  }
  askWaAfterDone.value = false;
  doneWaError.value = '';
  await dispatchWhatsAppReceipt(done.value.receipt, normalized);
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
        walletId: walletByMethod[method.value] ?? null,
      });
    }
  }

  const hasCredit = finalPayments.some((p) => p.method === 'credit');
  if (hasCredit && !props.selectedCustomer) {
    error.value = 'البيع الآجل لازم يتربط بعميل متسجّل';
    return;
  }

  if (
    (receiptMode.value === 'wa' || receiptMode.value === 'both') &&
    !isValidEgyptianPhone(waPhone.value)
  ) {
    error.value =
      'اكتب رقم واتساب صحيح (11 رقم يبدأ بـ 01) أو غيّر طريقة الإيصال لـ «بدون»';
    return;
  }

  busy.value = true;
  try {
    const tradeInAppliedMinor = Math.min(
      props.totalMinor,
      Math.max(0, props.tradeInCreditMinor ?? 0)
    );
    const paymentsForSale: DraftPayment[] = finalPayments.map((p) => ({ ...p }));
    if (tradeInAppliedMinor > 0) {
      const cashIdx = paymentsForSale.findIndex((p) => p.method === 'cash');
      if (cashIdx >= 0) {
        const existing = paymentsForSale[cashIdx]!;
        paymentsForSale[cashIdx] = {
          ...existing,
          amountMinor: existing.amountMinor + tradeInAppliedMinor,
        };
      } else {
        paymentsForSale.push({
          method: 'cash',
          amountMinor: tradeInAppliedMinor,
          reference: null,
        });
      }
    }

    const saleTimestamp = new Date();
    const approvalOutcome = await withOwnerApproval(
      () =>
        salesApi.recordSale(
          props.lines.map((line) => {
            const months = line.warrantyMonths ?? (line.serial ? 12 : 0);
            return {
              productId: line.productId,
              quantity: line.quantity,
              imei: line.imei ?? null,
              discountMinor: line.discountMinor ?? 0,
              ...warrantyDatesForMonths(months, saleTimestamp),
            };
          }),
          props.totalMinor,
          paymentsForSale,
          props.selectedCustomer?.id ?? null,
          props.invoiceDiscountMinor ?? 0
        ),
      'موافقة المالك على خصم الفاتورة'
    );
    if (approvalOutcome.status === 'cancelled') {
      return;
    }
    const outcome = approvalOutcome.value;
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

    const grossSubtotal = props.grossSubtotalMinor ?? props.totalMinor;
    const receiptData: ReceiptData = {
      reference: outcome.reference,
      occurredAt: saleTimestamp,
      sellerName: props.sellerName || 'بيتر',
      customerName:
        props.selectedCustomer?.name ?? (customerName.value.trim() || null),
      lines: props.lines.map((line) => {
        const months = line.warrantyMonths ?? (line.serial ? 12 : 0);
        const dates = warrantyDatesForMonths(months, saleTimestamp);
        return {
          name: line.name,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          discountMinor: line.discountMinor ?? 0,
          lineTotalMinor:
            line.quantity * line.unitPriceMinor - (line.discountMinor ?? 0),
          imei: line.imei ?? null,
          warrantyMonths: months,
          warrantyEnd: dates.warrantyEnd ?? null,
        };
      }),
      grossSubtotalMinor: grossSubtotal,
      discountMinor: Math.max(0, grossSubtotal - props.totalMinor),
      totalMinor: props.totalMinor,
      payments: finalPayments,
      changeMinor: cashChangeMinor,
    };

    const normalizedWa = normalizeEgyptianPhone(waPhone.value);
    done.value = {
      outcome,
      changeMinor: cashChangeMinor,
      summary: paymentsSummaryText(finalPayments),
      receipt: receiptData,
      receiptMode: receiptMode.value,
      waPhone:
        receiptMode.value === 'wa' || receiptMode.value === 'both'
          ? normalizedWa
          : '',
      waMessage: '',
      waUrl: '',
      imageCopied: false,
    };

    if (
      appearance.printerEnabled === 'on' &&
      (receiptMode.value === 'print' || receiptMode.value === 'both')
    ) {
      await onReprintReceipt();
    }
    if (receiptMode.value === 'wa' || receiptMode.value === 'both') {
      await dispatchWhatsAppReceipt(receiptData, normalizedWa);
    }

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
  if (done.value !== null) {
    if (askWaAfterDone.value) {
      void submitDoneWhatsApp();
    } else {
      finish();
    }
  } else {
    void pay();
  }
}
</script>

<template>
  <Modal
    :title="done ? 'تم البيع' : 'الدفع'"
    :sub="
      done
        ? `فاتورة رقم ${dg(done.outcome.reference)} · ${done.summary}`
        : `${currentMethodMeta.name} · ${pcsWord(count)}`
    "
    :size="done ? 'wide' : 'md'"
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
        <div
          v-if="(grossSubtotalMinor ?? totalMinor) > totalMinor"
          class="r"
        >
          <span>الإجمالي قبل الخصم ({{ pcsWord(count) }})</span>
          <span class="num">{{ money(grossSubtotalMinor ?? totalMinor) }}</span>
        </div>
        <div
          v-if="(grossSubtotalMinor ?? totalMinor) > totalMinor"
          class="r"
        >
          <span>الخصم</span>
          <span class="num">- {{ money((grossSubtotalMinor ?? totalMinor) - totalMinor) }}</span>
        </div>
        <div class="r">
          <span>{{ (grossSubtotalMinor ?? totalMinor) > totalMinor ? 'الصافي بعد الخصم' : `الإجمالي (${pcsWord(count)})` }}</span>
          <span class="num">{{ money(totalMinor) }}</span>
        </div>
        <div
          v-if="(tradeInCreditMinor ?? 0) > 0"
          class="r"
          data-pay-tradein-row
        >
          <span>خصم استبدال ({{ tradeInLabel || 'جهاز مستعمل' }})</span>
          <span class="num">- {{ money(tradeInCreditMinor ?? 0) }}</span>
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
              :placeholder="moneyInputValue(dueMinor)"
              data-autofocus
            />
          </div>
          <div class="sugs">
            <button
              v-for="s in suggestions"
              :key="s"
              type="button"
              class="chip"
              @click="cashText = moneyInputValue(s)"
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
                :placeholder="moneyInputValue(dueMinor)"
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
            <WalletNumberChips
              :method="method"
              :model-value="walletByMethod[method] ?? null"
              :disabled="busy"
              @update:model-value="(v: string | null) => (walletByMethod[method] = v)"
            />
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
              :placeholder="moneyInputValue(dueMinor)"
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
                :placeholder="moneyInputValue(dueMinor)"
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
            <WalletNumberChips
              :method="method"
              :model-value="walletByMethod[method] ?? null"
              :disabled="busy"
              @update:model-value="(v: string | null) => (walletByMethod[method] = v)"
            />
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

      <div class="field" data-pay-receipt-section>
        <span class="label">الإيصال</span>
        <div class="seg" role="group" aria-label="طريقة الإيصال">
          <button
            v-for="[id, label] in receiptOptions"
            :key="id"
            :id="`pay-receipt-mode-${id}`"
            type="button"
            :class="{ on: receiptMode === id }"
            :data-receipt-mode="id"
            @click="selectReceiptMode(id)"
          >
            {{ label }}
          </button>
        </div>
      </div>

      <div
        v-if="receiptMode === 'wa' || receiptMode === 'both'"
        class="field"
      >
        <label for="pay-wa">رقم واتساب العميل</label>
        <input
          id="pay-wa"
          v-model="waPhone"
          dir="ltr"
          inputmode="tel"
          autocomplete="off"
          maxlength="20"
          placeholder="01xxxxxxxxx"
          @input="error = ''"
        />
      </div>

      <div class="err-msg" role="alert">{{ error }}</div>
    </form>

    <div v-else class="done-wrap">
      <div class="stack">
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
        <div class="sum-box">
          <div class="r">
            <span>البيّاع</span>
            <b>{{ done.receipt.sellerName }}</b>
          </div>
          <div class="r">
            <span>العميل</span>
            <b>{{ done.receipt.customerName || 'نقدي' }}</b>
          </div>
          <div class="r">
            <span>الإيصال</span>
            <b data-done-receipt-status>
              {{ receiptModeDoneLabel(done.receiptMode) }}
              <bdi v-if="done.waPhone" dir="ltr" class="mono">({{ done.waPhone }})</bdi>
            </b>
          </div>
          <div class="r">
            <span>عدد القطع</span>
            <b class="num">{{ num(count) }}</b>
          </div>
        </div>

        <div v-if="done.waMessage" class="note" data-done-wa-summary>
          <Icon name="message-circle" />
          <div class="stack" style="gap: 4px; flex: 1">
            <span>{{ done.waMessage }}</span>
            <a
              v-if="done.waUrl"
              :href="done.waUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="link-btn"
              style="justify-self: start"
              data-wa-direct-link
            >
              فتح محادثة واتساب ({{ done.waPhone }})
            </a>
          </div>
        </div>

        <div class="row wrap" style="gap: 8px">
          <button
            v-if="!askWaAfterDone"
            id="send-wa-receipt-btn"
            type="button"
            class="btn"
            data-act="waSend"
            @click="onClickDoneWhatsApp"
          >
            <Icon name="message-circle" />
            {{ done.waPhone ? 'ابعت تاني واتساب' : 'ابعت الإيصال واتساب' }}
          </button>
          <button
            id="copy-receipt-img-btn"
            type="button"
            class="btn"
            @click="onCopyReceiptImage"
          >
            <Icon name="image" /> نسخ صورة الإيصال
          </button>
          <button
            v-if="appearance.printerEnabled === 'on'"
            id="reprint-receipt-btn"
            type="button"
            class="btn"
            @click="onReprintReceipt"
          >
            <Icon name="printer" /> اطبع تاني
          </button>
        </div>

        <template v-if="askWaAfterDone">
          <div class="row wa-ask" data-done-wa-ask>
            <div class="field">
              <label for="done-wa">رقم واتساب العميل</label>
              <input
                id="done-wa"
                ref="doneWaInput"
                v-model="doneWaDraft"
                dir="ltr"
                inputmode="tel"
                autocomplete="off"
                maxlength="20"
                placeholder="01xxxxxxxxx"
                @input="doneWaError = ''"
                @keydown.enter.prevent.stop="submitDoneWhatsApp"
              />
            </div>
            <button
              id="done-wa-send-btn"
              type="button"
              class="btn primary"
              @click="submitDoneWhatsApp"
            >
              <Icon name="send" /> ابعت <kbd>Enter</kbd>
            </button>
          </div>
          <div v-if="doneWaError" class="err-msg" role="alert">{{ doneWaError }}</div>
        </template>
      </div>

      <ReceiptPreview :sale="done.receipt" />
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
        id="finish-sale-btn"
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
