<script setup lang="ts">
// Line warranty duration picker (`docs/PLAN.md` §16, `ADR-023`).
import { computed, ref } from 'vue';

import { monthsTxt, parseCount } from '../../ui/format';
import Modal from '../../ui/Modal.vue';
import { QUICK_WARRANTY_OPTIONS, warrantyDatesForMonths } from './warranty';

const props = defineProps<{
  name: string;
  warrantyMonths: number;
}>();

const emit = defineEmits<{
  close: [];
  apply: [warrantyMonths: number];
}>();

const text = ref(String(props.warrantyMonths));
const error = ref('');

const parsedMonths = computed<number | null>(() => {
  const raw = text.value.trim();
  if (raw === '' || raw === '0') return 0;
  const n = parseCount(raw);
  if (n === null || n < 0 || n > 60) return null;
  return n;
});

const preview = computed(() => {
  const m = parsedMonths.value;
  if (m === null) return null;
  const dates = warrantyDatesForMonths(m);
  return {
    months: m,
    label: m > 0 ? `ضمان ${monthsTxt(m)}` : 'بدون ضمان',
    warrantyStart: dates.warrantyStart,
    warrantyEnd: dates.warrantyEnd,
  };
});

function pickMonths(months: number): void {
  error.value = '';
  text.value = String(months);
}

function apply(): void {
  const m = parsedMonths.value;
  if (m === null) {
    error.value = 'اكتب عدد شهور الضمان من 0 لحد 60 شهر';
    return;
  }
  emit('apply', m);
}
</script>

<template>
  <Modal title="مدة الضمان" :sub="name" size="sm" @close="emit('close')">
    <form class="stack" @submit.prevent="apply" @keydown.enter.prevent="apply">
      <div class="field">
        <label>اختيار سريع</label>
        <div class="chips quick-warranty-chips">
          <button
            v-for="opt in QUICK_WARRANTY_OPTIONS"
            :key="opt.months"
            type="button"
            class="chip"
            :class="{ on: parsedMonths === opt.months }"
            @click="pickMonths(opt.months)"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="field">
        <label for="warranty-months-in">المدة بالشهور (0 = بدون ضمان، لحد 60 شهر)</label>
        <input
          id="warranty-months-in"
          v-model="text"
          class="big-in num"
          inputmode="numeric"
          autocomplete="off"
          data-autofocus
          @input="error = ''"
        />
      </div>

      <div v-if="preview" class="warranty-preview-box">
        <template v-if="preview.months > 0 && preview.warrantyEnd">
          <b>{{ preview.label }}</b>
          <span class="sub">
            من <span class="num mono">{{ preview.warrantyStart }}</span> لحد
            <span class="num mono">{{ preview.warrantyEnd }}</span>
          </span>
        </template>
        <template v-else>
          <span class="sub">بدون ضمان على هذا الصنف</span>
        </template>
      </div>

      <div v-if="error" class="err-msg">{{ error }}</div>
    </form>

    <template #foot>
      <button type="button" class="btn primary" @click="apply">
        تمام <kbd>Enter</kbd>
      </button>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع</button>
    </template>
  </Modal>
</template>

<style scoped>
.quick-warranty-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.warranty-preview-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-radius: var(--r-sm);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  font-size: 13px;
}
</style>
