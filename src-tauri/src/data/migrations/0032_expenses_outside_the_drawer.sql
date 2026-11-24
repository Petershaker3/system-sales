-- Expenses that are not paid out of the drawer (`ADR-043`).
--
-- `expenses` was born as a drawer ledger (Plan item 1.9, `ADR-024`): a row needed an
-- open shift and the shift's expected cash was reduced by it. That is right for a
-- packet of tea bought from the till, and wrong for the rent, the electricity bill or
-- a salary — the shop pays those whether or not a shift is open, and counting them
-- against a drawer they never left would make the close-of-day count disagree with
-- reality.
--
-- The table therefore gains one idea rather than a second table: `paid_from` says
-- where the money came from, and `shift_id` is required exactly when it came out of
-- the drawer. A second table would have made every future total a union of two
-- shapes, and the shop has one list of expenses, not two.
--
-- The table is rebuilt because SQLite cannot drop a NOT NULL from a column in place.
-- Rebuilding is the same move `0005` made for `products`: create the new shape, copy
-- every row across with no transformation, drop the old table, rename inside the same
-- transaction.

-- Dropped first: they belong to the old table and would otherwise be destroyed by the
-- DROP at the bottom with no record of what they said.
DROP TRIGGER expenses_require_open_shift;
DROP TRIGGER expenses_no_update;
DROP TRIGGER expenses_no_delete;

CREATE TABLE expenses_rebuilt (
    id            TEXT    PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0),

    -- `NULL` means the money did not leave the drawer. It is not "unknown": the
    -- CHECK below ties it to `paid_from`, so a row either names the shift it was
    -- taken from or says plainly that no drawer was involved.
    shift_id      TEXT    NULL REFERENCES shifts (id) ON DELETE RESTRICT,

    -- 'drawer'  — paid out of the till during an open shift.
    -- 'outside' — paid from the owner's pocket, a bank account, or anywhere else;
    --             it is still the shop's expense and still appears in the section.
    paid_from     TEXT    NOT NULL CHECK (paid_from IN ('drawer', 'outside')),

    category      TEXT    NOT NULL CHECK (length(trim(category)) > 0 AND length(category) <= 80),
    amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
    note          TEXT    NULL CHECK (note IS NULL OR (length(trim(note)) > 0 AND length(note) <= 300)),
    created_by    TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at    INTEGER NOT NULL,

    -- Where the money came from and whether a shift is named are one fact, not two.
    -- A drawer row without a shift could not be counted at close; an outside row with
    -- one would be subtracted from a drawer it never touched.
    CHECK ((paid_from = 'drawer') = (shift_id IS NOT NULL))
);

-- Every row that exists today was paid out of the drawer of the shift it names.
-- No amount, date, note or attribution is touched.
INSERT INTO expenses_rebuilt (id, shift_id, paid_from, category, amount_minor, note, created_by, created_at)
SELECT id, shift_id, 'drawer', category, amount_minor, note, created_by, created_at
FROM expenses;

DROP TABLE expenses;

ALTER TABLE expenses_rebuilt RENAME TO expenses;

-- The shift close reads one shift's expenses; the section reads a period.
CREATE INDEX idx_expenses_shift ON expenses (shift_id, created_at);
CREATE INDEX idx_expenses_created_at ON expenses (created_at);

-- A drawer expense still requires an open shift, and now says so about the drawer
-- rather than about every row in the table. An outside expense is checked by the
-- same trigger and passes, because it names no shift at all.
CREATE TRIGGER expenses_require_open_shift
BEFORE INSERT ON expenses
WHEN NEW.paid_from = 'drawer'
    AND (SELECT status FROM shifts WHERE id = NEW.shift_id) IS NOT 'open'
BEGIN
    SELECT RAISE(ABORT, 'a drawer expense requires an open shift');
END;

-- Append-only, unchanged: an expense is a movement of money, and a movement that can
-- be rewritten after the fact is a number nobody can audit. A mistake is corrected by
-- recording what happened, not by editing history (`ADR-024`).
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
