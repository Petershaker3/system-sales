-- Migration 0004: departments.
--
-- WHAT A DEPARTMENT IS
--
-- A department is a **product classification** — the grouping a shop already uses
-- to organise what it sells: phones, accessories, spare parts. It is NOT a
-- physical place. It is not a warehouse, a branch, a storage area, a shelf or a
-- bin, and this table therefore references no location of any kind.
--
-- V1 has exactly one stock counter per product, so a department cannot partition
-- a product's stock. `products.department_id` (migration 0005) is a
-- classification attribute of the product, not a statement about where the goods
-- physically are.
--
-- Why this matters for the reader who later asks "why is there no location": the
-- inventory delivery specification discusses a department transfer, and §12 says a
-- *product* moves between departments. A transfer here is reclassification, not
-- relocation. Nothing in this schema can express a physical move because there is
-- nowhere to move between.
--
-- WHAT ELSE THIS TABLE CARRIES
--
-- `cost_method` and the three VAT columns are defaults declared here because a
-- department is an organisational and costing boundary. They are STORED, NOT
-- ACTIVE. No costing engine and no VAT arithmetic reads them yet: the code that
-- consumes `fifo` does not exist, and writing behaviour for a method that has no
-- implementation would be inventing behaviour. `spec:239` leaves the rounding
-- policy open, so there is deliberately no arithmetic here at all.
--
-- This table is purely additive. It references `users` and nothing else, and
-- nothing references it yet. `products.department_id` arrives in `0005`.
--
-- NO SYNCHRONISATION TABLE. ADR-008 places all sync outside V1.
--
-- Rollback is not a `Down` script: `plan:143` fixes the recovery model as
-- restore-a-backup then forward-fix.
--
-- Timestamps are INTEGER milliseconds since the Unix epoch, UTC, matching
-- migrations 0001 to 0003.

CREATE TABLE departments (
    -- UUID v7 (ADR-009), matching `products.id` and `users.id`: stable,
    -- time-ordered, never derived from a per-device counter (`spec:109`).
    id            TEXT    PRIMARY KEY NOT NULL,

    -- Required, and not unique at the table level: two departments must be able
    -- to share a name while one is archived and the other is live, so uniqueness
    -- is scoped by `status` below. Application rules trim the value; the storage
    -- layer does not, because `0002_catalog.sql` sets the same precedent by
    -- leaving trimming to `ProductName`.
    name          TEXT    NOT NULL,

    -- The project's established status convention, identical to `products.status`
    -- and `users.disabled_at` in intent: a record linked to history is archived,
    -- never deleted (`spec:221`). Exactly two states, no more.
    status        TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'archived')),

    -- NOT NULL with a default, so a department can never leave its costing method
    -- undeclared. That matters because `fifo` is genuinely different arithmetic
    -- from `moving_average`, and a department that did not say which one it uses
    -- would have to be guessed at the first receipt.
    --
    -- INERT UNTIL IMPLEMENTED. Both values are accepted; neither is acted on yet.
    -- `moving_average` lands with the inventory ledger, `fifo` with its costing
    -- engine. A manager may select either in the meantime and nothing reads it.
    cost_method   TEXT    NOT NULL DEFAULT 'moving_average'
                          CHECK (cost_method IN ('moving_average', 'fifo')),

    -- VAT defaults for products in this department. `products.vat_rate_bp` may
    -- override them per product.
    --
    -- Basis points: 1450 means 14.50%. An INTEGER, because a percentage is not an
    -- integer and a REAL would break the project's zero-floating-point rule
    -- (`spec:56`, ADR-010). Money itself is never stored here.
    --
    -- CHECK rather than a looser type, matching `user_credentials.must_change_password`:
    -- a stray value must not reach the session gate. The CHECK also states the one
    -- combination that is meaningless — VAT turned on with no rate to apply.
    vat_enabled   INTEGER NOT NULL DEFAULT 0
                          CHECK (vat_enabled IN (0, 1)),
    vat_rate_bp   INTEGER
                          CHECK (vat_rate_bp IS NULL OR vat_rate_bp >= 0),
    vat_inclusive INTEGER NOT NULL DEFAULT 0
                          CHECK (vat_inclusive IN (0, 1)),

    -- Display order for the classification list. A plain INTEGER, left to the
    -- manager: the manager is the only one who decides how their shop's list
    -- reads, so there is no hidden default ordering to fight with.
    sort_order    INTEGER NOT NULL DEFAULT 0,

    -- Attribution is mandatory (`plan:143`, `spec:177`) and is taken from the
    -- resolved session, never from a caller-supplied value.
    --
    -- RESTRICT, matching `products.created_by` and `products.updated_by`: losing
    -- who created a department is worse than refusing a user deletion, and V1 has
    -- no user deletion in any case.
    created_by    TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    updated_by    TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,

    -- NULL while active, set when archived, cleared when restored. A timestamp
    -- rather than a derived value so the archive moment is recoverable and not
    -- merely inferable from a later edit.
    archived_at   INTEGER,

    -- The one VAT combination that means nothing: VAT switched on with no rate to
    -- apply. Stated here rather than left to the application so it cannot be
    -- reached by a caller that forgets to check, which is the reason the other
    -- constraints on this table exist at all.
    --
    -- The reverse is deliberately allowed — a rate may stay recorded while VAT is
    -- switched off — because turning VAT off is a temporary business decision and
    -- forcing the operator to also erase the rate would lose it for no benefit.
    CHECK (vat_enabled = 0 OR vat_rate_bp IS NOT NULL)
);

-- Uniqueness among LIVE departments only.
--
-- A partial index rather than a table-level UNIQUE, because a permanent
-- constraint would make an archived department's name unreclaimable forever: the
-- history that keeps the archived row would also block a shop from opening a new
-- department with a familiar name after a reorganisation. Scoping to
-- `status = 'active'` lets a name be reused once the previous holder is archived,
-- while two live departments can still never share one.
--
-- NOCASE so `Phones` and `phones` are one classification, matching
-- `user_credentials.username COLLATE NOCASE` and `Barcode::lookup_key`.
CREATE UNIQUE INDEX idx_departments_active_name
    ON departments (name COLLATE NOCASE) WHERE status = 'active';

-- The listing reads ordered, so the index covers the common query rather than
-- forcing a sort on every keystroke of a department picker.
CREATE INDEX idx_departments_sort
    ON departments (sort_order, name COLLATE NOCASE);