<script setup lang="ts">
// «الالتقاط من الموبايل» — the handset's own half of the link (`ADR-042`).
//
// This is the screen the shop actually uses on the phone: photograph or type the
// item, its IMEIs and what it cost, and the capture waits HERE until the computer
// takes it. The computer is the side with the ledger, the receipt, and the owner's
// PIN, so nothing on this screen ever claims a product was created. It reports that
// the computer received the draft, which is the only thing a phone can know.
//
// The phone is not asked to host anything: no listener, no pairing QR, no database
// of its own. The camera and the keyboard are its whole job.

import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  companionClearOutbox,
  companionConnectHost,
  companionOverview,
  companionProbeHost,
  companionPushCaptures,
  companionSaveCapture,
  type CompanionIntakeDraft,
  type CompanionStatus,
} from '../../api/companion';
import { describeError } from '../../api/errors';
import type { Session } from '../../api/identity';
import { posCatalog, type PosProduct } from '../../api/pos';
import { dg, money, num, parseMoney } from '../../ui/format';
import CameraScanButton from '../../ui/CameraScanButton.vue';
import Icon from '../../ui/Icon.vue';
import type { ScanReading } from '../../ui/scan';
import { toast } from '../../ui/toast';
import { shrinkImageFile } from '../store/image.ts';
import {
  formatHostAddress,
  intakeProgressLabel,
  MAX_CAPTURE_PHOTOS,
  MAX_EXPENSE_NOTE_CHARS,
  outboxSummary,
  parseImeiList,
  parsePairPayload,
  validateCaptureDraft,
  validateExpenseDraft,
} from './companion.ts';

const props = defineProps<{
  session: Session;
}>();

const companion = ref<CompanionStatus | null>(null);
const products = ref<readonly PosProduct[]>([]);
const nowMs = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;

const pastePayload = ref('');
const hostAddress = ref('');
const hostCode = ref('');
const linkBusy = ref(false);
const linkResult = ref<{ ok: boolean; detail: string } | null>(null);

const productName = ref('');
const barcode = ref('');
const serialized = ref(false);
const quantity = ref(1);
const costPounds = ref('');
const imeiText = ref('');
const photos = ref<string[]>([]);
const saving = ref(false);
const pushing = ref(false);

// Expense capture (`ADR-043`): the same queue as a product, a different destination.
const expenseCategory = ref('');
const expenseAmountText = ref('');
const expenseNote = ref('');
const expensePaidFrom = ref<'drawer' | 'outside'>('outside');
const expenseSaving = ref(false);
// Errors wait until somebody has touched the form: an empty form is not a mistake,
// it is a form. The button still stays disabled until the draft is complete.
const expenseTouched = ref(false);

const deviceName = computed(() => `موبايل ${props.session.displayName}`.trim());

/**
 * The computer this phone already sends to, as the phone itself stored it.
 *
 * Reading it from the status rather than from a field is the whole point: the
 * address is remembered across restarts, so reopening the screen does not look like
 * an unlinked phone (`ADR-043`).
 */
const storedHost = computed<string>(() => companion.value?.remoteHost ?? '');

const deviceModel = computed(() => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone';
  if (/Android/i.test(ua)) return 'Android';
  return 'موبايل';
});

const imeis = computed(() => parseImeiList(imeiText.value));
const outbox = computed(() => companion.value?.outbox ?? []);
const counts = computed(() => outboxSummary(outbox.value));
const waitingCount = computed(() => counts.value.waiting);

const linkLine = computed((): {
  tone: 'ok' | 'warn' | 'err';
  label: string;
  detail: string;
} => {
  const status = companion.value;
  if (status === null) {
    return { tone: 'err', label: 'السيستم ما ردّش', detail: 'افتح التطبيق تاني على الكمبيوتر.' };
  }
  if (linkResult.value !== null) {
    return {
      tone: linkResult.value.ok ? 'ok' : 'warn',
      label: linkResult.value.ok ? 'الكمبيوتر سامع الموبايل' : 'الكمبيوتر ما اتوصّلش',
      detail: linkResult.value.detail,
    };
  }
  if (hostAddress.value !== '' && hostCode.value !== '') {
    return {
      tone: 'warn',
      label: 'العنوان محفوظ، والتجربة لسه ما اتعملتش',
      detail: 'دوس «وصّل بالكمبيوتر» عشان تعرف هو سامعك ولا لأ.',
    };
  }
  return {
    tone: 'warn',
    label: 'امسح باركود الربط من الكمبيوتر',
    detail:
      'الباركود بيظهر على الكمبيوتر في شاشة «الموبايل» أو في الإعدادات ← الأجهزة والطابعة. اللصق هنا بيشتغل لو الكاميرا ما كانش معاها.',
  };
});

const knownProduct = computed((): PosProduct | null => {
  const code = barcode.value.trim();
  if (code === '') return null;
  return products.value.find((p) => (p.barcode ?? '').trim() === code) ?? null;
});

const costMinor = computed(() => {
  const raw = costPounds.value.replace(/[^\d.]/g, '');
  if (raw === '') return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
});

const draftError = computed(() =>
  validateCaptureDraft({
    deviceName: deviceName.value,
    productName: productName.value,
    barcode: barcode.value,
    disposition: serialized.value ? 'serialized' : 'quantity',
    quantity: quantity.value,
    unitCostMinor: costMinor.value,
    imeis: imeis.value,
    photos: photos.value,
  }),
);

const expenseMinor = computed<number>(() => parseMoney(expenseAmountText.value) ?? 0);
const expenseDraftError = computed<string | null>(() =>
  validateExpenseDraft({
    deviceName: deviceName.value,
    category: expenseCategory.value,
    amountMinor: expenseMinor.value,
    paidFrom: expensePaidFrom.value,
    note: expenseNote.value,
  }),
);
const expenseProblem = computed<string | null>(() =>
  expenseTouched.value ? expenseDraftError.value : null,
);

async function loadAll(): Promise<void> {
  companion.value = await companionOverview().catch(() => null);
  // A stored address fills the field, so «مفيش حاجة مكتوبة» never reads as
  // «مش مربوط» (`ADR-043`).
  if (hostAddress.value === '' && (companion.value?.remoteHost ?? '') !== '') {
    hostAddress.value = companion.value?.remoteHost ?? '';
  }
  const catalog = await posCatalog().catch(() => null);
  products.value = catalog?.products ?? [];
}

/// Ask the stored computer whether it is listening, without retyping anything.
async function probeStoredHost(): Promise<void> {
  const target = storedHost.value.trim();
  if (target === '') {
    toast('لسه ما اتربطتش بكمبيوتر — امسح باركود الربط الأول.', 'err');
    return;
  }
  const at = target.lastIndexOf(':');
  const host = at > 0 ? target.slice(0, at) : target;
  const port = at > 0 ? Number(target.slice(at + 1)) : 8787;
  linkBusy.value = true;
  try {
    const probe = await companionProbeHost(host, Number.isFinite(port) ? port : 8787);
    linkResult.value = { ok: probe.ok, detail: probe.detail };
    toast(probe.detail, probe.ok ? 'ok' : 'err');
  } catch (error) {
    const reason = describeError(error);
    linkResult.value = { ok: false, detail: reason };
    toast(reason, 'err');
  } finally {
    linkBusy.value = false;
  }
}

function usePastedPayload(): void {
  const parsed = parsePairPayload(pastePayload.value);
  if (parsed === null) {
    toast('الكود اللي لصقته مش باركود ربط — لازم يبدأ بـ MSHOP-PAIR', 'err');
    return;
  }
  hostAddress.value = formatHostAddress(parsed.host, parsed.port);
  hostCode.value = parsed.pairCode;
  linkResult.value = null;
  toast(`عنوان «${parsed.shopName}» اتحفظ — دوس «وصّل بالكمبيوتر»`, 'ok');
}

async function connectAndTest(): Promise<void> {
  if (hostAddress.value.trim() === '' || hostCode.value.trim() === '') {
    toast('اكتب عنوان الكمبيوتر أو امسح باركود الربط الأول', 'err');
    return;
  }
  linkBusy.value = true;
  try {
    const result = await companionConnectHost({
      host: hostAddress.value.trim(),
      pairCode: hostCode.value.trim(),
      deviceName: deviceName.value,
      deviceModel: deviceModel.value,
    });
    linkResult.value = { ok: result.ok, detail: result.detail };
    companion.value = result.status;
    toast(result.detail, result.ok ? 'ok' : 'err');
  } catch (error) {
    const reason = describeError(error);
    linkResult.value = { ok: false, detail: reason };
    toast(reason, 'err');
  } finally {
    linkBusy.value = false;
  }
}

async function pushAll(): Promise<void> {
  pushing.value = true;
  try {
    const result = await companionPushCaptures();
    companion.value = result.status;
    linkResult.value = { ok: result.ok, detail: result.detail };
    toast(result.detail, result.ok ? 'ok' : 'err');
  } catch (error) {
    toast(describeError(error), 'err');
  } finally {
    pushing.value = false;
  }
}

/** A scan is a barcode unless it is unmistakably a serial: 15 digits is an IMEI. */
function applyBarcodeScan(reading: ScanReading): void {
  if (reading.kind === 'imei') {
    addImei(reading.digits);
    return;
  }
  barcode.value = reading.raw;
  toast('الباركود اتسجّل', 'ok');
}

/** The IMEI field takes one number per line; a scan appends the next one. */
function addImei(digits: string): void {
  const clean = digits.replace(/\D+/g, '');
  if (clean === '') return;
  const existing = imeiText.value.trim();
  imeiText.value = existing === '' ? clean : `${existing}\n${clean}`;
  serialized.value = true;
  toast(`الرقم ${clean.slice(-4)}… اتسجّل كـ IMEI`, 'ok');
}

function applyImeiScan(reading: ScanReading): void {
  addImei(reading.kind === 'barcode' ? reading.raw.replace(/\D+/g, '') : reading.digits);
}

async function pickPhotos(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null;
  const files = input?.files ?? null;
  if (files === null || files.length === 0) return;
  const taken = [...photos.value];
  for (const file of Array.from(files)) {
    if (taken.length >= MAX_CAPTURE_PHOTOS) break;
    try {
      taken.push(await shrinkImageFile(file));
    } catch {
      toast('الصورة دي ما قرتش — اختار ملف تاني', 'err');
    }
  }
  photos.value = taken;
  if (input !== null) input.value = '';
}

function dropPhoto(index: number): void {
  photos.value = photos.value.filter((_, at) => at !== index);
}

function resetForm(): void {
  productName.value = '';
  barcode.value = '';
  imeiText.value = '';
  quantity.value = 1;
  costPounds.value = '';
  photos.value = [];
  serialized.value = false;
}

async function saveCapture(): Promise<void> {
  const problem = draftError.value;
  if (problem !== null) {
    toast(problem, 'err');
    return;
  }
  const draft: CompanionIntakeDraft = {
    id: '',
    kind: 'product',
    pairCode: hostCode.value.trim(),
    deviceName: deviceName.value,
    createdAt: 0,
    disposition: serialized.value ? 'serialized' : 'quantity',
    productName: productName.value.trim(),
    barcode: barcode.value.trim(),
    quantity: quantity.value,
    unitCostMinor: costMinor.value,
    imeis: imeis.value,
    photos: photos.value,
    productId: null,
    receiptId: null,
    pushedAt: null,
    pushError: null,
    note: null,
    expenseCategory: '',
    expenseAmountMinor: 0,
    expensePaidFrom: '',
    expenseNote: '',
  };
  saving.value = true;
  try {
    companion.value = await companionSaveCapture(draft);
    resetForm();
    if (storedHost.value !== '') {
      // A linked phone does not make the shopkeeper press a second button: saving
      // sends. The toast after the push reports what the computer actually answered
      // (`ADR-043`).
      await pushAll();
    } else {
      toast(
        `الصنف اتحفظ على الموبايل — اربط الكمبيوتر فوق عشان تبعته (${dg(waitingCount.value)} مستني)`,
        'ok',
      );
    }
  } catch (error) {
    toast(describeError(error), 'err');
  } finally {
    saving.value = false;
  }
}

/**
 * Save an expense on the phone (`ADR-043`).
 *
 * It goes into the same queue as a capture, which is the whole point: the owner
 * records the rent in the shop's doorway, opens the receipt screen on the computer,
 * and presses one button there. Nothing is written to the ledger from here.
 */
async function saveExpense(): Promise<void> {
  expenseTouched.value = true;
  const problem = expenseDraftError.value;
  if (problem !== null) {
    toast(problem, 'err');
    return;
  }
  const draft: CompanionIntakeDraft = {
    id: '',
    kind: 'expense',
    pairCode: hostCode.value.trim(),
    deviceName: deviceName.value,
    createdAt: 0,
    disposition: 'quantity',
    productName: '',
    barcode: '',
    quantity: 1,
    unitCostMinor: 0,
    imeis: [],
    photos: [],
    productId: null,
    receiptId: null,
    pushedAt: null,
    pushError: null,
    note: null,
    expenseCategory: expenseCategory.value.trim(),
    expenseAmountMinor: expenseMinor.value,
    expensePaidFrom: expensePaidFrom.value,
    expenseNote: expenseNote.value.trim(),
  };
  expenseSaving.value = true;
  try {
    companion.value = await companionSaveCapture(draft);
    expenseCategory.value = '';
    expenseAmountText.value = '';
    expenseNote.value = '';
    expenseTouched.value = false;
    if (storedHost.value !== '') {
      await pushAll();
    } else {
      toast(
        `المصروف اتحفظ على الموبايل — اربط الكمبيوتر فوق عشان تبعته (${dg(waitingCount.value)} مستني)`,
        'ok',
      );
    }
  } catch (error) {
    toast(describeError(error), 'err');
  } finally {
    expenseSaving.value = false;
  }
}

async function clearDelivered(): Promise<void> {
  try {
    companion.value = await companionClearOutbox();
    toast('اللي الكمبيوتر أخده اتشيل من القائمة', 'ok');
  } catch (error) {
    toast(describeError(error), 'err');
  }
}

onMounted(() => {
  void loadAll();
  ticker = setInterval(() => {
    nowMs.value = Date.now();
    void companionOverview()
      .then((status) => (companion.value = status))
      .catch(() => undefined);
  }, 4_000);
});

onUnmounted(() => {
  if (ticker !== undefined) clearInterval(ticker);
});
</script>

<template>
  <div class="page" data-phone-capture-screen>
    <div class="page-h">
      <h2>الالتقاط من الموبايل</h2>
      <span class="sub">
        صوّر الصنف واكتب الـ <bdi dir="auto">IMEI</bdi> والتكلفة هنا؛ الكمبيوتر هو اللي
        بيسجّله في الاستلام. مفيش قاعدة بيانات على الموبايل.
      </span>
      <span class="sp"></span>
      <span class="status" :data-tone="linkLine.tone" data-link-state>
        <span class="dot"></span>
        <Icon name="wifi" />
        {{ linkLine.label }}
      </span>
    </div>

    <!-- The one thing the screen is for: what is waiting, and the button that sends
         it. Placed above everything else so «مش بقدر» has no room to happen. -->
    <section v-if="waitingCount > 0" class="card send-banner" data-capture-send-banner>
      <div>
        <b>{{ dg(waitingCount) }} حاجة على الموبايل لسه ما اتبعتتش للكمبيوتر</b>
        <span class="muted">
          صنف أو مصروف — الزرار ده بيبعت كل اللي مستني، ولو ما وصلش هيقوللك السبب.
        </span>
      </div>
      <button
        type="button"
        class="btn primary"
        :disabled="pushing"
        data-capture-send-banner-push
        @click="pushAll"
      >
        <Icon name="wifi" />
        {{ pushing ? 'بيّبعت…' : 'ابعت للكمبيوتر' }}
      </button>
    </section>

    <p v-if="linkLine.detail !== ''" class="muted" data-capture-link-detail>
      {{ linkLine.detail }}
    </p>

    <section class="card" data-capture-link>
      <div class="card-h">
        <h3>الربط بالكمبيوتر</h3>
        <span class="tag" :class="linkResult?.ok === true ? 'ok' : ''" data-capture-link-tag>
          <span v-if="linkResult?.ok === true" class="dot"></span>
          {{
            linkResult === null || linkResult === undefined
              ? 'لسه ما اتجرّبش'
              : linkResult.ok
                ? 'متّصل'
                : 'مش متّصل'
          }}
        </span>
      </div>

      <div class="stack" style="gap: 8px">
        <div class="field">
          <label for="mshop-paste">امسح أو الصق باركود الربط من الكمبيوتر</label>
          <input
            id="mshop-paste"
            v-model="pastePayload"
            type="text"
            dir="ltr"
            placeholder="MSHOP-PAIR|v1|اسم المحل|192.168.1.20:8787|PAIR-8787"
            data-capture-paste
          />
        </div>
        <div>
          <button type="button" class="btn sm" data-capture-use-payload @click="usePastedPayload">
            <Icon name="qr-code" /> خد العنوان من الكود
          </button>
        </div>
        <div class="row" style="gap: 8px">
          <div class="field" style="flex: 2">
            <label for="mshop-host">عنوان الكمبيوتر</label>
            <input
              id="mshop-host"
              v-model="hostAddress"
              type="text"
              dir="ltr"
              placeholder="192.168.1.20:8787"
              data-capture-host
            />
          </div>
          <div class="field" style="flex: 1">
            <label for="mshop-code">كود الربط</label>
            <input
              id="mshop-code"
              v-model="hostCode"
              type="text"
              dir="ltr"
              placeholder="PAIR-8787"
              data-capture-code
            />
          </div>
        </div>
        <div v-if="storedHost !== ''" class="remembered" data-capture-stored-host>
          <span>
            الموبايل متظبط على الكمبيوتر
            <bdi dir="ltr" class="mono">{{ storedHost }}</bdi>
            — مش محتاج تكتبه تاني.
          </span>
          <button
            type="button"
            class="btn sm"
            :disabled="linkBusy"
            data-capture-probe
            @click="probeStoredHost"
          >
            <Icon name="wifi" /> {{ linkBusy ? 'بيجرّب…' : 'جرّب الاتصال' }}
          </button>
        </div>
        <div class="row" style="gap: 8px">
          <button
            type="button"
            class="btn primary"
            :disabled="linkBusy"
            data-capture-connect
            @click="connectAndTest"
          >
            <Icon name="wifi" /> وصّل بالكمبيوتر
          </button>
          <button
            type="button"
            class="btn ghost"
            :disabled="pushing || waitingCount === 0"
            data-capture-push
            @click="pushAll"
          >
            {{ pushing ? 'بيّبعت…' : `ابعت اللي مستني (${num(waitingCount)})` }}
          </button>
        </div>
        <span class="muted" data-capture-device>
          الموبايل بعرّف نفسه باسم <bdi dir="rtl">{{ deviceName }}</bdi>
          (<bdi dir="auto">{{ deviceModel }}</bdi>) — وده السبب الوحيد لظهوره عند الكمبيوتر.
        </span>
      </div>
    </section>

    <section class="card" data-capture-form>
      <div class="card-h">
        <h3>تسجيل صنف</h3>
        <span class="tag">
          <Icon name="camera" /> {{ num(photos.length) }} / {{ num(MAX_CAPTURE_PHOTOS) }} صورة
        </span>
      </div>

      <div class="stack" style="gap: 8px">
        <div class="field">
          <label for="mshop-name">اسم الصنف</label>
          <input
            id="mshop-name"
            v-model="productName"
            type="text"
            placeholder="آيفون 15 برو ماكس 256"
            data-capture-name
          />
        </div>

        <div class="row" style="gap: 8px">
          <div class="field" style="flex: 2">
            <label for="mshop-barcode">الباركود (اختياري)</label>
            <input
              id="mshop-barcode"
              v-model="barcode"
              type="text"
              dir="ltr"
              placeholder="6221234560011"
              data-capture-barcode
            />
          </div>
          <div class="field" style="flex: 1; justify-content: flex-end">
            <span class="label">امسح</span>
            <CameraScanButton
              :compact="true"
              label="امسح الباركود"
              data-capture-scan
              @scan="applyBarcodeScan"
            />
          </div>
        </div>

        <p v-if="knownProduct !== null" class="muted" data-capture-known>
          الكمبيوتر عنده صنف بنفس الباركود: «{{ knownProduct.name }}» — لو دي نفس القطعة،
          البعته هتنزل استلام عليها بدل ما يتعمل صنف جديد.
        </p>

        <div class="row" style="gap: 8px">
          <div class="field" style="flex: 1">
            <label for="mshop-qty">الكمية</label>
            <input id="mshop-qty" v-model.number="quantity" type="number" min="1" data-capture-qty />
          </div>
          <div class="field" style="flex: 1">
            <label for="mshop-cost">التكلفة (جنيه)</label>
            <input
              id="mshop-cost"
              v-model="costPounds"
              type="text"
              inputmode="decimal"
              dir="ltr"
              data-capture-cost
            />
          </div>
          <div class="field" style="flex: 1">
            <span class="label">نوع المتابعة</span>
            <button
              type="button"
              class="chip"
              :class="{ on: serialized }"
              data-capture-serialized
              @click="serialized = !serialized"
            >
              <Icon name="fingerprint" /> صنف بـ <bdi dir="auto">IMEI</bdi>
            </button>
          </div>
        </div>

        <div v-if="serialized" class="field">
          <label for="mshop-imeis">أرقام الـ <bdi dir="auto">IMEI</bdi> — سطر لكل قطعة</label>
          <textarea id="mshop-imeis" v-model="imeiText" rows="3" dir="ltr" data-capture-imeis></textarea>
          <CameraScanButton
            label="امسح الـ IMEI"
            hint="أول ١٥ رقم اللي قدامك على علبة الموبايل."
            data-capture-scan-imei
            @scan="applyImeiScan"
          />
          <small class="hint">{{ num(imeis.length) }} رقم ظاهر من اللي كتبته</small>
        </div>

        <div class="field">
          <span class="label">صور الصنف</span>
          <input
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            data-capture-photos
            @change="pickPhotos"
          />
          <small class="hint">بتتصغّر لصورة رمادية ١٩٢ قبل ما تتبعت.</small>
        </div>

        <div v-if="photos.length > 0" class="row" style="gap: 6px; flex-wrap: wrap">
          <button
            v-for="(photo, index) in photos"
            :key="index"
            type="button"
            class="chip photo"
            data-capture-photo
            @click="dropPhoto(index)"
          >
            <img :src="photo" alt="صورة الصنف" />
            <span class="cnt">شيل</span>
          </button>
        </div>

        <p v-if="draftError !== null" class="warn" data-capture-error>{{ draftError }}</p>

        <div class="row" style="gap: 8px">
          <button
            type="button"
            class="btn primary"
            :disabled="draftError !== null || saving"
            data-capture-save
            @click="saveCapture"
          >
            احفظ على الموبايل
          </button>
          <button type="button" class="btn ghost" :disabled="saving" data-capture-reset @click="resetForm">
            نظّف الخانات
          </button>
        </div>
      </div>
    </section>

    <section class="card" data-capture-expense>
      <div class="card-h">
        <h3>تسجيل مصروف</h3>
        <span class="tag"><Icon name="hand-coins" /> بيتبعت زي الصنف بالظبط</span>
      </div>

      <div class="stack" style="gap: 8px">
        <div class="row" style="gap: 8px">
          <div class="field" style="flex: 2">
            <label for="mshop-exp-cat">البند</label>
            <input
              id="mshop-exp-cat"
              v-model="expenseCategory"
              type="text"
              maxlength="80"
              placeholder="إيجار، كهربا، مرتب، صيانة…"
              data-capture-expense-category
              @input="expenseTouched = true"
            />
          </div>
          <div class="field" style="flex: 1">
            <label for="mshop-exp-amount">المبلغ (جنيه)</label>
            <input
              id="mshop-exp-amount"
              v-model="expenseAmountText"
              type="text"
              inputmode="decimal"
              dir="ltr"
              data-capture-expense-amount
              @input="expenseTouched = true"
            />
          </div>
        </div>

        <div class="field">
          <label for="mshop-exp-note">ملاحظة (اختياري)</label>
          <input
            id="mshop-exp-note"
            v-model="expenseNote"
            type="text"
            :maxlength="MAX_EXPENSE_NOTE_CHARS"
            placeholder="إيجار شهر أكتوبر — دفعت لمحمد"
            data-capture-expense-note
            @input="expenseTouched = true"
          />
        </div>

        <div class="field">
          <span class="label">الفلوس جاية منين؟</span>
          <div class="row" style="gap: 6px">
            <button
              type="button"
              class="chip"
              :class="{ on: expensePaidFrom === 'outside' }"
              data-capture-expense-from="outside"
              @click="expensePaidFrom = 'outside'"
            >
              من برّه الدرج
            </button>
            <button
              type="button"
              class="chip"
              :class="{ on: expensePaidFrom === 'drawer' }"
              data-capture-expense-from="drawer"
              @click="expensePaidFrom = 'drawer'"
            >
              من الدرج
            </button>
          </div>
          <small class="hint">
            «من الدرج» بيتسجّل بس لو فيه وردية مفتوحة على الكمبيوتر. لو الدرج مقفول، اختار
            «من برّه الدرج» — غير كده الكمبيوتر هيرفض المسودة ويقول السبب.
          </small>
        </div>

        <p v-if="expenseProblem !== null" class="warn" data-capture-expense-error>
          {{ expenseProblem }}
        </p>

        <div class="row" style="gap: 8px">
          <button
            type="button"
            class="btn primary"
            :disabled="expenseDraftError !== null || expenseSaving"
            data-capture-expense-save
            @click="saveExpense"
          >
            احفظ المصروف على الموبايل
          </button>
        </div>
        <span class="muted">
          بيتحفظ هنا مع باقي اللي مستني — وبيتبعت للكمبيوتر بنفس زر «ابعت للكمبيوتر» تحت.
        </span>
      </div>
    </section>

    <section class="card" data-capture-outbox>
      <div class="card-h">
        <h3>اللي على الموبايل</h3>
        <span class="muted">
          {{ num(counts.waiting) }} مستنية · {{ num(counts.delivered) }} وصلت ·
          {{ num(counts.failed) }} مرفوضة
        </span>
        <span class="sp"></span>
        <button
          type="button"
          class="btn sm primary"
          :disabled="pushing || waitingCount === 0"
          data-outbox-push
          @click="pushAll"
        >
          <Icon name="wifi" />
          {{ pushing ? 'بيّبعت…' : `ابعت للكمبيوتر (${num(waitingCount)})` }}
        </button>
        <button
          v-if="counts.delivered > 0"
          type="button"
          class="btn sm ghost"
          data-capture-clear
          @click="clearDelivered"
        >
          شيل اللي اتسلّم
        </button>
      </div>

      <div v-if="outbox.length === 0" class="muted" style="padding: 8px 0" data-outbox-empty>
        مفيش صنف مستني البعته.
      </div>
      <div v-for="draft in outbox" :key="draft.id" class="s-row" data-outbox-row>
        <span class="t-ico">
          <Icon :name="draft.kind === 'expense' ? 'hand-coins' : 'boxes'" />
        </span>
        <div class="t">
          <b>{{ draft.kind === 'expense' ? draft.expenseCategory : draft.productName }}</b>
          <small v-if="draft.kind === 'expense'">
            مصروف · {{ money(draft.expenseAmountMinor) }} ·
            {{ draft.expensePaidFrom === 'drawer' ? 'من الدرج' : 'من برّه الدرج' }}
            <template v-if="draft.expenseNote !== ''"> · {{ draft.expenseNote }}</template>
          </small>
          <small v-else>
            {{ num(draft.quantity) }} قطعة
            <template v-if="draft.imeis.length > 0">
              · {{ num(draft.imeis.length) }} <bdi dir="auto">IMEI</bdi>
            </template>
            <template v-if="draft.photos.length > 0">
              · {{ num(draft.photos.length) }} صورة
            </template>
          </small>
          <small :class="draft.pushError ? 'warn' : 'muted'" data-outbox-state>
            {{ intakeProgressLabel(draft, nowMs, num) }}
          </small>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.send-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  border-color: var(--accent-fill);
}

.remembered {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--surface-2);
  font-size: 0.85rem;
}

.warn {
  color: #8a3b12;
  font-size: 0.82rem;
  font-weight: 600;
}

.chip.photo {
  flex-direction: column;
  gap: 2px;
  padding: 4px;
}

.chip.photo img {
  width: 64px;
  height: 64px;
  object-fit: cover;
  border-radius: 8px;
}

.status[data-tone='ok'] .dot {
  background: #0f766e;
}

.status[data-tone='warn'] .dot {
  background: #b45309;
}

.status[data-tone='err'] .dot {
  background: #be123c;
}
</style>
