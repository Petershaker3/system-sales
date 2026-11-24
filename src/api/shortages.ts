import { invoke } from '@tauri-apps/api/core';

export type ShortageStatus = 'open' | 'ordered';

export interface ShortageEntry {
  readonly id: string;
  readonly productId: string | null;
  readonly name: string;
  readonly qty: number;
  readonly note: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly status: ShortageStatus;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly createdAt: number;
  readonly resolvedAt: number | null;
  readonly onHand: number | null;
  readonly minQty: number | null;
}

export interface ShortageSuggestion {
  readonly productId: string;
  readonly name: string;
  readonly categoryId: string | null;
  readonly categoryName: string | null;
  readonly onHand: number;
  readonly minQty: number;
  readonly suggestedQty: number;
}

export interface ShortagesOverview {
  readonly items: readonly ShortageEntry[];
  readonly suggestions: readonly ShortageSuggestion[];
}

export interface AddShortageOutcome {
  readonly entry: ShortageEntry;
  readonly merged: boolean;
}

export interface AddShortageParams {
  readonly productId?: string | null;
  readonly name?: string | null;
  readonly qty: number;
  readonly note?: string | null;
  readonly customerName?: string | null;
  readonly customerPhone?: string | null;
}

export async function shortagesOverview(): Promise<ShortagesOverview> {
  return invoke<ShortagesOverview>('shortages_overview');
}

export async function addShortage(params: AddShortageParams): Promise<AddShortageOutcome> {
  return invoke<AddShortageOutcome>('add_shortage', {
    productId: params.productId ?? null,
    name: params.name ?? null,
    qty: params.qty,
    note: params.note ?? null,
    customerName: params.customerName ?? null,
    customerPhone: params.customerPhone ?? null,
  });
}

export async function setShortageStatus(
  shortageId: string,
  status: ShortageStatus
): Promise<ShortageEntry> {
  return invoke<ShortageEntry>('set_shortage_status', { shortageId, status });
}

export async function resolveShortage(shortageId: string): Promise<ShortageEntry> {
  return invoke<ShortageEntry>('resolve_shortage', { shortageId });
}

export async function deleteShortage(shortageId: string): Promise<ShortageEntry> {
  return invoke<ShortageEntry>('delete_shortage', { shortageId });
}

export async function addAllSuggestedShortages(): Promise<readonly ShortageEntry[]> {
  return invoke<readonly ShortageEntry[]>('add_all_suggested_shortages');
}
