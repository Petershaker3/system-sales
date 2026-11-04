<script setup lang="ts">
// «الأجهزة والطابعة» settings tab cards (`docs/ui/mockup-v1/views/settings.js` `setDevices()`,
// `docs/PLAN.md` §15, §16, §19; `ADR-028`, `ADR-037`).

import { computed, onMounted, ref } from 'vue';
import {
  companionOverview,
  pairCompanionDevice,
  setCompanionRemote,
  unpairCompanionDevice,
  type CompanionStatus,
} from '../../api/companion';
import { isPhone } from '../../shell/device';
import { describeError } from '../../api/errors';
import {
  appearance,
  type ReceiptPaperChoice,
  setAppearance,
} from '../../ui/appearance';
import { num } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import CompanionPairQr from '../mobile/CompanionPairQr.vue';
import { deviceLinkLabel } from '../mobile/companion';
import { buildPrinterTogglePatch, formatPrinterStatusSummary } from './tabs';

const companion = ref<CompanionStatus | null>(null);
const newDeviceName = ref('');
const newDeviceModel = ref('');
// Read once per load: "connected" is a statement about this moment, and a page
// left open overnight must not keep calling a handset connected (`ADR-042`).
const linkNow = ref(Date.now());
const phoneSide = computed(() => isPhone());

const statusSummary = computed(() =>
  formatPrinterStatusSummary(appearance.printerEnabled, appearance.receiptPaper),
);

const hostAddress = computed(() => {
  const ip = companion.value?.hostIp ?? '192.168.1.10';
  const port = companion.value?.port ?? 8787;
  return `${ip}:${port}`;
});

/**
 * The owner's follow-up code. It is the computer's own `remotePayload` and nothing
 * else: a code assembled here from a guessed shop name would be a code that scans
 * and then answers «مش عارف المحل ده» (`ADR-042`).
 */
const remotePayload = computed(() => companion.value?.remotePayload ?? '');

async function loadCompanion(): Promise<void> {
  companion.value = await companionOverview().catch(() => null);
  linkNow.value = Date.now();
}

async function onToggleRemoteFollowUp(): Promise<void> {
  const next = !(companion.value?.remoteEnabled ?? false);
  try {
    companion.value = await setCompanionRemote(next);
    toast(
      next
        ? 'اتفعلت متابعة المالك من برّه المحل (قراءة فقط مشفّرة)'
        : 'اتوقفت المتابعة البعيدة',
      'info',
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
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
        <span class="tag" :class="dev.online ? 'ok' : ''" data-paired-device-tag>
          <span v-if="dev.online" class="dot"></span>
          {{ deviceLinkLabel(dev, linkNow, num) }}
        </span>
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
        data-paired-devices-empty
      >
        مفيش موبايل كلّم الكمبيوتر بعد. ربط موبايل جديد من هنا بيسجّل الاسم بس —
        الموبايل بيظهر «متصل» أول ما يكلّم الكمبيوتر على الشبكة.
      </div>
    </section>

    <section class="card" data-devices-companion-card>
      <h3>توصيل موبايل جديد</h3>
      <p v-if="phoneSide" class="muted" data-devices-companion-phone-note>
        الموبايل ما بيعرضش باركود ربطش: الكمبيوتر هو اللي بيعرضه. من شاشة
        «الالتقاط» امسح باركود الكمبيوتر، أو اكتب عنوانه وكود الربط اللي تحته.
      </p>
      <div v-else class="qr-box">
        <CompanionPairQr
          :payload="companion?.pairPayload ?? ''"
          marker="data-companion-qr"
          aria-label="كود ربط الموبايل"
        />
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
          <span class="muted" data-companion-payload-line>
            أو اكتب السطر ده في الموبايل:
            <bdi dir="ltr" class="mono">{{ companion?.pairPayload ?? '' }}</bdi>
          </span>
          <span class="muted">
            مفيش قاعدة بيانات على الموبايل — كل حاجة بتتقرأ وتتحفظ في الكمبيوتر ده مباشرة.
          </span>
        </div>
      </div>
    </section>

    <section class="card" data-remote-followup-card>
      <div class="card-h">
        <h3>المتابعة من برّه المحل (للمالك)</h3>
        <span
          class="tag"
          :class="companion?.remoteEnabled ? 'ok' : ''"
          data-remote-status-tag
        >
          <span v-if="companion?.remoteEnabled" class="dot"></span>
          {{ companion?.remoteEnabled ? 'شغّالة (قراءة فقط)' : 'مقفولة' }}
        </span>
      </div>

      <div class="s-row">
        <span class="t-ico"><Icon name="signal" /></span>
        <div class="t">
          <b>مرحّل المتابعة البعيدة للمالك</b>
          <small>
            يبعت ملخص مشفّر (قراءة فقط) لمبيعات اللحظة والربح وفلوس الصيانة والسوفت وير والدرج والمحافظ عشان تتابع المحل من البيت
          </small>
        </div>
        <label
          class="switch"
          aria-label="مرحّل المتابعة البعيدة للمالك"
          data-remote-followup-toggle
        >
          <input
            type="checkbox"
            :checked="Boolean(companion?.remoteEnabled)"
            @change="onToggleRemoteFollowUp"
          />
          <span />
        </label>
      </div>

      <div v-if="companion?.remoteEnabled" class="qr-box" data-remote-qr-box>
        <CompanionPairQr
          :payload="remotePayload"
          marker="data-remote-qr"
          aria-label="كود المتابعة من برّه المحل"
          :width="140"
        />
        <div class="stack" style="gap: 4px">
          <b>كود متابعة المالك من برّه المحل: <bdi dir="ltr" class="mono">{{ companion?.remoteCode ?? 'RMT-9042' }}</bdi></b>
          <span class="muted">
            مشفّر، وللقراءة فقط للمالك — البيع والماسح والاستلام يفضلوا من داخل المحل بس.
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
