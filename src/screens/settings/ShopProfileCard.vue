<script setup lang="ts">
// «بيانات المحل» card in Settings (`docs/ui/mockup-v1/views/settings.js` `setShop`,
// `docs/PLAN.md` §10, §16; `ADR-022`).
import { computed, onMounted, ref, watch } from 'vue';

import { describeError } from '../../api/errors';
import {
  appearance,
  clearShopLogo,
  loadShopLogo,
  saveShopLogo,
  setAppearance,
  shopLogo,
} from '../../ui/appearance';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import type { ReceiptData } from '../pos/receipt';
import ReceiptPreview from '../pos/ReceiptPreview.vue';
import { approxKilobytes, shrinkImageFile } from '../store/image';

const shopNameDraft = ref(appearance.shopName);
const shopPhoneDraft = ref(appearance.shopPhone);
const shopAddressDraft = ref(appearance.shopAddress);
const logoBusy = ref(false);

watch(
  () => appearance.shopName,
  (v) => {
    shopNameDraft.value = v;
  }
);
watch(
  () => appearance.shopPhone,
  (v) => {
    shopPhoneDraft.value = v;
  }
);
watch(
  () => appearance.shopAddress,
  (v) => {
    shopAddressDraft.value = v;
  }
);

onMounted(() => {
  void loadShopLogo();
});

const sampleReceipt = computed<ReceiptData>(() => ({
  reference: '20261018-0001',
  occurredAt: new Date(2026, 9, 18, 14, 30),
  sellerName: 'بيتر',
  customerName: 'أحمد سمير',
  lines: [
    {
      name: 'Samsung Galaxy A16 128GB',
      quantity: 1,
      unitPriceMinor: 925_000,
      discountMinor: 0,
      lineTotalMinor: 925_000,
      imei: '352867150000004',
      warrantyMonths: 12,
      warrantyEnd: null,
    },
    {
      name: 'جراب سيليكون شفاف',
      quantity: 2,
      unitPriceMinor: 12_000,
      discountMinor: 0,
      lineTotalMinor: 24_000,
      imei: null,
      warrantyMonths: 0,
      warrantyEnd: null,
    },
  ],
  grossSubtotalMinor: 949_000,
  discountMinor: 0,
  totalMinor: 949_000,
  payments: [{ method: 'cash', amountMinor: 949_000, reference: null }],
  changeMinor: 1_000,
}));

async function saveShopField(
  field: 'shopName' | 'shopPhone' | 'shopAddress'
): Promise<void> {
  const val =
    field === 'shopName'
      ? shopNameDraft.value.trim()
      : field === 'shopPhone'
        ? shopPhoneDraft.value.trim()
        : shopAddressDraft.value.trim();

  if (field === 'shopName' && val === '') {
    toast('اسم المحل ماينفعش يبقى فاضي', 'err');
    shopNameDraft.value = appearance.shopName;
    return;
  }
  if (val === appearance[field]) return;
  try {
    await setAppearance({ [field]: val });
    toast('اتحفظت بيانات المحل', 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function onPickLogo(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || logoBusy.value) return;
  logoBusy.value = true;
  try {
    const dataUrl = await shrinkImageFile(file);
    await saveShopLogo(dataUrl);
    toast(`اتحفظ لوجو المحل (${approxKilobytes(dataUrl)} ك.ب)`, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    logoBusy.value = false;
  }
}

async function onRemoveLogo(): Promise<void> {
  if (logoBusy.value) return;
  logoBusy.value = true;
  try {
    await clearShopLogo();
    toast('اتشال لوجو المحل', 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    logoBusy.value = false;
  }
}
</script>

<template>
  <section class="card" data-card="shop-profile">
    <h3>بيانات المحل</h3>
    <div class="preview-pair">
      <div class="stack">
        <div class="field">
          <label for="set-shopName">اسم المحل</label>
          <input
            id="set-shopName"
            v-model="shopNameDraft"
            maxlength="120"
            autocomplete="off"
            @change="saveShopField('shopName')"
          />
        </div>
        <div class="grid2">
          <div class="field">
            <label for="set-shopPhone">التليفون</label>
            <input
              id="set-shopPhone"
              v-model="shopPhoneDraft"
              dir="ltr"
              inputmode="tel"
              maxlength="40"
              autocomplete="off"
              @change="saveShopField('shopPhone')"
            />
          </div>
          <div class="field">
            <label for="set-shopAddress">العنوان</label>
            <input
              id="set-shopAddress"
              v-model="shopAddressDraft"
              maxlength="200"
              autocomplete="off"
              @change="saveShopField('shopAddress')"
            />
          </div>
        </div>
        <div class="field">
          <span class="label">اللوجو</span>
          <div class="logo-up">
            <div class="logo" data-shop-logo-preview>
              <img v-if="shopLogo" :src="shopLogo" alt="لوجو المحل" />
              <span v-else>{{ (appearance.shopName || 'م').trim().charAt(0) }}</span>
            </div>
            <div class="stack" style="gap: 8px">
              <div class="row wrap" style="gap: 8px">
                <label class="btn sm" :class="{ disabled: logoBusy }">
                  <Icon name="upload" /> ارفع لوجو
                  <input
                    id="shop-logo-file"
                    type="file"
                    accept="image/*"
                    hidden
                    :disabled="logoBusy"
                    @change="onPickLogo"
                  />
                </label>
                <button
                  v-if="shopLogo"
                  id="remove-shop-logo-btn"
                  type="button"
                  class="btn sm ghost danger"
                  :disabled="logoBusy"
                  @click="onRemoveLogo"
                >
                  <Icon name="trash-2" /> شيل اللوجو
                </button>
              </div>
              <span class="hint">
                PNG أو JPG، بيتقص مربع 192×192 وبيتصغّر لوحده. بيظهر في البرنامج وعلى الإيصال وبيدخل في النسخة الاحتياطية.
              </span>
            </div>
          </div>
        </div>
      </div>
      <ReceiptPreview :sale="sampleReceipt" />
    </div>
  </section>
</template>
