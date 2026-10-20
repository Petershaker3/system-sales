<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Session } from '../../api/identity';
import {
  cancelRepair,
  createRepair,
  deliverRepair,
  repairsOverview,
  updateRepairStatus,
  type RepairKindFinancialBucket,
  type RepairPayMethod,
  type RepairServiceKind,
  type RepairStatusId,
  type RepairTechnicianSummary,
  type RepairTicket,
} from '../../api/repairs';
import { listCustomers, type Customer } from '../../api/customer';
import { appearance } from '../../ui/appearance';
import { describeError } from '../../api/errors';
import { money } from '../../ui/format';
import WalletNumberChips from '../pos/WalletNumberChips.vue';
import Icon from '../../ui/Icon.vue';
import CameraScanButton from '../../ui/CameraScanButton.vue';
import type { ScanReading } from '../../ui/scan';
import Modal from '../../ui/Modal.vue';
import {
  buildRepairWhatsAppUrl,
  filterRepairTickets,
  HARDWARE_QUICK_ISSUES,
  nextKanbanStatus,
  payMethodLabel,
  REPAIR_ACCESSORIES,
  REPAIR_DUE_OPTIONS,
  REPAIR_KANBAN_STATUSES,
  REPAIR_PAY_METHODS,
  REPAIR_WARRANTY_OPTIONS,
  repairPeriodRange,
  serviceKindLabel,
  SOFTWARE_QUICK_ISSUES,
  type RepairPeriodId,
} from './repairs';

const props = defineProps<{
  session: Session;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const egp = money;

const loading = ref(false);
const errorBanner = ref('');
const okBanner = ref('');
const shopName = ref('محل النور للموبايلات');

const period = ref<RepairPeriodId>('all');
const kindFilter = ref<'all' | RepairServiceKind>('all');
const techFilter = ref<string>('all');
const searchQuery = ref('');

const tickets = ref<readonly RepairTicket[]>([]);
const emptyBucket = (kind: string): RepairKindFinancialBucket => ({
  serviceKind: kind,
  ticketsCount: 0,
  openCount: 0,
  readyCount: 0,
  deliveredCount: 0,
  depositCollectedMinor: 0,
  deliveryCollectedMinor: 0,
  totalRevenueMinor: 0,
  cashCollectedMinor: 0,
  vfCollectedMinor: 0,
  instapayCollectedMinor: 0,
  cardCollectedMinor: 0,
  partsCostMinor: props.session.role === 'manager' ? 0 : null,
  netProfitMinor: props.session.role === 'manager' ? 0 : null,
});

const hardwareBucket = ref<RepairKindFinancialBucket>(emptyBucket('hardware'));
const softwareBucket = ref<RepairKindFinancialBucket>(emptyBucket('software'));
const combinedBucket = ref<RepairKindFinancialBucket>(emptyBucket('all'));
const technicians = ref<readonly RepairTechnicianSummary[]>([]);
const customers = ref<readonly Customer[]>([]);

// Intake modal state
const showIntake = ref(false);
const intakeSubmitting = ref(false);
const intakeError = ref('');
const intakeKind = ref<RepairServiceKind>('hardware');
const intakeDeliverNow = ref(false);
const intakePhone = ref('');
const intakeCustomerName = ref('');
const intakeDevice = ref('');
const intakeLock = ref('');
// A camera reading into the intake's IMEI field (`ADR-043`), same 15-digit rule as
// everywhere else.
function onIntakeScan(reading: ScanReading): void {
  intakeImei.value = reading.digits === '' ? reading.raw : reading.digits;
}

const intakeImei = ref('');
const intakeIssueChips = ref<string[]>([]);
const intakeIssueNote = ref('');
const intakeAccessories = ref<string[]>([]);
const intakeDue = ref('بكره');
const intakeTech = ref('');
const intakePriceEgp = ref('');
const intakePartsCostEgp = ref('');
const intakeDepositEgp = ref('0');
const intakePayMethod = ref<RepairPayMethod>('cash');
/** Which wallet number took the money collected at intake (`ADR-041`). */
const intakePayWalletId = ref<string | null>(null);
const intakeWarrantyDays = ref<number>(14);

// Deliver modal state
const deliverTarget = ref<RepairTicket | null>(null);
const deliverSubmitting = ref(false);
const deliverError = ref('');
const deliverFinalPriceEgp = ref('');
const deliverPartsCostEgp = ref('');
const deliverPayMethod = ref<RepairPayMethod>('cash');
/** Which wallet number takes the remaining amount at delivery (`ADR-041`). */
const deliverPayWalletId = ref<string | null>(null);
const deliverTech = ref('');
const deliverWarrantyDays = ref<number>(14);
const deliverNote = ref('');

// Detail / edit modal state
const detailTarget = ref<RepairTicket | null>(null);
const detailStatus = ref<RepairStatusId>('received');
const detailTech = ref('');
const detailEstPriceEgp = ref('');
const detailPartsCostEgp = ref('');
const detailNote = ref('');
const detailSubmitting = ref(false);
const detailError = ref('');

const canSeeCost = computed(
  () =>
    props.session.role === 'manager' ||
    hardwareBucket.value.partsCostMinor !== null ||
    softwareBucket.value.partsCostMinor !== null
);

const openTicketsCount = computed(
  () =>
    tickets.value.filter(
      (t) => t.status !== 'delivered' && t.status !== 'cancelled'
    ).length
);

const readyTicketsCount = computed(
  () => tickets.value.filter((t) => t.status === 'ready').length
);

const filteredTickets = computed(() =>
  filterRepairTickets(
    tickets.value,
    searchQuery.value,
    kindFilter.value,
    techFilter.value
  )
);

function ticketsInStage(stage: RepairStatusId): RepairTicket[] {
  return filteredTickets.value.filter((t) => t.status === stage);
}

const knownTechNames = computed(() => {
  const set = new Set<string>();
  for (const t of technicians.value) {
    if (t.technicianName.trim()) set.add(t.technicianName.trim());
  }
  for (const tk of tickets.value) {
    if (tk.technicianName && tk.technicianName.trim()) {
      set.add(tk.technicianName.trim());
    }
  }
  return Array.from(set);
});

const quickIssueChipsForIntake = computed(() =>
  intakeKind.value === 'software' ? SOFTWARE_QUICK_ISSUES : HARDWARE_QUICK_ISSUES
);

async function loadOverview(): Promise<void> {
  loading.value = true;
  errorBanner.value = '';
  try {
    const range = repairPeriodRange(period.value);
    const res = await repairsOverview({
      fromTs: range.fromTs,
      toTs: range.toTs,
    });
    tickets.value = res.tickets;
    hardwareBucket.value = res.hardware;
    softwareBucket.value = res.software;
    combinedBucket.value = res.combined;
    technicians.value = res.technicians;
  } catch (e) {
    errorBanner.value = describeError(e);
  } finally {
    loading.value = false;
  }
}

async function selectPeriod(next: RepairPeriodId): Promise<void> {
  period.value = next;
  await loadOverview();
}

function openIntakeModal(defaultKind: RepairServiceKind = 'hardware'): void {
  intakeError.value = '';
  intakeKind.value = defaultKind;
  intakeDeliverNow.value = defaultKind === 'software';
  intakePhone.value = '';
  intakeCustomerName.value = '';
  intakeDevice.value = '';
  intakeLock.value = '';
  intakeImei.value = '';
  intakeIssueChips.value = [];
  intakeIssueNote.value = '';
  intakeAccessories.value = [];
  intakeDue.value = defaultKind === 'software' ? 'النهارده' : 'بكره';
  intakeTech.value = '';
  intakePriceEgp.value = '';
  intakePartsCostEgp.value = '0';
  intakeDepositEgp.value = '0';
  intakePayMethod.value = 'cash';
  intakePayWalletId.value = null;
  intakeWarrantyDays.value = defaultKind === 'software' ? 0 : 14;
  showIntake.value = true;
}

function switchIntakeKind(kind: RepairServiceKind): void {
  intakeKind.value = kind;
  intakeIssueChips.value = [];
  if (kind === 'software') {
    intakeDue.value = 'النهارده';
    intakeWarrantyDays.value = 0;
  } else {
    intakeDeliverNow.value = false;
    intakeWarrantyDays.value = 14;
  }
}

function onIntakePhoneInput(): void {
  const digits = intakePhone.value.replace(/\D+/g, '');
  if (digits.length >= 10 && !intakeCustomerName.value.trim()) {
    const match = customers.value.find(
      (c) => (c.contact ?? '').replace(/\D+/g, '') === digits
    );
    if (match) {
      intakeCustomerName.value = match.name;
    }
  }
}

function toggleIssueChip(chip: string): void {
  const idx = intakeIssueChips.value.indexOf(chip);
  if (idx >= 0) {
    intakeIssueChips.value.splice(idx, 1);
  } else {
    intakeIssueChips.value.push(chip);
  }
}

function toggleAccessoryChip(acc: string): void {
  const idx = intakeAccessories.value.indexOf(acc);
  if (idx >= 0) {
    intakeAccessories.value.splice(idx, 1);
  } else {
    intakeAccessories.value.push(acc);
  }
}

function toMinorFromEgpInput(raw: string | number): number {
  const cleaned = String(raw ?? '').trim();
  if (!cleaned) return 0;
  const num = Number(cleaned);
  if (!Number.isFinite(num) || num < 0) return -1;
  return Math.round(num * 100);
}

async function submitIntake(): Promise<void> {
  intakeError.value = '';
  const combinedIssue = [
    ...intakeIssueChips.value,
    intakeIssueNote.value.trim(),
  ]
    .filter(Boolean)
    .join(' + ');

  if (!intakeCustomerName.value.trim() || !intakePhone.value.trim()) {
    intakeError.value = 'اكتب اسم العميل ورقم تليفونه.';
    return;
  }
  if (!intakeDevice.value.trim()) {
    intakeError.value = 'اكتب موديل الجهاز الأول.';
    return;
  }
  if (!combinedIssue) {
    intakeError.value =
      intakeKind.value === 'software'
        ? 'اختار عملية السوفت وير أو اكتب البيان.'
        : 'اختار العطل أو اكتب وصف المشكلة.';
    return;
  }

  const priceMinor = toMinorFromEgpInput(intakePriceEgp.value);
  const partsMinor = toMinorFromEgpInput(intakePartsCostEgp.value);
  const depositMinor = intakeDeliverNow.value
    ? 0
    : toMinorFromEgpInput(intakeDepositEgp.value);
  if (priceMinor < 0 || partsMinor < 0 || depositMinor < 0) {
    intakeError.value = 'تأكد إن الأسعار أرقام صحيحة.';
    return;
  }

  intakeSubmitting.value = true;
  try {
    const created = await createRepair({
      serviceKind: intakeKind.value,
      customerName: intakeCustomerName.value.trim(),
      customerPhone: intakePhone.value.trim(),
      deviceName: intakeDevice.value.trim(),
      imei: intakeImei.value.trim() || null,
      deviceLock: intakeLock.value.trim() || null,
      issue: combinedIssue,
      accessories: intakeAccessories.value.join(' + ') || null,
      dueLabel: intakeDue.value,
      estimatedPriceMinor: priceMinor,
      partsCostMinor: partsMinor,
      depositMinor,
      payMethod: intakeDeliverNow.value ? intakePayMethod.value : 'cash',
      payWalletId: intakeDeliverNow.value ? intakePayWalletId.value : null,
      technicianName: intakeTech.value.trim() || null,
      warrantyDays: intakeWarrantyDays.value,
      note: null,
      deliverNow: intakeDeliverNow.value,
    });
    showIntake.value = false;
    okBanner.value = intakeDeliverNow.value
      ? `تم تسجيل وتحصيل تذكرة ${created.ticketNo} (${serviceKindLabel(created.serviceKind)}) بنجاح`
      : `تم فتح تذكرة ${created.ticketNo} (${serviceKindLabel(created.serviceKind)}) بنجاح`;
    await loadOverview();
    emit('changed');
  } catch (e) {
    intakeError.value = describeError(e);
  } finally {
    intakeSubmitting.value = false;
  }
}

async function advanceStage(ticket: RepairTicket): Promise<void> {
  const next = nextKanbanStatus(ticket.status);
  if (!next) return;
  errorBanner.value = '';
  try {
    const updated = await updateRepairStatus({
      id: ticket.id,
      status: next,
    });
    okBanner.value = `اتنقلت تذكرة ${updated.ticketNo} لمرحلة «${REPAIR_KANBAN_STATUSES.find((s) => s.id === next)?.name ?? next}»`;
    await loadOverview();
  } catch (e) {
    errorBanner.value = describeError(e);
  }
}

function openDeliverModal(ticket: RepairTicket): void {
  deliverError.value = '';
  deliverTarget.value = ticket;
  const defaultFinal =
    ticket.finalPriceMinor > 0
      ? ticket.finalPriceMinor
      : ticket.estimatedPriceMinor;
  deliverFinalPriceEgp.value = String(Math.round(defaultFinal / 100));
  deliverPartsCostEgp.value =
    ticket.partsCostMinor !== null
      ? String(Math.round(ticket.partsCostMinor / 100))
      : '0';
  deliverPayMethod.value = ticket.payMethod || 'cash';
  deliverPayWalletId.value = null;
  deliverTech.value = ticket.technicianName ?? '';
  deliverWarrantyDays.value =
    ticket.warrantyDays > 0
      ? ticket.warrantyDays
      : ticket.serviceKind === 'software'
        ? 0
        : 14;
  deliverNote.value = ticket.note ?? '';
}

const deliverRemainingMinor = computed(() => {
  if (!deliverTarget.value) return 0;
  const finalMinor = Math.max(0, toMinorFromEgpInput(deliverFinalPriceEgp.value));
  return Math.max(0, finalMinor - deliverTarget.value.depositMinor);
});

const deliverNetProfitMinor = computed(() => {
  const finalMinor = Math.max(0, toMinorFromEgpInput(deliverFinalPriceEgp.value));
  const partsMinor = Math.max(0, toMinorFromEgpInput(deliverPartsCostEgp.value));
  return finalMinor - partsMinor;
});

async function submitDeliver(): Promise<void> {
  if (!deliverTarget.value) return;
  deliverError.value = '';
  const finalMinor = toMinorFromEgpInput(deliverFinalPriceEgp.value);
  const partsMinor = toMinorFromEgpInput(deliverPartsCostEgp.value);
  if (finalMinor < 0 || partsMinor < 0) {
    deliverError.value = 'تأكد إن السعر النهائي وتكلفة القطع أرقام صحيحة.';
    return;
  }

  deliverSubmitting.value = true;
  try {
    const delivered = await deliverRepair({
      id: deliverTarget.value.id,
      finalPriceMinor: finalMinor,
      partsCostMinor: partsMinor,
      payMethod: deliverPayMethod.value,
      payWalletId: deliverPayWalletId.value,
      technicianName: deliverTech.value.trim() || null,
      warrantyDays: deliverWarrantyDays.value,
      note: deliverNote.value.trim() || null,
    });
    deliverTarget.value = null;
    okBanner.value = `تم تسليم جهاز ${delivered.deviceName} (${delivered.ticketNo}) وتحصيل الحساب بنجاح`;
    await loadOverview();
    emit('changed');
  } catch (e) {
    deliverError.value = describeError(e);
  } finally {
    deliverSubmitting.value = false;
  }
}

function openDetailModal(ticket: RepairTicket): void {
  detailError.value = '';
  detailTarget.value = ticket;
  detailStatus.value = ticket.status;
  detailTech.value = ticket.technicianName ?? '';
  detailEstPriceEgp.value = String(Math.round(ticket.estimatedPriceMinor / 100));
  detailPartsCostEgp.value =
    ticket.partsCostMinor !== null
      ? String(Math.round(ticket.partsCostMinor / 100))
      : '0';
  detailNote.value = ticket.note ?? '';
}

async function saveDetailChanges(): Promise<void> {
  if (!detailTarget.value) return;
  detailError.value = '';
  const estMinor = toMinorFromEgpInput(detailEstPriceEgp.value);
  const partsMinor = toMinorFromEgpInput(detailPartsCostEgp.value);
  if (estMinor < 0 || partsMinor < 0) {
    detailError.value = 'تأكد من صحة الأسعار المدخلة.';
    return;
  }

  detailSubmitting.value = true;
  try {
    const updated = await updateRepairStatus({
      id: detailTarget.value.id,
      status: detailStatus.value,
      technicianName: detailTech.value.trim() || null,
      estimatedPriceMinor: estMinor,
      partsCostMinor: partsMinor,
      note: detailNote.value.trim(),
    });
    detailTarget.value = null;
    okBanner.value = `تم تحديث بيانات تذكرة ${updated.ticketNo}`;
    await loadOverview();
  } catch (e) {
    detailError.value = describeError(e);
  } finally {
    detailSubmitting.value = false;
  }
}

async function handleCancelTicket(): Promise<void> {
  if (!detailTarget.value) return;
  detailSubmitting.value = true;
  try {
    const cancelled = await cancelRepair(
      detailTarget.value.id,
      detailNote.value.trim() || 'إلغاء التذكرة'
    );
    detailTarget.value = null;
    okBanner.value = `تم إلغاء تذكرة ${cancelled.ticketNo}`;
    await loadOverview();
  } catch (e) {
    detailError.value = describeError(e);
  } finally {
    detailSubmitting.value = false;
  }
}

function sendTicketWhatsApp(
  ticket: RepairTicket,
  kind: 'intake' | 'ready' | 'delivered'
): void {
  const url = buildRepairWhatsAppUrl(ticket, shopName.value, kind);
  if (!url) {
    errorBanner.value = 'رقم تليفون العميل غير صالح لإرسال رسالة واتساب.';
    return;
  }
  if (!navigator.webdriver) {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  okBanner.value =
    kind === 'ready'
      ? `تم تجهيز رسالة واتساب للعميل ${ticket.customerName} إن الجهاز جاهز للاستلام`
      : `تم تجهيز رسالة واتساب لتذكرة ${ticket.ticketNo}`;
}

onMounted(async () => {
  await loadOverview();
  if (appearance.shopName?.trim()) {
    shopName.value = appearance.shopName.trim();
  }
  try {
    customers.value = await listCustomers();
  } catch {
    // Non-fatal (e.g. seller role)
  }
});
</script>

<template>
  <div class="page" data-repairs-screen>
    <div class="page-h">
      <div>
        <h1>الصيانة والسوفت وير</h1>
        <p class="sub">
          {{ openTicketsCount }} تذكرة مفتوحة في الورشة ·
          {{ readyTicketsCount }} جاهز للتسليم ·
          حساب الصيانة مفصول بالكامل عن حساب السوفت وير
        </p>
      </div>
      <div class="row" style="gap: 8px; flex-wrap: wrap">
        <div class="seg" role="tablist" aria-label="فترة الحساب">
          <button
            type="button"
            :class="{ active: period === 'today' }"
            data-repairs-period="today"
            @click="selectPeriod('today')"
          >
            النهارده
          </button>
          <button
            type="button"
            :class="{ active: period === 'yesterday' }"
            data-repairs-period="yesterday"
            @click="selectPeriod('yesterday')"
          >
            امبارح
          </button>
          <button
            type="button"
            :class="{ active: period === 'week' }"
            data-repairs-period="week"
            @click="selectPeriod('week')"
          >
            آخر 7 أيام
          </button>
          <button
            type="button"
            :class="{ active: period === 'month' }"
            data-repairs-period="month"
            @click="selectPeriod('month')"
          >
            الشهر ده
          </button>
          <button
            type="button"
            :class="{ active: period === 'all' }"
            data-repairs-period="all"
            @click="selectPeriod('all')"
          >
            الكل
          </button>
        </div>

        <button
          type="button"
          class="btn"
          data-repairs-new-software
          @click="openIntakeModal('software')"
        >
          <Icon name="zap" />
          <span>+ عملية سوفت وير</span>
        </button>

        <button
          type="button"
          class="btn primary"
          data-repairs-new
          @click="openIntakeModal('hardware')"
        >
          <Icon name="plus" />
          <span>استلام جهاز صيانة</span>
        </button>
      </div>
    </div>

    <div v-if="errorBanner" class="banner err" role="alert">
      <span>{{ errorBanner }}</span>
      <button type="button" class="btn ghost sm" @click="errorBanner = ''">إغلاق</button>
    </div>

    <div v-if="okBanner" class="banner ok" data-repairs-ok-banner>
      <span>{{ okBanner }}</span>
      <button type="button" class="btn ghost sm" @click="okBanner = ''">إغلاق</button>
    </div>

    <!-- شريط الحساب المالي المنفصل: فلوس الصيانة لوحدها وفلوس السوفت وير لوحدها -->
    <div class="repairs-money-grid">
      <!-- 1. حساب الصيانة (هاردوير) لوحده -->
      <section class="card repair-bucket-card hw" data-repairs-hw-card>
        <div class="rb-head">
          <div class="row" style="gap: 8px">
            <span class="badge info">صيانة هاردوير</span>
            <strong>فلوس الصيانة لوحدها</strong>
          </div>
          <span class="muted small">
            {{ hardwareBucket.ticketsCount }} تذكرة · {{ hardwareBucket.deliveredCount }} اتسلّم
          </span>
        </div>
        <div class="rb-metrics">
          <div class="rb-metric">
            <span class="lbl">المحصّل في الصيانة</span>
            <strong class="val num" data-hw-revenue>{{ egp(hardwareBucket.totalRevenueMinor) }}</strong>
            <span class="sub muted small">
              عربون {{ egp(hardwareBucket.depositCollectedMinor) }} + تسليم
              {{ egp(hardwareBucket.deliveryCollectedMinor) }}
            </span>
          </div>
          <div v-if="canSeeCost" class="rb-metric">
            <span class="lbl">تكلفة قطع الغيار</span>
            <strong class="val num" data-hw-cost>{{ egp(hardwareBucket.partsCostMinor ?? 0) }}</strong>
            <span class="sub muted small">{{ hardwareBucket.openCount }} جهاز مفتوح</span>
          </div>
          <div v-if="canSeeCost" class="rb-metric highlight">
            <span class="lbl">صافي فلوس الصيانة</span>
            <strong class="val num ok-txt" data-hw-profit>{{ egp(hardwareBucket.netProfitMinor ?? 0) }}</strong>
            <span class="sub muted small">بعد خصم قطع الغيار</span>
          </div>
        </div>
      </section>

      <!-- 2. حساب السوفت وير لوحده -->
      <section class="card repair-bucket-card sw" data-repairs-sw-card>
        <div class="rb-head">
          <div class="row" style="gap: 8px">
            <span class="badge ok">سوفت وير</span>
            <strong>فلوس السوفت وير لوحدها</strong>
          </div>
          <span class="muted small">
            {{ softwareBucket.ticketsCount }} عملية · {{ softwareBucket.deliveredCount }} اتسلّم
          </span>
        </div>
        <div class="rb-metrics">
          <div class="rb-metric">
            <span class="lbl">المحصّل في السوفت وير</span>
            <strong class="val num" data-sw-revenue>{{ egp(softwareBucket.totalRevenueMinor) }}</strong>
            <span class="sub muted small">
              فورمات · FRP · روم · فك رمز
            </span>
          </div>
          <div v-if="canSeeCost" class="rb-metric">
            <span class="lbl">تكلفة كريدت / شير</span>
            <strong class="val num" data-sw-cost>{{ egp(softwareBucket.partsCostMinor ?? 0) }}</strong>
            <span class="sub muted small">{{ softwareBucket.openCount }} مفتوح حالياً</span>
          </div>
          <div v-if="canSeeCost" class="rb-metric highlight">
            <span class="lbl">صافي فلوس السوفت وير</span>
            <strong class="val num ok-txt" data-sw-profit>{{ egp(softwareBucket.netProfitMinor ?? 0) }}</strong>
            <span class="sub muted small">ربح السوفت وير المستقل</span>
          </div>
        </div>
      </section>

      <!-- 3. حساب الفنيين (حد الصيانة وحد السوفت) وطرق التحصيل -->
      <section class="card repair-bucket-card tech" data-repairs-tech-card>
        <div class="rb-head">
          <strong>حساب الفنيين وطرق التحصيل</strong>
          <span class="muted small">إجمالي القسمين: {{ egp(combinedBucket.totalRevenueMinor) }}</span>
        </div>
        <div v-if="technicians.length > 0" class="tech-list">
          <div
            v-for="t in technicians"
            :key="t.technicianName"
            class="tech-row"
            :data-tech-row="t.technicianName"
          >
            <div>
              <strong><bdi dir="auto">{{ t.technicianName }}</bdi></strong>
              <span class="muted small" style="margin-inline-start: 6px">
                <template v-if="t.hardwareCount > 0">صيانة ({{ t.hardwareCount }})</template>
                <template v-if="t.hardwareCount > 0 && t.softwareCount > 0"> · </template>
                <template v-if="t.softwareCount > 0">سوفت ({{ t.softwareCount }})</template>
              </span>
            </div>
            <div class="row" style="gap: 10px">
              <span class="small muted">محصّل: <b class="num">{{ egp(t.totalRevenueMinor) }}</b></span>
              <span v-if="canSeeCost && t.netProfitMinor !== null" class="badge ok num">
                صافي {{ egp(t.netProfitMinor) }}
              </span>
            </div>
          </div>
        </div>
        <div v-else class="muted small" style="padding: 6px 0">
          لم يتم تحديد اسم فني على التذاكر بعد
        </div>
        <div class="pay-split-strip muted small">
          <span>كاش: <b class="num">{{ egp(combinedBucket.cashCollectedMinor) }}</b></span>
          <span>· فودافون: <b class="num">{{ egp(combinedBucket.vfCollectedMinor) }}</b></span>
          <span>· إنستاباي: <b class="num">{{ egp(combinedBucket.instapayCollectedMinor) }}</b></span>
          <span v-if="combinedBucket.cardCollectedMinor > 0">
            · كارت: <b class="num">{{ egp(combinedBucket.cardCollectedMinor) }}</b>
          </span>
        </div>
      </section>
    </div>

    <!-- شريط الفلترة والبحث -->
    <div class="repairs-toolbar card">
      <div class="row" style="gap: 10px; flex: 1; flex-wrap: wrap">
        <input
          v-model="searchQuery"
          type="search"
          class="input"
          style="max-width: 300px"
          placeholder="ابحث برقم التذكرة أو العميل أو الموديل أو العطل..."
          data-repairs-search
        />

        <div class="seg" role="tablist" aria-label="فلتر نوع العملية">
          <button
            type="button"
            :class="{ active: kindFilter === 'all' }"
            data-repairs-kind="all"
            @click="kindFilter = 'all'"
          >
            الكل ({{ tickets.filter((t) => t.status !== 'cancelled').length }})
          </button>
          <button
            type="button"
            :class="{ active: kindFilter === 'hardware' }"
            data-repairs-kind="hardware"
            @click="kindFilter = 'hardware'"
          >
            صيانة هاردوير ({{
              tickets.filter((t) => t.serviceKind === 'hardware' && t.status !== 'cancelled').length
            }})
          </button>
          <button
            type="button"
            :class="{ active: kindFilter === 'software' }"
            data-repairs-kind="software"
            @click="kindFilter = 'software'"
          >
            سوفت وير ({{
              tickets.filter((t) => t.serviceKind === 'software' && t.status !== 'cancelled').length
            }})
          </button>
        </div>

        <div v-if="knownTechNames.length > 0" class="chips" style="align-items: center">
          <span class="muted small">الفني:</span>
          <button
            type="button"
            class="chip"
            :class="{ active: techFilter === 'all' }"
            data-repairs-tech-filter="all"
            @click="techFilter = 'all'"
          >
            الكل
          </button>
          <button
            v-for="tech in knownTechNames"
            :key="tech"
            type="button"
            class="chip"
            :class="{ active: techFilter === tech }"
            :data-repairs-tech-filter="tech"
            @click="techFilter = tech"
          >
            <bdi dir="auto">{{ tech }}</bdi>
          </button>
        </div>
      </div>
    </div>

    <!-- لوحة الكانبان ذات الـ 5 مراحل -->
    <div class="kanban" data-repairs-kanban>
      <div
        v-for="st in REPAIR_KANBAN_STATUSES"
        :key="st.id"
        class="kcol"
        :data-kanban-col="st.id"
      >
        <div class="kh">
          <span class="row" style="gap: 6px">
            <span class="dot" :class="st.tone"></span>
            <b>{{ st.name }}</b>
          </span>
          <span class="badge" :class="st.tone">{{ ticketsInStage(st.id).length }}</span>
        </div>

        <div class="kb">
          <div v-if="ticketsInStage(st.id).length === 0" class="k-empty">
            فاضي
          </div>

          <div
            v-for="r in ticketsInStage(st.id)"
            :key="r.id"
            class="ticket"
            :data-ticket-no="r.ticketNo"
            :data-ticket-kind="r.serviceKind"
          >
            <div class="tk-h">
              <div class="row" style="gap: 6px">
                <span class="mono">{{ r.ticketNo }}</span>
                <span
                  class="badge"
                  :class="r.serviceKind === 'software' ? 'ok' : 'info'"
                >
                  {{ r.serviceKind === 'software' ? 'سوفت وير' : 'صيانة' }}
                </span>
              </div>
              <span class="muted small">{{ r.dueLabel }}</span>
            </div>

            <div class="row" style="justify-content: space-between; align-items: baseline">
              <div class="device"><bdi dir="auto">{{ r.deviceName }}</bdi></div>
              <span v-if="r.technicianName" class="tech-tag">
                <bdi dir="auto">{{ r.technicianName }}</bdi>
              </span>
            </div>

            <div class="issue"><bdi dir="auto">{{ r.issue }}</bdi></div>
            <div v-if="r.accessories" class="muted small">
              معاه: <bdi dir="auto">{{ r.accessories }}</bdi>
            </div>
            <div v-if="r.deviceLock" class="muted small">
              قفل: <bdi dir="auto">{{ r.deviceLock }}</bdi>
            </div>

            <div class="cust">
              <Icon name="user" />
              <span><bdi dir="auto">{{ r.customerName }}</bdi></span>
              <span class="mono" dir="ltr" style="margin-inline-start: auto">{{
                r.customerPhone
              }}</span>
            </div>

            <div class="tk-f">
              <div>
                <div class="muted small">
                  {{ r.status === 'delivered' ? 'تم تحصيل' : 'متوقع' }}:
                  <b class="num" style="color: var(--ink)">{{
                    egp(r.finalPriceMinor || r.estimatedPriceMinor)
                  }}</b>
                </div>
                <div v-if="r.depositMinor > 0 && r.status !== 'delivered'" class="small muted">
                  عربون {{ egp(r.depositMinor) }} · باقي {{ egp(r.remainingMinor) }}
                </div>
                <div
                  v-if="canSeeCost && r.netProfitMinor !== null && r.status === 'delivered'"
                  class="small ok-txt num"
                >
                  صافي: {{ egp(r.netProfitMinor) }} ({{ payMethodLabel(r.payMethod) }})
                </div>
              </div>

              <div class="row" style="gap: 4px; flex-wrap: wrap">
                <template v-if="r.status === 'ready'">
                  <button
                    type="button"
                    class="btn sm ok"
                    title="ابعت للعميل إن الجهاز جاهز على واتساب"
                    :data-repair-wa-ready="r.ticketNo"
                    @click="sendTicketWhatsApp(r, 'ready')"
                  >
                    <Icon name="message-circle" />
                  </button>
                  <button
                    type="button"
                    class="btn sm primary"
                    :data-repair-deliver-open="r.ticketNo"
                    @click="openDeliverModal(r)"
                  >
                    سلّم وحصّل
                  </button>
                </template>

                <template v-else-if="r.status === 'delivered'">
                  <button
                    type="button"
                    class="btn sm ghost"
                    title="إيصال واتساب"
                    :data-repair-wa-delivered="r.ticketNo"
                    @click="sendTicketWhatsApp(r, 'delivered')"
                  >
                    <Icon name="message-circle" />
                  </button>
                </template>

                <template v-else>
                  <button
                    type="button"
                    class="btn sm ghost"
                    title="تعديل / تفاصيل"
                    :data-repair-detail="r.ticketNo"
                    @click="openDetailModal(r)"
                  >
                    تفاصيل
                  </button>
                  <button
                    type="button"
                    class="btn sm"
                    :data-repair-advance="r.ticketNo"
                    @click="advanceStage(r)"
                  >
                    المرحلة الجاية ←
                  </button>
                </template>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- نافذة استلام جهاز صيانة أو عملية سوفت وير -->
    <Modal
      v-if="showIntake"
      :title="intakeKind === 'software' ? 'تسجيل عملية سوفت وير' : 'استلام جهاز صيانة (في أقل من دقيقة)'"
      sub="حدد نوع العملية (صيانة هاردوير أو سوفت وير) عشان كل قسم يتحسب لوحده"
      size="wide"
      @close="showIntake = false"
    >
      <div v-if="intakeError" class="banner err" role="alert" style="margin-bottom: 12px">
        {{ intakeError }}
      </div>

      <div class="intake">
        <!-- العمود الأول: بيانات العميل والجهاز والتكلفة -->
        <div style="display: grid; gap: 12px; align-content: start">
          <div class="form-grid">
            <label class="field">
              <span class="lbl">تليفون العميل *</span>
              <input
                v-model="intakePhone"
                type="tel"
                class="input"
                :class="{ mono: intakePhone !== '' }"
                :dir="intakePhone ? 'ltr' : 'rtl'"
                placeholder="010xxxxxxxx"
                data-intake-phone
                @input="onIntakePhoneInput"
              />
            </label>
            <label class="field">
              <span class="lbl">اسم العميل *</span>
              <input
                v-model="intakeCustomerName"
                type="text"
                class="input"
                placeholder="بيكمّل لوحده لو العميل مسجّل"
                data-intake-customer
              />
            </label>
            <label class="field">
              <span class="lbl">موديل الجهاز *</span>
              <input
                v-model="intakeDevice"
                type="text"
                class="input"
                placeholder="مثلاً: سامسونج A54"
                data-intake-device
              />
            </label>
            <label class="field">
              <span class="lbl">رمز / باترن القفل (اختياري)</span>
              <input
                v-model="intakeLock"
                type="text"
                class="input"
                placeholder="1234 أو حرف L أو فاضي"
                data-intake-lock
              />
            </label>
          </div>

          <div class="form-grid cols-3">
            <label class="field">
              <span class="lbl">
                {{ intakeKind === 'software' ? 'الفني (حد السوفت)' : 'الفني (حد الصيانة)' }}
              </span>
              <input
                v-model="intakeTech"
                type="text"
                class="input"
                :placeholder="intakeKind === 'software' ? 'مثلاً: يوسف' : 'مثلاً: م. حسن'"
                data-intake-tech
              />
            </label>

            <label class="field">
              <span class="lbl">{{ intakeDeliverNow ? 'السعر النهائي (ج.م) *' : 'التكلفة المتوقعة (ج.م)' }}</span>
              <input
                v-model="intakePriceEgp"
                type="number"
                min="0"
                class="input"
                :class="{ mono: intakePriceEgp !== '' }"
                :dir="intakePriceEgp ? 'ltr' : 'rtl'"
                placeholder="0"
                data-intake-price
              />
            </label>

            <label v-if="canSeeCost" class="field">
              <span class="lbl">
                {{ intakeKind === 'software' ? 'تكلفة داخلية (ج.م)' : 'تكلفة القطعة (ج.م)' }}
              </span>
              <input
                v-model="intakePartsCostEgp"
                type="number"
                min="0"
                class="input"
                :class="{ mono: intakePartsCostEgp !== '' }"
                :dir="intakePartsCostEgp ? 'ltr' : 'rtl'"
                placeholder="0"
                data-intake-parts-cost
              />
            </label>
          </div>

          <div class="form-grid cols-3">
            <template v-if="intakeDeliverNow">
              <label class="field">
                <span class="lbl">طريقة التحصيل</span>
                <select v-model="intakePayMethod" class="input" data-intake-pay-method>
                  <option v-for="m in REPAIR_PAY_METHODS" :key="m.id" :value="m.id">
                    {{ m.label }}
                  </option>
                </select>
              </label>
              <WalletNumberChips
                :method="intakePayMethod"
                v-model="intakePayWalletId"
                data-intake-pay-wallet
              />
            </template>
            <template v-else>
              <label class="field">
                <span class="lbl">عربون مدفوع كاش (ج.م)</span>
                <input
                  v-model="intakeDepositEgp"
                  type="number"
                  min="0"
                  class="input"
                  :class="{ mono: intakeDepositEgp !== '' }"
                  :dir="intakeDepositEgp ? 'ltr' : 'rtl'"
                  placeholder="0"
                  data-intake-deposit
                />
              </label>
              <label class="field">
                <span class="lbl">الموعد المتوقع</span>
                <select v-model="intakeDue" class="input" data-intake-due>
                  <option v-for="d in REPAIR_DUE_OPTIONS" :key="d" :value="d">
                    {{ d }}
                  </option>
                </select>
              </label>
            </template>

            <div class="field">
              <label class="lbl" for="repair-intake-imei">IMEI (اختياري)</label>
              <!-- Camera beside the field, not inside its label (`ADR-043`). -->
              <div class="row" style="gap: 6px; align-items: center">
                <input
                  id="repair-intake-imei"
                  v-model="intakeImei"
                  type="text"
                  class="input"
                  :class="{ mono: intakeImei !== '' }"
                  :dir="intakeImei ? 'ltr' : 'rtl'"
                  placeholder="اختياري"
                  data-intake-imei
                />
                <CameraScanButton
                  :compact="true"
                  data-intake-scan-imei
                  @scan="onIntakeScan"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- العمود الثاني: نوع العملية والعطل والمرفقات -->
        <div style="display: grid; gap: 12px; align-content: start">
          <div class="row" style="justify-content: space-between; gap: 10px; flex-wrap: wrap">
            <div class="seg" role="tablist" aria-label="مسار التذكرة">
              <button
                type="button"
                :class="{ active: intakeKind === 'hardware' }"
                data-intake-kind="hardware"
                @click="switchIntakeKind('hardware')"
              >
                صيانة هاردوير
              </button>
              <button
                type="button"
                :class="{ active: intakeKind === 'software' }"
                data-intake-kind="software"
                @click="switchIntakeKind('software')"
              >
                سوفت وير
              </button>
            </div>

            <label class="switch-field" data-intake-deliver-now>
              <span class="switch">
                <input v-model="intakeDeliverNow" type="checkbox" />
                <span></span>
              </span>
              <span class="cap">اتسلّمت في ساعتها (تحصيل فوري)</span>
            </label>
          </div>

          <div class="field">
            <span class="lbl">
              {{ intakeKind === 'software' ? 'عملية السوفت وير المطلوبة (اختار بلمسة)' : 'العطل (اختار بلمسة)' }}
            </span>
            <div class="chips">
              <button
                v-for="iss in quickIssueChipsForIntake"
                :key="iss"
                type="button"
                class="chip"
                :class="{ active: intakeIssueChips.includes(iss) }"
                :data-intake-issue-chip="iss"
                @click="toggleIssueChip(iss)"
              >
                {{ iss }}
              </button>
            </div>
            <input
              v-model="intakeIssueNote"
              type="text"
              class="input"
              style="margin-top: 6px"
              :placeholder="
                intakeKind === 'software'
                  ? 'تفاصيل إضافية عن عملية السوفت وير...'
                  : 'ملاحظة زيادة عن العطل...'
              "
              data-intake-issue
            />
          </div>

          <div class="field">
            <span class="lbl">معاه إيه؟ (عشان محدش يقول سبت الشاحن)</span>
            <div class="chips">
              <button
                v-for="acc in REPAIR_ACCESSORIES"
                :key="acc"
                type="button"
                class="chip"
                :class="{ active: intakeAccessories.includes(acc) }"
                :data-intake-acc-chip="acc"
                @click="toggleAccessoryChip(acc)"
              >
                {{ acc }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <template #foot>
        <button type="button" class="btn" @click="showIntake = false">إلغاء</button>
        <button
          type="button"
          class="btn primary"
          :disabled="intakeSubmitting"
          data-intake-submit
          @click="submitIntake"
        >
          {{
            intakeDeliverNow
              ? 'تسجيل وتحصيل فوراً'
              : 'حفظ التذكرة واستلام الجهاز'
          }}
        </button>
      </template>
    </Modal>

    <!-- نافذة تسليم الجهاز وتحصيل الباقي -->
    <Modal
      v-if="deliverTarget"
      :title="`تسليم وتحصيل — تذكرة ${deliverTarget.ticketNo}`"
      :sub="`${deliverTarget.deviceName} · ${deliverTarget.customerName} (${serviceKindLabel(deliverTarget.serviceKind)})`"
      size="md"
      @close="deliverTarget = null"
    >
      <div style="display: grid; gap: 12px">
        <div v-if="deliverError" class="banner err" role="alert">
          {{ deliverError }}
        </div>

        <div class="form-grid">
          <label class="field">
            <span class="lbl">السعر النهائي للعميل (ج.م) *</span>
            <input
              v-model="deliverFinalPriceEgp"
              type="number"
              min="0"
              class="input"
              :class="{ mono: deliverFinalPriceEgp !== '' }"
              :dir="deliverFinalPriceEgp ? 'ltr' : 'rtl'"
              data-deliver-final-price
            />
          </label>

          <label v-if="canSeeCost" class="field">
            <span class="lbl">
              {{
                deliverTarget.serviceKind === 'software'
                  ? 'التكلفة الداخلية (ج.م)'
                  : 'تكلفة قطع الغيار (ج.م)'
              }}
            </span>
            <input
              v-model="deliverPartsCostEgp"
              type="number"
              min="0"
              class="input"
              :class="{ mono: deliverPartsCostEgp !== '' }"
              :dir="deliverPartsCostEgp ? 'ltr' : 'rtl'"
              data-deliver-parts-cost
            />
          </label>
        </div>

        <div class="card" style="padding: 12px; background: var(--surface-2)">
          <div class="row" style="justify-content: space-between">
            <span class="muted">عربون مدفوع مسبقاً:</span>
            <b class="num">{{ egp(deliverTarget.depositMinor) }}</b>
          </div>
          <div class="row" style="justify-content: space-between; margin-top: 6px">
            <span><b>المطلوب تحصيله دلوقتي:</b></span>
            <strong class="num" style="font-size: 16px" data-deliver-remaining>
              {{ egp(deliverRemainingMinor) }}
            </strong>
          </div>
          <div
            v-if="canSeeCost"
            class="row"
            style="justify-content: space-between; margin-top: 6px"
          >
            <span class="muted">
              صافي ربح
              {{ deliverTarget.serviceKind === 'software' ? 'السوفت وير' : 'الصيانة' }}:
            </span>
            <b class="num ok-txt" data-deliver-net-profit>{{ egp(deliverNetProfitMinor) }}</b>
          </div>
        </div>

        <div class="field">
          <span class="lbl">طريقة تحصيل الباقي</span>
          <div class="seg" role="radiogroup" aria-label="طريقة التحصيل">
            <button
              v-for="m in REPAIR_PAY_METHODS"
              :key="m.id"
              type="button"
              :class="{ active: deliverPayMethod === m.id }"
              :data-deliver-method="m.id"
              @click="deliverPayMethod = m.id"
            >
              {{ m.label }}
            </button>
          </div>
          <WalletNumberChips
            :method="deliverPayMethod"
            v-model="deliverPayWalletId"
            data-deliver-pay-wallet
          />
        </div>

        <div class="form-grid">
          <label class="field">
            <span class="lbl">الفني المسؤول</span>
            <input
              v-model="deliverTech"
              type="text"
              class="input"
              placeholder="اسم الفني"
              data-deliver-tech
            />
          </label>

          <label class="field">
            <span class="lbl">مدة الضمان</span>
            <select v-model="deliverWarrantyDays" class="input" data-deliver-warranty>
              <option
                v-for="w in REPAIR_WARRANTY_OPTIONS"
                :key="w.days"
                :value="w.days"
              >
                {{ w.label }}
              </option>
            </select>
          </label>
        </div>

        <label class="field">
          <span class="lbl">ملاحظات التسليم (اختياري)</span>
          <input
            v-model="deliverNote"
            type="text"
            class="input"
            placeholder="أي ملاحظة عند التسليم..."
            data-deliver-note
          />
        </label>
      </div>

      <template #foot>
        <button type="button" class="btn" @click="deliverTarget = null">إلغاء</button>
        <button
          type="button"
          class="btn primary"
          :disabled="deliverSubmitting"
          data-deliver-confirm
          @click="submitDeliver"
        >
          تأكيد التسليم والتحصيل
        </button>
      </template>
    </Modal>

    <!-- نافذة تفاصيل وتعديل التذكرة المفتوحة -->
    <Modal
      v-if="detailTarget"
      :title="`تفاصيل تذكرة ${detailTarget.ticketNo}`"
      :sub="`${detailTarget.deviceName} · ${detailTarget.customerName}`"
      size="md"
      @close="detailTarget = null"
    >
      <div style="display: grid; gap: 12px">
        <div v-if="detailError" class="banner err" role="alert">
          {{ detailError }}
        </div>

        <div class="form-grid">
          <label class="field">
            <span class="lbl">المرحلة الحالية</span>
            <select v-model="detailStatus" class="input" data-detail-status>
              <option
                v-for="s in REPAIR_KANBAN_STATUSES.filter((st) => st.id !== 'delivered')"
                :key="s.id"
                :value="s.id"
              >
                {{ s.name }}
              </option>
            </select>
          </label>

          <label class="field">
            <span class="lbl">الفني المسؤول</span>
            <input
              v-model="detailTech"
              type="text"
              class="input"
              data-detail-tech
            />
          </label>

          <label class="field">
            <span class="lbl">التكلفة المتوقعة (ج.م)</span>
            <input
              v-model="detailEstPriceEgp"
              type="number"
              min="0"
              class="input"
              :class="{ mono: detailEstPriceEgp !== '' }"
              :dir="detailEstPriceEgp ? 'ltr' : 'rtl'"
              data-detail-price
            />
          </label>

          <label v-if="canSeeCost" class="field">
            <span class="lbl">تكلفة قطع الغيار / التكلفة الداخلية (ج.م)</span>
            <input
              v-model="detailPartsCostEgp"
              type="number"
              min="0"
              class="input"
              :class="{ mono: detailPartsCostEgp !== '' }"
              :dir="detailPartsCostEgp ? 'ltr' : 'rtl'"
              data-detail-parts-cost
            />
          </label>
        </div>

        <label class="field">
          <span class="lbl">ملاحظات الفحص</span>
          <input
            v-model="detailNote"
            type="text"
            class="input"
            placeholder="نتيجة الفحص أو القطعة المطلوبة..."
            data-detail-note
          />
        </label>
      </div>

      <template #foot>
        <button
          type="button"
          class="btn danger ghost"
          :disabled="detailSubmitting"
          data-detail-cancel-ticket
          @click="handleCancelTicket"
        >
          إلغاء التذكرة
        </button>
        <div style="flex: 1"></div>
        <button
          type="button"
          class="btn sm"
          @click="
            const tk = detailTarget;
            detailTarget = null;
            if (tk) openDeliverModal(tk);
          "
        >
          سلّم وحصّل...
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="detailSubmitting"
          data-detail-save
          @click="saveDetailChanges"
        >
          حفظ التعديلات
        </button>
      </template>
    </Modal>
  </div>
</template>
