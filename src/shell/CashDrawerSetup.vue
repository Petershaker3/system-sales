<script setup lang="ts">
import { ref, watch } from 'vue';
import { cashPostingPreview, configureDrawer, transferDrawerCash, recordDrawerPhysicalCount, reviewRepairCashRefund, type CashPostingPreview } from '../api/shift';
import { describeError } from '../api/errors';
import { fmtLong, money, moneyUnitWord, parseMoney } from '../ui/format';

const props = defineProps<{ canConfigure: boolean; shiftId: string | null }>();
const emit = defineEmits<{ changed: [] }>();
const preview = ref<CashPostingPreview | null>(null);
const error = ref(''); const busy = ref(false);
const selected = ref(''); const newName = ref('');
const request = ref<string | null>(null); const newId = ref<string | null>(null);
watch([selected, newName], () => { request.value = null; newId.value = null; });
const destination = ref(''); const amount = ref(''); const transferReason = ref(''); const confirmed = ref(false);
const transferRequest = ref<string | null>(null);
watch([destination, amount, transferReason, confirmed, () => props.shiftId], () => { transferRequest.value = null; });
async function transfer(): Promise<void> {
  const parsed = parseMoney(amount.value);
  if (busy.value || !props.shiftId || !destination.value || !parsed || !transferReason.value.trim() || !confirmed.value) return;
  transferRequest.value ??= crypto.randomUUID(); busy.value = true; error.value = '';
  try {
    await transferDrawerCash(props.shiftId, destination.value, parsed, transferReason.value, transferRequest.value);
    emit('changed');
    destination.value = ''; amount.value = ''; transferReason.value = ''; confirmed.value = false;
    await load();
  } catch (err) { error.value = describeError(err); }
  finally { busy.value = false; }
}
const countDrawer = ref(''); const countAmount = ref(''); const countConfirmed = ref(false);
const countRequest = ref<string | null>(null);
watch([countDrawer, countAmount, countConfirmed], () => { countRequest.value = null; });
async function saveCount(): Promise<void> {
  const parsed = parseMoney(countAmount.value);
  if (busy.value || !countDrawer.value || parsed === null || !countConfirmed.value) return;
  countRequest.value ??= crypto.randomUUID(); busy.value = true; error.value = '';
  try {
    await recordDrawerPhysicalCount(countDrawer.value, parsed, countRequest.value);
    countDrawer.value = ''; countAmount.value = ''; countConfirmed.value = false;
    await load();
  } catch (err) { error.value = describeError(err); }
  finally { busy.value = false; }
}
const reviewRepair = ref(''); const reviewDrawer = ref(''); const reviewTime = ref(''); const reviewEvidence = ref(''); const reviewConfirmed = ref(false);
const reviewRequest = ref<string | null>(null);
watch([reviewRepair, reviewDrawer, reviewTime, reviewEvidence, reviewConfirmed], () => { reviewRequest.value = null; });
async function saveRefundReview(): Promise<void> {
  const gap = preview.value?.uncertainRepairRefunds.find(r => r.repairId === reviewRepair.value);
  const payoutAt = new Date(reviewTime.value).getTime();
  if (busy.value || !gap?.shiftId || !reviewDrawer.value || !Number.isSafeInteger(payoutAt) || !reviewEvidence.value.trim() || !reviewConfirmed.value) return;
  reviewRequest.value ??= crypto.randomUUID(); busy.value = true; error.value = '';
  try {
    await reviewRepairCashRefund(reviewRequest.value, gap.repairId, gap.shiftId, reviewDrawer.value, payoutAt, reviewEvidence.value);
    reviewRepair.value = ''; reviewDrawer.value = ''; reviewTime.value = ''; reviewEvidence.value = ''; reviewConfirmed.value = false;
    emit('changed'); await load();
  } catch (err) { error.value = describeError(err); }
  finally { busy.value = false; }
}
async function load(): Promise<void> {
  busy.value = true; error.value = '';
  try { preview.value = await cashPostingPreview(); }
  catch (err) { error.value = describeError(err); }
  finally { busy.value = false; }
}
async function save(): Promise<void> {
  if (busy.value || !props.canConfigure || !preview.value) return;
  const existing = preview.value.drawers.find(d => d.id === selected.value);
  const name = existing?.name ?? newName.value.trim();
  if (!name) return;
  request.value ??= crypto.randomUUID();
  newId.value ??= crypto.randomUUID();
  busy.value = true; error.value = '';
  try { await configureDrawer(existing?.id ?? newId.value, name, request.value); await load(); }
  catch (err) { error.value = describeError(err); }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="note" data-cash-drawer-setup>
    <button type="button" class="btn" :disabled="busy" @click="load">هوية الدرج وحركات نقدية مسجلة</button>
    <p>عرض تجريبي غير مكتمل: لا يشمل كل مصادر النقدية أو التاريخ، وليس رصيداً ولا مطابقة. غياب الحالات الجديدة لا يثبت سلامة المرتجعات القديمة.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="preview">
      <p>درج الوردية القادم: {{ preview.drawers.find(d => d.isDefault)?.name ?? 'لم يحدد المالك درجاً' }}. الوردية المفتوحة والعمليات القديمة لا تُنسب بأثر رجعي.</p>
      <div v-if="canConfigure">
        <label>اختار درجاً أو سجّل درجاً جديداً
          <select v-model="selected"><option value="">درج جديد</option><option v-for="d in preview.drawers" :key="d.id" :value="d.id">{{ d.name }}</option></select>
        </label>
        <label v-if="!selected">اسم الدرج <input v-model="newName" maxlength="80" /></label>
        <button type="button" class="btn" :disabled="busy || (!selected && !newName.trim())" @click="save">تحديد للوردية القادمة</button>
      </div>
      <p v-else>لا يمكن تغيير هوية الدرج أثناء الوردية المفتوحة.</p>
      <div v-if="shiftId && preview.drawers.length > 1" class="stack" data-cash-drawer-transfer>
        <p>تسجيل نقل نقدية تم فعلياً من درج الوردية إلى درج آخر. لا يتحقق السيستم حالياً من الرصيد الكافي.</p>
        <label>الدرج المستلم <select v-model="destination"><option value="">اختار</option><option v-for="d in preview.drawers.filter(d => !d.isDefault)" :key="d.id" :value="d.id">{{ d.name }}</option></select></label>
        <label>المبلغ ({{ moneyUnitWord() }}) <input v-model="amount" inputmode="decimal" /></label>
        <label>سبب النقل <input v-model="transferReason" maxlength="300" /></label>
        <label><input v-model="confirmed" type="checkbox" /> عدّيت النقدية ونقلتها فعلاً وأفهم أن الرصيد لم يُطابق</label>
        <button type="button" class="btn" :disabled="busy || !destination || !parseMoney(amount) || !transferReason.trim() || !confirmed" @click="transfer">تسجيل النقل</button>
      </div>
      <div v-if="preview.uncertainRepairRefundCount > 0" class="note" role="status" data-uncertain-repair-refunds>
        <p>فيه {{ preview.uncertainRepairRefundCount }} مرتجع صيانة مسجل من غير دليل كافٍ لطريقة الصرف أو الدرج. دي فجوة، مش حركة نقدية مؤكدة ولا عجز محسوب.</p>
        <ul><li v-for="r in preview.uncertainRepairRefunds" :key="r.repairId">تذكرة {{ r.ticketNo }} — {{ money(r.amountMinor) }} — {{ r.actorId }} — {{ fmtLong(new Date(r.occurredAt)) }} — {{ r.shiftId ? 'الوردية مسجلة' : 'الوردية غير معروفة' }}</li></ul>
        <p v-if="preview.uncertainRepairRefundCount > preview.uncertainRepairRefunds.length">المعروض آخر 100 حالة فقط.</p>
        <p>مراجعة المدير متاحة فقط لرد كامل ثبت تحصيله نقداً، وله وردية ودرج مسجلان. المختلط والقديم بلا دليل يظل مجهولاً.</p>
        <label>التذكرة <select v-model="reviewRepair"><option value="">اختار</option><option v-for="r in preview.uncertainRepairRefunds.filter(r => r.shiftId)" :key="r.repairId" :value="r.repairId">{{ r.ticketNo }} — {{ money(r.amountMinor) }}</option></select></label>
        <label>الدرج الذي خرج منه النقد فعلاً <select v-model="reviewDrawer"><option value="">اختار</option><option v-for="d in preview.drawers" :key="d.id" :value="d.id">{{ d.name }}</option></select></label>
        <label>وقت الصرف الفعلي بدقة <input v-model="reviewTime" type="datetime-local" step="0.001" /></label>
        <label>الدليل على الصرف والوقت والدرج <input v-model="reviewEvidence" maxlength="1000" /></label>
        <label><input v-model="reviewConfirmed" type="checkbox" /> تحققت من الدليل وأؤكد خروج المبلغ كله كاش من الدرج في الوقت المكتوب</label>
        <button type="button" class="btn" :disabled="busy || !reviewRepair || !reviewDrawer || !reviewTime || !reviewEvidence.trim() || !reviewConfirmed" @click="saveRefundReview">تسجيل مراجعة المدير</button>
      </div>
      <div v-if="preview.repairCashRefundReviews.length" class="note" data-repair-refund-review-history>
        <p>مراجعات رد نقدي سابقة؛ الدليل إقرار المدير وليس تحققًا آليًا منه:</p>
        <ul><li v-for="r in preview.repairCashRefundReviews" :key="r.requestId">{{ r.repairId }} — {{ preview.drawers.find(d => d.id === r.drawerId)?.name ?? 'درج غير معروف' }} — صرف {{ fmtLong(new Date(r.payoutAt)) }} — راجع {{ r.actorId }} في {{ fmtLong(new Date(r.reviewedAt)) }} — {{ r.evidence }}</li></ul>
      </div>
      <div v-if="preview.drawers.length" class="stack" data-drawer-physical-count>
        <p>تسجيل جرد فعلي لدرج معين. الجرد ليس حركة مالية ولا يحدد عجزاً أو زيادة قبل اكتمال المطابقة.</p>
        <label>الدرج <select v-model="countDrawer"><option value="">اختار</option><option v-for="d in preview.drawers" :key="d.id" :value="d.id">{{ d.name }}</option></select></label>
        <label>المعدود فعلياً ({{ moneyUnitWord() }}) <input v-model="countAmount" inputmode="decimal" /></label>
        <label><input v-model="countConfirmed" type="checkbox" /> عدّيت هذا الدرج فعلياً</label>
        <button type="button" class="btn" :disabled="busy || !countDrawer || parseMoney(countAmount) === null || !countConfirmed" @click="saveCount">تسجيل الجرد</button>
        <ul><li v-for="c in preview.recentCounts" :key="c.requestId">{{ preview.drawers.find(d => d.id === c.drawerId)?.name ?? 'درج غير معروف' }} — {{ money(c.amountMinor) }} — {{ c.countedBy }} — {{ fmtLong(new Date(c.countedAt)) }} — جرد فقط، غير مُطابق</li></ul>
        <p v-if="preview.recentCounts.length === 100">المعروض آخر 100 جرد فقط.</p>
      </div>
      <ul>
        <li v-for="p in preview.recentPostings" :key="p.sourceKind + p.sourceId">{{ p.sourceKind }} / {{ p.sourceId }} — {{ money(p.signedMinor) }} — {{ preview.drawers.find(d => d.id === p.drawerId)?.name ?? 'الدرج غير معروف' }} — {{ p.actorId }} — {{ fmtLong(new Date(p.occurredAt)) }}</li>
      </ul>
      <p v-if="preview.recentPostings.length === 100">المعروض آخر 100 حركة مسجلة فقط.</p>
    </template>
  </section>
</template>
