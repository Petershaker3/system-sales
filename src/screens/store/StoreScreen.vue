<script setup lang="ts">
// «المخزن» (owner decision ADR-016 #26). For now it hosts the panels that
// already work — products (with their category, ADR-018 §1) and stock
// receiving — in the new frame, and «صنف جديد» (ADR-018 §2 and §3). The
// categories and the phone companies are managed from the settings, as in the
// mockup. The full store screen of the mockup (variants, IMEI receiving,
// shortages) arrives with the next steps of plan item 1.2 and with 1.4 and 1.15.
import { ref } from 'vue';

import CatalogPanel from '../../components/CatalogPanel.vue';
import StockPanel from '../../components/StockPanel.vue';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import NewItemKindModal from './NewItemKindModal.vue';
import NewItemModal from './NewItemModal.vue';
import NewPhoneModal from './NewPhoneModal.vue';

/** The kind chooser behind «صنف جديد»; the form it names opens next. */
const kind = ref(false);
const newPhone = ref(false);
const newItem = ref(false);
/** Bumped after an item is registered, so the panels read the catalogue again. */
const reload = ref(0);

function pick(kindPicked: 'phone' | 'item'): void {
  kind.value = false;
  if (kindPicked === 'phone') newPhone.value = true;
  else newItem.value = true;
}

function registered(name: string): void {
  newPhone.value = false;
  newItem.value = false;
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
      <button type="button" class="btn primary" @click="kind = true"><Icon name="package-plus" /> صنف جديد</button>
    </div>
    <div class="note"><Icon name="info" /><span>الشاشة الكاملة للمخزن (الصور والاستلام بالـ IMEI والنواقص) جاية في المراحل الجاية من الخطة.</span></div>

    <div class="legacy-grid">
      <section class="card legacy-panel"><CatalogPanel :key="`c${reload}`" /></section>
      <section class="card legacy-panel"><StockPanel :key="`s${reload}`" @new-item="kind = true" /></section>
    </div>
    <NewItemKindModal v-if="kind" @close="kind = false" @pick="pick" />
    <NewPhoneModal v-if="newPhone" @close="newPhone = false" @created="registered" />
    <NewItemModal v-if="newItem" @close="newItem = false" @created="registered" />
  </div>
</template>

<style scoped>
.page-h .sp {
  flex: 1;
}
</style>
