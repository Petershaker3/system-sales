-- Payments recorded before this migration have unknown provenance: migration
-- 0030 may have filled wallet_id by current method, even when a wallet was
-- changed after the transaction. Never backfill this evidence.
CREATE TABLE sale_wallet_provenance (
    payment_id TEXT PRIMARY KEY NOT NULL REFERENCES sale_payments(id) ON DELETE RESTRICT,
    wallet_id TEXT NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
    kind TEXT NOT NULL CHECK (kind = 'recorded_on_sale')
);
CREATE TRIGGER sale_wallet_provenance_on_insert AFTER INSERT ON sale_payments
WHEN NEW.wallet_id IS NOT NULL AND NEW.method IN ('vf','instapay')
 AND (SELECT kind FROM sales WHERE id=NEW.sale_id) = 'sale'
BEGIN
    INSERT INTO sale_wallet_provenance(payment_id,wallet_id,kind)
    VALUES(NEW.id,NEW.wallet_id,'recorded_on_sale');
END;
CREATE TRIGGER sale_wallet_provenance_no_update BEFORE UPDATE ON sale_wallet_provenance
BEGIN SELECT RAISE(ABORT, 'wallet provenance is immutable'); END;
CREATE TRIGGER sale_wallet_provenance_no_delete BEFORE DELETE ON sale_wallet_provenance
BEGIN SELECT RAISE(ABORT, 'wallet provenance is immutable'); END;
-- Even callers outside the service cannot use an unknown historical wallet as
-- the basis for an allocation; no estimate becomes a confirmed source.
CREATE TRIGGER refund_allocation_wallet_provenance BEFORE INSERT ON refund_payment_allocations
WHEN EXISTS (SELECT 1 FROM sale_payments p WHERE p.id=NEW.original_payment_id
             AND p.method IN ('vf','instapay') AND NOT EXISTS (
                SELECT 1 FROM sale_wallet_provenance v
                WHERE v.payment_id=p.id AND v.wallet_id=p.wallet_id))
BEGIN SELECT RAISE(ABORT, 'refund wallet provenance unavailable'); END;
