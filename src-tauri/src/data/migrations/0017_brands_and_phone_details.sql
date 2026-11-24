-- 0017: phone brands, and a phone's details on its product (ADR-018 §2; the
-- owner's approval: ADR-016 decisions 29 and 31).
--
-- Additive only — one new table, five nullable columns on `products`, no
-- existing column, row, index or migration changed:
--
-- * `brands` — the phone companies the owner keeps in the settings (as in the
--   legacy app): a name, whether its phones are touch, keypad or both, the
--   owner's order, and whether it is offered in «موبايل جديد». The default
--   companies are not inserted here: `created_by` must name a user, and a fresh
--   device has none yet. They are added with the first manager, and on start-up
--   for a database made before this migration, like the default categories.
-- * `products.brand_id`, `model`, `device_type` — a phone's company, its model
--   as the shop writes it («Galaxy A16», «iPhone 16», «105») and whether it is
--   touch or keypad. All three or none: the triggers below refuse half a phone.
-- * `products.storage_gb`, `ram_gb` — a touch phone's storage and RAM in GB
--   (1 TB = 1024). A keypad phone has neither.
--
-- The product's name stays the one stored name; the details are what it was
-- built from («Samsung Galaxy A16 128GB»), and what the sales screen groups by.

CREATE TABLE brands (
    id           TEXT    PRIMARY KEY NOT NULL,
    name         TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    device_type  TEXT    NOT NULL DEFAULT 'touch'
                         CHECK (device_type IN ('touch', 'keypad', 'both')),
    sort_order   INTEGER NOT NULL DEFAULT 0,
    hidden       INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
    created_by   TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    updated_by   TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

-- One company, one name, whatever the case.
CREATE UNIQUE INDEX idx_brands_name ON brands (name COLLATE NOCASE);
CREATE INDEX idx_brands_sort ON brands (sort_order, name COLLATE NOCASE);

ALTER TABLE products ADD COLUMN brand_id TEXT REFERENCES brands (id) ON DELETE RESTRICT;
ALTER TABLE products ADD COLUMN model TEXT CHECK (model IS NULL OR length(trim(model)) > 0);
ALTER TABLE products ADD COLUMN device_type TEXT
    CHECK (device_type IS NULL OR device_type IN ('touch', 'keypad'));
ALTER TABLE products ADD COLUMN storage_gb INTEGER CHECK (storage_gb IS NULL OR storage_gb > 0);
ALTER TABLE products ADD COLUMN ram_gb INTEGER CHECK (ram_gb IS NULL OR ram_gb > 0);

CREATE INDEX idx_products_brand ON products (brand_id);

-- A phone is a company, a model and a device type together, or it is not a
-- phone at all; and a keypad phone has no storage or RAM.
CREATE TRIGGER products_phone_details_insert
BEFORE INSERT ON products
WHEN NOT (
        (NEW.brand_id IS NULL AND NEW.model IS NULL AND NEW.device_type IS NULL
         AND NEW.storage_gb IS NULL AND NEW.ram_gb IS NULL)
     OR (NEW.brand_id IS NOT NULL AND NEW.model IS NOT NULL AND NEW.device_type IS NOT NULL
         AND (NEW.device_type = 'touch' OR (NEW.storage_gb IS NULL AND NEW.ram_gb IS NULL)))
)
BEGIN
    SELECT RAISE(ABORT, 'phone details: a company, a model and a device type together; a keypad phone has no storage or RAM');
END;

CREATE TRIGGER products_phone_details_update
BEFORE UPDATE OF brand_id, model, device_type, storage_gb, ram_gb ON products
WHEN NOT (
        (NEW.brand_id IS NULL AND NEW.model IS NULL AND NEW.device_type IS NULL
         AND NEW.storage_gb IS NULL AND NEW.ram_gb IS NULL)
     OR (NEW.brand_id IS NOT NULL AND NEW.model IS NOT NULL AND NEW.device_type IS NOT NULL
         AND (NEW.device_type = 'touch' OR (NEW.storage_gb IS NULL AND NEW.ram_gb IS NULL)))
)
BEGIN
    SELECT RAISE(ABORT, 'phone details: a company, a model and a device type together; a keypad phone has no storage or RAM');
END;
