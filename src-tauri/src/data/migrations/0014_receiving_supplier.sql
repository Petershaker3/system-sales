-- Migration 0014: the supplier label on receiving (P4b, decision D1).
--
-- WHAT THIS MAKES LIVE
--
-- `spec:29` and `§231`: simplified receiving is a supplier NAME plus a quantity
-- and a unit cost. No purchase orders, no payables, no counterparty entity.
--
-- WHY THE COLUMN IS ON THE MOVEMENT AND NOT IN A TABLE
--
-- The owner's D1 was asked as a storage shape and answered: a nullable TEXT
-- column on the receipt's own movement row. That is deliberate, and the reason
-- is that the list the shop actually wants is then DERIVED rather than stored
-- twice:
--
--     SELECT DISTINCT supplier_name
--       FROM stock_movements
--      WHERE kind = 'receipt' AND supplier_name IS NOT NULL;
--
-- A `suppliers` table would be a second place for the same fact to live, and a
-- second thing to keep in step with history — and `spec:29` never asked for a
-- counterparty at all. The plan flags D1 as REWORK RISK ("additive only if no
-- receiving migration is committed first"), so this shape is committed once and
-- changed never.
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No supplier table, no purchase document, no payable, no expected date, no
-- invoice number from the supplier. Every one of those is procurement, and
-- procurement is out of V1 scope.
--
-- No backfill. Movements written before this migration arrived from a shop that
-- recorded no supplier, and inventing one now would claim a trade that never
-- happened.
--
-- Purely additive. No table is rebuilt, no column is altered, no PRAGMA is used
-- and no `-- no-transaction` marker appears, so this runs inside the ordinary
-- SQLx migration transaction.

-- A supplier is a label the operator typed, so it is stored as they typed it
-- once trimmed, and it must be a label rather than an empty string: `''` and a
-- run of spaces are refused so that "no supplier" has exactly one spelling,
-- NULL. The length bound matches the operator's field, not the storage layer's
-- appetite for arbitrarily long text.
ALTER TABLE stock_movements ADD COLUMN supplier_name TEXT NULL
    CHECK (supplier_name IS NULL
           OR (length(supplier_name) BETWEEN 1 AND 120
               AND supplier_name = trim(supplier_name)));

-- Only a receipt is a purchase. A sale, a reversal and a removal name no
-- supplier, and an adjustment is not a purchase either — it is a correction of
-- something already counted. Enforcing that here means a later writer cannot
-- label a sale as having come from a supplier.
--
-- A trigger rather than a CHECK for the same reason as `0013`: this is a rule
-- about two columns' relationship to `kind`, and a table rebuild is not an
-- option for an append-only ledger whose rows `sale_lines` and `sale_reversals`
-- reference.
CREATE TRIGGER stock_movements_supplier_only_on_receipt
BEFORE INSERT ON stock_movements
WHEN NEW.supplier_name IS NOT NULL AND NEW.kind <> 'receipt'
BEGIN
    SELECT RAISE(ABORT, 'only a receipt may name a supplier');
END;

CREATE TRIGGER stock_movements_supplier_only_on_receipt_update
BEFORE UPDATE ON stock_movements
WHEN NEW.supplier_name IS NOT NULL AND NEW.kind <> 'receipt'
BEGIN
    SELECT RAISE(ABORT, 'only a receipt may name a supplier');
END;