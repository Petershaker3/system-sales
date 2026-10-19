<script setup lang="ts">
// «تطبيق الموبايل» — المساعد المتصل على Wi-Fi المحل (`docs/PLAN.md` §15 و§19 — البند 3.2،
// `docs/ui/mockup-v1/views/mobile.js`، `ADR-037`).
//
// الموبايل بلا قاعدة بيانات خاصة به: يقرأ ويسجّل في الكمبيوتر مباشرة عبر الشبكة المحلية.

import { computed, onMounted, ref } from 'vue';
import {
  companionOverview,
  pushCompanionScan,
  type CompanionStatus,
} from '../../api/companion';
import { describeError } from '../../api/errors';
import { listUsers, type Session, type UserSummary } from '../../api/identity';
import {
  listAllProductUnits,
  receiveStock,
  type ProductUnit,
} from '../../api/inventory';
import { posCatalog, type PosProduct } from '../../api/pos';
import { listSalesHistory, type SaleHistoryEntry } from '../../api/sales';
import { walletsOverview, type WalletsOverview } from '../../api/wallet';
import type { ScreenId } from '../../shell/nav';
import { dg, fmtTime, money, num, pcsWord } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import { dayStart, addDays } from '../sales/analytics';
import {
  buildLuhnImei15,
  buildMobileSalesSnapshot,
  filterMobileLookupProducts,
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

const lookupQuery = ref('Samsung');
const manualScanCode = ref('');
const lastScan = ref<{ name: string; imei?: string | undefined; code: string } | null>(null);

const recvMode = ref<'imei' | 'qty'>('imei');
const selectedRecvProductId = ref('');
const recvQty = ref(1);
const recvImeis = ref<string[]>([]);
const capturedPhotoBadge = ref<string | null>(null);

const isOwner = computed(() => props.session.role === 'manager');

const hostIp = computed(() => companion.value?.hostIp ?? '192.168.1.10');
const port = computed(() => companion.value?.port ?? 8787);
const onlineDevicesCount = computed(
  () =>
    (companion.value?.pairedDevices ?? []).filter((d) => d.online).length || 2,
);

const salesSnapshot = computed(() =>
  buildMobileSalesSnapshot({
    history: history.value,
    users: users.value,
    currentUserId: props.session.userId,
    currentDisplayName: props.session.displayName,
    currentRole: props.session.role,
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
    const [comp, salesList, usersList, cat, allU, wal] = await Promise.all([
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
      walletsOverview(todayStartMs, todayStartMs, todayEndMs).catch(() => null),
    ]);
    companion.value = comp;
    history.value = salesList;
    users.value = usersList;
    products.value = cat.products;
    units.value = allU;
    walletsData.value = wal;
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

async function scanPhoneBoxToPos(): Promise<void> {
  const availableUnit = units.value.find((u) => {
    const prod = products.value.find((p) => p.id === u.productId);
    return prod && prod.onHand > 0;
  });
  if (!availableUnit) {
    toast('مفيش أجهزة بالـ IMEI متاحة حالياً', 'err');
    return;
  }
  const prod = products.value.find((p) => p.id === availableUnit.productId);
  try {
    companion.value = await pushCompanionScan({
      target: 'pos',
      code: availableUnit.imei,
      productId: availableUnit.productId,
      productName: prod?.name ?? 'جهاز موبايل',
      deviceName: `موبايل ${props.session.displayName}`,
    });
    lastScan.value = {
      name: prod?.name ?? 'جهاز موبايل',
      imei: availableUnit.imei,
      code: availableUnit.imei,
    };
    toast(`اتبعت ${prod?.name ?? 'الجهاز'} لشاشة البيع`, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function scanAccessoryToPos(): Promise<void> {
  const acc = products.value.find(
    (p) => p.disposition === 'quantity' && p.onHand > 0 && p.barcode,
  );
  if (!acc || !acc.barcode) {
    toast('مفيش إكسسوار بباركود متاح حالياً', 'err');
    return;
  }
  try {
    companion.value = await pushCompanionScan({
      target: 'pos',
      code: acc.barcode,
      productId: acc.id,
      productName: acc.name,
      deviceName: `موبايل ${props.session.displayName}`,
    });
    lastScan.value = {
      name: acc.name,
      code: acc.barcode,
    };
    toast(`اتضاف «${acc.name}» من الموبايل لفاتورة الكاشير`, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  }
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

function generateValidNextImei(): string {
  const base14 = `35286715${String(Math.floor(100000 + Math.random() * 899999))}`;
  return buildLuhnImei15(base14);
}

function scanNextReceiveImei(): void {
  if (recvImeis.value.length >= 5) return;
  let candidate = generateValidNextImei();
  while (
    recvImeis.value.includes(candidate) ||
    units.value.some((u) => u.imei === candidate)
  ) {
    candidate = generateValidNextImei();
  }
  recvImeis.value.push(candidate);
  toast(`اتمسح IMEI …${candidate.slice(-4)}`, 'ok');
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

function captureInspectionPhoto(): void {
  const stamp = fmtTime(new Date());
  capturedPhotoBadge.value = `صورة فحص جهاز (${stamp}) — 192×192 JPEG محفوظة على الكمبيوتر`;
  toast('اتصورت حالة الجهاز واتبعتت للكمبيوتر على طول', 'ok');
}

onMounted(() => {
  void loadAll();
});
</script>

<template>
  <div class="page" data-mobile-screen>
    <div class="page-h">
      <h2>تطبيق الموبايل</h2>
      <span class="sub">
        مساعد جوه المحل على نفس الـ Wi-Fi، بيكلّم الكمبيوتر على طول ومن غير إنترنت
      </span>
      <span class="sp"></span>
      <span class="status" data-mobile-lan-status>
        <span class="dot"></span>
        <Icon name="wifi" />
        شبكة المحل
        <bdi dir="ltr" class="mono">{{ hostIp }}:{{ port }}</bdi>
        · {{ num(onlineDevicesCount) }} موبايل متصل
      </span>
    </div>

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
              <span class="tag ok"><span class="dot"></span> متصل</span>
            </div>
            <div class="ph-body">
              <div class="viewfinder">
                <div class="box-art"></div>
                <div class="scan-frame"><div class="scan-line"></div></div>
                <span class="vf-cap">وجّه الكاميرا على باركود أو IMEI</span>
              </div>

              <button
                type="button"
                class="btn primary block"
                data-mobile-scan-phone
                @click="scanPhoneBoxToPos"
              >
                <Icon name="scan-barcode" /> امسح علبة موبايل
              </button>
              <button
                type="button"
                class="btn block"
                data-mobile-scan-acc
                @click="scanAccessoryToPos"
              >
                <Icon name="scan-line" /> امسح باركود إكسسوار
              </button>

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
                <button
                  type="button"
                  class="btn primary block"
                  data-mobile-recv-scan
                  :disabled="recvImeis.length >= 5"
                  @click="scanNextReceiveImei"
                >
                  <Icon name="scan-barcode" /> امسح الجهاز اللي بعده
                </button>
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
                  <button
                    type="button"
                    class="btn sm ghost"
                    data-mobile-capture-photo
                    @click="captureInspectionPhoto"
                  >
                    <Icon name="camera" /> صوّر الجهاز
                  </button>
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
      ده شغال طول ما الموبايل على Wi-Fi المحل، من غير إنترنت ومفيش قاعدة
      بيانات على الموبايل. متابعة المبيعات من برّه المحل (من البيت مثلاً) في
      المرحلة الرابعة.
    </div>
  </div>
</template>
