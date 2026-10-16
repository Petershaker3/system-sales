/**
 * Department classification API (SP-1b).
 *
 * A thin typed wrapper over `invoke`, mirroring `catalog.ts`: no token is ever
 * read or sent, because the backend resolves the operator from the OS
 * credential store. Every failure arrives as a `CommandError` carrying a stable
 * code, and rendering happens in `errors.ts`.
 *
 * These operations need `ManageDepartments`, which carries no re-authentication
 * requirement — naming a classification is routine work (`spec:210`), and the
 * backend refuses a sales user regardless of what this file offers.
 */

import { invoke } from '@tauri-apps/api/core';

import type { CommandError } from './errors';

/**
 * How a department's stock cost is computed.
 *
 * These strings are the stored values Rust parses (`CostMethod::as_str`), so
 * they must match exactly.
 */
export type CostMethod = 'moving_average' | 'fifo';
export type DepartmentStatus = 'active' | 'archived';

/** Department VAT: `rateBp` is null only when VAT is not configured. */
export interface DepartmentVat {
  readonly enabled: boolean;
  readonly rateBp: number | null;
  readonly inclusive: boolean;
}

/** A department as the backend sees it (camelCase of `DepartmentDto`). */
export interface Department {
  readonly id: string;
  readonly name: string;
  readonly status: DepartmentStatus;
  readonly costMethod: CostMethod;
  readonly vat: DepartmentVat;
  readonly sortOrder: number;
  readonly createdBy: string;
  readonly updatedBy: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly archivedAt: number | null;
}

/** Payload for creating and updating a department — the same seven fields. */
export interface DepartmentInput {
  readonly name: string;
  readonly costMethod: CostMethod;
  readonly vatEnabled: boolean;
  readonly vatRateBp: number | null;
  readonly vatInclusive: boolean;
  readonly sortOrder: number;
}

function flat(input: DepartmentInput) {
  return {
    name: input.name,
    costMethod: input.costMethod,
    vatEnabled: input.vatEnabled,
    vatRateBp: input.vatRateBp,
    vatInclusive: input.vatInclusive,
    sortOrder: input.sortOrder,
  };
}

export async function createDepartment(input: DepartmentInput): Promise<Department> {
  return invoke<Department>('create_department', flat(input));
}

export async function getDepartment(id: string): Promise<Department> {
  return invoke<Department>('get_department', { id });
}

/**
 * Every department, active and archived, in display order — `sort_order`
 * first, name breaking ties. The panel splits the two statuses itself.
 */
export async function listDepartments(): Promise<Department[]> {
  return invoke<Department[]>('list_departments');
}

export async function updateDepartment(
  id: string,
  input: DepartmentInput,
): Promise<Department> {
  return invoke<Department>('update_department', { id, ...flat(input) });
}

/**
 * Archive, or restore an archived department. Never a delete: `spec:221` keeps
 * a department linked to history, and the row stays.
 */
export async function setDepartmentArchived(
  id: string,
  archived: boolean,
): Promise<Department> {
  return invoke<Department>('set_department_archived', { id, archived });
}

/**
 * Apply the panel's displayed order: the full id sequence of the live
 * departments, positions 0..n. Archived rows are not part of the ordering —
 * the backend refuses to move them, and they keep their stored position.
 */
export async function reorderDepartments(orderedIds: string[]): Promise<Department[]> {
  return invoke<Department[]>('reorder_departments', { orderedIds });
}

export type { CommandError };
