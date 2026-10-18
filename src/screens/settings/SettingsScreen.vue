<script setup lang="ts">
// «الإعدادات» — the owner's. The look comes first (the two looks, light/dark,
// the shop colour, the font, the size, the digits), then the categories of the
// sales screen (ADR-018 §1) and the phone companies (§2), then the recovery
// code (ADR-017 §4); then the
// device settings, the users and the backup panels that already work. The eight
// settings screens of the mockup are plan item 1.13.
import BackupPanel from '../../components/BackupPanel.vue';
import SettingsPanel from '../../components/SettingsPanel.vue';
import UserManagement from '../../components/UserManagement.vue';
import AppearanceCard from './AppearanceCard.vue';
import BrandsCard from './BrandsCard.vue';
import CategoriesCard from './CategoriesCard.vue';
import DiscountLimitCard from './DiscountLimitCard.vue';
import ImeiModeCard from './ImeiModeCard.vue';
import PaymentMethodsCard from './PaymentMethodsCard.vue';
import ProductImagesCard from './ProductImagesCard.vue';
import ReceiptSettingsCard from './ReceiptSettingsCard.vue';
import RecoveryCodeCard from './RecoveryCodeCard.vue';
import ShopProfileCard from './ShopProfileCard.vue';
import WalletsSettingsCard from './WalletsSettingsCard.vue';
</script>

<template>
  <div class="page">
    <div class="page-h">
      <h2>الإعدادات</h2>
      <span class="sub">بيانات المحل، والشكل، والإيصال والواتساب، والتصنيفات، والمستخدمين والنسخ الاحتياطي.</span>
    </div>
    <ShopProfileCard />
    <AppearanceCard />
    <ReceiptSettingsCard />
    <ProductImagesCard />
    <ImeiModeCard />
    <PaymentMethodsCard />
    <WalletsSettingsCard />
    <DiscountLimitCard />
    <CategoriesCard />
    <BrandsCard />

    <RecoveryCodeCard />
    <div class="legacy-grid">
      <section class="card legacy-panel"><SettingsPanel /></section>
      <section class="card legacy-panel"><UserManagement /></section>
      <section class="card legacy-panel"><BackupPanel /></section>
    </div>
  </div>
</template>
