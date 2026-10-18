/**
 * Phone brands and registering a new phone (ADR-018 §2). A thin typed wrapper
 * over `invoke`; no token is ever sent — the backend resolves the operator from
 * the OS credential store.
 */

import { invoke } from '@tauri-apps/api/core';

import type { Product } from './catalog';

/** Which phones a company makes, as the owner set it. */
export type BrandDeviceType = 'touch' | 'keypad' | 'both';
/** One phone: touch («تاتش») or keypad («زراير»). */
export type DeviceType = 'touch' | 'keypad';

export interface Brand {
  readonly id: string;
  readonly name: string;
  readonly deviceType: BrandDeviceType;
  readonly sortOrder: number;
  /** Not offered in «موبايل جديد»; its phones still sell. */
  readonly hidden: boolean;
  /** Model lines written without the company («iPhone»), for the name preview. */
  readonly lines: readonly string[];
}

/** One row of the settings list. */
export interface BrandEntry extends Brand {
  /** Live phones of this company. */
  readonly products: number;
  readonly isDefault: boolean;
  readonly deletable: boolean;
}

export function listBrands(): Promise<BrandEntry[]> {
  return invoke<BrandEntry[]>('list_brands');
}

export function createBrand(name: string, deviceType: BrandDeviceType): Promise<Brand> {
  return invoke<Brand>('create_brand', { name, deviceType });
}

export function renameBrand(id: string, name: string): Promise<Brand> {
  return invoke<Brand>('rename_brand', { id, name });
}

export function setBrandType(id: string, deviceType: BrandDeviceType): Promise<Brand> {
  return invoke<Brand>('set_brand_type', { id, deviceType });
}

export function setBrandHidden(id: string, hidden: boolean): Promise<Brand> {
  return invoke<Brand>('set_brand_hidden', { id, hidden });
}

export function moveBrand(id: string, direction: 'up' | 'down'): Promise<Brand> {
  return invoke<Brand>('move_brand', { id, direction });
}

export function deleteBrand(id: string): Promise<void> {
  return invoke<void>('delete_brand', { id });
}

export interface NewPhone {
  readonly categoryId: string;
  readonly brandId: string;
  readonly model: string;
  readonly deviceType: DeviceType;
  /** Required for a touch phone; `null` for a keypad one. */
  readonly storageGb: number | null;
  readonly ramGb: number | null;
  readonly salePriceMinor: number | null;
}

export interface RegisteredPhone {
  readonly product: Product;
  readonly brandId: string;
  readonly model: string;
  readonly deviceType: DeviceType;
  readonly storageGb: number | null;
  readonly ramGb: number | null;
}

/** Register a new phone; its name is built from its details. */
export function createPhone(input: NewPhone): Promise<RegisteredPhone> {
  return invoke<RegisteredPhone>('create_phone', {
    categoryId: input.categoryId,
    brandId: input.brandId,
    model: input.model,
    deviceType: input.deviceType,
    storageGb: input.storageGb,
    ramGb: input.ramGb,
    salePriceMinor: input.salePriceMinor,
  });
}

export type ConditionGrade = 'A' | 'B' | 'C';

export interface NewUsedPhone {
  readonly categoryId: string;
  readonly brandId: string;
  readonly model: string;
  readonly deviceType: DeviceType;
  readonly storageGb: number | null;
  readonly ramGb: number | null;
  readonly color?: string | null;
  readonly imei: string;
  readonly imei2?: string | null;
  readonly conditionGrade: ConditionGrade;
  readonly batteryHealthPct?: number | null;
  readonly accessories?: string | null;
  readonly intakeNote?: string | null;
  readonly costMinor: number;
  readonly salePriceMinor: number;
  readonly sellerName?: string | null;
  readonly sellerPhone?: string | null;
  readonly sellerNationalId?: string | null;
  readonly isOpeningStock?: boolean;
  readonly payoutFromDrawer?: boolean;
}

export interface RegisteredUsedPhone {
  readonly product: Product;
  readonly brandId: string;
  readonly model: string;
  readonly deviceType: DeviceType;
  readonly storageGb: number | null;
  readonly ramGb: number | null;
  readonly unitId: string;
  readonly imei: string;
  readonly imei2: string | null;
  readonly conditionGrade: ConditionGrade;
  readonly batteryHealthPct: number | null;
  readonly costMinor: number;
  readonly salePriceMinor: number;
  readonly onHand: number;
}

/** Register a used phone unit into stock (`ADR-032`). */
export function createUsedPhone(input: NewUsedPhone): Promise<RegisteredUsedPhone> {
  return invoke<RegisteredUsedPhone>('create_used_phone', {
    categoryId: input.categoryId,
    brandId: input.brandId,
    model: input.model,
    deviceType: input.deviceType,
    storageGb: input.storageGb,
    ramGb: input.ramGb,
    color: input.color ?? null,
    imei: input.imei,
    imei2: input.imei2 ?? null,
    conditionGrade: input.conditionGrade,
    batteryHealthPct: input.batteryHealthPct ?? null,
    accessories: input.accessories ?? null,
    intakeNote: input.intakeNote ?? null,
    costMinor: input.costMinor,
    salePriceMinor: input.salePriceMinor,
    sellerName: input.sellerName ?? null,
    sellerPhone: input.sellerPhone ?? null,
    sellerNationalId: input.sellerNationalId ?? null,
    isOpeningStock: input.isOpeningStock ?? false,
    payoutFromDrawer: input.payoutFromDrawer ?? false,
  });
}

export interface ImeiLocalUnitMatch {
  readonly unitId: string;
  readonly productId: string;
  readonly productName: string;
  readonly imei: string;
  readonly imei2: string | null;
  readonly status: 'in_stock' | 'sold' | 'retired' | string;
  readonly color: string | null;
  readonly conditionGrade: ConditionGrade | null;
  readonly batteryHealthPct: number | null;
  readonly accessories: string | null;
  readonly intakeNote: string | null;
  readonly unitCostMinor: number | null;
  readonly sellerName: string | null;
  readonly sellerPhone: string | null;
  readonly sellerNationalId: string | null;
  readonly createdAt: number;
}

export interface ImeiRepairMatch {
  readonly ticketNo: string;
  readonly deviceName: string;
  readonly issue: string;
  readonly status: string;
  readonly customerName: string;
  readonly createdAt: number;
}

export interface ImeiCheckResult {
  readonly normalized: string;
  readonly digitCount: number;
  readonly formatValid: boolean;
  readonly luhnValid: boolean;
  readonly tac: string | null;
  readonly localUnit: ImeiLocalUnitMatch | null;
  readonly repairs: readonly ImeiRepairMatch[];
}

/** Inspect an IMEI for Luhn check digit, TAC prefix, and local history (`ADR-032`). */
export function checkImei(imei: string): Promise<ImeiCheckResult> {
  return invoke<ImeiCheckResult>('check_imei', { imei });
}

