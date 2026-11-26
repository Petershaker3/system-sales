-- Extend the existing source-linked cash projection, retaining every 0048
-- row and never backfilling historical wallet operations. Voids are new
-- compensating events at void time, not deletion of the original posting.
DROP TRIGGER cash_sale_payment_post;
DROP TRIGGER cash_customer_payment_post;
DROP TRIGGER cash_drawer_expense_post;
DROP TRIGGER cash_movement_post;
CREATE TABLE cash_source_postings_next (
    source_kind TEXT NOT NULL CHECK(source_kind IN ('sale_payment','customer_payment','expense','cash_movement','wallet_op','wallet_void')),
    source_id TEXT NOT NULL CHECK(length(trim(source_id))>0),
    shift_id TEXT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    drawer_id TEXT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT,
    signed_minor INTEGER NOT NULL CHECK(signed_minor <> 0),
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
    PRIMARY KEY(source_kind,source_id),
    CHECK(drawer_id IS NULL OR shift_id IS NOT NULL)
) STRICT;
INSERT INTO cash_source_postings_next SELECT * FROM cash_source_postings;
DROP TABLE cash_source_postings;
ALTER TABLE cash_source_postings_next RENAME TO cash_source_postings;
CREATE INDEX idx_cash_postings_drawer_time ON cash_source_postings(drawer_id,occurred_at);
CREATE TRIGGER cash_postings_validate_assignment BEFORE INSERT ON cash_source_postings
WHEN NEW.drawer_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM shift_drawers WHERE shift_id=NEW.shift_id AND drawer_id=NEW.drawer_id
)
BEGIN SELECT RAISE(ABORT,'cash posting drawer does not match shift assignment'); END;
CREATE TRIGGER cash_postings_no_update BEFORE UPDATE ON cash_source_postings
BEGIN SELECT RAISE(ABORT,'cash postings are append-only'); END;
CREATE TRIGGER cash_postings_no_delete BEFORE DELETE ON cash_source_postings
BEGIN SELECT RAISE(ABORT,'cash postings are append-only'); END;
CREATE TRIGGER cash_sale_payment_post AFTER INSERT ON sale_payments
WHEN NEW.method='cash' AND NEW.amount_minor>0
BEGIN
 INSERT INTO cash_source_postings(source_kind,source_id,shift_id,drawer_id,signed_minor,actor_id,occurred_at)
 SELECT 'sale_payment',NEW.id,sh.id,sd.drawer_id,CASE s.kind WHEN 'sale' THEN NEW.amount_minor ELSE -NEW.amount_minor END,s.sold_by,NEW.occurred_at
 FROM sales s LEFT JOIN shifts sh ON sh.status='open' AND NEW.occurred_at >= sh.opened_at LEFT JOIN shift_drawers sd ON sd.shift_id=sh.id WHERE s.id=NEW.sale_id;
END;
CREATE TRIGGER cash_customer_payment_post AFTER INSERT ON customer_ledger
WHEN NEW.kind='payment' AND NEW.method='cash'
BEGIN
 INSERT INTO cash_source_postings(source_kind,source_id,shift_id,drawer_id,signed_minor,actor_id,occurred_at)
 SELECT 'customer_payment',NEW.id,sh.id,sd.drawer_id,-NEW.amount_minor,NEW.actor_id,NEW.occurred_at
 FROM (SELECT 1) x LEFT JOIN shifts sh ON sh.status='open' AND NEW.occurred_at >= sh.opened_at LEFT JOIN shift_drawers sd ON sd.shift_id=sh.id;
END;
CREATE TRIGGER cash_drawer_expense_post AFTER INSERT ON expenses
WHEN NEW.paid_from='drawer'
BEGIN
 INSERT INTO cash_source_postings(source_kind,source_id,shift_id,drawer_id,signed_minor,actor_id,occurred_at)
 SELECT 'expense',NEW.id,NEW.shift_id,sd.drawer_id,-NEW.amount_minor,NEW.created_by,NEW.created_at
 FROM (SELECT 1) x LEFT JOIN shift_drawers sd ON sd.shift_id=NEW.shift_id;
END;
CREATE TRIGGER cash_movement_post AFTER INSERT ON cash_movements
BEGIN
 INSERT INTO cash_source_postings(source_kind,source_id,shift_id,drawer_id,signed_minor,actor_id,occurred_at)
 SELECT 'cash_movement',NEW.id,NEW.shift_id,sd.drawer_id,CASE NEW.kind WHEN 'cash_in' THEN NEW.amount_minor ELSE -NEW.amount_minor END,NEW.created_by,NEW.created_at
 FROM (SELECT 1) x LEFT JOIN shift_drawers sd ON sd.shift_id=NEW.shift_id;
END;

-- Wallet/service operations use the cash semantics already used by shift
-- totals. Transfers between wallets and operations with via=out are excluded.
-- Use a CASE to keep zero-value operations from creating a posting.
CREATE TRIGGER cash_wallet_operation_post AFTER INSERT ON wallet_ops
WHEN (CASE
 WHEN NEW.kind IN ('deposit','bill','card') THEN NEW.amount_minor + NEW.fee_minor
 WHEN NEW.kind='withdraw' THEN -(NEW.amount_minor - NEW.fee_minor)
 WHEN NEW.kind='software' THEN NEW.fee_minor
 WHEN NEW.kind='topup' AND NEW.via='drawer' THEN -NEW.amount_minor
 WHEN NEW.kind='unload' AND NEW.via='drawer' THEN NEW.amount_minor
 ELSE 0 END) <> 0
BEGIN
 INSERT INTO cash_source_postings(source_kind,source_id,shift_id,drawer_id,signed_minor,actor_id,occurred_at)
 SELECT 'wallet_op',NEW.id,sh.id,sd.drawer_id,
 CASE WHEN NEW.kind IN ('deposit','bill','card') THEN NEW.amount_minor + NEW.fee_minor
 WHEN NEW.kind='withdraw' THEN -(NEW.amount_minor - NEW.fee_minor)
 WHEN NEW.kind='software' THEN NEW.fee_minor
 WHEN NEW.kind='topup' AND NEW.via='drawer' THEN -NEW.amount_minor
 WHEN NEW.kind='unload' AND NEW.via='drawer' THEN NEW.amount_minor END,
 NEW.created_by,NEW.created_at
 FROM (SELECT 1) x LEFT JOIN shifts sh ON sh.status='open' AND NEW.created_at >= sh.opened_at LEFT JOIN shift_drawers sd ON sd.shift_id=sh.id;
END;
-- Only an operation whose original cash posting exists can be compensated
-- without inventing a historical source. Legacy voids remain outside this
-- partial projection, so its completeness flag must remain false.
CREATE TRIGGER cash_wallet_void_post AFTER UPDATE OF voided_at ON wallet_ops
WHEN OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL
 AND EXISTS(SELECT 1 FROM cash_source_postings p WHERE p.source_kind='wallet_op' AND p.source_id=NEW.id)
BEGIN
 INSERT INTO cash_source_postings(source_kind,source_id,shift_id,drawer_id,signed_minor,actor_id,occurred_at)
 SELECT 'wallet_void',NEW.id,sh.id,sd.drawer_id,-original.signed_minor,NEW.voided_by,NEW.voided_at
 FROM cash_source_postings original LEFT JOIN shifts sh ON sh.status='open' AND NEW.voided_at>=sh.opened_at
 LEFT JOIN shift_drawers sd ON sd.shift_id=sh.id WHERE original.source_kind='wallet_op' AND original.source_id=NEW.id;
END;
