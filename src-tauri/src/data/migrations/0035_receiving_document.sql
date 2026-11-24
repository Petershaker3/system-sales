-- 0035_receiving_document.sql
--
-- A delivery is a DOCUMENT, not a pile of unrelated pieces
-- (2026-11-05: «فين البرنامج» / receiving redesign).
--
-- WHAT THIS ADDS
--
-- Four nullable columns on `stock_movements`, and nothing else:
--
--   document_id    groups the lines of one delivery, so «توريد ٣ أصناف»
--                  writes three movements that can be read back as one page.
--   document_ref   the supplier's own invoice / reference number, as typed.
--   purchase_date  the day the goods were bought, `YYYY-MM-DD`, when the
--                  operator knows it. NULL means «same day it was received»,
--                  which is what the ledger already says in `occurred_at`.
--   note           one free line about this delivery.
--
-- WHY ON THE MOVEMENT
--
-- Same reasoning as `0014`'s `supplier_name`: the shop asks for a receiving
-- history, and a history is DERIVED from the ledger rather than stored beside
-- it. A `receipt_documents` table would be a second place for the same facts to
-- live and a second thing to keep in step with an append-only ledger.
--
-- `document_id` is a plain TEXT uuid with no foreign key, on purpose: it names a
-- group of rows in this same table, so there is no other row to point at. A line
-- of a document is still one movement with its own product, quantity and cost —
-- which is what keeps `SUM(quantity_delta)` equal to the position.
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No purchase orders, no payables, no expected dates, no supplier entity, no
-- document header table. `spec:29` scopes receiving to a name, a quantity and a
-- cost; the reference number and the note are what an operator writes on the
-- paper invoice, not procurement.
--
-- No backfill. A receipt written before this migration carried no document
-- reference, and inventing one would claim a paper that never existed.
--
-- Purely additive. No table is rebuilt and no PRAGMA is used, so this runs inside
-- the ordinary SQLx migration transaction.

-- A reference is a label the operator typed, so it is stored trimmed and it must
-- not be an empty string: `''` and a run of spaces are refused so that «no
-- reference» has exactly one spelling, NULL.
ALTER TABLE stock_movements ADD COLUMN document_id TEXT NULL;

ALTER TABLE stock_movements ADD COLUMN document_ref TEXT NULL
    CHECK (document_ref IS NULL
           OR (length(document_ref) BETWEEN 1 AND 60
               AND document_ref = trim(document_ref)));

-- The same shape `sales.warranty_start` uses (`0013`): a calendar day, not an
-- instant. The instant the delivery was recorded is `occurred_at`; this is the
-- day on the supplier's invoice, which may be earlier.
ALTER TABLE stock_movements ADD COLUMN purchase_date TEXT NULL
    CHECK (purchase_date IS NULL
           OR (length(purchase_date) = 10
               AND purchase_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'));

ALTER TABLE stock_movements ADD COLUMN note TEXT NULL
    CHECK (note IS NULL
           OR (length(note) BETWEEN 1 AND 300 AND note = trim(note)));

CREATE INDEX idx_stock_movements_document ON stock_movements (document_id);

-- A sale, a reversal and an adjustment are not deliveries, so they may not carry
-- delivery paperwork. Trigger rather than CHECK for the same reason as `0014`:
-- this is a rule about a relationship between columns, and a table rebuild is
-- not an option for an append-only ledger whose rows `sale_lines` reference.
CREATE TRIGGER stock_movements_document_only_on_receipt
BEFORE INSERT ON stock_movements
WHEN NEW.kind <> 'receipt'
     AND (NEW.document_id IS NOT NULL
          OR NEW.document_ref IS NOT NULL
          OR NEW.purchase_date IS NOT NULL
          OR NEW.note IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'only a receipt may carry receiving paperwork');
END;

CREATE TRIGGER stock_movements_document_only_on_receipt_update
BEFORE UPDATE ON stock_movements
WHEN NEW.kind <> 'receipt'
     AND (NEW.document_id IS NOT NULL
          OR NEW.document_ref IS NOT NULL
          OR NEW.purchase_date IS NOT NULL
          OR NEW.note IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'only a receipt may carry receiving paperwork');
END;

-- Opening stock is what was already on the shelf on the day the programme was
-- installed. It is not a purchase, so it names no supplier (`0020`) and it
-- cannot cite a supplier invoice or a purchase day either. A note is allowed:
-- «الرف اللي ورا» is a fact about the count, not a claim about a trade.
CREATE TRIGGER stock_movements_opening_has_no_purchase_document
BEFORE INSERT ON stock_movements
WHEN NEW.receipt_kind = 'opening'
     AND (NEW.document_ref IS NOT NULL OR NEW.purchase_date IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'opening stock is not a supplier purchase');
END;

CREATE TRIGGER stock_movements_opening_has_no_purchase_document_update
BEFORE UPDATE ON stock_movements
WHEN NEW.receipt_kind = 'opening'
     AND (NEW.document_ref IS NOT NULL OR NEW.purchase_date IS NOT NULL)
BEGIN
    SELECT RAISE(ABORT, 'opening stock is not a supplier purchase');
END;
