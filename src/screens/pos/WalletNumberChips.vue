<script setup lang="ts">
// Explicitly select the actual receiving wallet; absence is not a primary.
import { onMounted, ref, watch } from 'vue';
import { paymentWalletCandidates, type PaymentWalletOption } from '../../api/wallet';

const props = defineProps<{
  /** The pay method whose numbers to offer. Cash, card and آجل move no wallet money. */
  method: string | null;
  modelValue: string | null;
  disabled?: boolean;
}>();

const emit = defineEmits<{ 'update:modelValue': [value: string | null] }>();

const options = ref<PaymentWalletOption[]>([]);
const error = ref('');
let request = 0;

/** A method only a shop wallet can hold, and therefore a method worth asking about. */
function pickable(method: string | null): boolean {
  return method === 'vf' || method === 'instapay';
}

async function load(method: string | null): Promise<void> {
  const current = ++request;
  error.value = '';
  if (!pickable(method)) {
    options.value = [];
    if (props.modelValue !== null) emit('update:modelValue', null);
    return;
  }
  try {
    const found = await paymentWalletCandidates(method ?? '');
    if (current !== request) return;
    options.value = found;
    if (props.modelValue !== null && !found.some((w) => w.id === props.modelValue)) {
      emit('update:modelValue', null);
    }
  } catch (err) {
    if (current !== request) return;
    options.value = [];
    error.value = err instanceof Error ? err.message : String(err);
  }
}

onMounted(() => void load(props.method));
watch(
  () => props.method,
  (next) => void load(next)
);
</script>

<template>
  <div v-if="pickable(method)" class="field wallet-number-chips">
    <span class="lbl">رقم المحفظة اللي استلمت</span>
    <div class="seg" role="radiogroup" aria-label="رقم المحفظة">
      <button
        v-for="w in options"
        :key="w.id"
        type="button"
        :class="{ active: modelValue === w.id }"
        :disabled="disabled"
        :aria-checked="modelValue === w.id"
        role="radio"
        :data-wallet-choice="w.id"
        @click="emit('update:modelValue', modelValue === w.id ? null : w.id)"
      >
        {{ w.name }}
        <bdi dir="ltr" class="mono">{{ w.number }}</bdi>
      </button>
    </div>
    <span v-if="error" class="hint">{{ error }}</span>
    <span v-else class="hint">
      اختار رقم المحفظة الذي استلم المبلغ؛ لا يُفترض رقم تلقائياً.
    </span>
  </div>
</template>
