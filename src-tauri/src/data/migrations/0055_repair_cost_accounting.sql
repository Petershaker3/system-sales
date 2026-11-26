ALTER TABLE repairs ADD COLUMN cancelled_at INTEGER;
ALTER TABLE repairs ADD COLUMN cancelled_parts_status TEXT
    CHECK (cancelled_parts_status IS NULL OR cancelled_parts_status IN ('no_parts', 'used', 'unknown'));
ALTER TABLE repairs ADD COLUMN cancelled_parts_cost_minor INTEGER
    CHECK (cancelled_parts_cost_minor IS NULL OR cancelled_parts_cost_minor >= 0);

-- Recover the event time where the existing cancellation audit event identifies
-- this ticket. The disposition remains unknown: historical amounts are not proof
-- that a part was used or could not be returned.
UPDATE repairs
   SET cancelled_at = (
       SELECT e.occurred_at
         FROM audit_events e
        WHERE e.event_type = 'repair_cancelled'
          AND json_valid(e.detail)
          AND json_extract(e.detail, '$.repair_id') = repairs.id
        ORDER BY e.occurred_at DESC
        LIMIT 1
   ),
       cancelled_parts_status = 'unknown'
 WHERE status = 'cancelled';

CREATE INDEX idx_repairs_cancelled_at ON repairs(cancelled_at);

CREATE TABLE repair_cost_history (
    id TEXT PRIMARY KEY NOT NULL,
    repair_id TEXT NOT NULL REFERENCES repairs(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    occurred_at INTEGER NOT NULL,
    cost_basis TEXT NOT NULL CHECK (cost_basis IN ('estimate', 'delivered_final', 'cancelled_actual')),
    old_cost_minor INTEGER CHECK (old_cost_minor IS NULL OR old_cost_minor >= 0),
    new_cost_minor INTEGER CHECK (new_cost_minor IS NULL OR new_cost_minor >= 0),
    note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX idx_repair_cost_history_ticket_time
    ON repair_cost_history(repair_id, occurred_at);

CREATE TRIGGER repair_cost_history_no_update
BEFORE UPDATE ON repair_cost_history
BEGIN
    SELECT RAISE(ABORT, 'repair cost history is append-only');
END;

CREATE TRIGGER repair_cost_history_no_delete
BEFORE DELETE ON repair_cost_history
BEGIN
    SELECT RAISE(ABORT, 'repair cost history is append-only');
END;
