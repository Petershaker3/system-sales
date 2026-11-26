-- Explicit links for NEW reversals. Historical reversal rows are deliberately
-- not backfilled: method and even wallet do not identify one original payment
-- when a sale has multiple allocations. Missing links remain unknown.
CREATE TABLE refund_payment_allocations (
    reversal_payment_id TEXT NOT NULL REFERENCES sale_payments(id) ON DELETE RESTRICT,
    original_payment_id TEXT NOT NULL REFERENCES sale_payments(id) ON DELETE RESTRICT,
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    PRIMARY KEY (reversal_payment_id, original_payment_id)
);
CREATE INDEX idx_refund_allocations_original ON refund_payment_allocations(original_payment_id);

-- Both payments must belong to linked sale documents and the same source.
-- Never allocate more than either the reversal or original payment's capacity.
CREATE TRIGGER refund_allocation_validate BEFORE INSERT ON refund_payment_allocations
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM sale_payments rp
        JOIN sales rs ON rs.id = rp.sale_id AND rs.kind = 'reversal'
        JOIN sale_payments op ON op.id = NEW.original_payment_id
        JOIN sales os ON os.id = op.sale_id AND os.kind = 'sale'
        WHERE rp.id = NEW.reversal_payment_id
          AND rs.reverses_sale_id = os.id
          AND rp.method = op.method AND rp.wallet_id IS op.wallet_id
    ) THEN RAISE(ABORT, 'refund allocation source mismatch') END;
    SELECT CASE WHEN NEW.amount_minor > (SELECT amount_minor FROM sale_payments WHERE id = NEW.reversal_payment_id) - COALESCE((SELECT SUM(amount_minor) FROM refund_payment_allocations WHERE reversal_payment_id = NEW.reversal_payment_id), 0)
      THEN RAISE(ABORT, 'refund payment overallocated') END;
    SELECT CASE WHEN NEW.amount_minor > (SELECT amount_minor FROM sale_payments WHERE id = NEW.original_payment_id) - COALESCE((SELECT SUM(amount_minor) FROM refund_payment_allocations WHERE original_payment_id = NEW.original_payment_id), 0)
      THEN RAISE(ABORT, 'original payment overrefunded') END;
END;
CREATE TRIGGER refund_allocations_no_update BEFORE UPDATE ON refund_payment_allocations
BEGIN SELECT RAISE(ABORT, 'refund allocations are append-only'); END;
CREATE TRIGGER refund_allocations_no_delete BEFORE DELETE ON refund_payment_allocations
BEGIN SELECT RAISE(ABORT, 'refund allocations are append-only'); END;
