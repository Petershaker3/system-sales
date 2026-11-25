-- Evidence-backed allocation of an already recorded reversal. These are links,
-- not money movements and never rewrite the source payment or refund. No rows
-- are inferred during upgrade. SQLite serializes writers, so the capacity checks
-- below cover normal allocations and all prior repairs in one transaction.
CREATE TABLE refund_allocation_repairs (
    request_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(request_id)) BETWEEN 1 AND 120),
    reversal_payment_id TEXT NOT NULL REFERENCES sale_payments(id) ON DELETE RESTRICT,
    original_payment_id TEXT NOT NULL REFERENCES sale_payments(id) ON DELETE RESTRICT,
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 300),
    evidence TEXT NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 1000),
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
) STRICT;
CREATE INDEX idx_refund_repairs_original ON refund_allocation_repairs(original_payment_id);
CREATE INDEX idx_refund_repairs_reversal ON refund_allocation_repairs(reversal_payment_id);
CREATE VIEW refund_allocation_effective AS
 SELECT reversal_payment_id,original_payment_id,amount_minor FROM refund_payment_allocations
 UNION ALL
 SELECT reversal_payment_id,original_payment_id,amount_minor FROM refund_allocation_repairs;
CREATE TRIGGER refund_repairs_no_update BEFORE UPDATE ON refund_allocation_repairs
BEGIN SELECT RAISE(ABORT,'refund allocation repairs are append-only'); END;
CREATE TRIGGER refund_repairs_no_delete BEFORE DELETE ON refund_allocation_repairs
BEGIN SELECT RAISE(ABORT,'refund allocation repairs are append-only'); END;
-- Check source identity, proven electronic provenance, and both capacities.
-- A repair must describe a *recorded* payout through the same source: an
-- alternative payout destination needs a distinct financial policy and ledger.
CREATE TRIGGER refund_repair_validate BEFORE INSERT ON refund_allocation_repairs
BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM sale_payments rp JOIN sales rs ON rs.id=rp.sale_id AND rs.kind='reversal'
   JOIN sale_payments op ON op.id=NEW.original_payment_id
   JOIN sales os ON os.id=op.sale_id AND os.kind='sale'
   LEFT JOIN sale_effective_wallet_attribution e ON e.payment_id=op.id
   WHERE rp.id=NEW.reversal_payment_id AND rs.reverses_sale_id=os.id AND rp.method=op.method
     AND ((op.method IN ('vf','instapay') AND e.wallet_id IS NOT NULL AND rp.wallet_id=e.wallet_id)
       OR (op.method NOT IN ('vf','instapay') AND rp.wallet_id IS op.wallet_id))
 ) THEN RAISE(ABORT,'refund repair source mismatch') END;
 SELECT CASE WHEN NEW.amount_minor > (SELECT amount_minor FROM sale_payments WHERE id=NEW.reversal_payment_id)
   - COALESCE((SELECT SUM(amount_minor) FROM refund_allocation_effective WHERE reversal_payment_id=NEW.reversal_payment_id),0)
   THEN RAISE(ABORT,'refund repair exceeds reversal capacity') END;
 SELECT CASE WHEN NEW.amount_minor > (SELECT amount_minor FROM sale_payments WHERE id=NEW.original_payment_id)
   - COALESCE((SELECT SUM(amount_minor) FROM refund_allocation_effective WHERE original_payment_id=NEW.original_payment_id),0)
   THEN RAISE(ABORT,'refund repair exceeds original capacity') END;
END;
-- Normal allocation must also see repairs; otherwise a later normal allocation
-- could consume the same capacity a second time.
DROP TRIGGER refund_allocation_validate;
CREATE TRIGGER refund_allocation_validate BEFORE INSERT ON refund_payment_allocations
BEGIN
 SELECT CASE WHEN NOT EXISTS (
   SELECT 1 FROM sale_payments rp JOIN sales rs ON rs.id=rp.sale_id AND rs.kind='reversal'
   JOIN sale_payments op ON op.id=NEW.original_payment_id
   JOIN sales os ON os.id=op.sale_id AND os.kind='sale'
   LEFT JOIN sale_effective_wallet_attribution e ON e.payment_id=op.id
   WHERE rp.id=NEW.reversal_payment_id AND rs.reverses_sale_id=os.id AND rp.method=op.method
     AND ((op.method IN ('vf','instapay') AND e.wallet_id IS NOT NULL AND rp.wallet_id=e.wallet_id)
       OR (op.method NOT IN ('vf','instapay') AND rp.wallet_id IS op.wallet_id))
 ) THEN RAISE(ABORT,'refund allocation source mismatch') END;
 SELECT CASE WHEN NEW.amount_minor > (SELECT amount_minor FROM sale_payments WHERE id=NEW.reversal_payment_id)
   - COALESCE((SELECT SUM(amount_minor) FROM refund_allocation_effective WHERE reversal_payment_id=NEW.reversal_payment_id),0)
   THEN RAISE(ABORT,'refund payment overallocated') END;
 SELECT CASE WHEN NEW.amount_minor > (SELECT amount_minor FROM sale_payments WHERE id=NEW.original_payment_id)
   - COALESCE((SELECT SUM(amount_minor) FROM refund_allocation_effective WHERE original_payment_id=NEW.original_payment_id),0)
   THEN RAISE(ABORT,'original payment overrefunded') END;
END;
CREATE TRIGGER sale_wallet_review_repair_used BEFORE INSERT ON sale_wallet_reviews
WHEN NEW.action='revoke' AND EXISTS(SELECT 1 FROM refund_allocation_repairs WHERE original_payment_id=NEW.payment_id)
BEGIN SELECT RAISE(ABORT,'review used by a refund repair cannot be revoked'); END;
