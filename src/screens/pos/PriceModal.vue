<script setup lang="ts">
// «مالوش سعر بيع»: the price the owner types here is saved to the product, and
// the line goes into the invoice right after it.
//
// Phones arrive from the old program with no sale price at all (the owner's own
// instruction: «مفيش جهاز كاتبله سعر بيع»), and the sales screen refused them
// with a toast pointing at «المخزن» — a dead end he could not walk
// (2026-11-02). Typing the price where he stands is the shortest honest path:
// the price is his, it is stored once per model, and the next sale of that model
// needs no typing at all.
import { computed, ref } from 'vue';

import { money, parseMoney } from '../../ui/format';
import Modal from '../../ui/Modal.vue';

const props = defineProps<{ name: string; sub?: string }>();
const emit = defineEmits<{ close: []; save: [minor: number] }>();

const text = ref('');
const error = ref('');

const minor = computed(() => parseMoney(text.value));

function save(): void {
  const value = minor.value;
  if (value === null) {
    error.value = text.value.trim() === '' ? 'اكتب السعر الأول' : 'اكتب السعر بالجنيه والقروش، مثال: 8500';
    return;
  }
  emit('save', value);
}
</script>

<template>
  <Modal title="سعر البيع" :sub="props.sub ?? props.name" size="sm" @close="emit('close')">
    <form class="stack" @submit.prevent="save" @keydown.enter.prevent="save">
      <p class="note">
        «{{ props.name }}» لسه مكتوبلهوش سعر بيع. اكتبه هنا مرة واحدة، وهيتحفظ على الموديل
        وتقدر تبيعه على طول.
      </p>
      <div class="field">
        <label for="price-in">سعر البيع بالجنيه</label>
        <input
          id="price-in"
          v-model="text"
          class="big-in num"
          inputmode="decimal"
          autocomplete="off"
          data-field="sale-price"
          data-autofocus
        />
      </div>
      <small class="hint" v-if="minor !== null">هيتحفظ: {{ money(minor) }}</small>
      <div class="err-msg">{{ error }}</div>
    </form>
    <template #foot>
      <button type="button" class="btn primary" @click="save">احفظ السعر وكمّل البيع <kbd>Enter</kbd></button>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع</button>
    </template>
  </Modal>
</template>
