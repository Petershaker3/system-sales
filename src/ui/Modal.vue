<script setup lang="ts">
// A window over the screen (docs/ui/mockup-v1: `.overlay > .modal`).
// Esc and a click on the dim background close it; the first field marked
// `data-autofocus` takes the focus when it opens.
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue';

import Icon from './Icon.vue';

const props = withDefaults(
  defineProps<{ title: string; sub?: string; size?: 'sm' | 'md' | 'wide' | ''; closable?: boolean }>(),
  { sub: '', size: '', closable: true }
);
const emit = defineEmits<{ close: [] }>();
const box = ref<HTMLElement | null>(null);

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.closable) {
    event.preventDefault();
    event.stopPropagation();
    emit('close');
  }
}

onMounted(async () => {
  document.body.classList.add('has-modal');
  window.addEventListener('keydown', onKey, true);
  await nextTick();
  const first = box.value?.querySelector<HTMLElement>('[data-autofocus]');
  first?.focus({ preventScroll: true });
  if (first instanceof HTMLInputElement) first.select();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true);
  if (document.querySelectorAll('.overlay').length <= 1) document.body.classList.remove('has-modal');
});
</script>

<template>
  <div class="overlay" @mousedown.self="closable && emit('close')">
    <div ref="box" class="modal" :class="size" role="dialog" aria-modal="true" :aria-label="title">
      <div class="modal-h">
        <h2>
          <span class="mt">{{ title }}</span>
          <small v-if="sub">{{ sub }}</small>
        </h2>
        <button v-if="closable" type="button" class="icon-btn sm" title="إغلاق (Esc)" @click="emit('close')">
          <Icon name="x" />
        </button>
      </div>
      <div class="modal-b">
        <slot />
      </div>
      <div v-if="$slots['foot']" class="modal-f">
        <slot name="foot" />
      </div>
    </div>
  </div>
</template>
