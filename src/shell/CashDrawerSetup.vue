<script setup lang="ts">
import { ref, watch } from 'vue';
import { cashPostingPreview, configureDrawer, transferDrawerCash, type CashPostingPreview } from '../api/shift';
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
    <p>عرض تجريبي غير مكتمل: لا يشمل كل مصادر النقدية أو التاريخ، وليس رصيداً ولا مطابقة.</p>
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
      <ul>
        <li v-for="p in preview.recentPostings" :key="p.sourceKind + p.sourceId">{{ p.sourceKind }} / {{ p.sourceId }} — {{ money(p.signedMinor) }} — {{ preview.drawers.find(d => d.id === p.drawerId)?.name ?? 'الدرج غير معروف' }} — {{ p.actorId }} — {{ fmtLong(new Date(p.occurredAt)) }}</li>
      </ul>
      <p v-if="preview.recentPostings.length === 100">المعروض آخر 100 حركة مسجلة فقط.</p>
    </template>
  </section>
</template>
