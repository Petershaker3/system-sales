-- Shifts (`shifts`), drawer expenses (`expenses`), and cash movements (`cash_movements`).
-- Plan item 1.9 (`ADR-024`, `ADR-016` #31, `HANDOFF_2026-10-17.md` §6, `docs/PLAN.md` §12).

CREATE TABLE shifts (
    id                   TEXT    PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    shift_number         INTEGER NOT NULL UNIQUE CHECK (shift_number >= 1),
    status               TEXT    NOT NULL CHECK (status IN ('open', 'closed')),
    opening_cash_minor   INTEGER NOT NULL CHECK (opening_cash_minor >= 0),
    expected_cash_minor  INTEGER NULL,
    counted_cash_minor   INTEGER NULL CHECK (counted_cash_minor IS NULL OR counted_cash_minor >= 0),
    difference_minor     INTEGER NULL,
    close_note           TEXT    NULL CHECK (close_note IS NULL OR (length(trim(close_note)) > 0 AND length(close_note) <= 300)),
    opened_by            TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    opened_at            INTEGER NOT NULL,
    closed_by            TEXT    NULL REFERENCES users (id) ON DELETE RESTRICT,
    closed_at            INTEGER NULL,
    CHECK (
        (status = 'open'
            AND expected_cash_minor IS NULL
            AND counted_cash_minor IS NULL
            AND difference_minor IS NULL
            AND close_note IS NULL
            AND closed_by IS NULL
            AND closed_at IS NULL)
        OR
        (status = 'closed'
            AND expected_cash_minor IS NOT NULL
            AND counted_cash_minor IS NOT NULL
            AND difference_minor IS NOT NULL
            AND difference_minor = counted_cash_minor - expected_cash_minor
            AND closed_by IS NOT NULL
            AND closed_at IS NOT NULL
            AND closed_at >= opened_at)
    )
);

CREATE UNIQUE INDEX idx_shifts_single_open ON shifts (status) WHERE status = 'open';
CREATE INDEX idx_shifts_opened_at ON shifts (opened_at DESC);

CREATE TRIGGER shifts_immutable_once_closed
BEFORE UPDATE ON shifts
WHEN OLD.status = 'closed'
BEGIN
    SELECT RAISE(ABORT, 'closed shifts are immutable');
END;

CREATE TRIGGER shifts_no_delete
BEFORE DELETE ON shifts
BEGIN
    SELECT RAISE(ABORT, 'shifts cannot be deleted');
END;

CREATE TABLE expenses (
    id            TEXT    PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    shift_id      TEXT    NOT NULL REFERENCES shifts (id) ON DELETE RESTRICT,
    category      TEXT    NOT NULL CHECK (length(trim(category)) > 0 AND length(category) <= 80),
    amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
    note          TEXT    NULL CHECK (note IS NULL OR (length(trim(note)) > 0 AND length(note) <= 300)),
    created_by    TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at    INTEGER NOT NULL
);

CREATE INDEX idx_expenses_shift ON expenses (shift_id, created_at);
CREATE INDEX idx_expenses_created_at ON expenses (created_at);

CREATE TRIGGER expenses_require_open_shift
BEFORE INSERT ON expenses
WHEN (SELECT status FROM shifts WHERE id = NEW.shift_id) IS NOT 'open'
BEGIN
    SELECT RAISE(ABORT, 'expenses require an open shift');
END;

CREATE TRIGGER expenses_no_update
BEFORE UPDATE ON expenses
BEGIN
    SELECT RAISE(ABORT, 'expenses is append-only');
END;

CREATE TRIGGER expenses_no_delete
BEFORE DELETE ON expenses
BEGIN
    SELECT RAISE(ABORT, 'expenses is append-only');
END;

CREATE TABLE cash_movements (
    id            TEXT    PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),
    shift_id      TEXT    NOT NULL REFERENCES shifts (id) ON DELETE RESTRICT,
    kind          TEXT    NOT NULL CHECK (kind IN ('cash_in', 'owner_draw')),
    amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
    reason        TEXT    NOT NULL CHECK (length(trim(reason)) > 0 AND length(reason) <= 200),
    created_by    TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at    INTEGER NOT NULL
);

CREATE INDEX idx_cash_movements_shift ON cash_movements (shift_id, created_at);
CREATE INDEX idx_cash_movements_created_at ON cash_movements (created_at);

CREATE TRIGGER cash_movements_require_open_shift
BEFORE INSERT ON cash_movements
WHEN (SELECT status FROM shifts WHERE id = NEW.shift_id) IS NOT 'open'
BEGIN
    SELECT RAISE(ABORT, 'cash_movements require an open shift');
END;

CREATE TRIGGER cash_movements_no_update
BEFORE UPDATE ON cash_movements
BEGIN
    SELECT RAISE(ABORT, 'cash_movements is append-only');
END;

CREATE TRIGGER cash_movements_no_delete
BEFORE DELETE ON cash_movements
BEGIN
    SELECT RAISE(ABORT, 'cash_movements is append-only');
END;
