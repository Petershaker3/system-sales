<script setup lang="ts">
// «سعر البيع» — the price typed where the sale happens, and the one decision the
// shopkeeper has to make with it (`0035`).
//
// Phones arrive with no sale price at all (the owner's own rule: «سعر البيع
// للهواتف مش موجود — بيتحدد وقت البيع»), and a used handset's price is a
// conversation with one customer, not a property of the model. So when a price is
// typed here the app asks which of two things it is:
//
//   - «احفظه سعر الموديل»   → the product's price becomes this, and every later
//                             sale of the model starts here.
//   - «الفاتورة دي بس»      → the line is charged this, and the model keeps
//                             whatever price it had (possibly none).
//
// The answer is never guessed. Writing a price on a model is a price change for
// every other unit of it, and a shopkeeper selling one device for 3,900 must not
// silently reprice the identical device beside it.
import { computed, ref } from 'vue';

import { money, parseMoney } from '../../ui/format';
import Modal from '../../ui/Modal.vue';

const props = defineProps<{
  name: string;
  sub?: string;
  /** The model's current price, when it has one. `null` means «not priced yet». */
  currentMinor?: number | null;
  /**
   * Whether this session may write a price onto the model at all. A seller who
   * may not is still allowed to charge a price for this invoice — Rust decides
   * that — so the button is shown and the refusal comes from the service.
   */
  canSaveDefault?: boolean;
}>();
const emit = defineEmits<{ close: []; saveDefault: [minor: number]; saveOnce: [minor: number] }>();

const text = ref(props.currentMinor !== null && props.currentMinor !== undefined
  ? (props.currentMinor / 100).toFixed(2).replace(/\.00$/, '')
  : '');
const error = ref('');

const minor = computed(() => parseMoney(text.value));
void props.canSaveDefault;

function guard(): number | null {
  const value = minor.value;
  if (value === null || value <= 0) {
    error.value =
      text.value.trim() === '' ? 'اكتب السعر الأول' : 'اكتب السعر بالجنيه والقروش، مثال: 8500';
    return null;
  }
  error.value = '';
  return value;
}

function saveDefault(): void {
  const value = guard();
  if (value !== null) emit('saveDefault', value);
}

function saveOnce(): void {
  const value = guard();
  if (value !== null) emit('saveOnce', value);
}
</script>

<template>
  <Modal title="سعر البيع" :sub="props.sub ?? props.name" size="sm" @close="emit('close')">
    <form class="stack" @submit.prevent="saveOnce">
      <p class="note">
        <template v-if="props.currentMinor !== null && props.currentMinor !== undefined">
          «{{ props.name }}» سعره الحالي <b class="num">{{ money(props.currentMinor) }}</b>.
          لو هتبيعه بسعر تاني دلوقتي، اختار السعر ده بيبقى إيه.
        </template>
        <template v-else>
          «{{ props.name }}» لسه مكتوبلهوش سعر بيع. اكتبه هنا، واختار: يتحفظ على الموديل
          ولا للفاتورة دي بس.
        </template>
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
      <small class="hint" v-if="minor !== null && minor > 0">
        هيتحسب على الفاتورة: {{ money(minor) }}
      </small>
      <div class="err-msg">{{ error }}</div>
    </form>
    <template #foot>
      <button
        type="button"
        class="btn primary"
        data-price-save-default
        @click="saveDefault"
      >
        احفظه سعر الموديل وكمّل البيع
      </button>
      <button type="button" class="btn soft" data-price-once @click="saveOnce">
        السعر للفاتورة دي بس
      </button>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع</button>
    </template>
  </Modal>
</template>
