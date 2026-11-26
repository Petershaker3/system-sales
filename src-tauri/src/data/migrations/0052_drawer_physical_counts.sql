-- A count is a physical observation, not a posting or a reconciled balance.
-- No old count is assigned to a drawer without evidence. Observations are
-- independent of operational shift close and retain the shift open at capture.
CREATE TABLE cash_drawer_physical_counts (
    request_id TEXT PRIMARY KEY NOT NULL CHECK(length(trim(request_id)) BETWEEN 1 AND 120),
    drawer_id TEXT NOT NULL REFERENCES cash_drawers(id) ON DELETE RESTRICT,
    shift_id TEXT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    counted_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    counted_at INTEGER NOT NULL CHECK(counted_at >= 0)
) STRICT;
CREATE INDEX idx_drawer_physical_counts_drawer ON cash_drawer_physical_counts(drawer_id, counted_at);
CREATE TRIGGER drawer_physical_counts_open_shift BEFORE INSERT ON cash_drawer_physical_counts
WHEN NEW.shift_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM shifts WHERE id=NEW.shift_id AND status='open')
BEGIN SELECT RAISE(ABORT,'count shift must be open'); END;
CREATE TRIGGER drawer_physical_counts_no_update BEFORE UPDATE ON cash_drawer_physical_counts
BEGIN SELECT RAISE(ABORT,'physical counts are append-only'); END;
CREATE TRIGGER drawer_physical_counts_no_delete BEFORE DELETE ON cash_drawer_physical_counts
BEGIN SELECT RAISE(ABORT,'physical counts are append-only'); END;
