<script setup lang="ts">
// «الإعدادات» — the owner's. The look comes first (the two looks, light/dark,
// the shop colour, the font, the size, the digits), then the recovery code
// (ADR-017 §4); then the device settings, the users and the backup panels that
// already work. The eight settings screens of the mockup are plan item 1.13.
import BackupPanel from '../../components/BackupPanel.vue';
import SettingsPanel from '../../components/SettingsPanel.vue';
import UserManagement from '../../components/UserManagement.vue';
import AppearanceCard from './AppearanceCard.vue';
import RecoveryCodeCard from './RecoveryCodeCard.vue';
</script>

<template>
  <div class="page">
    <div class="page-h">
      <h2>الإعدادات</h2>
      <span class="sub">الشكل الأول، وبعده إعدادات الجهاز والمستخدمين والنسخ الاحتياطي.</span>
    </div>
    <AppearanceCard />
    <RecoveryCodeCard />
    <div class="legacy-grid">
      <section class="card legacy-panel"><SettingsPanel /></section>
      <section class="card legacy-panel"><UserManagement /></section>
      <section class="card legacy-panel"><BackupPanel /></section>
    </div>
  </div>
</template>
