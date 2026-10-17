<script setup lang="ts">
// «المبيعات». The full screen of the mockup — days, months, filters, views by
// invoice, day, item and category, and cancelling from the list — is plan
// item 1.14 (returns are 1.11). Until then it hosts the customer file.
//
// The old sale panel (components/SalesPanel.vue) is no longer shown: selling
// happens on «البيع», and two ways to sell would only confuse the counter. It
// is replaced, together with its narrow «cancel the sale I just recorded», by
// the sales screen of item 1.14.
import CustomerPanel from '../../components/CustomerPanel.vue';
import Icon from '../../ui/Icon.vue';
</script>

<template>
  <div class="page">
    <div class="page-h">
      <h2>العملاء</h2>
      <span class="sub">البيع نفسه من شاشة «البيع». هنا ملف العملاء.</span>
    </div>
    <div class="note">
      <Icon name="info" />
      <span>قايمة الفواتير بالأيام والشهور والفلاتر، وإلغاء فاتورة منها، جاية في البند 1.14 من الخطة، والمرتجع في البند 1.11.</span>
    </div>
    <div class="legacy-grid">
      <section class="card legacy-panel"><CustomerPanel /></section>
    </div>
  </div>
</template>
