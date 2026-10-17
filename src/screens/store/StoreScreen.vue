<script setup lang="ts">
// «المخزن» (owner decision ADR-016 #26). For now it hosts the panels that
// already work — products (with their category, ADR-018 §1) and stock
// receiving — in the new frame. The categories themselves are managed from the
// settings, as in the mockup. The full store screen of the mockup (items with
// brands and variants, IMEI receiving, shortages) arrives with the next steps of
// plan item 1.2 and with 1.4 and 1.15.
import CatalogPanel from '../../components/CatalogPanel.vue';
import StockPanel from '../../components/StockPanel.vue';
import Icon from '../../ui/Icon.vue';
</script>

<template>
  <div class="page">
    <div class="page-h">
      <h2>الأصناف والكميات</h2>
      <span class="sub">سجّل الصنف بسعره، وبعدين استلم الكمية بسعر الشراء. التكلفة بتتحسب بالمتوسط المرجح.</span>
    </div>
    <div class="note"><Icon name="info" /><span>الشاشة الكاملة للمخزن (الشركات والأنواع والاستلام بالـ IMEI والنواقص) جاية في المراحل الجاية من الخطة.</span></div>
    <div class="legacy-grid">
      <section class="card legacy-panel"><CatalogPanel /></section>
      <section class="card legacy-panel"><StockPanel /></section>
    </div>
  </div>
</template>
