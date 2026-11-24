-- Migration 0012: customer file core + sale link columns (customer records, P4).
--
-- WHAT THIS MAKES LIVE
--
-- The customer core from `spec:30` and `spec:178-179`: one row per customer
-- with a name and a single optional contact. Similar names are never merged
-- by construction: there is no UNIQUE constraint on `name` and no
-- find-by-name path, so two "Ahmed Hassan" rows simply coexist.
--
-- The sale link anticipated by `migrations/0011` ("a later slice adds a
-- nullable `customer_id` by additive migration without rewriting any sale
-- row"): `sales.customer_id` is NULL unless an explicit link command sets it,
-- and `sales.customer_name_snapshot` keeps the free-text name for an unlinked
-- sale (`spec:178`).
--
-- WHAT IS DELIBERATELY ABSENT
--
-- No warranty columns. Warranty start/end per device/sale (`spec:179`) waits
-- for decision D4 (warranty periods/terms); a later additive migration adds
-- them without touching these rows.
--
-- No address, no national id (`spec:179`: nothing beyond name + one contact
-- without a stated need).
--
-- Purely additive. No table is rebuilt, no column is altered, no PRAGMA is
-- used and no `-- no-transaction` marker appears, so this runs inside the
-- ordinary SQLx migration transaction.
--
-- Timestamps are INTEGER milliseconds since the Unix epoch, UTC, matching
-- migrations 0001 to 0011.

CREATE TABLE customers (
    -- UUID v7 (ADR-009), matching every other entity id in this schema.
    id          TEXT    PRIMARY KEY NOT NULL,

    -- Display name. Deliberately NOT UNIQUE: `spec:178` forbids merging two
    -- similar names into one record, so uniqueness would be the wrong
    -- invariant. The length guard is a last line of defence; the domain
    -- validates first.
    name        TEXT    NOT NULL CHECK (length(name) <= 120),

    -- The single optional contact (`spec:179`). NULL means none was given.
    contact     TEXT    NULL CHECK (contact IS NULL OR length(contact) <= 64),

    -- Normal-flow archival (ID-04): records are archived, never hard-deleted,
    -- so invoice and movement history keeps its references.
    archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),

    -- Attributing operator, from the resolved session, never from the caller.
    created_by  TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- Browse/search support for the manager. An index, not a constraint: it
-- speeds listing without implying that names are unique.
CREATE INDEX idx_customers_name ON customers (name);

-- Explicit link only: NULL unless set by the link command. Unlinked sales
-- keep their free-text name in `customer_name_snapshot` instead (`spec:178`).
ALTER TABLE sales ADD COLUMN customer_id TEXT NULL
    REFERENCES customers (id) ON DELETE RESTRICT;
ALTER TABLE sales ADD COLUMN customer_name_snapshot TEXT NULL;
