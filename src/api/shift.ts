/**
 * Tauri command bindings for shifts, drawer expenses, and cash movements
 * (Plan item 1.9, `ADR-024`, `PLAN.md` §12).
 */

import { invoke } from '@tauri-apps/api/core';

export type ShiftStatus = 'open' | 'closed';
export type CashMovementKind = 'cash_in' | 'owner_draw';

export interface ShiftRecord {
  readonly id: string;
  readonly shiftNumber: number;
  readonly status: ShiftStatus;
  readonly openingCashMinor: number;
  readonly expectedCashMinor: number | null;
  readonly countedCashMinor: number | null;
  readonly differenceMinor: number | null;
  readonly closeNote: string | null;
  readonly openedBy: string;
  readonly openedAt: number;
  readonly closedBy: string | null;
  readonly closedAt: number | null;
}

export interface ShiftTotals {
  /** Missing or false means timestamp-derived and not financially reconciled. */
  readonly cashReconciled?: boolean;
  readonly openingCashMinor: number;
  readonly cashSalesMinor: number;
  readonly vfSalesMinor: number;
  readonly instapaySalesMinor: number;
  readonly cardSalesMinor: number;
  readonly installSalesMinor: number;
  readonly creditSalesMinor: number;
  readonly salesTotalMinor: number;
  readonly salesCostMinor: number;
  readonly salesCount: number;
  readonly customerCashInMinor: number;
  readonly servicesCount: number;
  readonly servicesFeeMinor: number;
  readonly servicesCashInMinor: number;
  readonly servicesCashOutMinor: number;
  readonly walletDrawerNetMinor: number;
  readonly drawerTransferNetMinor: number;
  readonly cashInMinor: number;
  readonly ownerDrawMinor: number;
  readonly expensesMinor: number;
  readonly expectedCashMinor: number;
  readonly grossProfitMinor: number;
  readonly netProfitMinor: number;
}

export interface ExpenseRecord {
  readonly id: string;
  /** `null` when the money did not leave the drawer (`ADR-043`). */
  readonly shiftId: string | null;
  /** `'drawer'` or `'outside'`; only a drawer row reduces a shift's cash. */
  readonly paidFrom: 'drawer' | 'outside';
  readonly category: string;
  readonly amountMinor: number;
  readonly note: string | null;
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface CashMovementRecord {
  readonly id: string;
  readonly shiftId: string;
  readonly kind: CashMovementKind;
  readonly amountMinor: number;
  readonly reason: string;
  readonly createdBy: string;
  readonly createdAt: number;
}

export interface ShiftSummary {
  readonly shift: ShiftRecord;
  readonly totals: ShiftTotals;
  readonly expenses: readonly ExpenseRecord[];
  readonly cashMovements: readonly CashMovementRecord[];
}

export interface CurrentShiftState {
  readonly openShift: ShiftSummary | null;
  readonly lastClosedShift: ShiftRecord | null;
  readonly recentClosedShifts: readonly ShiftRecord[];
}

export function currentShiftSummary(): Promise<CurrentShiftState> {
  return invoke<CurrentShiftState>('current_shift_summary');
}

export function openShift(openingCashMinor: number): Promise<ShiftSummary> {
  return invoke<ShiftSummary>('open_shift', { openingCashMinor });
}

export function recordExpense(
  category: string,
  amountMinor: number,
  note: string | null = null
): Promise<ShiftSummary> {
  return invoke<ShiftSummary>('record_expense', { category, amountMinor, note });
}

export function recordCashMovement(
  kind: CashMovementKind,
  amountMinor: number,
  reason: string
): Promise<ShiftSummary> {
  return invoke<ShiftSummary>('record_cash_movement', { kind, amountMinor, reason });
}

export function closeShift(
  shiftId: string,
  countedCashMinor: number,
  closeNote: string | null = null
): Promise<ShiftSummary> {
  return invoke<ShiftSummary>('close_shift', { shiftId, countedCashMinor, closeNote });
}

/** A physical observation, not a verified drawer balance or shift closing. */
export interface ShiftCashCount {
  readonly id: string;
  readonly shiftId: string;
  readonly amountMinor: number;
  readonly countedBy: string;
  readonly countedAt: number;
}
export function recordShiftCashCount(amountMinor: number): Promise<ShiftCashCount> {
  return invoke<ShiftCashCount>('record_shift_cash_count', { amountMinor });
}
export function latestShiftCashCount(): Promise<ShiftCashCount | null> {
  return invoke<ShiftCashCount | null>('latest_shift_cash_count');
}

/** Partial source-linked records, not a cash balance or reconciliation. */
export interface CashDrawerIdentity {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: number;
  readonly isDefault: boolean;
}
export interface CashSourcePosting {
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly shiftId: string | null;
  readonly drawerId: string | null;
  readonly signedMinor: number;
  readonly actorId: string;
  readonly occurredAt: number;
}
export interface DrawerPhysicalCount {
  readonly requestId: string;
  readonly drawerId: string;
  readonly shiftId: string | null;
  readonly amountMinor: number;
  readonly countedBy: string;
  readonly countedAt: number;
}
export interface UncertainRepairRefund {
  readonly repairId: string;
  readonly ticketNo: string;
  readonly shiftId: string | null;
  readonly amountMinor: number;
  readonly actorId: string;
  readonly occurredAt: number;
}
export interface RepairCashRefundReview {
  readonly requestId: string;
  readonly repairId: string;
  readonly shiftId: string;
  readonly drawerId: string;
  readonly payoutAt: number;
  readonly evidence: string;
  readonly actorId: string;
  readonly reviewedAt: number;
}
export interface CashPostingPreview {
  readonly repairCashRefundReviews: RepairCashRefundReview[];
  readonly uncertainRepairRefunds: UncertainRepairRefund[];
  readonly uncertainRepairRefundCount: number;
  readonly drawers: CashDrawerIdentity[];
  readonly recentPostings: CashSourcePosting[];
  readonly recentCounts: DrawerPhysicalCount[];
  readonly complete: false;
}
export function cashPostingPreview(): Promise<CashPostingPreview> {
  return invoke('cash_posting_preview');
}
export function configureDrawer(drawerId: string, name: string, requestId: string): Promise<void> {
  return invoke('configure_drawer', { drawerId, name, requestId });
}

export function transferDrawerCash(shiftId: string, toDrawerId: string, amountMinor: number, reason: string, requestId: string): Promise<void> {
  return invoke('transfer_drawer_cash', { shiftId, toDrawerId, amountMinor, reason, requestId });
}

export function recordDrawerPhysicalCount(drawerId: string, amountMinor: number, requestId: string): Promise<DrawerPhysicalCount> {
  return invoke('record_drawer_physical_count', { drawerId, amountMinor, requestId });
}

export function reviewRepairCashRefund(requestId: string, repairId: string, shiftId: string, drawerId: string, payoutAt: number, evidence: string): Promise<RepairCashRefundReview> {
  return invoke('review_repair_cash_refund', { requestId, repairId, shiftId, drawerId, payoutAt, evidence });
}
