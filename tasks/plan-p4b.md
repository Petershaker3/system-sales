# P4b — Inventory completion

Plan of record for the P4b phase. Authority: `docs/PROJECT_INSTRUCTIONS.md`, then
`docs/decisions/ADR-*`, then `tasks/delivery-plan.md` row 422 (P4b), then the
owner decisions below. Executor: inline (`executing-plans`).

## What P4b owes, from the delivery plan

Row 422 names five things: receiving with a supplier (post-D1), the
stocktake/adjustment path, ID-04 archival verification, the XC-10 schema probe
and XC-11 no-drop. Acceptance is "receiving with supplier; stocktake path;
guarded cost-switch; ledger rebuild", verified by integration tests and a schema
probe on both platforms.

## Owner decisions taken before any code

- **D1** — receiving takes an optional supplier name.
- **D1 shape (asked and answered this session)** — the supplier is a nullable
  `TEXT` column on the receipt's own `stock_movements` row. No `suppliers` table,
  no purchase document. Two reasons, and the second is the load-bearing one:
  `spec:29`/`§231` says simplified receiving is a supplier *name* plus quantity
  and unit cost, with no purchase orders and no payables; and the supplier list
  the shop actually needs is then derived, not duplicated —
  `SELECT DISTINCT supplier_name FROM stock_movements WHERE kind = 'receipt'`.
  A separate table would have been a second place for the same fact to drift.
  The plan flags D1 as REWORK RISK ("additive only if no receiving migration is
  committed first"), so this shape is fixed once and committed once.

## Task list

### Task 1 — supplier name on receiving (D1)
- [ ] Migration `0014`: nullable `supplier_name` on `stock_movements`, CHECK for
      non-empty and length, on the movement itself — not a rebuilt table.
- [ ] `SupplierName` value type: trimmed, length-bounded, refused rather than
      repaired, with its own stable code and Arabic message.
- [ ] `receive()` takes it; it reaches the receipt movement only. A sale, a
      reversal and a removal must never carry one — an adjustment is not a
      purchase.
- [ ] Command + frontend: one optional field on the receiving form.
- [ ] Tests: migration shape, domain grammar, persistence with and without a
      supplier, and the refusal of a supplier on a non-receipt movement.
- Verification: `cargo test --offline` green, `npm run typecheck` green.

### Task 2 — stocktake / adjustment (INV-08)
- [ ] `stock_movements.kind` already admits `adjustment`; the service does not
      exist. Set the counted on-hand, post the signed difference as one movement.
- [ ] Manager-only and re-authenticated: an adjustment is a value change
      (`ADR-015`), not routine work like a receipt.
- [ ] Refuse an adjustment that would drive stock below zero.
- Tests: exact delta, no-op refused, negative refused, audit event attributed.

### Task 3 — ID-04 archival verification
- [ ] Prove a product that has been sold cannot be hard-deleted, and that
      archiving keeps invoice and movement history intact.

### Task 4 — XC-10 schema probe
- [ ] A test that walks the whole schema and fails if any `BLOB` column or
      large field appears. Cheap, and it keeps the rule enforced rather than
      remembered.

### Task 5 — XC-11 no-drop
- [ ] Confirm the injected-failure atomicity case still holds on this tree.

## Ordering and why

Task 1 first: it is the only one that commits a receiving migration, and the
plan says that migration must not be committed before the supplier shape is
settled. Tasks 3–5 are verification of rules that are believed to already hold,
so they are cheap and can follow. Task 2 is the largest new behaviour and comes
after the ledger shape it writes into is final.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Supplier ends up on a movement row where it reads as a purchase order | Medium | The column is nullable, named `supplier_name`, and documented in the migration as a label the operator typed — never a counterparty entity |
| Adjustment silently invents stock | High | One movement equal to the signed delta; never a direct write to the position |
| A second run rewrites receiving | Medium | Migration 0014 is additive and applied once by version; no `Down` script exists or will |

## Open questions

None blocking. The D1 shape was the one decision this phase needed and it has
been answered.