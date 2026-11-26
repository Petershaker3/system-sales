<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { refundRepairCase, repairRefundAllocation, type RefundRepairCase } from '../../api/sales';
import { describeError } from '../../api/errors';
import { money, moneyUnitWord, parseMoney, fmtLong } from '../../ui/format';

const props = defineProps<{ saleId: string }>();
const data = ref<RefundRepairCase | null>(null);
const error = ref(''); const busy = ref(false);
const original = ref(''); const reversal = ref(''); const amount = ref('');
const reason = ref(''); const evidence = ref(''); const acknowledged = ref(false);
const request = ref<string | null>(null);
let generation = 0;
const parsed = computed(() => parseMoney(amount.value));
watch([original, reversal, amount, reason, evidence, acknowledged], () => { request.value = null; });
watch(() => props.saleId, () => { generation++; data.value = null; original.value = ''; reversal.value = ''; error.value = ''; });
async function load(): Promise<void> {
  const g = ++generation; busy.value = true; error.value = '';
  try { const result = await refundRepairCase(props.saleId); if (g === generation) data.value = result; }
  catch (err) { if (g === generation) error.value = describeError(err); }
  finally { if (g === generation) busy.value = false; }
}
async function submit(): Promise<void> {
  if (busy.value || !original.value || !reversal.value || !parsed.value || !reason.value.trim() || !evidence.value.trim() || !acknowledged.value) return;
  request.value ??= crypto.randomUUID(); busy.value = true; error.value = '';
  try {
    await repairRefundAllocation(reversal.value, original.value, parsed.value, reason.value, evidence.value, request.value);
    original.value = ''; reversal.value = ''; amount.value = ''; reason.value = ''; evidence.value = ''; acknowledged.value = false;
    await load();
  } catch (err) { error.value = describeError(err); }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="card" data-refund-repair>
    <button class="btn" type="button" :disabled="busy" @click="load">مراجعة ربط المرتجعات القديمة</button>
    <p class="muted">للمالك فقط: هذا ربط لسجلات موجودة بالدليل وليس دفعاً جديداً. لا تخمّن مصدر أو مبلغ المرتجع. الرصيد غير المربوط يظل غير محسوم.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="data">
      <p v-if="data.unresolved" role="status">توجد مبالغ أو مستندات مرتجع غير مكتملة الربط؛ قد يستمر منع المرتجع حتى تكتمل الأدلة.</p>
      <p v-else>لا توجد مبالغ مرتجع غير مربوطة في السجلات المعروضة.</p>
      <ul>
        <li v-for="p in data.payments" :key="p.paymentId">
          {{ p.kind === 'sale' ? 'دفع أصلي' : 'دفع مرتجع' }} — {{ p.paymentId }} — {{ p.method }} — {{ money(p.amountMinor) }} — المربوط {{ money(p.allocatedMinor) }} — المسجل {{ p.recordedWalletId ?? 'لا يوجد' }}<template v-if="p.kind === 'sale' && (p.method === 'vf' || p.method === 'instapay')"> — المصدر المثبت {{ p.effectiveWalletId ?? 'غير مثبت' }}</template>
        </li>
      </ul>
      <label>دفع المرتجع
        <select v-model="reversal"><option value="">اختار</option><option v-for="p in data.payments.filter(p => p.kind === 'reversal' && p.allocatedMinor < p.amountMinor)" :key="p.paymentId" :value="p.paymentId">{{ p.paymentId }} — {{ p.method }} — متبقٍ {{ money(p.amountMinor - p.allocatedMinor) }}</option></select>
      </label>
      <label>الدفع الأصلي المثبت
        <select v-model="original"><option value="">اختار</option><option v-for="p in data.payments.filter(p => p.kind === 'sale' && p.allocatedMinor < p.amountMinor)" :key="p.paymentId" :value="p.paymentId">{{ p.paymentId }} — {{ p.method }} — متبقٍ {{ money(p.amountMinor - p.allocatedMinor) }}</option></select>
      </label>
      <label>المبلغ المثبت ({{ moneyUnitWord() }}) <input v-model="amount" inputmode="decimal" /></label>
      <label>سبب الربط <input v-model="reason" maxlength="300" /></label>
      <label>مرجع الدليل المستقل <textarea v-model="evidence" maxlength="1000" /></label>
      <label><input v-model="acknowledged" type="checkbox" /> راجعت المستندات وأفهم أن الربط لا يغيّر الدفع ولا يثبت رصيد الدرج</label>
      <button class="btn" type="button" :disabled="busy || !original || !reversal || !parsed || !reason.trim() || !evidence.trim() || !acknowledged" @click="submit">تسجيل ربط بالدليل</button>
      <ul v-if="data.repairs.length" data-refund-repair-history>
        <li v-for="r in data.repairs" :key="r.requestId">{{ r.reversalPaymentId }} ← {{ r.originalPaymentId }} — {{ money(r.amountMinor) }} — {{ r.reason }} — {{ r.evidence }} — {{ r.actorId }} — {{ fmtLong(new Date(r.occurredAt)) }}</li>
      </ul>
    </template>
  </section>
</template>
