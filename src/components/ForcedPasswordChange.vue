<script setup lang="ts">
// Forced password change.
//
// A full-screen gate with no exit. The backend enforces it — `Session::authorize`
// refuses every permission except `ChangeOwnPassword` while the flag is set — so
// this screen is a reflection of a real restriction, not the restriction itself.
// Hiding it would still leave the server refusing every command.
//
// The flag is read from the resolved session rather than accepted from the caller.

import { ref } from 'vue';

import * as lifecycle from '../api/lifecycle';
import { describeError } from '../api/errors';

const emit = defineEmits<{ changed: [] }>();

const currentPassword = ref('');
const newPassword = ref('');
const confirmation = ref('');
const error = ref('');
const busy = ref(false);

async function submit(): Promise<void> {
  if (newPassword.value !== confirmation.value) {
    error.value = 'كلمتا المرور غير متطابقتين.';
    return;
  }

  busy.value = true;
  error.value = '';
  try {
    await lifecycle.changeOwnPassword(currentPassword.value, newPassword.value);
    currentPassword.value = '';
    newPassword.value = '';
    confirmation.value = '';
    emit('changed');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="panel">
    <h2 class="panel-title">يجب تغيير كلمة المرور</h2>
    <p class="hint">
      حدّد المدير كلمة مرور جديدة لك. لازم تغيّرها قبل ما تدخل النظام.
    </p>

    <form @submit.prevent="submit">
      <label class="field">
        <span>كلمة المرور الحالية</span>
        <input
          v-model="currentPassword"
          type="password"
          autocomplete="current-password"
          required
        />
      </label>

      <label class="field">
        <span>كلمة المرور الجديدة</span>
        <input
          v-model="newPassword"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
        />
      </label>

      <label class="field">
        <span>تأكيد كلمة المرور</span>
        <input
          v-model="confirmation"
          type="password"
          autocomplete="new-password"
          required
          minlength="8"
        />
      </label>

      <p class="hint">ثمانية أحرف على الأقل.</p>
      <button type="submit" :disabled="busy">حفظ كلمة المرور</button>
    </form>

    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
/* Minimal, matching App.vue. Inherits the panel and field styling from there. */
</style>