<script setup lang="ts">
// «تطبيق الموبايل» — نصّ الكمبيوتر من الربط (`docs/PLAN.md` §15 و§19 — البند 3.2،
// `docs/ui/mockup-v1/views/mobile.js`، `ADR-037`, `ADR-042`).
//
// دي شاشة الكمبيوتر: هنا الباركود اللي الموبايل بيمسحه، وهنا المسودة اللي بعتّها
// الموبايل ومستنية موافقة اللي قدام الكمبيوتر. اللي تحت ده معاينة لشكل الموبايل —
// الموبايل الحقيقي بيشتغل من شاشة «الالتقاط»، ومفيش قاعدة بيانات على الموبايل.

import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  companionAcceptIntake,
  companionOverview,
  companionRejectIntake,
  companionRotatePairCode,
  pushCompanionScan,
  unpairCompanionDevice,
  type CompanionIntakeDraft,
  type CompanionStatus,
} from '../../api/companion';
import { describeError } from '../../api/errors';
import { listUsers, type Session, type UserSummary } from '../../api/identity';
import {
  listAllProductUnits,
  receiveStock,
  type ProductUnit,
} from '../../api/inventory';
import { setProductImage } from '../../api/images';
import { posCatalog, type PosProduct } from '../../api/pos';
import { repairsOverview, type RepairsOverview } from '../../api/repairs';
import { listSalesHistory, type SaleHistoryEntry } from '../../api/sales';
import { currentShiftSummary, type CurrentShiftState } from '../../api/shift';
import { walletsOverview, type WalletsOverview } from '../../api/wallet';
import type { ScreenId } from '../../shell/nav';
import { appearance } from '../../ui/appearance';
import { dg, fmtTime, money, num, pcsWord } from '../../ui/format';
import CameraScanButton from '../../ui/CameraScanButton.vue';
import Icon from '../../ui/Icon.vue';
import type { ScanReading } from '../../ui/scan';
import { toast } from '../../ui/toast';
import { dayStart, addDays } from '../sales/analytics';
import { imeiLuhn, normalizeImeiDigits } from '../pos/imei';
import { isPhone } from '../../shell/device';
import { shrinkImageFile } from '../store/image.ts';
import CompanionPairQr from './CompanionPairQr.vue';
import {
  buildMobileSalesSnapshot,
  buildRemoteOwnerSnapshot,
  deviceLinkLabel,
  filterMobileLookupProducts,
  hostLinkState,
  resolveMobileScanToPos,
} from './companion';

const props = defineProps<{
  session: Session;
}>();

const emit = defineEmits<{
  goScreen: [screen: ScreenId];
  changed: [];
}>();

const companion = ref<CompanionStatus | null>(null);
const history = ref<readonly SaleHistoryEntry[]>([]);
const users = ref<readonly UserSummary[]>([]);
const products = ref<readonly PosProduct[]>([]);
const units = ref<readonly ProductUnit[]>([]);
const walletsData = ref<WalletsOverview | null>(null);
const repairsData = ref<RepairsOverview | null>(null);
const shiftData = ref<CurrentShiftState | null>(null);
const viewMode = ref<'lan' | 'remote'>('lan');

const lookupQuery = ref('Samsung');
const manualScanCode = ref('');
const lastScan = ref<{ name: string; imei?: string | undefined; code: string } | null>(null);

const recvMode = ref<'imei' | 'qty'>('imei');
const selectedRecvProductId = ref('');
const recvQty = ref(1);
const recvImeis = ref<string[]>([]);
const recvImeiDraft = ref('');
const capturedPhotoBadge = ref<string | null>(null);

const isOwner = computed(() => props.session.role === 'manager');

const hostIp = computed(() => companion.value?.hostIp ?? '192.168.1.10');
const port = computed(() => companion.value?.port ?? 8787);
const nowMs = ref(Date.now());
let linkTicker: ReturnType<typeof setInterval> | undefined;

// The handset's own screen belongs on the handset (`ADR-042`). This file is the
// computer's half; the number of connected phones is read from the wire rather
// than printed because a panel with a green dot looks more finished.
const linkState = computed(() =>
  companion.value === null
    ? null
    : hostLinkState(
        {
          running: companion.value.running,
          port: companion.value.port,
          pairedDevices: companion.value.pairedDevices,
          rejectedPushes: companion.value.rejectedPushes,
          pendingIntakes: companion.value.pendingIntakes,
        },
        num,
      ),
);
const pendingIntakes = computed<readonly CompanionIntakeDraft[]>(
  () => companion.value?.pendingIntakes ?? [],
);
const pairedDevices = computed(() => companion.value?.pairedDevices ?? []);
/** How many handsets the wire actually hears right now — never a painted green dot. */
const onlinePhones = computed(
  () => pairedDevices.value.filter((device) => device.online).length,
);
const lastLinkLabel = computed(() => {
  const status = companion.value;
  if (status === null) return 'مفيش حالة';
  if (status.lastLinkAt === null) return 'مفيش بيانات اتنقلت بعد';
  return `آخر بيانات اتنقلت ${deviceLinkLabel(
    { online: false, lastSeenAt: status.lastLinkAt },
    nowMs.value,
    num,
  ).replace('آخر ظهور ', '')}`;
});
const phoneSide = computed(() => isPhone());

async function refreshCompanion(): Promise<void> {
  companion.value = await companionOverview().catch(() => companion.value);
  nowMs.value = Date.now();
}

async function onAcceptIntake(draft: CompanionIntakeDraft): Promise<void> {
  try {
    const applied = await companionAcceptIntake(draft.id);
    companion.value = applied.status;
    if (draft.kind === 'expense') {
      // Money is written down by the same use case the expenses screen calls, so the
      // toast names the section rather than the receiving screen (`ADR-043`).
      toast(
        `«${draft.expenseCategory}» اتسجل في المصاريف — ${money(draft.expenseAmountMinor)}`,
        'ok',
      );
      return;
    }
    toast(
      applied.draft.note === null
        ? `«${applied.draft.productName}» نزلت في الاستلام على الكمبيوتر`
        : `«${applied.draft.productName}» نزلت في الاستلام — ${applied.draft.note}`,
      'ok',
    );
    emit('changed');
    await loadAll();
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function onRejectIntake(draft: CompanionIntakeDraft): Promise<void> {
  try {
    companion.value = await companionRejectIntake(draft.id);
    toast(`«${draft.productName}» اترفضت وما اتسجّلش حاجة`, 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function onUnpairDevice(deviceId: string, name: string): Promise<void> {
  try {
    companion.value = await unpairCompanionDevice(deviceId);
    toast(`«${name}» اتفصل — لو كلّم الكمبيوتر تاني برقم الربط الحالي هيرجع`, 'info');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function onRotatePairCode(): Promise<void> {
  try {
    companion.value = await companionRotatePairCode();
    toast('كود الربط اتغيّر: كل الموبايلات محتاجة تمسح الباركود من جديد', 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

const salesSnapshot = computed(() =>
  buildMobileSalesSnapshot({
    history: history.value,
    users: users.value,
    currentUserId: props.session.userId,
    currentDisplayName: props.session.displayName,
    currentRole: props.session.role,
  }),
);

const remoteSnapshot = computed(() =>
  buildRemoteOwnerSnapshot({
    shopName: appearance.shopName || 'موبايل ستور',
    remoteCode: companion.value?.remoteCode ?? 'RMT-9042',
    remoteEnabled: Boolean(companion.value?.remoteEnabled),
    salesMinor: salesSnapshot.value.totalMinor,
    invoicesCount: salesSnapshot.value.invoicesCount,
    profitMinor: salesSnapshot.value.profitMinor ?? 0,
    hardwareRevenueMinor: repairsData.value?.hardware.totalRevenueMinor ?? 0,
    softwareRevenueMinor: repairsData.value?.software.totalRevenueMinor ?? 0,
    expectedDrawerCashMinor:
      shiftData.value?.openShift?.totals.expectedCashMinor ?? null,
    shiftNumber: shiftData.value?.openShift?.shift.shiftNumber ?? null,
  }),
);

const shownWallets = computed(() =>
  (walletsData.value?.wallets ?? []).filter((w) => !w.wallet.hidden).slice(0, 4),
);

const lookupResults = computed(() =>
  filterMobileLookupProducts({
    query: lookupQuery.value,
    products: products.value,
    units: units.value,
    isOwner: isOwner.value,
  }),
);

const serialProducts = computed(() =>
  products.value.filter(
    (p) =>
      p.disposition === 'serialized' ||
      p.tracking === 'serial_optional' ||
      p.tracking === 'serial_required',
  ),
);

const selectedRecvProduct = computed<PosProduct | null>(() => {
  const found =
    products.value.find((p) => p.id === selectedRecvProductId.value) ??
    serialProducts.value[0] ??
    products.value[0] ??
    null;
  return found;
});

const selectedRecvCostMinor = computed(() => {
  const p = selectedRecvProduct.value;
  if (!p) return 0;
  const u = units.value.find(
    (unit) => unit.productId === p.id && typeof unit.unitCostMinor === 'number',
  );
  if (u?.unitCostMinor) return u.unitCostMinor;
  return Math.max(100, Math.round((p.salePriceMinor ?? 100_00) * 0.85));
});

const pendingPosScansCount = computed(
  () =>
    (companion.value?.pendingScans ?? []).filter((s) => s.target === 'pos')
      .length,
);

async function loadAll(): Promise<void> {
  const now = new Date();
  const todayStartMs = dayStart(now).getTime();
  const todayEndMs = addDays(dayStart(now), 1).getTime() - 1;
  try {
    const [comp, salesList, usersList, cat, allU, wal, rep, sh] =
      await Promise.all([
        companionOverview().catch(() => null),
        listSalesHistory(2000).catch(() => [] as SaleHistoryEntry[]),
        listUsers().catch(() => [] as UserSummary[]),
        posCatalog().catch(() => ({
          products: [],
          categories: [],
          brands: [],
          units: [],
        })),
        listAllProductUnits().catch(() => [] as ProductUnit[]),
        walletsOverview(todayStartMs, todayStartMs, todayEndMs).catch(
          () => null,
        ),
        repairsOverview({ fromTs: todayStartMs, toTs: todayEndMs }).catch(
          () => null,
        ),
        currentShiftSummary().catch(() => null),
      ]);
    companion.value = comp;
    history.value = salesList;
    users.value = usersList;
    products.value = cat.products;
    units.value = allU;
    walletsData.value = wal;
    repairsData.value = rep;
    shiftData.value = sh;
    if (!selectedRecvProductId.value) {
      const firstPhone =
        cat.products.find((p) => p.disposition === 'serialized') ??
        cat.products[0];
      if (firstPhone) selectedRecvProductId.value = firstPhone.id;
    }
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

/** A camera reading goes through the same resolver as a typed code. */
function onManualScan(reading: ScanReading): void {
  manualScanCode.value = reading.digits === '' ? reading.raw : reading.digits;
  void submitManualScanToPos();
}

async function submitManualScanToPos(): Promise<void> {
  const res = resolveMobileScanToPos(
    manualScanCode.value,
    products.value,
    units.value,
  );
  if (!res.ok) {
    toast(res.errorMessage ?? 'كود غير صالح', 'err');
    return;
  }
  try {
    companion.value = await pushCompanionScan({
      target: 'pos',
      code: res.code,
      productId: res.productId,
      productName: res.productName,
      deviceName: `موبايل ${props.session.displayName}`,
    });
    lastScan.value = {
      name: res.productName ?? 'صنف',
      imei: res.imei ?? undefined,
      code: res.code,
    };
    manualScanCode.value = '';
    toast(`اتبعت «${res.productName}» لشاشة البيع`, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

/**
 * One IMEI into the receipt list — from the camera or typed, with the same checks the
 * stock panel applies: exactly 15 digits, a valid check digit, and never a second time.
 */
function addRecvImei(raw: string): void {
  if (recvImeis.value.length >= 5) return;
  const digits = normalizeImeiDigits(raw);
  if (digits === '') return;
  if (!/^\d{15}$/.test(digits)) {
    toast('الـ IMEI لازم يكون 15 رقم بالظبط', 'err');
    return;
  }
  if (!imeiLuhn(digits)) {
    toast('الـ IMEI ده فيه رقم غلط (فحص Luhn) — راجع العلبة', 'err');
    return;
  }
  if (
    recvImeis.value.includes(digits) ||
    units.value.some((u) => u.imei === digits || u.imei2 === digits)
  ) {
    toast('الـ IMEI ده متسجّل بالفعل', 'err');
    return;
  }
  recvImeis.value = [...recvImeis.value, digits];
  recvImeiDraft.value = '';
  toast(`اتمسح IMEI …${digits.slice(-4)}`, 'ok');
}

function onReceiveScan(reading: ScanReading): void {
  addRecvImei(reading.digits === '' ? reading.raw : reading.digits);
}

function addTypedRecvImei(): void {
  addRecvImei(recvImeiDraft.value);
}

async function saveReceiveByImei(): Promise<void> {
  const p = selectedRecvProduct.value;
  if (!p || recvImeis.value.length === 0) return;
  try {
    const count = recvImeis.value.length;
    await receiveStock(
      p.id,
      count,
      selectedRecvCostMinor.value,
      'شركة النور (من الموبايل)',
      recvImeis.value,
    );
    recvImeis.value = [];
    await loadAll();
    emit('changed');
    toast(`اتضاف ${num(count)} جهاز «${p.name}» للمخزن من الموبايل`, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function saveReceiveByQty(): Promise<void> {
  const p = selectedRecvProduct.value;
  if (!p || recvQty.value <= 0) return;
  try {
    const count = recvQty.value;
    await receiveStock(
      p.id,
      count,
      selectedRecvCostMinor.value,
      'شركة النور (من الموبايل)',
    );
    recvQty.value = 1;
    await loadAll();
    emit('changed');
    toast(
      `اتضاف ${num(count)} قطعة «${p.name}» للمخزن من الموبايل`,
      'ok',
    );
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

// The inspection photo used to be a toast: nothing was read, nothing was sent.
// It now goes where a picture of a product actually goes on this computer — the
// product's cover image — and the badge reports what really happened (`ADR-042`).
async function onInspectionPhotoPicked(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement | null;
  const files = input?.files ?? null;
  const productId = selectedRecvProductId.value;
  if (files === null || files.length === 0) return;
  if (productId === '') {
    toast('اختار الصنف الأول عشان الصورة تتحفظ عليه', 'err');
    if (input !== null) input.value = '';
    return;
  }
  try {
    const dataUrl = await shrinkImageFile(files[0] as File);
    await setProductImage(productId, dataUrl);
    capturedPhotoBadge.value = `صورة فحص جهاز (${fmtTime(
      new Date(),
    )}) — 192×192 JPEG اتحفظت كغلاف للصنف على الكمبيوتر`;
    toast('الصورة اتحفظت على الصنف', 'ok');
  } catch (err) {
    toast(typeof err === 'string' ? err : 'الصورة ما قرتش', 'err');
  } finally {
    if (input !== null) input.value = '';
  }
}

onMounted(() => {
  void loadAll();
  // The link is only true for a few seconds, so the panel asks again rather than
  // letting "متصل" mean "as of whenever this page was opened".
  linkTicker = setInterval(() => void refreshCompanion(), 4_000);
});

onUnmounted(() => {
  if (linkTicker !== undefined) clearInterval(linkTicker);
});
</script>

<template>
  <div class="page" data-mobile-screen>
    <div class="page-h">
      <h2>تطبيق الموبايل</h2>
      <span class="sub">
        {{
          viewMode === 'remote'
            ? 'متابعة المالك من برّه المحل (قراءة فقط مشفّرة للمبيعات والصيانة والسوفت وير والدرج)'
            : 'مساعد جوه المحل على نفس الـ Wi-Fi، بيكلّم الكمبيوتر على طول ومن غير إنترنت'
        }}
      </span>
      <span class="sp"></span>
      <div
        v-if="isOwner"
        class="seg"
        data-mobile-mode-switch
        role="group"
        aria-label="وضع اتصال الموبايل"
      >
        <button
          type="button"
          :class="{ on: viewMode === 'lan' }"
          data-mobile-mode="lan"
          @click="viewMode = 'lan'"
        >
          <Icon name="wifi" /> داخل المحل (Wi-Fi)
        </button>
        <button
          type="button"
          :class="{ on: viewMode === 'remote' }"
          data-mobile-mode="remote"
          @click="viewMode = 'remote'"
        >
          <Icon name="signal" /> من برّه المحل (للمالك)
        </button>
      </div>
      <span class="status" data-mobile-lan-status>
        <span class="dot"></span>
        <Icon :name="viewMode === 'remote' ? 'signal' : 'wifi'" />
        <template v-if="viewMode === 'remote'">
          مرحّل مشفّر
          <bdi dir="ltr" class="mono">{{ remoteSnapshot.remoteCode }}</bdi>
          · قراءة فقط للمالك
        </template>
        <template v-else>
          شبكة المحل
          <bdi dir="ltr" class="mono">{{ hostIp }}:{{ port }}</bdi>
          · {{ linkState?.label ?? 'بنتظر رد السيرفر' }}
        </template>
      </span>
    </div>

    <p v-if="phoneSide" class="muted" data-mobile-host-note>
      انت على موبايل: شاشة الالتقاط هي اللي بتصوّر وبتبعت، والكمبيوتر هو اللي بيعرض
      باركود الربط. اللي تحت ده شكل شاشات الموبايل للمراجعة بس.
    </p>

    <!-- The inbox is its own card, with a heading and a count, and it comes first:
         what a phone sent is the reason this screen exists. It used to be a list
         with no heading under the QR, which is exactly why «مش بقدر» was the
         owner's description of a working feature. -->
    <section v-if="!phoneSide" class="card" data-companion-inbox>
      <div class="card-h">
        <h3>اللي وصل من الموبايل</h3>
        <span
          class="tag"
          :class="pendingIntakes.length > 0 ? 'warn' : ''"
          data-companion-inbox-count
        >
          <span v-if="pendingIntakes.length > 0" class="dot"></span>
          {{
            pendingIntakes.length === 0
              ? 'مفيش حاجة مستنية'
              : `${num(pendingIntakes.length)} مستنية موافقتك`
          }}
        </span>
        <span class="sp"></span>
        <span class="muted" style="font-size: 0.82rem">صنف أو مصروف — الكمبيوتر هو اللي بيسجّل</span>
      </div>
      <p class="muted" style="margin-top: 0">
        كل حاجة الموبايل بعتها بتقف هنا لحد ما تقرر. الصنف بينزل باستلام، والمصروف بيتسجل
        في قسم المصاريف — ومفيش حاجة بتتكتب في الدفتر من غير موافقتك.
      </p>

    <div v-if="pendingIntakes.length === 0" class="muted" style="padding: 8px 0" data-companion-inbox-empty>
      مفيش مسودة واصلة من الموبايل. اللي يوصل بيستنى موافقتك هنا قبل ما ينزل في الاستلام
      أو في المصاريف.
    </div>
    <div
      v-for="draft in pendingIntakes"
      :key="draft.id"
      class="s-row"
      data-companion-intake-row
    >
      <span class="t-ico">
        <Icon :name="draft.kind === 'expense' ? 'hand-coins' : 'boxes'" />
      </span>
      <div class="t">
        <b>{{ draft.kind === 'expense' ? draft.expenseCategory : draft.productName }}</b>
        <small v-if="draft.kind === 'expense'">
          مصروف من {{ draft.deviceName }} · {{ money(draft.expenseAmountMinor) }} ·
          {{ draft.expensePaidFrom === 'drawer' ? 'من الدرج' : 'من برّه الدرج' }}
        </small>
        <small v-else>
          من {{ draft.deviceName }} · {{ num(draft.quantity) }} قطعة ·
          · {{ money(draft.unitCostMinor) }} للقطعة
          <template v-if="draft.imeis.length > 0">
            · {{ num(draft.imeis.length) }} <bdi dir="auto">IMEI</bdi>
          </template>
          <template v-if="draft.photos.length > 0">
            · {{ num(draft.photos.length) }} صورة
          </template>
        </small>
        <small v-if="draft.kind === 'expense'" class="muted">
          {{
            draft.expenseNote === ''
              ? 'من غير ملاحظة'
              : draft.expenseNote
          }}
        </small>
        <small v-else class="muted">
          {{
            draft.barcode === ''
              ? 'من غير باركود — هيتعمل صنف جديد بالاسم ده'
              : `باركود ${draft.barcode}`
          }}
        </small>
      </div>
      <button type="button" class="btn sm primary" data-companion-accept @click="onAcceptIntake(draft)">
        {{ draft.kind === 'expense' ? 'سجّلها في المصاريف' : 'نزّلها في الاستلام' }}
      </button>
      <button type="button" class="btn sm ghost" data-companion-reject @click="onRejectIntake(draft)">
        ارفض
      </button>
    </div>
  </section>

    <section v-if="!phoneSide" class="card" data-companion-host-panel>
      <div class="card-h">
        <h3>الربط: الكمبيوتر بيعرض والموبايل بيصور</h3>
        <span
          class="tag"
          :class="linkState?.tone === 'ok' ? 'ok' : linkState?.tone === 'warn' ? 'warn' : 'danger'"
          data-companion-link-tone
        >
          <span v-if="linkState?.tone === 'ok'" class="dot"></span>
          {{ linkState?.label ?? 'مفيش حالة' }}
        </span>
        <span class="sp"></span>
        <button
          v-if="isOwner"
          type="button"
          class="btn sm ghost"
          data-companion-rotate
          @click="onRotatePairCode"
        >
          <Icon name="refresh-ccw" /> كود ربط جديد
        </button>
      </div>

      <p v-if="linkState !== null && linkState.detail !== ''" class="muted" data-companion-link-detail>
        {{ linkState.detail }}
      </p>

      <div class="qr-box">
        <CompanionPairQr
          :payload="companion?.pairPayload ?? ''"
          marker="data-companion-qr"
          aria-label="باركود ربط الموبايل"
        />
        <div class="stack" style="gap: 6px">
          <b>{{ num(1) }}. افتح «الالتقاط» على الموبايل</b>
          <span>{{ num(2) }}. امسح الباركود ده، أو اكتب اللي تحته في خانة الكود</span>
          <span>
            {{ num(3) }}. الموبايل يبعت الصنف أو المصروف — وانت تقرر هنا: الصنف ينزل استلام،
            والمصروف يتسجل في قسمه
          </span>
          <span class="muted">
            عنوان الكمبيوتر:
            <bdi dir="ltr" class="mono" data-companion-host-address>{{ hostIp }}:{{ port }}</bdi>
          </span>
          <span class="muted" data-companion-payload>
            <bdi dir="ltr" class="mono">{{ companion?.pairPayload ?? '' }}</bdi>
          </span>
          <span class="muted" data-companion-last-link>{{ lastLinkLabel }}</span>
        </div>
      </div>

      <div v-for="dev in pairedDevices" :key="dev.id" class="s-row" data-companion-device-row>
        <span class="t-ico"><Icon name="smartphone" /></span>
        <div class="t">
          <b>{{ dev.name }}</b>
          <small><bdi dir="rtl">{{ dev.model }}</bdi> · {{ deviceLinkLabel(dev, nowMs, num) }}</small>
        </div>
        <span class="tag" :class="dev.online ? 'ok' : ''" data-companion-device-tag>
          <span v-if="dev.online" class="dot"></span>
          {{ dev.online ? 'متصل دلوقتي' : 'مقترن' }}
        </span>
        <button
          v-if="isOwner"
          type="button"
          class="btn sm ghost danger"
          data-companion-unpair
          @click="onUnpairDevice(dev.id, dev.name)"
        >
          فصل
        </button>
      </div>
    </section>

    <div class="phones">
      <!-- 1. مبيعات النهارده لحظة بلحظة -->
      <div class="phone-wrap" data-mobile-frame="sales">
        <div class="cap"><Icon name="chart-column" /> مبيعات النهارده</div>
        <div class="phone">
          <div class="screen">
            <div class="ph-status">
              <span>{{ fmtTime(new Date()) }}</span>
              <span><Icon name="wifi" /> <Icon name="signal" /></span>
            </div>
            <div class="ph-head">
              <b data-mobile-sales-title>{{ salesSnapshot.headerTitle }}</b>
              <span class="tag ok"><span class="dot"></span> مباشر</span>
            </div>
            <div class="ph-body">
              <div class="ph-card ph-total">
                <span class="muted" data-mobile-sales-label>{{
                  salesSnapshot.totalLabel
                }}</span>
                <b class="num big" data-mobile-sales-total>{{
                  money(salesSnapshot.totalMinor)
                }}</b>
                <div class="r">
                  <span class="muted"
                    >{{ num(salesSnapshot.invoicesCount) }} فاتورة</span
                  >
                  <span
                    v-if="
                      salesSnapshot.isOwner &&
                      salesSnapshot.vsYesterday !== null
                    "
                    :class="
                      salesSnapshot.vsYesterday >= 0 ? 'ok-t' : 'danger-t'
                    "
                  >
                    <Icon
                      :name="
                        salesSnapshot.vsYesterday >= 0
                          ? 'trending-up'
                          : 'trending-down'
                      "
                    />
                    {{ num(Math.abs(salesSnapshot.vsYesterday)) }}% عن امبارح
                    لنفس الساعة
                  </span>
                </div>
                <div
                  v-if="
                    salesSnapshot.isOwner && salesSnapshot.profitMinor !== null
                  "
                  class="r"
                  data-mobile-sales-profit
                >
                  <span class="muted">الربح (للمالك بس)</span>
                  <b class="num">{{ money(salesSnapshot.profitMinor) }}</b>
                </div>
              </div>

              <div
                v-if="salesSnapshot.isOwner && viewMode === 'remote'"
                class="ph-card"
                data-mobile-remote-summary
              >
                <span class="muted" style="font-size: 0.8rem">
                  ملخص الصيانة والدرج عن بُعد
                </span>
                <div class="r">
                  <span>فلوس الصيانة لوحدها</span>
                  <b class="num">{{ money(remoteSnapshot.hardwareRevenueMinor) }}</b>
                </div>
                <div class="r">
                  <span>فلوس السوفت وير لوحدها</span>
                  <b class="num">{{ money(remoteSnapshot.softwareRevenueMinor) }}</b>
                </div>
                <div
                  v-if="remoteSnapshot.expectedDrawerCashMinor !== null"
                  class="r"
                >
                  <span>المفروض في الدرج</span>
                  <b class="num">{{ money(remoteSnapshot.expectedDrawerCashMinor) }}</b>
                </div>
              </div>

              <div
                v-if="salesSnapshot.isOwner && salesSnapshot.sellerBars.length > 0"
                class="ph-card"
                data-mobile-seller-bars
              >
                <span class="muted" style="font-size: 0.8rem">مين باع كام</span>
                <div
                  v-for="sb in salesSnapshot.sellerBars"
                  :key="sb.userId"
                  class="seller-bar"
                >
                  <span class="nm">{{ sb.name }}</span>
                  <span class="bar-track">
                    <i
                      :style="{
                        width: `${sb.widthPct}%`,
                        background: sb.color,
                      }"
                    ></i>
                  </span>
                  <b class="num">{{ money(sb.salesMinor) }}</b>
                </div>
              </div>

              <div
                v-if="salesSnapshot.isOwner && shownWallets.length > 0"
                class="ph-card ph-wallets"
                data-mobile-wallets
              >
                <span class="muted" style="font-size: 0.8rem">أرصدة المحافظ</span>
                <div v-for="w in shownWallets" :key="w.wallet.id" class="r">
                  <span>
                    <span class="dot" :style="{ background: w.wallet.color }"></span>
                    {{ w.wallet.name }}
                  </span>
                  <b class="num">{{ money(w.balanceMinor) }}</b>
                </div>
              </div>

              <div class="ph-list">
                <div
                  v-for="r in salesSnapshot.recentInvoices"
                  :key="r.saleId"
                  class="ph-sale"
                  data-mobile-recent-sale
                >
                  <div class="r">
                    <b class="num">فاتورة {{ dg(r.no) }}</b>
                    <b class="num">{{ money(r.totalMinor) }}</b>
                  </div>
                  <div class="r muted">
                    <span
                      >{{ dg(fmtTime(new Date(r.occurredAt))) }}،
                      {{ r.seller }}</span
                    >
                    <span>{{ r.method }}</span>
                  </div>
                </div>
                <div
                  v-if="salesSnapshot.recentInvoices.length === 0"
                  class="muted"
                  style="font-size: 0.85rem; text-align: center"
                >
                  لسه مفيش مبيعات
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="cap-s">
          {{
            isOwner
              ? 'أي بيعة بتتسجّل على الكمبيوتر بتظهر هنا في نفس اللحظة. المالك يشوف كل المبيعات ومين باع كام'
              : 'البيّاع يشوف مبيعاته هو بس، وإجمالي المحل والربح للمالك'
          }}
        </div>
      </div>

      <!-- 2. ماسح للكاشير (بدون خدمات جوجل) -->
      <div class="phone-wrap" data-mobile-frame="scan">
        <div class="cap"><Icon name="scan-line" /> ماسح للكاشير</div>
        <div class="phone">
          <div class="screen">
            <div class="ph-status">
              <span>{{ fmtTime(new Date()) }}</span>
              <span><Icon name="wifi" /> <Icon name="signal" /></span>
            </div>
            <div class="ph-head">
              <b>ماسح الكاشير</b>
              <span
                class="tag"
                :class="onlinePhones > 0 ? 'ok' : ''"
                :data-online="num(onlinePhones)"
                data-mobile-scan-link
              >
                <span v-if="onlinePhones > 0" class="dot"></span>
                {{ onlinePhones > 0 ? 'متصل' : 'مش متصل' }}
              </span>
            </div>
            <div class="ph-body">
              <!-- A real camera, not a picture of one: the frame only appears when the
                   lens is open, and a machine without a decoder says so and keeps the
                   field below for typing. -->
              <CameraScanButton
                label="امسح باركود أو IMEI"
                hint="وجّه الكاميرا على الباركود أو الـ IMEI — القراية بتحصل على الجهاز ده بس."
                data-mobile-scan-camera
                @scan="onManualScan"
              />

              <div class="row" style="gap: 6px">
                <input
                  v-model="manualScanCode"
                  type="text"
                  :class="{ mono: manualScanCode !== '' }"
                  :dir="manualScanCode ? 'ltr' : 'rtl'"
                  placeholder="أو اكتب باركود / IMEI…"
                  data-mobile-scan-input
                  style="flex: 1; min-width: 0; height: 36px"
                  @keydown.enter.prevent="submitManualScanToPos"
                />
                <button
                  type="button"
                  class="btn sm"
                  data-mobile-scan-submit
                  @click="submitManualScanToPos"
                >
                  إرسال
                </button>
              </div>

              <div v-if="lastScan" class="ph-card" data-mobile-last-scan>
                <div class="r">
                  <b><bdi dir="rtl">{{ lastScan.name }}</bdi></b>
                  <span class="ok-t"><Icon name="circle-check" /></span>
                </div>
                <div
                  v-if="lastScan.imei"
                  class="muted mono"
                  dir="ltr"
                  style="font-size: 0.8rem"
                >
                  IMEI {{ lastScan.imei }}
                </div>
                <div class="muted" style="font-size: 0.8rem">
                  اتبعت لشاشة البيع ({{ num(pendingPosScansCount) }} في انتظار
                  الكاشير)
                </div>
              </div>

              <button
                v-if="pendingPosScansCount > 0"
                type="button"
                class="btn sm ghost block"
                data-mobile-go-pos
                @click="emit('goScreen', 'pos')"
              >
                <Icon name="shopping-cart" /> افتح شاشة البيع ({{
                  pcsWord(pendingPosScansCount)
                }})
              </button>
            </div>
          </div>
        </div>
        <div class="cap-s">
          الكاميرا بتقرا الـ IMEI أو الباركود بمكتبة مدمجة بدون خدمات جوجل وتبعته
          لشاشة البيع على طول
        </div>
      </div>

      <!-- 3. استعلام سعر ومخزون -->
      <div class="phone-wrap" data-mobile-frame="lookup">
        <div class="cap"><Icon name="search" /> سعر ومخزون</div>
        <div class="phone">
          <div class="screen">
            <div class="ph-status">
              <span>{{ fmtTime(new Date()) }}</span>
              <span><Icon name="wifi" /> <Icon name="signal" /></span>
            </div>
            <div class="ph-head"><b>سعر ومخزون</b></div>
            <div class="ph-body">
              <label class="inline-search">
                <Icon name="search" />
                <input
                  id="m-look"
                  v-model="lookupQuery"
                  type="text"
                  data-mobile-lookup-input
                  placeholder="اسم الصنف أو الباركود…"
                  autocomplete="off"
                />
              </label>

              <template v-if="lookupResults.length > 0">
                <div
                  v-for="item in lookupResults"
                  :key="item.productId"
                  class="ph-card"
                  data-mobile-lookup-card
                >
                  <div class="ph-prod">
                    <b><bdi dir="rtl">{{ item.name }}</bdi></b>
                  </div>
                  <div class="r">
                    <span
                      class="num"
                      style="font-size: 1.2rem; font-weight: 700"
                    >
                      {{ money(item.salePriceMinor) }}
                    </span>
                    <span
                      class="tag"
                      :class="item.onHand <= 0 ? 'danger' : 'ok'"
                    >
                      {{
                        item.onHand <= 0
                          ? 'خلصان'
                          : `متاح ${num(item.onHand)}`
                      }}
                    </span>
                  </div>
                  <div
                    v-if="item.colors.length > 0"
                    class="muted"
                    style="font-size: 0.8rem"
                  >
                    الألوان: {{ item.colors.join('، ') }}
                  </div>
                  <div
                    v-if="isOwner && item.costMinor !== null"
                    class="muted"
                    style="font-size: 0.8rem"
                    data-mobile-lookup-cost
                  >
                    التكلفة (للمالك): {{ money(item.costMinor) }}
                  </div>
                </div>
              </template>
              <div
                v-else
                class="muted"
                style="text-align: center; padding: 20px 0"
              >
                ملقيناش صنف بالاسم ده
              </div>
            </div>
          </div>
        </div>
        <div class="cap-s">
          أي بيّاع يعرف السعر والمتاح والألوان وهو واقف مع الزبون (والتكلفة للمالك
          بس)
        </div>
      </div>

      <!-- 4. استلام بضاعة وتصوير صيانة / استبدال -->
      <div class="phone-wrap" data-mobile-frame="receive">
        <div class="cap"><Icon name="package-plus" /> استلام وتصوير</div>
        <div class="phone">
          <div class="screen">
            <div class="ph-status">
              <span>{{ fmtTime(new Date()) }}</span>
              <span><Icon name="wifi" /> <Icon name="signal" /></span>
            </div>
            <div class="ph-head"><b>استلام بضاعة</b></div>
            <div class="ph-body">
              <div v-if="selectedRecvProduct" class="ph-card">
                <div class="r">
                  <span class="muted">المورد</span>
                  <b>شركة النور</b>
                </div>
                <div class="r">
                  <span class="muted">الصنف</span>
                  <select
                    v-model="selectedRecvProductId"
                    data-mobile-recv-product
                    style="max-width: 155px; height: 30px; font-size: 0.8rem"
                  >
                    <option
                      v-for="prod in products"
                      :key="prod.id"
                      :value="prod.id"
                    >
                      {{ prod.name }}
                    </option>
                  </select>
                </div>
                <div class="r">
                  <span class="muted">تكلفة الجهاز</span>
                  <b class="num" data-mobile-recv-cost>
                    {{ isOwner ? money(selectedRecvCostMinor) : '****' }}
                  </b>
                </div>
              </div>

              <div class="seg ph-seg">
                <button
                  type="button"
                  :class="{ on: recvMode === 'imei' }"
                  data-mobile-recv-mode="imei"
                  @click="recvMode = 'imei'"
                >
                  <Icon name="scan-barcode" /> بالـ IMEI
                </button>
                <button
                  type="button"
                  :class="{ on: recvMode === 'qty' }"
                  data-mobile-recv-mode="qty"
                  @click="recvMode = 'qty'"
                >
                  <Icon name="hash" /> بالعدد
                </button>
              </div>

              <template v-if="recvMode === 'imei'">
                <div class="ph-card">
                  <div class="r">
                    <b>اتمسح {{ num(recvImeis.length) }} من {{ num(5) }}</b>
                    <span class="tag accent">
                      <Icon name="scan-barcode" /> IMEI
                    </span>
                  </div>
                </div>
                <div class="ph-list">
                  <div
                    v-for="(im, idx) in recvImeis"
                    :key="im"
                    class="ph-item"
                    data-mobile-recv-imei-row
                  >
                    <span class="rank">{{ num(idx + 1) }}</span>
                    <bdi dir="ltr" class="mono">{{ im }}</bdi>
                    <span class="sp"></span>
                    <span class="ok-t"><Icon name="circle-check" /></span>
                  </div>
                  <div
                    v-if="recvImeis.length === 0"
                    class="muted"
                    style="font-size: 0.85rem"
                  >
                    لسه مفيش أجهزة اتمسحت
                  </div>
                </div>
                <div class="row" style="gap: 6px">
                  <input
                    v-model="recvImeiDraft"
                    :class="{ mono: recvImeiDraft !== '' }"
                    :dir="recvImeiDraft ? 'ltr' : 'rtl'"
                    inputmode="numeric"
                    maxlength="17"
                    autocomplete="off"
                    placeholder="15 رقم…"
                    data-mobile-recv-imei-input
                    style="flex: 1; min-width: 0; height: 36px"
                    :disabled="recvImeis.length >= 5"
                    @keydown.enter.prevent="addTypedRecvImei"
                  />
                  <CameraScanButton
                    :compact="true"
                    data-mobile-recv-camera
                    @scan="onReceiveScan"
                  />
                  <button
                    type="button"
                    class="btn sm"
                    data-mobile-recv-add
                    :disabled="recvImeis.length >= 5"
                    @click="addTypedRecvImei"
                  >
                    أضف
                  </button>
                </div>
                <button
                  type="button"
                  class="btn block"
                  data-mobile-recv-save
                  :disabled="recvImeis.length === 0"
                  @click="saveReceiveByImei"
                >
                  <Icon name="save" /> حفظ الاستلام
                </button>
              </template>

              <template v-else>
                <div class="ph-card">
                  <div class="r">
                    <b>العدد</b>
                    <div class="qty">
                      <button
                        type="button"
                        data-mobile-recv-plus
                        title="زوّد"
                        @click="recvQty = Math.min(99, recvQty + 1)"
                      >
                        <Icon name="plus" />
                      </button>
                      <span class="num" data-mobile-recv-qty>{{
                        num(recvQty)
                      }}</span>
                      <button
                        type="button"
                        data-mobile-recv-minus
                        title="قلّل"
                        @click="recvQty = Math.max(1, recvQty - 1)"
                      >
                        <Icon name="minus" />
                      </button>
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  class="btn primary block"
                  data-mobile-recv-save-qty
                  @click="saveReceiveByQty"
                >
                  <Icon name="save" /> حفظ الاستلام
                </button>
              </template>

              <!-- تصوير أجهزة الصيانة والاستبدال (Plan §15) -->
              <div class="ph-card" style="margin-top: 4px">
                <div class="r">
                  <span class="muted" style="font-size: 0.8rem">
                    تصوير صيانة / استبدال
                  </span>
                  <label class="btn sm ghost" data-mobile-capture-photo>
                    <Icon name="camera" /> صوّر الجهاز
                    <input
                      id="mshop-inspection-photo"
                      type="file"
                      accept="image/*"
                      capture="environment"
                      hidden
                      data-mobile-photo-input
                      @change="onInspectionPhotoPicked"
                    />
                  </label>
                </div>
                <div
                  v-if="capturedPhotoBadge"
                  class="ok-t"
                  style="font-size: 0.76rem"
                  data-mobile-photo-status
                >
                  {{ capturedPhotoBadge }}
                </div>
              </div>
            </div>
          </div>
        </div>
        <div class="cap-s">
          استلام بالـ IMEI أو بالعدد، وتصوير أجهزة الصيانة والاستبدال مباشرة
          للكمبيوتر
        </div>
      </div>
    </div>

    <div class="note phones-note">
      <Icon name="wifi" />
      ده شغال طول ما الموبايل على Wi-Fi المحل، من غير إنترنت ومفيش قاعدة بيانات على الموبايل. متابعة المبيعات من برّه المحل (من البيت مثلاً) في المرحلة الرابعة.
    </div>
  </div>
</template>
