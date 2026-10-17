<script setup lang="ts">
import Icon from './Icon.vue';
import { toasts } from './toast';
</script>

<template>
  <div id="toasts" role="status" aria-live="polite">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="[t.kind, { out: t.out }]">
      <Icon :name="t.kind === 'err' ? 'circle-alert' : t.kind === 'info' ? 'info' : 'circle-check'" />
      <span>{{ t.message }}</span>
    </div>
  </div>
</template>
