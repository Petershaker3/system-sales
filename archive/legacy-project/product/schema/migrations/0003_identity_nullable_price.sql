-- Migration 0003: nullable price + source identity.
--
-- Two changes, both required before any importer runs:
--
-- 1. products.price_minor becomes NULL. The legacy system holds real stock
--    with no evidenced sale price, and neither zero (a lie that the phone is
--    free) nor dropping the product (losing a real catalog) is acceptable.
--    NULL means exactly "legacy product with unknown selling price", and the
--    mapping is forbidden from turning it into zero.
--
-- 2. Every table that will hold migrated rows gains source_entity and
--    origin_ref. Together with origin they form the source identity:
--    (origin, source_entity, origin_ref). The partial unique index enforces it
--    only when a ref exists, so ordinary local rows with NULL refs are
--    unaffected. Pairing discipline (a ref always travels with its entity) is
--    enforced where pairs are made, in the mapping, and tested there: the
--    database owns uniqueness, the mapping owns pairing, and neither pretends
--    to do the other's job.
--
-- SQLite cannot ALTER a column's nullability, so products is rebuilt: new
-- table, copy, drop, rename. No production database exists yet, but the
-- rebuild is written as if one did, and tests/schema_v3.rs proves it by
-- migrating a hand-built v1 table with rows in it.

PRAGMA foreign_keys = OFF;

CREATE TABLE products_new (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sku              TEXT    NOT NULL UNIQUE,
    name             TEXT    NOT NULL,
    kind             TEXT    NOT NULL CHECK (kind IN ('phone', 'accessory', 'used', 'part', 'service', 'other')),
    barcode          TEXT,
    price_minor      INTEGER CHECK (price_minor IS NULL OR typeof(price_minor) = 'integer'),
    avg_cost_minor   INTEGER CHECK (avg_cost_minor IS NULL OR typeof(avg_cost_minor) = 'integer'),
    qty              INTEGER NOT NULL DEFAULT 0 CHECK (typeof(qty) = 'integer' AND qty >= 0),
    primary_photo_id INTEGER REFERENCES product_photos (id),
    origin           TEXT    NOT NULL DEFAULT 'local',
    source_entity    TEXT,
    origin_ref       TEXT,
    created_by       TEXT,
    created_at       TEXT    NOT NULL
);

INSERT INTO products_new (
    id, sku, name, kind, barcode, price_minor, avg_cost_minor, qty,
    primary_photo_id, origin, source_entity, origin_ref, created_by, created_at
)
SELECT
    id, sku, name, kind, barcode, price_minor, avg_cost_minor, qty,
    primary_photo_id, origin, NULL, NULL, created_by, created_at
FROM products;

DROP TABLE products;

ALTER TABLE products_new RENAME TO products;

CREATE UNIQUE INDEX products_origin_ref
    ON products (origin, source_entity, origin_ref)
    WHERE origin_ref IS NOT NULL;

ALTER TABLE purchase_history ADD COLUMN source_entity TEXT;
ALTER TABLE purchase_history ADD COLUMN origin_ref TEXT;

ALTER TABLE invoices ADD COLUMN source_entity TEXT;
ALTER TABLE invoices ADD COLUMN origin_ref TEXT;

-- Lines are never addressed independently of their invoice: one legacy row
-- becomes one invoice holding its lines, so the invoice's identity covers
-- them. Giving lines their own identity columns would imply they can migrate
-- alone, which the mapping forbids. The invoice carries (origin, entity, ref);
-- its lines ride along.

ALTER TABLE repairs ADD COLUMN source_entity TEXT;
ALTER TABLE repairs ADD COLUMN origin_ref TEXT;

ALTER TABLE wallet_movements ADD COLUMN source_entity TEXT;
ALTER TABLE wallet_movements ADD COLUMN origin_ref TEXT;

ALTER TABLE expenses ADD COLUMN source_entity TEXT;
ALTER TABLE expenses ADD COLUMN origin_ref TEXT;

ALTER TABLE repair_parts ADD COLUMN source_entity TEXT;
ALTER TABLE repair_parts ADD COLUMN origin_ref TEXT;

CREATE UNIQUE INDEX purchase_history_origin_ref
    ON purchase_history (origin, source_entity, origin_ref)
    WHERE origin_ref IS NOT NULL;

CREATE UNIQUE INDEX invoices_origin_ref
    ON invoices (origin, source_entity, origin_ref)
    WHERE origin_ref IS NOT NULL;

CREATE UNIQUE INDEX repairs_origin_ref
    ON repairs (origin, source_entity, origin_ref)
    WHERE origin_ref IS NOT NULL;

CREATE UNIQUE INDEX wallet_movements_origin_ref
    ON wallet_movements (origin, source_entity, origin_ref)
    WHERE origin_ref IS NOT NULL;

CREATE UNIQUE INDEX expenses_origin_ref
    ON expenses (origin, source_entity, origin_ref)
    WHERE origin_ref IS NOT NULL;

CREATE UNIQUE INDEX repair_parts_origin_ref
    ON repair_parts (origin, source_entity, origin_ref)
    WHERE origin_ref IS NOT NULL;

UPDATE meta SET value = '3' WHERE key = 'schema_version';

PRAGMA foreign_keys = ON;
