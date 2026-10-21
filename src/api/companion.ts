// Tauri invoke wrapper for the LAN companion server & the phone capture link
// (`ADR-037`, `ADR-042`, Plan item 3.2).
//
// Two roles on one page (`ADR-042`): the computer *hosts* the link — it is the side
// with the database, the pairing QR, and the inbox of captures waiting to be
// applied — and the handset *dials* it, holding its own captures until the computer
// takes them. Every function below is legal on either side; which ones a screen
// calls is the difference between the two.

import { invoke } from '@tauri-apps/api/core';

export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly pairedAt: number;
  /**
   * Last moment the computer heard from this handset. `0` means it has never
   * spoken, which is what a hand-typed pairing looks like (`ADR-042`).
   */
  readonly lastSeenAt: number;
  /** Derived from `lastSeenAt` by the service, never stored as a wish. */
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

/**
 * One capture made on the phone. The same shape is the phone's outbox row, the
 * body of the LAN push, and the desktop's inbox row (`ADR-042`).
 */
export interface CompanionIntakeDraft {
  readonly id: string;
  /**
   * `'product'` for a stock capture, `'expense'` for money that left the shop
   * (`ADR-043`). An older queue row carries `''`, which is a product.
   */
  readonly kind: string;
  readonly pairCode: string;
  readonly deviceName: string;
  readonly createdAt: number;
  readonly disposition: string;
  readonly productName: string;
  readonly barcode: string;
  readonly quantity: number;
  readonly unitCostMinor: number;
  readonly imeis: readonly string[];
  /** `data:` URLs of thumbnails, already shrunk on the phone. */
  readonly photos: readonly string[];
  readonly productId: string | null;
  readonly receiptId: string | null;
  readonly pushedAt: number | null;
  readonly pushError: string | null;
  readonly note: string | null;
  /** Expense drafts only: the category as the shopkeeper typed it. */
  readonly expenseCategory: string;
  /** Expense drafts only: piastres, always positive. */
  readonly expenseAmountMinor: number;
  /** Expense drafts only: `'drawer'` or `'outside'`. */
  readonly expensePaidFrom: string;
  /** Expense drafts only: the free line explaining what the money bought. */
  readonly expenseNote: string;
}

/** What a connection test actually measured (`ADR-042`). */
export interface CompanionProbe {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly detail: string;
}

/** A hand-rolled round trip plus the status that follows it. */
export interface CompanionLinkResult {
  readonly ok: boolean;
  readonly detail: string;
  readonly status: CompanionStatus;
}

export interface CompanionIntakeApplied {
  readonly status: CompanionStatus;
  readonly draft: CompanionIntakeDraft;
}

export interface CompanionStatus {
  readonly hostIp: string;
  readonly port: number;
  readonly pairCode: string;
  readonly pairPayload: string;
  /** The responder reports its own bind; a port someone else took is not "running". */
  readonly running: boolean;
  readonly pairedDevices: readonly PairedDevice[];
  readonly pendingScans: readonly CompanionScanItem[];
  /** Captures the phone pushed that the computer has not applied yet. */
  readonly pendingIntakes: readonly CompanionIntakeDraft[];
  /** This device's own queue: on the handset, what is waiting to be sent. */
  readonly outbox: readonly CompanionIntakeDraft[];
  /** Pushes turned away for the wrong pair code, so a knock is visible (`ADR-042`). */
  readonly rejectedPushes: number;
  readonly remoteEnabled: boolean;
  readonly remoteCode: string;
  readonly remotePayload: string;
  /** The computer this handset sends to (`ip:port`); `''` when it has none. */
  readonly remoteHost: string;
  /** The last moment data really moved. Absent means it never has. */
  readonly lastLinkAt: number | null;
}

export async function companionOverview(): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('companion_overview');
}

export async function setCompanionRemote(
  enabled: boolean,
): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('set_companion_remote', { enabled });
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

/**
 * The handset side: remember which computer to dial, prove the wire, and register
 * this phone with it. The address is saved even when nothing answered, because
 * pairing happens in the morning with the computer switched off and it is the push
 * that waits (`ADR-042`).
 */
export async function companionConnectHost(input: {
  host: string;
  pairCode: string;
  deviceName: string;
  deviceModel: string;
}): Promise<CompanionLinkResult> {
  return invoke<CompanionLinkResult>('companion_connect_host', {
    host: input.host,
    pairCode: input.pairCode,
    deviceName: input.deviceName,
    deviceModel: input.deviceModel,
  });
}

/** Ask the computer whether this program is the one answering. */
export async function companionProbeHost(
  host: string,
  port: number,
): Promise<CompanionProbe> {
  return invoke<CompanionProbe>('companion_probe_host', { host, port });
}

/** Keep a capture on the phone until the computer takes it. */
export async function companionSaveCapture(
  draft: CompanionIntakeDraft,
): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('companion_save_capture', { draft });
}

/** Send everything waiting on the phone to the computer. */
export async function companionPushCaptures(): Promise<CompanionLinkResult> {
  return invoke<CompanionLinkResult>('companion_push_captures');
}

/** Drop the captures the computer already took. */
export async function companionClearOutbox(): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('companion_clear_outbox');
}

/** Apply one captured draft, through the ordinary audited receipt. */
export async function companionAcceptIntake(
  intakeId: string,
): Promise<CompanionIntakeApplied> {
  return invoke<CompanionIntakeApplied>('companion_accept_intake', { intakeId });
}

/** Refuse one captured draft without touching the ledger. */
export async function companionRejectIntake(intakeId: string): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('companion_reject_intake', { intakeId });
}

/** A new pairing code: the lock-out of every handset that has the old one. */
export async function companionRotatePairCode(): Promise<CompanionStatus> {
  return invoke<CompanionStatus>('companion_rotate_pair_code');
}
