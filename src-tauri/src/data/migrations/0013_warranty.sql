-- Migration 0013: warranty dates on sale lines (P4, decisions D4, D8, D9).
--
-- WHAT THIS MAKES LIVE
--
-- The warranty range from `spec:179`, kept where the owner's D4 put it: on the
-- line that was sold, one pair of dates per item. Not on the customer row (D9):
-- a customer who bought two things on different days has two coverages, and a
-- single range on the customer file would have to be one of them or a merge of
-- both. Looking up "is this customer's device still covered" is a join
-- `sale_lines -> sales.customer_id`, not a second copy that can drift.
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No default duration. D4 is explicit: the operator types both boundaries, and
-- this software does not invent a period the shop never agreed to.
--
-- No backfill. A line written before this migration had no warranty recorded, and
-- filling in a date now would claim a coverage that was never sold.
--
-- Epoch milliseconds would have been consistent with every other timestamp here,
-- and are deliberately refused (D8). A warranty boundary is a CALENDAR DAY the
-- operator typed; an instant would make "the last day of the warranty" depend on
-- the device's timezone and drift by a day when a clock is corrected. So these
-- two columns are TEXT `YYYY-MM-DD`, and nothing else may be stored in them.
--
-- Purely additive. No table is rebuilt, no column is altered, no PRAGMA is used
-- and no `-- no-transaction` marker appears, so this runs inside the ordinary
-- SQLx migration transaction.

-- Why two columns rather than a stored duration: a duration is a claim about a
-- start nobody recorded, and it drifts when the date is corrected. Both ends are
-- typed, so both ends are stored.
--
-- The GLOB is a full-string match, so it fixes the shape at exactly ten ASCII
-- characters as well as the two dashes: `2026-2-3`, `15-03-2026`, `2026/03/15`,
-- a full ISO instant and a number all fail it. The day itself is NOT checked
-- here — SQLite has no date type and a leap-year rule in CHECK would duplicate
-- the domain's arithmetic in two places that could then disagree. The domain
-- (`domain::sales::WarrantyDate`) refuses 30 February on the way in; this
-- constraint is the backstop for any writer that is not that domain.
ALTER TABLE sale_lines ADD COLUMN warranty_start TEXT NULL
    CHECK (warranty_start IS NULL
           OR warranty_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE sale_lines ADD COLUMN warranty_end TEXT NULL
    CHECK (warranty_end IS NULL
           OR warranty_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');

-- "The range must not run backwards" is the one rule these columns need that a
-- column-level CHECK cannot express: SQLite forbids a column constraint from
-- naming another column, and a table-level CHECK could only be added by
-- rebuilding `sale_lines` — which `stock_movements.sale_line_id` references, so
-- rebuilding it would put a referenced table through a drop. A trigger is the
-- documented alternative, and 0011 already established the precedent for exactly
-- this reason: a rule the service honours but the database does not is a rule
-- one bad writer erases.
--
-- The comparison is text, and it is correct as text precisely because both
-- columns are ISO-shaped by the CHECKs above and ISO days sort
-- chronologically. `tests/unit` pins that property so the two cannot drift.
CREATE TRIGGER sale_lines_warranty_range_insert
BEFORE INSERT ON sale_lines
WHEN NEW.warranty_start IS NOT NULL
 AND NEW.warranty_end IS NOT NULL
 AND NEW.warranty_end < NEW.warranty_start
BEGIN
    SELECT RAISE(ABORT, 'sale_lines.warranty_end must not precede warranty_start');
END;

CREATE TRIGGER sale_lines_warranty_range_update
BEFORE UPDATE ON sale_lines
WHEN NEW.warranty_start IS NOT NULL
 AND NEW.warranty_end IS NOT NULL
 AND NEW.warranty_end < NEW.warranty_start
BEGIN
    SELECT RAISE(ABORT, 'sale_lines.warranty_end must not precede warranty_start');
END;