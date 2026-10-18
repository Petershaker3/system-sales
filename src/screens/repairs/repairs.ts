import type {
  RepairPayMethod,
  RepairServiceKind,
  RepairStatusId,
  RepairTicket,
} from '../../api/repairs.ts';
import { normalize as normalizeArabic } from '../../ui/arabic.ts';

export interface RepairStatusMeta {
  readonly id: RepairStatusId;
  readonly name: string;
  readonly tone: 'info' | 'warn' | 'ok' | 'muted';
}

export const REPAIR_KANBAN_STATUSES: readonly RepairStatusMeta[] = [
  { id: 'received', name: 'استلام', tone: 'info' },
  { id: 'diagnosing', name: 'فحص', tone: 'warn' },
  { id: 'waiting', name: 'مستني قطعة / موافقة', tone: 'warn' },
  { id: 'ready', name: 'جاهز للتسليم', tone: 'ok' },
  { id: 'delivered', name: 'اتسلّم', tone: 'muted' },
] as const;

export const HARDWARE_QUICK_ISSUES: readonly string[] = [
  'شاشة',
  'بطارية',
  'سوكت شحن',
  'فلاتة شحن',
  'فلاتة باور',
  'كاميرا',
  'بصمة',
  'سماعة / مايك',
  'مياه',
] as const;

export const SOFTWARE_QUICK_ISSUES: readonly string[] = [
  'فورمات وتحديث',
  'تخطي حساب جوجل FRP',
  'فك رمز / باسورد',
  'تفليش كامل / روم',
  'نقل بيانات ونسخ احتياطي',
  'تعريب وتطبيقات',
  'حساب آي كلاود / أبل ID',
] as const;

export const REPAIR_ACCESSORIES: readonly string[] = [
  'شاحن',
  'جراب',
  'شريحة',
  'ميموري',
  'علبة',
] as const;

export const REPAIR_DUE_OPTIONS: readonly string[] = [
  'النهارده',
  'بكره',
  'بعده',
] as const;

export interface RepairWarrantyOption {
  readonly days: number;
  readonly label: string;
}

export const REPAIR_WARRANTY_OPTIONS: readonly RepairWarrantyOption[] = [
  { days: 0, label: 'بدون ضمان' },
  { days: 7, label: '7 أيام' },
  { days: 14, label: '14 يوم' },
  { days: 30, label: '30 يوم' },
  { days: 90, label: '90 يوم' },
] as const;

export interface RepairPayMethodOption {
  readonly id: RepairPayMethod;
  readonly label: string;
}

export const REPAIR_PAY_METHODS: readonly RepairPayMethodOption[] = [
  { id: 'cash', label: 'كاش (الدرج)' },
  { id: 'vf', label: 'فودافون كاش' },
  { id: 'instapay', label: 'إنستاباي' },
  { id: 'card', label: 'كارت' },
] as const;

export type RepairPeriodId = 'today' | 'yesterday' | 'week' | 'month' | 'all';

export interface RepairPeriodRange {
  readonly fromTs: number | null;
  readonly toTs: number | null;
}

export function repairPeriodRange(
  period: RepairPeriodId,
  nowMs: number = Date.now()
): RepairPeriodRange {
  if (period === 'all') {
    return { fromTs: null, toTs: null };
  }
  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const endOfToday = startOfToday + 86_400_000 - 1;
  if (period === 'today') {
    return { fromTs: startOfToday, toTs: endOfToday };
  }
  if (period === 'yesterday') {
    return {
      fromTs: startOfToday - 86_400_000,
      toTs: startOfToday - 1,
    };
  }
  if (period === 'week') {
    return {
      fromTs: startOfToday - 6 * 86_400_000,
      toTs: endOfToday,
    };
  }
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    fromTs: startOfMonth,
    toTs: endOfToday,
  };
}

export function nextKanbanStatus(status: RepairStatusId): RepairStatusId | null {
  switch (status) {
    case 'received':
      return 'diagnosing';
    case 'diagnosing':
      return 'waiting';
    case 'waiting':
      return 'ready';
    default:
      return null;
  }
}

export function serviceKindLabel(kind: RepairServiceKind): string {
  return kind === 'software' ? 'سوفت وير' : 'صيانة هاردوير';
}

export function payMethodLabel(method: RepairPayMethod | string): string {
  switch (method) {
    case 'vf':
      return 'فودافون كاش';
    case 'instapay':
      return 'إنستاباي';
    case 'card':
      return 'كارت';
    default:
      return 'كاش';
  }
}

export function filterRepairTickets(
  tickets: readonly RepairTicket[],
  query: string,
  kindFilter: 'all' | RepairServiceKind,
  techFilter: string
): RepairTicket[] {
  const q = normalizeArabic(query);
  const techNorm = normalizeArabic(techFilter);
  return tickets.filter((t) => {
    if (kindFilter !== 'all' && t.serviceKind !== kindFilter) {
      return false;
    }
    if (techNorm !== '' && techFilter !== 'all') {
      const tName = normalizeArabic(t.technicianName ?? '');
      if (tName !== techNorm) {
        return false;
      }
    }
    if (!q) {
      return true;
    }
    const hay = normalizeArabic(
      `${t.ticketNo} ${t.customerName} ${t.customerPhone} ${t.deviceName} ${t.issue} ${t.technicianName ?? ''} ${t.imei ?? ''} ${t.note}`
    );
    return hay.includes(q);
  });
}

export function normalizeEgyptianWhatsAppPhone(raw: string): string | null {
  const digits = raw.replace(/\D+/g, '');
  if (/^01[0125]\d{8}$/.test(digits)) {
    return `2${digits}`;
  }
  if (/^201[0125]\d{8}$/.test(digits)) {
    return digits;
  }
  return null;
}

export function buildRepairWhatsAppUrl(
  ticket: RepairTicket,
  shopName: string,
  kind: 'intake' | 'ready' | 'delivered'
): string | null {
  const phone = normalizeEgyptianWhatsAppPhone(ticket.customerPhone);
  if (!phone) {
    return null;
  }
  const track = ticket.serviceKind === 'software' ? 'السوفت وير' : 'الصيانة';
  const estEgp = Math.round(ticket.estimatedPriceMinor / 100);
  const finalEgp = Math.round((ticket.finalPriceMinor || ticket.estimatedPriceMinor) / 100);
  const depEgp = Math.round(ticket.depositMinor / 100);
  const remEgp = Math.max(0, finalEgp - depEgp);

  let text = '';
  if (kind === 'intake') {
    text =
      `أهلاً أ/ ${ticket.customerName}، تم استلام جهازك (${ticket.deviceName}) في ${shopName} — قسم ${track}.\n` +
      `رقم التذكرة: ${ticket.ticketNo}\n` +
      `البيان: ${ticket.issue}\n` +
      `التكلفة المتوقعة: ${estEgp} ج.م` +
      (depEgp > 0 ? ` (مدفوع عربون ${depEgp} ج.م والباقي ${remEgp} ج.م)` : '') +
      `\nالموعد المتوقع: ${ticket.dueLabel}`;
  } else if (kind === 'ready') {
    text =
      `أهلاً أ/ ${ticket.customerName}، جهازك (${ticket.deviceName}) بقى جاهز للاستلام في ${shopName}!\n` +
      `رقم التذكرة: ${ticket.ticketNo}\n` +
      `المطلوب عند الاستلام: ${remEgp} ج.م\n` +
      `تنورنا في أي وقت.`;
  } else {
    text =
      `شكراً لزيارتك ${shopName} أ/ ${ticket.customerName}!\n` +
      `تم تسليم جهاز (${ticket.deviceName}) — تذكرة ${ticket.ticketNo} (${track}).\n` +
      `إجمالي الحساب: ${finalEgp} ج.م` +
      (ticket.warrantyDays > 0 ? `\nضمان ${track}: ${ticket.warrantyDays} يوم.` : '');
  }
  return `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
}
