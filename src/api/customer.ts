/**
 * Customer file API (P4).
 *
 * A thin typed wrapper over `invoke`, mirroring `departments.ts`. Creating is
 * open to sellers (both roles hold `Sell`); listing, reading and archiving
 * are manager-only (`ManageCustomers`) and the backend refuses a sales caller
 * regardless of what the DOM offers (`spec:210`).
 *
 * Names are never unique and never merged (`spec:178`): two similar names are
 * two records, and the UI must not offer "pick the existing one" by name.
 */

import { invoke } from '@tauri-apps/api/core';

import type { CommandError } from './errors';

/** A customer record as the backend returns it. */
export interface Customer {
  readonly id: string;
  readonly name: string;
  /** Null means no contact was given — never an empty string. */
  readonly contact: string | null;
  readonly archived: boolean;
}

/** Create a customer. Both roles may call this (invoice-time entry). */
export async function createCustomer(
  name: string,
  contact: string | null,
): Promise<Customer> {
  return invoke<Customer>('create_customer', { name, contact });
}

/** List live customers. Manager-only; sales callers are refused in Rust. */
export async function listCustomers(): Promise<Customer[]> {
  return invoke<Customer[]>('list_customers');
}

/** Read one customer. Manager-only. */
export async function getCustomer(id: string): Promise<Customer> {
  return invoke<Customer>('get_customer', { id });
}

/** Archive a customer. Manager-only. History keeps its references. */
export async function archiveCustomer(id: string): Promise<Customer> {
  return invoke<Customer>('archive_customer', { id });
}

export type { CommandError };
