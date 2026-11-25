-- A physical count is evidence, not a drawer balance or reconciliation.
-- No legacy rows are backfilled and no historical drawer identity is inferred.
CREATE TABLE shift_cash_counts (
    id TEXT PRIMARY KEY NOT NULL,
    shift_id TEXT NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
    amount_minor INTEGER NOT NULL CHECK(amount_minor >= 0),
    counted_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    counted_at INTEGER NOT NULL
);
CREATE INDEX idx_shift_cash_counts_latest ON shift_cash_counts(shift_id, counted_at DESC, id DESC);
CREATE TRIGGER shift_cash_counts_require_open BEFORE INSERT ON shift_cash_counts
WHEN (SELECT status FROM shifts WHERE id=NEW.shift_id) IS NOT 'open'
BEGIN SELECT RAISE(ABORT, 'cash count requires an open shift'); END;
CREATE TRIGGER shift_cash_counts_no_update BEFORE UPDATE ON shift_cash_counts
BEGIN SELECT RAISE(ABORT, 'cash counts are append-only'); END;
CREATE TRIGGER shift_cash_counts_no_delete BEFORE DELETE ON shift_cash_counts
BEGIN SELECT RAISE(ABORT, 'cash counts are append-only'); END;
