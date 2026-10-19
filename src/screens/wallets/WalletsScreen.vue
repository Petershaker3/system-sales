<script setup lang="ts">
/**
 * Wallets & Services screen («المحافظ»)
 * (Plan item 1.10, `ADR-025`, `PLAN.md` §9, §19, `docs/ui/mockup-v1/views/wallets.js`).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { describeError } from '../../api/errors';
import type { Session } from '../../api/identity';
import {
  reconcileWallet,
  recordWalletMovement,
  voidWalletOp,
  walletsOverview,
  type WalletOp,
  type WalletSummary,
  type WalletVia,
} from '../../api/wallet';
import ServicesModal from '../pos/ServicesModal.vue';
import {
  BILL_TYPES,
  opWalletDeltaMinor,
  RECONCILE_REASONS,
  resolveWalletPeriodBounds,
  TELECOM_OPERATORS,
  WALLET_PERIODS,
  walletStateBadge,
  type WalletPeriodKey,
} from './wallets';
import { countWord, fmtTime, money, num, parseMoney } from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import type { IconName } from '../../ui/icons';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';

const props = defineProps<{
  session: Session;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const isOwner = computed<boolean>(() => props.session.role === 'manager');

const wallets = ref<readonly WalletSummary[]>([]);
const ops = ref<readonly WalletOp[]>([]);
const period = ref<WalletPeriodKey>('today');
const selectedWalletId = ref<string>('all');
const loading = ref(false);
const busy = ref(false);

const servicesOpen = ref(false);
const moveOpen = ref(false);
const countOpen = ref(false);
const voidTarget = ref<WalletOp | null>(null);

// --- Move modal state (`topup`, `unload`, `move`) ---
const wmKind = ref<'topup' | 'unload' | 'move'>('topup');
const wmWalId = ref<string>('vf');
const wmToId = ref<string>('et');
const wmVia = ref<WalletVia>('drawer');
const wmAmtText = ref('');
const wmNoteText = ref('');

// --- Count / reconcile modal state (`adjust`) ---
const wcWalId = ref<string>('vf');
const wcRealText = ref('');
const wcReason = ref<string>('');
const wcNoteText = ref('');

// --- Void modal state ---
const voidReasonText = ref('');

const visibleWallets = computed<readonly WalletSummary[]>(() =>
  wallets.value.filter((w) => !w.wallet.hidden)
);

const walletMap = computed<ReadonlyMap<string, WalletSummary>>(() => {
  const m = new Map<string, WalletSummary>();
  for (const w of wallets.value) {
    m.set(w.wallet.id, w);
  }
  return m;
});

const totalBalanceMinor = computed<number>(() =>
  visibleWallets.value.reduce((acc, w) => acc + w.balanceMinor, 0)
);

const alertWalletsCount = computed<number>(() =>
  visibleWallets.value.filter((w) => w.state !== 'ok').length
);

const currentPeriodLabel = computed<string>(() => {
  return WALLET_PERIODS.find((p) => p.k === period.value)?.label ?? 'النهارده';
});

const summaryTotals = computed(() => {
  let depMinor = 0;
  let witMinor = 0;
  let feesMinor = 0;
  let salesInMinor = 0;
  for (const w of visibleWallets.value) {
    depMinor += w.period.depMinor;
    witMinor += w.period.witMinor;
    feesMinor += w.period.feesMinor;
    salesInMinor += w.period.salesInMinor;
  }
  return { depMinor, witMinor, feesMinor, salesInMinor };
});

async function refresh(): Promise<void> {
  loading.value = true;
  try {
    const bounds = resolveWalletPeriodBounds(period.value);
    const wid =
      selectedWalletId.value === 'all' ? null : selectedWalletId.value;
    const overview = await walletsOverview(
      bounds.todayFromMs,
      bounds.periodFromMs,
      bounds.periodToMs,
      wid,
      100
    );
    wallets.value = overview.wallets;
    ops.value = overview.ops;
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    loading.value = false;
  }
}

watch([period, selectedWalletId], () => {
  void refresh();
});

function toggleWalletFilter(id: string): void {
  selectedWalletId.value = selectedWalletId.value === id ? 'all' : id;
}

function meterPct(w: WalletSummary): number {
  const maxMinor =
    w.wallet.maxLimitMinor > 0 ? w.wallet.maxLimitMinor : 9_000_000;
  return Math.max(
    0,
    Math.min(100, Math.round((w.balanceMinor / maxMinor) * 100))
  );
}

function openServicesModal(): void {
  servicesOpen.value = true;
}

function openMoveModal(): void {
  const first = visibleWallets.value[0]?.wallet.id ?? 'vf';
  const cur =
    selectedWalletId.value !== 'all' && walletMap.value.has(selectedWalletId.value)
      ? selectedWalletId.value
      : first;
  wmKind.value = 'topup';
  wmWalId.value = cur;
  wmToId.value =
    visibleWallets.value.find((w) => w.wallet.id !== cur)?.wallet.id ?? cur;
  wmVia.value = 'drawer';
  wmAmtText.value = '';
  wmNoteText.value = '';
  moveOpen.value = true;
}

const wmSourceWallet = computed<WalletSummary | null>(
  () => walletMap.value.get(wmWalId.value) ?? visibleWallets.value[0] ?? null
);
const wmTargetWallet = computed<WalletSummary | null>(
  () =>
    walletMap.value.get(wmToId.value) ??
    visibleWallets.value.find((w) => w.wallet.id !== wmWalId.value) ??
    null
);
const wmAmtMinor = computed<number>(() => {
  const m = parseMoney(wmAmtText.value);
  return m !== null && m > 0 ? m : 0;
});
const wmInsufficient = computed<boolean>(() => {
  const src = wmSourceWallet.value;
  if (!src || wmKind.value === 'topup' || wmAmtMinor.value <= 0) return false;
  return wmAmtMinor.value > src.balanceMinor;
});

async function submitMove(): Promise<void> {
  if (busy.value) return;
  const src = wmSourceWallet.value;
  if (!src) return;
  if (wmAmtMinor.value <= 0) {
    toast('اكتب المبلغ', 'err');
    return;
  }
  if (wmInsufficient.value) {
    toast(
      `رصيد ${src.wallet.name} (${money(src.balanceMinor)}) مش كافي`,
      'err'
    );
    return;
  }
  if (wmKind.value === 'move' && wmWalId.value === wmToId.value) {
    toast('اختار محفظة تانية تحوّل ليها', 'err');
    return;
  }

  busy.value = true;
  try {
    await recordWalletMovement(
      wmKind.value,
      src.wallet.id,
      wmKind.value === 'move' ? wmToId.value : null,
      wmKind.value === 'move' ? null : wmVia.value,
      wmAmtMinor.value,
      wmNoteText.value.trim() || null
    );
    toast('اتسجّلت الحركة على المحفظة', 'ok');
    moveOpen.value = false;
    await refresh();
    emit('changed');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

function openCountModal(): void {
  const first = visibleWallets.value[0]?.wallet.id ?? 'vf';
  const cur =
    selectedWalletId.value !== 'all' && walletMap.value.has(selectedWalletId.value)
      ? selectedWalletId.value
      : first;
  wcWalId.value = cur;
  const w = walletMap.value.get(cur);
  wcRealText.value = w ? String(Math.round(w.balanceMinor / 100)) : '0';
  wcReason.value = '';
  wcNoteText.value = '';
  countOpen.value = true;
}

watch(wcWalId, (id) => {
  const w = walletMap.value.get(id);
  if (w) {
    wcRealText.value = String(Math.round(w.balanceMinor / 100));
    wcReason.value = '';
  }
});

const wcWallet = computed<WalletSummary | null>(
  () => walletMap.value.get(wcWalId.value) ?? visibleWallets.value[0] ?? null
);
const wcRealMinor = computed<number | null>(() => parseMoney(wcRealText.value));
const wcDiffMinor = computed<number>(() => {
  const w = wcWallet.value;
  if (!w) return 0;
  const real = wcRealMinor.value ?? w.balanceMinor;
  return real - w.balanceMinor;
});

async function submitCount(): Promise<void> {
  if (busy.value) return;
  const w = wcWallet.value;
  if (!w) return;
  const realMinor = wcRealMinor.value;
  if (realMinor === null || realMinor < 0) {
    toast('اكتب الرصيد الفعلي في التطبيق بشكل صحيح', 'err');
    return;
  }
  if (wcDiffMinor.value === 0) {
    toast(`رصيد ${w.wallet.name} مظبوط، مفيش فرق`, 'ok');
    countOpen.value = false;
    return;
  }
  const reason = wcReason.value.trim();
  if (!reason) {
    toast('اختار أو اكتب سبب الفرق', 'err');
    return;
  }

  busy.value = true;
  try {
    await reconcileWallet(
      w.wallet.id,
      realMinor,
      reason,
      wcNoteText.value.trim() || null
    );
    toast(
      `اتظبط رصيد ${w.wallet.name} على ${money(realMinor)}`,
      'ok'
    );
    countOpen.value = false;
    await refresh();
    emit('changed');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

function openVoidModal(op: WalletOp): void {
  voidTarget.value = op;
  voidReasonText.value = '';
}

async function submitVoid(): Promise<void> {
  if (busy.value || !voidTarget.value) return;
  const reason = voidReasonText.value.trim();
  if (!reason) {
    toast('اكتب سبب إلغاء العملية', 'err');
    return;
  }
  busy.value = true;
  try {
    await voidWalletOp(voidTarget.value.id, reason);
    toast('اتلغت العملية واترد الرصيد', 'ok');
    voidTarget.value = null;
    await refresh();
    emit('changed');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    busy.value = false;
  }
}

function opMeta(op: WalletOp): {
  readonly label: string;
  readonly sub: string;
  readonly icon: IconName;
  readonly walletLabel: string;
  readonly walletColor: string | null;
} {
  const w = op.walletId ? walletMap.value.get(op.walletId) : undefined;
  const toW = op.toWalletId ? walletMap.value.get(op.toWalletId) : undefined;
  const wName = w?.wallet.name ?? op.walletId ?? '—';
  const toName = toW?.wallet.name ?? op.toWalletId ?? '—';

  switch (op.kind) {
    case 'deposit':
      return {
        label: 'إيداع لعميل',
        sub: 'حوّلت من المحفظة واخدت كاش',
        icon: 'arrow-down-to-line',
        walletLabel: wName,
        walletColor: w?.wallet.color ?? null,
      };
    case 'withdraw':
      return {
        label: 'سحب لعميل',
        sub: 'استقبلت على المحفظة ودفعت كاش',
        icon: 'arrow-up-from-line',
        walletLabel: wName,
        walletColor: w?.wallet.color ?? null,
      };
    case 'topup':
      return {
        label: 'شحن المحفظة',
        sub: op.via === 'drawer' ? 'كاش من الدرج' : 'من برّه الدرج',
        icon: 'plus',
        walletLabel: wName,
        walletColor: w?.wallet.color ?? null,
      };
    case 'unload':
      return {
        label: 'تفريغ المحفظة',
        sub: op.via === 'drawer' ? 'كاش للدرج' : 'لبرّه الدرج',
        icon: 'minus',
        walletLabel: wName,
        walletColor: w?.wallet.color ?? null,
      };
    case 'move':
      return {
        label: 'تحويل بين محفظتين',
        sub: `من ${wName} لـ ${toName}`,
        icon: 'arrow-left-right',
        walletLabel: `${wName} ← ${toName}`,
        walletColor: w?.wallet.color ?? null,
      };
    case 'adjust':
      return {
        label: 'جرد وتعديل رصيد',
        sub: op.amountMinor >= 0 ? 'زيادة رصيد' : 'نقص رصيد',
        icon: 'sliders-horizontal',
        walletLabel: wName,
        walletColor: w?.wallet.color ?? null,
      };
    case 'bill': {
      const bt = BILL_TYPES.find((b) => b.id === op.serviceType);
      return {
        label: `فاتورة ${bt?.name ?? op.serviceType ?? ''}`,
        sub: op.reference ? `حساب ${op.reference}` : 'دفع فاتورة',
        icon: 'receipt',
        walletLabel: 'خدمات عامة',
        walletColor: null,
      };
    }
    case 'card': {
      const opInfo = TELECOM_OPERATORS.find((o) => o.id === op.reference);
      return {
        label: op.serviceType ?? 'كارت شحن',
        sub: opInfo ? `شبكة ${opInfo.name}` : 'كارت شحن سريع',
        icon: 'smartphone',
        walletLabel: 'خدمات عامة',
        walletColor: opInfo?.color ?? null,
      };
    }
    case 'software':
      return {
        label: `سوفت وير: ${op.serviceType ?? 'خدمة'}`,
        sub: 'خدمة سوفت وير وبرمجة',
        icon: 'wrench',
        walletLabel: 'خدمات عامة',
        walletColor: null,
      };
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'F9') {
    e.preventDefault();
    servicesOpen.value = true;
  }
}

onMounted(() => {
  void refresh();
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="page" data-wallets-screen>
    <div class="page-h" style="justify-content: space-between; flex-wrap: wrap; gap: 10px">
      <div style="display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap">
        <h2>المحافظ</h2>
        <span class="sub">
          إجمالي الأرصدة:
          <b class="num" data-wallets-total-balance>{{
            money(totalBalanceMinor)
          }}</b>
          <template v-if="alertWalletsCount > 0">
            ·
            <span class="tag warn" data-wallets-alert-count>
              {{ countWord(alertWalletsCount, 'محفظة', 'محفظتين', 'محافظ') }} محتاجة
              انتباه
            </span>
          </template>
        </span>
      </div>
      <div class="row">
        <button
          type="button"
          class="btn primary"
          data-wal-open-services
          @click="openServicesModal"
        >
          <Icon name="smartphone" />
          <span>إيداع أو سحب</span>
          <kbd>F9</kbd>
        </button>
        <template v-if="isOwner">
          <button
            type="button"
            class="btn"
            data-wal-open-move
            @click="openMoveModal"
          >
            <Icon name="arrow-left-right" />
            <span>شحن أو تفريغ</span>
          </button>
          <button
            type="button"
            class="btn ghost"
            data-wal-open-count
            @click="openCountModal"
          >
            <Icon name="sliders-horizontal" />
            <span>جرد محفظة</span>
          </button>
        </template>
      </div>
    </div>

    <!-- Wallet Cards -->
    <div class="wl-cards" data-wallets-cards>
      <button
        v-for="ws in visibleWallets"
        :key="ws.wallet.id"
        type="button"
        class="wl-card"
        :class="[
          ws.state !== 'ok' ? ws.state : '',
          selectedWalletId === ws.wallet.id ? 'on' : '',
        ]"
        :data-wal-card="ws.wallet.id"
        @click="toggleWalletFilter(ws.wallet.id)"
      >
        <div class="wl-head">
          <span
            class="wl-dot"
            :style="{ background: ws.wallet.color }"
          ></span>
          <b><bdi dir="auto">{{ ws.wallet.name }}</bdi></b>
          <span
            v-if="walletStateBadge(ws.state)"
            class="tag"
            :class="walletStateBadge(ws.state)?.cls"
          >
            {{ walletStateBadge(ws.state)?.label }}
          </span>
        </div>

        <div class="wl-bal num" :data-wal-balance="ws.wallet.id">
          {{ money(ws.balanceMinor) }}
        </div>

        <div class="wl-meter">
          <i
            :style="{
              width: `${meterPct(ws)}%`,
              background: ws.wallet.color,
            }"
          ></i>
        </div>

        <div class="wl-num mono muted" dir="ltr">
          {{ ws.wallet.number || 'بدون رقم' }}
        </div>

        <!-- Several numbers of one company read as a set here too (`ADR-040`). -->
        <div
          v-if="ws.wallet.company && ws.wallet.company !== ws.wallet.name"
          class="wl-company muted"
          :data-wal-card-company="ws.wallet.id"
        >
          شركة: <bdi dir="auto">{{ ws.wallet.company }}</bdi>
        </div>

        <div class="wl-stats">
          <span>
            النهارده: <b class="num">{{ num(ws.today.opsCount) }}</b> عملية ·
            عمولة <b class="num">{{ money(ws.today.feesMinor) }}</b>
          </span>
          <span v-if="ws.wallet.dailyLimitMinor > 0">
            الحد اليومي: <b class="num">{{ money(ws.today.usedMinor) }}</b> /
            {{ money(ws.wallet.dailyLimitMinor) }}
          </span>
        </div>
      </button>
    </div>

    <!-- Period filter -->
    <div class="row between" style="flex-wrap: wrap; gap: 10px">
      <div class="chips" data-wallets-periods>
        <button
          v-for="p in WALLET_PERIODS"
          :key="p.k"
          type="button"
          class="chip"
          :class="{ on: period === p.k }"
          :data-wal-period="p.k"
          @click="period = p.k"
        >
          {{ p.label }}
        </button>
      </div>
      <div v-if="selectedWalletId !== 'all'" class="row" style="gap: 8px">
        <span class="tag info">
          بتعرض:
          <bdi dir="auto">{{
            walletMap.get(selectedWalletId)?.wallet.name ?? selectedWalletId
          }}</bdi>
        </span>
        <button
          type="button"
          class="btn sm ghost"
          data-wal-clear-filter
          @click="selectedWalletId = 'all'"
        >
          عرض كل المحافظ
        </button>
      </div>
    </div>

    <!-- Summary table per wallet -->
    <div class="card" style="padding: 0; overflow: hidden" data-wallets-summary-card>
      <div class="between" style="padding: 12px 16px">
        <b>ملخص كل محفظة ({{ currentPeriodLabel }})</b>
        <span class="muted" style="font-size: 0.82rem">
          إيداع وسحب وعمولة وفلوس بيع في نفس الجدول
        </span>
      </div>
      <div class="tbl-wrap" style="border: 0; border-top: 1px solid var(--border); border-radius: 0">
        <table class="tbl wl-summary">
          <thead>
            <tr>
              <th>المحفظة</th>
              <th>الرصيد دلوقتي</th>
              <th>إيداع (خارج من المحفظة)</th>
              <th>سحب (داخل للمحفظة)</th>
              <th>العمولة</th>
              <th>فلوس البيع</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="ws in visibleWallets"
              :key="ws.wallet.id"
              :class="{ on: selectedWalletId === ws.wallet.id }"
              :data-wal-summary-row="ws.wallet.id"
              @click="toggleWalletFilter(ws.wallet.id)"
            >
              <td>
                <div class="row" style="gap: 8px">
                  <span
                    class="wl-dot"
                    :style="{ background: ws.wallet.color }"
                  ></span>
                  <b><bdi dir="auto">{{ ws.wallet.name }}</bdi></b>
                </div>
              </td>
              <td class="num">
                <b>{{ money(ws.balanceMinor) }}</b>
              </td>
              <td class="num">
                <template v-if="ws.period.depCount > 0">
                  {{ money(ws.period.depMinor) }}
                  <small class="muted">({{ num(ws.period.depCount) }})</small>
                </template>
                <span v-else class="muted">—</span>
              </td>
              <td class="num">
                <template v-if="ws.period.witCount > 0">
                  {{ money(ws.period.witMinor) }}
                  <small class="muted">({{ num(ws.period.witCount) }})</small>
                </template>
                <span v-else class="muted">—</span>
              </td>
              <td
                class="num"
                :style="{
                  color: ws.period.feesMinor > 0 ? 'var(--ok)' : '',
                }"
              >
                <b v-if="ws.period.feesMinor > 0">
                  +{{ money(ws.period.feesMinor) }}
                </b>
                <span v-else class="muted">—</span>
              </td>
              <td class="num">
                <span v-if="ws.period.salesInMinor > 0">
                  +{{ money(ws.period.salesInMinor) }}
                </span>
                <span v-else class="muted">—</span>
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr>
              <td><b>الإجمالي</b></td>
              <td class="num"><b>{{ money(totalBalanceMinor) }}</b></td>
              <td class="num"><b>{{ money(summaryTotals.depMinor) }}</b></td>
              <td class="num"><b>{{ money(summaryTotals.witMinor) }}</b></td>
              <td class="num" style="color: var(--ok)">
                <b>+{{ money(summaryTotals.feesMinor) }}</b>
              </td>
              <td class="num">
                <b>{{
                  summaryTotals.salesInMinor > 0
                    ? `+${money(summaryTotals.salesInMinor)}`
                    : '—'
                }}</b>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    <!-- Operations log -->
    <div class="card" style="padding: 0; overflow: hidden" data-wallets-log-card>
      <div class="between" style="padding: 12px 16px">
        <b>سجل الحركات ({{ currentPeriodLabel }})</b>
        <span class="muted" style="font-size: 0.82rem">
          {{ countWord(ops.length, 'حركة', 'حركتين', 'حركات') }}
        </span>
      </div>
      <div class="tbl-wrap" style="border: 0; border-top: 1px solid var(--border); border-radius: 0">
        <table class="tbl wl-log">
          <thead>
            <tr>
              <th>الوقت</th>
              <th>العملية</th>
              <th>المحفظة</th>
              <th>حركة المحفظة</th>
              <th>العمولة</th>
              <th>حركة الدرج</th>
              <th>ملاحظة</th>
              <th v-if="isOwner"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="ops.length === 0">
              <td :colspan="isOwner ? 8 : 7">
                <div class="empty">
                  <Icon name="wallet" />
                  <p>مفيش حركات في الفترة دي</p>
                </div>
              </td>
            </tr>
            <tr
              v-for="op in ops"
              :key="op.id"
              :class="{ void: op.voidedAt !== null }"
              :data-wal-op-row="op.id"
            >
              <td class="mono muted" dir="ltr">
                {{ fmtTime(new Date(op.createdAt)) }}
              </td>
              <td>
                <div class="wl-kind">
                  <Icon :name="opMeta(op).icon" />
                  <div>
                    <b>{{ opMeta(op).label }}</b>
                    <small class="muted">{{ opMeta(op).sub }}</small>
                  </div>
                </div>
              </td>
              <td>
                <div class="row" style="gap: 6px">
                  <span
                    v-if="opMeta(op).walletColor"
                    class="wl-dot"
                    :style="{ background: opMeta(op).walletColor ?? undefined }"
                  ></span>
                  <span><bdi dir="auto">{{ opMeta(op).walletLabel }}</bdi></span>
                </div>
              </td>
              <td
                class="num"
                :style="{
                  color:
                    (opWalletDeltaMinor(
                      op,
                      selectedWalletId === 'all' ? null : selectedWalletId
                    ) ?? 0) > 0
                      ? 'var(--ok)'
                      : (opWalletDeltaMinor(
                            op,
                            selectedWalletId === 'all' ? null : selectedWalletId
                          ) ?? 0) < 0
                        ? 'var(--danger)'
                        : '',
                }"
              >
                <b
                  v-if="
                    opWalletDeltaMinor(
                      op,
                      selectedWalletId === 'all' ? null : selectedWalletId
                    ) !== null
                  "
                >
                  {{
                    (opWalletDeltaMinor(
                      op,
                      selectedWalletId === 'all' ? null : selectedWalletId
                    ) ?? 0) > 0
                      ? '+'
                      : '−'
                  }}{{
                    money(
                      Math.abs(
                        opWalletDeltaMinor(
                          op,
                          selectedWalletId === 'all' ? null : selectedWalletId
                        ) ?? 0
                      )
                    )
                  }}
                </b>
                <span v-else class="muted">—</span>
              </td>
              <td class="num">
                <span v-if="op.feeMinor > 0">+{{ money(op.feeMinor) }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td
                class="num"
                :style="{
                  color:
                    op.drawerDeltaMinor > 0
                      ? 'var(--ok)'
                      : op.drawerDeltaMinor < 0
                        ? 'var(--danger)'
                        : '',
                }"
              >
                <b v-if="op.drawerDeltaMinor !== 0">
                  {{ op.drawerDeltaMinor > 0 ? '+' : '−'
                  }}{{ money(Math.abs(op.drawerDeltaMinor)) }}
                </b>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <span
                  v-if="op.voidedAt !== null"
                  class="tag danger"
                  data-wal-op-void-tag
                >
                  اتلغت: {{ op.voidReason || 'بدون سبب' }}
                </span>
                <span v-else class="muted">{{ op.note || '—' }}</span>
              </td>
              <td v-if="isOwner" style="text-align: end">
                <button
                  v-if="op.voidedAt === null"
                  type="button"
                  class="btn icon sm ghost"
                  title="إلغاء العملية"
                  :data-wal-void-op="op.id"
                  @click="openVoidModal(op)"
                >
                  <Icon name="x" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Quick Services Modal (F9) -->
    <ServicesModal
      v-if="servicesOpen"
      :initial-wallet-id="
        selectedWalletId !== 'all' ? selectedWalletId : null
      "
      @close="servicesOpen = false"
      @recorded="
        refresh();
        emit('changed');
      "
    />

    <!-- Owner Move Modal (`topup` / `unload` / `move`) -->
    <Modal
      v-if="moveOpen"
      title="شحن أو تفريغ محفظة"
      sub="تغذية المحفظة أو سحب رصيدها أو تحويل بين محفظتين"
      size="wide"
      @close="moveOpen = false"
    >
      <div data-wallet-move-modal>
        <div class="tabs" style="margin-bottom: 14px">
          <button
            type="button"
            class="tab"
            :class="{ on: wmKind === 'topup' }"
            data-wm-kind="topup"
            @click="wmKind = 'topup'"
          >
            شحن محفظة
          </button>
          <button
            type="button"
            class="tab"
            :class="{ on: wmKind === 'unload' }"
            data-wm-kind="unload"
            @click="wmKind = 'unload'"
          >
            تفريغ محفظة
          </button>
          <button
            type="button"
            class="tab"
            :class="{ on: wmKind === 'move' }"
            data-wm-kind="move"
            @click="wmKind = 'move'"
          >
            تحويل بين محفظتين
          </button>
        </div>

        <div class="field" style="margin-bottom: 12px">
          <span class="lbl">
            {{
              wmKind === 'move'
                ? 'من محفظة'
                : wmKind === 'topup'
                  ? 'المحفظة اللي هتشحنها'
                  : 'المحفظة اللي هتفرّغها'
            }}
          </span>
          <div class="wallets">
            <button
              v-for="ws in visibleWallets"
              :key="ws.wallet.id"
              type="button"
              class="wallet"
              :class="{ on: ws.wallet.id === wmWalId }"
              :data-wm-wal="ws.wallet.id"
              @click="wmWalId = ws.wallet.id"
            >
              <span
                class="wl-dot"
                :style="{ background: ws.wallet.color }"
              ></span>
              <span class="t">
                <b><bdi dir="auto">{{ ws.wallet.name }}</bdi></b>
                <small class="num">{{ money(ws.balanceMinor) }}</small>
              </span>
            </button>
          </div>
        </div>

        <div v-if="wmKind === 'move'" class="field" style="margin-bottom: 12px">
          <span class="lbl">لمحفظة</span>
          <div class="wallets">
            <button
              v-for="ws in visibleWallets.filter((x) => x.wallet.id !== wmWalId)"
              :key="ws.wallet.id"
              type="button"
              class="wallet"
              :class="{ on: ws.wallet.id === wmToId }"
              :data-wm-to="ws.wallet.id"
              @click="wmToId = ws.wallet.id"
            >
              <span
                class="wl-dot"
                :style="{ background: ws.wallet.color }"
              ></span>
              <span class="t">
                <b><bdi dir="auto">{{ ws.wallet.name }}</bdi></b>
                <small class="num">{{ money(ws.balanceMinor) }}</small>
              </span>
            </button>
          </div>
        </div>

        <div v-else class="field" style="margin-bottom: 12px">
          <span class="lbl">
            {{ wmKind === 'topup' ? 'الفلوس جاية منين؟' : 'الفلوس رايحة فين؟' }}
          </span>
          <div class="g2">
            <button
              type="button"
              class="btn"
              :class="wmVia === 'drawer' ? 'primary' : 'ghost'"
              data-wm-via="drawer"
              @click="wmVia = 'drawer'"
            >
              <Icon name="banknote" />
              <span>
                {{
                  wmKind === 'topup'
                    ? 'كاش من الدرج (ينقص الدرج)'
                    : 'كاش للدرج (يزوّد الدرج)'
                }}
              </span>
            </button>
            <button
              type="button"
              class="btn"
              :class="wmVia === 'out' ? 'primary' : 'ghost'"
              data-wm-via="out"
              @click="wmVia = 'out'"
            >
              <Icon name="landmark" />
              <span>برّه الدرج (ميتأثرش الدرج)</span>
            </button>
          </div>
        </div>

        <div class="g2">
          <div class="field">
            <label class="lbl" for="wm-amt">المبلغ (ج.م)</label>
            <input
              id="wm-amt"
              v-model="wmAmtText"
              class="in lg"
              :class="{ mono: wmAmtText !== '' }"
              :dir="wmAmtText ? 'ltr' : 'rtl'"
              inputmode="decimal"
              placeholder="5000"
              data-wm-amt
            />
          </div>
          <div class="field">
            <label class="lbl" for="wm-note">ملاحظة (اختياري)</label>
            <input
              id="wm-note"
              v-model="wmNoteText"
              class="in"
              placeholder="مندوب فوري / تحويل بنك..."
              data-wm-note
            />
          </div>
        </div>

        <div
          v-if="wmSourceWallet"
          class="due-box"
          style="margin-top: 12px; justify-content: space-between"
        >
          <div>
            <small>رصيد <bdi dir="auto">{{ wmSourceWallet.wallet.name }}</bdi> بعدها</small>
            <b
              class="num"
              :style="{
                fontSize: '1.25rem',
                color: wmInsufficient ? 'var(--danger)' : '',
              }"
            >
              {{
                money(
                  wmKind === 'topup'
                    ? wmSourceWallet.balanceMinor + wmAmtMinor
                    : wmSourceWallet.balanceMinor - wmAmtMinor
                )
              }}
            </b>
          </div>
          <div v-if="wmKind === 'move' && wmTargetWallet" style="text-align: end">
            <small>رصيد <bdi dir="auto">{{ wmTargetWallet.wallet.name }}</bdi> بعدها</small>
            <b class="num" style="font-size: 1.25rem">
              {{ money(wmTargetWallet.balanceMinor + wmAmtMinor) }}
            </b>
          </div>
          <div v-else style="text-align: end">
            <small>تأثير الدرج</small>
            <b class="num" style="font-size: 1.25rem">
              {{
                wmVia === 'out'
                  ? 'مفيش'
                  : wmKind === 'topup'
                    ? `−${money(wmAmtMinor)}`
                    : `+${money(wmAmtMinor)}`
              }}
            </b>
          </div>
        </div>
      </div>

      <template #foot>
        <button type="button" class="btn ghost" @click="moveOpen = false">
          إلغاء
        </button>
        <button
          type="button"
          class="btn primary lg"
          :disabled="busy || wmInsufficient"
          data-wm-submit
          @click="submitMove"
        >
          <Icon name="check" />
          <span>سجّل الحركة</span>
        </button>
      </template>
    </Modal>

    <!-- Owner Reconcile / Count Modal (`adjust`) -->
    <Modal
      v-if="countOpen"
      title="جرد محفظة"
      sub="طابق الرصيد المسجّل في السيستم بالرصيد الفعلي في تطبيق المحفظة"
      @close="countOpen = false"
    >
      <div v-if="wcWallet" data-wallet-count-modal>
        <div class="field" style="margin-bottom: 12px">
          <span class="lbl">اختار المحفظة</span>
          <div class="wallets">
            <button
              v-for="ws in visibleWallets"
              :key="ws.wallet.id"
              type="button"
              class="wallet"
              :class="{ on: ws.wallet.id === wcWalId }"
              :data-wc-wal="ws.wallet.id"
              @click="wcWalId = ws.wallet.id"
            >
              <span
                class="wl-dot"
                :style="{ background: ws.wallet.color }"
              ></span>
              <span class="t">
                <b><bdi dir="auto">{{ ws.wallet.name }}</bdi></b>
                <small class="num">{{ money(ws.balanceMinor) }}</small>
              </span>
            </button>
          </div>
        </div>

        <div class="g2">
          <div class="field">
            <span class="lbl">المسجّل في السيستم</span>
            <div
              class="in lg num"
              style="
                display: flex;
                align-items: center;
                background: var(--surface-2);
                font-weight: 700;
              "
              data-wc-expected
            >
              {{ money(wcWallet.balanceMinor) }}
            </div>
          </div>
          <div class="field">
            <label class="lbl" for="wc-real">الفعلي في التطبيق (ج.م)</label>
            <input
              id="wc-real"
              v-model="wcRealText"
              class="in lg"
              :class="{ mono: wcRealText !== '' }"
              :dir="wcRealText ? 'ltr' : 'rtl'"
              inputmode="decimal"
              data-wc-real
            />
          </div>
        </div>

        <div class="due-box" style="margin-top: 12px">
          <small>الفرق</small>
          <b
            class="num"
            :style="{
              color:
                wcDiffMinor === 0
                  ? 'var(--ok)'
                  : wcDiffMinor < 0
                    ? 'var(--danger)'
                    : 'var(--warn)',
            }"
            data-wc-diff
          >
            {{
              wcDiffMinor === 0
                ? 'مظبوط'
                : wcDiffMinor < 0
                  ? `عجز ${money(Math.abs(wcDiffMinor))}`
                  : `زيادة +${money(wcDiffMinor)}`
            }}
          </b>
        </div>

        <template v-if="wcDiffMinor !== 0">
          <div class="field" style="margin-top: 12px">
            <span class="lbl">سبب الفرق</span>
            <div class="chips">
              <button
                v-for="r in RECONCILE_REASONS"
                :key="r"
                type="button"
                class="chip"
                :class="{ on: wcReason === r }"
                :data-wc-reason="r"
                @click="wcReason = r"
              >
                {{ r }}
              </button>
            </div>
          </div>
          <div class="field" style="margin-top: 10px">
            <label class="lbl" for="wc-note">تفاصيل (اختياري)</label>
            <input
              id="wc-note"
              v-model="wcNoteText"
              class="in"
              placeholder="اكتب ملاحظة لو حابب"
              data-wc-note
            />
          </div>
        </template>
      </div>

      <template #foot>
        <button type="button" class="btn ghost" @click="countOpen = false">
          إلغاء
        </button>
        <button
          type="button"
          class="btn primary lg"
          :disabled="busy"
          data-wc-submit
          @click="submitCount"
        >
          <Icon name="check" />
          <span>{{ wcDiffMinor === 0 ? 'تمام، مظبوط' : 'ظبّط الرصيد' }}</span>
        </button>
      </template>
    </Modal>

    <!-- Owner Void Modal -->
    <Modal
      v-if="voidTarget"
      title="إلغاء عملية محفظة"
      :sub="`${opMeta(voidTarget).label} — المبلغ ${money(Math.abs(voidTarget.amountMinor))}`"
      size="sm"
      @close="voidTarget = null"
    >
      <div data-wallet-void-modal>
        <div class="note warn" style="margin-bottom: 12px">
          <Icon name="triangle-alert" />
          <span>
            العملية هتفضل باينة في السجل وعليها خط، والرصيد والدرج هيتردوا.
          </span>
        </div>
        <div class="field">
          <label class="lbl" for="void-reason">سبب الإلغاء</label>
          <input
            id="void-reason"
            v-model="voidReasonText"
            class="in"
            placeholder="اتكتبت بالغلط / العميل رجع في كلامه..."
            data-void-reason
          />
        </div>
      </div>

      <template #foot>
        <button type="button" class="btn ghost" @click="voidTarget = null">
          رجوع
        </button>
        <button
          type="button"
          class="btn danger"
          :disabled="busy"
          data-void-submit
          @click="submitVoid"
        >
          <Icon name="x" />
          <span>إلغاء العملية</span>
        </button>
      </template>
    </Modal>
  </div>
</template>
