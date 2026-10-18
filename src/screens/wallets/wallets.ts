/**
 * Pure domain helpers and presets for shop wallets and the services ledger
 * (Plan item 1.10, `ADR-025`, `docs/ui/mockup-v1/views/wallets.js`, `docs/ui/mockup-v1/pos.js`).
 */

import type { WalletAlertState, WalletOp, WalletPayMethod } from '../../api/wallet.ts';
import type { ServiceFeeMode } from '../../ui/appearance.ts';
import { parseMoney } from '../../ui/format.ts';

export const WALLET_PRESETS = [
  { name: 'فودافون كاش', color: '#e60000' },
  { name: 'اتصالات كاش', color: '#5cb85c' },
  { name: 'أورنج كاش', color: '#ff7900' },
  { name: 'وي باي', color: '#6b2fb5' },
  { name: 'إنستاباي', color: '#6b3fa0' },
  { name: 'حساب بنك', color: '#1d4f91' },
  { name: 'محفظة تانية', color: '#0d7377' },
] as const;

export const WALLET_PAY_OPTIONS: ReadonlyArray<{
  readonly id: WalletPayMethod | '';
  readonly name: string;
}> = [
  { id: '', name: 'لأ' },
  { id: 'vf', name: 'فودافون كاش' },
  { id: 'instapay', name: 'إنستاباي' },
];

export const TELECOM_OPERATORS = [
  { id: 'vf', name: 'فودافون', color: '#e60000' },
  { id: 'or', name: 'أورنج', color: '#ff7900' },
  { id: 'et', name: 'اتصالات', color: '#5cb85c' },
  { id: 'we', name: 'WE', color: '#6b2fb5' },
] as const;

export const RECHARGE_CARD_VALUES = [10, 15, 25, 50, 100, 200] as const;

export const BILL_TYPES = [
  { id: 'net', name: 'إنترنت أرضي', icon: 'wifi' },
  { id: 'land', name: 'تليفون أرضي', icon: 'phone' },
  { id: 'elec', name: 'كهرباء', icon: 'zap' },
  { id: 'water', name: 'مياه', icon: 'droplets' },
  { id: 'gas', name: 'غاز', icon: 'flame' },
] as const;

export const SOFTWARE_PRESETS = [
  { name: 'فورمات وتحديث', feeEgp: '100' },
  { name: 'نقل بيانات', feeEgp: '100' },
  { name: 'تخطي حساب FRP', feeEgp: '200' },
  { name: 'تعريب وتفليش', feeEgp: '150' },
  { name: 'إنشاء حساب وضبط', feeEgp: '50' },
] as const;

export const RECONCILE_REASONS = [
  'رسوم الشبكة',
  'عملية ماتسجّلتش',
  'غلط في عملية',
  'سبب تاني',
] as const;

export type WalletPeriodKey = 'today' | 'yesterday' | 'month' | 'lastMonth';

export const WALLET_PERIODS: ReadonlyArray<{
  readonly k: WalletPeriodKey;
  readonly label: string;
}> = [
  { k: 'today', label: 'النهارده' },
  { k: 'yesterday', label: 'امبارح' },
  { k: 'month', label: 'الشهر ده' },
  { k: 'lastMonth', label: 'الشهر اللي فات' },
];

/** Compute automatic wallet commission in minor units (`max(feeMinMinor, round(amountMinor * feePct / 100))`). */
export function computeAutoWalletFeeMinor(
  amountMinor: number,
  feePct: number,
  feeMinMinor: number
): number {
  if (amountMinor <= 0) return 0;
  const pct = Math.max(0, Math.min(20, Math.floor(feePct || 0)));
  const minMinor = Math.max(0, Math.floor(feeMinMinor || 0));
  const pctFee = Math.round((amountMinor * pct) / 100);
  return Math.max(minMinor, pctFee);
}

/**
 * Parse the typed commission input according to the shop's `serviceFeeMode`.
 * - In `'manual'` mode, an empty string returns `null` (must be typed explicitly; `'0'` is valid).
 * - In `'auto'` mode, an empty string falls back to `autoDefaultMinor`.
 */
export function resolveServiceFeeMinor(
  rawInput: string,
  mode: ServiceFeeMode,
  autoDefaultMinor: number
): number | null {
  const trimmed = rawInput.trim();
  if (trimmed === '') {
    return mode === 'auto' ? Math.max(0, autoDefaultMinor) : null;
  }
  const parsed = parseMoney(trimmed);
  if (parsed === null || parsed < 0) {
    return null;
  }
  return parsed;
}

/** Compute wallet balance after a customer deposit or withdrawal (`deposit` subtracts, `withdraw` adds). */
export function walletBalanceAfterCustomerOp(
  currentBalanceMinor: number,
  kind: 'deposit' | 'withdraw',
  amountMinor: number
): number {
  const amt = Math.max(0, amountMinor);
  return kind === 'deposit' ? currentBalanceMinor - amt : currentBalanceMinor + amt;
}

/** Compute drawer cash movement for a customer deposit or withdrawal (`deposit` -> `+(amount + fee)`, `withdraw` -> `-(amount - fee)`). */
export function drawerCashDeltaForCustomerOp(
  kind: 'deposit' | 'withdraw',
  amountMinor: number,
  feeMinor: number
): number {
  const amt = Math.max(0, amountMinor);
  const fee = Math.max(0, feeMinor);
  return kind === 'deposit' ? amt + fee : -(amt - fee);
}

/** Classify a wallet's balance against its configured `minAlertMinor` and `maxLimitMinor`. */
export function computeWalletAlertState(
  balanceMinor: number,
  minAlertMinor: number,
  maxLimitMinor: number
): WalletAlertState {
  if (balanceMinor < 0) return 'neg';
  if (maxLimitMinor > 0 && balanceMinor > maxLimitMinor) return 'over';
  if (maxLimitMinor > 0 && balanceMinor >= Math.floor((maxLimitMinor * 9) / 10)) {
    return 'near';
  }
  if (minAlertMinor > 0 && balanceMinor < minAlertMinor) return 'low';
  return 'ok';
}

export function walletStateBadge(state: WalletAlertState): {
  readonly label: string;
  readonly cls: 'danger' | 'warn';
} | null {
  switch (state) {
    case 'neg':
      return { label: 'بالسالب', cls: 'danger' };
    case 'over':
      return { label: 'عدّت أقصى رصيد', cls: 'danger' };
    case 'near':
      return { label: 'قرّبت من أقصى رصيد', cls: 'warn' };
    case 'low':
      return { label: 'قربت تخلص', cls: 'warn' };
    default:
      return null;
  }
}

/** Signed wallet balance delta for displaying a row in `.wl-log`. */
export function opWalletDeltaMinor(
  op: WalletOp,
  selectedWalletId: string | null = null
): number | null {
  switch (op.kind) {
    case 'deposit':
    case 'unload':
      return -op.amountMinor;
    case 'withdraw':
    case 'topup':
      return op.amountMinor;
    case 'adjust':
      return op.amountMinor;
    case 'move':
      if (selectedWalletId && op.toWalletId === selectedWalletId) {
        return op.amountMinor;
      }
      if (selectedWalletId && op.walletId === selectedWalletId) {
        return -op.amountMinor;
      }
      return -op.amountMinor;
    default:
      return null;
  }
}

/** Compute millisecond boundaries (`todayFromMs`, `periodFromMs`, `periodToMs`) for a period key. */
export function resolveWalletPeriodBounds(
  period: WalletPeriodKey,
  now: Date = new Date()
): {
  readonly todayFromMs: number;
  readonly periodFromMs: number;
  readonly periodToMs: number;
} {
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0,
    0,
    0,
    0
  );
  const endOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999
  );
  const todayFromMs = startOfToday.getTime();

  if (period === 'today') {
    return {
      todayFromMs,
      periodFromMs: todayFromMs,
      periodToMs: endOfToday.getTime(),
    };
  }
  if (period === 'yesterday') {
    const yStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      0,
      0,
      0,
      0
    );
    const yEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - 1,
      23,
      59,
      59,
      999
    );
    return {
      todayFromMs,
      periodFromMs: yStart.getTime(),
      periodToMs: yEnd.getTime(),
    };
  }
  if (period === 'month') {
    const mStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    return {
      todayFromMs,
      periodFromMs: mStart.getTime(),
      periodToMs: endOfToday.getTime(),
    };
  }
  const lmStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
  const lmEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
  return {
    todayFromMs,
    periodFromMs: lmStart.getTime(),
    periodToMs: lmEnd.getTime(),
  };
}
