<script setup lang="ts">
// «المخزن» (owner decision ADR-016 #26). For now it hosts the panels that
// already work — products (with their category, ADR-018 §1) and stock
// receiving — in the new frame, and «موبايل جديد» (ADR-018 §2). The categories
// and the phone companies are managed from the settings, as in the mockup. The
// full store screen of the mockup (variants, IMEI receiving, shortages) arrives
// with the next steps of plan item 1.2 and with 1.4 and 1.15.
import { ref } from 'vue';

import CatalogPanel from '../../components/CatalogPanel.vue';
import StockPanel from '../../components/StockPanel.vue';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import NewPhoneModal from './NewPhoneModal.vue';

const newPhone = ref(false);
/** Bumped after a phone is registered, so the panels read the catalogue again. */
const reload = ref(0);

function registered(name: string): void {
  newPhone.value = false;
  reload.value += 1;
  toast(`اتسجّل «${name}». استلم الكمية بسعر الشراء من «استلام توريد»`, 'ok', 4500);
}
</script>

<template>
  <div class="page">
    <div class="page-h">
      <h2>الأصناف والكميات</h2>
      <span class="sub">سجّل الصنف بسعره، وبعدين استلم الكمية بسعر الشراء. التكلفة بتتحسب بالمتوسط المرجح.</span>
      <span class="sp"></span>
      <button type="button" class="btn primary" @click="newPhone = true"><Icon name="smartphone" /> موبايل جديد</button>
    </div>
    <div class="note"><Icon name="info" /><span>الشاشة الكاملة للمخزن (التفرعات والاستلام بالـ IMEI والنواقص) جاية في المراحل الجاية من الخطة.</span></div>
    <div class="legacy-grid">
      <section class="card legacy-panel"><CatalogPanel :key="`c${reload}`" /></section>
      <section class="card legacy-panel"><StockPanel :key="`s${reload}`" /></section>
    </div>
    <NewPhoneModal v-if="newPhone" @close="newPhone = false" @created="registered" />
  </div>
</template>

<style scoped>
.page-h .sp {
  flex: 1;
}
</style>
