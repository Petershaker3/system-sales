-- Cancellation and payout are distinct facts. When the existing undo flow
-- cannot prove a wholly cash refund, preserve an explicit unresolved event.
-- It is not a cash posting and it does not identify a drawer or payout method.
-- No historic repair is assigned a timestamp or source by this migration.
CREATE TABLE uncertain_repair_refunds (
    repair_id TEXT PRIMARY KEY NOT NULL REFERENCES repairs(id) ON DELETE RESTRICT,
    shift_id TEXT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL CHECK(occurred_at >= 0)
) STRICT;
CREATE INDEX idx_uncertain_repair_refunds_time ON uncertain_repair_refunds(occurred_at);
CREATE TRIGGER uncertain_repair_refunds_no_update BEFORE UPDATE ON uncertain_repair_refunds
BEGIN SELECT RAISE(ABORT,'uncertain refund events are append-only'); END;
CREATE TRIGGER uncertain_repair_refunds_no_delete BEFORE DELETE ON uncertain_repair_refunds
BEGIN SELECT RAISE(ABORT,'uncertain refund events are append-only'); END;
