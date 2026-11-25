-- A wallet may stop receiving a method after an old sale. New sales must use
-- a wallet currently configured for the method; a reversal may still name the
-- original payment's recorded wallet and method. Do not infer a replacement.
DROP TRIGGER sale_payments_wallet_matches_method;
CREATE TRIGGER sale_payments_wallet_matches_method
BEFORE INSERT ON sale_payments
WHEN NEW.wallet_id IS NOT NULL
 AND COALESCE((SELECT w.pay_method FROM wallets w WHERE w.id = NEW.wallet_id), '') <> NEW.method
 AND NOT EXISTS (
    SELECT 1 FROM sales reversal
    JOIN sale_payments original ON original.sale_id = reversal.reverses_sale_id
    WHERE reversal.id = NEW.sale_id AND reversal.kind = 'reversal'
      AND original.method = NEW.method AND original.wallet_id = NEW.wallet_id
 )
BEGIN
    SELECT RAISE(ABORT, 'sale_payments.wallet_id must name a wallet that receives this method or an original reversal source');
END;
