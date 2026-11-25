# ADR-058: Evidence for an electronic sale's refund wallet

Status: implemented for new sales; historical resolution remains open.

## Context

Migration 0030 populated `sale_payments.wallet_id` using the wallet configured
for a method at upgrade time. This assignment is not necessarily evidence of
which wallet actually received a past payment. An identifier alone cannot
separate such a backfill from an operator's original selection. Returning money
against the guessed identifier could debit the wrong wallet. Payment methods
such as Vodafone Cash can have several receiving numbers, and a wallet's current
configuration can change after a sale.

## Decision

New electronic receipts require the operator/caller to name an eligible wallet
explicitly. Sales, customer collections, and repair services use the same Rust
resolver; `null` no longer means the current primary wallet. The picker offers
all eligible wallets, including a single candidate. The selection is persisted
with the original payment. Migration 0043 records append-only evidence for new
original sale payments transactionally, and adds a database check that an
electronic refund allocation refers to a payment with matching evidence.

Service-layer cancellation and partial returns require this evidence and use
existing original payment allocation and capacity rules. They may reverse to the
original wallet even if it no longer receives new payments by that method.
A failed validation rolls back the reversal, inventory, and approval consumption.
Migration 0043 never retroactively creates evidence for existing rows.

## Consequences and limits

Electronic sale payments already present on upgrade are conservatively unknown,
including genuinely explicit historical selections that the schema cannot
prove. Their electronic returns/cancellations are refused until a separately
specified, authorized, auditable evidence-resolution mechanism exists. No
operator override or inferred wallet is added here. This does not establish
provenance for older customer or repair payments. `sale_wallet_provenance` is
not a cash drawer ledger and a linked cash refund still lacks original drawer
identity. Reports remain provisional and guards remain in place.

The SQLite database, including this evidence and its triggers, is included in
the encrypted backup snapshot. The financial-record round-trip test validates
restoration of provenance, observations and constraints; it does not validate a
complete ledger, which has not yet been implemented.
