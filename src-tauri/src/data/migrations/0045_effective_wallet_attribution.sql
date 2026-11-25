-- An explicit, active manager review may attribute a historical payment to a
-- different wallet (or one previously unknown), without updating the payment.
CREATE VIEW sale_effective_wallet_attribution AS
SELECT p.id AS payment_id,
       COALESCE(v.wallet_id,
         (SELECT r.wallet_id FROM sale_wallet_reviews r
          WHERE r.payment_id=p.id AND r.sequence=(SELECT MAX(r2.sequence) FROM sale_wallet_reviews r2 WHERE r2.payment_id=p.id)
            AND r.action='confirm')) AS wallet_id
FROM sale_payments p
JOIN sales s ON s.id=p.sale_id AND s.kind='sale'
LEFT JOIN sale_wallet_provenance v ON v.payment_id=p.id
WHERE p.method IN ('vf','instapay');

DROP TRIGGER sale_wallet_review_validate;
CREATE TRIGGER sale_wallet_review_validate BEFORE INSERT ON sale_wallet_reviews
BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM sale_payments p JOIN sales s ON s.id=p.sale_id
      WHERE p.id=NEW.payment_id AND s.kind='sale' AND p.method IN ('vf','instapay')
        AND NOT EXISTS(SELECT 1 FROM sale_wallet_provenance v WHERE v.payment_id=p.id)
    ) THEN RAISE(ABORT,'review requires historical electronic payment') END;
    SELECT CASE WHEN NEW.action='confirm' AND COALESCE((SELECT action FROM sale_wallet_reviews WHERE payment_id=NEW.payment_id ORDER BY sequence DESC LIMIT 1),'revoke') <> 'revoke'
      THEN RAISE(ABORT,'payment already confirmed') END;
    SELECT CASE WHEN NEW.action='revoke' AND NOT EXISTS(SELECT 1 FROM sale_wallet_reviews r WHERE r.payment_id=NEW.payment_id AND r.action='confirm' AND r.wallet_id=NEW.wallet_id AND r.sequence=(SELECT MAX(r2.sequence) FROM sale_wallet_reviews r2 WHERE r2.payment_id=NEW.payment_id))
      THEN RAISE(ABORT,'payment not confirmed for wallet') END;
    SELECT CASE WHEN NEW.action='revoke' AND EXISTS(SELECT 1 FROM refund_payment_allocations WHERE original_payment_id=NEW.payment_id)
      THEN RAISE(ABORT,'review used by a refund cannot be revoked') END;
END;

DROP TRIGGER sale_payments_wallet_matches_method;
CREATE TRIGGER sale_payments_wallet_matches_method BEFORE INSERT ON sale_payments
WHEN NEW.wallet_id IS NOT NULL
 AND COALESCE((SELECT w.pay_method FROM wallets w WHERE w.id=NEW.wallet_id),'') <> NEW.method
 AND NOT EXISTS (
    SELECT 1 FROM sales reversal JOIN sale_payments original ON original.sale_id=reversal.reverses_sale_id
    JOIN sale_effective_wallet_attribution e ON e.payment_id=original.id AND e.wallet_id=NEW.wallet_id
    WHERE reversal.id=NEW.sale_id AND reversal.kind='reversal' AND original.method=NEW.method
 )
BEGIN SELECT RAISE(ABORT,'wallet must receive method or match reviewed original'); END;

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
    SELECT CASE WHEN NEW.amount_minor > (SELECT amount_minor FROM sale_payments WHERE id=NEW.reversal_payment_id) - COALESCE((SELECT SUM(amount_minor) FROM refund_payment_allocations WHERE reversal_payment_id=NEW.reversal_payment_id),0)
      THEN RAISE(ABORT,'refund payment overallocated') END;
    SELECT CASE WHEN NEW.amount_minor > (SELECT amount_minor FROM sale_payments WHERE id=NEW.original_payment_id) - COALESCE((SELECT SUM(amount_minor) FROM refund_payment_allocations WHERE original_payment_id=NEW.original_payment_id),0)
      THEN RAISE(ABORT,'original payment overrefunded') END;
END;
DROP TRIGGER refund_allocation_wallet_provenance;
CREATE TRIGGER refund_allocation_wallet_provenance BEFORE INSERT ON refund_payment_allocations
WHEN EXISTS (SELECT 1 FROM sale_payments p WHERE p.id=NEW.original_payment_id AND p.method IN ('vf','instapay')
 AND NOT EXISTS(SELECT 1 FROM sale_effective_wallet_attribution e WHERE e.payment_id=p.id AND e.wallet_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'refund wallet provenance unavailable'); END;
