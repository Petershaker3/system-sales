<script setup lang="ts">
import { ref, watch } from 'vue';
import { describeError } from '../../api/errors';
import { reviewHistoricalWallet, walletReviewCases, type WalletReviewCase } from '../../api/sales';
import { money, fmtLong } from '../../ui/format';

const props = defineProps<{ saleId: string }>();
const cases = ref<WalletReviewCase[] | null>(null);
const error = ref('');
const busy = ref(false);
const target = ref<string | null>(null);
const reason = ref('');
const evidence = ref('');
const acknowledgment = ref(false);
const requestId = ref<string | null>(null);
let generation = 0;
watch(() => props.saleId, () => { generation++; cases.value = null; target.value = null; error.value = ''; });
watch([target, reason, evidence, acknowledgment], () => { requestId.value = null; });
async function load(): Promise<void> {
  const g = ++generation;
  busy.value = true; error.value = '';
  try { const result = await walletReviewCases(props.saleId); if (g === generation) cases.value = result; }
  catch (err) { if (g === generation) error.value = describeError(err); }
  finally { if (g === generation) busy.value = false; }
}
async function submit(item: WalletReviewCase): Promise<void> {
  if (busy.value || !item.recordedWalletId || !reason.value.trim() || !evidence.value.trim() || !acknowledgment.value) return;
  const action = item.reviewAction === 'confirm' ? 'revoke' : 'confirm';
  requestId.value ??= crypto.randomUUID();
  busy.value = true; error.value = '';
  try {
    await reviewHistoricalWallet(item.paymentId, item.recordedWalletId, action, reason.value, evidence.value, requestId.value);
    target.value = null; reason.value = ''; evidence.value = ''; acknowledgment.value = false;
    await load();
  } catch (err) { error.value = describeError(err); }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="card" data-wallet-review>
    <button type="button" class="btn" :disabled="busy" data-wallet-review-load @click="load">مراجعة مصدر المحافظ القديمة</button>
    <p class="muted">للمالك فقط: المحفظة المكتوبة تاريخياً ليست دليلاً وحدها. راجع مستندات فعلية قبل التأكيد. لو الرقم مختلف أو غير موجود لا تؤكد؛ لا يوجد مسار تصحيح آمن بعد.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="cases && cases.length === 0">لا توجد مدفوعات إلكترونية قديمة لهذه الفاتورة تحتاج مراجعة.</p>
    <div v-for="item in cases ?? []" :key="item.paymentId" class="note" :data-wallet-review-payment="item.paymentId">
      <p>{{ item.method }} — {{ money(item.amountMinor) }} — المسجل تاريخياً: {{ item.recordedWalletName ?? item.recordedWalletId ?? 'غير معروف' }}</p>
      <p v-if="item.reviewAction === 'confirm'">مؤكّد بمراجعة المالك، وليس تحققاً آلياً — {{ item.reviewReason }} — {{ item.reviewEvidence }} — {{ item.reviewActorId }} — {{ item.reviewOccurredAt ? fmtLong(new Date(item.reviewOccurredAt)) : '' }}</p>
      <p v-else>المصدر غير مثبت<span v-if="item.reviewAction === 'revoke'">؛ آخر مراجعة أُلغيت: {{ item.reviewReason }} — {{ item.reviewEvidence }}</span>.</p>
      <button v-if="item.recordedWalletId" type="button" class="btn" :disabled="busy" @click="target = item.paymentId">{{ item.reviewAction === 'confirm' ? 'إلغاء التأكيد بسجل تعويضي' : 'مراجعة وتأكيد الرقم المسجل' }}</button>
      <div v-if="target === item.paymentId" class="stack">
        <label>سبب القرار <input v-model="reason" maxlength="300" /></label>
        <label>الدليل المستقل (مثلاً مرجع كشف الحساب) <textarea v-model="evidence" maxlength="1000" /></label>
        <label><input v-model="acknowledgment" type="checkbox" /> راجعت الدليل وأفهم أن هذا القرار لا يثبت رصيد الدرج</label>
        <button type="button" class="btn" :disabled="busy || !reason.trim() || !evidence.trim() || !acknowledgment" data-wallet-review-submit @click="submit(item)">تسجيل القرار</button>
      </div>
    </div>
  </section>
</template>
