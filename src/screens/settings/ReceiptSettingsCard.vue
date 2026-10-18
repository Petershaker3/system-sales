<script setup lang="ts">
// «الإيصال والواتساب» card in Settings (`docs/ui/mockup-v1/views/settings.js`
// `setReceipt` & `setDevices`, `docs/PLAN.md` §10, §16; `ADR-022`).
import { computed, ref, watch } from 'vue';

import { describeError } from '../../api/errors';
import {
  appearance,
  type ReceiptModeChoice,
  type ReceiptPaperChoice,
  setAppearance,
} from '../../ui/appearance';
import { num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import {
  effectiveReceiptSetting,
  formatWhatsAppMessage,
  type ReceiptData,
  receiptModeOptions,
  warrantyLabelForReceipt,
} from '../pos/receipt';
import ReceiptPreview from '../pos/ReceiptPreview.vue';

const footerDraft = ref(appearance.receiptFooter);
const waTemplateDraft = ref(appearance.waTemplate);

watch(
  () => appearance.receiptFooter,
  (v) => {
    footerDraft.value = v;
  }
);
watch(
  () => appearance.waTemplate,
  (v) => {
    waTemplateDraft.value = v;
  }
);

const modeOptions = computed(() =>
  receiptModeOptions(appearance.printerEnabled)
);

const activeMode = computed(() =>
  effectiveReceiptSetting(appearance.receiptMode, appearance.printerEnabled)
);

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

const sampleWaPreview = computed(() =>
  formatWhatsAppMessage(waTemplateDraft.value || appearance.waTemplate, {
    customerName: sampleReceipt.value.customerName,
    reference: sampleReceipt.value.reference,
    shopName: appearance.shopName,
    totalMinor: sampleReceipt.value.totalMinor,
    warrantyDate: warrantyLabelForReceipt(sampleReceipt.value),
  })
);

async function pickReceiptMode(next: ReceiptModeChoice): Promise<void> {
  if (next === appearance.receiptMode) return;
  try {
    await setAppearance({ receiptMode: next });
    toast('اتحفظ اختيار الإيصال بعد الدفع', 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function togglePrinter(enabled: boolean): Promise<void> {
  const nextPrinter = enabled ? 'on' : 'off';
  const patch: {
    printerEnabled: 'on' | 'off';
    receiptMode?: ReceiptModeChoice;
  } = { printerEnabled: nextPrinter };
  if (
    !enabled &&
    (appearance.receiptMode === 'print' || appearance.receiptMode === 'both')
  ) {
    patch.receiptMode = 'wa';
  }
  try {
    await setAppearance(patch);
    toast(
      enabled
        ? 'الطباعة رجعت في شاشة الدفع'
        : 'الإيصال هيتبعت واتساب بس',
      'info'
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function pickPaper(paper: ReceiptPaperChoice): Promise<void> {
  if (paper === appearance.receiptPaper) return;
  try {
    await setAppearance({ receiptPaper: paper });
    toast(`اتظبط مقاس الورق على ${num(Number(paper))} مم`, 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function saveFooter(): Promise<void> {
  const val = footerDraft.value.trim();
  if (val === appearance.receiptFooter) return;
  try {
    await setAppearance({ receiptFooter: val });
    toast('اتحفظ ذيل الإيصال', 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function saveWaTemplate(): Promise<void> {
  const val = waTemplateDraft.value.trim();
  if (val === '') {
    toast('قالب رسالة الواتساب ماينفعش يبقى فاضي', 'err');
    waTemplateDraft.value = appearance.waTemplate;
    return;
  }
  if (val === appearance.waTemplate) return;
  try {
    await setAppearance({ waTemplate: val });
    toast('اتحفظت رسالة الواتساب', 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}
</script>

<template>
  <section class="card" data-card="receipt-settings">
    <h3>الإيصال والواتساب</h3>
    <div class="preview-pair">
      <div class="stack">
        <div class="s-row">
          <div class="t">
            <b>بعد الدفع</b>
            <small>
              {{
                appearance.printerEnabled === 'on'
                  ? 'الاختيار اللي بيبقى متعلّم في شاشة الدفع'
                  : 'مفيش طابعة: الإيصال بيتبعت واتساب (صورة + رسالة). من غير عميل بتبقى «بدون» وتقدر تختار واتساب وتكتب الرقم'
              }}
            </small>
          </div>
          <div class="seg" role="group" aria-label="بعد الدفع">
            <button
              v-for="[id, label] in modeOptions"
              :key="id"
              :id="`set-receiptMode-${id}`"
              type="button"
              :class="{ on: activeMode === id }"
              @click="pickReceiptMode(id)"
            >
              {{ label }}
            </button>
          </div>
        </div>

        <div class="field">
          <label for="set-receiptFooter">الجملة اللي في آخر الإيصال</label>
          <textarea
            id="set-receiptFooter"
            v-model="footerDraft"
            rows="2"
            maxlength="500"
            @change="saveFooter"
          />
        </div>

        <div class="field">
          <label for="set-waTemplate">رسالة الواتساب</label>
          <textarea
            id="set-waTemplate"
            v-model="waTemplateDraft"
            rows="2"
            maxlength="1000"
            @change="saveWaTemplate"
          />
          <span class="hint">
            <code>{الاسم}</code> و<code>{رقم}</code> و<code>{المحل}</code> و<code>{الإجمالي}</code> و<code>{تاريخ_الضمان}</code> بيتبدّلوا لوحدهم
          </span>
        </div>

        <div class="note" data-wa-template-preview>
          <Icon name="message-circle" />
          <span>مثال الرسالة: «{{ sampleWaPreview }}»</span>
        </div>

        <div class="s-row">
          <div class="t">
            <b>عندي طابعة إيصالات</b>
            <small>
              لما تجيب طابعة حرارية فعّل ده، وهترجع «طباعة» و«الاتنين» في شاشة الدفع
            </small>
          </div>
          <label class="switch">
            <input
              id="set-printerEnabled"
              type="checkbox"
              :checked="appearance.printerEnabled === 'on'"
              @change="
                togglePrinter(
                  ($event.target as HTMLInputElement).checked
                )
              "
            />
            <span />
          </label>
        </div>

        <div v-if="appearance.printerEnabled === 'on'" class="s-row">
          <div class="t">
            <b>مقاس الورق</b>
            <small>بيتطبع كصورة عشان العربي يطلع مظبوط على أي طابعة حرارية</small>
          </div>
          <div class="seg" role="group" aria-label="مقاس الورق">
            <button
              id="set-receiptPaper-80"
              type="button"
              :class="{ on: appearance.receiptPaper === '80' }"
              @click="pickPaper('80')"
            >
              {{ num(80) }} مم
            </button>
            <button
              id="set-receiptPaper-58"
              type="button"
              :class="{ on: appearance.receiptPaper === '58' }"
              @click="pickPaper('58')"
            >
              {{ num(58) }} مم
            </button>
          </div>
        </div>
      </div>

      <ReceiptPreview :sale="sampleReceipt" />
    </div>
  </section>
</template>
