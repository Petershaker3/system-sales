-- 0018_product_variants.sql
--
-- Product variants («تفرعات الصنف», ADR-018 §4, plan item 1.2 step 4).
--
-- A counted item such as a case, screen protector, charger or cable often comes
-- in several models, colours, wattages or lengths. The shop registers the item
-- once as a parent (`product_parents`) with one or two dimensions from the
-- fixed vocabulary (`الموبايل`, `اللون`, `النوع`, `المقاس`, `القوة`, `الطول`,
-- `المساحة`), and each combination of their values is stored as its own row in
-- `products` with its own barcode, sale price, stock balance and moving-average
-- cost.
--
-- The sales screen collapses the variants of a parent into one tile («ليه X نوع»)
-- that opens the variant picker, while barcode and text search find the variant
-- itself. Receiving («استلام توريد») and invoices work on the variant's own
-- product row without change.
--
-- Additive only: one new table and four nullable columns on `products`. Existing
-- rows keep `parent_id = NULL` and behave as standalone products.

CREATE TABLE product_parents (
    id          TEXT    PRIMARY KEY,
    name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
    department_id TEXT  NOT NULL REFERENCES departments (id) ON DELETE RESTRICT,
    dimension_1 TEXT    NOT NULL CHECK (dimension_1 IN (
        'الموبايل', 'اللون', 'النوع', 'المقاس', 'القوة', 'الطول', 'المساحة'
    )),
    dimension_2 TEXT    CHECK (dimension_2 IS NULL OR dimension_2 IN (
        'الموبايل', 'اللون', 'النوع', 'المقاس', 'القوة', 'الطول', 'المساحة'
    )),
    created_by  TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    updated_by  TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

-- The same variant family cannot be registered twice in the same category,
-- whatever the case of its Latin letters.
CREATE UNIQUE INDEX idx_product_parents_category_name
    ON product_parents (department_id, name COLLATE NOCASE);

ALTER TABLE products
    ADD COLUMN parent_id TEXT REFERENCES product_parents (id) ON DELETE RESTRICT;

ALTER TABLE products
    ADD COLUMN variant_1 TEXT CHECK (variant_1 IS NULL OR length(trim(variant_1)) > 0);

ALTER TABLE products
    ADD COLUMN variant_2 TEXT CHECK (variant_2 IS NULL OR length(trim(variant_2)) > 0);

ALTER TABLE products
    ADD COLUMN variant_order INTEGER CHECK (variant_order IS NULL OR variant_order >= 0);

CREATE INDEX idx_products_parent_id ON products (parent_id);

-- All-or-nothing variant details on a product row:
--   * without a parent, all variant columns are NULL;
--   * with a parent, `variant_1` and `variant_order` are present, the product
--     is not a phone (`brand_id IS NULL`), `variant_2` matches whether the
--     parent has a second dimension, and the combination is unique under the
--     parent (case-insensitively).
CREATE TRIGGER products_variant_details_insert
BEFORE INSERT ON products
FOR EACH ROW
WHEN (
    (NEW.parent_id IS NULL AND (
        NEW.variant_1 IS NOT NULL
        OR NEW.variant_2 IS NOT NULL
        OR NEW.variant_order IS NOT NULL
    ))
    OR (NEW.parent_id IS NOT NULL AND (
        NEW.variant_1 IS NULL
        OR NEW.variant_order IS NULL
        OR NEW.brand_id IS NOT NULL
        OR (
            (SELECT dimension_2 FROM product_parents WHERE id = NEW.parent_id) IS NULL
            AND NEW.variant_2 IS NOT NULL
        )
        OR (
            (SELECT dimension_2 FROM product_parents WHERE id = NEW.parent_id) IS NOT NULL
            AND NEW.variant_2 IS NULL
        )
        OR EXISTS (
            SELECT 1 FROM products
            WHERE parent_id = NEW.parent_id
              AND lower(variant_1) = lower(NEW.variant_1)
              AND COALESCE(lower(variant_2), '') = COALESCE(lower(NEW.variant_2), '')
        )
    ))
)
BEGIN
    SELECT RAISE(ABORT, 'products: invalid variant details');
END;

CREATE TRIGGER products_variant_details_update
BEFORE UPDATE OF parent_id, variant_1, variant_2, variant_order, brand_id ON products
FOR EACH ROW
WHEN (
    (NEW.parent_id IS NULL AND (
        NEW.variant_1 IS NOT NULL
        OR NEW.variant_2 IS NOT NULL
        OR NEW.variant_order IS NOT NULL
    ))
    OR (NEW.parent_id IS NOT NULL AND (
        NEW.variant_1 IS NULL
        OR NEW.variant_order IS NULL
        OR NEW.brand_id IS NOT NULL
        OR (
            (SELECT dimension_2 FROM product_parents WHERE id = NEW.parent_id) IS NULL
            AND NEW.variant_2 IS NOT NULL
        )
        OR (
            (SELECT dimension_2 FROM product_parents WHERE id = NEW.parent_id) IS NOT NULL
            AND NEW.variant_2 IS NULL
        )
        OR EXISTS (
            SELECT 1 FROM products
            WHERE parent_id = NEW.parent_id
              AND id <> NEW.id
              AND lower(variant_1) = lower(NEW.variant_1)
              AND COALESCE(lower(variant_2), '') = COALESCE(lower(NEW.variant_2), '')
        )
    ))
)
BEGIN
    SELECT RAISE(ABORT, 'products: invalid variant details');
END;
