// Tauri invoke wrapper for the LAN Companion Server & Mobile Helper (`ADR-037`, Plan item 3.2).

import { invoke } from '@tauri-apps/api/core';

export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly pairedAt: number;
  readonly lastSeenAt: number;
  readonly online: boolean;
}

export interface CompanionScanItem {
  readonly id: string;
  readonly target: 'pos' | 'receive';
  readonly code: string;
  readonly productId: string | null;
  readonly productName: string | null;
  readonly deviceName: string;
  readonly scannedAt: number;
}

export interface CompanionStatus {
  readonly hostIp: string;
  readonly port: number;
  readonly pairCode: string;
  readonly pairPayload: string;
  readonly running: boolean;
  readonly pairedDevices: readonly PairedDevice[];
  readonly pendingScans: readonly CompanionScanItem[];
}

export async function companionOverview(): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('companion_overview');
}

export async function pairCompanionDevice(
  name: string,
  model: string,
): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('pair_companion_device', { name, model });
}

export async function unpairCompanionDevice(
  deviceId: string,
): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('unpair_companion_device', { deviceId });
}

export async function pushCompanionScan(input: {
  target: 'pos' | 'receive';
  code: string;
  productId?: string | null;
  productName?: string | null;
  deviceName?: string;
}): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('push_companion_scan', {
    target: input.target,
    code: input.code,
    productId: input.productId ?? null,
    productName: input.productName ?? null,
    deviceName: input.deviceName ?? 'موبايل المحل',
  });
}

export async function consumeCompanionScans(
  target: 'pos' | 'receive',
): Promise<CompanionScanItem[]> {
  return invoke<CompanionScanItem[]>('consume_companion_scans', { target });
}
