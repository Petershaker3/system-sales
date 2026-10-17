<script setup lang="ts">
// The kind chooser behind «صنف جديد» (the mockup's `niKinds`, ADR-018 §3):
// a new phone, or a counted item. «موبايل مستعمل» is not shown until its units
// exist in item 1.4 — a button is not offered before it works.
import { onBeforeUnmount, onMounted } from 'vue';

import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';

const emit = defineEmits<{ close: []; pick: [kind: 'phone' | 'item'] }>();

function onKey(event: KeyboardEvent): void {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.key === '1') {
    event.preventDefault();
    emit('pick', 'phone');
  } else if (event.key === '2') {
    event.preventDefault();
    emit('pick', 'item');
  }
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Modal title="صنف جديد" sub="اختار نوعه" size="md" @close="emit('close')">
    <div class="ni-kinds">
      <button type="button" class="ni-kind" @click="emit('pick', 'phone')">
        <span class="t-ico"><Icon name="smartphone" /></span>
        <span class="t">
          <b>موبايل جديد</b>
          <small>الشركة والموديل والمساحة. كل جهاز بالـ IMEI بتاعه وقت الاستلام</small>
        </span>
        <kbd>1</kbd>
      </button>
      <button type="button" class="ni-kind" @click="emit('pick', 'item')">
        <span class="t-ico"><Icon name="package" /></span>
        <span class="t">
          <b>إكسسوار أو أي صنف بالعدد</b>
          <small>جرابات وشواحن وسماعات، بالتصنيف والباركود أو كود المحل</small>
        </span>
        <kbd>2</kbd>
      </button>
    </div>
    <div class="note">
      <Icon name="info" />
      <span>التصنيفات والشركات بتتغيّر من الإعدادات. وأي صنف بيتسجّل هنا بيظهر على طول في البيع والبحث والمخزن.</span>
    </div>
    <template #foot>
      <span class="muted">دوس 1 أو 2</span>
      <span class="sp"></span>
      <button type="button" class="btn ghost" @click="emit('close')">رجوع <kbd>Esc</kbd></button>
    </template>
  </Modal>
</template>

<style scoped>
.sp {
  flex: 1;
}
.ni-kinds {
  display: grid;
  gap: 10px;
}
.ni-kind {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-m);
  background: var(--surface);
  color: var(--text);
  text-align: start;
  font: inherit;
  cursor: pointer;
}
.ni-kind:hover,
.ni-kind:focus-visible {
  border-color: var(--accent-text);
  background: var(--surface-2);
}
.t-ico {
  display: grid;
  place-items: center;
  flex: none;
  width: 42px;
  height: 42px;
  border-radius: var(--r-s);
  background: var(--accent-weak);
  color: var(--accent-text);
}
.t-ico :deep(svg.i) {
  width: 22px;
  height: 22px;
}
.t {
  display: grid;
  gap: 2px;
  min-width: 0;
}
.t b {
  font-size: 0.98rem;
}
.t small {
  color: var(--text-2);
  font-size: 0.8rem;
}
.ni-kind kbd {
  margin-inline-start: auto;
  flex: none;
}
.note {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin-top: 12px;
  color: var(--text-2);
  font-size: 0.85rem;
}
.note :deep(svg.i) {
  width: 15px;
  height: 15px;
  flex: none;
  margin-top: 2px;
}
</style>
