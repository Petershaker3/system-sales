<script setup lang="ts">
// F2: type the quantity of the selected line.
import { ref } from 'vue';

import { parseCount } from '../../ui/format';
import Modal from '../../ui/Modal.vue';

const props = defineProps<{ name: string; quantity: number }>();
const emit = defineEmits<{ close: []; apply: [quantity: number] }>();

const text = ref(String(props.quantity));
const error = ref('');

function apply(): void {
  const n = parseCount(text.value);
  if (n === null) {
    error.value = 'اكتب رقم صحيح';
    return;
  }
  emit('apply', n);
}
</script>

<template>
  <Modal title="الكمية" :sub="name" size="sm" @close="emit('close')">
    <form class="stack" @submit.prevent="apply" @keydown.enter.prevent="apply">
      <div class="field">
        <label for="qty-in">كام قطعة؟ (صفر يشيل السطر)</label>
        <input id="qty-in" v-model="text" class="big-in num" inputmode="numeric" autocomplete="off" data-autofocus />
      </div>
      <div class="err-msg">{{ error }}</div>
    </form>
    <template #foot>
      <button type="button" class="btn primary" @click="apply">تمام <kbd>Enter</kbd></button>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع</button>
    </template>
  </Modal>
</template>
