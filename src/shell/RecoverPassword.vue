<script setup lang="ts">
// «نسيت كلمة السر؟» on the owner's card (ADR-017 §4): the recovery code from
// the paper and a new password, without a session. A wrong code counts against
// the same lockout as a wrong password; a right one replaces the password,
// ends every session and burns the code — the next one is shown right after,
// once.
//
// The lock card owns the keyboard while this is open, so the submit button
// sits inside the form: Enter submits through it.
import { ref } from 'vue';

import * as api from '../api/identity';
import { asCommandError, describeError, ErrorCode } from '../api/errors';
import type { UserSummary } from '../api/identity';
import { toLatinDigits } from '../ui/format';
import Modal from '../ui/Modal.vue';

const props = defineProps<{ user: UserSummary }>();
const emit = defineEmits<{ close: []; recovered: [code: string] }>();

const code = ref('');
const password = ref('');
const again = ref('');
const error = ref('');
const busy = ref(false);

async function submit(): Promise<void> {
  if (busy.value) return;
  if (password.value !== again.value) {
    error.value = 'كلمتين السر مش زي بعض. اكتبها تاني.';
    again.value = '';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const next = await api.recoverPasswordWithCode(props.user.id, toLatinDigits(code.value.trim()), password.value);
    code.value = '';
    password.value = '';
    again.value = '';
    emit('recovered', next.code);
  } catch (err) {
    error.value =
      asCommandError(err)?.code === ErrorCode.INVALID_CREDENTIALS ? 'الكود غلط. راجعه من الورقة.' : describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Modal title="نسيت كلمة السر؟" :sub="`${user.displayName}: بكود الاسترجاع اللي على الورقة`" size="sm" @close="emit('close')">
    <form class="stack" @submit.prevent="submit">
      <div class="field">
        <label for="rc-code">كود الاسترجاع</label>
        <input
          id="rc-code"
          v-model="code"
          class="big-in mono"
          dir="ltr"
          autocomplete="off"
          autocapitalize="characters"
          spellcheck="false"
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
          data-autofocus
        />
      </div>
      <div class="field">
        <label for="rc-pass">كلمة السر الجديدة</label>
        <input id="rc-pass" v-model="password" type="password" autocomplete="new-password" />
        <span class="hint">8 حروف على الأقل. الـ PIN زي ما هو.</span>
      </div>
      <div class="field">
        <label for="rc-again">اكتبها تاني</label>
        <input id="rc-again" v-model="again" type="password" autocomplete="new-password" />
      </div>
      <div class="err-msg" role="alert">{{ error }}</div>
      <button type="submit" class="btn primary block" :disabled="busy">غيّر كلمة السر <kbd>Enter</kbd></button>
    </form>
    <template #foot>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع <kbd>Esc</kbd></button>
    </template>
  </Modal>
</template>
