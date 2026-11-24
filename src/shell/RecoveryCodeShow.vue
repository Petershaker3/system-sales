<script setup lang="ts">
// A recovery code, shown this once (ADR-017 §4): to be written on paper and
// kept away from the device. Rust keeps only a one-way fingerprint of it, so
// nobody — this window included — can show it again.
//
// The window stays until the owner says it is written down. There is no copy
// button: a copied code is a code left behind on the machine.
import { ref } from 'vue';

import Icon from '../ui/Icon.vue';
import Modal from '../ui/Modal.vue';

withDefaults(defineProps<{ code: string; title?: string; sub?: string }>(), {
  title: 'كود الاسترجاع',
  sub: 'لو نسيت كلمة السر، ده اللي هيرجّعك',
});
const emit = defineEmits<{ done: [] }>();

const written = ref(false);
</script>

<template>
  <Modal :title="title" :sub="sub" size="sm" :closable="false" @close="emit('done')">
    <div class="rc">
      <div class="rc-code mono" dir="ltr" aria-label="كود الاسترجاع">
        <span v-for="(group, i) in code.split('-')" :key="i">{{ group }}</span>
      </div>
      <div class="note warn">
        <Icon name="notebook-pen" />
        <span>اكتبه على ورقة دلوقتي، وشيلها في مكان أمين بعيد عن الجهاز. <b>مش هيظهر تاني.</b></span>
      </div>
      <label class="rc-check">
        <input v-model="written" type="checkbox" />
        <span>كتبته على ورقة</span>
      </label>
    </div>
    <template #foot>
      <button type="button" class="btn primary" :disabled="!written" @click="emit('done')">تمام</button>
    </template>
  </Modal>
</template>

<style scoped>
.rc-code {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 12px;
  margin-bottom: 12px;
  padding: 14px 10px;
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-m);
  background: var(--surface-2);
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}
.rc-check {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-weight: 600;
  cursor: pointer;
}
</style>
