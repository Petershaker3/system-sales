<script setup lang="ts">
// Which wallet number took this money (`ADR-041`).
//
// Shown only where a choice exists: a shop with one number per method has nothing to pick, and
// the backend answers with a single candidate for it. Every flow that moves money — a sale at the
// till, a refund, a customer settling a debt, a repair being settled — puts these chips next to
// its method buttons, so the number the accounting records is the number the operator looked at.
//
// The value is the wallet id or `null`. `null` is not "unknown": it means the primary for the
// method, which is the same answer the backend gives when nothing is named, so the default the
// operator sees and the money the ledger holds cannot drift apart.
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

/** A method only a shop wallet can hold, and therefore a method worth asking about. */
function pickable(method: string | null): boolean {
  return method === 'vf' || method === 'instapay';
}

async function load(method: string | null): Promise<void> {
  error.value = '';
  if (!pickable(method)) {
    options.value = [];
    if (props.modelValue !== null) emit('update:modelValue', null);
    return;
  }
  try {
    const found = await paymentWalletCandidates(method ?? '');
    // One candidate is not a choice, and a picked number that is no longer on the list (deleted,
    // hidden, or given another method) is dropped rather than left to be refused at write time.
    options.value = found.length > 1 ? found : [];
    if (props.modelValue !== null && !found.some((w) => w.id === props.modelValue)) {
      emit('update:modelValue', null);
    }
  } catch (err) {
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
  <div v-if="options.length > 1 || error" class="field wallet-number-chips">
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
      سيبها لو المحل فيه رقم واحد بس للطريقة دي — هتتسجّل عليه لوحده.
    </span>
  </div>
</template>
