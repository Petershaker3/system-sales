-- Cash posting foundation: no historical identity or opening balance is guessed.
-- This projection is intentionally not a reconciled balance: repairs and wallet
-- service events are not yet fully captured. Existing operations remain usable.
CREATE TABLE cash_drawers (
    id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(id)) BETWEEN 1 AND 80),
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 80),
    created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at INTEGER NOT NULL CHECK(created_at >= 0)
) STRICT;
CREATE TRIGGER cash_drawers_no_update BEFORE UPDATE ON cash_drawers
BEGIN SELECT RAISE(ABORT,'drawer identities are immutable'); END;
CREATE TRIGGER cash_drawers_no_delete BEFORE DELETE ON cash_drawers
BEGIN SELECT RAISE(ABORT,'drawer identities are immutable'); END;
CREATE TABLE cash_drawer_configuration_events (
    request_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(request_id)) BETWEEN 1 AND 120),
    drawer_id TEXT NOT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
) STRICT;
CREATE TRIGGER cash_drawer_configuration_events_no_update BEFORE UPDATE ON cash_drawer_configuration_events
BEGIN SELECT RAISE(ABORT,'drawer configuration events are immutable'); END;
CREATE TRIGGER cash_drawer_configuration_events_no_delete BEFORE DELETE ON cash_drawer_configuration_events
BEGIN SELECT RAISE(ABORT,'drawer configuration events are immutable'); END;
-- Configuration is explicit, never seeded with a hard-coded drawer.
CREATE TABLE cash_drawer_default (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton=1),
    drawer_id TEXT NOT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT,
    configured_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    configured_at INTEGER NOT NULL CHECK(configured_at >= 0)
) STRICT;
CREATE TRIGGER cash_drawer_default_no_change_open BEFORE UPDATE ON cash_drawer_default
WHEN EXISTS(SELECT 1 FROM shifts WHERE status='open')
BEGIN SELECT RAISE(ABORT,'cannot change drawer during an open shift'); END;
CREATE TRIGGER cash_drawer_default_no_insert_open BEFORE INSERT ON cash_drawer_default
WHEN EXISTS(SELECT 1 FROM shifts WHERE status='open')
BEGIN SELECT RAISE(ABORT,'cannot configure drawer during an open shift'); END;
CREATE TRIGGER cash_drawer_default_no_delete BEFORE DELETE ON cash_drawer_default
BEGIN SELECT RAISE(ABORT,'drawer default cannot be deleted'); END;
-- Shift assignments are snapshots. A shift created before setup remains unknown.
CREATE TABLE shift_drawers (
    shift_id TEXT PRIMARY KEY NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    drawer_id TEXT NOT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT
) STRICT;
CREATE TRIGGER shift_drawer_on_open AFTER INSERT ON shifts
WHEN NEW.status='open'
BEGIN INSERT INTO shift_drawers(shift_id,drawer_id) SELECT NEW.id,drawer_id FROM cash_drawer_default WHERE singleton=1; END;
CREATE TRIGGER shift_drawers_no_update BEFORE UPDATE ON shift_drawers
BEGIN SELECT RAISE(ABORT,'shift drawer is immutable'); END;
CREATE TRIGGER shift_drawers_no_delete BEFORE DELETE ON shift_drawers
BEGIN SELECT RAISE(ABORT,'shift drawer is immutable'); END;
-- One entry per existing immutable source record. NULL drawer means explicitly
-- unknown, not a default or verified destination. No row is backfilled.
CREATE TABLE cash_source_postings (
    source_kind TEXT NOT NULL CHECK(source_kind IN ('sale_payment','customer_payment','expense','cash_movement')),
    source_id TEXT NOT NULL CHECK(length(trim(source_id))>0),
    shift_id TEXT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    drawer_id TEXT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT,
    signed_minor INTEGER NOT NULL CHECK(signed_minor <> 0),
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0),
    PRIMARY KEY(source_kind,source_id),
    CHECK(drawer_id IS NULL OR shift_id IS NOT NULL)
) STRICT;
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
