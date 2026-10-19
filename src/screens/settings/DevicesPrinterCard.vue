<script setup lang="ts">
// «الأجهزة والطابعة» settings tab cards (`docs/ui/mockup-v1/views/settings.js` `setDevices()`,
// `docs/PLAN.md` §15, §16, §19; `ADR-028`, `ADR-037`).

import { computed, onMounted, ref } from 'vue';
import {
  companionOverview,
  pairCompanionDevice,
  unpairCompanionDevice,
  type CompanionStatus,
} from '../../api/companion';
import { describeError } from '../../api/errors';
import {
  appearance,
  type ReceiptPaperChoice,
  setAppearance,
} from '../../ui/appearance';
import { num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import { buildPairingQrMatrix } from '../mobile/companion';
import { buildPrinterTogglePatch, formatPrinterStatusSummary } from './tabs';

const companion = ref<CompanionStatus | null>(null);
const newDeviceName = ref('');
const newDeviceModel = ref('');

const statusSummary = computed(() =>
  formatPrinterStatusSummary(appearance.printerEnabled, appearance.receiptPaper),
);

const hostAddress = computed(() => {
  const ip = companion.value?.hostIp ?? '192.168.1.10';
  const port = companion.value?.port ?? 8787;
  return `${ip}:${port}`;
});

const qrMatrix = computed(() =>
  buildPairingQrMatrix(
    companion.value?.pairPayload ??
      `MSHOP-PAIR|v1|${appearance.shopName || 'موبايل ستور'}|192.168.1.10:8787|PAIR-8787`,
    21,
  ),
);

async function loadCompanion(): Promise<void> {
  companion.value = await companionOverview().catch(() => null);
}

async function onPairNewDevice(): Promise<void> {
  const name = newDeviceName.value.trim() || 'موبايل مارينا';
  const model = newDeviceModel.value.trim() || 'Samsung Galaxy A54';
  try {
    companion.value = await pairCompanionDevice(name, model);
    newDeviceName.value = '';
    newDeviceModel.value = '';
    toast(`اتربط «${name}» على شبكة المحل بنجاح`, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function onUnpairDevice(id: string, name: string): Promise<void> {
  try {
    companion.value = await unpairCompanionDevice(id);
    toast(`اتفصل «${name}» من الكمبيوتر`, 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

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

onMounted(() => {
  void loadCompanion();
});
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

    <section class="card" data-paired-devices-card>
      <div class="card-h">
        <h3>الموبايلات المتوصلة</h3>
        <button
          type="button"
          class="btn sm"
          data-pair-device-btn
          @click="onPairNewDevice"
        >
          <Icon name="smartphone" /> ربط موبايل جديد
        </button>
      </div>

      <div
        v-for="dev in companion?.pairedDevices ?? []"
        :key="dev.id"
        class="s-row"
        data-paired-device-row
      >
        <span class="t-ico"><Icon name="smartphone" /></span>
        <div class="t">
          <b>{{ dev.name }}</b>
          <small><bdi dir="rtl">{{ dev.model }}</bdi>، على شبكة المحل</small>
        </div>
        <span class="tag ok"><span class="dot"></span> متصل</span>
        <button
          type="button"
          class="btn sm ghost danger"
          data-unpair-device
          @click="onUnpairDevice(dev.id, dev.name)"
        >
          فصل
        </button>
      </div>

      <div
        v-if="(companion?.pairedDevices ?? []).length === 0"
        class="muted"
        style="padding: 8px 0"
      >
        مفيش موبايلات مربوطة حالياً
      </div>
    </section>

    <section class="card" data-devices-companion-card>
      <h3>توصيل موبايل جديد</h3>
      <div class="qr-box">
        <div class="pair-qr" data-companion-qr>
          <svg
            viewBox="0 0 21 21"
            width="136"
            height="136"
            shape-rendering="crispEdges"
            aria-label="كود ربط الموبايل"
          >
            <rect width="21" height="21" fill="#ffffff" />
            <template v-for="(row, r) in qrMatrix" :key="r">
              <template v-for="(cell, c) in row" :key="`${r}-${c}`">
                <rect
                  v-if="cell"
                  :x="c"
                  :y="r"
                  width="1"
                  height="1"
                  fill="#141517"
                />
              </template>
            </template>
          </svg>
        </div>
        <div class="stack" style="gap: 6px">
          <b>{{ num(1) }}. افتح تطبيق المحل على الموبايل</b>
          <span>{{ num(2) }}. اتأكد إنه على نفس الـ <bdi dir="auto">Wi-Fi</bdi> بتاع المحل</span>
          <span>{{ num(3) }}. امسح كود الربط، وبعدها اختار البيّاع واكتب الـ <bdi dir="auto">PIN</bdi></span>
          <span class="muted">
            عنوان الكمبيوتر:
            <bdi dir="ltr" class="mono" data-companion-host-address>{{
              hostAddress
            }}</bdi>
          </span>
          <span class="muted">
            مفيش قاعدة بيانات على الموبايل — كل حاجة بتتقرأ وتتحفظ في الكمبيوتر ده مباشرة.
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
</style>
