<script setup lang="ts">
/**
 * Partial/full line return, damaged stock routing, and single-operation exchange modal
 * (Plan item 1.11, `ADR-026`, `PLAN.md` §10, §19).
 */
import { computed, nextTick, onMounted, reactive, ref } from 'vue';

import { describeError } from '../../api/errors';
import WalletNumberChips from './WalletNumberChips.vue';
import {
  inspectSaleForReturn,
  listRecentSalesForReturn,
  recordSaleExchange,
  recordSaleReturn,
  type ReturnableSaleInspection,
  type ReturnableSaleSummary,
  type ReturnCondition,
  type SaleExchangeOutcome,
  type SaleLine,
  type SalePaymentInput,
  type SaleReturnLineInput,
  type SaleReturnOutcome,
} from '../../api/sales';
import { withOwnerApproval } from '../../shell/approval';
import { fmtDate, fmtTime, money, num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';
import { PAY_METHODS, type PayMethodId } from './payments';
import {
  allocateDefaultRefundPayments,
  computeExchangeDifference,
  computePartialLineReturn,
  computeReturnSummaryPreview,
  RETURN_REASON_PRESETS,
} from './returns';

const props = withDefaults(
  defineProps<{
    initialSaleReference?: string | null;
    cartLines?: readonly SaleLine[];
    cartInvoiceDiscountMinor?: number;
    cartTotalMinor?: number;
    cartCustomerId?: string | null;
    isOwner?: boolean;
  }>(),
  {
    initialSaleReference: null,
    cartLines: () => [],
    cartInvoiceDiscountMinor: 0,
    cartTotalMinor: 0,
    cartCustomerId: null,
    isOwner: false,
  }
);

const emit = defineEmits<{
  close: [];
  returned: [outcome: SaleReturnOutcome];
  exchanged: [outcome: SaleExchangeOutcome];
}>();

const searchQuery = ref(props.initialSaleReference ?? '');
const searchInput = ref<HTMLInputElement | null>(null);
const recentSales = ref<readonly ReturnableSaleSummary[]>([]);
const loadingList = ref(false);
const loadingSale = ref(false);
const busy = ref(false);

const inspection = ref<ReturnableSaleInspection | null>(null);
const lineDrafts = reactive<
  Record<string, { quantity: number; condition: ReturnCondition }>
>({});
const reasonText = ref<string>(RETURN_REASON_PRESETS[0] ?? 'عدول العميل');
const refundMode = ref<'default' | PayMethodId>('default');
/** Which number pays the refund out, for a shop holding several for that method (`ADR-041`). */
const refundWalletId = ref<string | null>(null);

const hasCartItems = computed<boolean>(() => props.cartLines.length > 0);

function payMethodLabel(method: string): string {
  const m = PAY_METHODS.find((x) => x.id === method);
  return m ? m.name : method;
}

async function loadRecentSales(): Promise<void> {
  loadingList.value = true;
  try {
    recentSales.value = await listRecentSalesForReturn(
      searchQuery.value.trim() || null,
      20
    );
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    loadingList.value = false;
  }
}

async function selectSale(idOrRef: string): Promise<void> {
  const target = idOrRef.trim();
  if (!target) return;
  loadingSale.value = true;
  try {
    const info = await inspectSaleForReturn(target);
    inspection.value = info;
    for (const k of Object.keys(lineDrafts)) {
      delete lineDrafts[k];
    }
    for (const l of info.lines) {
      lineDrafts[l.lineId] = {
        quantity: 0,
        condition: 'intact',
      };
    }
    refundMode.value = 'default';
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    loadingSale.value = false;
  }
}

function selectAllRemaining(): void {
  const info = inspection.value;
  if (!info) return;
  for (const l of info.lines) {
    const cur = lineDrafts[l.lineId];
    lineDrafts[l.lineId] = {
      quantity: l.remainingQty,
      condition: cur?.condition ?? 'intact',
    };
  }
}

function setLineQty(lineId: string, maxQty: number, nextQty: number): void {
  const clamped = Math.max(0, Math.min(maxQty, Math.trunc(nextQty) || 0));
  const cur = lineDrafts[lineId];
  lineDrafts[lineId] = {
    quantity: clamped,
    condition: cur?.condition ?? 'intact',
  };
}

function setLineCondition(lineId: string, condition: ReturnCondition): void {
  const cur = lineDrafts[lineId];
  lineDrafts[lineId] = {
    quantity: cur?.quantity ?? 0,
    condition,
  };
}

const summary = computed(() => {
  if (!inspection.value) {
    return {
      lines: [],
      totalQty: 0,
      intactQty: 0,
      damagedQty: 0,
      linesNetMinor: 0,
      invoiceDiscountShareMinor: 0,
      refundMinor: 0,
      intactCostMinor: 0,
      damagedCostMinor: 0,
    };
  }
  return computeReturnSummaryPreview(inspection.value, lineDrafts);
});

const defaultRefundAllocation = computed<readonly SalePaymentInput[]>(() => {
  if (!inspection.value) return [];
  return allocateDefaultRefundPayments(
    inspection.value.payments,
    summary.value.refundMinor
  );
});

const exchangeDiff = computed(() =>
  computeExchangeDifference(summary.value.refundMinor, props.cartTotalMinor)
);

const canSubmit = computed<boolean>(() => {
  const info = inspection.value;
  if (!info || info.isCancelled || busy.value) return false;
  return summary.value.totalQty > 0 && reasonText.value.trim().length > 0;
});

function buildReturnLinesInput(): SaleReturnLineInput[] {
  return summary.value.lines.map((l) => ({
    saleLineId: l.lineId,
    quantity: l.quantity,
    condition: l.condition,
  }));
}

function buildRefundPaymentsInput(): SalePaymentInput[] | null {
  if (refundMode.value === 'default') {
    return null;
  }
  return [
    {
      method: refundMode.value,
      amountMinor: summary.value.refundMinor,
      reference: null,
      // Which number pays it out. Under «بنفس طريقة الدفع» this stays null on purpose: the
      // backend sends every refund row back out of the wallet the sale put it in (`ADR-041`).
      walletId: refundWalletId.value,
    },
  ];
}

async function submitReturn(): Promise<void> {
  const info = inspection.value;
  if (!info || !canSubmit.value) {
    if (summary.value.totalQty <= 0) {
      toast('اختار صنف واحد على الأقل للمرتجع', 'err');
    } else if (!reasonText.value.trim()) {
      toast('اكتب سبب المرتجع قبل الحفظ', 'err');
    }
    return;
  }

  const returnLines = buildReturnLinesInput();
  const refundPayments = buildRefundPaymentsInput();
  const cleanReason = reasonText.value.trim();

  busy.value = true;
  try {
    const approval = await withOwnerApproval(
      () =>
        recordSaleReturn(
          info.saleId,
          returnLines,
          cleanReason,
          refundPayments
        ),
      `موافقة المالك على مرتجع فاتورة ${info.reference}`
    );
    if (approval.status === 'cancelled') return;
    const outcome = approval.value;
    toast(
      `اتسجّل المرتجع (${outcome.returnReference}) — استرداد ${money(outcome.refundMinor)}`,
      'ok'
    );
    emit('returned', outcome);
    emit('close');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

async function submitExchange(): Promise<void> {
  const info = inspection.value;
  if (!info || !canSubmit.value || !hasCartItems.value) return;

  const returnLines = buildReturnLinesInput();
  const refundPayments = buildRefundPaymentsInput();
  const cleanReason = reasonText.value.trim();
  const newPayments: SalePaymentInput[] = [
    {
      method: refundMode.value === 'default' ? 'cash' : refundMode.value,
      amountMinor: props.cartTotalMinor,
      reference: null,
    },
  ];

  busy.value = true;
  try {
    const approval = await withOwnerApproval(
      () =>
        recordSaleExchange(
          info.saleId,
          returnLines,
          cleanReason,
          props.cartLines,
          props.cartInvoiceDiscountMinor,
          refundPayments,
          newPayments,
          props.cartCustomerId ?? info.customerId
        ),
      `موافقة المالك على استبدال فاتورة ${info.reference}`
    );
    if (approval.status === 'cancelled') return;
    const outcome = approval.value;
    const diff = outcome.netDifferenceMinor;
    const diffLabel =
      diff > 0
        ? `حصّل فرق ${money(diff)}`
        : diff < 0
          ? `رد للعميل فرق ${money(-diff)}`
          : 'بدون فرق';
    toast(
      `تم الاستبدال: فاتورة ${outcome.saleOutcome.reference} (${diffLabel})`,
      'ok'
    );
    emit('exchanged', outcome);
    emit('close');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  await loadRecentSales();
  if (props.initialSaleReference?.trim()) {
    await selectSale(props.initialSaleReference.trim());
  } else if (recentSales.value.length > 0) {
    const firstOpen =
      recentSales.value.find(
        (s) => !s.isCancelled && s.alreadyRefundedMinor < s.totalMinor
      ) ?? recentSales.value[0];
    if (firstOpen) {
      await selectSale(firstOpen.saleId);
    }
  }
  await nextTick();
  searchInput.value?.focus();
});
</script>

<template>
  <Modal
    title="مرتجع / استبدال"
    sub="مرتجع جزئي أو كلي بتكلفة السطر الأصلية · سليم للمخزن أو تالف لمخزون تالف · بـPIN المالك"
    size="wide"
    @close="emit('close')"
  >
    <div data-return-modal>
      <!-- Search & Invoice Picker -->
      <form
        class="row"
        style="gap: 8px; margin-bottom: 12px"
        @submit.prevent="
          loadRecentSales().then(() => {
            if (recentSales[0]) selectSale(recentSales[0].saleId);
          })
        "
      >
        <input
          ref="searchInput"
          v-model="searchQuery"
          class="in"
          :class="{ mono: searchQuery !== '' }"
          :dir="searchQuery ? 'ltr' : 'rtl'"
          placeholder="ابحث برقم الفاتورة أو اسم العميل أو الصنف أو IMEI..."
          data-return-search
          @input="loadRecentSales"
        />
        <button
          type="button"
          class="btn ghost"
          data-return-search-btn
          @click="
            loadRecentSales().then(() => {
              if (recentSales[0]) selectSale(recentSales[0].saleId);
            })
          "
        >
          <Icon name="search" />
          <span>بحث</span>
        </button>
      </form>

      <!-- Recent Sales Strip -->
      <div
        v-if="recentSales.length > 0"
        class="chips"
        style="margin-bottom: 14px; max-height: 88px; overflow-y: auto"
        data-return-recent-list
      >
        <button
          v-for="s in recentSales"
          :key="s.saleId"
          type="button"
          class="chip"
          :class="{ on: inspection?.saleId === s.saleId }"
          :data-return-sale-row="s.reference"
          @click="selectSale(s.saleId)"
        >
          <b class="mono" dir="ltr">{{ s.reference }}</b>
          <span>· <bdi dir="auto">{{ s.firstProductName }}</bdi></span>
          <span class="num">({{ money(s.totalMinor) }})</span>
          <span
            v-if="s.isCancelled || s.alreadyRefundedMinor >= s.totalMinor"
            class="tag danger"
            style="margin-inline-start: 4px"
          >
            مرتجع بالكامل
          </span>
          <span
            v-else-if="s.alreadyRefundedMinor > 0"
            class="tag warn"
            style="margin-inline-start: 4px"
          >
            مرتجع جزئي
          </span>
        </button>
      </div>

      <div v-if="!inspection && !loadingSale" class="empty">
        <Icon name="receipt" />
        <p>اختار فاتورة من القايمة أو ابحث برقم الفاتورة</p>
      </div>

      <div v-else-if="inspection" data-return-inspection>
        <!-- Invoice Header Summary -->
        <div
          class="card"
          style="
            padding: 10px 14px;
            margin-bottom: 12px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 10px;
          "
        >
          <div>
            <b>فاتورة <span class="mono" dir="ltr">{{ inspection.reference }}</span></b>
            <small class="muted" style="margin-inline-start: 8px">
              {{ fmtDate(new Date(inspection.occurredAt)) }} ·
              {{ fmtTime(new Date(inspection.occurredAt)) }}
            </small>
            <div style="margin-top: 4px">
              <span class="tag">
                <Icon name="user" />
                <bdi dir="auto">{{ inspection.customerName ?? 'عميل نقدي' }}</bdi>
              </span>
              <span
                v-for="(p, idx) in inspection.payments"
                :key="idx"
                class="tag"
                style="margin-inline-start: 6px"
              >
                {{ payMethodLabel(p.method) }}:
                <b class="num">{{ money(p.amountMinor) }}</b>
              </span>
            </div>
          </div>

          <div style="text-align: end">
            <div>
              <small class="muted">إجمالي الفاتورة:</small>
              <b class="num" style="margin-inline-start: 6px">{{
                money(inspection.totalMinor)
              }}</b>
            </div>
            <div v-if="inspection.alreadyRefundedMinor > 0">
              <small class="muted">مرتجع سابق:</small>
              <b class="num" style="margin-inline-start: 6px; color: var(--warn)">
                {{ money(inspection.alreadyRefundedMinor) }}
              </b>
              <small class="muted" style="margin-inline-start: 6px">متبقي:</small>
              <b class="num" style="margin-inline-start: 4px">
                {{ money(inspection.remainingRefundableMinor) }}
              </b>
            </div>
            <button
              v-if="
                !inspection.isCancelled &&
                inspection.lines.some((l) => l.remainingQty > 0)
              "
              type="button"
              class="btn sm ghost"
              style="margin-top: 4px"
              data-return-select-all
              @click="selectAllRemaining"
            >
              تحديد كل المتبقي للمرتجع
            </button>
          </div>
        </div>

        <!-- Invoice Lines Table -->
        <div class="table-wrap" style="margin-bottom: 12px">
          <table class="t">
            <thead>
              <tr>
                <th>الصنف</th>
                <th class="ta-n">المباع</th>
                <th class="ta-n">المتاح للمرتجع</th>
                <th class="ta-n">سعر الوحدة</th>
                <th class="ta-n">كمية المرتجع</th>
                <th>حالة المرتجع</th>
                <th class="ta-n">قيمة المرتجع</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="l in inspection.lines"
                :key="l.lineId"
                :data-return-line-row="l.lineNo"
              >
                <td>
                  <b><bdi dir="auto">{{ l.productName }}</bdi></b>
                  <div v-if="l.imei" style="margin-top: 2px">
                    <span class="tag mono" dir="ltr">IMEI: {{ l.imei }}</span>
                  </div>
                  <div
                    v-if="isOwner && l.unitCostMinor !== undefined"
                    class="muted"
                    style="font-size: 0.78rem"
                  >
                    تكلفة السطر الأصلية:
                    <span class="num">{{ money(l.unitCostMinor) }}</span> / قطعة
                  </div>
                </td>
                <td class="ta-n num">{{ num(l.quantity) }}</td>
                <td class="ta-n num">
                  <b :style="{ color: l.remainingQty > 0 ? '' : 'var(--muted)' }">
                    {{ num(l.remainingQty) }}
                  </b>
                </td>
                <td class="ta-n num">{{ money(l.unitSellingPriceMinor) }}</td>
                <td class="ta-n">
                  <div
                    v-if="l.remainingQty > 0 && !inspection.isCancelled"
                    class="row"
                    style="gap: 4px; justify-content: flex-end"
                  >
                    <button
                      type="button"
                      class="btn sm ghost"
                      :data-return-qty-dec="l.lineNo"
                      @click="
                        setLineQty(
                          l.lineId,
                          l.remainingQty,
                          (lineDrafts[l.lineId]?.quantity ?? 0) - 1
                        )
                      "
                    >
                      −
                    </button>
                    <input
                      type="number"
                      min="0"
                      :max="l.remainingQty"
                      :value="lineDrafts[l.lineId]?.quantity ?? 0"
                      class="in sm num"
                      style="width: 60px; text-align: center"
                      :data-return-qty="l.lineNo"
                      @input="
                        setLineQty(
                          l.lineId,
                          l.remainingQty,
                          Number(($event.target as HTMLInputElement).value)
                        )
                      "
                    />
                    <button
                      type="button"
                      class="btn sm ghost"
                      :data-return-qty-inc="l.lineNo"
                      @click="
                        setLineQty(
                          l.lineId,
                          l.remainingQty,
                          (lineDrafts[l.lineId]?.quantity ?? 0) + 1
                        )
                      "
                    >
                      +
                    </button>
                  </div>
                  <span v-else class="muted">مرتجع بالكامل</span>
                </td>
                <td>
                  <div
                    v-if="l.remainingQty > 0 && !inspection.isCancelled"
                    class="seg"
                  >
                    <button
                      type="button"
                      :class="{
                        on: (lineDrafts[l.lineId]?.condition ?? 'intact') === 'intact',
                      }"
                      :data-return-cond-intact="l.lineNo"
                      @click="setLineCondition(l.lineId, 'intact')"
                    >
                      سليم (للمخزن)
                    </button>
                    <button
                      type="button"
                      :class="{
                        on: lineDrafts[l.lineId]?.condition === 'damaged',
                      }"
                      :data-return-cond-damaged="l.lineNo"
                      @click="setLineCondition(l.lineId, 'damaged')"
                    >
                      تالف (مخزون تالف)
                    </button>
                  </div>
                  <span v-else class="muted">—</span>
                </td>
                <td class="ta-n num">
                  <b v-if="(lineDrafts[l.lineId]?.quantity ?? 0) > 0">
                    {{
                      money(
                        computePartialLineReturn(
                          l,
                          lineDrafts[l.lineId]?.quantity ?? 0,
                          lineDrafts[l.lineId]?.condition ?? 'intact'
                        )?.lineTotalMinor ?? 0
                      )
                    }}
                  </b>
                  <span v-else class="muted">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Reason & Refund Method -->
        <div class="g2" style="margin-bottom: 12px">
          <div class="field">
            <label class="lbl" for="ret-reason">سبب المرتجع / الاستبدال</label>
            <div class="chips" style="margin-bottom: 6px">
              <button
                v-for="preset in RETURN_REASON_PRESETS"
                :key="preset"
                type="button"
                class="chip"
                :class="{ on: reasonText === preset }"
                :data-return-reason-chip="preset"
                @click="reasonText = preset"
              >
                {{ preset }}
              </button>
            </div>
            <input
              id="ret-reason"
              v-model="reasonText"
              class="in"
              placeholder="اكتب سبب المرتجع..."
              data-return-reason
            />
          </div>

          <div class="field">
            <span class="lbl">طريقة رد الفلوس</span>
            <div class="chips" style="margin-bottom: 6px">
              <button
                type="button"
                class="chip"
                :class="{ on: refundMode === 'default' }"
                data-return-method="default"
                @click="refundMode = 'default'"
              >
                بنفس طريقة الدفع الأصلية (افتراضي)
              </button>
              <button
                type="button"
                class="chip"
                :class="{ on: refundMode === 'cash' }"
                data-return-method="cash"
                @click="refundMode = 'cash'"
              >
                كاش من الدرج
              </button>
              <button
                type="button"
                class="chip"
                :class="{ on: refundMode === 'vf' }"
                data-return-method="vf"
                @click="refundMode = 'vf'"
              >
                فودافون كاش
              </button>
              <button
                type="button"
                class="chip"
                :class="{ on: refundMode === 'instapay' }"
                data-return-method="instapay"
                @click="refundMode = 'instapay'"
              >
                إنستاباي
              </button>
              <button
                v-if="inspection.customerId"
                type="button"
                class="chip"
                :class="{ on: refundMode === 'credit' }"
                data-return-method="credit"
                @click="refundMode = 'credit'"
              >
                خصم من حساب الآجل
              </button>
            </div>
            <WalletNumberChips
              v-if="refundMode !== 'default'"
              :method="refundMode"
              v-model="refundWalletId"
            />
            <small v-if="refundMode === 'default'" class="hint">
              الرد الافتراضي:
              <span
                v-for="(rp, idx) in defaultRefundAllocation"
                :key="idx"
                style="margin-inline-end: 8px"
              >
                {{ payMethodLabel(rp.method) }}:
                <b class="num">{{ money(rp.amountMinor) }}</b>
              </span>
            </small>
          </div>
        </div>

        <!-- Return & Exchange Totals Box -->
        <div
          class="due-box"
          style="justify-content: space-between; flex-wrap: wrap; gap: 12px"
          data-return-summary-box
        >
          <div>
            <small>إجمالي المرتجع للعميل</small>
            <b
              class="num"
              style="font-size: 1.35rem"
              data-return-refund-total
            >
              {{ money(summary.refundMinor) }}
            </b>
            <div style="margin-top: 4px; font-size: 0.85rem">
              <span v-if="summary.intactQty > 0" class="tag ok">
                سليم للمخزن: {{ num(summary.intactQty) }} قطعة
              </span>
              <span
                v-if="summary.damagedQty > 0"
                class="tag danger"
                style="margin-inline-start: 6px"
              >
                تالف (مخزون تالف): {{ num(summary.damagedQty) }} قطعة
              </span>
            </div>
          </div>

          <div
            v-if="hasCartItems && summary.totalQty > 0"
            style="text-align: end"
            data-return-exchange-box
          >
            <small>
              استبدال مع السلة الحالية ({{ money(cartTotalMinor) }})
            </small>
            <b
              class="num"
              style="font-size: 1.35rem; display: block"
              data-return-exchange-diff
            >
              <template v-if="exchangeDiff.direction === 'customer_pays'">
                تحصّل من العميل فرق: {{ money(exchangeDiff.absDifferenceMinor) }}
              </template>
              <template v-else-if="exchangeDiff.direction === 'customer_receives'">
                ترد للعميل فرق: {{ money(exchangeDiff.absDifferenceMinor) }}
              </template>
              <template v-else>استبدال بدون فرق ({{ money(0) }})</template>
            </b>
          </div>
        </div>

        <!-- Prior Returns History on this Invoice -->
        <div
          v-if="inspection.returns.length > 0"
          style="margin-top: 12px"
          data-return-history
        >
          <small class="muted">عمليات مرتجع سابقة على الفاتورة دي:</small>
          <div class="chips" style="margin-top: 4px">
            <span
              v-for="r in inspection.returns"
              :key="r.id"
              class="tag"
            >
              <span class="mono" dir="ltr">{{ r.returnReference }}</span>
              · <b class="num">{{ money(r.refundMinor) }}</b>
              · <bdi dir="auto">{{ r.reason }}</bdi>
              <template v-if="r.exchangeReference">
                (استبدال بـ <span class="mono" dir="ltr">{{ r.exchangeReference }}</span>)
              </template>
            </span>
          </div>
        </div>
      </div>
    </div>

    <template #foot>
      <button type="button" class="btn ghost" @click="emit('close')">
        إلغاء
      </button>
      <button
        v-if="hasCartItems"
        type="button"
        class="btn primary lg"
        :disabled="!canSubmit"
        data-exchange-submit
        @click="submitExchange"
      >
        <Icon name="arrow-left-right" />
        <span>تأكيد الاستبدال مع السلة (بـPIN المالك)</span>
      </button>
      <button
        type="button"
        class="btn primary lg"
        :disabled="!canSubmit"
        data-return-submit
        @click="submitReturn"
      >
        <Icon name="check" />
        <span>تأكيد المرتجع (بـPIN المالك)</span>
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.chip.on .tag {
  background: rgba(255, 255, 255, 0.22);
  color: #fff;
  border-color: rgba(255, 255, 255, 0.35);
}
</style>
