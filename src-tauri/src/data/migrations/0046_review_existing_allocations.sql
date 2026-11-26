-- An older linked refund may predate provenance enforcement. A later review may
-- not silently make its already-posted refund wallet disagree with the original
-- attribution. Such a conflict needs an explicit compensating financial process.
CREATE TRIGGER sale_wallet_review_existing_allocations BEFORE INSERT ON sale_wallet_reviews
WHEN NEW.action = 'confirm' AND EXISTS (
    SELECT 1 FROM refund_payment_allocations a
    JOIN sale_payments reversal ON reversal.id=a.reversal_payment_id
    WHERE a.original_payment_id=NEW.payment_id AND reversal.wallet_id IS NOT NEW.wallet_id
)
BEGIN SELECT RAISE(ABORT,'existing refund uses a different wallet'); END;
