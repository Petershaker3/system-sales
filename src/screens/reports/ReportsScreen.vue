<script setup lang="ts">
// شاشة «التقارير» للمالك: «النهارده» و«الشهر» بمقارناته وتقييمه (`docs/ui/mockup-v1/views/reports.js`,
// `docs/ui/mockup-v1/analytics.js`, `docs/ui/MONTHS-REPORTS-RECEIVING.md`, `docs/PLAN.md` §14 & §19, `ADR-035`).

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { listCategories, type Category } from '../../api/categories';
import { describeError } from '../../api/errors';
import { expensesOverview, type ExpenseOverview } from '../../api/expenses';
import { listUsers, type Session, type UserSummary } from '../../api/identity';
import { listAllProductUnits, type ProductUnit } from '../../api/inventory';
import { posCatalog, type PosProduct } from '../../api/pos';
import { repairsOverview, type RepairsOverview } from '../../api/repairs';
import { listSalesHistory, type SaleHistoryEntry } from '../../api/sales';
import { currentShiftSummary, type CurrentShiftState } from '../../api/shift';
import { shortagesOverview, type ShortagesOverview } from '../../api/shortages';
import { walletsOverview, type WalletsOverview } from '../../api/wallet';
import type { ScreenId } from '../../shell/nav';
import { appearance } from '../../ui/appearance';
import {
  countWord,
  dg,
  fmtDay,
  fmtDayDate,
  fmtLong,
  fmtMonth,
  fmtTime,
  money,
  monthName,
  num,
  pcsWord,
} from '../../ui/format';
import Icon from '../../ui/Icon.vue';
import { toast } from '../../ui/toast';
import { buildWhatsAppUrl, normalizeEgyptianPhone } from '../pos/receipt';
import {
  addDays,
  byMonth,
  chgFormat,
  dayStart,
  EVALUATION_THRESHOLDS,
  isoDay,
  kShortMinor,
  monthEnd,
  monthKey,
  monthReport,
  monthStart,
  nMonthsLabel,
  pct,
  rateDay,
  rateMonthVerdict,
  sameMonth,
  todayReport,
  type EvaluationNote,
} from '../sales/analytics';
import {
  buildSmartAlertsBundle,
  formatDailyWhatsAppSummary,
} from './smart-alerts';

defineProps<{
  session?: Session;
}>();

const emit = defineEmits<{
  openSalesDay: [iso: string];
  openSalesMonth: [monthKey: string];
  goScreen: [screen: ScreenId];
}>();

const activeTab = ref<'today' | 'month'>('today');
const selectedMonth = ref<Date>(monthStart(new Date()));
const nowDate = ref<Date>(new Date());

const history = ref<readonly SaleHistoryEntry[]>([]);
const categories = ref<readonly Category[]>([]);
const users = ref<readonly UserSummary[]>([]);
const shiftState = ref<CurrentShiftState | null>(null);
const todayWallets = ref<WalletsOverview | null>(null);
const monthWallets = ref<WalletsOverview | null>(null);
const todayRepairs = ref<RepairsOverview | null>(null);
const todayExpenses = ref<ExpenseOverview | null>(null);
const monthRepairs = ref<RepairsOverview | null>(null);
const monthExpenses = ref<ExpenseOverview | null>(null);
const shortagesData = ref<ShortagesOverview | null>(null);
const posProducts = ref<readonly PosProduct[]>([]);
const allUnits = ref<readonly ProductUnit[]>([]);
const showWaSummaryPreview = ref(false);
const loading = ref(false);

function categoryNameById(id: string, fallback = ''): string {
  if (id === 'svc') return 'خدمات وصيانة';
  if (id === 'uncategorized') return 'بدون تصنيف';
  const found = categories.value.find((c) => c.id === id);
  return found ? found.name : fallback || 'بدون تصنيف';
}

function isUsedCategory(catId: string | null): boolean {
  if (!catId) return false;
  if (catId === '01a14728-8400-7000-8000-000000000002' || catId === 'used') return true;
  const found = categories.value.find((c) => c.id === catId);
  return found?.kind === 'used' || (found?.name.includes('مستعمل') ?? false);
}

function userNameById(id: string, fallback = ''): string {
  const u = users.value.find((x) => x.id === id);
  return u ? u.displayName : fallback || id;
}

function weekdayName(dayIndex: number): string {
  // Jan 7, 2024 was a Sunday (0)
  return fmtDay(new Date(2024, 0, 7 + dayIndex));
}

const todayData = computed(() =>
  todayReport(history.value, nowDate.value, (d) => fmtDay(d)),
);

const maxWeekSalesMinor = computed(() =>
  Math.max(1, ...todayData.value.week.map((w) => w.salesMinor)),
);

const currentMonthRep = computed(() =>
  monthReport(history.value, nowDate.value, nowDate.value, {
    categoryNameById,
    isUsedCategory,
  }),
);

const currentMonthVsPrev = computed(() =>
  currentMonthRep.value.PT.salesMinor
    ? pct(currentMonthRep.value.T.salesMinor, currentMonthRep.value.PT.salesMinor)
    : null,
);

const monthRep = computed(() =>
  monthReport(history.value, selectedMonth.value, nowDate.value, {
    categoryNameById,
    isUsedCategory,
  }),
);

const allMonthsAsc = computed(() => byMonth(history.value));
const allMonthsDesc = computed(() => [...allMonthsAsc.value].reverse());

const firstMonth = computed(() => {
  const first = allMonthsAsc.value[0];
  return first ? first.from : monthStart(nowDate.value);
});

const atFirstMonth = computed(
  () => monthRep.value.from.getTime() <= firstMonth.value.getTime(),
);
const atLastMonth = computed(() =>
  sameMonth(monthRep.value.from, dayStart(nowDate.value)),
);

const monthTitle = computed(
  () =>
    `${fmtMonth(monthRep.value.from)}${monthRep.value.live ? ' (لحد النهارده)' : ''}`,
);

const vsPrevLabel = computed(() =>
  monthRep.value.P.live
    ? `نفس الوقت من ${monthName(monthRep.value.P.from)}`
    : monthName(monthRep.value.P.from),
);

const vsYearLabel = computed(() =>
  monthRep.value.Y.live
    ? `نفس الوقت من ${fmtMonth(monthRep.value.Y.from)}`
    : fmtMonth(monthRep.value.Y.from),
);

const chSales = computed(() =>
  monthRep.value.PT.salesMinor
    ? pct(monthRep.value.T.salesMinor, monthRep.value.PT.salesMinor)
    : null,
);

const chProfit = computed(() =>
  monthRep.value.PT.profitMinor
    ? pct(monthRep.value.T.profitMinor, monthRep.value.PT.profitMinor)
    : null,
);

const chYoy = computed(() =>
  monthRep.value.YT && monthRep.value.YT.salesMinor
    ? pct(monthRep.value.T.salesMinor, monthRep.value.YT.salesMinor)
    : null,
);

const monthMarginPct = computed(() =>
  monthRep.value.T.salesMinor
    ? Math.round((monthRep.value.T.profitMinor / monthRep.value.T.salesMinor) * 100)
    : 0,
);

const monthRating = computed(() =>
  rateMonthVerdict(monthRep.value.verdict, monthRep.value.rank, monthRep.value.of),
);

const verdictText = computed(() => {
  const R = monthRep.value;
  const map: Record<typeof R.verdict.key, string> = {
    best: `أحسن شهر في آخر ${nMonthsLabel(R.of)}`,
    top3: `من أحسن 3 شهور في آخر ${nMonthsLabel(R.of)}: ترتيبه ${num(R.rank ?? 1)}`,
    low3: `من أضعف 3 شهور في آخر ${nMonthsLabel(R.of)}: ترتيبه ${num(R.rank ?? 1)}`,
    mid: `شهر متوسط: ترتيبه ${num(R.rank ?? 1)} من ${num(R.of)}`,
    early: 'لسه بدري نحكم على الشهر ده',
    few: 'مفيش شهور كفاية قبله نقارن بيها',
  };
  return map[R.verdict.key];
});

function notePrefixText(n: EvaluationNote): string {
  const near = (ch: number) => Math.abs(ch) < EVALUATION_THRESHOLDS.sales;
  switch (n.key) {
    case 'sales':
      return n.ch === null
        ? 'مفيش شهر قبله في السجل نقارن بيه'
        : near(n.ch)
          ? `المبيعات قريبة من ${vsPrevLabel.value}`
          : `المبيعات ${n.ch > 0 ? 'زادت' : 'قلّت'} ${num(Math.abs(n.ch))}% عن ${vsPrevLabel.value}`;
    case 'yoy':
      return n.ch === null || near(n.ch)
        ? `قريبة من ${vsYearLabel.value}`
        : `${n.ch > 0 ? 'وزادت' : 'وقلّت'} ${num(Math.abs(n.ch))}% عن ${vsYearLabel.value}`;
    case 'margin':
      return `هامش الربح ${n.now > n.before ? 'طلع' : 'نزل'} من ${num(n.before)}% لـ ${num(n.now)}%${
        n.mix
          ? `، لأن الموبايلات بقت ${num(n.mix.now)}% من المبيعات (كانت ${num(n.mix.before)}%)`
          : ''
      }`;
    case 'avg':
      return `متوسط الفاتورة ${n.ch > 0 ? 'زاد' : 'قلّ'} ${num(Math.abs(n.ch))}%: بقى ${money(n.nowMinor)}`;
    case 'catUp':
      return `مبيعات «${categoryNameById(n.id, n.name)}» زادت ${num(n.ch)}%`;
    case 'catDown':
      return `مبيعات «${categoryNameById(n.id, n.name)}» قلّت ${num(Math.abs(n.ch))}%`;
    case 'disc':
      return `الخصومات زادت: ${money(n.nowMinor)} (كانت ${money(n.beforeMinor)})`;
    case 'credit':
      return `الآجل زاد: ${money(n.nowMinor)} (كان ${money(n.beforeMinor)})، يعني فلوس لسه برّه المحل`;
    case 'top':
      return 'أكتر صنف جاب فلوس: ';
    case 'bestDay':
      return `أعلى يوم: ${fmtDayDate(n.day)} (${money(n.salesMinor)})`;
    case 'weekdays':
      return `${weekdayName(n.days[0])} و${weekdayName(n.days[1])} عملوا ${num(n.share)}% من المبيعات`;
    case 'seller':
      return `${userNameById(n.id, n.name)} عمل ${num(n.share)}% من المبيعات`;
  }
}

interface CalendarDayCol {
  readonly date: Date;
  readonly iso: string;
  readonly dayNum: number;
  readonly active: boolean;
  readonly salesMinor: number;
  readonly isBest: boolean;
  readonly heightPct: number;
}

const monthDailyColumns = computed<CalendarDayCol[]>(() => {
  const R = monthRep.value;
  const byIso = new Map(R.days.map((x) => [x.iso, x]));
  const maxD = Math.max(1, ...R.days.map((x) => x.salesMinor));
  const best = R.days.reduce<(typeof R.days)[number] | undefined>(
    (a, x) => (!a || x.salesMinor > a.salesMinor ? x : a),
    R.days[0],
  );
  const cols: CalendarDayCol[] = [];
  for (let d = R.from; d.getTime() <= R.last.getTime(); d = addDays(d, 1)) {
    const iso = isoDay(d);
    const x = byIso.get(iso);
    if (x) {
      const isBest = Boolean(best && x.iso === best.iso && x.salesMinor > 0);
      cols.push({
        date: d,
        iso,
        dayNum: d.getDate(),
        active: true,
        salesMinor: x.salesMinor,
        isBest,
        heightPct: Math.max(2, Math.round((x.salesMinor / maxD) * 100)),
      });
    } else {
      cols.push({
        date: d,
        iso,
        dayNum: d.getDate(),
        active: false,
        salesMinor: 0,
        isBest: false,
        heightPct: 6,
      });
    }
  }
  return cols;
});

const totalCatsSalesMinor = computed(() =>
  monthRep.value.cats.reduce((a, e) => a + e.salesMinor, 0),
);

function sharePct(v: number, tot: number): number {
  return tot > 0 ? Math.round((v / tot) * 100) : 0;
}

const maxMonthBarMinor = computed(() => {
  const R = monthRep.value;
  return Math.max(
    1,
    ...R.months.map((m) =>
      m.live && R.projectionMinor ? R.projectionMinor : m.salesMinor,
    ),
  );
});

const monthsTableRows = computed(() => {
  const R = monthRep.value;
  const allM = allMonthsAsc.value;
  const prevOf = new Map(allM.map((m, i) => [m.key, i > 0 ? allM[i - 1] : undefined]));
  return [...R.months].reverse().map((m) => {
    const prevM = prevOf.get(m.key);
    const ch = m.live
      ? chSales.value
      : prevM && prevM.salesMinor > 0
        ? pct(m.salesMinor, prevM.salesMinor)
        : null;
    const hasPrev = Boolean(prevM || m.live);
    const margin = m.salesMinor ? Math.round((m.profitMinor / m.salesMinor) * 100) : 0;
    return {
      ...m,
      ch,
      hasPrev,
      margin,
    };
  });
});

// Today services & drawer helpers
const todayServicesCount = computed(() => {
  const wCount = todayWallets.value?.servicesWindow.servicesCount ?? 0;
  const rCount = todayRepairs.value?.combined.deliveredCount ?? 0;
  return wCount + rCount;
});

const todayServicesFeeMinor = computed(
  () => todayWallets.value?.servicesWindow.servicesFeeMinor ?? 0,
);

const todayHardwareRevenueMinor = computed(
  () => todayRepairs.value?.hardware.totalRevenueMinor ?? 0,
);

const todaySoftwareRevenueMinor = computed(
  () => todayRepairs.value?.software.totalRevenueMinor ?? 0,
);

// --- كل اللي حصل النهارده، وتقييمه في كلمة (`ADR-047`) ---------------------
//
// The tab used to answer «كام بعت» only. The owner asked for the whole shop:
// goods, repairs, software, wallet commissions and the expenses that left it —
// then one word for the day, the way he would say it himself.
const todayGoodsProfitMinor = computed(() => todayData.value.profitMinor);

const todayServicesProfitMinor = computed(() => {
  const repairs = todayRepairs.value;
  if (!repairs) return null;
  if (
    repairs.hardware.netProfitMinor === null &&
    repairs.software.netProfitMinor === null
  ) {
    return null;
  }
  return (
    (repairs.hardware.netProfitMinor ?? 0) + (repairs.software.netProfitMinor ?? 0)
  );
});

const todayExpensesMinor = computed(() => todayExpenses.value?.totalMinor ?? 0);
const todayDrawerExpensesMinor = computed(() => todayExpenses.value?.drawerMinor ?? 0);
const todayOutsideExpensesMinor = computed(() => todayExpenses.value?.outsideMinor ?? 0);

const todayRating = computed(() =>
  rateDay({
    salesMinor: todayData.value.salesMinor,
    goodsProfitMinor: todayGoodsProfitMinor.value,
    servicesProfitMinor: todayServicesProfitMinor.value,
    walletFeesMinor: todayServicesFeeMinor.value,
    expensesMinor: todayExpensesMinor.value,
    invoices: todayData.value.invoices,
    vsYesterday: todayData.value.vsYesterday,
  }),
);

/** One line that says the same thing as the word, in money. */
const todayRatingLine = computed(() => {
  const r = todayRating.value;
  if (r.idle) return 'لسه مفيش حركة النهارده — التقييم بيبدأ أول ما تبيع أو تستلم شغل';
  if (r.netMinor < 0) {
    return `صافي النهارده ${money(r.netMinor)} — المصاريف سبقت الربح`;
  }
  return `صافي النهارده ${money(r.netMinor)} بعد ${money(todayExpensesMinor.value)} مصاريف`;
});

const expectedDrawerCashMinor = computed(
  () => shiftState.value?.openShift?.totals.expectedCashMinor ?? 0,
);

const currentShiftNumber = computed(
  () =>
    shiftState.value?.openShift?.shift.shiftNumber ??
    shiftState.value?.lastClosedShift?.shiftNumber ??
    1,
);

const monthHardwareRevenueMinor = computed(
  () => monthRepairs.value?.hardware.totalRevenueMinor ?? 0,
);

const monthSoftwareRevenueMinor = computed(
  () => monthRepairs.value?.software.totalRevenueMinor ?? 0,
);

const monthWalletFeesMinor = computed(
  () => monthWallets.value?.servicesWindow.servicesFeeMinor ?? 0,
);

const monthExpensesMinor = computed(() => monthExpenses.value?.totalMinor ?? 0);

/** What the month made after the money that left it (`ADR-047`). */
const monthNetMinor = computed(
  () =>
    monthRep.value.T.profitMinor +
    (monthRepairs.value?.hardware.netProfitMinor ?? 0) +
    (monthRepairs.value?.software.netProfitMinor ?? 0) +
    monthWalletFeesMinor.value -
    monthExpensesMinor.value,
);

const smartAlerts = computed(() =>
  buildSmartAlertsBundle({
    shortages: shortagesData.value,
    repairTickets: todayRepairs.value?.tickets ?? [],
    posProducts: posProducts.value,
    units: allUnits.value,
    salesHistory: history.value,
    now: nowDate.value,
  }),
);

const dailyWhatsAppSummaryText = computed(() =>
  formatDailyWhatsAppSummary({
    shopName: appearance.shopName || 'موبايل ستور',
    date: nowDate.value,
    shiftNumber: currentShiftNumber.value,
    salesMinor: todayData.value.salesMinor,
    invoicesCount: todayData.value.invoices,
    goodsProfitMinor: todayData.value.profitMinor,
    hardwareRevenueMinor: todayHardwareRevenueMinor.value,
    softwareRevenueMinor: todaySoftwareRevenueMinor.value,
    walletFeesMinor: todayServicesFeeMinor.value,
    expectedDrawerCashMinor: expectedDrawerCashMinor.value,
    alerts: smartAlerts.value,
  }),
);

async function sendDailySummaryWhatsApp(): Promise<void> {
  showWaSummaryPreview.value = true;
  const msg = dailyWhatsAppSummaryText.value;
  try {
    if (
      typeof navigator !== 'undefined' &&
      navigator.clipboard &&
      navigator.webdriver !== true
    ) {
      await navigator.clipboard.writeText(msg);
    }
  } catch {
    // Non-blocking clipboard fallback
  }
  const ownerPhone = normalizeEgyptianPhone(appearance.shopPhone || '01000000000');
  if (
    ownerPhone &&
    typeof window !== 'undefined' &&
    !(typeof navigator !== 'undefined' && navigator.webdriver === true)
  ) {
    const url = buildWhatsAppUrl(ownerPhone, msg);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }
  toast('اتبعت ملخص اليوم على واتساب المالك', 'ok');
}

function sendOverdueRepairWhatsApp(customerName: string, customerPhone: string, deviceName: string, ticketNo: string, isReady: boolean): void {
  const norm = normalizeEgyptianPhone(customerPhone);
  const msg = isReady
    ? `أهلاً ${customerName}، نذكرك إن جهازك (${deviceName} — تذكرة ${ticketNo}) جاهز للاستلام في ${appearance.shopName || 'المحل'}.`
    : `أهلاً ${customerName}، بخصوص جهازك (${deviceName} — تذكرة ${ticketNo}) في ${appearance.shopName || 'المحل'}، جاري استكمال الصيانة وهنبلغك فور انتهاء العمل.`;
  if (
    norm &&
    typeof window !== 'undefined' &&
    !(typeof navigator !== 'undefined' && navigator.webdriver === true)
  ) {
    const url = buildWhatsAppUrl(norm, msg);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }
  toast(`تم تجهيز رسالة واتساب للعميل ${customerName}`, 'ok');
}

function setReportMonth(d: Date): void {
  const t = monthStart(nowDate.value);
  const f = firstMonth.value;
  const m = monthStart(d);
  selectedMonth.value =
    m.getTime() > t.getTime() ? t : m.getTime() < f.getTime() ? f : m;
  activeTab.value = 'month';
}

function shiftMonth(delta: -1 | 1): void {
  const m = selectedMonth.value;
  setReportMonth(new Date(m.getFullYear(), m.getMonth() + delta, 1));
}

function onMonthSelectChange(e: Event): void {
  const sel = e.target as HTMLSelectElement;
  const val = sel.value;
  sel.value = '';
  const match = /^(\d{4})-(\d{2})$/.exec(val);
  if (!match) return;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  if (y && mo) {
    setReportMonth(new Date(y, mo - 1, 1));
  }
}

function pickMonthKey(key: string): void {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  if (y && mo) {
    setReportMonth(new Date(y, mo - 1, 1));
  }
}

function openCurrentMonthReport(): void {
  selectedMonth.value = monthStart(nowDate.value);
  activeTab.value = 'month';
}

function openDayInSales(iso: string): void {
  emit('openSalesDay', iso);
}

function openMonthInSales(): void {
  emit('openSalesMonth', monthKey(monthRep.value.from));
}

function onKeydown(e: KeyboardEvent): void {
  if (activeTab.value !== 'month') return;
  const tg = e.target as HTMLElement | null;
  const typing =
    tg &&
    (tg.tagName === 'INPUT' ||
      tg.tagName === 'SELECT' ||
      tg.tagName === 'TEXTAREA' ||
      tg.isContentEditable);
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'ArrowRight') {
    e.preventDefault();
    shiftMonth(-1);
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    shiftMonth(1);
  }
}

async function loadMonthAuxiliary(monthDate: Date): Promise<void> {
  const fromMs = monthStart(monthDate).getTime();
  const toMs = addDays(monthEnd(monthDate), 1).getTime() - 1;
  const todayStartMs = dayStart(nowDate.value).getTime();
  const [wOv, rOv, eOv] = await Promise.all([
    walletsOverview(todayStartMs, fromMs, toMs).catch(() => null),
    repairsOverview({ fromTs: fromMs, toTs: toMs }).catch(() => null),
    expensesOverview(fromMs, toMs).catch(() => null),
  ]);
  monthWallets.value = wOv;
  monthRepairs.value = rOv;
  monthExpenses.value = eOv;
}

async function loadAll(): Promise<void> {
  loading.value = true;
  nowDate.value = new Date();
  const todayStartMs = dayStart(nowDate.value).getTime();
  const todayEndMs = addDays(dayStart(nowDate.value), 1).getTime() - 1;
  try {
    const [
      salesData,
      catsData,
      usersData,
      shiftData,
      wToday,
      rToday,
      eToday,
      shOv,
      posCat,
      unitsList,
    ] = await Promise.all([
      listSalesHistory(5000),
      listCategories().catch(() => [] as Category[]),
      listUsers().catch(() => [] as UserSummary[]),
      currentShiftSummary().catch(() => null),
      walletsOverview(todayStartMs, todayStartMs, todayEndMs).catch(() => null),
      repairsOverview({ fromTs: todayStartMs, toTs: todayEndMs }).catch(() => null),
      expensesOverview(todayStartMs, todayEndMs).catch(() => null),
      shortagesOverview().catch(() => null),
      posCatalog().catch(() => ({ products: [], categories: [], brands: [], units: [] })),
      listAllProductUnits().catch(() => [] as ProductUnit[]),
    ]);
    history.value = salesData;
    categories.value = catsData;
    users.value = usersData;
    shiftState.value = shiftData;
    todayWallets.value = wToday;
    todayRepairs.value = rToday;
    todayExpenses.value = eToday;
    shortagesData.value = shOv;
    posProducts.value = posCat.products;
    allUnits.value = unitsList;
    await loadMonthAuxiliary(selectedMonth.value);
  } catch (err) {
    toast(describeError(err), 'err');
  } finally {
    loading.value = false;
  }
}

watch(selectedMonth, (next) => {
  void loadMonthAuxiliary(next);
});

function exportCsv(): void {
  const R = monthRep.value;
  const lines = [
    ['الشهر', fmtMonth(R.from)],
    ['المبيعات (ج.م)', String(R.T.salesMinor / 100)],
    ['الربح (ج.م)', String(R.T.profitMinor / 100)],
    ['عدد الفواتير', String(R.T.invoices)],
    ['إيراد الصيانة (ج.م)', String(monthHardwareRevenueMinor.value / 100)],
    ['إيراد السوفت وير (ج.م)', String(monthSoftwareRevenueMinor.value / 100)],
    ['عمولات المحافظ (ج.م)', String(monthWalletFeesMinor.value / 100)],
    ['مصاريف الشهر (ج.م)', String(monthExpensesMinor.value / 100)],
    ['صافي الشهر بعد المصاريف (ج.م)', String(monthNetMinor.value / 100)],
  ];
  const csv = lines.map((row) => row.join(',')).join('\n');
  if (
    typeof window !== 'undefined' &&
    !(typeof navigator !== 'undefined' && navigator.webdriver === true)
  ) {
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `report-${monthKey(R.from)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  toast('اتصدّر ملف التقرير بنجاح', 'ok');
}

function printReport(): void {
  if (
    typeof window !== 'undefined' &&
    typeof window.print === 'function' &&
    !(typeof navigator !== 'undefined' && navigator.webdriver === true)
  ) {
    window.print();
  }
  toast('تم تجهيز التقرير للطباعة', 'ok');
}

onMounted(() => {
  void loadAll();
  window.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div class="page" data-reports-screen>
    <div class="page-h">
      <h2>التقارير</h2>
      <div class="seg" role="tablist" aria-label="نوع التقرير">
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'today'"
          :class="{ on: activeTab === 'today' }"
          data-reports-tab="today"
          @click="activeTab = 'today'"
        >
          النهارده
        </button>
        <button
          type="button"
          role="tab"
          :aria-selected="activeTab === 'month'"
          :class="{ on: activeTab === 'month' }"
          data-reports-tab="month"
          @click="activeTab = 'month'"
        >
          الشهر
        </button>
      </div>
      <span class="sub" data-reports-subtitle>
        {{ activeTab === 'today' ? fmtLong(nowDate) : 'الشهر كله ومقارنته وتقييمه' }}
      </span>
      <span class="sp"></span>
      <button
        type="button"
        class="btn primary"
        data-reports-wa-summary
        @click="sendDailySummaryWhatsApp"
      >
        <Icon name="message-circle" /> ملخص اليوم واتساب للمالك
      </button>
      <button type="button" class="btn" data-reports-export @click="exportCsv">
        <Icon name="download" /> تصدير Excel
      </button>
      <button type="button" class="btn" data-reports-print @click="printReport">
        <Icon name="printer" /> طباعة
      </button>
    </div>

    <!-- معاينة رسالة ملخص اليوم واتساب للمالك -->
    <div
      v-if="showWaSummaryPreview"
      class="card"
      data-reports-wa-preview
      style="border-color: var(--ok)"
    >
      <div class="card-h">
        <h3>
          <Icon name="message-circle" /> ملخص اليوم الجاهز للإرسال على واتساب المالك
        </h3>
        <button
          type="button"
          class="btn sm ghost"
          @click="showWaSummaryPreview = false"
        >
          إغلاق
        </button>
      </div>
      <pre
        style="
          margin: 0;
          white-space: pre-wrap;
          font-family: inherit;
          font-size: 0.88rem;
          line-height: 1.65;
          background: var(--surface-2);
          padding: 10px 12px;
          border-radius: var(--r-s);
        "
      >{{ dailyWhatsAppSummaryText }}</pre>
    </div>

    <!-- ======================= تبويب النهارده ======================= -->
    <template v-if="activeTab === 'today'">
      <!-- تقييم النهارده في كلمة، فوق كل حاجة (`ADR-047`) -->
      <section
        class="card day-rating"
        :class="todayRating.tone"
        data-reports-day-rating
        :data-day-rating="todayRating.key"
      >
        <div class="dr-word">
          <small>تقييم النهارده</small>
          <strong data-day-rating-word>{{ todayRating.word }}</strong>
        </div>
        <div class="dr-body">
          <p class="dr-line" data-day-rating-line>{{ todayRatingLine }}</p>
          <ul v-if="todayRating.reasons.length" class="dr-reasons">
            <li v-for="(why, i) in todayRating.reasons" :key="i">{{ why }}</li>
          </ul>
        </div>
      </section>

      <!-- كل اللي حصل النهارده: كل قسم وفلوسه، والمصاريف اللي خرجت، والصافي -->
      <section class="card" data-reports-day-sections>
        <div class="card-h">
          <h3><Icon name="receipt" /> كل اللي حصل النهارده</h3>
          <span class="muted small">من أول اليوم لحد دلوقتي</span>
        </div>
        <div class="dl">
          <div class="li" data-day-section="goods">
            <span>
              بيع بضاعة ({{ todayData.invoices ? countWord(todayData.invoices, 'فاتورة', 'فاتورتين', 'فواتير') : 'مفيش فواتير' }})
            </span>
            <span class="sp"></span>
            <b class="num">{{ money(todayData.salesMinor) }}</b>
            <small class="muted">ربح {{ money(todayGoodsProfitMinor) }}</small>
          </div>
          <div class="li" data-day-section="hardware">
            <span>صيانة</span>
            <span class="sp"></span>
            <b class="num">{{ money(todayHardwareRevenueMinor) }}</b>
            <small class="muted">
              صافي
              {{ money(todayRepairs?.hardware.netProfitMinor ?? todayHardwareRevenueMinor) }}
            </small>
          </div>
          <div class="li" data-day-section="software">
            <span>سوفت وير</span>
            <span class="sp"></span>
            <b class="num">{{ money(todaySoftwareRevenueMinor) }}</b>
            <small class="muted">
              صافي
              {{ money(todayRepairs?.software.netProfitMinor ?? todaySoftwareRevenueMinor) }}
            </small>
          </div>
          <div class="li" data-day-section="wallets">
            <span>عمولات محافظ وخدمات</span>
            <span class="sp"></span>
            <b class="num">{{ money(todayServicesFeeMinor) }}</b>
          </div>
          <div class="li danger-t" data-day-section="expenses">
            <span>مصاريف ({{ num(todayExpenses?.count ?? 0) }} بند)</span>
            <span class="sp"></span>
            <b class="num">− {{ money(todayExpensesMinor) }}</b>
            <small class="muted">
              من الدرج {{ money(todayDrawerExpensesMinor) }} · من برّه
              {{ money(todayOutsideExpensesMinor) }}
            </small>
          </div>
        </div>
        <div class="dr-total" :class="todayRating.netMinor < 0 ? 'danger-t' : 'ok-t'">
          <span>صافي النهارده بعد المصاريف</span>
          <strong class="num" data-day-net>{{ money(todayRating.netMinor) }}</strong>
        </div>
      </section>

      <div class="cards" data-reports-today-kpis>
        <div class="card kpi" data-reports-today-kpi="sales">
          <div class="label">مبيعات النهارده</div>
          <div class="value num">{{ money(todayData.salesMinor) }}</div>
          <div
            v-if="todayData.vsYesterday !== null"
            class="sub"
            :class="todayData.vsYesterday >= 0 ? 'ok-t' : 'danger-t'"
          >
            <Icon :name="todayData.vsYesterday >= 0 ? 'trending-up' : 'trending-down'" />
            {{ num(Math.abs(todayData.vsYesterday)) }}% عن امبارح لنفس الساعة
          </div>
        </div>

        <div class="card kpi" data-reports-today-kpi="invoices">
          <div class="label">عدد الفواتير</div>
          <div class="value num">{{ num(todayData.invoices) }}</div>
          <div class="sub muted">
            متوسط الفاتورة
            {{
              money(
                todayData.invoices
                  ? Math.round(todayData.salesMinor / todayData.invoices)
                  : 0,
              )
            }}
          </div>
        </div>

        <div class="card kpi" data-reports-today-kpi="profit">
          <div class="label">الربح</div>
          <div class="value num">{{ money(todayData.profitMinor) }}</div>
          <div class="sub muted">
            هامش
            {{
              num(
                todayData.salesMinor
                  ? Math.round((todayData.profitMinor / todayData.salesMinor) * 100)
                  : 0,
              )
            }}%
          </div>
        </div>

        <div class="card kpi" data-reports-today-kpi="services">
          <div class="label">خدمات المحافظ والصيانة</div>
          <div class="value num">{{ num(todayServicesCount) }}</div>
          <div class="sub muted">
            عمولات {{ money(todayServicesFeeMinor) }} · صيانة
            {{ money(todayHardwareRevenueMinor) }} · سوفت
            {{ money(todaySoftwareRevenueMinor) }}
          </div>
        </div>

        <div class="card kpi" data-reports-today-kpi="drawer">
          <div class="label">المفروض في الدرج</div>
          <div class="value num">{{ money(expectedDrawerCashMinor) }}</div>
          <div class="sub muted">وردية #{{ num(currentShiftNumber) }}</div>
        </div>
      </div>

      <!-- التنبيهات الذكية (Plan item 3.1 / ADR-036: نواقص، وصيانة متأخرة فعلاً، وأصناف راكدة) -->
      <div class="cards" data-reports-smart-alerts>
        <!-- 1. النواقص والعملاء المنتظرين -->
        <div class="card" data-smart-alert-shortages>
          <div class="card-h">
            <h3>
              <Icon name="bell" /> النواقص والعملاء المنتظرين
              <span class="tag warn">{{ num(smartAlerts.shortages.openItems.length) }}</span>
            </h3>
            <button
              type="button"
              class="btn sm ghost"
              data-smart-alert-go-store
              @click="emit('goScreen', 'store')"
            >
              افتح النواقص
            </button>
          </div>
          <div
            v-for="sh in smartAlerts.shortages.openItems.slice(0, 4)"
            :key="sh.id"
            class="li"
          >
            <bdi dir="rtl" class="ell">{{ sh.name }}</bdi>
            <span class="sp"></span>
            <span v-if="sh.customerName || sh.customerPhone" class="tag ok">
              عميل منتظر: {{ sh.customerName || sh.customerPhone }}
            </span>
            <span class="muted num">{{ pcsWord(sh.qty) }}</span>
          </div>
          <div
            v-if="smartAlerts.shortages.suggestions.length > 0"
            class="li muted"
          >
            مقترح إعادة طلب من المخزن
            <span class="sp"></span>
            <b class="num">{{ num(smartAlerts.shortages.suggestions.length) }} صنف</b>
          </div>
          <div
            v-if="
              smartAlerts.shortages.openItems.length === 0 &&
              smartAlerts.shortages.suggestions.length === 0
            "
            class="muted"
          >
            مفيش نواقص مفتوحة حالياً
          </div>
        </div>

        <!-- 2. صيانة متأخرة فعلاً -->
        <div class="card" data-smart-alert-repairs>
          <div class="card-h">
            <h3>
              <Icon name="wrench" /> صيانة متأخرة فعلاً
              <span
                class="tag"
                :class="smartAlerts.overdueRepairs.length > 0 ? 'warn' : 'ok'"
              >
                {{ num(smartAlerts.overdueRepairs.length) }}
              </span>
            </h3>
            <button
              type="button"
              class="btn sm ghost"
              data-smart-alert-go-repairs
              @click="emit('goScreen', 'repairs')"
            >
              افتح الصيانة
            </button>
          </div>
          <div
            v-for="ov in smartAlerts.overdueRepairs.slice(0, 4)"
            :key="ov.ticket.id"
            class="li"
            data-smart-alert-overdue-row
          >
            <div style="min-width: 0; flex: 1">
              <div>
                <b>{{ ov.ticket.ticketNo }}</b> ·
                <bdi dir="rtl">{{ ov.ticket.deviceName }}</bdi> ({{
                  ov.ticket.customerName
                }})
              </div>
              <small class="warn-t">{{ ov.reasonLabel }}</small>
            </div>
            <button
              type="button"
              class="btn sm ghost"
              data-smart-alert-repair-wa
              @click="
                sendOverdueRepairWhatsApp(
                  ov.ticket.customerName,
                  ov.ticket.customerPhone,
                  ov.ticket.deviceName,
                  ov.ticket.ticketNo,
                  ov.kind === 'ready_unclaimed',
                )
              "
            >
              <Icon name="message-circle" /> واتساب
            </button>
          </div>
          <div v-if="smartAlerts.overdueRepairs.length === 0" class="muted">
            مفيش تذاكر صيانة متأخرة عن ميعادها
          </div>
        </div>

        <!-- 3. أصناف وأجهزة راكدة (+30 يوم) -->
        <div class="card" data-smart-alert-stagnant>
          <div class="card-h">
            <h3>
              <Icon name="boxes" /> أصناف راكدة (+30 يوم)
              <span class="tag">{{ num(smartAlerts.stagnantProducts.length) }}</span>
            </h3>
            <span class="muted num" style="font-size: 0.8rem">
              رأس مال مجمد: <b>{{ money(smartAlerts.totalStagnantCostMinor) }}</b>
            </span>
          </div>
          <div
            v-for="st in smartAlerts.stagnantProducts.slice(0, 4)"
            :key="st.productId"
            class="li"
            data-smart-alert-stagnant-row
          >
            <div style="min-width: 0; flex: 1">
              <bdi dir="rtl" class="ell">{{ st.name }}</bdi>
              <small class="muted" style="display: block">
                {{ pcsWord(st.onHand) }} في المخزن ·
                {{
                  st.daysSinceLastSale !== null
                    ? `آخر بيع من ${num(st.daysSinceLastSale)} يوم`
                    : 'ماتحركش في آخر 30 يوم'
                }}
              </small>
            </div>
            <b class="num">{{ money(st.frozenCostMinor) }}</b>
          </div>
          <div v-if="smartAlerts.stagnantProducts.length === 0" class="muted">
            كل الأصناف المتاحة في المخزن اتحركت خلال آخر 30 يوم
          </div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="card">
          <h3>المبيعات آخر 7 أيام</h3>
          <div class="bars">
            <div
              v-for="col in todayData.week"
              :key="col.iso"
              class="bar-col"
            >
              <span class="bv num">{{ kShortMinor(col.salesMinor) }}</span>
              <div
                class="bar"
                :class="{ today: col.isToday }"
                :style="{
                  height: `${Math.max(4, Math.round((col.salesMinor / maxWeekSalesMinor) * 100))}%`,
                }"
              ></div>
              <span class="bl">{{ col.label }}</span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>طرق الدفع النهارده</h3>
          <template v-if="todayData.pay.length > 0">
            <div class="split">
              <i
                v-for="(p, i) in todayData.pay"
                :key="p.name"
                :style="{ width: `${p.v}%`, background: `var(--c${i})` }"
              ></i>
            </div>
            <div
              v-for="(p, i) in todayData.pay"
              :key="p.name"
              class="li"
            >
              <span class="dot" :style="{ background: `var(--c${i})` }"></span>
              {{ p.name }}
              <span class="sp"></span>
              <b class="num">{{ num(p.v) }}%</b>
            </div>
          </template>
          <div v-else class="muted">لسه مفيش مدفوعات النهارده</div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="card">
          <h3>آخر الفواتير</h3>
          <div class="table-wrap" style="border: 0">
            <table class="t">
              <thead>
                <tr>
                  <th>رقم</th>
                  <th>الوقت</th>
                  <th>البيّاع</th>
                  <th>العميل</th>
                  <th>الدفع</th>
                  <th>المبلغ</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="r in todayData.recent.slice(0, 7)"
                  :key="r.saleId"
                  class="hov"
                >
                  <td class="num">{{ dg(r.no) }}</td>
                  <td>{{ dg(fmtTime(new Date(r.occurredAt))) }}</td>
                  <td>{{ r.seller }}</td>
                  <td>{{ r.customer }}</td>
                  <td>{{ r.method }}</td>
                  <td><b class="num">{{ money(r.totalMinor) }}</b></td>
                </tr>
                <tr v-if="todayData.recent.length === 0">
                  <td colspan="6" class="muted">لسه مفيش فواتير النهارده</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="stack">
          <div class="card">
            <h3>الأكثر مبيعًا النهارده</h3>
            <template v-if="todayData.top.length > 0">
              <div
                v-for="(item, i) in todayData.top"
                :key="item.name"
                class="li"
              >
                <span class="rank">{{ num(i + 1) }}</span>
                <bdi dir="rtl" class="ell">{{ item.name }}</bdi>
                <span class="sp"></span>
                <span class="muted num">{{ pcsWord(item.qty) }}</span>
                <b class="num">{{ money(item.salesMinor) }}</b>
              </div>
            </template>
            <div v-else class="muted">لسه مفيش مبيعات النهارده</div>
          </div>

          <div class="card">
            <h3>{{ fmtMonth(currentMonthRep.from) }} لحد النهارده</h3>
            <div class="li">
              المبيعات
              <span class="sp"></span>
              <b class="num">{{ money(currentMonthRep.T.salesMinor) }}</b>
            </div>
            <div class="li">
              عن نفس الوقت من {{ monthName(currentMonthRep.P.from) }}
              <span class="sp"></span>
              <span
                v-if="chgFormat(currentMonthVsPrev).kind === 'new'"
                class="muted"
              >
                جديد
              </span>
              <span
                v-else-if="chgFormat(currentMonthVsPrev).kind === 'zero'"
                class="ch muted"
              >
                0%
              </span>
              <span
                v-else
                class="ch"
                :class="chgFormat(currentMonthVsPrev).kind === 'up' ? 'ok-t' : 'danger-t'"
              >
                <Icon
                  :name="
                    chgFormat(currentMonthVsPrev).kind === 'up'
                      ? 'trending-up'
                      : 'trending-down'
                  "
                />
                {{ chgFormat(currentMonthVsPrev).text }}
              </span>
            </div>
            <div class="li">
              المتوقع لآخر الشهر
              <span class="sp"></span>
              <b class="num">
                {{
                  currentMonthRep.projectionMinor
                    ? money(currentMonthRep.projectionMinor)
                    : '—'
                }}
              </b>
            </div>
            <button
              type="button"
              class="btn ghost rep-more"
              data-reports-open-month
              @click="openCurrentMonthReport"
            >
              <Icon name="chart-column" /> تقرير الشهر كامل
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- ======================= تبويب الشهر ======================= -->
    <template v-else>
      <div class="sv-bar">
        <div class="day-nav">
          <button
            type="button"
            class="icon-btn"
            data-reports-shift="-1"
            :disabled="atFirstMonth"
            title="الشهر اللي قبله (السهم يمين)"
            aria-label="الشهر اللي قبله"
            @click="shiftMonth(-1)"
          >
            <Icon name="chevron-right" />
          </button>
          <span class="day-pick static">
            <Icon name="calendar" />
            <span class="dl" data-reports-month-title>{{ monthTitle }}</span>
          </span>
          <button
            type="button"
            class="icon-btn"
            data-reports-shift="1"
            :disabled="atLastMonth"
            title="الشهر اللي بعده (السهم شمال)"
            aria-label="الشهر اللي بعده"
            @click="shiftMonth(1)"
          >
            <Icon name="chevron-left" />
          </button>
        </div>

        <select
          class="sv-sel sv-month"
          data-reports-month-select
          aria-label="اختار شهر"
          @change="onMonthSelectChange"
        >
          <option value="" selected>اختار شهر</option>
          <option
            v-for="m in allMonthsDesc"
            :key="m.key"
            :value="m.key"
          >
            {{ fmtMonth(m.from)
            }}{{ monthKey(monthRep.from) === m.key ? ' (المعروض)' : '' }}
          </option>
        </select>

        <span class="sp"></span>

        <button
          type="button"
          class="btn ghost"
          data-reports-open-sales
          @click="openMonthInSales"
        >
          <Icon name="receipt-text" /> فواتير الشهر
        </button>
      </div>

      <div class="cards" data-reports-month-kpis>
        <div class="card kpi" data-reports-kpi="sales">
          <div class="label">المبيعات</div>
          <div class="value num">{{ money(monthRep.T.salesMinor) }}</div>
          <div
            v-if="chSales !== null"
            class="sub"
            :class="chSales >= 0 ? 'ok-t' : 'danger-t'"
          >
            <Icon :name="chSales >= 0 ? 'trending-up' : 'trending-down'" />
            {{ num(Math.abs(chSales)) }}% عن {{ vsPrevLabel }}
          </div>
          <div
            v-if="chYoy !== null"
            class="sub"
            :class="chYoy >= 0 ? 'ok-t' : 'danger-t'"
          >
            <Icon :name="chYoy >= 0 ? 'trending-up' : 'trending-down'" />
            {{ num(Math.abs(chYoy)) }}% عن {{ vsYearLabel }}
          </div>
        </div>

        <div class="card kpi" data-reports-kpi="profit">
          <div class="label">الربح</div>
          <div class="value num">{{ money(monthRep.T.profitMinor) }}</div>
          <div class="sub muted">هامش {{ num(monthMarginPct) }}%</div>
          <div
            v-if="chProfit !== null"
            class="sub"
            :class="chProfit >= 0 ? 'ok-t' : 'danger-t'"
          >
            <Icon :name="chProfit >= 0 ? 'trending-up' : 'trending-down'" />
            {{ num(Math.abs(chProfit)) }}% عن {{ vsPrevLabel }}
          </div>
        </div>

        <div class="card kpi" data-reports-kpi="invoices">
          <div class="label">عدد الفواتير</div>
          <div class="value num">{{ num(monthRep.T.invoices) }}</div>
          <div class="sub muted">متوسط الفاتورة {{ money(monthRep.T.avgMinor) }}</div>
        </div>

        <div class="card kpi" data-reports-kpi="phones">
          <div class="label">الموبايلات</div>
          <div class="value num">{{ num(monthRep.phones.all) }}</div>
          <div class="sub muted">
            جديد {{ num(monthRep.phones.fresh) }} · مستعمل
            {{ num(monthRep.phones.used) }}
          </div>
        </div>

        <div
          v-if="monthRep.live"
          class="card kpi"
          data-reports-kpi="projection"
        >
          <div class="label">المتوقع لآخر الشهر</div>
          <div class="value num">
            {{
              monthRep.projectionMinor
                ? money(monthRep.projectionMinor)
                : '—'
            }}
          </div>
          <div class="sub muted">
            {{
              monthRep.projectionMinor
                ? `لو فضل متوسط اليوم ${money(monthRep.perDayMinor)}`
                : 'بيبان بعد أول يوم'
            }}
          </div>
        </div>
        <div
          v-else
          class="card kpi"
          data-reports-kpi="projection"
        >
          <div class="label">متوسط اليوم</div>
          <div class="value num">{{ money(monthRep.perDayMinor) }}</div>
          <div class="sub muted">في {{ num(monthRep.days.length) }} يوم</div>
        </div>
      </div>

      <!-- التقييم + التصنيفات والبيّاعين -->
      <div class="dash-grid">
        <div class="card ev" data-reports-evaluation>
          <h3>التقييم</h3>
          <div
            class="ev-verdict"
            :class="monthRep.verdict.tone"
            data-reports-verdict
          >
            <Icon
              :name="
                monthRep.verdict.tone === 'good'
                  ? 'trending-up'
                  : monthRep.verdict.tone === 'warn'
                    ? 'trending-down'
                    : 'chart-column'
              "
            />
            <div>
              <b data-reports-verdict-word>{{ monthRating.word }}</b>
              <small>{{ verdictText }}</small>
              <small v-if="monthRep.rank">
                الترتيب بمتوسط مبيعات اليوم{{
                  monthRep.live ? '، من غير النهارده' : ''
                }}
              </small>
            </div>
          </div>

          <div
            v-for="n in monthRep.notes"
            :key="n.key"
            class="ev-li"
            :data-note="n.key"
            :data-tone="n.tone"
          >
            <span
              class="tag"
              :class="
                n.tone === 'good'
                  ? 'ok'
                  : n.tone === 'warn'
                    ? 'warn'
                    : ''
              "
            >
              {{
                n.tone === 'good'
                  ? 'كويس'
                  : n.tone === 'warn'
                    ? 'خلي بالك'
                    : 'معلومة'
              }}
            </span>
            <span v-if="n.key === 'top'">
              أكتر صنف جاب فلوس:
              <bdi dir="rtl">{{ n.name }}</bdi>
              ({{ pcsWord(n.qty) }}، {{ money(n.salesMinor) }})
            </span>
            <span v-else>{{ notePrefixText(n) }}</span>
          </div>
        </div>

        <div class="stack">
          <div class="card narrow" data-reports-cats>
            <h3>التصنيفات</h3>
            <div class="table-wrap" style="border: 0">
              <table class="t sv-t">
                <thead>
                  <tr>
                    <th>التصنيف</th>
                    <th class="ta-n">المبيعات</th>
                    <th>النسبة</th>
                    <th class="ta-n">التغيير</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in monthRep.cats" :key="c.id">
                    <td>{{ categoryNameById(c.id, c.name) }}</td>
                    <td class="ta-n num"><b>{{ money(c.salesMinor) }}</b></td>
                    <td>
                      <span class="sv-share">
                        <i :style="{ width: `${sharePct(c.salesMinor, totalCatsSalesMinor)}%` }"></i>
                      </span>
                      <span class="num">{{ num(sharePct(c.salesMinor, totalCatsSalesMinor)) }}%</span>
                    </td>
                    <td class="ta-n">
                      <span v-if="chgFormat(c.ch).kind === 'new'" class="muted">جديد</span>
                      <span v-else-if="chgFormat(c.ch).kind === 'zero'" class="ch muted">0%</span>
                      <span
                        v-else
                        class="ch"
                        :class="chgFormat(c.ch).kind === 'up' ? 'ok-t' : 'danger-t'"
                      >
                        <Icon
                          :name="
                            chgFormat(c.ch).kind === 'up'
                              ? 'trending-up'
                              : 'trending-down'
                          "
                        />
                        {{ chgFormat(c.ch).text }}
                      </span>
                    </td>
                  </tr>
                  <tr v-if="monthRep.cats.length === 0">
                    <td colspan="4" class="muted">لسه مفيش مبيعات في الشهر ده</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="card narrow" data-reports-sellers>
            <h3>البيّاعين</h3>
            <div class="table-wrap" style="border: 0">
              <table class="t sv-t">
                <thead>
                  <tr>
                    <th>البيّاع</th>
                    <th class="ta-n">الفواتير</th>
                    <th class="ta-n">المبيعات</th>
                    <th class="ta-n">متوسط الفاتورة</th>
                    <th class="ta-n">التغيير</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="u in monthRep.sellers" :key="u.id">
                    <td>{{ userNameById(u.id, u.name) }}</td>
                    <td class="ta-n num">{{ num(u.invoices) }}</td>
                    <td class="ta-n num"><b>{{ money(u.salesMinor) }}</b></td>
                    <td class="ta-n num">{{ money(u.avgMinor) }}</td>
                    <td class="ta-n">
                      <span v-if="chgFormat(u.ch).kind === 'new'" class="muted">جديد</span>
                      <span v-else-if="chgFormat(u.ch).kind === 'zero'" class="ch muted">0%</span>
                      <span
                        v-else
                        class="ch"
                        :class="chgFormat(u.ch).kind === 'up' ? 'ok-t' : 'danger-t'"
                      >
                        <Icon
                          :name="
                            chgFormat(u.ch).kind === 'up'
                              ? 'trending-up'
                              : 'trending-down'
                          "
                        />
                        {{ chgFormat(u.ch).text }}
                      </span>
                    </td>
                  </tr>
                  <tr v-if="monthRep.sellers.length === 0">
                    <td colspan="5" class="muted">لسه مفيش مبيعات في الشهر ده</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

      <!-- يوم بيوم -->
      <div class="card" data-reports-daily>
        <h3>
          يوم بيوم
          <span class="sp"></span>
          <span class="muted rep-hint">دوس على أي يوم تشوف فواتيره</span>
        </h3>
        <div class="bars dense">
          <template v-for="col in monthDailyColumns" :key="col.iso">
            <button
              v-if="col.active"
              type="button"
              class="bar-col"
              data-reports-day-bar
              :data-d="col.iso"
              :title="`${fmtDayDate(col.date)}: ${money(col.salesMinor)} — افتح فواتيره`"
              :aria-label="`${fmtDayDate(col.date)}: ${money(col.salesMinor)}`"
              @click="openDayInSales(col.iso)"
            >
              <span class="bv num">
                {{ col.isBest ? kShortMinor(col.salesMinor) : '' }}
              </span>
              <div
                class="bar"
                :class="{ today: col.isBest }"
                :style="{ height: `${col.heightPct}%` }"
              ></div>
              <span class="bl num">{{ num(col.dayNum) }}</span>
            </button>
            <div
              v-else
              class="bar-col later"
              aria-hidden="true"
            >
              <span class="bv"></span>
              <div class="bar ghost" style="height: 6%"></div>
              <span class="bl num">{{ num(col.dayNum) }}</span>
            </div>
          </template>
        </div>
      </div>

      <!-- الأصناف الأكتر مبيعًا + طرق الدفع -->
      <div class="dash-grid">
        <div class="card" data-reports-products>
          <h3>الأصناف الأكتر مبيعًا</h3>
          <div class="table-wrap" style="border: 0">
            <table class="t sv-t">
              <thead>
                <tr>
                  <th>الصنف</th>
                  <th class="ta-n">القطع</th>
                  <th class="ta-n">المبيعات</th>
                  <th class="ta-n">التغيير</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="p in monthRep.products.slice(0, 8)"
                  :key="p.key"
                >
                  <td><bdi dir="rtl">{{ p.name }}</bdi></td>
                  <td class="ta-n num">{{ num(p.qty) }}</td>
                  <td class="ta-n num"><b>{{ money(p.salesMinor) }}</b></td>
                  <td class="ta-n">
                    <span v-if="chgFormat(p.ch).kind === 'new'" class="muted">جديد</span>
                    <span v-else-if="chgFormat(p.ch).kind === 'zero'" class="ch muted">0%</span>
                    <span
                      v-else
                      class="ch"
                      :class="chgFormat(p.ch).kind === 'up' ? 'ok-t' : 'danger-t'"
                    >
                      <Icon
                        :name="
                          chgFormat(p.ch).kind === 'up'
                            ? 'trending-up'
                            : 'trending-down'
                        "
                      />
                      {{ chgFormat(p.ch).text }}
                    </span>
                  </td>
                </tr>
                <tr v-if="monthRep.products.length === 0">
                  <td colspan="4" class="muted">لسه مفيش مبيعات في الشهر ده</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="card narrow" data-reports-methods>
          <h3>طرق الدفع</h3>
          <div class="table-wrap" style="border: 0">
            <table class="t sv-t">
              <thead>
                <tr>
                  <th>الطريقة</th>
                  <th class="ta-n">المبلغ</th>
                  <th>النسبة</th>
                  <th class="ta-n">التغيير</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in monthRep.methods" :key="m.id">
                  <td>{{ m.name }}</td>
                  <td class="ta-n num"><b>{{ money(m.amountMinor) }}</b></td>
                  <td>
                    <span class="sv-share">
                      <i :style="{ width: `${sharePct(m.amountMinor, monthRep.T.salesMinor)}%` }"></i>
                    </span>
                    <span class="num">{{ num(sharePct(m.amountMinor, monthRep.T.salesMinor)) }}%</span>
                  </td>
                  <td class="ta-n">
                    <span v-if="chgFormat(m.ch).kind === 'new'" class="muted">جديد</span>
                    <span v-else-if="chgFormat(m.ch).kind === 'zero'" class="ch muted">0%</span>
                    <span
                      v-else
                      class="ch"
                      :class="chgFormat(m.ch).kind === 'up' ? 'ok-t' : 'danger-t'"
                    >
                      <Icon
                        :name="
                          chgFormat(m.ch).kind === 'up'
                            ? 'trending-up'
                            : 'trending-down'
                        "
                      />
                      {{ chgFormat(m.ch).text }}
                    </span>
                  </td>
                </tr>
                <tr v-if="monthRep.methods.length === 0">
                  <td colspan="4" class="muted">لسه مفيش مبيعات في الشهر ده</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- إيراد الصيانة لوحده والسوفت وير لوحده والخدمات في الشهر -->
      <div class="card" data-reports-repairs-summary>
        <h3>الصيانة والسوفت وير وعمولات المحافظ في الشهر</h3>
        <div class="cards">
          <div class="card kpi" data-reports-month-hardware>
            <div class="label"><Icon name="wrench" /> فلوس الصيانة لوحدها</div>
            <div class="value num">{{ money(monthHardwareRevenueMinor) }}</div>
            <div class="sub muted">
              {{ num(monthRepairs?.hardware.deliveredCount ?? 0) }} جهاز مُسلّم ·
              صافي ربح
              {{ money(monthRepairs?.hardware.netProfitMinor ?? monthHardwareRevenueMinor) }}
            </div>
          </div>

          <div class="card kpi" data-reports-month-software>
            <div class="label"><Icon name="smartphone" /> فلوس السوفت وير لوحدها</div>
            <div class="value num">{{ money(monthSoftwareRevenueMinor) }}</div>
            <div class="sub muted">
              {{ num(monthRepairs?.software.deliveredCount ?? 0) }} عملية سوفت ·
              صافي ربح
              {{ money(monthRepairs?.software.netProfitMinor ?? monthSoftwareRevenueMinor) }}
            </div>
          </div>

          <div class="card kpi" data-reports-month-wallet-fees>
            <div class="label"><Icon name="wallet" /> عمولات المحافظ والفواتير</div>
            <div class="value num">{{ money(monthWalletFeesMinor) }}</div>
            <div class="sub muted">
              {{ num(monthWallets?.servicesWindow.servicesCount ?? 0) }} عملية خدمة
            </div>
          </div>

          <div class="card kpi" data-reports-month-expenses>
            <div class="label"><Icon name="hand-coins" /> مصاريف الشهر</div>
            <div class="value num danger-t">{{ money(monthExpensesMinor) }}</div>
            <div class="sub muted">
              من الدرج {{ money(monthExpenses?.drawerMinor ?? 0) }} · من برّه
              {{ money(monthExpenses?.outsideMinor ?? 0) }}
            </div>
          </div>
        </div>

        <div class="dr-total" :class="monthNetMinor < 0 ? 'danger-t' : 'ok-t'">
          <span>صافي الشهر بعد المصاريف (كل الأقسام)</span>
          <strong class="num" data-reports-month-net>{{ money(monthNetMinor) }}</strong>
        </div>
      </div>

      <!-- آخر N شهور -->
      <div class="card" data-reports-months-history>
        <h3>آخر {{ nMonthsLabel(monthRep.months.length) }}</h3>
        <div class="bars months">
          <button
            v-for="m in monthRep.months"
            :key="m.key"
            type="button"
            class="bar-col"
            data-reports-month-bar
            :data-m="m.key"
            :title="`${fmtMonth(m.from)}: ${money(m.salesMinor)}${
              m.live && monthRep.projectionMinor
                ? ` — المتوقع ${money(monthRep.projectionMinor)}`
                : ''
            }`"
            :aria-label="`${fmtMonth(m.from)}: ${money(m.salesMinor)}`"
            @click="pickMonthKey(m.key)"
          >
            <span class="bv num">
              {{
                kShortMinor(
                  m.live && monthRep.projectionMinor
                    ? monthRep.projectionMinor
                    : m.salesMinor,
                )
              }}
            </span>
            <div
              class="bar-stack"
              :style="{
                height: `${Math.max(
                  3,
                  Math.round(
                    (((m.live && monthRep.projectionMinor
                      ? Math.max(m.salesMinor, monthRep.projectionMinor)
                      : m.salesMinor) /
                      maxMonthBarMinor) *
                      100),
                  ),
                )}%`,
              }"
            >
              <div
                v-if="
                  m.live &&
                  monthRep.projectionMinor &&
                  monthRep.projectionMinor > m.salesMinor
                "
                class="bar ghost"
                :style="{ flex: monthRep.projectionMinor - m.salesMinor }"
              ></div>
              <div
                class="bar"
                :class="{ today: m.key === monthKey(monthRep.from) }"
                :style="{ flex: m.salesMinor || 1 }"
              ></div>
            </div>
            <span class="bl">{{ monthName(m.from) }}</span>
          </button>
        </div>

        <div class="table-wrap" style="border: 0">
          <table class="t sv-t">
            <thead>
              <tr>
                <th>الشهر</th>
                <th class="ta-n">المبيعات</th>
                <th class="ta-n">عن اللي قبله</th>
                <th class="ta-n">الربح</th>
                <th class="ta-n">الهامش</th>
                <th class="ta-n">الفواتير</th>
                <th class="ta-n">متوسط اليوم</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="m in monthsTableRows"
                :key="m.key"
                class="hov click"
                :class="{ on: m.key === monthKey(monthRep.from) }"
                data-reports-month-row
                :data-m="m.key"
                @click="pickMonthKey(m.key)"
              >
                <td>
                  {{ fmtMonth(m.from) }}
                  <span v-if="m.live" class="muted">(لحد النهارده)</span>
                </td>
                <td class="ta-n num"><b>{{ money(m.salesMinor) }}</b></td>
                <td class="ta-n">
                  <span v-if="!m.hasPrev" class="muted">—</span>
                  <span v-else-if="chgFormat(m.ch).kind === 'new'" class="muted">جديد</span>
                  <span v-else-if="chgFormat(m.ch).kind === 'zero'" class="ch muted">0%</span>
                  <span
                    v-else
                    class="ch"
                    :class="chgFormat(m.ch).kind === 'up' ? 'ok-t' : 'danger-t'"
                  >
                    <Icon
                      :name="
                        chgFormat(m.ch).kind === 'up'
                          ? 'trending-up'
                          : 'trending-down'
                      "
                    />
                    {{ chgFormat(m.ch).text }}
                  </span>
                </td>
                <td class="ta-n num">{{ money(m.profitMinor) }}</td>
                <td class="ta-n num">{{ num(m.margin) }}%</td>
                <td class="ta-n num">{{ num(m.invoices) }}</td>
                <td class="ta-n num">{{ money(m.perDayMinor) }}</td>
              </tr>
              <tr v-if="monthsTableRows.length === 0">
                <td colspan="7" class="muted">لسه مفيش مبيعات في السجل</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* تقييم النهارده (`ADR-047`): كلمة واحدة كبيرة، والسبب جنبها. */
.day-rating {
  display: flex;
  align-items: stretch;
  gap: 16px;
  margin-bottom: 14px;
  border-inline-start: 5px solid var(--border);
}

.day-rating.good { border-inline-start-color: var(--ok); }
.day-rating.ok { border-inline-start-color: var(--accent-text); }
.day-rating.warn { border-inline-start-color: var(--warn); }
.day-rating.danger { border-inline-start-color: var(--danger); }

.dr-word {
  display: grid;
  align-content: center;
  justify-items: center;
  gap: 2px;
  min-width: 130px;
  padding-inline-end: 16px;
  border-inline-end: 1px solid var(--border);
}

.dr-word small {
  color: var(--muted);
  font-size: 0.8rem;
}

.dr-word strong {
  font-size: 1.6rem;
  line-height: 1.2;
}

.day-rating.good .dr-word strong { color: var(--ok); }
.day-rating.ok .dr-word strong { color: var(--accent-text); }
.day-rating.warn .dr-word strong { color: var(--warn); }
.day-rating.danger .dr-word strong { color: var(--danger); }

.dr-body {
  display: grid;
  gap: 6px;
  align-content: center;
}

.dr-line {
  margin: 0;
  font-weight: 600;
}

.dr-reasons {
  margin: 0;
  padding-inline-start: 18px;
  color: var(--muted);
  font-size: 0.85rem;
  display: grid;
  gap: 2px;
}

.dr-total {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border);
  font-weight: 700;
}

.dr-total strong { font-size: 1.15rem; }
</style>
