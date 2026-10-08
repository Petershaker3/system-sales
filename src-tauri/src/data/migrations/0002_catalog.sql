-- Migration 0002: product identity catalog.
--
-- Scope is deliberately narrow: the identity of a product and the price at
-- which the shop intends to sell it. This migration creates NO stock tracking,
-- NO serialized units and NO cost, because those belong to `inventory-procurement`
-- and `serialized-unit tracking`, which are separate capabilities (`spec:28-31`)
-- and are not yet decided. See ADR-010 and the plan's open items.
--
-- NO SYNCHRONISATION TABLE. ADR-008 places all sync outside V1.
--
-- Rollback is not a `Down` script: `plan:143` fixes the recovery model as
-- restore-a-backup then forward-fix.
--
-- Timestamps are INTEGER milliseconds since the Unix epoch, UTC, matching
-- migration 0001.

CREATE TABLE products (
    -- UUID v7 (ADR-009): stable, time-ordered, never derived from storage
    -- location or a per-device counter (`spec:109`).
    id               TEXT    PRIMARY KEY NOT NULL,

    -- Not unique (decision D8). Two products may legitimately share a name;
    -- the barcode and the id are what identify a product.
    name             TEXT    NOT NULL,

    -- Disposition (D1/D2). Recorded now so existing products are never
    -- reclassified later, but NOTE: nothing enforces it yet. No stock movement
    -- or serialized-unit table exists, so this states intent only.
    disposition      TEXT    NOT NULL CHECK (disposition IN ('quantity', 'serialized')),

    -- Barcode (D3/D4): one optional barcode per product, created for the
    -- product and never derived from any identifier (`spec:176`).
    --
    -- UNIQUE rejects a duplicate barcode when present (`plan:167`) while
    -- permitting any number of NULLs, which is what makes the column optional.
    -- That NULL behaviour is proven by an integration test rather than assumed.
    --
    -- No format validation: accepting only digits would require symbology
    -- knowledge, which belongs to the still-blocked barcode decision.
    barcode          TEXT    UNIQUE,

    -- Selling price in piastres (ADR-010). NULLABLE, and the distinction
    -- matters:
    --     NULL = not yet set
    --     0    = genuinely free
    -- Collapsing them would assert that an unpriced item costs nothing. A
    -- product may enter the catalogue before its price is known, so an unset
    -- price is a legitimate state. Requiring a price before a sale is the
    -- responsibility of `pos-sales` (`spec:31`), not of the catalogue.
    sale_price_minor INTEGER CHECK (sale_price_minor IS NULL OR sale_price_minor >= 0),

    -- Archive semantics (D7, `spec:221`): a product linked to history is
    -- archived, never deleted.
    status           TEXT    NOT NULL CHECK (status IN ('active', 'archived')),

    -- Attribution is mandatory (`plan:143`, `spec:177`) and is taken from the
    -- resolved session, never from a caller-supplied value.
    --
    -- RESTRICT (D8): losing who created a product is worse than refusing a user
    -- deletion, and V1 has no user deletion in any case.
    created_by       TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    updated_by       TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,

    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
);

-- The default listing filters by status, and the manager view is the common path.
CREATE INDEX idx_products_status ON products (status);

-- Disposition filtering will back the inventory slice.
CREATE INDEX idx_products_disposition ON products (disposition);

-- Attribution lookups, for example "everything this manager created".
CREATE INDEX idx_products_created_by ON products (created_by);
