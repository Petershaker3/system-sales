<script setup lang="ts">
// «إضافة صيانة / سوفت وير» من شاشة البيع (طلب صاحب المحل، 2026-11-02).
//
// الجهاز اللي بيتصلح وهو واقف على الكاشير: تذكرة سريعة من غير ما تسيب الفاتورة،
// بنفس `create_repair` اللي شاشة الصيانة بتستخدمه — فالتذكرة بتظهر هناك فورًا.
// الحقول كلها اللي بيتطلبها الحفظ: نوع الخدمة، الجهاز، العطل، السعر. الباقي اختياري.
import { computed, nextTick, ref } from 'vue';

import { describeError } from '../../api/errors';
import { createRepair, type RepairPayMethod, type RepairServiceKind } from '../../api/repairs';
import { HARDWARE_QUICK_ISSUES, SOFTWARE_QUICK_ISSUES } from '../repairs/repairs';
import { moneyUnitWord, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';

const emit = defineEmits<{ close: []; created: []; }>();

const kind = ref<RepairServiceKind>('software');
const device = ref('');
const issueText = ref('');
const priceText = ref('');
const paidNow = ref(true);
const payMethod = ref<RepairPayMethod>('cash');
const customerName = ref('');
const customerPhone = ref('');
const busy = ref(false);
const error = ref('');
const deviceInput = ref<HTMLInputElement | null>(null);

const issues = computed(() =>
  kind.value === 'software' ? SOFTWARE_QUICK_ISSUES : HARDWARE_QUICK_ISSUES
);

const PAY_METHODS: readonly { id: RepairPayMethod; label: string }[] = [
  { id: 'cash', label: 'كاش' },
  { id: 'vf', label: 'فودافون كاش' },
  { id: 'instapay', label: 'إنستاباي' },
];

function toggleIssue(word: string): void {
  const parts = issueText.value
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  const at = parts.indexOf(word);
  if (at >= 0) parts.splice(at, 1);
  else parts.push(word);
  issueText.value = parts.join(' + ');
}

function isIssueOn(word: string): boolean {
  return issueText.value
    .split('+')
    .map((p) => p.trim())
    .includes(word);
}

async function submit(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  if (!device.value.trim()) {
    error.value = 'اكتب موديل الجهاز.';
    return;
  }
  if (!issueText.value.trim()) {
    error.value = kind.value === 'software' ? 'اختار عملية السوفت وير.' : 'اختار العطل.';
    return;
  }
  const priceMinor = parseMoney(priceText.value) ?? 0;
  if (priceMinor < 0) {
    error.value = 'السعر مش صحيح.';
    return;
  }

  busy.value = true;
  try {
    const created = await createRepair({
      serviceKind: kind.value,
      customerName: customerName.value.trim(),
      customerPhone: customerPhone.value.trim(),
      deviceName: device.value.trim(),
      issue: issueText.value.trim(),
      estimatedPriceMinor: priceMinor,
      depositMinor: paidNow.value ? priceMinor : 0,
      payMethod: payMethod.value,
      // «مدفوع دلوقتي» معناه الجهاز اتسلّم من نفس الشاشة؛ التذكرة بتتقفل
      // عشان ما تفضلش معلّقة في «الصيانة» وهي خلصت.
      deliverNow: paidNow.value,
    });
    toast(
      paidNow.value
        ? `تذكرة ${created.ticketNo} اتسجّلت واتحصّل ${priceMinor / 100} ج`
        : `تذكرة ${created.ticketNo} مفتوحة في «الصيانة»`,
      'ok',
      4000,
    );
    emit('created');
    emit('close');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}

nextTick(() => deviceInput.value?.focus());
</script>

<template>
  <Modal title="إضافة صيانة / سوفت وير" sub="من غير ما تسيب شاشة البيع" size="md" @close="emit('close')">
    <form id="quick-repair-form" class="qr" data-quick-repair @submit.prevent="submit">
      <div class="seg" role="group" aria-label="نوع الخدمة">
        <button
          type="button"
          class="seg-b"
          :class="{ on: kind === 'software' }"
          data-quick-repair-kind="software"
          @click="kind = 'software'"
        >
          <Icon name="wrench" /> سوفت وير
        </button>
        <button
          type="button"
          class="seg-b"
          :class="{ on: kind === 'hardware' }"
          data-quick-repair-kind="hardware"
          @click="kind = 'hardware'"
        >
          <Icon name="smartphone" /> صيانة
        </button>
      </div>

      <div class="row" style="gap: 10px; flex-wrap: wrap">
        <label class="field" style="flex: 1; min-width: 160px">
          <span>الجهاز</span>
          <input ref="deviceInput" v-model="device" autocomplete="off" placeholder="مثال: A15 / infinix hot 10" data-quick-repair-device />
        </label>
        <label class="field" style="flex: 1; min-width: 140px">
          <span>السعر ({{ moneyUnitWord() }})</span>
          <input v-model="priceText" inputmode="decimal" autocomplete="off" placeholder="0" data-quick-repair-price />
        </label>
      </div>

      <div class="qr-issues">
        <button
          v-for="word in issues"
          :key="word"
          type="button"
          class="btn sm"
          :class="{ primary: isIssueOn(word) }"
          :data-quick-repair-issue="word"
          @click="toggleIssue(word)"
        >
          {{ word }}
        </button>
      </div>

      <label class="field">
        <span>بيان إضافي (اختياري)</span>
        <input v-model="issueText" autocomplete="off" placeholder="أو اكتب العطل بنفسك" data-quick-repair-issue-text />
      </label>

      <div class="row" style="gap: 10px; flex-wrap: wrap">
        <label class="field" style="flex: 1; min-width: 140px">
          <span>اسم العميل (اختياري)</span>
          <input v-model="customerName" autocomplete="off" data-quick-repair-customer />
        </label>
        <label class="field" style="flex: 1; min-width: 140px">
          <span>التليفون (اختياري)</span>
          <input v-model="customerPhone" inputmode="tel" dir="ltr" autocomplete="off" data-quick-repair-phone />
        </label>
      </div>

      <label class="qr-check">
        <input v-model="paidNow" type="checkbox" data-quick-repair-paid />
        <span>مدفوع واتسلّم دلوقتي (يظهر في الدرج ويروح للتقارير)</span>
      </label>

      <div v-if="paidNow" class="seg" role="group" aria-label="طريقة الدفع">
        <button
          v-for="m in PAY_METHODS"
          :key="m.id"
          type="button"
          class="seg-b"
          :class="{ on: payMethod === m.id }"
          :data-quick-repair-pay="m.id"
          @click="payMethod = m.id"
        >
          {{ m.label }}
        </button>
      </div>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </form>

    <template #foot>
      <button type="submit" form="quick-repair-form" class="btn primary" :disabled="busy" data-quick-repair-save>
        <Icon name="check" /> سجّل التذكرة
      </button>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع للفاتورة</button>
    </template>
  </Modal>
</template>

<style scoped>
.qr { display: flex; flex-direction: column; gap: 12px; }
.qr .seg { display: flex; gap: 6px; }
.qr-issues { display: flex; flex-wrap: wrap; gap: 6px; }
.qr-check { display: flex; align-items: center; gap: 8px; font-size: .86rem; }
</style>
