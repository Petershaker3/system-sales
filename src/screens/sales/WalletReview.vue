<script setup lang="ts">
import { ref, watch } from 'vue';
import { describeError } from '../../api/errors';
import { reviewHistoricalWallet, walletReviewCases, walletReviewHistory, type WalletReviewCase, type WalletReviewEvent } from '../../api/sales';
import { money, fmtLong } from '../../ui/format';
import { walletsOverview, type WalletRecord } from '../../api/wallet';

const props = defineProps<{ saleId: string }>();
const cases = ref<WalletReviewCase[] | null>(null);
const error = ref('');
const wallets = ref<WalletRecord[]>([]);
const selectedWalletId = ref('');
const history = ref<WalletReviewEvent[] | null>(null);
const historyPaymentId = ref<string | null>(null);
const busy = ref(false);
const target = ref<string | null>(null);
const reason = ref('');
const evidence = ref('');
const acknowledgment = ref(false);
const requestId = ref<string | null>(null);
let generation = 0;
watch(() => props.saleId, () => { generation++; cases.value = null; target.value = null; history.value = null; historyPaymentId.value = null; error.value = ''; });
watch([target, selectedWalletId, reason, evidence, acknowledgment], () => { requestId.value = null; });
async function load(): Promise<void> {
  const g = ++generation;
  busy.value = true; error.value = '';
  try { const [result, overview] = await Promise.all([walletReviewCases(props.saleId), walletsOverview(0, 0, 0, null, 1)]); if (g === generation) { cases.value = result; wallets.value = overview.wallets.map(w => w.wallet); } }
  catch (err) { if (g === generation) error.value = describeError(err); }
  finally { if (g === generation) busy.value = false; }
}
async function showHistory(item: WalletReviewCase): Promise<void> {
  if (busy.value) return;
  const g = generation;
  busy.value = true; error.value = '';
  try { const events = await walletReviewHistory(item.paymentId); if (g === generation) { history.value = events; historyPaymentId.value = item.paymentId; } }
  catch (err) { if (g === generation) error.value = describeError(err); }
  finally { if (g === generation) busy.value = false; }
}
async function submit(item: WalletReviewCase): Promise<void> {
  const action = item.reviewAction === 'confirm' ? 'revoke' : 'confirm';
  const walletId = action === 'revoke' ? item.reviewWalletId : selectedWalletId.value;
  if (busy.value || !walletId || !reason.value.trim() || !evidence.value.trim() || !acknowledgment.value) return;
  requestId.value ??= crypto.randomUUID();
  busy.value = true; error.value = '';
  try {
    await reviewHistoricalWallet(item.paymentId, walletId, action, reason.value, evidence.value, requestId.value);
    target.value = null; selectedWalletId.value = ''; reason.value = ''; evidence.value = ''; acknowledgment.value = false; history.value = null; historyPaymentId.value = null;
    await load();
  } catch (err) { error.value = describeError(err); }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="card" data-wallet-review>
    <button type="button" class="btn" :disabled="busy" data-wallet-review-load @click="load">مراجعة مصدر المحافظ القديمة</button>
    <p class="muted">للمالك فقط: المحفظة المكتوبة تاريخياً ليست دليلاً وحدها. راجع مستندات فعلية وحدد المحفظة التي يثبتها الدليل، حتى لو اختلفت عن الرقم القديم؛ لا تخمّن من طريقة الدفع.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="cases && cases.length === 0">لا توجد مدفوعات إلكترونية قديمة لهذه الفاتورة تحتاج مراجعة.</p>
    <div v-for="item in cases ?? []" :key="item.paymentId" class="note" :data-wallet-review-payment="item.paymentId">
      <p>{{ item.method }} — {{ money(item.amountMinor) }} — المسجل تاريخياً: {{ item.recordedWalletName ?? item.recordedWalletId ?? 'غير معروف' }}</p>
      <p v-if="item.reviewAction === 'confirm'">مؤكّد بمراجعة المالك للمحفظة {{ wallets.find(w => w.id === item.reviewWalletId)?.name ?? item.reviewWalletId }}، وليس تحققاً آلياً — {{ item.reviewReason }} — {{ item.reviewEvidence }} — {{ item.reviewActorId }} — {{ item.reviewOccurredAt ? fmtLong(new Date(item.reviewOccurredAt)) : '' }}</p>
      <p v-else>المصدر غير مثبت<span v-if="item.reviewAction === 'revoke'">؛ آخر مراجعة أُلغيت: {{ item.reviewReason }} — {{ item.reviewEvidence }}</span>.</p>
      <button type="button" class="btn" :disabled="busy" @click="showHistory(item)">عرض سجل المراجعات</button>
      <ul v-if="historyPaymentId === item.paymentId && history" data-wallet-review-history>
        <li v-for="event in history" :key="event.sequence">{{ event.action === 'confirm' ? 'تأكيد' : 'إلغاء' }} — {{ event.walletId }} — {{ event.reason }} — {{ event.evidence }} — {{ event.actorId }} — {{ fmtLong(new Date(event.occurredAt)) }}</li>
      </ul>
      <button type="button" class="btn" :disabled="busy" @click="target = item.paymentId; selectedWalletId = ''">{{ item.reviewAction === 'confirm' ? 'إلغاء التأكيد بسجل تعويضي' : 'مراجعة وتحديد المحفظة بالدليل' }}</button>
      <div v-if="target === item.paymentId" class="stack">
        <label v-if="item.reviewAction !== 'confirm'">المحفظة التي يثبتها الدليل
          <select v-model="selectedWalletId" data-wallet-review-choice>
            <option value="">اختار المحفظة من الدليل</option>
            <option v-for="wallet in wallets" :key="wallet.id" :value="wallet.id">{{ wallet.name }} {{ wallet.number }}{{ wallet.hidden ? ' (مخفية)' : '' }}</option>
          </select>
        </label>
        <label>سبب القرار <input v-model="reason" maxlength="300" /></label>
        <label>الدليل المستقل (مثلاً مرجع كشف الحساب) <textarea v-model="evidence" maxlength="1000" /></label>
        <label><input v-model="acknowledgment" type="checkbox" /> راجعت الدليل وأفهم أن هذا القرار لا يثبت رصيد الدرج</label>
        <button type="button" class="btn" :disabled="busy || (!selectedWalletId && item.reviewAction !== 'confirm') || !reason.trim() || !evidence.trim() || !acknowledgment" data-wallet-review-submit @click="submit(item)">تسجيل القرار</button>
      </div>
    </div>
  </section>
</template>
