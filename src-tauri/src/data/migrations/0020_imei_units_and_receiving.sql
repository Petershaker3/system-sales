-- 0020_imei_units_and_receiving.sql
--
-- Optional IMEI units, opening-stock receipts, and phone unit sales
-- (`ADR-019`, `ADR-016` #8, #30, #31, #34, `PLAN.md` §7 & §11).
--
-- Purely additive within the owner-approved Phase 1 schema proposal:
-- 1. `products.tracking` (`'none' | 'serial_optional' | 'serial_required'`),
--    defaulting to `'none'` and set to `'serial_optional'` for phones.
-- 2. `stock_movements.receipt_kind` (`'supplier' | 'opening'`), allowed only on
--    receipts (`kind = 'receipt'`) and refusing a supplier name when `'opening'`.
-- 3. `units(id, product_id, imei, imei2, color, unit_cost_minor, status,
--    received_movement_id, sale_line_id, retired_reason, created_by, created_at)`
--    recording individual serialized devices with their actual cost.
-- 4. `sale_lines.unit_id` linking a sold line to the specific unit when sold
--    by IMEI.

ALTER TABLE products ADD COLUMN tracking TEXT NOT NULL DEFAULT 'none'
    CHECK (tracking IN ('none', 'serial_optional', 'serial_required'));

UPDATE products SET tracking = 'serial_optional' WHERE brand_id IS NOT NULL;

ALTER TABLE stock_movements ADD COLUMN receipt_kind TEXT NULL
    CHECK (receipt_kind IS NULL OR receipt_kind IN ('supplier', 'opening'));

CREATE TRIGGER stock_movements_receipt_kind_only_on_receipt
BEFORE INSERT ON stock_movements
WHEN NEW.receipt_kind IS NOT NULL AND NEW.kind <> 'receipt'
BEGIN
    SELECT RAISE(ABORT, 'only a receipt may declare receipt_kind');
END;

CREATE TRIGGER stock_movements_opening_has_no_supplier
BEFORE INSERT ON stock_movements
WHEN NEW.receipt_kind = 'opening' AND NEW.supplier_name IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'opening stock may not name a supplier');
END;

CREATE TABLE units (
    id                   TEXT    PRIMARY KEY NOT NULL,
    product_id           TEXT    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
    imei                 TEXT    NOT NULL UNIQUE CHECK (
        length(imei) = 15
        AND imei GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
    ),
    imei2                TEXT    NULL UNIQUE CHECK (
        imei2 IS NULL
        OR (
            length(imei2) = 15
            AND imei2 GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
            AND imei2 <> imei
        )
    ),
    color                TEXT    NULL CHECK (
        color IS NULL
        OR (length(trim(color)) BETWEEN 1 AND 40 AND color = trim(color))
    ),
    unit_cost_minor      INTEGER NOT NULL CHECK (unit_cost_minor >= 0),
    status               TEXT    NOT NULL CHECK (status IN ('in_stock', 'sold', 'retired')),
    received_movement_id TEXT    NULL REFERENCES stock_movements (id) ON DELETE RESTRICT,
    sale_line_id         TEXT    NULL REFERENCES sale_lines (id) ON DELETE RESTRICT,
    retired_reason       TEXT    NULL CHECK (retired_reason IS NULL OR length(trim(retired_reason)) > 0),
    created_by           TEXT    NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at           INTEGER NOT NULL,
    CHECK (
        (status = 'in_stock' AND sale_line_id IS NULL AND retired_reason IS NULL)
        OR (status = 'sold' AND sale_line_id IS NOT NULL AND retired_reason IS NULL)
        OR (status = 'retired' AND retired_reason IS NOT NULL)
    )
);

CREATE INDEX idx_units_product_status ON units (product_id, status, created_at, id);
CREATE INDEX idx_units_sale_line ON units (sale_line_id);

ALTER TABLE sale_lines ADD COLUMN unit_id TEXT NULL
    REFERENCES units (id) ON DELETE RESTRICT;
