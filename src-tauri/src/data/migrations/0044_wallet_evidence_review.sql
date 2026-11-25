-- Historical assignments remain untouched. This evidence can confirm only an
-- already recorded wallet; a conflicting wallet requires a future correction
-- policy and is not silently substituted. Review events are append-only.
CREATE TABLE sale_wallet_reviews (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_id TEXT NOT NULL REFERENCES sale_payments(id) ON DELETE RESTRICT,
    wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    action TEXT NOT NULL CHECK(action IN ('confirm','revoke')),
    reason TEXT NOT NULL CHECK(length(trim(reason)) BETWEEN 1 AND 300),
    evidence TEXT NOT NULL CHECK(length(trim(evidence)) BETWEEN 1 AND 1000),
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
    request_id TEXT NOT NULL UNIQUE CHECK(length(trim(request_id)) BETWEEN 1 AND 120)
);
CREATE INDEX idx_sale_wallet_reviews_payment ON sale_wallet_reviews(payment_id,sequence DESC);
CREATE TRIGGER sale_wallet_review_validate BEFORE INSERT ON sale_wallet_reviews
BEGIN
    SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM sale_payments p JOIN sales s ON s.id=p.sale_id
      WHERE p.id=NEW.payment_id AND s.kind='sale' AND p.method IN ('vf','instapay')
        AND p.wallet_id=NEW.wallet_id
        AND NOT EXISTS(SELECT 1 FROM sale_wallet_provenance v WHERE v.payment_id=p.id)
    ) THEN RAISE(ABORT,'review requires historical recorded wallet') END;
    SELECT CASE WHEN NEW.action='confirm' AND COALESCE((SELECT action FROM sale_wallet_reviews WHERE payment_id=NEW.payment_id ORDER BY sequence DESC LIMIT 1),'revoke') <> 'revoke'
      THEN RAISE(ABORT,'payment already confirmed') END;
    SELECT CASE WHEN NEW.action='revoke' AND COALESCE((SELECT action FROM sale_wallet_reviews WHERE payment_id=NEW.payment_id ORDER BY sequence DESC LIMIT 1),'revoke') <> 'confirm'
      THEN RAISE(ABORT,'payment not confirmed') END;
    SELECT CASE WHEN NEW.action='revoke' AND EXISTS(SELECT 1 FROM refund_payment_allocations WHERE original_payment_id=NEW.payment_id)
      THEN RAISE(ABORT,'review used by a refund cannot be revoked') END;
END;
CREATE TRIGGER sale_wallet_reviews_no_update BEFORE UPDATE ON sale_wallet_reviews
BEGIN SELECT RAISE(ABORT,'wallet reviews are append-only'); END;
CREATE TRIGGER sale_wallet_reviews_no_delete BEFORE DELETE ON sale_wallet_reviews
BEGIN SELECT RAISE(ABORT,'wallet reviews are append-only'); END;
DROP TRIGGER refund_allocation_wallet_provenance;
CREATE TRIGGER refund_allocation_wallet_provenance BEFORE INSERT ON refund_payment_allocations
WHEN EXISTS (SELECT 1 FROM sale_payments p WHERE p.id=NEW.original_payment_id
  AND p.method IN ('vf','instapay') AND NOT EXISTS (
    SELECT 1 FROM sale_wallet_provenance v WHERE v.payment_id=p.id AND v.wallet_id=p.wallet_id)
  AND NOT EXISTS (SELECT 1 FROM sale_wallet_reviews r WHERE r.payment_id=p.id AND r.wallet_id=p.wallet_id
    AND r.action='confirm' AND r.sequence=(SELECT MAX(r2.sequence) FROM sale_wallet_reviews r2 WHERE r2.payment_id=p.id)))
BEGIN SELECT RAISE(ABORT,'refund wallet provenance unavailable'); END;
