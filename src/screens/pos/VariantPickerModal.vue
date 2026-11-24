<script setup lang="ts">
// Variant picker modal on the sales screen (`MODALS.variant` in
// `docs/ui/mockup-v1/views/catalog.js`, ADR-018 §4, plan item 1.2 step 4).
//
// Clicking a family tile («ليه X نوع») opens this modal with all combinations
// of the parent item. Out-of-stock variants are disabled («خلصان»), arrow keys
// skip disabled variants and wrap around, and Enter or a click adds the chosen
// variant to the active invoice.

import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

import type { PosProduct } from '../../api/pos';
import { money, num } from '../../ui/format';
import Modal from '../../ui/Modal.vue';
import {
  firstEnabledVariantIndex,
  stepVariantHighlight,
  variantOptionLabel,
} from './variants';

const props = defineProps<{
  parentName: string;
  dimensions: readonly string[];
  variants: readonly PosProduct[];
  freeStock: Readonly<Record<string, number>>;
}>();

const emit = defineEmits<{
  close: [];
  pick: [product: PosProduct];
}>();

function stockOf(v: PosProduct): number {
  return props.freeStock[v.id] ?? v.onHand;
}

function variantParts(v: PosProduct): string[] {
  const parts = [v.variant1, v.variant2].filter(
    (x): x is string => typeof x === 'string' && x.trim() !== ''
  );
  return parts.length > 0 ? parts : [variantOptionLabel(v)];
}



function isEnabled(v: PosProduct): boolean {
  return stockOf(v) > 0 && v.salePriceMinor !== null;
}

const enabledFlags = computed(() => props.variants.map(isEnabled));

const highlighted = ref(firstEnabledVariantIndex(enabledFlags.value));

const subTitle = computed(() => `اختار ${props.dimensions.join(' و')}`);

function choose(v: PosProduct): void {
  if (!isEnabled(v)) return;
  emit('pick', v);
}

function onKey(ev: KeyboardEvent): void {
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') {
    ev.preventDefault();
    ev.stopPropagation();
    highlighted.value = stepVariantHighlight(enabledFlags.value, highlighted.value, 1);
  } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    ev.stopPropagation();
    highlighted.value = stepVariantHighlight(enabledFlags.value, highlighted.value, -1);
  } else if (ev.key === 'Enter') {
    const picked = props.variants[highlighted.value];
    if (picked !== undefined && isEnabled(picked)) {
      ev.preventDefault();
      ev.stopPropagation();
      emit('pick', picked);
    }
  }
}

onMounted(() => {
  highlighted.value = firstEnabledVariantIndex(enabledFlags.value);
  window.addEventListener('keydown', onKey, true);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
});
</script>

<template>
  <Modal :title="parentName" :sub="subTitle" size="md" @close="emit('close')">
    <div class="vr-grid" role="listbox" aria-label="الأنواع">
      <button
        v-for="(v, index) in variants"
        :key="v.id"
        type="button"
        class="vr"
        :class="{ on: index === highlighted }"
        role="option"
        :aria-selected="index === highlighted"
        :disabled="!isEnabled(v)"
        @click="choose(v)"
      >
        <b>
          <template v-for="(part, pi) in variantParts(v)" :key="pi">
            <template v-if="pi > 0">، </template>
            <bdi dir="auto">{{ part }}</bdi>
          </template>
        </b>

        <span class="num">
          {{ v.salePriceMinor === null ? 'بدون سعر' : money(v.salePriceMinor) }}
        </span>
        <small
          :class="
            stockOf(v) <= 0 ? 'danger-t' : stockOf(v) <= 2 ? 'warn-t' : 'muted'
          "
        >
          {{ stockOf(v) <= 0 ? 'خلصان' : `${num(stockOf(v))} متاح` }}
        </small>
      </button>
    </div>

    <template #foot>
      <span class="muted">الأسهم وEnter، أو دوس على النوع</span>
      <span class="sp"></span>
      <button type="button" class="btn ghost" @click="emit('close')">
        قفل <kbd>Esc</kbd>
      </button>
    </template>
  </Modal>
</template>
