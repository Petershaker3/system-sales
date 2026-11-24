<script setup lang="ts">
// «زيادة» على إجمالي الفاتورة (طلب صاحب المحل، 2026-11-09، `0037`).
//
// عكس الخصم بالظبط في المعنى ومكانه في الحساب: الخصم بينزل من البنود، والزيادة
// بتطلع فوق صافي البنود (توصيل، تركيب، خدمة، تقريب). عشان كده ليها نافذة لوحدها
// وسطر لوحده في الفاتورة والإيصال — ما تختلطش بالخصم ولا تلغيه.
//
// الأرقام السريعة مش تخمين سعر: هي المبالغ اللي بتتكرر فعلًا في المحل (٥ للكيس،
// ١٠ للتركيب...). أي مبلغ تاني يتكتب في الخانة.
import { computed, ref } from 'vue';

import { money, moneyInputValue, moneyUnitWord, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { MAX_SURCHARGE_MINOR } from './cart';

const props = defineProps<{
  /** What is added on this invoice right now. */
  currentMinor: number;
  /** The invoice's net total after every discount, before the addition. */
  baseMinor: number;
}>();

const emit = defineEmits<{
  close: [];
  apply: [surchargeMinor: number];
}>();

const text = ref(props.currentMinor > 0 ? moneyInputValue(props.currentMinor) : '');
const error = ref('');

const typedMinor = computed<number | null>(() => {
  if (text.value.trim() === '') return 0;
  return parseMoney(text.value);
});

const QUICK = [5, 10, 20, 50, 100];

function pick(egp: number): void {
  text.value = String(egp);
  error.value = '';
}

function apply(): void {
  const minor = typedMinor.value;
  if (minor === null || minor < 0) {
    error.value = 'اكتب مبلغ صحيح.';
    return;
  }
  if (minor > MAX_SURCHARGE_MINOR) {
    error.value = `أقصى زيادة على فاتورة واحدة ${money(MAX_SURCHARGE_MINOR)}.`;
    return;
  }
  emit('apply', minor);
}

function clearIt(): void {
  emit('apply', 0);
}
</script>

<template>
  <Modal
    title="زيادة على الفاتورة"
    sub="توصيل، تركيب، خدمة، أو تقريب — بتتضاف بعد الخصم"
    size="sm"
    @close="emit('close')"
  >
    <form class="stack" @submit.prevent="apply">
      <div class="chips" style="gap: 6px">
        <button
          v-for="egp in QUICK"
          :key="egp"
          type="button"
          class="chip"
          :class="{ active: text.trim() === String(egp) }"
          :data-surcharge-quick="egp"
          @click="pick(egp)"
        >
          +{{ egp }}
        </button>
      </div>

      <div class="field">
        <label for="surcharge-input">المبلغ المضاف ({{ moneyUnitWord() }})</label>
        <input
          id="surcharge-input"
          v-model="text"
          class="big-in num"
          inputmode="decimal"
          autocomplete="off"
          placeholder="0"
          data-autofocus
          data-surcharge-input
        />
      </div>

      <div class="due-box">
        <div class="r">
          <span>صافي الفاتورة قبل الزيادة</span>
          <span class="num">{{ money(props.baseMinor) }}</span>
        </div>
        <div class="r">
          <span>الزيادة</span>
          <span class="num">+ {{ money(typedMinor ?? 0) }}</span>
        </div>
        <div class="r grand">
          <span>المطلوب من العميل</span>
          <span class="num">{{ money(props.baseMinor + (typedMinor ?? 0)) }}</span>
        </div>
      </div>

      <div v-if="error" class="err-msg">{{ error }}</div>
    </form>

    <template #foot>
      <button type="button" class="btn primary" data-surcharge-apply @click="apply">
        <Icon name="check" /> تطبيق الزيادة
      </button>
      <button
        v-if="props.currentMinor > 0"
        type="button"
        class="btn"
        data-surcharge-clear
        @click="clearIt"
      >
        شيل الزيادة
      </button>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع</button>
    </template>
  </Modal>
</template>
