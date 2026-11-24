<script setup lang="ts">
// Set or change your own daily PIN (ADR-017 §1). The first PIN needs nothing
// more than the session; changing one asks for the current password, so a
// session left open cannot be used to take over someone's daily secret.
// Offered by itself after a password sign-in on an account with no PIN, where
// «بعدين» skips it.
import { ref } from 'vue';

import { describeError } from '../api/errors';
import * as lifecycle from '../api/lifecycle';
import { toLatinDigits } from '../ui/format';
import Modal from '../ui/Modal.vue';
import { toast } from '../ui/toast';

const props = withDefaults(defineProps<{ first: boolean; offered?: boolean }>(), { offered: false });
const emit = defineEmits<{ close: []; saved: [] }>();

const pin = ref('');
const again = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);

async function save(): Promise<void> {
  if (busy.value) return;
  const typed = toLatinDigits(pin.value.trim());
  if (!/^[0-9]{4,6}$/.test(typed)) {
    error.value = 'الـ PIN لازم يكون من 4 لـ6 أرقام.';
    return;
  }
  if (typed !== toLatinDigits(again.value.trim())) {
    error.value = 'الرقمين مش زي بعض. اكتبه تاني.';
    again.value = '';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await lifecycle.setMyPin(typed, props.first ? null : password.value);
    toast(props.first ? 'اتعمل الـ PIN. من دلوقتي ادخل وبدّل بيه.' : 'اتغيّر الـ PIN.', 'ok');
    emit('saved');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal
    :title="first ? 'اعمل PIN' : 'غيّر الـ PIN'"
    :sub="first ? 'من 4 لـ6 أرقام، عشان تدخل وتبدّل بسرعة' : 'محتاج كلمة السر بتاعتك'"
    size="sm"
    @close="emit('close')"
  >
    <form class="stack" @submit.prevent="save" @keydown.enter.prevent="save">
      <div v-if="!first" class="field">
        <label for="pin-current">كلمة السر</label>
        <input id="pin-current" v-model="password" type="password" autocomplete="current-password" data-autofocus />
      </div>
      <div class="field">
        <label for="pin-new">الـ PIN الجديد</label>
        <input
          id="pin-new"
          v-model="pin"
          class="big-in num"
          type="password"
          inputmode="numeric"
          maxlength="6"
          autocomplete="off"
          :data-autofocus="first ? '' : undefined"
        />
      </div>
      <div class="field">
        <label for="pin-again">اكتبه تاني</label>
        <input id="pin-again" v-model="again" class="big-in num" type="password" inputmode="numeric" maxlength="6" autocomplete="off" />
      </div>
      <div class="err-msg" role="alert">{{ error }}</div>
    </form>
    <template #foot>
      <button type="button" class="btn primary" :disabled="busy" @click="save">احفظ <kbd>Enter</kbd></button>
      <button type="button" class="btn ghost" @click="emit('close')">{{ offered ? 'بعدين' : 'رجوع' }}</button>
    </template>
  </Modal>
</template>
