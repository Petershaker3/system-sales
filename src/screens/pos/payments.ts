// Pure payment method definitions, Settings normaliser, and POS split-payment
// helpers (`docs/ui/mockup-v1/pos.js`, `docs/ui/mockup-v1/views/settings.js`, `ADR-020`).

import { money } from '../../ui/format.ts';
import type { IconName } from '../../ui/icons.ts';

export type PayMethodId =
  | 'cash'
  | 'vf'
  | 'instapay'
  | 'card'
  | 'install'
  | 'credit';

export interface PayMethodMeta {
  readonly id: PayMethodId;
  readonly name: string;
  readonly hint: string;
  readonly icon: IconName;
  readonly alwaysEnabled?: boolean;
}

export const PAY_METHODS: readonly PayMethodMeta[] = [
  {
    id: 'cash',
    name: 'كاش',
    hint: 'نقدي في الدرج (شغّال دايمًا)',
    icon: 'banknote',
    alwaysEnabled: true,
  },
  {
    id: 'vf',
    name: 'فودافون كاش',
    hint: 'تحويل محفظة (فودافون / اتصالات / أورانج / وي)',
    icon: 'wallet',
  },
  {
    id: 'instapay',
    name: 'إنستاباي',
    hint: 'تحويل فوري على حساب المحل',
    icon: 'zap',
  },
  {
    id: 'card',
    name: 'فيزا / ميزة',
    hint: 'ماكينة الكارت البنكي الخارجية',
    icon: 'credit-card',
  },
  {
    id: 'install',
    name: 'تقسيط',
    hint: 'شركات التقسيط (valU / سهولة / Sympl / حالًا / كونتكت)',
    icon: 'calendar-clock',
  },
  {
    id: 'credit',
    name: 'آجل',
    hint: 'يتسجّل على حساب عميل متسجّل ويظهر رصيده',
    icon: 'notebook-pen',
  },
];

export const INSTALLMENT_PROVIDERS: readonly string[] = [
  'valU',
  'سهولة',
  'Sympl',
  'حالًا',
  'كونتكت',
];

export const DEFAULT_PAY_METHODS = 'cash,vf,instapay,card,install,credit';

export function normalizePayMethods(raw: string | undefined): string {
  if (!raw) return DEFAULT_PAY_METHODS;
  const validIds = new Set<string>(PAY_METHODS.map((m) => m.id));
  const picked = new Set<string>();
  for (const token of raw.split(',')) {
    const clean = token.trim().toLowerCase();
    if (!clean) continue;
    if (!validIds.has(clean)) return DEFAULT_PAY_METHODS;
    picked.add(clean);
  }
  if (!picked.has('cash')) return DEFAULT_PAY_METHODS;
  return PAY_METHODS.map((m) => m.id)
    .filter((id) => picked.has(id))
    .join(',');
}

export function isPayMethodEnabled(
  id: PayMethodId,
  raw: string = DEFAULT_PAY_METHODS
): boolean {
  if (id === 'cash') return true;
  const normalized = normalizePayMethods(raw);
  return normalized.split(',').includes(id);
}

export function enabledPayMethods(
  raw: string = DEFAULT_PAY_METHODS
): PayMethodMeta[] {
  return PAY_METHODS.filter((m) => isPayMethodEnabled(m.id, raw));
}

export interface DraftPayment {
  readonly method: PayMethodId;
  readonly amountMinor: number;
  readonly reference?: string | null;
  /**
   * The shop wallet number that took this part of the money (`ADR-041`). Left out or null means
   * "the primary for the method", which is what a shop holding one number per method always
   * meant — so a draft that never asks the question still records the same money as before.
   */
  readonly walletId?: string | null;
}

/** Total piastres already added to the split-payment list. */
export function paidSoFar(payments: readonly DraftPayment[]): number {
  let sum = 0;
  for (const p of payments) sum += p.amountMinor;
  return sum;
}

/** Remaining piastres still due on the invoice after `payments`. */
export function remainingDue(
  totalMinor: number,
  payments: readonly DraftPayment[]
): number {
  return Math.max(0, totalMinor - paidSoFar(payments));
}

/** Quick cash note suggestions in piastres (`docs/ui/mockup-v1/pos.js`, `cashSuggestions`). */
export function cashSuggestions(dueMinor: number): number[] {
  if (dueMinor <= 0) return [0];
  const out = new Set<number>([dueMinor]);
  for (const step of [50_00, 100_00, 200_00, 500_00, 1000_00]) {
    const up = Math.ceil(dueMinor / step) * step;
    if (up > dueMinor) out.add(up);
    if (out.size >= 5) break;
  }
  return [...out].sort((a, b) => a - b);
}

/** Human-readable Arabic label for one payment row. */
export function methodLabel(
  method: PayMethodId,
  reference?: string | null
): string {
  const base = PAY_METHODS.find((m) => m.id === method)?.name ?? method;
  const cleanRef = reference?.trim();
  if (method === 'install' && cleanRef) {
    return `${base} (${cleanRef})`;
  }
  return base;
}

/** Summary line shown on «تم البيع» after payment completes. */
export function paymentsSummaryText(payments: readonly DraftPayment[]): string {
  if (payments.length === 0) return 'كاش';
  if (payments.length === 1) {
    const first = payments[0]!;
    return methodLabel(first.method, first.reference);
  }
  return payments
    .map((p) => `${money(p.amountMinor)} ${methodLabel(p.method, p.reference)}`)
    .join(' + ');
}
