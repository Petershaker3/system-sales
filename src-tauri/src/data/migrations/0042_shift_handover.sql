-- A handover records observations, never a ledger balance or a settlement.
-- No old shift or drawer identity is reconstructed.
CREATE TABLE shift_opening_observations (
    shift_id TEXT PRIMARY KEY NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    previous_shift_id TEXT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    opening_minor INTEGER NOT NULL CHECK (opening_minor >= 0),
    previous_count_minor INTEGER NULL CHECK (previous_count_minor IS NULL OR previous_count_minor >= 0),
    handover_difference_minor INTEGER NULL,
    observed_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    observed_at INTEGER NOT NULL,
    reconciliation_status TEXT NOT NULL DEFAULT 'unreconciled' CHECK (reconciliation_status = 'unreconciled'),
    CHECK ((previous_count_minor IS NULL AND handover_difference_minor IS NULL) OR
           (previous_count_minor IS NOT NULL AND handover_difference_minor = opening_minor - previous_count_minor))
);
CREATE TRIGGER shift_opening_observations_no_update BEFORE UPDATE ON shift_opening_observations
BEGIN SELECT RAISE(ABORT, 'opening observations are append-only'); END;
CREATE TRIGGER shift_opening_observations_no_delete BEFORE DELETE ON shift_opening_observations
BEGIN SELECT RAISE(ABORT, 'opening observations are append-only'); END;
