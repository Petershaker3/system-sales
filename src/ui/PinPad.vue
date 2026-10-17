<script setup lang="ts">
// The PIN pad of the approved mockup (views/lock.js and the user-switch menu in
// app.js): dots, a numpad, an error line — the look and the steps are the
// mockup's. One difference, because the daily PIN is 4 to 6 digits (ADR-017 §1)
// where the mockup's demo PINs are 4: the pad submits on Enter or «دخول», or by
// itself at the sixth digit, rather than at the fourth (which would count a
// failure against everyone whose PIN is longer).
//
// The parent owns the keyboard while a pad is shown (a lock overlay or the
// switch menu must stop keys from reaching the screen underneath), so keys come
// in through `handleKey`.
import { computed, ref } from 'vue';

import { num, toLatinDigits } from './format';
import Icon from './Icon.vue';

const MIN = 4;
const MAX = 6;

const props = withDefaults(
  defineProps<{ size?: 'lg' | 'sm'; error?: string; busy?: boolean; go?: string }>(),
  {
    size: 'lg',
    error: '',
    busy: false,
    /** The submit button's word: «دخول» to sign in, «وافق» to approve. */
    go: 'دخول',
  }
);
const emit = defineEmits<{ submit: [pin: string]; back: []; input: [] }>();

const pin = ref('');
const slots = computed(() => Math.max(MIN, pin.value.length));

function press(key: string): void {
  if (props.busy) return;
  if (key === 'del') {
    pin.value = pin.value.slice(0, -1);
    emit('input');
    return;
  }
  if (!/^[0-9]$/.test(key) || pin.value.length >= MAX) return;
  pin.value += key;
  emit('input');
  if (pin.value.length === MAX) submit();
}

function submit(): void {
  if (props.busy || pin.value.length < MIN) return;
  emit('submit', pin.value);
}

/** Forget what was typed (after a refusal, or when the pad is reused). */
function clear(): void {
  pin.value = '';
}

/** A digit from the key's position, so an Arabic keyboard layout types digits too. */
function digitOf(event: KeyboardEvent): string | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  const code = /^(?:Digit|Numpad)([0-9])$/.exec(event.code);
  if (code) return code[1] ?? null;
  const latin = toLatinDigits(event.key);
  return /^[0-9]$/.test(latin) ? latin : null;
}

/** Handle a key for the pad; `true` when it was the pad's. */
function handleKey(event: KeyboardEvent): boolean {
  const digit = digitOf(event);
  if (digit !== null) press(digit);
  else if (event.key === 'Backspace') press('del');
  else if (event.key === 'Enter' || event.key === 'NumpadEnter') submit();
  else if (event.key === 'Escape') emit('back');
  else return false;
  return true;
}

defineExpose({ handleKey, clear });
</script>

<template>
  <div class="pinpad">
    <div class="pin-dots" :class="{ sm: size === 'sm' }" aria-hidden="true">
      <i v-for="i in slots" :key="i" :class="{ on: i <= pin.length }" />
    </div>
    <div class="err-msg" role="alert">{{ error }}</div>
    <div class="numpad" :class="{ sm: size === 'sm' }">
      <button v-for="n in [1, 2, 3, 4, 5, 6, 7, 8, 9]" :key="n" type="button" @click="press(String(n))">
        {{ num(n) }}
      </button>
      <button type="button" title="رجوع (Esc)" @click="emit('back')"><Icon name="arrow-right" /></button>
      <button type="button" @click="press('0')">{{ num(0) }}</button>
      <button type="button" title="مسح" @click="press('del')"><Icon name="delete" /></button>
    </div>
    <button
      type="button"
      class="btn primary block pin-go"
      :class="size === 'sm' ? 'sm' : 'lg'"
      :disabled="busy || pin.length < 4"
      @click="submit"
    >
      {{ go }} <kbd>Enter</kbd>
    </button>
  </div>
</template>

<style scoped>
.pin-go {
  margin-top: 12px;
}
.pin-go.sm {
  margin-top: 8px;
}
</style>
