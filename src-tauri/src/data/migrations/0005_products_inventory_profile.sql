-- Migration 0005: the product inventory profile.
--
-- WHAT THIS DOES
--
-- Widens `products.disposition` to the three approved product classes and adds the
-- three inventory-profile columns: a department classification, a default unit
-- cost, and a VAT rate. `products` is rebuilt rather than altered, because SQLite
-- cannot change a CHECK constraint on an existing column — not with ALTER TABLE,
-- not with a PRAGMA.
--
-- WHY A REBUILD IS SAFE HERE, WHEN `0003` REFUSED ONE FOR `users`
--
-- `0003_identity_lifecycle.sql` rejected rebuilding `users` because three tables
-- pointed *at* it (`sessions`, `user_credentials`, `products.created_by`), so a
-- half-finished rebuild could leave accounts without sessions and would need
-- `PRAGMA foreign_keys=OFF` — a per-connection setting that silently does
-- nothing inside a transaction, which could hand the pool a connection with
-- foreign keys off.
--
-- `products` has no such problem **at this point in history**. Nothing references
-- it yet: the inventory ledger that will point at it is migration `0007`. Every
-- foreign key on the table points outward, to `users`, and is recreated verbatim
-- below, so the engine enforces them throughout. Therefore this migration:
--
--   * does NOT use `PRAGMA foreign_keys = OFF`;
--   * does NOT need `-- no-transaction`;
--   * runs inside the normal SQLx migration transaction, so a crash anywhere in
--     it leaves the original `products` table intact.
--
-- The ordering is load-bearing and must not change: if a future migration adds a
-- foreign key *to* `products`, this rebuild is no longer the safe pattern it is
-- today.
--
-- WHAT IS NOT HERE
--
-- No stock, no quantity, no inventory ledger, no cost layers, no costing
-- arithmetic and no VAT arithmetic. `default_cost_minor` and `vat_rate_bp` are
-- stored configuration that nothing reads yet; the engines that consume them arrive
-- in later slices. `department_id` is a **product classification**, not a physical
-- location: V1 has one stock counter per product, so a department classifies a
-- product rather than locating it.
--
-- Rollback is not a `Down` script: `plan:143` fixes the recovery model as
-- restore-a-backup then forward-fix.
--
-- Timestamps are INTEGER milliseconds since the Unix epoch, UTC, matching
-- migrations 0001 to 0004.

CREATE TABLE products_rebuilt (
    -- UUID v7 (ADR-009): stable, time-ordered, never derived from storage
    -- location or a per-device counter (`spec:109`).
    id               TEXT    PRIMARY KEY NOT NULL,

    -- Not unique (decision D8). Two products may legitimately share a name;
    -- the barcode and the id are what identify a product.
    name             TEXT    NOT NULL,

    -- Disposition. Extended from two values to the three approved classes:
    -- a quantity-tracked product, a per-piece tracked product, and a one-off that
    -- is sold once as an individual occurrence and keeps no stock balance
    -- (`spec:175`). The first two values are unchanged, so every existing row
    -- remains valid and no product is ever reclassified by this migration.
    --
    -- Recorded, not yet enforced by any stock logic: no `stock_movements` table
    -- exists, so this still states intent rather than being checked against stock.
    disposition      TEXT    NOT NULL
                          CHECK (disposition IN ('quantity', 'serialized', 'one_off')),

    -- Barcode (D3/D4): one optional barcode per product, created for the product
    -- and never derived from any identifier (`spec:176`).
    --
    -- UNIQUE rejects a duplicate barcode when present while permitting any number
    -- of NULLs, which is what makes the column optional.
    --
    -- No format validation: accepting only digits would require symbology
    -- knowledge, which belongs to the still-blocked barcode decision.
    barcode          TEXT    UNIQUE,

    -- Selling price in piastres (ADR-010). NULLABLE, and the distinction matters:
    --     NULL = not yet set
    --     0    = genuinely free
    -- Collapsing them would assert that an unpriced item costs nothing.
    sale_price_minor INTEGER CHECK (sale_price_minor IS NULL OR sale_price_minor >= 0),

    -- Product classification. NULLABLE and left NULL for every pre-existing row:
    -- a product may legitimately be in the catalogue before anyone classifies it,
    -- and `spec:175` forbids inventing data, so there is no backfill and no
    -- default "General" department.
    --
    -- ON DELETE RESTRICT, matching every other attribution-style reference in this
    -- schema: losing which department a product belongs to is worse than refusing a
    -- department deletion, and departments are archived rather than deleted anyway.
    department_id    TEXT             REFERENCES departments (id) ON DELETE RESTRICT,

    -- Approved unit cost in piastres, for a product that has none in stock. The
    -- real cost arrives with a receipt.
    --
    -- Same NULL meaning as `sale_price_minor`: NULL is "not set", 0 is "genuinely
    -- free" — a gift or a founders' batch. No `NULL` was invented for rows that
    -- never had a cost.
    --
    -- An INTEGER count of piastres. No REAL, no decimal text, no floating point
    -- money (`spec:56`, ADR-010).
    default_cost_minor INTEGER        CHECK (default_cost_minor IS NULL OR default_cost_minor >= 0),

    -- Product-level VAT rate, overriding any department default. Basis points:
    -- 1450 means 14.50%. An INTEGER because a percentage is not an integer and a
    -- REAL would break the project's zero-floating-point rule.
    --
    -- Stored only. Nothing computes an amount from it, and `spec:239` leaves the
    -- rounding policy open.
    vat_rate_bp      INTEGER          CHECK (vat_rate_bp IS NULL OR vat_rate_bp >= 0),

    -- Archive semantics (D7, `spec:221`): a product linked to history is archived,
    -- never deleted.
    status           TEXT    NOT NULL CHECK (status IN ('active', 'archived')),

    -- Attribution is mandatory (`plan:143`, `spec:177`) and is taken from the
    -- resolved session, never from a caller-supplied value.
    created_by       TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    updated_by       TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

-- Copy every existing row across, one for one.
--
-- The ten original columns are carried by name with no transformation, so an id, a
-- name, a barcode, a NULL price, a status, an attribution and both timestamps are
-- preserved exactly. `disposition` is copied as-is: both stored values are still
-- valid under the widened CHECK, so no product is reclassified.
--
-- The three new columns are left out of the column list, so SQLite inserts their
-- defaults, which are NULL for all three. That is the deliberate choice: assigning
-- a department, a cost or a VAT rate here would be manufacturing business data
-- the shop never entered, and `spec:175` forbids inventing stock from any source.
INSERT INTO products_rebuilt (id, name, disposition, barcode, sale_price_minor,
                              status, created_by, updated_by, created_at, updated_at)
SELECT id, name, disposition, barcode, sale_price_minor,
       status, created_by, updated_by, created_at, updated_at
FROM products;

-- Safe to drop only now, and only because nothing references `products` at this
-- point in history. Dropping a table also drops its indexes and its inline UNIQUE
-- constraint, so both are recreated below.
DROP TABLE products;

-- Renaming inside the same transaction makes the whole rebuild atomic from a
-- reader's point of view: no other connection can observe the intermediate state,
-- and a failure anywhere above rolls the whole migration back.
ALTER TABLE products_rebuilt RENAME TO products;

-- The default listing filters by status, and the manager view is the common path.
CREATE INDEX idx_products_status ON products (status);

-- Disposition filtering backs the inventory slice.
CREATE INDEX idx_products_disposition ON products (disposition);

-- Department-filtered listing: a classification picker reads every product in one
-- department, and this keeps that from scanning the table.
CREATE INDEX idx_products_department ON products (department_id);

-- Attribution lookups, for example "everything this manager created".
CREATE INDEX idx_products_created_by ON products (created_by);