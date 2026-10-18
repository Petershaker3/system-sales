<script setup lang="ts">
// «الأجهزة والطابعة» settings tab cards (`docs/ui/mockup-v1/views/settings.js` `setDevices()`,
// `docs/PLAN.md` §15, §16, §19; `ADR-028`).

import { computed } from 'vue';
import { describeError } from '../../api/errors';
import {
  appearance,
  type ReceiptPaperChoice,
  setAppearance,
} from '../../ui/appearance';
import { num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import { buildPrinterTogglePatch, formatPrinterStatusSummary } from './tabs';

const statusSummary = computed(() =>
  formatPrinterStatusSummary(appearance.printerEnabled, appearance.receiptPaper),
);

async function onTogglePrinter(): Promise<void> {
  const nextEnabled = appearance.printerEnabled !== 'on';
  const patch = buildPrinterTogglePatch(nextEnabled, appearance.receiptMode);
  try {
    await setAppearance(patch);
    toast(
      nextEnabled
        ? 'الطباعة رجعت في شاشة الدفع'
        : 'الإيصال هيتبعت واتساب بس',
      'info',
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function onPickPaper(paper: ReceiptPaperChoice): Promise<void> {
  if (paper === appearance.receiptPaper) return;
  try {
    await setAppearance({ receiptPaper: paper });
    toast(`اتظبط مقاس الورق على ${num(Number(paper))} مم`, 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

function onTestPrint(): void {
  toast('بيطبع صفحة تجربة على XP-80', 'info');
}
</script>

<template>
  <div class="devices-printer-stack" data-devices-printer-section>
    <section class="card" data-devices-printer-card>
      <h3>الطابعة</h3>

      <div v-if="statusSummary.ready" class="s-row" data-printer-status="ready">
        <span class="t-ico"><Icon name="printer" /></span>
        <div class="t">
          <b><bdi dir="auto">{{ statusSummary.title }}</bdi></b>
          <small>طابعة حرارية {{ num(Number(appearance.receiptPaper)) }} مم، والطباعة كصورة</small>
        </div>
        <span class="tag ok" data-printer-ready-tag>{{ statusSummary.badge }}</span>
        <button
          type="button"
          class="btn sm"
          data-printer-test-btn
          @click="onTestPrint"
        >
          <Icon name="printer" />
          <span>صفحة تجربة</span>
        </button>
      </div>

      <div v-else class="s-row" data-printer-status="wa-only">
        <span class="t-ico"><Icon name="message-circle" /></span>
        <div class="t">
          <b>{{ statusSummary.title }}</b>
          <small>{{ statusSummary.subtitle }}</small>
        </div>
        <span class="tag" data-printer-wa-only-tag>{{ statusSummary.badge }}</span>
      </div>

      <div class="s-row">
        <div class="t">
          <b>عندي طابعة إيصالات</b>
          <small>لما تجيب طابعة حرارية فعّل ده، وهترجع «طباعة» و«الاتنين» في شاشة الدفع</small>
        </div>
        <label
          class="switch"
          aria-label="عندي طابعة إيصالات"
          data-devices-printer-toggle
        >
          <input
            type="checkbox"
            :checked="appearance.printerEnabled === 'on'"
            @change="onTogglePrinter"
          />
          <span />
        </label>
      </div>

      <div v-if="appearance.printerEnabled === 'on'" class="s-row" data-devices-paper-row>
        <div class="t">
          <b>مقاس الورق</b>
          <small>بيتطبع كصورة عشان العربي يطلع مظبوط على أي طابعة حرارية</small>
        </div>
        <div class="seg" role="group" aria-label="مقاس الورق">
          <button
            type="button"
            data-devices-paper="80"
            :class="{ on: appearance.receiptPaper === '80' }"
            @click="onPickPaper('80')"
          >
            {{ num(80) }} مم
          </button>
          <button
            type="button"
            data-devices-paper="58"
            :class="{ on: appearance.receiptPaper === '58' }"
            @click="onPickPaper('58')"
          >
            {{ num(58) }} مم
          </button>
        </div>
      </div>
    </section>

    <section class="card" data-devices-companion-card>
      <h3>الموبايلات المتوصلة وتوصيل موبايل جديد</h3>
      <div class="qr-box">
        <div class="pair-qr companion-badge" aria-hidden="true">
          <Icon name="smartphone" />
        </div>
        <div class="stack" style="gap: 6px">
          <b>{{ num(1) }}. افتح تطبيق المحل على الموبايل</b>
          <span>{{ num(2) }}. اتأكد إنه على نفس الـ <bdi dir="auto">Wi-Fi</bdi> بتاع المحل</span>
          <span>{{ num(3) }}. امسح كود الربط، وبعدها اختار البيّاع واكتب الـ <bdi dir="auto">PIN</bdi></span>
          <span class="muted">
            مفيش قاعدة بيانات على الموبايل — كل حاجة بتتقرأ وتتحفظ في الكمبيوتر ده مباشرة (المرحلة {{ num(3) }}).
          </span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.devices-printer-stack {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.companion-badge {
  width: 72px;
  height: 72px;
  display: grid;
  place-items: center;
  background: var(--surface-2);
  color: var(--accent-text);
  flex: none;
}

.companion-badge :deep(svg.i) {
  width: 34px;
  height: 34px;
}
</style>
