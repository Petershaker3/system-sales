<script setup lang="ts">
// «فحص الـIMEI» (`ADR-032`, `PLAN.md` §13): Luhn check, TAC prefix, local unit
// & repair history in the shop, and NTRA / `*#06#` verification checklist.
import { computed, onMounted, ref } from 'vue';

import { checkImei, type ImeiCheckResult } from '../../api/brands';
import { describeError } from '../../api/errors';
import { money } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import CameraScanButton from '../../ui/CameraScanButton.vue';
import type { ScanReading } from '../../ui/scan';
import Modal from '../../ui/Modal.vue';
import { gradeArabicLabel } from './phone';

const props = defineProps<{
  initialImei?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const imeiInput = ref(props.initialImei ?? '');
const report = ref<ImeiCheckResult | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const inputEl = ref<HTMLInputElement | null>(null);

const unitStatusLabel = computed(() => {
  const st = report.value?.localUnit?.status;
  if (st === 'in_stock') return 'موجود في المخزن حالياً';
  if (st === 'sold') return 'اتبايع في المحل قبل كده';
  if (st === 'retired') return 'مرتجع / متقاعد';
  return st ?? '';
});

/**
 * A camera reading into the IMEI field (`ADR-043`).
 *
 * The check is deliberately not run automatically: the shopkeeper usually wants to
 * confirm the number is the one on the box before spending a query on it.
 */
function onScan(reading: ScanReading): void {
  imeiInput.value = reading.digits === '' ? reading.raw : reading.digits;
}

async function runCheck(): Promise<void> {
  const raw = imeiInput.value.trim();
  if (!raw || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    report.value = await checkImei(raw);
  } catch (e) {
    error.value = describeError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  inputEl.value?.focus();
  if (props.initialImei?.trim()) {
    void runCheck();
  }
});
</script>

<template>
  <Modal
    title="فحص الـ IMEI وسجل الجهاز"
    sub="التحقق الحسابي (Luhn) + سجل البيع والمخزن والصيانة في المحل + خطوات فحص تليفوني NTRA"
    size="md"
    @close="emit('close')"
  >
    <div v-if="error" class="err" role="alert">{{ error }}</div>

    <div class="field">
      <label class="lbl" for="imei-check-input">
        رقم الـ IMEI (15 رقم — اطلب <bdi dir="ltr">*#06#</bdi> على الموبايل)
      </label>
      <div class="search-row">
        <input
          id="imei-check-input"
          ref="inputEl"
          v-model="imeiInput"
          class="in"
          :class="{ mono: imeiInput !== '' }"
          :dir="imeiInput ? 'ltr' : 'rtl'"
          maxlength="20"
          placeholder="اكتب أو امسح الـ 15 رقم..."
          @keydown.enter.prevent="runCheck"
        />
        <CameraScanButton :compact="true" data-imei-check-scan @scan="onScan" />
        <button
          type="button"
          class="btn primary"
          data-imei-check-submit
          :disabled="!imeiInput.trim() || busy"
          @click="runCheck"
        >
          <Icon name="search" /> افحص الـ IMEI
        </button>
      </div>
    </div>

    <div v-if="report" class="report-card" data-imei-check-result>
      <!-- 1. Luhn & Format Check -->
      <div class="check-sec">
        <div class="sec-title">1. الفحص الحسابي (Luhn Check)</div>
        <div class="badges-row">
          <span v-if="report.luhnValid" class="tag ok" data-imei-luhn-ok>
            ✓ رقم IMEI صحيح حسابياً (15 رقم + رقم التحقق سليم)
          </span>
          <span v-else-if="!report.formatValid" class="tag err-tag" data-imei-luhn-err>
            ✗ لازم يكون 15 رقم بالظبط (المكتوب: {{ report.digitCount }} رقم)
          </span>
          <span v-else class="tag err-tag" data-imei-luhn-err>
            ✗ رقم التحقق الأخير (Luhn) غلط — راجع كتابة الرقم من شاشة الجهاز
          </span>
          <span v-if="report.tac" class="tag mono" dir="ltr">TAC: {{ report.tac }}</span>
        </div>
      </div>

      <!-- 2. Local Unit History -->
      <div class="check-sec">
        <div class="sec-title">2. سجل الجهاز في مخزن المحل</div>
        <div v-if="report.localUnit" class="unit-box" data-imei-local-unit>
          <div class="unit-head">
            <strong><bdi dir="rtl">{{ report.localUnit.productName }}</bdi></strong>
            <span
              class="tag"
              :class="{
                ok: report.localUnit.status === 'in_stock',
                'warn-tag': report.localUnit.status !== 'in_stock',
              }"
            >
              {{ unitStatusLabel }}
            </span>
          </div>
          <div class="unit-meta">
            <span>IMEI 1: <b class="mono" dir="ltr">{{ report.localUnit.imei }}</b></span>
            <span v-if="report.localUnit.imei2">
              IMEI 2: <b class="mono" dir="ltr">{{ report.localUnit.imei2 }}</b>
            </span>
            <span v-if="report.localUnit.conditionGrade">
              الحالة: <b>{{ gradeArabicLabel(report.localUnit.conditionGrade) }}</b>
            </span>
            <span v-if="report.localUnit.batteryHealthPct !== null">
              البطارية: <b class="mono" dir="ltr">{{ report.localUnit.batteryHealthPct }}%</b>
            </span>
            <span v-if="report.localUnit.color">اللون: <b>{{ report.localUnit.color }}</b></span>
            <span v-if="report.localUnit.accessories">
              معاه: <b>{{ report.localUnit.accessories }}</b>
            </span>
            <span v-if="report.localUnit.unitCostMinor !== null">
              تكلفة الشراء: <b>{{ money(report.localUnit.unitCostMinor) }}</b>
            </span>
          </div>
          <div v-if="report.localUnit.intakeNote" class="unit-note">
            ملاحظات الفحص: {{ report.localUnit.intakeNote }}
          </div>
          <div
            v-if="
              report.localUnit.sellerName ||
              report.localUnit.sellerPhone ||
              report.localUnit.sellerNationalId
            "
            class="unit-seller"
          >
            <span>بيانات اللي باعه للمحل:</span>
            <b v-if="report.localUnit.sellerName">{{ report.localUnit.sellerName }}</b>
            <span v-if="report.localUnit.sellerPhone" class="mono" dir="ltr">
              {{ report.localUnit.sellerPhone }}
            </span>
            <span v-if="report.localUnit.sellerNationalId">
              بطاقة: <b class="mono" dir="ltr">{{ report.localUnit.sellerNationalId }}</b>
            </span>
          </div>
        </div>
        <div v-else class="empty-sec" data-imei-no-local-unit>
          مش متسجل في مخزن المحل قبل كده.
        </div>
      </div>

      <!-- 3. Local Repairs History -->
      <div class="check-sec">
        <div class="sec-title">3. سجل الصيانة والسوفت وير في المحل</div>
        <div v-if="report.repairs.length > 0" class="repairs-list" data-imei-repairs>
          <div v-for="rep in report.repairs" :key="rep.ticketNo" class="rep-item">
            <span class="mono" dir="ltr">{{ rep.ticketNo }}</span>
            <b><bdi dir="auto">{{ rep.deviceName }}</bdi></b>
            <span>— {{ rep.issue }}</span>
            <span class="muted">({{ rep.customerName }})</span>
          </div>
        </div>
        <div v-else class="empty-sec">ملوش تذاكر صيانة سابقة في المحل.</div>
      </div>
    </div>

    <!-- 4. Checklist before buying a used device -->
    <div class="ntra-checklist">
      <div class="sec-title">خطوات تأكيد الفحص قبل الشراء من عميل:</div>
      <ul>
        <li>
          اطلب <b class="mono" dir="ltr">*#06#</b> على الجهاز وقارن الـ IMEI بالمطبوع على العلبة وبيت الشريحة.
        </li>
        <li>
          افحص الرقم في تطبيق <b>تليفوني (NTRA)</b> للتأكد من عدم وجود ضرائب جمركية مستحقة أو إيقاف للشبكة.
        </li>
        <li>
          اتأكد من خروج العميل من حساب <b>iCloud / Google Account</b> وفرمتة الجهاز قدامه، وسجّل صورة بطاقته الـ14 رقم.
        </li>
      </ul>
    </div>

    <template #foot>
      <span class="sp"></span>
      <button type="button" class="btn ghost" @click="emit('close')">إغلاق</button>
    </template>
  </Modal>
</template>

<style scoped>
.sp {
  flex: 1;
}
.search-row {
  display: flex;
  gap: 8px;
}
.report-card {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}
.check-sec {
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--r-m);
  background: var(--surface-2);
}
.sec-title {
  margin-bottom: 8px;
  font-weight: 700;
  font-size: var(--fs-sm);
}
.badges-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.tag.ok {
  background: var(--ok-soft);
  color: var(--ok-text);
}
.tag.err-tag {
  background: var(--danger-soft);
  color: var(--danger-text);
}
.tag.warn-tag {
  background: var(--warn-soft, var(--surface));
  color: var(--warn-text, var(--text));
}
.unit-box {
  display: grid;
  gap: 6px;
}
.unit-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.unit-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: var(--fs-sm);
}
.unit-note,
.unit-seller {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding-top: 4px;
  border-top: 1px dashed var(--border);
  font-size: var(--fs-sm);
}
.empty-sec {
  color: var(--text-muted);
  font-size: var(--fs-sm);
}
.repairs-list {
  display: grid;
  gap: 6px;
  font-size: var(--fs-sm);
}
.rep-item {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.ntra-checklist {
  margin-top: 12px;
  padding: 10px 12px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-m);
  background: var(--surface-2);
  font-size: var(--fs-sm);
}
.ntra-checklist ul {
  margin: 4px 0 0;
  padding-inline-start: 18px;
  display: grid;
  gap: 4px;
}
.err {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--danger-border);
  border-radius: var(--r-s);
  background: var(--danger-soft);
  color: var(--danger-text);
  font-weight: 600;
}
</style>
