<script setup lang="ts">
// شاشة «المبيعات» (`docs/ui/mockup-v1/views/sales.js`, `docs/ui/mockup-v1/analytics.js`,
// `docs/ui/SALES-SHORTAGES.md`, `docs/PLAN.md` §14, `ADR-029`).
//
// - Owner (`role === 'manager'`) sees all shop sales, seller filter, and cost/profit.
// - Seller (`role === 'sales'`) sees only their own sales (`مبيعاتك انت بس`), without cost or profit.
// - Computed directly from `sales` and `sale_lines` without any extra table.

import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

import { listCategories, type Category } from '../../api/categories';
import { describeError } from '../../api/errors';
import { listUsers, whoami, type Session, type UserSummary } from '../../api/identity';
import { getShopLogo } from '../../api/images';
import {
  cancelSale,
  listSalesHistory,
  type SaleHistoryEntry,
  type SaleHistoryLine,
} from '../../api/sales';
import { withOwnerApproval } from '../../shell/approval';
import { appearance } from '../../ui/appearance';
import {
  dg,
  fmtDate,
  fmtDayDate,
  fmtLong,
  fmtMonth,
  fmtTime,
  money,
  monthName,
  num,
} from '../../ui/format';
import { chatOpenNote, openChatUrl } from '../../ui/external';
import Icon from '../../ui/Icon.vue';
import Modal from '../../ui/Modal.vue';
import { toast } from '../../ui/toast';
import {
  buildWhatsAppUrl,
  copyReceiptCanvasToClipboard,
  formatWhatsAppMessage,
  isValidEgyptianPhone,
  normalizeEgyptianPhone,
  renderReceiptCanvas,
  warrantyLabelForReceipt,
  type ReceiptData,
} from '../pos/receipt';
import {
  addDays,
  byCategory,
  byDay,
  byMonth,
  byProduct,
  comparePeriod,
  dayStart,
  daysIn,
  extractInvoiceDigits,
  filterSalesRows,
  firstSaleDay,
  isoDay,
  monthEnd,
  monthKey,
  monthStart,
  moreItemsLabel,
  parseIsoDay,
  paymentMethodName,
  paymentSummaryLabel,
  pct,
  rowAmountMinor,
  SALES_PAYMENT_METHODS,
  sameMonth,
  totalsOf,
  type SalesRangeId,
  type SalesViewTab,
} from './analytics';

const props = defineProps<{
  session?: Session;
  focusTarget?: { readonly kind: 'day'; readonly iso: string } | { readonly kind: 'month'; readonly key: string } | null;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const resolvedSession = ref<Session | null>(props.session ?? null);
watch(
  () => props.session,
  (next) => {
    if (next) resolvedSession.value = next;
  }
);

const isOwner = computed(() => resolvedSession.value?.role === 'manager');
const canSeeCost = computed(() => isOwner.value);
const currentUserId = computed(() => resolvedSession.value?.userId ?? '');

const today = computed(() => dayStart(new Date()));

const state = reactive<{
  from: Date;
  to: Date;
  range: SalesRangeId;
  q: string;
  cat: string;
  seller: string;
  method: string;
  view: SalesViewTab;
  limit: number;
}>({
  from: dayStart(new Date()),
  to: dayStart(new Date()),
  range: 'today',
  q: '',
  cat: '',
  seller: '',
  method: '',
  view: 'inv',
  limit: 150,
});

const history = ref<readonly SaleHistoryEntry[]>([]);
const categories = ref<readonly Category[]>([]);
const users = ref<readonly UserSummary[]>([]);
const shopLogo = ref<string | null>(null);
const loading = ref(false);

const selectedSaleId = ref<string | null>(null);
const resendPhoneDraft = ref('');
const showCancelBox = ref(false);
const cancelReason = ref('');
const cancelling = ref(false);

const selectedSale = computed<SaleHistoryEntry | null>(() => {
  if (!selectedSaleId.value) return null;
  return history.value.find((s) => s.saleId === selectedSaleId.value) ?? null;
});

const firstDay = computed(() => firstSaleDay(history.value, today.value));
const len = computed(() => daysIn(state.from, state.to));
const isMonth = computed(() => state.range === 'month' || state.range === 'month-x');
const atToday = computed(() => state.to.getTime() >= today.value.getTime());
const atFirst = computed(() => state.from.getTime() <= firstDay.value.getTime());

const isFiltered = computed(
  () => !!(state.q.trim() || state.cat || state.seller || state.method)
);

const periodLabel = computed(() => {
  if (isMonth.value) {
    return `${fmtMonth(state.from)}${state.range === 'month' ? ' (لحد النهارده)' : ''}`;
  }
  if (len.value === 1) {
    return fmtLong(state.from);
  }
  return `من ${fmtDate(state.from)} لحد ${fmtDate(state.to)}`;
});

const rows = computed(() =>
  filterSalesRows(
    history.value,
    state.from,
    state.to,
    {
      q: state.q,
      cat: state.cat,
      seller: state.seller,
      method: state.method,
    },
    {
      isOwner: isOwner.value,
      userId: currentUserId.value,
    }
  )
);

const T = computed(() => totalsOf(rows.value));

const comparison = computed(() =>
  comparePeriod(state.from, state.to, isMonth.value, new Date())
);

const prevTotals = computed(() => {
  if (!isOwner.value) return null;
  const p = comparison.value;
  const prevRows = filterSalesRows(
    history.value,
    p.from,
    p.to,
    {
      q: state.q,
      cat: state.cat,
      seller: state.seller,
      method: state.method,
    },
    {
      isOwner: isOwner.value,
      userId: currentUserId.value,
      end: p.end,
    }
  );
  return totalsOf(prevRows);
});

const ch = computed(() =>
  prevTotals.value ? pct(T.value.salesMinor, prevTotals.value.salesMinor) : null
);

const vsWhat = computed(() => {
  const p = comparison.value;
  if (len.value === 1) {
    return p.live ? 'امبارح لنفس الساعة' : 'اليوم اللي قبله';
  }
  if (isMonth.value) {
    return p.live ? `نفس الوقت من ${monthName(p.from)}` : monthName(p.from);
  }
  return 'الفترة اللي قبلها';
});

const monthsDesc = computed(() => [...byMonth(history.value)].reverse());

const mainCategories = computed(() =>
  categories.value.filter((c) => c.parentId === null)
);

function subCategoriesOf(parentId: string): Category[] {
  return categories.value.filter((c) => c.parentId === parentId);
}

function categoryNameById(id: string): string {
  if (id === 'svc') return 'خدمات وصيانة';
  return categories.value.find((c) => c.id === id)?.name ?? '';
}

const sellersList = computed(() => {
  const map = new Map<string, string>();
  for (const u of users.value) {
    map.set(u.id, u.displayName);
  }
  for (const s of history.value) {
    if (!map.has(s.soldBy)) {
      map.set(s.soldBy, s.sellerName || s.soldBy);
    }
  }
  return [...map.entries()].map(([id, name]) => ({ id, name }));
});

const viewTabs = computed<readonly (readonly [SalesViewTab, string])[]>(() => [
  ['inv', 'الفواتير'],
  ...(len.value > 1 ? ([['day', 'الأيام']] as const) : []),
  ['prod', 'الأصناف'],
  ['cat', 'التصنيفات'],
]);

const dayRows = computed(() => byDay(rows.value, state.from, state.to));
const topDay = computed(() => {
  const list = dayRows.value;
  if (!list.length) return null;
  return list.reduce((best, d) => (d.salesMinor > best.salesMinor ? d : best), list[0]!);
});
const maxDaySalesMinor = computed(() => Math.max(1, topDay.value?.salesMinor ?? 1));

const productRows = computed(() => byProduct(rows.value));
const categoryRows = computed(() => byCategory(rows.value, categoryNameById));
const categoryTotalSalesMinor = computed(() =>
  Math.max(
    1,
    categoryRows.value.reduce((sum, c) => sum + c.salesMinor, 0)
  )
);

const reversedRows = computed(() => [...rows.value].reverse());
const shownRows = computed(() => reversedRows.value.slice(0, state.limit));

function displayInvoiceNo(reference: string): string {
  const seq = extractInvoiceDigits(reference);
  return seq ? dg(seq) : dg(reference);
}

function setSingleDay(d: Date): void {
  const t = today.value;
  const x = d.getTime() > t.getTime() ? t : dayStart(d);
  if (state.view === 'day') state.view = 'inv';
  state.from = x;
  state.to = x;
  if (x.getTime() === t.getTime()) {
    state.range = 'today';
  } else if (x.getTime() === addDays(t, -1).getTime()) {
    state.range = 'yesterday';
  } else {
    state.range = '';
  }
  state.limit = 150;
}

function setMonthRange(f: Date): void {
  const t = today.value;
  const e = monthEnd(f);
  state.from = monthStart(f);
  state.to = e.getTime() > t.getTime() ? t : e;
  state.range = sameMonth(f, t) ? 'month' : 'month-x';
  state.limit = 150;
}

function selectRange(id: 'today' | 'yesterday' | 'week' | 'month'): void {
  const t = today.value;
  if (id === 'today') {
    setSingleDay(t);
  } else if (id === 'yesterday') {
    setSingleDay(addDays(t, -1));
  } else if (id === 'month') {
    setMonthRange(t);
  } else {
    state.from = addDays(t, -6);
    state.to = t;
    state.range = 'week';
    state.limit = 150;
  }
}

function shiftPeriod(dir: -1 | 1): void {
  const t = today.value;
  const span = len.value;
  if (dir > 0 && state.to.getTime() >= t.getTime()) return;
  if (dir < 0 && state.from.getTime() <= firstDay.value.getTime()) return;

  if (span === 1) {
    setSingleDay(addDays(state.from, dir));
    return;
  }
  if (state.range === 'month' || state.range === 'month-x') {
    setMonthRange(new Date(state.from.getFullYear(), state.from.getMonth() + dir, 1));
    return;
  }
  let nextFrom = addDays(state.from, dir * span);
  let nextTo = addDays(state.to, dir * span);
  if (nextTo.getTime() > t.getTime()) {
    nextTo = t;
    nextFrom = addDays(t, -(span - 1));
  }
  state.from = nextFrom;
  state.to = nextTo;
  state.range = nextTo.getTime() === t.getTime() && span === 7 ? 'week' : '';
  state.limit = 150;
}

function onDatePick(event: Event): void {
  const raw = (event.target as HTMLInputElement).value;
  const parsed = parseIsoDay(raw);
  if (parsed) {
    setSingleDay(parsed);
  }
}

function onMonthPick(event: Event): void {
  const select = event.target as HTMLSelectElement;
  const val = select.value;
  select.value = '';
  const m = /^(\d{4})-(\d{2})$/.exec(val);
  if (!m) return;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (y && mo) {
    setMonthRange(new Date(y, mo - 1, 1));
  }
}

function clearFilters(): void {
  state.q = '';
  state.cat = '';
  state.seller = '';
  state.method = '';
  state.limit = 150;
}

function openDayFromTable(iso: string): void {
  const parsed = parseIsoDay(iso);
  if (!parsed) return;
  state.view = 'inv';
  setSingleDay(parsed);
}

function filterByProduct(productName: string): void {
  state.q = productName;
  state.view = 'inv';
  state.limit = 150;
}

function filterByCategory(catId: string): void {
  state.cat = catId === 'uncategorized' ? '' : catId;
  state.view = 'prod';
  state.limit = 150;
}

function openInvoiceModal(sale: SaleHistoryEntry): void {
  selectedSaleId.value = sale.saleId;
  resendPhoneDraft.value = sale.customerPhone ?? '';
  showCancelBox.value = false;
  cancelReason.value = '';
}

function closeInvoiceModal(): void {
  selectedSaleId.value = null;
  showCancelBox.value = false;
  cancelReason.value = '';
}

async function resendReceiptWhatsApp(sale: SaleHistoryEntry): Promise<void> {
  const targetPhone = normalizeEgyptianPhone(
    sale.customerPhone || resendPhoneDraft.value
  );
  if (!targetPhone) {
    toast('اكتب رقم موبايل مصري صحيح (11 رقم يبدأ بـ 01) لإرسال الإيصال', 'err');
    return;
  }

  const receiptData: ReceiptData = {
    reference: sale.reference,
    occurredAt: new Date(sale.occurredAt),
    sellerName: sale.sellerName,
    customerName: sale.customerName,
    lines: sale.lines.map((l: SaleHistoryLine) => ({
      name: l.productName,
      quantity: l.quantity,
      unitPriceMinor: l.unitSellingPriceMinor,
      discountMinor: l.discountMinor,
      lineTotalMinor: l.lineTotalMinor,
      imei: l.imei,
      warrantyEnd: l.warrantyEnd,
    })),
    grossSubtotalMinor: sale.linesSubtotalMinor,
    discountMinor: sale.discountMinor,
    totalMinor: sale.totalMinor,
    payments: sale.payments.map((p) => ({
      method: p.method as 'cash' | 'vf' | 'instapay' | 'card' | 'install' | 'credit',
      amountMinor: p.amountMinor,
      reference: p.reference,
    })),
    changeMinor: 0,
  };

  // The chat opens first: after the renders below the click is gone and the
  // browser blocks the window (`src/ui/external.ts`).
  const message = formatWhatsAppMessage(appearance.waTemplate, {
    customerName: sale.customerName,
    reference: sale.reference,
    shopName: appearance.shopName,
    totalMinor: sale.totalMinor,
    warrantyDate: warrantyLabelForReceipt(receiptData),
  });
  const url = buildWhatsAppUrl(targetPhone, message);
  const opened = openChatUrl(url);

  try {
    const canvas = await renderReceiptCanvas(receiptData, {
      shopName: appearance.shopName,
      shopPhone: appearance.shopPhone,
      shopAddress: appearance.shopAddress,
      receiptFooter: appearance.receiptFooter,
      receiptPaper: appearance.receiptPaper,
      shopLogo: shopLogo.value,
    });
    await copyReceiptCanvasToClipboard(canvas);
    toast(`واتساب على ${targetPhone}: ${chatOpenNote(opened)}`, 'ok');
  } catch (err) {
    toast(describeError(err), 'err');
  }
}

async function confirmCancelInvoice(): Promise<void> {
  const sale = selectedSale.value;
  if (!sale || sale.isCancelled) return;
  const reason = cancelReason.value.trim();
  if (!reason) {
    toast('اكتب سبب إلغاء الفاتورة الأول', 'err');
    return;
  }
  cancelling.value = true;
  try {
    await withOwnerApproval(
      () => cancelSale(sale.saleId, reason),
      `إلغاء فاتورة ${sale.reference}`
    );
    toast(`تم إلغاء الفاتورة ${sale.reference} وإرجاع البضاعة للمخزن`, 'ok');
    showCancelBox.value = false;
    cancelReason.value = '';
    await loadAll();
    emit('changed');
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    cancelling.value = false;
  }
}

function exportCsv(): void {
  if (!rows.value.length) {
    toast('مفيش مبيعات في الفترة دي عشان تتصدّر', 'info');
    return;
  }
  const headers = [
    'رقم الفاتورة',
    'التاريخ',
    'الوقت',
    ...(isOwner.value ? ['البيّاع'] : []),
    'العميل',
    'الأصناف',
    'الدفع',
    'الإجمالي (ج.م)',
    ...(canSeeCost.value ? ['الربح (ج.م)'] : []),
  ];
  const csvLines = [
    headers.join(','),
    ...reversedRows.value.map((r) => {
      const dt = new Date(r.x.occurredAt);
      const itemsText = r.lines.map((l) => `${l.productName} x${l.quantity}`).join(' | ');
      const cols = [
        `"${r.x.reference}"`,
        `"${fmtDate(dt)}"`,
        `"${fmtTime(dt)}"`,
        ...(isOwner.value ? [`"${r.x.sellerName}"`] : []),
        `"${r.x.customerName ?? 'نقدي'}"`,
        `"${itemsText.replace(/"/g, '""')}"`,
        `"${paymentSummaryLabel(r.x.payments)}"`,
        (rowAmountMinor(r) / 100).toFixed(2),
        ...(canSeeCost.value
          ? [((r.x.profitMinor ?? 0) / 100).toFixed(2)]
          : []),
      ];
      return cols.join(',');
    }),
  ];
  const blob = new Blob(['\uFEFF' + csvLines.join('\r\n')], {
    type: 'text/csv;charset=utf-8;',
  });
  if (typeof navigator === 'undefined' || navigator.webdriver !== true) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-${isoDay(state.from)}-${isoDay(state.to)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  toast(`تم تصدير ${num(rows.value.length)} فاتورة لملف Excel (CSV)`, 'ok');
}

function onKeydown(event: KeyboardEvent): void {
  if (selectedSaleId.value !== null) return;
  const tg = event.target as HTMLElement | null;
  const typing =
    tg &&
    (tg.tagName === 'INPUT' ||
      tg.tagName === 'SELECT' ||
      tg.tagName === 'TEXTAREA' ||
      tg.isContentEditable);
  if (typing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'ArrowRight') {
    event.preventDefault();
    shiftPeriod(-1);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    shiftPeriod(1);
  }
}

async function loadAll(): Promise<void> {
  loading.value = true;
  try {
    if (!resolvedSession.value) {
      resolvedSession.value = await whoami();
    }
    const [salesData, catsData, usersData, logoData] = await Promise.all([
      listSalesHistory(5000),
      listCategories().catch(() => [] as Category[]),
      listUsers().catch(() => [] as UserSummary[]),
      getShopLogo().catch(() => null),
    ]);
    history.value = salesData;
    categories.value = catsData;
    users.value = usersData;
    shopLogo.value = logoData;
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    loading.value = false;
  }
}

watch(
  () => resolvedSession.value?.userId,
  () => {
    state.seller = '';
    void loadAll();
  }
);

function applyFocusTarget(
  target: { readonly kind: 'day'; readonly iso: string } | { readonly kind: 'month'; readonly key: string } | null | undefined,
): void {
  if (!target) return;
  clearFilters();
  state.view = 'inv';
  if (target.kind === 'day') {
    const parsed = parseIsoDay(target.iso);
    if (parsed) setSingleDay(parsed);
  } else if (target.kind === 'month') {
    const m = /^(\d{4})-(\d{2})$/.exec(target.key);
    if (m) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      if (y && mo) setMonthRange(new Date(y, mo - 1, 1));
    }
  }
}

watch(
  () => props.focusTarget,
  (next) => {
    applyFocusTarget(next);
  }
);

onMounted(() => {
  applyFocusTarget(props.focusTarget);
  void loadAll();
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="page sales" data-sales-screen>
    <div class="page-h">
      <h2>المبيعات</h2>
      <span class="sub" data-sales-subtitle>
        {{ isOwner ? 'كل مبيعات المحل' : 'مبيعاتك انت بس' }}
      </span>
      <span class="sp" />
      <button
        type="button"
        class="btn"
        data-sales-export
        @click="exportCsv"
      >
        <Icon name="download" /> تصدير Excel
      </button>
    </div>

    <div class="sv-bar">
      <div class="day-nav">
        <button
          type="button"
          class="icon-btn"
          data-sales-shift="-1"
          :disabled="atFirst"
          :title="`${len === 1 ? 'اليوم اللي قبله' : 'الفترة اللي قبلها'} (السهم يمين)`"
          :aria-label="len === 1 ? 'اليوم اللي قبله' : 'الفترة اللي قبلها'"
          @click="shiftPeriod(-1)"
        >
          <Icon name="chevron-right" />
        </button>

        <label class="day-pick" title="اختار يوم" data-sales-day-pick>
          <Icon name="calendar" />
          <span class="dl" data-sales-period-label>{{ periodLabel }}</span>
          <input
            type="date"
            data-sales-date-input
            :value="isoDay(state.to)"
            :min="isoDay(firstDay)"
            :max="isoDay(today)"
            aria-label="اختار يوم"
            @change="onDatePick"
          />
        </label>

        <button
          type="button"
          class="icon-btn"
          data-sales-shift="1"
          :disabled="atToday"
          :title="`${len === 1 ? 'اليوم اللي بعده' : 'الفترة اللي بعدها'} (السهم شمال)`"
          :aria-label="len === 1 ? 'اليوم اللي بعده' : 'الفترة اللي بعدها'"
          @click="shiftPeriod(1)"
        >
          <Icon name="chevron-left" />
        </button>
      </div>

      <div class="seg" role="group" aria-label="الفترة">
        <button
          type="button"
          :class="{ on: state.range === 'today' }"
          data-sales-range="today"
          @click="selectRange('today')"
        >
          النهارده
        </button>
        <button
          type="button"
          :class="{ on: state.range === 'yesterday' }"
          data-sales-range="yesterday"
          @click="selectRange('yesterday')"
        >
          امبارح
        </button>
        <button
          type="button"
          :class="{ on: state.range === 'week' }"
          data-sales-range="week"
          @click="selectRange('week')"
        >
          آخر 7 أيام
        </button>
        <button
          type="button"
          :class="{ on: state.range === 'month' }"
          data-sales-range="month"
          @click="selectRange('month')"
        >
          الشهر ده
        </button>
      </div>

      <select
        class="sv-sel sv-month"
        data-sales-month
        aria-label="اختار شهر"
        :value="''"
        @change="onMonthPick"
      >
        <option value="" selected>اختار شهر</option>
        <option
          v-for="m in monthsDesc"
          :key="m.key"
          :value="m.key"
        >
          {{ fmtMonth(m.from) }}{{ isMonth && monthKey(state.from) === m.key ? ' (المعروض)' : '' }}
        </option>
      </select>
    </div>

    <div class="sv-filters">
      <label class="inline-search">
        <Icon name="search" />
        <input
          id="sv-q"
          v-model="state.q"
          data-sales-search
          placeholder="صنف، رقم فاتورة، IMEI، عميل أو رقمه"
          autocomplete="off"
          aria-label="بحث في المبيعات"
          @input="state.limit = 150"
        />
      </label>

      <select
        v-model="state.cat"
        class="sv-sel"
        data-sales-cat
        aria-label="التصنيف"
        @change="state.limit = 150"
      >
        <option value="">كل التصنيفات</option>
        <template v-for="c in mainCategories" :key="c.id">
          <optgroup
            v-if="subCategoriesOf(c.id).length > 0"
            :label="c.name"
          >
            <option :value="c.id">كل {{ c.name }}</option>
            <option
              v-for="s in subCategoriesOf(c.id)"
              :key="s.id"
              :value="s.id"
            >
              {{ s.name }}
            </option>
          </optgroup>
          <option v-else :value="c.id">{{ c.name }}</option>
        </template>
      </select>

      <select
        v-if="isOwner"
        v-model="state.seller"
        class="sv-sel"
        data-sales-seller
        aria-label="البيّاع"
        @change="state.limit = 150"
      >
        <option value="">كل البيّاعين</option>
        <option
          v-for="u in sellersList"
          :key="u.id"
          :value="u.id"
        >
          {{ u.name }}
        </option>
      </select>

      <select
        v-model="state.method"
        class="sv-sel"
        data-sales-method
        aria-label="طريقة الدفع"
        @change="state.limit = 150"
      >
        <option value="">كل طرق الدفع</option>
        <option
          v-for="m in SALES_PAYMENT_METHODS"
          :key="m.id"
          :value="m.id"
        >
          {{ m.name }}
        </option>
      </select>

      <button
        v-if="isFiltered"
        type="button"
        class="btn ghost"
        data-sales-clear-filters
        @click="clearFilters"
      >
        <Icon name="x" /> مسح الفلاتر
      </button>
    </div>

    <div class="cards">
      <div class="card kpi" data-sales-kpi="sales">
        <div class="label">المبيعات</div>
        <div class="value num" data-sales-kpi-sales-value>
          {{ money(T.salesMinor) }}
        </div>
        <div
          v-if="ch !== null"
          class="sub"
          :class="ch >= 0 ? 'ok-t' : 'danger-t'"
          data-sales-kpi-change
        >
          <Icon :name="ch >= 0 ? 'trending-up' : 'trending-down'" />
          {{ num(Math.abs(ch)) }}% عن {{ vsWhat }}
        </div>
      </div>

      <div class="card kpi" data-sales-kpi="invoices">
        <div class="label">عدد الفواتير</div>
        <div class="value num" data-sales-kpi-invoices-value>
          {{ num(T.invoices) }}
        </div>
        <div class="sub muted">متوسط الفاتورة {{ money(T.avgMinor) }}</div>
      </div>

      <div class="card kpi" data-sales-kpi="pcs">
        <div class="label">القطع</div>
        <div class="value num" data-sales-kpi-pcs-value>
          {{ num(T.pcs) }}
        </div>
        <div class="sub muted">
          {{ len === 1 ? 'في اليوم ده' : `في ${num(len)} يوم` }}
        </div>
      </div>

      <div
        v-if="canSeeCost"
        class="card kpi"
        data-sales-kpi="profit"
      >
        <div class="label">الربح</div>
        <div class="value num" data-sales-kpi-profit-value>
          {{ money(T.profitMinor) }}
        </div>
        <div class="sub muted">
          هامش {{ num(T.salesMinor ? Math.round((T.profitMinor / T.salesMinor) * 100) : 0) }}%
        </div>
      </div>
    </div>

    <div class="sv-head">
      <div class="seg" role="tablist" aria-label="طريقة العرض">
        <button
          v-for="[vId, vLabel] in viewTabs"
          :key="vId"
          type="button"
          :class="{ on: state.view === vId }"
          :data-sales-view="vId"
          @click="state.view = vId"
        >
          {{ vLabel }}
        </button>
      </div>
      <span
        v-if="T.partial"
        class="muted sv-note"
        data-sales-partial-note
      >
        المبالغ للأصناف المطابقة بس، قبل خصم الفاتورة
      </span>
    </div>

    <div v-if="!rows.length" class="sv-empty" data-sales-empty>
      <Icon name="receipt-text" />
      <b>
        {{
          isFiltered
            ? 'مفيش مبيعات بالفلاتر دي'
            : len === 1
              ? 'مفيش مبيعات في اليوم ده'
              : isMonth
                ? 'مفيش مبيعات في الشهر ده'
                : 'مفيش مبيعات في الفترة دي'
        }}
      </b>
      <span>
        {{
          isFiltered
            ? 'شيل فلتر أو جرّب يوم تاني.'
            : 'جرّب يوم تاني بالأسهم أو اختار تاريخ.'
        }}
      </span>
      <button
        v-if="isFiltered"
        type="button"
        class="btn sm"
        data-sales-empty-clear
        @click="clearFilters"
      >
        <Icon name="x" /> مسح الفلاتر
      </button>
    </div>

    <!-- عرض بالأيام -->
    <div
      v-else-if="state.view === 'day' && len > 1"
      class="table-wrap"
    >
      <table class="t sv-t sv-days" data-sales-table="day">
        <thead>
          <tr>
            <th>اليوم</th>
            <th class="ta-n">الفواتير</th>
            <th class="ta-n">القطع</th>
            <th class="ta-n">المبيعات</th>
            <th aria-hidden="true" />
            <th v-if="canSeeCost" class="ta-n">الربح</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="d in dayRows"
            :key="d.iso"
            class="hov click"
            :class="{ zero: d.invoices === 0 }"
            :data-sales-day-row="d.iso"
            title="افتح اليوم ده"
            @click="openDayFromTable(d.iso)"
          >
            <td>
              {{ fmtDayDate(d.day) }}
              <span
                v-if="topDay && d.iso === topDay.iso && d.salesMinor > 0"
                class="tag ok"
              >
                أعلى يوم
              </span>
            </td>
            <td class="ta-n num">{{ num(d.invoices) }}</td>
            <td class="ta-n num">{{ num(d.pcs) }}</td>
            <td class="ta-n num">
              <b>{{ money(d.salesMinor) }}</b>
            </td>
            <td aria-hidden="true">
              <span class="sv-share">
                <i
                  :style="{
                    width: `${Math.round((d.salesMinor / maxDaySalesMinor) * 100)}%`,
                  }"
                />
              </span>
            </td>
            <td v-if="canSeeCost" class="ta-n num">
              {{ money(d.profitMinor) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- عرض بالأصناف -->
    <div
      v-else-if="state.view === 'prod'"
      class="table-wrap"
    >
      <table class="t sv-t" data-sales-table="prod">
        <thead>
          <tr>
            <th>الصنف</th>
            <th>التصنيف</th>
            <th class="ta-n">القطع</th>
            <th class="ta-n">المبيعات</th>
            <th v-if="canSeeCost" class="ta-n">الربح</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in productRows"
            :key="e.key"
            class="hov click"
            :data-sales-prod-row="e.name"
            title="اعرض فواتيره"
            @click="filterByProduct(e.name)"
          >
            <td><bdi dir="auto">{{ e.name }}</bdi></td>
            <td class="muted">{{ e.categoryName }}</td>
            <td class="ta-n num">{{ num(e.qty) }}</td>
            <td class="ta-n num">
              <b>{{ money(e.salesMinor) }}</b>
            </td>
            <td v-if="canSeeCost" class="ta-n num">
              {{ money(e.profitMinor) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- عرض بالتصنيفات -->
    <div
      v-else-if="state.view === 'cat'"
      class="table-wrap"
    >
      <table class="t sv-t" data-sales-table="cat">
        <thead>
          <tr>
            <th>التصنيف</th>
            <th class="ta-n">القطع</th>
            <th class="ta-n">المبيعات</th>
            <th>النسبة</th>
            <th v-if="canSeeCost" class="ta-n">الربح</th>
          </tr>
        </thead>
        <tbody>
          <template v-for="c in categoryRows" :key="c.id">
            <tr
              class="hov click"
              :data-sales-cat-row="c.id"
              title="اعرض أصنافه"
              @click="filterByCategory(c.id)"
            >
              <td>{{ c.name }}</td>
              <td class="ta-n num">{{ num(c.qty) }}</td>
              <td class="ta-n num">
                <b>{{ money(c.salesMinor) }}</b>
              </td>
              <td>
                <span class="sv-share">
                  <i
                    :style="{
                      width: `${Math.round((c.salesMinor / categoryTotalSalesMinor) * 100)}%`,
                    }"
                  />
                </span>
                <span class="num">
                  {{ num(Math.round((c.salesMinor / categoryTotalSalesMinor) * 100)) }}%
                </span>
              </td>
              <td v-if="canSeeCost" class="ta-n num">
                {{ money(c.profitMinor) }}
              </td>
            </tr>
            <tr
              v-for="s in c.subs"
              :key="s.id"
              class="hov click sub"
              :data-sales-cat-row="s.id"
              title="اعرض أصنافه"
              @click="filterByCategory(s.id)"
            >
              <td>{{ s.name }}</td>
              <td class="ta-n num">{{ num(s.qty) }}</td>
              <td class="ta-n num">
                <b>{{ money(s.salesMinor) }}</b>
              </td>
              <td>
                <span class="sv-share">
                  <i
                    :style="{
                      width: `${Math.round((s.salesMinor / categoryTotalSalesMinor) * 100)}%`,
                    }"
                  />
                </span>
                <span class="num">
                  {{ num(Math.round((s.salesMinor / categoryTotalSalesMinor) * 100)) }}%
                </span>
              </td>
              <td v-if="canSeeCost" class="ta-n num">
                {{ money(s.profitMinor) }}
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- عرض بالفواتير (الافتراضي) -->
    <template v-else>
      <div class="table-wrap">
        <table class="t sv-t" data-sales-table="inv">
          <thead>
            <tr>
              <th>رقم</th>
              <th>{{ len === 1 ? 'الوقت' : 'اليوم' }}</th>
              <th v-if="isOwner">البيّاع</th>
              <th>العميل</th>
              <th>الأصناف</th>
              <th>الدفع</th>
              <th class="ta-n">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in shownRows"
              :key="r.x.saleId"
              class="hov click"
              :data-sales-inv-row="r.x.reference"
              @click="openInvoiceModal(r.x)"
            >
              <td class="num" :title="r.x.reference">
                {{ displayInvoiceNo(r.x.reference) }}
              </td>
              <td class="num">
                <template v-if="len === 1">
                  {{ fmtTime(new Date(r.x.occurredAt)) }}
                </template>
                <template v-else>
                  {{ fmtDate(new Date(r.x.occurredAt)) }}
                  <span class="muted">{{ fmtTime(new Date(r.x.occurredAt)) }}</span>
                </template>
              </td>
              <td v-if="isOwner">{{ r.x.sellerName }}</td>
              <td>
                <template v-if="r.x.customerName">
                  {{ r.x.customerName }}
                </template>
                <span v-else class="muted">نقدي</span>
              </td>
              <td>
                <bdi dir="auto">{{ r.lines[0]?.productName ?? '' }}</bdi>
                <span v-if="r.lines.length > 1" class="muted">
                  {{ ' ' + moreItemsLabel(r.lines.length - 1) }}
                </span>
              </td>
              <td>{{ paymentSummaryLabel(r.x.payments) }}</td>
              <td class="ta-n num">
                <b>{{ money(rowAmountMinor(r)) }}</b>
                <small v-if="r.lineLevel" class="muted">
                  من {{ money(r.x.totalMinor) }}
                </small>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <button
        v-if="reversedRows.length > shownRows.length"
        type="button"
        class="btn ghost sv-more"
        data-sales-more
        @click="state.limit += 150"
      >
        اعرض {{ num(Math.min(150, reversedRows.length - shownRows.length)) }} فاتورة كمان (فاضل {{ num(reversedRows.length - shownRows.length) }})
      </button>
    </template>

    <!-- تفاصيل الفاتورة -->
    <Modal
      v-if="selectedSale"
      size="md"
      :title="`فاتورة رقم ${displayInvoiceNo(selectedSale.reference)}`"
      :sub="`${fmtLong(new Date(selectedSale.occurredAt))} الساعة ${fmtTime(new Date(selectedSale.occurredAt))}، البيّاع ${selectedSale.sellerName}`"
      aria-label="تفاصيل الفاتورة"
      @close="closeInvoiceModal"
    >
      <div class="stack" data-sales-detail-modal>
        <div class="row" style="justify-content: space-between; flex-wrap: wrap; gap: 8px">
          <div class="sv-cust">
            <Icon :name="selectedSale.customerName ? 'user-round' : 'user'" />
            <span v-if="selectedSale.customerName">
              <b>{{ selectedSale.customerName }}</b>
              <bdi
                v-if="selectedSale.customerPhone"
                dir="ltr"
                class="mono"
                style="margin-inline-start: 6px"
              >
                {{ selectedSale.customerPhone }}
              </bdi>
            </span>
            <span v-else>عميل نقدي</span>
          </div>
          <span class="mono muted" dir="ltr" data-sales-detail-ref>
            {{ selectedSale.reference }}
          </span>
        </div>

        <div class="table-wrap">
          <table class="t">
            <thead>
              <tr>
                <th>الصنف</th>
                <th class="ta-n">الكمية</th>
                <th class="ta-n">السعر</th>
                <th class="ta-n">الإجمالي</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="l in selectedSale.lines"
                :key="l.lineId"
                :data-sales-detail-line="l.productName"
              >
                <td>
                  <bdi dir="auto">{{ l.productName }}</bdi>
                  <div v-if="l.imei" class="sv-meta">
                    <span class="tag accent imei-tag">
                      <Icon name="scan-barcode" />
                      <span class="k">IMEI</span>
                      <span class="mono" dir="ltr" data-sales-detail-imei>{{ l.imei }}</span>
                    </span>
                  </div>
                  <div v-if="l.warrantyEnd" class="sv-meta muted" data-sales-detail-warranty>
                    ضمان لحد <bdi dir="ltr">{{ l.warrantyEnd }}</bdi>
                  </div>
                </td>
                <td class="ta-n num">{{ num(l.quantity) }}</td>
                <td class="ta-n num">{{ money(l.unitSellingPriceMinor) }}</td>
                <td class="ta-n num">{{ money(l.lineTotalMinor) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="sum-box">
          <div v-if="selectedSale.discountMinor > 0" class="r">
            <span>خصم</span>
            <span class="num">− {{ money(selectedSale.discountMinor) }}</span>
          </div>
          <div class="r grand">
            <span>الإجمالي</span>
            <span class="num" data-sales-detail-total>{{ money(selectedSale.totalMinor) }}</span>
          </div>
          <div
            v-for="(p, idx) in selectedSale.payments"
            :key="idx"
            class="r"
          >
            <span>{{ paymentMethodName(p.method, p.reference) }}</span>
            <span class="num">{{ money(p.amountMinor) }}</span>
          </div>
          <div
            v-if="selectedSale.alreadyRefundedMinor > 0 && !selectedSale.isCancelled"
            class="r warn-t"
          >
            <span>مرتجع سابق</span>
            <span class="num">− {{ money(selectedSale.alreadyRefundedMinor) }}</span>
          </div>
          <div
            v-if="canSeeCost && selectedSale.profitMinor !== undefined"
            class="r muted"
            data-sales-detail-profit
          >
            <span>الربح</span>
            <span class="num">{{ money(selectedSale.profitMinor) }}</span>
          </div>
        </div>

        <div
          v-if="!selectedSale.customerPhone"
          class="row"
          style="gap: 8px; flex-wrap: wrap"
        >
          <input
            v-model="resendPhoneDraft"
            class="in"
            :class="{ mono: resendPhoneDraft !== '' }"
            :dir="resendPhoneDraft ? 'ltr' : 'rtl'"
            inputmode="tel"
            placeholder="رقم واتساب لإرسال الإيصال (01xxxxxxxxx)"
            aria-label="رقم واتساب لإرسال الإيصال"
            data-sales-detail-wa-phone
            style="flex: 1; min-width: 210px"
          />
        </div>

        <div
          v-if="showCancelBox && isOwner && !selectedSale.isCancelled"
          class="card"
          style="background: var(--surface-2); padding: 12px"
          data-sales-detail-cancel-box
        >
          <div class="stack" style="gap: 8px">
            <label for="sv-cancel-reason" style="font-weight: 700; font-size: .88rem">
              سبب إلغاء الفاتورة (بيطلب PIN المالك وبيرجّع البضاعة للمخزن)
            </label>
            <div class="row" style="gap: 8px; flex-wrap: wrap">
              <input
                id="sv-cancel-reason"
                v-model="cancelReason"
                class="in"
                data-sales-detail-cancel-reason
                placeholder="مثلًا: العميل رجّع الفاتورة بالكامل"
                style="flex: 1; min-width: 200px"
                @keydown.enter.prevent="confirmCancelInvoice"
              />
              <button
                type="button"
                class="btn danger"
                data-sales-detail-cancel-confirm
                :disabled="cancelling"
                @click="confirmCancelInvoice"
              >
                <Icon name="trash-2" /> تأكيد الإلغاء
              </button>
            </div>
          </div>
        </div>
      </div>

      <template #foot>
        <button
          v-if="isOwner && !selectedSale.isCancelled && !showCancelBox"
          type="button"
          class="btn ghost danger"
          data-sales-detail-cancel-open
          @click="showCancelBox = true"
        >
          <Icon name="rotate-ccw" /> إلغاء الفاتورة
        </button>
        <span class="sp" />
        <button
          v-if="selectedSale.customerPhone || isValidEgyptianPhone(resendPhoneDraft)"
          type="button"
          class="btn"
          data-sales-detail-resend
          @click="resendReceiptWhatsApp(selectedSale)"
        >
          <Icon name="message-circle" /> ابعت الإيصال تاني واتساب
        </button>
        <button
          type="button"
          class="btn ghost"
          data-sales-detail-close
          @click="closeInvoiceModal"
        >
          اقفل <kbd>Esc</kbd>
        </button>
      </template>
    </Modal>
  </div>
</template>
