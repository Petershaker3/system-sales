/**
 * Tauri command bindings for shop wallets and the services ledger
 * (Plan item 1.10, `ADR-025`, `PLAN.md` §9, §12, §16, §19).
 */

import { invoke } from '@tauri-apps/api/core';

export type WalletPayMethod = 'vf' | 'instapay';
export type WalletAlertState = 'ok' | 'low' | 'near' | 'over' | 'neg';
export type WalletOpKind =
  | 'deposit'
  | 'withdraw'
  | 'topup'
  | 'unload'
  | 'move'
  | 'adjust'
  | 'bill'
  | 'card'
  | 'software';
export type WalletVia = 'drawer' | 'out';

export interface WalletRecord {
  readonly id: string;
  readonly name: string;
  readonly number: string;
  readonly color: string;
  readonly openingBalanceMinor: number;
  readonly minAlertMinor: number;
  readonly maxLimitMinor: number;
  readonly dailyLimitMinor: number;
  readonly payMethod: WalletPayMethod | null;
  readonly sort: number;
  readonly hidden: boolean;
  readonly isCustom: boolean;
  readonly createdAt: number;
}

export interface WalletPeriodStats {
  readonly walletId: string;
  readonly opsCount: number;
  readonly depCount: number;
  readonly depMinor: number;
  readonly witCount: number;
  readonly witMinor: number;
  readonly feesMinor: number;
  readonly usedMinor: number;
  readonly salesInMinor: number;
}

export interface WalletSummary {
  readonly wallet: WalletRecord;
  readonly balanceMinor: number;
  readonly state: WalletAlertState;
  readonly today: WalletPeriodStats;
  readonly period: WalletPeriodStats;
}

export interface WalletOp {
  readonly id: string;
  readonly walletId: string | null;
  readonly toWalletId: string | null;
  readonly kind: WalletOpKind;
  readonly via: WalletVia | null;
  readonly serviceType: string | null;
  readonly reference: string | null;
  readonly amountMinor: number;
  readonly feeMinor: number;
  readonly drawerDeltaMinor: number;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly voidedBy: string | null;
  readonly voidedAt: number | null;
  readonly voidReason: string | null;
}

export interface ServicesWindowTotals {
  readonly servicesCount: number;
  readonly servicesFeeMinor: number;
  readonly servicesCashInMinor: number;
  readonly servicesCashOutMinor: number;
  readonly walletDrawerNetMinor: number;
}

export interface WalletsOverview {
  readonly wallets: readonly WalletSummary[];
  readonly ops: readonly WalletOp[];
  readonly servicesWindow: ServicesWindowTotals;
}

export interface UpdateWalletPayload {
  readonly walletId: string;
  readonly name: string;
  readonly number: string;
  readonly color: string;
  readonly openingBalanceMinor: number;
  readonly minAlertMinor: number;
  readonly maxLimitMinor: number;
  readonly dailyLimitMinor: number;
  readonly payMethod: WalletPayMethod | null;
  readonly sort: number;
  readonly hidden: boolean;
}

export function walletsOverview(
  todayFromMs: number,
  periodFromMs: number,
  periodToMs: number,
  walletId: string | null = null,
  limit = 100
): Promise<WalletsOverview> {
  return invoke<WalletsOverview>('wallets_overview', {
    todayFromMs,
    periodFromMs,
    periodToMs,
    walletId,
    limit,
  });
}

export function recordWalletOp(
  walletId: string,
  kind: 'deposit' | 'withdraw',
  amountMinor: number,
  feeMinor: number,
  note: string | null = null
): Promise<WalletOp> {
  return invoke<WalletOp>('record_wallet_op', {
    walletId,
    kind,
    amountMinor,
    feeMinor,
    note,
  });
}

export function recordServiceOp(
  kind: 'bill' | 'card' | 'software',
  serviceType: string,
  reference: string | null,
  amountMinor: number,
  feeMinor: number,
  note: string | null = null
): Promise<WalletOp> {
  return invoke<WalletOp>('record_service_op', {
    kind,
    serviceType,
    reference,
    amountMinor,
    feeMinor,
    note,
  });
}

export function recordWalletMovement(
  kind: 'topup' | 'unload' | 'move',
  walletId: string,
  toWalletId: string | null,
  via: WalletVia | null,
  amountMinor: number,
  note: string | null = null
): Promise<WalletOp> {
  return invoke<WalletOp>('record_wallet_movement', {
    kind,
    walletId,
    toWalletId,
    via,
    amountMinor,
    note,
  });
}

export function reconcileWallet(
  walletId: string,
  realBalanceMinor: number,
  reason: string,
  note: string | null = null
): Promise<WalletOp | null> {
  return invoke<WalletOp | null>('reconcile_wallet', {
    walletId,
    realBalanceMinor,
    reason,
    note,
  });
}

export function voidWalletOp(opId: string, reason: string): Promise<WalletOp> {
  return invoke<WalletOp>('void_wallet_op', { opId, reason });
}

export function createWallet(
  name: string,
  color: string,
  number: string | null = null
): Promise<WalletRecord> {
  return invoke<WalletRecord>('create_wallet', { name, color, number });
}

export function updateWallet(payload: UpdateWalletPayload): Promise<WalletRecord> {
  return invoke<WalletRecord>('update_wallet', { ...payload });
}

export function deleteWallet(walletId: string): Promise<void> {
  return invoke<void>('delete_wallet', { walletId });
}
