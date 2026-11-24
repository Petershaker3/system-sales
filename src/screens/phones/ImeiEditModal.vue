<script setup lang="ts">
// «اكتب الـ IMEI»: giving a device the number printed on its box, after it was
// registered without one («بدون IMEI», owner 2026-11-02).
//
// The typed number is checked the same way a scan is — fifteen digits and the
// Luhn digit — before the backend is asked, so a typo is refused here with a
// reason instead of coming back as a code.
import { computed, ref } from 'vue';

import { describeError } from '../../api/errors';
import { money, num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';
import { normalizeImeiDigits, validateImeiInput } from '../pos/imei';

const props = defineProps<{
  unitId: string;
  deviceName: string;
  costMinor: number;
}>();

const emit = defineEmits<{ close: []; saved: [] }>();

const text = ref('');
const error = ref('');
const busy = ref(false);

const digits = computed(() => normalizeImeiDigits(text.value));
const validation = computed(() => validateImeiInput(text.value));
const canSave = computed(() => validation.value.ok && !busy.value);

function messageFor(code: string): string {
  return code === 'IMEI_LENGTH_INVALID'
    ? `الـ IMEI لازم يكون 15 رقم — انت كتبت ${num(digits.value.length)}`
    : 'رقم التحقق الأخير (Luhn) غلط — راجع الرقم على العلبة أو اطلب *#06#';
}

async function save(): Promise<void> {
  if (busy.value) return;
  error.value = '';
  if (!validation.value.ok) {
    error.value = messageFor(validation.value.code);
    return;
  }
  busy.value = true;
  try {
    const { setUnitImei } = await import('../../api/inventory');
    const stored = await setUnitImei(props.unitId, validation.value.imei);
    toast(`اتسجل الـ IMEI ${stored} على «${props.deviceName}»`, 'ok');
    emit('saved');
    emit('close');
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    error.value =
      code === 'IMEI_ALREADY_REGISTERED'
        ? 'الرقم ده مسجل على جهاز تاني في المحل — راجع الجهازين.'
        : code === 'IMEI_UNIT_NOT_AVAILABLE'
          ? 'الجهاز ده اتباع أو اتشال من المخزن، فمينفعش يتغير رقمه.'
          : describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal title="اكتب الـ IMEI" :sub="props.deviceName" size="sm" @close="emit('close')">
    <form class="stack" @submit.prevent="save" @keydown.enter.prevent="save">
      <p class="note">
        <Icon name="info" />
        الجهاز ده مسجل «بدون IMEI» برقم داخلي مؤقت. اكتب الرقم الحقيقي اللي على العلبة
        (أو اطلب <bdi dir="ltr">*#06#</bdi>) وهيتسجل مكانه.
      </p>
      <div class="field">
        <label for="imei-edit">IMEI (15 رقم)</label>
        <input
          id="imei-edit"
          v-model="text"
          class="big-in mono"
          dir="ltr"
          inputmode="numeric"
          maxlength="19"
          autocomplete="off"
          placeholder="356938035643809"
          data-field="imei"
          data-autofocus
        />
      </div>
      <small v-if="digits !== '' && validation.ok" class="ok-t">✓ رقم سليم (Luhn)</small>
      <small v-else-if="digits !== ''" class="muted">{{ digits.length }}/15</small>
      <small class="muted">تكلفة القطعة: {{ money(props.costMinor) }}</small>
      <div class="err-msg">{{ error }}</div>
    </form>
    <template #foot>
      <button type="button" class="btn primary" :disabled="!canSave" @click="save">
        احفظ الرقم
      </button>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع</button>
    </template>
  </Modal>
</template>
