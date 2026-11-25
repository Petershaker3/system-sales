<script setup lang="ts">
// Modal for opening a shift and closing a shift in <= 3 minutes with Egyptian
// denomination counter, expected vs counted drawer reconciliation, difference
// badge, and WhatsApp shift report (`docs/PLAN.md` §12, `ADR-024`, `docs/ui/mockup-v1/pos.js`).
import { computed, reactive, ref, watch } from 'vue';

import { describeError } from '../api/errors';
import type { Session } from '../api/identity';
import {
  closeShift,
  recordShiftCashCount,
  latestShiftCashCount,
  type ShiftCashCount,
  openShift,
  type CurrentShiftState,
  type ShiftSummary,
} from '../api/shift';
import {
  denomTotalMinor,
  EGYPTIAN_DENOMS,
  sendShiftReportViaWhatsApp,
  shiftDifferenceState,
} from '../screens/pos/shift';
import { appearance } from '../ui/appearance';
import {
  fmtTime,
  money,
  moneyInputValue,
  moneyUnitWord,
  num,
  parseCount,
  parseMoney,
} from '../ui/format';
import CashDrawerSetup from './CashDrawerSetup.vue';
import Icon from '../ui/Icon.vue';
import Modal from '../ui/Modal.vue';
import { toast } from '../ui/toast';

const props = defineProps<{
  session: Session;
  shiftState: CurrentShiftState;
}>();

const emit = defineEmits<{
  close: [];
  changed: [];
}>();

const busy = ref(false);

// --- Open shift form state (when no shift is open) ---
// The opening and counted cash must be physically entered; a forecast is not a count.
const openingCashText = ref('');

const nextShiftNumber = computed(() => {
  const prevNo = props.shiftState.lastClosedShift?.shiftNumber ?? 0;
  return prevNo + 1;
});

// --- Close shift form state (when a shift is open) ---
const denomCounts = reactive<Record<string, string>>({
  '200': '',
  '100': '',
  '50': '',
  '20': '',
  '10': '',
  '5': '',
  '1': '',
  '0.5': '',
});

const countedCashText = ref('');
const closeNote = ref('');

const savedCount = ref<ShiftCashCount | null>(null);
const countLoadFailed = ref(false);
let countRequest = 0;
watch(() => props.shiftState.openShift?.shift.id, async (id) => {
  const request = ++countRequest;
  countedCashText.value = '';
  savedCount.value = null;
  countLoadFailed.value = false;
  if (!id) return;
  try {
    const count = await latestShiftCashCount();
    if (request === countRequest && count?.shiftId === id) savedCount.value = count;
  } catch { if (request === countRequest) countLoadFailed.value = true; }
}, { immediate: true });

function onDenomInput(): void {
  const numericCounts: Record<string, number> = {};
  let anyTyped = false;
  for (const d of EGYPTIAN_DENOMS) {
    const raw = (denomCounts[String(d)] ?? '').trim();
    if (raw !== '') {
      const parsed = parseCount(raw);
      if (parsed !== null && parsed >= 0) {
        numericCounts[String(d)] = parsed;
        anyTyped = true;
      }
    }
  }
  if (anyTyped) {
    const minor = denomTotalMinor(numericCounts);
    countedCashText.value = moneyInputValue(minor);
  }
}

const countedCashMinor = computed<number | null>(() => {
  const parsed = parseMoney(countedCashText.value);
  return parsed !== null && parsed >= 0 ? parsed : null;
});
const differenceMinor = computed<number | null>(() => {
  if (countedCashMinor.value === null || !props.shiftState.openShift) return null;
  return countedCashMinor.value - props.shiftState.openShift.totals.expectedCashMinor;
});
const diffInfo = computed(() => differenceMinor.value === null ? null : shiftDifferenceState(differenceMinor.value));

const canCloseShift = computed<boolean>(() => {
  return (
    props.session.role === 'manager' ||
    appearance.sellerCanCloseShift === 'on'
  );
});

async function submitOpenShift(): Promise<void> {
  if (busy.value) return;
  const minor = parseMoney(openingCashText.value);
  if (minor === null || minor < 0) {
    toast('اكتب رصيد بداية الدرج بشكل صحيح (0 أو أكبر)', 'err');
    return;
  }
  busy.value = true;
  try {
    const summary: ShiftSummary = await openShift(minor);
    toast(
      `تم فتح الوردية #${summary.shift.shiftNumber} برصيد ${money(minor)}`,
      'ok'
    );
    emit('changed');
    emit('close');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

function sendWhatsAppReport(): void {
  const open = props.shiftState.openShift;
  if (!open || countedCashMinor.value === null) { toast('عدّ النقدية واكتب المعدود أولاً', 'err'); return; }
  const sent = sendShiftReportViaWhatsApp(
    open,
    appearance.shopName,
    appearance.shopPhone,
    countedCashMinor.value,
    closeNote.value.trim() || null
  );
  toast(`تقرير الوردية للمالك: ${sent.note}`, 'ok');
}

async function submitCashCount(): Promise<void> {
  if (busy.value || !props.shiftState.openShift) return;
  const minor = countedCashMinor.value;
  if (minor === null) { toast('اكتب المعدود الفعلي في الدرج بشكل صحيح', 'err'); return; }
  busy.value = true;
  try {
    const count = await recordShiftCashCount(minor);
    if (count.shiftId !== props.shiftState.openShift?.shift.id) throw new Error('SHIFT_CHANGED');
    savedCount.value = count;
    countLoadFailed.value = false;
    toast('تم تسجيل العدّ فقط؛ الوردية لا تزال مفتوحة وغير مطابقة', 'ok');
  } catch (err) { toast(describeError(err), 'err'); }
  finally { busy.value = false; }
}

async function submitOperationalClose(): Promise<void> {
  if (busy.value || !canCloseShift.value || countedCashMinor.value === null || !props.shiftState.openShift) return;
  busy.value = true;
  try {
    await closeShift(props.shiftState.openShift.shift.id, countedCashMinor.value, closeNote.value.trim() || null);
    toast('تم إغلاق الوردية تشغيلياً وتسجيل العدّ؛ المطابقة المالية لا تزال معلّقة', 'ok');
    emit('changed');
    emit('close');
  } catch (err) { toast(describeError(err), 'err'); }
  finally { busy.value = false; }
}

</script>

<template>
  <Modal
    :title="
      shiftState.openShift
        ? `تقفيل الوردية #${shiftState.openShift.shift.shiftNumber}`
        : `فتح وردية جديدة #${nextShiftNumber}`
    "
    :sub="
      shiftState.openShift
        ? `مفتوحة من ${fmtTime(new Date(shiftState.openShift.shift.openedAt))} — عدّ النقدية؛ تقدير الدرج غير مُراجَع`
        : 'اكتب رصيد الفكة والنقدية الموجودة في الدرج لبداية الوردية'
    "
    :size="shiftState.openShift ? 'wide' : 'md'"
    @close="emit('close')"
  >
    <CashDrawerSetup v-if="session.role === 'manager'" :can-configure="!shiftState.openShift" />
    <!-- Open a new shift -->
    <div v-if="!shiftState.openShift" data-open-shift-view>
      <form @submit.prevent="submitOpenShift">
        <div class="field">
          <label class="lbl">رصيد بداية الوردية في الدرج ({{ moneyUnitWord() }})</label>
          <input
            v-model="openingCashText"
            class="in"
            :class="{ mono: openingCashText !== '' }"
            :dir="openingCashText ? 'ltr' : 'rtl'"
            inputmode="decimal"
            placeholder="1000"
            data-open-shift-cash
          />
        </div>
        <div class="chips" style="margin-top: 8px">
          <button
            v-for="preset in ['0', '500', '1000', '2000']"
            :key="preset"
            type="button"
            class="chip num"
            :data-open-shift-preset="preset"
            @click="openingCashText = moneyInputValue(Number(preset) * 100)"
          >
            {{ money(Number(preset) * 100) }}
          </button>
        </div>

        <div
          v-if="shiftState.lastClosedShift"
          class="note"
          style="margin-top: 12px"
          data-last-closed-shift-hint
        >
          <Icon name="info" />
          <span>
            الوردية اللي فاتت (#{{ shiftState.lastClosedShift.shiftNumber }}) سُجل لها مبلغ إغلاق
            <b v-if="shiftState.lastClosedShift.countedCashMinor !== null" class="num">{{ money(shiftState.lastClosedShift.countedCashMinor) }}</b><b v-else>غير متاح</b>؛ مصدر العدّ القديم قد لا يكون مثبتاً والمطابقة معلّقة. عدّ النقدية مجدداً ولا تعتبر الرقم السابق رصيداً مؤكداً.
          </span>
          <span v-if="parseMoney(openingCashText) !== null && shiftState.lastClosedShift.countedCashMinor !== null" data-shift-handover-difference>
            الفرق بين العدّ الجديد والمبلغ السابق (قد يختلف مصدرهما): {{ money((parseMoney(openingCashText) ?? 0) - shiftState.lastClosedShift.countedCashMinor) }} — فرق تسليم غير مُطابَق.
          </span>
        </div>

        <div
          v-if="shiftState.recentClosedShifts.length > 0"
          style="margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px"
          data-recent-closed-shifts
        >
          <div class="lbl" style="margin-bottom: 6px">آخر ورديات اتقفلت</div>
          <div style="display: flex; flex-direction: column; gap: 6px; max-height: 150px; overflow-y: auto">
            <div
              v-for="s in shiftState.recentClosedShifts.slice(0, 4)"
              :key="s.id"
              class="row"
              style="
                justify-content: space-between;
                padding: 6px 10px;
                border-radius: 8px;
                background: var(--surface-2);
                font-size: 13px;
              "
            >
              <span>
                <b>وردية #{{ s.shiftNumber }}</b>
                <small v-if="s.closeNote" class="muted"> — {{ s.closeNote }}</small>
              </span>
              <span class="num">
                معدود: <b v-if="s.countedCashMinor !== null">{{ money(s.countedCashMinor) }}</b><b v-else>غير متاح</b>
                (المطابقة معلّقة)
              </span>
            </div>
          </div>
        </div>
      </form>
    </div>

    <!-- Close current open shift -->
    <div v-else data-close-shift-view>
      <div class="note" role="alert" data-shift-unreconciled style="margin-bottom: 12px; border-color: var(--warn)">
        الإغلاق تشغيلي فقط بعد عدّ النقدية. مصادر النقدية غير مُطابَقة والفرق تقديري، وتظل المراجعة معلّقة للوردية التالية.
      </div>
      <p v-if="countLoadFailed" role="alert" data-shift-count-failed>تعذّر تحميل آخر عدّ؛ لا نفترض أنه صفر أو غير موجود.</p>
      <p v-else-if="savedCount" data-shift-count-state>آخر عدّ مسجّل: {{ money(savedCount.amountMinor) }} — غير مُطابَق، والوردية لا تزال مفتوحة.</p>
      <p v-else data-shift-count-state>لم يُسجّل عدّ لهذه الوردية؛ مصادر النقدية غير مُطابَقة.</p>
      <div
        v-if="!canCloseShift"
        class="note"
        style="margin-bottom: 12px; border-color: var(--warn)"
        data-shift-close-locked
      >
        <Icon name="lock-keyhole" />
        <span>
تقفيل الوردية للمالك أو لمن سمح له المالك فقط؛ الإغلاق تشغيلي وليس مطابقة مالية.
        </span>
      </div>

      <div
        style="
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
          gap: 16px;
          align-items: start;
        "
      >
        <!-- Left column: Expected drawer & shift sales summary -->
        <div
          style="
            background: var(--surface-2);
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 14px;
          "
        >
          <div class="lbl" style="margin-bottom: 8px">تقدير حركة النقدية حسب توقيت الحركات — غير مُراجَع</div>
          <table class="tbl" style="width: 100%; font-size: 13.5px">
            <tbody>
              <tr>
                <td>رصيد بداية الوردية</td>
                <td class="num" style="text-align: end" data-shift-opening-cash>
                  {{ money(shiftState.openShift.totals.openingCashMinor) }}
                </td>
              </tr>
              <tr>
                <td>+ مبيعات كاش</td>
                <td class="num" style="text-align: end" data-shift-cash-sales>
                  + {{ money(shiftState.openShift.totals.cashSalesMinor) }}
                </td>
              </tr>
              <tr v-if="shiftState.openShift.totals.customerCashInMinor > 0">
                <td>+ تحصيل آجل كاش</td>
                <td class="num" style="text-align: end" data-shift-customer-cash>
                  + {{ money(shiftState.openShift.totals.customerCashInMinor) }}
                </td>
              </tr>
              <tr v-if="shiftState.openShift.totals.servicesCashInMinor > 0">
                <td>+ خدمات ومحافظ داخل الدرج</td>
                <td class="num" style="text-align: end" data-shift-services-in>
                  + {{ money(shiftState.openShift.totals.servicesCashInMinor) }}
                </td>
              </tr>
              <tr v-if="shiftState.openShift.totals.servicesCashOutMinor > 0">
                <td>− سحب محافظ خارج من الدرج</td>
                <td class="num" style="text-align: end" data-shift-services-out>
                  − {{ money(shiftState.openShift.totals.servicesCashOutMinor) }}
                </td>
              </tr>
              <tr v-if="shiftState.openShift.totals.walletDrawerNetMinor !== 0">
                <td>شحن وتفريغ المحافظ من الدرج</td>
                <td class="num" style="text-align: end" data-shift-wallet-drawer>
                  {{ shiftState.openShift.totals.walletDrawerNetMinor > 0 ? '+ ' : '− '
                  }}{{ money(Math.abs(shiftState.openShift.totals.walletDrawerNetMinor)) }}
                </td>
              </tr>
              <tr v-if="shiftState.openShift.totals.cashInMinor > 0">
                <td>+ إيداع فكة بالدرج</td>
                <td class="num" style="text-align: end" data-shift-cash-in>
                  + {{ money(shiftState.openShift.totals.cashInMinor) }}
                </td>
              </tr>
              <tr>
                <td>− مصروفات من الدرج ({{ shiftState.openShift.expenses.length }})</td>
                <td class="num" style="text-align: end" data-shift-expenses>
                  − {{ money(shiftState.openShift.totals.expensesMinor) }}
                </td>
              </tr>
              <tr>
                <td>− سحب المالك</td>
                <td class="num" style="text-align: end" data-shift-owner-draw>
                  − {{ money(shiftState.openShift.totals.ownerDrawMinor) }}
                </td>
              </tr>
              <tr style="font-weight: 800; font-size: 15px; border-top: 2px solid var(--border)">
                <td>= تقدير غير مُراجَع</td>
                <td class="num" style="text-align: end" data-shift-expected-cash>
                  {{ money(shiftState.openShift.totals.expectedCashMinor) }}
                </td>
              </tr>
            </tbody>
          </table>

          <div class="lbl" style="margin-top: 14px; margin-bottom: 6px">
            طرق الدفع التانية وملخص الوردية ({{ shiftState.openShift.totals.salesCount }} فاتورة)
          </div>
          <table class="tbl" style="width: 100%; font-size: 13px">
            <tbody>
              <tr>
                <td>فودافون كاش</td>
                <td class="num" style="text-align: end">
                  {{ money(shiftState.openShift.totals.vfSalesMinor) }}
                </td>
              </tr>
              <tr>
                <td>إنستاباي</td>
                <td class="num" style="text-align: end">
                  {{ money(shiftState.openShift.totals.instapaySalesMinor) }}
                </td>
              </tr>
              <tr v-if="shiftState.openShift.totals.cardSalesMinor > 0">
                <td>فيزا / ميزة</td>
                <td class="num" style="text-align: end">
                  {{ money(shiftState.openShift.totals.cardSalesMinor) }}
                </td>
              </tr>
              <tr v-if="shiftState.openShift.totals.installSalesMinor > 0">
                <td>تقسيط</td>
                <td class="num" style="text-align: end">
                  {{ money(shiftState.openShift.totals.installSalesMinor) }}
                </td>
              </tr>
              <tr>
                <td>آجل جديد على العملاء</td>
                <td class="num" style="text-align: end">
                  {{ money(shiftState.openShift.totals.creditSalesMinor) }}
                </td>
              </tr>
              <tr style="font-weight: 700">
                <td>إجمالي مبيعات الوردية</td>
                <td class="num" style="text-align: end" data-shift-sales-total>
                  {{ money(shiftState.openShift.totals.salesTotalMinor) }}
                </td>
              </tr>
              <tr v-if="session.role === 'manager'" style="font-weight: 700">
                <td>ربح تقديري غير مُراجَع</td>
                <td class="num" style="text-align: end" data-shift-net-profit>
                  {{ money(shiftState.openShift.totals.netProfitMinor) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Right column: Denomination counter & actual counted cash -->
        <div>
          <div class="row" style="justify-content: space-between; margin-bottom: 8px">
            <label class="lbl" style="margin: 0">عدّ الفئات المصرية (اختياري يحسبلك الإجمالي)</label>

          </div>

          <div
            style="
              display: grid;
              grid-template-columns: repeat(2, 1fr);
              gap: 8px;
              margin-bottom: 12px;
            "
          >
            <div
              v-for="denom in EGYPTIAN_DENOMS"
              :key="denom"
              class="row"
              :data-denom-row="denom"
              style="
                justify-content: space-between;
                padding: 5px 8px;
                border: 1px solid var(--border);
                border-radius: 8px;
                background: var(--surface-2);
                gap: 6px;
              "
            >
              <span class="num" style="font-weight: 700; min-width: 54px">
                {{ num(denom) }} ج
              </span>
              <input
                v-model="denomCounts[String(denom)]"
                class="in sm"
                :class="{ mono: (denomCounts[String(denom)] ?? '') !== '' }"
                dir="ltr"
                inputmode="numeric"
                placeholder="0"
                style="width: 68px; text-align: center"
                :data-denom-input="denom"
                @input="onDenomInput"
              />
            </div>
          </div>

          <div class="field">
            <label class="lbl">المعدود الفعلي في الدرج ({{ moneyUnitWord() }})</label>
            <input
              v-model="countedCashText"
              class="in"
              :class="{ mono: countedCashText !== '' }"
              :dir="countedCashText ? 'ltr' : 'rtl'"
              inputmode="decimal"
              placeholder="0"
              style="font-size: 18px; font-weight: 800"
              data-shift-counted-input
            />
          </div>

          <div
            class="row"
            v-if="diffInfo"
            data-shift-diff-banner
            :data-shift-diff-state="diffInfo.state"
            style="
              justify-content: space-between;
              padding: 10px 12px;
              border-radius: 10px;
              margin-top: 10px;
              font-weight: 800;
              background: var(--surface-2);
              border: 1px solid var(--border);
            "
          >
            <span>الفرق عن التقدير غير المُراجَع:</span>
            <span data-shift-diff-label>{{ diffInfo.label }}</span>
          </div>

          <div class="field" style="margin-top: 10px">
            <label class="lbl">ملاحظة تقفيل الوردية (اختياري)</label>
            <input
              v-model="closeNote"
              class="in"
              placeholder="مثلًا: الدرج مظبوط أو سبب أي فرق..."
              data-shift-close-note
            />
          </div>
        </div>
      </div>
    </div>

    <template #foot>
      <button type="button" class="btn" @click="emit('close')">إلغاء</button>
      <template v-if="!shiftState.openShift">
        <button
          type="button"
          class="btn primary"
          :disabled="busy"
          data-open-shift-submit
          @click="submitOpenShift"
        >
          <Icon name="check" /> فتح الوردية وبدء البيع
        </button>
      </template>
      <template v-else>
        <button
          type="button"
          class="btn"
          :disabled="countedCashMinor === null"
          data-shift-wa-send
          @click="sendWhatsAppReport"
        >
          <Icon name="message-circle" /> إرسال التقرير واتساب للمالك
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="busy || countedCashMinor === null"
          data-shift-record-count
          @click="submitCashCount"
        >
          <Icon name="check" /> تسجيل العدّ فقط
        </button>
        <button type="button" class="btn" :disabled="busy || !canCloseShift || countedCashMinor === null" data-close-shift-submit @click="submitOperationalClose">إغلاق تشغيلي (غير مُطابَق)</button>
      </template>
    </template>
  </Modal>
</template>
