<script setup lang="ts">
// One icon from the approved set (icons.ts, Lucide, ISC). The markup is a
// static string compiled into the bundle, never data, so v-html is safe here.
import { computed } from 'vue';

import { ICONS } from './icons';
import type { IconName } from './icons';

const props = defineProps<{ name: IconName }>();
const body = computed(() => ICONS[props.name]);
</script>

<template>
  <svg
    class="i"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="body"
  />
</template>
