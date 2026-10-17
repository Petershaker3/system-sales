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

/** A customer record as the backend returns it, including their current آجل balance (`ADR-020` §3). */
export interface Customer {
  readonly id: string;
  readonly name: string;
  /** Null means no contact was given — never an empty string. */
  readonly contact: string | null;
  readonly archived: boolean;
  /** Current آجل balance owed to the shop, in piastres (`ADR-020` §3). */
  readonly balanceMinor: number;
}

/** One entry in a customer's credit (`آجل`) ledger (`ADR-020` §3). */
export interface CustomerLedgerEntry {
  readonly id: string;
  readonly customerId: string;
  readonly kind: 'credit_sale' | 'payment' | 'sale_reversal';
  readonly amountMinor: number;
  readonly method: string | null;
  readonly saleId: string | null;
  readonly note: string | null;
  readonly occurredAt: number;
}

/** Create a customer. Both roles may call this (invoice-time entry). */
export async function createCustomer(
  name: string,
  contact: string | null,
): Promise<Customer> {
  return invoke<Customer>('create_customer', { name, contact });
}

/** List live customers with their current آجل balance (`ADR-020` §3). */
export async function listCustomers(): Promise<Customer[]> {
  return invoke<Customer[]>('list_customers');
}

/** Read one customer with their current آجل balance (`ADR-020` §3). */
export async function getCustomer(id: string): Promise<Customer> {
  return invoke<Customer>('get_customer', { id });
}

/** Archive a customer. Manager-only. History keeps its references. */
export async function archiveCustomer(id: string): Promise<Customer> {
  return invoke<Customer>('archive_customer', { id });
}

/** Record a debt repayment from a customer against their آجل balance (`ADR-020` §3). */
export async function recordCustomerPayment(
  customerId: string,
  amountMinor: number,
  method: 'cash' | 'vf' | 'instapay' | 'card',
  note?: string | null,
): Promise<Customer> {
  return invoke<Customer>('record_customer_payment', {
    customerId,
    amountMinor,
    method,
    note: note ?? null,
  });
}

/** List a customer's credit ledger entries, newest first (`ADR-020` §3). */
export async function listCustomerLedger(
  customerId: string,
): Promise<CustomerLedgerEntry[]> {
  return invoke<CustomerLedgerEntry[]>('list_customer_ledger', { customerId });
}

export type { CommandError };
