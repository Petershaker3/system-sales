<script setup lang="ts">
// «الإعدادات» — 8 tabs matching the approved mockup (`docs/ui/mockup-v1/views/settings.js`,
// `docs/PLAN.md` §16, §19; `ADR-028`):
//   1. `shop`    — المحل
//   2. `look`    — الشكل
//   3. `catalog` — الأصناف والبيع
//   4. `users`   — المستخدمين والصلاحيات
//   5. `pay`     — المحافظ والدفع
//   6. `receipt` — الإيصال والضمان
//   7. `backup`  — النسخ الاحتياطي
//   8. `devices` — الأجهزة والطابعة
import { ref } from 'vue';

import BackupPanel from '../../components/BackupPanel.vue';
import SettingsPanel from '../../components/SettingsPanel.vue';
import UserManagement from '../../components/UserManagement.vue';
import { describeError } from '../../api/errors';
import {
  appearance,
  DEFAULT_APPEARANCE,
  setAppearance,
  type Appearance,
} from '../../ui/appearance';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import AppearanceCard from './AppearanceCard.vue';
import BackupPolicyCard from './BackupPolicyCard.vue';
import BrandsCard from './BrandsCard.vue';
import CategoriesCard from './CategoriesCard.vue';
import DevicesPrinterCard from './DevicesPrinterCard.vue';
import DiscountLimitCard from './DiscountLimitCard.vue';
import ImeiModeCard from './ImeiModeCard.vue';
import MoneyUnitCard from './MoneyUnitCard.vue';
import OwnerAccountCard from './OwnerAccountCard.vue';
import PaymentMethodsCard from './PaymentMethodsCard.vue';
import ProductImagesCard from './ProductImagesCard.vue';
import ReceiptSettingsCard from './ReceiptSettingsCard.vue';
import RecoveryCodeCard from './RecoveryCodeCard.vue';
import ShopProfileCard from './ShopProfileCard.vue';
import {
  isTabSectionVisible,
  selectSettingsTab,
  SETTINGS_TABS,
  type SettingsTabId,
  type SettingsViewTab,
} from './tabs';
import WalletsSettingsCard from './WalletsSettingsCard.vue';

const activeTab = ref<SettingsViewTab>('all');

function onPickTab(tab: SettingsViewTab): void {
  activeTab.value = selectSettingsTab(activeTab.value, tab);
}

function showSection(tab: SettingsTabId): boolean {
  return isTabSectionVisible(activeTab.value, tab);
}

/**
 * Jump to one tab (`ADR-039`).
 *
 * The shell's open-shop banner asks for الإعدادات ← المستخدمين والصلاحيات, where the
 * owner account is made; a screen the shell already mounted has to be told, and a
 * prop would be re-read on every render for a single tap.
 */
function openTab(tab: SettingsTabId): void {
  activeTab.value = tab;
}

defineExpose({ openTab });

async function onResetSettings(): Promise<void> {
  const catalogDefaults: Partial<Appearance> = {
    theme: DEFAULT_APPEARANCE.theme,
    images: DEFAULT_APPEARANCE.images,
    imeiMode: DEFAULT_APPEARANCE.imeiMode,
    payMethods: DEFAULT_APPEARANCE.payMethods,
    discountLimitPct: DEFAULT_APPEARANCE.discountLimitPct,
    shopName: DEFAULT_APPEARANCE.shopName,
    shopPhone: DEFAULT_APPEARANCE.shopPhone,
    shopAddress: DEFAULT_APPEARANCE.shopAddress,
    receiptFooter: DEFAULT_APPEARANCE.receiptFooter,
    waTemplate: DEFAULT_APPEARANCE.waTemplate,
    receiptMode: DEFAULT_APPEARANCE.receiptMode,
    printerEnabled: DEFAULT_APPEARANCE.printerEnabled,
    receiptPaper: DEFAULT_APPEARANCE.receiptPaper,
    warrantyNew: DEFAULT_APPEARANCE.warrantyNew,
    warrantyUsed: DEFAULT_APPEARANCE.warrantyUsed,
    warrantyItem: DEFAULT_APPEARANCE.warrantyItem,
    sellerCanCloseShift: DEFAULT_APPEARANCE.sellerCanCloseShift,
    serviceFeeMode: DEFAULT_APPEARANCE.serviceFeeMode,
    serviceFeePct: DEFAULT_APPEARANCE.serviceFeePct,
    serviceFeeMin: DEFAULT_APPEARANCE.serviceFeeMin,
    billFee: DEFAULT_APPEARANCE.billFee,
    backupOnShift: DEFAULT_APPEARANCE.backupOnShift,
    backupEvery2h: DEFAULT_APPEARANCE.backupEvery2h,
    backupUsbAuto: DEFAULT_APPEARANCE.backupUsbAuto,
    backupVerify: DEFAULT_APPEARANCE.backupVerify,
  };
  try {
    await setAppearance(catalogDefaults);
    const lookChanged =
      appearance.look !== DEFAULT_APPEARANCE.look ||
      appearance.accent !== DEFAULT_APPEARANCE.accent ||
      appearance.font !== DEFAULT_APPEARANCE.font ||
      appearance.scale !== DEFAULT_APPEARANCE.scale ||
      appearance.digits !== DEFAULT_APPEARANCE.digits ||
      appearance.moneyUnit !== DEFAULT_APPEARANCE.moneyUnit;
    if (lookChanged) {
      try {
        await setAppearance({
          look: DEFAULT_APPEARANCE.look,
          accent: DEFAULT_APPEARANCE.accent,
          font: DEFAULT_APPEARANCE.font,
          scale: DEFAULT_APPEARANCE.scale,
          digits: DEFAULT_APPEARANCE.digits,
          moneyUnit: DEFAULT_APPEARANCE.moneyUnit,
        });
      } catch {
        // Look keys require a fresh password if not already re-authenticated;
        // catalog & theme defaults have already been restored.
      }
    }
    toast('رجعت الإعدادات الأصلية', 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <div class="page">
    <div class="page-h">
      <h2>الإعدادات</h2>
      <span class="sub">كل تغيير بيتحفظ لوحده</span>
    </div>

    <div class="settings" data-settings-layout>
      <nav class="s-nav" aria-label="أقسام الإعدادات" data-settings-nav>
        <button
          v-for="tab in SETTINGS_TABS"
          :key="tab.id"
          type="button"
          :class="{ on: activeTab === tab.id }"
          :data-settings-tab="tab.id"
          @click="onPickTab(tab.id)"
        >
          <Icon :name="tab.icon" />
          <span>{{ tab.label }}</span>
        </button>

        <button
          v-if="activeTab !== 'all'"
          type="button"
          data-settings-tab="all"
          @click="onPickTab('all')"
        >
          <Icon name="layout-grid" />
          <span>كل الإعدادات</span>
        </button>

        <button
          type="button"
          style="margin-top: 10px"
          data-reset-settings-btn
          @click="onResetSettings"
        >
          <Icon name="rotate-ccw" />
          <span>رجّع الإعدادات الأصلية</span>
        </button>
      </nav>

      <div class="s-sec" data-settings-sec>
        <!-- 1. المحل -->
        <div v-show="showSection('shop')" class="s-sec" data-settings-panel="shop">
          <ShopProfileCard />
        </div>

        <!-- 2. الشكل -->
        <div v-show="showSection('look')" class="s-sec" data-settings-panel="look">
          <MoneyUnitCard />
          <AppearanceCard />
        </div>

        <!-- 3. الأصناف والبيع -->
        <div v-show="showSection('catalog')" class="s-sec" data-settings-panel="catalog">
          <ImeiModeCard />
          <ProductImagesCard />
          <CategoriesCard />
          <BrandsCard />
        </div>

        <!-- 4. المستخدمين والصلاحيات -->
        <div v-show="showSection('users')" class="s-sec" data-settings-panel="users">
          <!-- First, because on a shop that has no account yet this is the only
               thing here the owner came for (`ADR-039`). -->
          <OwnerAccountCard />
          <DiscountLimitCard />
          <RecoveryCodeCard />
          <section class="card legacy-panel"><UserManagement /></section>
        </div>

        <!-- 5. المحافظ والدفع -->
        <div v-show="showSection('pay')" class="s-sec" data-settings-panel="pay">
          <WalletsSettingsCard />
          <PaymentMethodsCard />
        </div>

        <!-- 6. الإيصال والضمان -->
        <div v-show="showSection('receipt')" class="s-sec" data-settings-panel="receipt">
          <ReceiptSettingsCard />
          <section class="card legacy-panel"><SettingsPanel /></section>
        </div>

        <!-- 7. النسخ الاحتياطي -->
        <div v-show="showSection('backup')" class="s-sec" data-settings-panel="backup">
          <BackupPolicyCard />
          <section class="card legacy-panel"><BackupPanel /></section>
        </div>

        <!-- 8. الأجهزة والطابعة -->
        <div v-show="showSection('devices')" class="s-sec" data-settings-panel="devices">
          <DevicesPrinterCard />
        </div>
      </div>
    </div>
  </div>
</template>
