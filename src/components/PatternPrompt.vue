<script setup lang="ts">
// The Pattern prompt — the step-up gate made visible (SP-1b).
//
// Rust decides when an operation needs a fresh Pattern approval
// (`PATTERN_REQUIRED`, `PATTERN_APPROVAL_STALE`); this component only collects
// what the operator types and sends it for checking. The entered value travels
// once, is checked, and is dropped — nothing here keeps it beyond the input
// binding. Verification is permissionless by design, so no re-auth modal sits
// in front of it.

import { ref, watch } from 'vue';

import * as api from '../api/pattern';
import { describeError } from '../api/errors';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ verified: []; cancelled: [] }>();

const pattern = ref('');
const error = ref('');
const busy = ref(false);

// Re-opened fresh every time: the previous attempt's text must not survive
// into the next prompt.
watch(
  () => props.visible,
  (visible) => {
    if (visible) {
      pattern.value = '';
      error.value = '';
    }
  },
);

async function submit(): Promise<void> {
  busy.value = true;
  error.value = '';
  try {
    await api.verifyPattern(pattern.value);
    pattern.value = '';
    emit('verified');
  } catch (err) {
    error.value = describeError(err);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div v-if="visible" class="overlay">
    <form class="modal" @submit.prevent="submit">
      <h3 class="modal-title">تأكيد النمط</h3>
      <p class="hint">هذه العملية حسّاسة. أدخل النمط للمتابعة.</p>

      <label class="field">
        <span>النمط</span>
        <input
          v-model="pattern"
          type="password"
          autocomplete="off"
          required
          autofocus
        />
      </label>

      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <div class="row">
        <button type="submit" :disabled="busy">تأكيد</button>
        <button type="button" :disabled="busy" @click="emit('cancelled')">إلغاء</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
/* Minimal, matching UserManagement.vue's modal. */
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  z-index: 10;
}
.modal {
  background: #fff;
  padding: 1rem;
  max-width: 22rem;
  width: 100%;
}
.modal-title {
  margin: 0 0 0.5rem;
  font-size: 1rem;
}
.row {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
</style>
