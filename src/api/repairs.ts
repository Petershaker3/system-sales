import { invoke } from '@tauri-apps/api/core';

export type RepairServiceKind = 'hardware' | 'software';
export type RepairStatusId =
  | 'received'
  | 'diagnosing'
  | 'waiting'
  | 'ready'
  | 'delivered'
  | 'cancelled';
export type RepairPayMethod = 'cash' | 'vf' | 'instapay' | 'card';

export interface RepairTicket {
  readonly id: string;
  readonly ticketNo: string;
  readonly serviceKind: RepairServiceKind;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly deviceName: string;
  readonly imei: string | null;
  readonly deviceLock: string;
  readonly issue: string;
  readonly accessories: string;
  readonly dueLabel: string;
  readonly status: RepairStatusId;
  readonly estimatedPriceMinor: number;
  readonly finalPriceMinor: number;
  readonly partsCostMinor: number | null;
  readonly netProfitMinor: number | null;
  readonly depositMinor: number;
  readonly collectedMinor: number;
  readonly remainingMinor: number;
  readonly payMethod: RepairPayMethod;
  readonly technicianName: string | null;
  readonly warrantyDays: number;
  readonly note: string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly createdAt: number;
  readonly deliveredAt: number | null;
}

export interface RepairKindFinancialBucket {
  readonly serviceKind: string;
  readonly ticketsCount: number;
  readonly openCount: number;
  readonly readyCount: number;
  readonly deliveredCount: number;
  readonly depositCollectedMinor: number;
  readonly deliveryCollectedMinor: number;
  readonly totalRevenueMinor: number;
  readonly cashCollectedMinor: number;
  readonly vfCollectedMinor: number;
  readonly instapayCollectedMinor: number;
  readonly cardCollectedMinor: number;
  readonly partsCostMinor: number | null;
  readonly netProfitMinor: number | null;
}

export interface RepairTechnicianSummary {
  readonly technicianName: string;
  readonly hardwareCount: number;
  readonly softwareCount: number;
  readonly deliveredCount: number;
  readonly hardwareRevenueMinor: number;
  readonly softwareRevenueMinor: number;
  readonly totalRevenueMinor: number;
  readonly partsCostMinor: number | null;
  readonly netProfitMinor: number | null;
}

export interface RepairsOverview {
  readonly tickets: readonly RepairTicket[];
  readonly hardware: RepairKindFinancialBucket;
  readonly software: RepairKindFinancialBucket;
  readonly combined: RepairKindFinancialBucket;
  readonly technicians: readonly RepairTechnicianSummary[];
}

export interface CreateRepairParams {
  readonly serviceKind: RepairServiceKind;
  readonly customerName: string;
  readonly customerPhone: string;
  readonly deviceName: string;
  readonly imei?: string | null;
  readonly deviceLock?: string | null;
  readonly issue: string;
  readonly accessories?: string | null;
  readonly dueLabel?: string | null;
  readonly estimatedPriceMinor: number;
  readonly partsCostMinor?: number | null;
  readonly depositMinor: number;
  readonly payMethod?: RepairPayMethod | null;
  /** The wallet number that took the money (`ADR-041`). */
  readonly payWalletId?: string | null;
  readonly technicianName?: string | null;
  readonly warrantyDays?: number | null;
  readonly note?: string | null;
  readonly deliverNow?: boolean;
}

export interface UpdateRepairStatusParams {
  readonly id: string;
  readonly status: RepairStatusId;
  readonly technicianName?: string | null;
  readonly estimatedPriceMinor?: number | null;
  readonly partsCostMinor?: number | null;
  readonly note?: string | null;
}

export interface DeliverRepairParams {
  readonly id: string;
  readonly finalPriceMinor: number;
  readonly partsCostMinor?: number | null;
  readonly payMethod: RepairPayMethod;
  /** The wallet number the remaining amount is collected into (`ADR-041`). */
  readonly payWalletId?: string | null;
  readonly technicianName?: string | null;
  readonly warrantyDays?: number | null;
  readonly note?: string | null;
}

export async function repairsOverview(params?: {
  readonly fromTs?: number | null;
  readonly toTs?: number | null;
}): Promise<RepairsOverview> {
  return invoke<RepairsOverview>('repairs_overview', {
    fromTs: params?.fromTs ?? null,
    toTs: params?.toTs ?? null,
  });
}

export async function createRepair(params: CreateRepairParams): Promise<RepairTicket> {
  return invoke<RepairTicket>('create_repair', {
    serviceKind: params.serviceKind,
    customerName: params.customerName,
    customerPhone: params.customerPhone,
    deviceName: params.deviceName,
    imei: params.imei ?? null,
    deviceLock: params.deviceLock ?? null,
    issue: params.issue,
    accessories: params.accessories ?? null,
    dueLabel: params.dueLabel ?? null,
    estimatedPriceMinor: params.estimatedPriceMinor,
    partsCostMinor: params.partsCostMinor ?? null,
    depositMinor: params.depositMinor,
    payMethod: params.payMethod ?? 'cash',
    payWalletId: params.payWalletId ?? null,
    technicianName: params.technicianName ?? null,
    warrantyDays: params.warrantyDays ?? null,
    note: params.note ?? null,
    deliverNow: params.deliverNow ?? false,
  });
}

export async function updateRepairStatus(params: UpdateRepairStatusParams): Promise<RepairTicket> {
  return invoke<RepairTicket>('update_repair_status', {
    id: params.id,
    status: params.status,
    technicianName: params.technicianName ?? null,
    estimatedPriceMinor: params.estimatedPriceMinor ?? null,
    partsCostMinor: params.partsCostMinor ?? null,
    note: params.note ?? null,
  });
}

export async function deliverRepair(params: DeliverRepairParams): Promise<RepairTicket> {
  return invoke<RepairTicket>('deliver_repair', {
    id: params.id,
    finalPriceMinor: params.finalPriceMinor,
    partsCostMinor: params.partsCostMinor ?? null,
    payMethod: params.payMethod,
    payWalletId: params.payWalletId ?? null,
    technicianName: params.technicianName ?? null,
    warrantyDays: params.warrantyDays ?? null,
    note: params.note ?? null,
  });
}

export async function cancelRepair(id: string, note?: string | null): Promise<RepairTicket> {
  return invoke<RepairTicket>('cancel_repair', {
    id,
    note: note ?? null,
  });
}
